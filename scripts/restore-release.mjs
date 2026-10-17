import { workloadRevision } from './workload-revision.mjs';
import { readAdmissionState, assertClosedAdmission } from './admission-operation.mjs';
import { assertVerificationExecutor, runRuntimeVerification } from './verify-runtime-task.mjs';
import { canonicalJson, sha256, SHA } from './json-contract.mjs';
import { retainedBetaSizingProfile, retainedBetaSizingTelemetry } from './beta-sizing-profile.mjs';

const platformName = 'AnyWearPlatformStack-beta';
const workloadName = 'AnyWearWorkloadStack-beta';
const stableStatuses = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']);
const parameterKeys = ['ServiceImageDigest', 'ServiceCommitSha', 'VlmConfigArn', 'CloudFrontPrefixListId'];
// A restore changes the release, so only the outputs this operation consumes are
// a stable interface. scripts/verify-runtime-task.mjs requires the first eleven
// Platform outputs below; its required-key list is the source of that subset and
// must be kept in step with this literal. Verification also passes the two queue
// URLs to the one-shot task. BetaActive is covered by assertResidentStacks.
const platformInterfaceKeys = ['EcsClusterName', 'PrivateSubnetIds', 'OneShotSecurityGroupId', 'VerificationTaskRoleArn',
  'OneShotExecutionRoleArn', 'OneShotLogGroupName', 'DatabaseSecretArn', 'DatabaseHost', 'DatabasePort', 'DatabaseName',
  'WardrobeBucketName', 'VtoQueueUrl', 'AutoTaggingQueueUrl'];
