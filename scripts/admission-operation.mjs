import { canonicalJson, contentHash, parseJson } from './json-contract.mjs';
import { normalizeTesterEmails } from './tester-allowlist.mjs';
import { workloadRevision } from '../.github/scripts/beta-lifecycle.mjs';
import { assertVerificationExecutor, runRuntimeVerification } from './verify-runtime-task.mjs';

const parameterNames = {
  admission_suspended: '/anywear/beta/admission_suspended',
  intake_open: '/anywear/beta/intake_open',
  tester_emails: '/anywear/beta/tester_allowlist',
};
const stableStatuses = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']);
const values = stack => Object.fromEntries((stack?.Outputs ?? []).map(row => [row.OutputKey, row.OutputValue]));
const unavailableState = () => ({ admission_suspended: 'unavailable', intake_open: 'unavailable', tester_emails: 'unavailable' });

export async function readAdmissionState(io) {
  const entries = Object.entries(parameterNames);
  // Read every field even when another read fails, so failure evidence preserves
  // the actual known values without converting missing/malformed values to false.
  const reads = await Promise.allSettled(entries.map(async ([key, name]) => {
    const parameter = (await io.aws(['ssm', 'get-parameter', '--name', name])).Parameter;
    if (parameter?.Name !== undefined && parameter.Name !== name) throw new Error('Unexpected admission parameter identity');
    const value = parameter?.Value;
    if (key === 'tester_emails') return parseJson(normalizeTesterEmails(value));
    if (value !== 'true' && value !== 'false') throw new Error('Admission parameter requires an exact boolean');
    return value === 'true';
  }));
  const state = unavailableState();
  for (let index = 0; index < entries.length; index++) {
    if (reads[index].status === 'fulfilled') state[entries[index][0]] = reads[index].value;
  }
  if (reads.some(read => read.status === 'rejected')) {
    const error = new Error('Complete valid Beta admission state unavailable');
    error.observedAdmissionState = state;
    throw error;
  }
  return state;
}

function testerList(value) {
  return parseJson(normalizeTesterEmails(canonicalJson(value)));
}

export function assertClosedAdmission(state, original) {
  if (state?.admission_suspended !== true || state?.intake_open !== false) throw new Error('Beta admission is not proven suspended with intake closed');
  if (canonicalJson(testerList(state.tester_emails)) !== canonicalJson(testerList(original?.tester_emails))) throw new Error('Beta tester list changed during admission closure');
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

export async function runCloseAdmission({ io, selector, manifest, schema, infraSha, env = process.env, verifyRuntime = runRuntimeVerification }) {
  // Source rejection must precede any authenticated activity or lifecycle task.
  if (env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Infra'
    || env.GITHUB_WORKFLOW_REF !== 'git-malu/AnyWear-Infra/.github/workflows/beta-admission.yml@refs/heads/main') throw new Error('Protected Infra admission executor required');
  assertVerificationExecutor(infraSha, env);
  try {
    const platform = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearPlatformStack-beta'])).Stacks?.[0];
    const workload = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearWorkloadStack-beta'])).Stacks?.[0];
    if (!stableStatuses.has(platform?.StackStatus) || !stableStatuses.has(workload?.StackStatus)) throw new Error('Stable Beta stacks required to close admission');
    const outputs = values(platform);
    if (outputs.BetaActive !== 'true' || values(workload).BetaActive !== 'true' || outputs.EcsClusterName !== 'beta-anywear') throw new Error('Active Beta required to close admission');
    const revision = workloadRevision(workload);
    if (revision.commit !== selector.image.service_sha || revision.digest !== selector.image.digest) throw new Error('Admission closure must retain the deployed selected image');
    const original = await readAdmissionState(io);
    io.recordAdmissionState?.({ phase: 'original', state: original, result: 'observed' });
    // The selected existing Service close command sets suspension only. Public
    // intake must already be closed, and its tester list must remain unchanged.
    if (original.intake_open !== false) throw new Error('Public intake must already be closed before admission closure');
    const verification = await verifyRuntime({ io, outputs, selector, manifest, schema, infraSha, env });
    await io.oneShot('lifecycle', revision, 'close');
    const state = await readAdmissionState(io);
    io.recordAdmissionState?.({ phase: 'closed', state, result: 'observed' });
    assertClosedAdmission(state, original);
    const status = parseLifecycleStatus(await io.oneShot('lifecycle', revision, 'status'));
    assertStatusMatchesAdmission(status, state);
    // Status is read-only, but take a final SSM snapshot so its observed DB policy
    // cannot be accepted against admission values changed during that task.
    const finalState = await readAdmissionState(io);
    assertClosedAdmission(finalState, original);
    assertStatusMatchesAdmission(status, finalState);
    io.recordAdmissionState?.({ phase: 'closed', state: finalState, result: 'verified', lifecycle_status_sha256: contentHash(status) });
    return { original, state: finalState, status, runtime_verification: verification };
  } catch (error) {
    let state;
    try { state = await readAdmissionState(io); }
    catch (readError) { state = readError.observedAdmissionState ?? unavailableState(); }
    io.recordAdmissionState?.({ phase: 'failed', state, result: 'failed' });
    throw new Error('Beta admission closure failed; preserve observed state for explicit recovery', { cause: error });
  }
}
