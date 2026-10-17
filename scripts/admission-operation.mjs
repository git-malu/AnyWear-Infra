import { canonicalJson, contentHash } from './json-contract.mjs';
import { ADMISSION_WINDOW_CLOCK_SKEW_MS, admissionWindowPayload, parseWindowMinutes } from './admission-window.mjs';
import { canonicalTesterList, observeAdmissionState, readAdmissionState } from './admission-state.mjs';
import { workloadRevision } from '../.github/scripts/beta-lifecycle.mjs';
import { assertVerificationExecutor, runRuntimeVerification } from './verify-runtime-task.mjs';

export { readAdmissionState } from './admission-state.mjs';

const stableStatuses = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']);
const values = stack => Object.fromEntries((stack?.Outputs ?? []).map(row => [row.OutputKey, row.OutputValue]));
const testerList = value => canonicalJson(canonicalTesterList(value));

export function assertClosedAdmission(state, original) {
  if (state?.admission_suspended !== true || state?.intake_open !== false) throw new Error('Beta admission is not proven suspended with intake closed');
  if (testerList(state.tester_emails) !== testerList(original?.tester_emails)) throw new Error('Beta tester list changed during admission closure');
  return state;
}

// The open mirror of the closed assertion: a window is the tester lane, so
// public intake stays closed and the recorded membership does not change.
export function assertOpenedAdmission(state, original) {
  if (state?.admission_suspended !== false || state?.intake_open !== false) throw new Error('Beta admission is not proven open with intake closed');
  if (testerList(state.tester_emails) !== testerList(original?.tester_emails)) throw new Error('Beta tester list changed during the admission window');
  return state;
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid lifecycle ${label}`);
}

export function parseLifecycleStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.intake_open !== 'boolean' || typeof value.admission_suspended !== 'boolean'
    || typeof value.database_policy_matches_ssm !== 'boolean') throw new Error('Lifecycle admission status fields unavailable');
  count(value.tester_count, 'tester count');
  if (value.tester_count > 50) throw new Error('Invalid lifecycle tester count');
  // Backlog is diagnostic evidence, not an admission-close/drain requirement.
  for (const key of ['tasks', 'outbox', 'outboxManualIntervention']) if (Object.hasOwn(value, key)) count(value[key], key);
  for (const key of ['outboxOldestAgeMs', 'outboxManualInterventionOldestAgeMs']) {
    if (Object.hasOwn(value, key) && value[key] !== null
      && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0)) throw new Error(`Invalid lifecycle ${key}`);
  }
  if (Object.hasOwn(value, 'outboxStatusCounts')) {
    if (!value.outboxStatusCounts || typeof value.outboxStatusCounts !== 'object' || Array.isArray(value.outboxStatusCounts)) throw new Error('Invalid lifecycle outbox status counts');
    for (const valueCount of Object.values(value.outboxStatusCounts)) count(valueCount, 'outbox status count');
  }
  for (const key of ['queues', 'dlqs']) {
    if (!Object.hasOwn(value, key)) continue;
    if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) throw new Error(`Invalid lifecycle ${key}`);
    for (const queue of ['vto', 'tagging']) {
      const counts = value[key][queue];
      if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error(`Invalid lifecycle ${key} ${queue}`);
      for (const field of ['visible', 'notVisible', 'delayed']) count(counts[field], `${key} ${queue} ${field}`);
    }
  }
  canonicalJson(value);
  return value;
}

function assertStatusMatchesAdmission(status, state) {
  if (status.database_policy_matches_ssm !== true || status.admission_suspended !== state.admission_suspended
    || status.intake_open !== state.intake_open || status.tester_count !== state.tester_emails.length) throw new Error('Lifecycle DB/SSM admission readback mismatch');
}

// The recorded window bound is an ISO-8601 instant or null. Anything else is
// unproven rather than a usable expiry, so every reader treats it as such.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
export function parseWindowExpiry(value) {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) throw new Error('Admission window expiry is not an ISO-8601 instant');
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new Error('Admission window expiry is not an ISO-8601 instant');
  return at;
}

function observedExpiry(status) {
  const value = status?.admission_window_expires_at;
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : 'malformed';
}

// `close-admission` classifies what it ended from the database status read, never
// from the SSM mirror, which is stale after an unattended expiry.
// - ordinary: suspension was false and the database carried a live window.
// - recovery: suspension was false and the bound had already ended the window
//   (absent, malformed or expired expiry), so this close restored the tuple.
// - already-closed: suspension was already true; closing changed nothing.
export function classifyCloseKind(status, now = Date.now()) {
  if (status?.admission_suspended === true) return 'already-closed';
  const value = status?.admission_window_expires_at;
  if (value !== null && value !== undefined) {
    try { if (parseWindowExpiry(value) > now) return 'ordinary'; }
    catch { /* Malformed means the bound cannot be proven live: a recovery close. */ }
  }
  return 'recovery';
}

// The pre-open fence. The field's presence is the executable proof that the
// selected Service revision can carry and enforce a bound; without it the
// window would be a remembered one. The state itself must already be closed, and
// `admission_suspended` is required because a window is opened only from the
// recorded closed tuple restored by `close-admission`.
function assertClosedWindowStatus(status, now) {
  if (!Object.hasOwn(status, 'admission_window_expires_at')) {
    throw new Error('Selected Service cannot report the admission window bound; refresh the pinned Service revision before opening admission');
  }
  if (status.admission_suspended !== true) throw new Error('Admission must be provably suspended before an admission window opens');
  if (status.intake_open !== false) throw new Error('Public intake must already be closed before an admission window');
  if (status.database_policy_matches_ssm !== true) throw new Error('Admission database/SSM policy must agree before an admission window');
  if (status.admission_window_expires_at === null) return;
  let at;
  try { at = parseWindowExpiry(status.admission_window_expires_at); }
  catch (error) { throw new Error('Admission closure cannot be proven from a non-null admission window expiry', { cause: error }); }
  if (at > now) throw new Error('A live admission window must be closed before another window opens');
}

// The post-open read-back. The record may never claim a longer window than the
// dispatch requested, so the observed expiry must be inside the requested bound.
// `ADMISSION_WINDOW_CLOCK_SKEW_MS` is the same allowance the Service read applies,
// for the same reason: the writer (the one-shot lifecycle container) and the
// reader have independent clocks. It is not applied to the dispatch bound.
function assertOpenWindowStatus(status, windowMinutes, now) {
  if (status.admission_suspended !== false || status.intake_open !== false || status.database_policy_matches_ssm !== true) {
    throw new Error('Lifecycle database admission is not proven open with intake closed');
  }
  if (!Object.hasOwn(status, 'admission_window_expires_at') || status.admission_window_expires_at === null) {
    throw new Error('Opened lifecycle status carries no admission window expiry');
  }
  const remaining = parseWindowExpiry(status.admission_window_expires_at) - now;
  if (remaining <= 0 || remaining > windowMinutes * 60_000 + ADMISSION_WINDOW_CLOCK_SKEW_MS) {
    throw new Error('Observed admission window expiry is outside the requested bound');
  }
  return status.admission_window_expires_at;
}

const clock = io => (typeof io.now === 'function' ? io.now() : Date.now());
const describeAdmission = state => `admission_suspended=${state?.admission_suspended}, intake_open=${state?.intake_open}, `
  + `tester_count=${Array.isArray(state?.tester_emails) ? state.tester_emails.length : 'unavailable'}`;

export async function runCloseAdmission({ io, selector, manifest, schema, infraSha, env = process.env, verifyRuntime = runRuntimeVerification }) {
  // Source rejection must precede any authenticated activity or lifecycle task.
  if (env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Infra'
    || env.GITHUB_WORKFLOW_REF !== 'git-malu/AnyWear-Infra/.github/workflows/beta-admission.yml@refs/heads/main') throw new Error('Protected Infra admission executor required');
  assertVerificationExecutor(infraSha, env);
  let revision; let prior; let closeAttempted = false;
  try {
    const platform = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearPlatformStack-beta'])).Stacks?.[0];
    const workload = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearWorkloadStack-beta'])).Stacks?.[0];
    if (!stableStatuses.has(platform?.StackStatus) || !stableStatuses.has(workload?.StackStatus)) throw new Error('Stable Beta stacks required to close admission');
    const outputs = values(platform);
    if (outputs.BetaActive !== 'true' || values(workload).BetaActive !== 'true' || outputs.EcsClusterName !== 'beta-anywear') throw new Error('Active Beta required to close admission');
    revision = workloadRevision(workload);
    if (revision.commit !== selector.image.service_sha || revision.digest !== selector.image.digest) throw new Error('Admission closure must retain the deployed selected image');
    const original = await readAdmissionState(io);
    io.recordAdmissionState?.({ phase: 'original', state: original, result: 'observed' });
    // The selected existing Service close command sets suspension only. Public
    // intake must already be closed, and its tester list must remain unchanged.
    if (original.intake_open !== false) throw new Error('Public intake must already be closed before admission closure');
    // Read the database admission state before closing so the operation records
    // whether it ended a live window or one the bound had already ended.
    prior = parseLifecycleStatus(await io.oneShot('lifecycle', revision, 'status'));
    const closeKind = classifyCloseKind(prior, clock(io));
    const priorExpiresAt = observedExpiry(prior);
    const verification = await verifyRuntime({ io, outputs, selector, manifest, schema, infraSha, env });
    closeAttempted = true;
    await io.oneShot('lifecycle', revision, 'close');
    const state = await readAdmissionState(io);
    io.recordAdmissionState?.({ phase: 'closed', state, result: 'observed', close_kind: closeKind, prior_expires_at: priorExpiresAt });
    assertClosedAdmission(state, original);
    const status = parseLifecycleStatus(await io.oneShot('lifecycle', revision, 'status'));
    assertStatusMatchesAdmission(status, state);
    // Status is read-only, but take a final SSM snapshot so its observed DB policy
    // cannot be accepted against admission values changed during that task.
    const finalState = await readAdmissionState(io);
    assertClosedAdmission(finalState, original);
    assertStatusMatchesAdmission(status, finalState);
    io.recordAdmissionState?.({ phase: 'closed', state: finalState, result: 'verified', close_kind: closeKind,
      prior_expires_at: priorExpiresAt, lifecycle_status_sha256: contentHash(status) });
    return { original, state: finalState, status, close_kind: closeKind, prior_expires_at: priorExpiresAt, runtime_verification: verification };
  } catch (error) {
    const { state } = await observeAdmissionState(io);
    io.recordAdmissionState?.({ phase: 'failed', state, result: 'failed',
      ...(closeAttempted && prior ? { close_kind: classifyCloseKind(prior, clock(io)), prior_expires_at: observedExpiry(prior) } : {}) });
    throw new Error('Beta admission closure failed; preserve observed state for explicit recovery', { cause: error });
  }
}

export async function runOpenAdmission({ io, selector, manifest, schema, infraSha, env = process.env, verifyRuntime = runRuntimeVerification }) {
  // Source rejection must precede any authenticated activity or lifecycle task.
  if (env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Infra'
    || env.GITHUB_WORKFLOW_REF !== 'git-malu/AnyWear-Infra/.github/workflows/beta-admission.yml@refs/heads/main') throw new Error('Protected Infra admission executor required');
  assertVerificationExecutor(infraSha, env);
  const windowMinutes = parseWindowMinutes(env.WINDOW_MINUTES);
  const payload = admissionWindowPayload(env);
  let revision; let original; let requested = false;
  try {
    const platform = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearPlatformStack-beta'])).Stacks?.[0];
    const workload = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearWorkloadStack-beta'])).Stacks?.[0];
    if (!stableStatuses.has(platform?.StackStatus) || !stableStatuses.has(workload?.StackStatus)) throw new Error('Stable Beta stacks required to open admission');
    const outputs = values(platform);
    if (outputs.BetaActive !== 'true' || values(workload).BetaActive !== 'true' || outputs.EcsClusterName !== 'beta-anywear') throw new Error('Active Beta required to open admission');
    revision = workloadRevision(workload);
    if (revision.commit !== selector.image.service_sha || revision.digest !== selector.image.digest) throw new Error('Admission window must retain the deployed selected image');
    // Refuse before opening when the selected Service cannot report the recorded
    // expiry, or when the state is not provably closed.
    assertClosedWindowStatus(parseLifecycleStatus(await io.oneShot('lifecycle', revision, 'status')), clock(io));
    original = await readAdmissionState(io);
    io.recordAdmissionState?.({ phase: 'original', state: original, result: 'observed' });
    // Only public intake is required closed here. The SSM mirror of suspension can
    // still read false after an unattended expiry; the database status read above
    // is what proves closure, and the recovery close restores the mirror.
    if (original.intake_open !== false) throw new Error('Public intake must already be closed before an admission window');
    const verification = await verifyRuntime({ io, outputs, selector, manifest, schema, infraSha, env });
    requested = true;
    await io.oneShot('lifecycle', revision, 'open', payload);
    const state = await readAdmissionState(io);
    assertOpenedAdmission(state, original);
    const status = parseLifecycleStatus(await io.oneShot('lifecycle', revision, 'status'));
    const admissionWindowExpiresAt = assertOpenWindowStatus(status, windowMinutes, clock(io));
    assertStatusMatchesAdmission(status, state);
    io.recordAdmissionState?.({ phase: 'opened', state, result: 'observed', window_minutes: windowMinutes,
      admission_window_expires_at: admissionWindowExpiresAt });
    const finalState = await readAdmissionState(io);
    assertOpenedAdmission(finalState, original);
    assertStatusMatchesAdmission(status, finalState);
    io.recordAdmissionState?.({ phase: 'verified', state: finalState, result: 'verified', window_minutes: windowMinutes,
      admission_window_expires_at: admissionWindowExpiresAt, lifecycle_status_sha256: contentHash(status) });
    return { original, state: finalState, status, window_minutes: windowMinutes,
      admission_window_expires_at: admissionWindowExpiresAt, runtime_verification: verification };
  } catch (error) {
    // Nothing before the open attempt can have lifted suspension, so those
    // failures record the observed state and never issue a close of their own.
    if (!requested) {
      const { state } = await observeAdmissionState(io);
      io.recordAdmissionState?.({ phase: 'failed', state, result: 'failed' });
      throw new Error('Beta admission window failed before it was requested; preserve observed state for explicit recovery', { cause: error });
    }
    // The window may be open. Close it back to the recorded tuple before throwing;
    // the record names the close as the failed-window recovery it is.
    let closeError;
    try {
      await io.oneShot('lifecycle', revision, 'close');
      const closed = await readAdmissionState(io);
      assertClosedAdmission(closed, original);
      io.recordAdmissionState?.({ phase: 'closed', state: closed, result: 'observed', close_kind: 'failed-window' });
    } catch (recoveryError) { closeError = recoveryError; }
    const { state } = await observeAdmissionState(io);
    io.recordAdmissionState?.({ phase: 'failed', state, result: 'failed', close_kind: 'failed-window' });
    if (closeError) {
      throw new AggregateError([error, closeError],
        `Beta admission window failed and its recovery close did not restore the recorded tuple; observed admission may be open: ${describeAdmission(state)}`,
        { cause: error });
    }
    throw new Error('Beta admission window failed and was closed back to the recorded tuple; preserve observed state for explicit recovery',
      { cause: error });
  }
}
