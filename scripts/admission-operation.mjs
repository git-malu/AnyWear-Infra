import { canonicalJson, contentHash } from './json-contract.mjs';
import { ADMISSION_WINDOW_CLOCK_SKEW_MS, admissionWindowPayload, parseWindowMinutes } from './admission-window.mjs';
import { canonicalTesterList, observeAdmissionState, readAdmissionState, assertProvableAdmissionClosure } from './admission-state.mjs';
import { ADMISSION_MODE_CLOSED, ADMISSION_MODE_TESTERS, admissionClock, describeAdmissionMode,
  effectiveAdmissionBound, parseAdmissionInstant, sameAdmissionInstant } from './admission-mode.mjs';
import { workloadRevision } from '../.github/scripts/beta-lifecycle.mjs';
import { assertVerificationExecutor, runRuntimeVerification } from './verify-runtime-task.mjs';

export { readAdmissionState } from './admission-state.mjs';
// The forward-migration fence is shared with `start`, which invokes the same
// migrate one-shot from `.github/scripts/beta-lifecycle.mjs`.
export { assertMigrationAdmissionClosed } from './admission-mode.mjs';

const stableStatuses = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']);
const values = stack => Object.fromEntries((stack?.Outputs ?? []).map(row => [row.OutputKey, row.OutputValue]));
const testerList = value => canonicalJson(canonicalTesterList(value));

