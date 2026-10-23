import { canonicalJson, contentHash, sha256 } from './json-contract.mjs';
import { ADMISSION_MODE_PARAMETER, ADMISSION_MODE_CLOSED, ADMISSION_MODE_TESTERS, admissionClock, describeAdmissionMode } from './admission-mode.mjs';
import { canonicalTesterList, observeAdmissionState, readAdmissionState, assertProvableAdmissionClosure } from './admission-state.mjs';
import { workloadRevision } from './workload-revision.mjs';
import { assertProtectedExecutor } from './operation-boundaries.mjs';
import { runtimeStack, assertRuntimeReady, describeStack } from './one-writer.mjs';

export { readAdmissionState } from './admission-state.mjs';
// The standalone `migrate` operation uses this fence from `admission-mode.mjs`;
// it refuses unless the admission mirror proves closed admission.
export { assertMigrationAdmissionClosed } from './admission-mode.mjs';

const stableStatuses = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']);
const values = stack => Object.fromEntries((stack?.Outputs ?? []).map(row => [row.OutputKey, row.OutputValue]));
const testerList = value => canonicalJson(canonicalTesterList(value));

const admissionEntry = 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main';
function assertAdmissionExecutor(env) {
  if (env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Infra' || env.GITHUB_WORKFLOW_REF !== admissionEntry) throw new Error('Protected Infra admission executor required');
}

// Issue #166: admission acts on the deployed compute only. Beta runs when the
// Infra-owned Runtime stack exists; the Base stack stays persistent and no
// `BetaActive` output describes partial activation.
function assertRunningBeta(platform, runtime, purpose) {
  if (!stableStatuses.has(platform?.StackStatus)) throw new Error(`Stable Beta Base stack required to ${purpose}`);
  assertRuntimeReady(runtime, `Admission (${purpose})`);
  if (values(platform).EcsClusterName !== 'beta-anywear') throw new Error(`Running Beta Base cluster required to ${purpose}`);
  return values(platform);
}

// Closure is the mode's own decision, and it must be a decision the record can
// prove: a `closed` record this repository wrote. An unreadable or malformed value
// reads closed for admission, but it is not proof, so a mutating admission
// operation refuses it instead of trusting it.
export function assertClosedAdmission(state, original) {
  assertProvableAdmissionClosure(state, 'Beta admission is not proven closed');
  if (testerList(state.tester_emails) !== testerList(original?.tester_emails)) throw new Error('Beta tester list changed during admission closure');
  return state;
}

// The open mirror of the closed assertion: opening is the tester lane, so the
// recorded membership does not change. There is no bound to prove; the mode word
// in the record is the whole decision.
export function assertOpenedAdmission(state, original) {
  if (state?.admission_mode !== ADMISSION_MODE_TESTERS || state?.admission_mode_source !== 'record') throw new Error('Beta admission is not proven open');
  if (testerList(state.tester_emails) !== testerList(original?.tester_emails)) throw new Error('Beta tester list changed during the admission open');
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
  // Both surfaces are mode-only now, so the removed window field is not required.
  // It is still tolerated while a Service image deployed before this batch is
  // serving `status` during a rollout, but it is never read as a decision and the
  // open path refuses a status that still carries it.
  if (Object.hasOwn(value, 'admission_window_expires_at') && value.admission_window_expires_at !== null
    && typeof value.admission_window_expires_at !== 'string') throw new Error('Invalid lifecycle admission_window_expires_at');
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

// The deployed Service no longer has window semantics, and its status no longer
// emits the removed field. A status image deployed before this batch still emits
// it, so its presence is the executable evidence that the running Service is old.
export const lifecycleStatusReportsExpiry = status => Object.hasOwn(status ?? {}, 'admission_window_expires_at');

// The status read-back and the SSM mirror must describe the same *effective* mode.
// `admission_mode` is the effective decision every gate uses, so the comparison is
// effective-to-effective and never against a raw stored word. The raw record is
// published beside it: `database_record_differs` from the Service and
// `mirror_record_differs` from this comparison, because each surface can store its
// own word while both decide the same mode. There is no bound to compare.
export function compareAdmissionDecision(status, state, now = Date.now()) {
  const unavailable = state?.admission_mode === 'unavailable';
  const effectiveMatches = status.database_policy_matches_ssm === true
    && status.admission_mode === state?.admission_mode
    && status.tester_count === (Array.isArray(state?.tester_emails) ? state.tester_emails.length : -1);
  return { effective_matches: effectiveMatches,
    database_record_differs: status.database_record_differs,
    mirror_record_differs: unavailable ? 'unavailable' : status.admission_record !== state?.admission_recorded_mode,
    observed_at: new Date(now).toISOString(),
    database: { admission_mode: status.admission_mode,
      admission_record: status.admission_record, database_record_differs: status.database_record_differs,
      tester_count: status.tester_count, database_policy_matches_ssm: status.database_policy_matches_ssm } };
}

function assertStatusMatchesAdmission(status, state, now = Date.now()) {
  const comparison = compareAdmissionDecision(status, state, now);
  const decision = comparison.database;
  if (decision.database_policy_matches_ssm !== true) throw new Error('Lifecycle DB/SSM admission readback mismatch');
  if (decision.admission_mode !== state.admission_mode) throw new Error('Lifecycle DB/SSM admission readback mismatch');
  if (decision.tester_count !== state.tester_emails.length) throw new Error('Lifecycle DB/SSM admission readback mismatch');
  return comparison;
}

// `close-admission` classifies what it ended from the database status read, never
// from the SSM mirror. Both surfaces are mode-only, so the mode word is enough:
// - ordinary: the effective decision is `testers`; an open admission was closed.
// - already-closed: the effective decision is `closed`; suspending changed nothing.
export function classifyCloseKind(status) {
  return status?.admission_mode === ADMISSION_MODE_TESTERS ? 'ordinary' : 'already-closed';
}

// The pre-open fence. It needs the effective database decision provably closed and
// the database policy to agree with SSM, so a resume never lifts suspension from a
// surface that disagrees with itself. The removed window field may still be
// present on a Service image from before this batch; this fence deliberately does
// not depend on it, because the post-open read-back is what proves the deployed
// Service no longer reports it.
function assertClosedAdmissionStatus(status) {
  if (status.admission_mode !== ADMISSION_MODE_CLOSED) throw new Error('Admission must be provably closed before admission opens');
  if (status.database_policy_matches_ssm !== true) throw new Error('Admission database/SSM policy must agree before admission opens');
}

// The post-open read-back, and the executable proof that the running Service has no
// window semantics: the removed field must be absent, not null. A Service image
// from before this batch is refused here rather than silently treated as open.
export function assertOpenAdmissionStatus(status) {
  if (status.admission_mode !== ADMISSION_MODE_TESTERS || status.database_policy_matches_ssm !== true) {
    throw new Error('Lifecycle database admission is not proven open');
  }
  if (lifecycleStatusReportsExpiry(status)) {
    throw new Error('Deployed Service still reports the removed admission window field; deploy the Service revision without window semantics before opening admission');
  }
  return status;
}

const clock = admissionClock;
const describeAdmission = state => `${describeAdmissionMode(state)}, `
  + `tester_count=${Array.isArray(state?.tester_emails) ? state.tester_emails.length : 'unavailable'}`;

export async function runCloseAdmission({ io, infraSha, env = process.env }) {
  // Source rejection must precede any authenticated activity or lifecycle task.
  assertAdmissionExecutor(env);
  assertProtectedExecutor(infraSha, env);
  let revision;
  try {
    const platform = await describeStack(io, 'AnyWearPlatformStack-beta');
    const runtime = await describeStack(io, runtimeStack);
    assertRunningBeta(platform, runtime, 'close admission');
    revision = workloadRevision(runtime);
    const original = await readAdmissionState(io);
    // Read the database admission state before closing so the run reports
    // whether it ended an open admission.
    const prior = parseLifecycleStatus(await io.oneShot('lifecycle', revision, 'status'));
    const closeKind = classifyCloseKind(prior);
    await io.oneShot('lifecycle', revision, 'suspend');
    const state = await readAdmissionState(io);
    assertClosedAdmission(state, original);
    const status = parseLifecycleStatus(await io.oneShot('lifecycle', revision, 'status'));
    assertStatusMatchesAdmission(status, state, clock(io));
    // Status is read-only, but take a final SSM snapshot so its observed DB policy
    // cannot be accepted against admission values changed during that task.
    const finalState = await readAdmissionState(io);
    assertClosedAdmission(finalState, original);
    assertStatusMatchesAdmission(status, finalState, clock(io));
    // The close verdict is a run fact: the step log names what it ended, and the
    // admission value is redacted to a mode + count (#207).
    process.stdout.write(`${JSON.stringify({ operation: 'close-admission', close_kind: closeKind,
      admission: describeAdmission(finalState) })}\n`);
    return { original, state: finalState, status, close_kind: closeKind };
  } catch (error) {
    // The failed close prints the redacted admission state it actually observed, so
    // "preserve observed state for explicit recovery" names something the operator
    // can read from the run (#207).
    const { state } = await observeAdmissionState(io);
    process.stdout.write(`${JSON.stringify({ operation: 'close-admission', result: 'failed',
      admission: describeAdmission(state) })}\n`);
    throw new Error('Beta admission close failed; preserve observed state for explicit recovery', { cause: error });
  }
}

// The post-open proof: one first-class event that says "open, no bound, both
// surfaces agree" without reading logs. It is evidence, not a substitute for the
// assertions above; both computed claims must be true or the operation fails.
function admissionOpenProof({ state, status, observedAt }) {
  const testers = state.tester_emails;
  const testerCount = Array.isArray(testers) ? testers.length : -1;
  const recordKeys = state.admission_recorded_keys;
  const reportsExpiry = lifecycleStatusReportsExpiry(status);
  const keyListAbsent = Array.isArray(recordKeys) && recordKeys.length === 1 && recordKeys[0] === 'mode';
  return {
    type: 'admission-open-proof',
    schema_version: 1,
    observed_at: observedAt,
    mode: ADMISSION_MODE_TESTERS,
    mode_source: state.admission_mode_source,
    no_bound: keyListAbsent && reportsExpiry === false,
    tester_count: testerCount,
    tester_emails_sha256: sha256(canonicalJson(testers)),
    surfaces_agree: status.database_policy_matches_ssm === true
      && status.admission_mode === state.admission_mode
      && status.tester_count === testerCount,
    ssm: {
      parameter: ADMISSION_MODE_PARAMETER,
      recorded_mode: state.admission_recorded_mode,
      record_keys: recordKeys,
      expires_at_present: Array.isArray(recordKeys) ? recordKeys.includes('expires_at') : 'unavailable',
    },
    database: {
      lifecycle_status_mode: status.admission_mode,
      lifecycle_status_record: status.admission_record,
      lifecycle_status_reports_expires_at: reportsExpiry,
      database_policy_matches_ssm: status.database_policy_matches_ssm,
      tester_count: status.tester_count,
      lifecycle_status_sha256: contentHash(status),
    },
  };
}

export async function runOpenAdmission({ io, infraSha, env = process.env }) {
  // Source rejection must precede any authenticated activity or lifecycle task.
  assertAdmissionExecutor(env);
  assertProtectedExecutor(infraSha, env);
  let revision; let original; let requested = false;
  try {
    const platform = await describeStack(io, 'AnyWearPlatformStack-beta');
    const runtime = await describeStack(io, runtimeStack);
    assertRunningBeta(platform, runtime, 'open admission');
    revision = workloadRevision(runtime);
    // Refuse before resuming unless the database decision is provably closed and
    // the database policy agrees with the mirror.
    assertClosedAdmissionStatus(parseLifecycleStatus(await io.oneShot('lifecycle', revision, 'status')));
    original = await readAdmissionState(io);
    // The mirror has no bound, so it reads `testers` until an explicit close writes
    // `closed`. Requiring the record to prove closure is what makes opening refuse
    // from a value it cannot trust; such a record is repaired by `close-admission`.
    assertProvableAdmissionClosure(original, 'Admission mirror does not prove closed admission before admission opens');
    requested = true;
    // Lifecycle `resume` takes no payload: the Service has no bound to write.
    await io.oneShot('lifecycle', revision, 'resume');
    const state = await readAdmissionState(io);
    assertOpenedAdmission(state, original);
    const status = parseLifecycleStatus(await io.oneShot('lifecycle', revision, 'status'));
    assertOpenAdmissionStatus(status);
    assertStatusMatchesAdmission(status, state, clock(io));
    // Re-read SSM after the status task so the proof binds one version of both
    // surfaces instead of accepting a value that changed during the status read.
    const finalState = await readAdmissionState(io);
    assertOpenedAdmission(finalState, original);
    assertStatusMatchesAdmission(status, finalState, clock(io));
    const proof = admissionOpenProof({ state: finalState, status, observedAt: new Date(clock(io)).toISOString() });
    if (proof.no_bound !== true || proof.surfaces_agree !== true) {
      throw new Error(`Admission open proof failed: no_bound=${proof.no_bound}, surfaces_agree=${proof.surfaces_agree}`);
    }
    // The post-open proof is a run fact: one printed line says "open, no bound,
    // both surfaces agree", and it is not recorded (#207).
    process.stdout.write(`${JSON.stringify(proof)}\n`);
    return { original, state: finalState, status, proof };
  } catch (error) {
    // Nothing before the resume attempt can have opened admission, so this path
    // issues no close of its own; the printed redacted state and the cause chain
    // are the whole verdict.
    if (!requested) {
      const { state } = await observeAdmissionState(io);
      process.stdout.write(`${JSON.stringify({ operation: 'open-admission', result: 'failed-before-request',
        admission: describeAdmission(state) })}\n`);
      throw new Error('Beta admission open failed before it was requested; preserve observed state for explicit recovery', { cause: error });
    }
    // Admission may be open. Close it back to the recorded decision before
    // throwing; the printed line names the close as the failed-open recovery it is.
    let closeError;
    try {
      await io.oneShot('lifecycle', revision, 'suspend');
      const closed = await readAdmissionState(io);
      assertClosedAdmission(closed, original);
    } catch (recoveryError) { closeError = recoveryError; }
    const { state } = await observeAdmissionState(io);
    process.stdout.write(`${JSON.stringify({ operation: 'open-admission', result: 'failed-open',
      close_kind: closeError ? 'failed-open-close-failed' : 'failed-open',
      admission: describeAdmission(state) })}\n`);
    if (closeError) {
      throw new AggregateError([error, closeError],
        `Beta admission open failed and its recovery close did not restore the recorded decision; observed admission may be open: ${describeAdmission(state)}`,
        { cause: error });
    }
    throw new Error('Beta admission open failed and was closed back to the recorded decision (close_kind=failed-open); with no automatic closure an interrupted open can stay open until an explicit close-admission',
      { cause: error });
  }
}