// ApiBaseUrl is the only Workload output the restore consumes. Other Workload
// outputs are internal attributes and may legitimately move with the release.
const workloadInterfaceKeys = ['ApiBaseUrl'];
const outputs = stack => Object.fromEntries((stack?.Outputs ?? []).map(row => [row.OutputKey, row.OutputValue]));
const selectOutputs = (all, keys) => Object.fromEntries(keys.map(key => [key, all[key]]));
const stackRead = async (io, name) => (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', name])).Stacks?.[0];

function assertContext(infraSha, env) {
  assertVerificationExecutor(infraSha, env);
  if (env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Infra' || !SHA.test(infraSha ?? '') || env.GITHUB_SHA !== infraSha
    || env.GITHUB_WORKFLOW_REF !== 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main') {
    throw new Error('Restore requires the reviewed Infra executor source');
  }
  if (env.INFRA_IDENTITY_PHASE !== 'retired' || env.INFRA_RETENTION_PROTECTION !== 'true') {
    throw new Error('Restore requires retired identity and retention protection');
  }
}

// Closed admission is the only activation precondition. Stable stack status is a
// CloudFormation mutation-safety requirement, not an activation requirement; an
// inactive stack is rejected later by the resident postcondition below (and by the
// shared runtime verifier before any deploy), never by this precondition.
function assertRestoreTarget(platform, workload) {
  for (const [name, stack] of [[platformName, platform], [workloadName, workload]]) {
    if (!stableStatuses.has(stack?.StackStatus)) throw new Error(`Restore requires stable ${name}`);
  }
  if (outputs(platform).EcsClusterName !== 'beta-anywear') throw new Error('Restore is restricted to beta-anywear');
}

// The resident invariant, re-asserted after each deploy rather than required of
// the operator's starting point.
function assertResidentStacks(platform, workload) {
  for (const [name, stack] of [[platformName, platform], [workloadName, workload]]) {
    if (!stableStatuses.has(stack?.StackStatus)) throw new Error(`Restore requires stable ${name} after deploy`);
    if (outputs(stack).BetaActive !== 'true') throw new Error(`Restore requires active ${name} after deploy`);
  }
}

// A release-changing restore may move outputs the operation does not consume
// (internal attributes such as an ALB DNS name), but a consumed interface output
// must stay present and unchanged.
function assertInterface(name, actual, original, keys) {
  for (const key of keys) {
    if (!actual[key]) throw new Error(`Restore ${name} interface output ${key} missing after deploy`);
    if (actual[key] !== original[key]) throw new Error(`Restore ${name} interface output ${key} changed after deploy`);
  }
}

function assertParameters(workload, selected) {
  const actual = workloadRevision(workload);
  for (const key of parameterKeys) {
    if (actual.parameters[key] !== selected.parameters[key]) throw new Error(`Restore parameter readback mismatch for ${key}`);
  }
  for (const retained of [retainedBetaSizingProfile, retainedBetaSizingTelemetry]) {
    if (retained(actual.parameters) !== retained(selected.parameters)) throw new Error('Restore retained Beta sizing parameter readback mismatch');
  }
}

function redactedAdmission(state) {
  return { admission_mode: state.admission_mode, admission_window_expires_at: state.admission_window_expires_at,
    admission_mode_source: state.admission_mode_source,
    tester_count: state.tester_emails.length, tester_allowlist_sha256: sha256(canonicalJson(state.tester_emails)) };
}

async function failureReadback(io, stage) {
  const observed = { failure_stage: stage, recovery: 'requires-explicit-recovery' };
  for (const [key, name] of [['platform', platformName], ['workload', workloadName]]) {
    try {
      const stack = await stackRead(io, name);
      observed[`${key}_status`] = /^[A-Z_]{1,64}$/.test(stack?.StackStatus ?? '') ? stack.StackStatus : 'unavailable';
      const active = outputs(stack).BetaActive;
      observed[`${key}_active`] = ['true', 'false'].includes(active) ? active : 'unavailable';
      if (key === 'workload') {
        const parameters = Object.fromEntries((stack?.Parameters ?? []).map(row => [row.ParameterKey, row.ParameterValue]));
        observed.service_sha = SHA.test(parameters.ServiceCommitSha ?? '') ? parameters.ServiceCommitSha : 'unavailable';
        observed.image_digest = /^sha256:[a-f0-9]{64}$/.test(parameters.ServiceImageDigest ?? '') ? parameters.ServiceImageDigest : 'unavailable';
      }
    } catch {
      observed[`${key}_status`] = 'unavailable'; observed[`${key}_active`] = 'unavailable';
      if (key === 'workload') { observed.service_sha = 'unavailable'; observed.image_digest = 'unavailable'; }
    }
  }
  // The shared reader preserves each independently known field even when another
  // SSM value is malformed/unavailable. Never retain raw tester addresses.
  let admission;
  try { admission = await readAdmissionState(io); }
  catch (error) { admission = error.observedAdmissionState; }
  for (const key of ['admission_mode', 'admission_window_expires_at']) {
    const value = admission?.[key];
    observed[key] = typeof value === 'string' || value === null ? value : 'unavailable';
  }
  observed.tester_count = Array.isArray(admission?.tester_emails) ? admission.tester_emails.length : 'unavailable';
  observed.tester_allowlist_sha256 = Array.isArray(admission?.tester_emails) ? sha256(canonicalJson(admission.tester_emails)) : 'unavailable';
  return observed;
}

// Called inside the ordinary Infra queue after immutable release/source checks.
// A candidate may differ from the live image. Its actual policy/journal and DB
// compatibility must be proved on the current Platform before either CFN deploy.
export async function runRestoreRelease({ io, selector, manifest, schema, infraSha, env = process.env,
  verifyRuntime = runRuntimeVerification }) {
  // Reject source/context before any authenticated read or task. The enclosing
  // runtime additionally validates the committed selection and dispatch inputs.
  assertContext(infraSha, env);
  let stage = 'preconditions'; let originalAdmission; let lastAdmission;
  const closed = async () => {
    assertContext(infraSha, env);
    lastAdmission = await readAdmissionState(io);
    assertClosedAdmission(lastAdmission, originalAdmission);
  };
  const phase = async (name, action) => {
    stage = name;
    await io.recordRestoreStage?.({ stage, result: 'began' });
    assertContext(infraSha, env);
    await closed();
    const result = await action();
    await closed();
    await io.recordRestoreStage?.({ stage, result: 'succeeded',
      ...(stage === 'candidate-verification' ? { verification: result } : {}) });
    return result;
  };
  try {
    await io.recordRestoreStage?.({ stage, result: 'began' });
    assertContext(infraSha, env);
    const platform = await stackRead(io, platformName); const workload = await stackRead(io, workloadName);
    assertRestoreTarget(platform, workload);
    const originalOutputs = outputs(platform); const originalWorkloadOutputs = outputs(workload);
    if (!originalWorkloadOutputs.ApiBaseUrl) throw new Error('Restore API interface unavailable');
    const originalPlatformInterface = selectOutputs(originalOutputs, platformInterfaceKeys);
    const originalWorkloadInterface = selectOutputs(originalWorkloadOutputs, workloadInterfaceKeys);
    const current = workloadRevision(workload);
    retainedBetaSizingProfile(current.parameters);
    retainedBetaSizingTelemetry(current.parameters);
    const selected = { ...current, digest: selector.image.digest, commit: selector.image.service_sha,
      parameters: { ...current.parameters, ServiceImageDigest: selector.image.digest, ServiceCommitSha: selector.image.service_sha } };
    // Reuse the existing strict immutable revision and preserved-parameter checks.
    workloadRevision({ Parameters: Object.entries(selected.parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })) });
    originalAdmission = await readAdmissionState(io);
    assertClosedAdmission(originalAdmission, originalAdmission); lastAdmission = originalAdmission;
    await io.recordRestoreStage?.({ stage, result: 'succeeded' });

    const candidate = await phase('candidate-verification', () => verifyRuntime({ io, outputs: originalOutputs,
      selector, manifest, schema, infraSha, env }));
    const readSelected = async () => {
      const actualPlatform = await stackRead(io, platformName); const actualWorkload = await stackRead(io, workloadName);
      assertResidentStacks(actualPlatform, actualWorkload); assertParameters(actualWorkload, selected);
      assertInterface('Platform', outputs(actualPlatform), originalPlatformInterface, platformInterfaceKeys);
      assertInterface('Workload', outputs(actualWorkload), originalWorkloadInterface, workloadInterfaceKeys);
      return actualWorkload;
    };
    await phase('workload-deploy', () => io.deploy(workloadName, selected));
    const stableServices = () => io.aws(['ecs', 'wait', 'services-stable', '--cluster', 'beta-anywear',
      '--services', 'beta-anywear-api', 'beta-anywear-worker']);
    await phase('workload-stable-readback', async () => { await stableServices(); await readSelected(); });
    await phase('platform-deploy', () => io.deploy(platformName, selected));
    await phase('selected-runtime-qualification', async () => {
      await stableServices();
      const actual = await readSelected(); const url = outputs(actual).ApiBaseUrl;
      if (!url) throw new Error('Restore API interface unavailable');
      await io.verifyHealth(url, selected);
      await closed();
      await io.oneShot('verify', selected, url);
    });
    await phase('final-readback', readSelected);
    return { selected_revision: selected, candidate_verification: candidate, admission: redactedAdmission(lastAdmission) };
  } catch (error) {
    const observed = await failureReadback(io, stage);
    // Evidence-hook failures must never resume a sibling deployment or recovery.
    try { await io.recordRestoreStage?.({ stage, result: 'failed' }); } catch { /* Preserve the original failure. */ }
    try { await io.recordRestoreState?.(observed); } catch { /* Preserve the original failure. */ }
    try { await io.recordRecovery?.('requires-explicit-recovery'); } catch { /* Preserve the original failure. */ }
    throw new Error(`Beta release restore failed at ${stage}; explicit recovery required; Platform=${observed.platform_active} (${observed.platform_status}), Workload=${observed.workload_active} (${observed.workload_status})`, { cause: error });
  }
}