const admissionEntry = 'git-malu/AnyWear-Infra/.github/workflows/beta-admission.yml@refs/heads/main';
function assertAdmissionExecutor(env) {
  if (env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Infra' || env.GITHUB_WORKFLOW_REF !== admissionEntry) throw new Error('Protected Infra admission executor required');
}

function assertActiveBeta(platform, workload, purpose) {
  if (!stableStatuses.has(platform?.StackStatus) || !stableStatuses.has(workload?.StackStatus)) throw new Error(`Stable Beta stacks required to ${purpose}`);
  const outputs = values(platform);
  if (outputs.BetaActive !== 'true' || values(workload).BetaActive !== 'true' || outputs.EcsClusterName !== 'beta-anywear') throw new Error(`Active Beta required to ${purpose}`);
  return outputs;
}

// Closure is the mode's own decision, and it must be a decision the record can
// prove: `closed` observed, or a tester window its own bound already ended. An
// unreadable or malformed value reads closed for admission, but it is not proof,
// so a mutating admission operation refuses it instead of trusting it.
export function assertClosedAdmission(state, original) {
  assertProvableAdmissionClosure(state, 'Beta admission is not proven closed');
  if (testerList(state.tester_emails) !== testerList(original?.tester_emails)) throw new Error('Beta tester list changed during admission closure');
  return state;
}

// The open mirror of the closed assertion: a window is the tester lane, so the
// recorded membership does not change. The bound was already proven live and in
// range by the parser that produced `state`.
export function assertOpenedAdmission(state, original) {
  if (state?.admission_mode !== ADMISSION_MODE_TESTERS) throw new Error('Beta admission is not proven open');
  if (testerList(state.tester_emails) !== testerList(original?.tester_emails)) throw new Error('Beta tester list changed during the admission window');
  return state;
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid lifecycle ${label}`);
}

export function parseLifecycleStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![ADMISSION_MODE_CLOSED, ADMISSION_MODE_TESTERS].includes(value.admission_mode)
    || ![ADMISSION_MODE_CLOSED, ADMISSION_MODE_TESTERS].includes(value.admission_record)
    || typeof value.database_record_differs !== 'boolean'
    || typeof value.database_policy_matches_ssm !== 'boolean') throw new Error('Lifecycle admission status fields unavailable');
  count(value.tester_count, 'tester count');
  if (value.tester_count > 50) throw new Error('Invalid lifecycle tester count');
  // `admission_mode` is the effective decision every gate uses; `admission_record`
  // is the raw stored mode and `database_record_differs` says whether they differ.
  // After an abandoned window the row still stores `testers` while admission is
  // closed, and one field cannot say both things. The bound is effective too: it is
  // null whenever the effective decision is closed.
  if (Object.hasOwn(value, 'admission_window_expires_at') && value.admission_window_expires_at !== null
    && typeof value.admission_window_expires_at !== 'string') throw new Error('Invalid lifecycle admission_window_expires_at');
  // Backlog is diagnostic evidence, not an admission-suspend/drain requirement.
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

// The status read-back and the SSM mirror must describe the same *effective*
// decision. `admission_mode` is the effective decision every gate uses and
// `admission_window_expires_at` is the effective bound (null when closed), so the
// comparison is effective-to-effective and never against a raw stored word. The
// raw record is published beside it: `database_record_differs` from the Service
// and `mirror_record_differs` from this comparison, because an abandoned window
// keeps the row at `testers` while both surfaces decide `closed`. The pre-window
// and resume pre-checks key off this effective comparison, so they still work
// after an abandoned window.
export function compareAdmissionDecision(status, state, now = Date.now()) {
  const stateBound = effectiveAdmissionBound(state);
  const unavailable = state?.admission_mode === 'unavailable';
  const effectiveMatches = status.database_policy_matches_ssm === true
    && status.admission_mode === state?.admission_mode
    && sameAdmissionInstant(status.admission_window_expires_at ?? null, stateBound)
    && status.tester_count === (Array.isArray(state?.tester_emails) ? state.tester_emails.length : -1);
  return { effective_matches: effectiveMatches,
    database_record_differs: status.database_record_differs,
    mirror_record_differs: unavailable ? 'unavailable' : status.admission_record !== state?.admission_recorded_mode,
    observed_at: new Date(now).toISOString(),
    database: { admission_mode: status.admission_mode, admission_window_expires_at: status.admission_window_expires_at ?? null,
      admission_record: status.admission_record, database_record_differs: status.database_record_differs,
      tester_count: status.tester_count, database_policy_matches_ssm: status.database_policy_matches_ssm } };
}

function assertStatusMatchesAdmission(status, state, now = Date.now()) {
  const comparison = compareAdmissionDecision(status, state, now);
  const decision = comparison.database;
  if (decision.database_policy_matches_ssm !== true) throw new Error('Lifecycle DB/SSM admission readback mismatch');
  if (decision.admission_mode !== state.admission_mode) throw new Error('Lifecycle DB/SSM admission readback mismatch');
  if (!sameAdmissionInstant(decision.admission_window_expires_at, effectiveAdmissionBound(state))) {
    throw new Error('Lifecycle DB/SSM admission window bound mismatch');
  }
  if (decision.tester_count !== state.tester_emails.length) throw new Error('Lifecycle DB/SSM admission readback mismatch');
  return comparison;
}

// The recorded window bound is a canonical ISO-8601 instant, or null. Anything
// else is unproven rather than a usable expiry, so every reader treats it as such.
export function parseWindowExpiry(value) {
  const at = parseAdmissionInstant(value);
  if (at === undefined) throw new Error('Admission window expiry is not a canonical ISO-8601 instant');
  return at;
}

function observedExpiry(status) {
  // The status reports the effective bound: null whenever the decision is closed.
  const value = status?.admission_window_expires_at;
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : 'malformed';
}

// `suspend-admission` classifies what it ended from the database status read,
// never from the SSM mirror, which the bound may already have closed.
// The effective decision is `closed` both for an already-closed environment and
// for an abandoned window, so the raw stored mode is what distinguishes them:
// - ordinary: the effective decision is `testers`; a live window was ended.
// - recovery: the effective decision is `closed` but the row still stores
//   `testers`; the bound had already ended that window, so this suspend restored
//   the record.
// - already-closed: the effective decision is `closed` and the row stores
//   `closed`; suspending changed nothing.
export function classifyCloseKind(status) {
  if (status?.admission_mode === ADMISSION_MODE_TESTERS) return 'ordinary';
  if (status?.admission_record === ADMISSION_MODE_TESTERS) return 'recovery';
  return 'already-closed';
}

// The pre-window fence. The bound field's presence is the executable proof that
// the selected Service revision can carry and enforce a bound; without it the
// window would be a remembered one. The *effective* database decision must
// already be closed, so the fence still admits a resume after an abandoned
// window, whose row stores `testers` while the decision is closed.
function assertClosedWindowStatus(status, now = Date.now()) {
  if (!Object.hasOwn(status, 'admission_window_expires_at')) {
    throw new Error('Selected Service cannot report the admission window bound; refresh the pinned Service revision before resuming admission');
  }
  if (status.admission_mode !== ADMISSION_MODE_CLOSED) throw new Error('Admission must be provably closed before an admission window resumes');
  if (status.database_policy_matches_ssm !== true) throw new Error('Admission database/SSM policy must agree before an admission window');
  // The effective bound is null when closed; a non-null value must have ended.
  if (status.admission_window_expires_at === null) return;
  let at;
  try { at = parseWindowExpiry(status.admission_window_expires_at); }
  catch (error) { throw new Error('Admission closure cannot be proven from a non-null admission window expiry', { cause: error }); }
  if (at > now) throw new Error('A live admission window must be closed before another window resumes');
}

// The post-resume read-back. The record may never claim a longer window than the
// dispatch requested, so the observed expiry must be inside the requested bound.
// `ADMISSION_WINDOW_CLOCK_SKEW_MS` is the same allowance the Service read applies,
// for the same reason: the writer (the one-shot lifecycle container) and the
// reader have independent clocks. It is not applied to the dispatch bound.
function assertOpenWindowStatus(status, windowMinutes, now) {
  if (status.admission_mode !== ADMISSION_MODE_TESTERS || status.database_policy_matches_ssm !== true) {
    throw new Error('Lifecycle database admission is not proven open');
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

const clock = admissionClock;
const describeAdmission = state => `${describeAdmissionMode(state)}, `
  + `tester_count=${Array.isArray(state?.tester_emails) ? state.tester_emails.length : 'unavailable'}`;

export async function runSuspendAdmission({ io, selector, manifest, schema, infraSha, env = process.env, verifyRuntime = runRuntimeVerification }) {
  // Source rejection must precede any authenticated activity or lifecycle task.
  assertAdmissionExecutor(env);
  assertVerificationExecutor(infraSha, env);
  let revision; let prior; let suspendAttempted = false;
  try {
    const platform = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearPlatformStack-beta'])).Stacks?.[0];
    const workload = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearWorkloadStack-beta'])).Stacks?.[0];
    const outputs = assertActiveBeta(platform, workload, 'suspend admission');
    revision = workloadRevision(workload);
    if (revision.commit !== selector.image.service_sha || revision.digest !== selector.image.digest) throw new Error('Admission suspension must retain the deployed selected image');
    const original = await readAdmissionState(io);
    io.recordAdmissionState?.({ phase: 'original', state: original, result: 'observed' });
    // Read the database admission state before suspending so the operation
    // records whether it ended a live window or one the bound had already ended.
    prior = parseLifecycleStatus(await io.oneShot('lifecycle', revision, 'status'));
    const closeKind = classifyCloseKind(prior);
    const priorExpiresAt = observedExpiry(prior);
    const verification = await verifyRuntime({ io, outputs, selector, manifest, schema, infraSha, env });
    suspendAttempted = true;
    await io.oneShot('lifecycle', revision, 'suspend');
    const state = await readAdmissionState(io);
    io.recordAdmissionState?.({ phase: 'suspended', state, result: 'observed', close_kind: closeKind, prior_expires_at: priorExpiresAt });
    assertClosedAdmission(state, original);
    const status = parseLifecycleStatus(await io.oneShot('lifecycle', revision, 'status'));
    assertStatusMatchesAdmission(status, state, clock(io));
    // Status is read-only, but take a final SSM snapshot so its observed DB policy
    // cannot be accepted against admission values changed during that task.
    const finalState = await readAdmissionState(io);
    assertClosedAdmission(finalState, original);
    assertStatusMatchesAdmission(status, finalState, clock(io));
    io.recordAdmissionState?.({ phase: 'suspended', state: finalState, result: 'verified', close_kind: closeKind,
      prior_expires_at: priorExpiresAt, lifecycle_status_sha256: contentHash(status) });
    return { original, state: finalState, status, close_kind: closeKind, prior_expires_at: priorExpiresAt, runtime_verification: verification };
  } catch (error) {
    const { state } = await observeAdmissionState(io);
    io.recordAdmissionState?.({ phase: 'failed', state, result: 'failed',
      ...(suspendAttempted && prior ? { close_kind: classifyCloseKind(prior), prior_expires_at: observedExpiry(prior) } : {}) });
    throw new Error('Beta admission suspension failed; preserve observed state for explicit recovery', { cause: error });
  }
}

export async function runResumeAdmission({ io, selector, manifest, schema, infraSha, env = process.env, verifyRuntime = runRuntimeVerification }) {
  // Source rejection must precede any authenticated activity or lifecycle task.
  assertAdmissionExecutor(env);
  assertVerificationExecutor(infraSha, env);
  const windowMinutes = parseWindowMinutes(env.WINDOW_MINUTES);
  const payload = admissionWindowPayload(env);
  let revision; let original; let requested = false;
  try {
    const platform = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearPlatformStack-beta'])).Stacks?.[0];
    const workload = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearWorkloadStack-beta'])).Stacks?.[0];
    const outputs = assertActiveBeta(platform, workload, 'resume admission');
    revision = workloadRevision(workload);
    if (revision.commit !== selector.image.service_sha || revision.digest !== selector.image.digest) throw new Error('Admission window must retain the deployed selected image');
    // Refuse before resuming when the selected Service cannot report the recorded
    // expiry, or when the database decision is not provably closed.
    assertClosedWindowStatus(parseLifecycleStatus(await io.oneShot('lifecycle', revision, 'status')), clock(io));
    original = await readAdmissionState(io);
    io.recordAdmissionState?.({ phase: 'original', state: original, result: 'observed' });
    // The mirror carries its own bound, so it reads closed after an unattended
    // expiry without anyone acting. Requiring it to prove closure is what makes
    // `resume-admission` refuse to open from a record it cannot trust; a mirror
    // restored to a value that cannot prove closure is repaired by
    // `suspend-admission`, the documented predecessor of any window.
    assertProvableAdmissionClosure(original, 'Admission mirror does not prove closed admission before a window resumes');
    const verification = await verifyRuntime({ io, outputs, selector, manifest, schema, infraSha, env });
    requested = true;
    await io.oneShot('lifecycle', revision, 'resume', payload);
    const state = await readAdmissionState(io);
    assertOpenedAdmission(state, original);
    const status = parseLifecycleStatus(await io.oneShot('lifecycle', revision, 'status'));
    const admissionWindowExpiresAt = assertOpenWindowStatus(status, windowMinutes, clock(io));
    assertStatusMatchesAdmission(status, state, clock(io));
    io.recordAdmissionState?.({ phase: 'resumed', state, result: 'observed', window_minutes: windowMinutes,
      admission_window_expires_at: admissionWindowExpiresAt });
    const finalState = await readAdmissionState(io);
    assertOpenedAdmission(finalState, original);
    assertStatusMatchesAdmission(status, finalState, clock(io));
    io.recordAdmissionState?.({ phase: 'verified', state: finalState, result: 'verified', window_minutes: windowMinutes,
      admission_window_expires_at: admissionWindowExpiresAt, lifecycle_status_sha256: contentHash(status) });
    return { original, state: finalState, status, window_minutes: windowMinutes,
      admission_window_expires_at: admissionWindowExpiresAt, runtime_verification: verification };
  } catch (error) {
    // Nothing before the resume attempt can have lifted suspension, so those
    // failures record the observed state and never issue a suspension of their own.
    if (!requested) {
      const { state } = await observeAdmissionState(io);
      io.recordAdmissionState?.({ phase: 'failed', state, result: 'failed' });
      throw new Error('Beta admission window failed before it was requested; preserve observed state for explicit recovery', { cause: error });
    }
    // The window may be open. Close it back to the recorded decision before
    // throwing; the record names the suspension as the failed-window recovery it is.
    let closeError;
    try {
      await io.oneShot('lifecycle', revision, 'suspend');
      const closed = await readAdmissionState(io);
      assertClosedAdmission(closed, original);
      io.recordAdmissionState?.({ phase: 'suspended', state: closed, result: 'observed', close_kind: 'failed-window' });
    } catch (recoveryError) { closeError = recoveryError; }
    const { state } = await observeAdmissionState(io);
    io.recordAdmissionState?.({ phase: 'failed', state, result: 'failed', close_kind: 'failed-window' });
    if (closeError) {
      throw new AggregateError([error, closeError],
        `Beta admission window failed and its recovery suspension did not restore the recorded decision; observed admission may be open: ${describeAdmission(state)}`,
        { cause: error });
    }
    throw new Error('Beta admission window failed and was suspended back to the recorded decision; preserve observed state for explicit recovery',
      { cause: error });
  }
}
