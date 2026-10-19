import { readAdmissionState, assertClosedAdmission } from './admission-operation.mjs';
import { assertProtectedExecutor } from './operation-boundaries.mjs';
import { assertTerminalRuntime, assertRuntimeReady, terminalStackStatuses, runtimeStack } from './one-writer.mjs';
import { canonicalJson, sha256, SHA } from './json-contract.mjs';

const platformName = 'AnyWearPlatformStack-beta';
const runtimeName = runtimeStack;
const stableStatuses = terminalStackStatuses;
// The Base stack is the only stack this operation deploys. A release recovery
// restores the persistent Base and leaves the Runtime slice to AnyWear-Service's
// own release chain; the Runtime is read here to prove it exists and is terminal
// before and after the deploy, so the two producers never cross a deployment.
const platformInterfaceKeys = ['EcsClusterName', 'PrivateSubnetIds', 'OneShotSecurityGroupId', 'VerificationTaskRoleArn',
  'OneShotExecutionRoleArn', 'OneShotLogGroupName', 'DatabaseSecretArn', 'DatabaseHost', 'DatabasePort', 'DatabaseName',
  'WardrobeBucketName', 'VtoQueueUrl', 'AutoTaggingQueueUrl', 'ServiceRepositoryUri', 'ServiceRepositoryName',
  'ApiDistributionId', 'ApiDistributionDomainName', 'ApiBaseUrl'];
const outputs = stack => Object.fromEntries((stack?.Outputs ?? []).map(row => [row.OutputKey, row.OutputValue]));
const selectOutputs = (all, keys) => Object.fromEntries(keys.map(key => [key, all[key]]));
const stackRead = async (io, name) => (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', name])).Stacks?.[0];

function assertContext(infraSha, env) {
  assertProtectedExecutor(infraSha, env);
  if (env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Infra' || !SHA.test(infraSha ?? '') || env.GITHUB_SHA !== infraSha
    || env.GITHUB_WORKFLOW_REF !== 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main') {
    throw new Error('Restore requires the reviewed Infra executor source');
  }
  if (env.INFRA_IDENTITY_PHASE !== 'retired' || env.INFRA_RETENTION_PROTECTION !== 'true') {
    throw new Error('Restore requires retired identity and retention protection');
  }
}

// Closed admission and a live Runtime are the preconditions. Stable stack status
// is a CloudFormation mutation-safety requirement, not an activation requirement.
// A missing Runtime means the operator must start first (deploy-egress, then the
// Service deploy) instead of restoring an environment nothing is serving.
function assertRestoreTarget(platform) {
  if (!stableStatuses.has(platform?.StackStatus)) throw new Error(`Restore requires stable ${platformName}`);
  if (outputs(platform).EcsClusterName !== 'beta-anywear') throw new Error('Restore is restricted to beta-anywear');
}

function assertRuntimeStarted(runtime) {
  assertRuntimeReady(runtime, 'Restore');
}

// One writer per stack: a Base deploy must not cross a Runtime deployment, so
// the Runtime is terminal before and after. This is a read-only precondition, not
// a claim to deploy or observe its resources.
function assertRuntimeTerminal(runtime) {
  assertTerminalRuntime(runtime, 'Restore');
}

function assertRestoredPlatform(platform) {
  if (!stableStatuses.has(platform?.StackStatus)) throw new Error(`Restore requires stable ${platformName} after deploy`);
}

// A restore may move outputs the operation does not consume, but a consumed
// interface output must stay present and unchanged.
function assertInterface(actual, original) {
  for (const key of platformInterfaceKeys) {
    if (!actual[key]) throw new Error(`Restore interface output ${key} missing after deploy`);
    if (actual[key] !== original[key]) throw new Error(`Restore interface output ${key} changed after deploy`);
  }
}

// The adopted API distribution must still be serving after the Base update: the
// CloudFront status is the postcondition the CloudFormation stack alone cannot
// prove.
async function assertDistributionDeployed(io, platform) {
  const all = outputs(platform);
  const id = all.ApiDistributionId;
  const domain = all.ApiDistributionDomainName;
  if (!id || !domain) throw new Error('Restore requires the Base API distribution id and domain outputs');
  const distribution = (await io.aws(['cloudfront', 'get-distribution', '--id', id])).Distribution;
  if (distribution?.Id !== id || distribution?.Status !== 'Deployed' || distribution?.DomainName !== domain) {
    throw new Error(`Restore requires the Base API distribution ${id} to be Deployed with its recorded domain`);
  }
}

function redactedAdmission(state) {
  return { admission_mode: state.admission_mode,
    admission_mode_source: state.admission_mode_source,
    admission_recorded_mode: state.admission_recorded_mode,
    admission_recorded_keys: state.admission_recorded_keys,
    tester_count: state.tester_emails.length, tester_allowlist_sha256: sha256(canonicalJson(state.tester_emails)) };
}

async function failureReadback(io, stage) {
  const observed = { failure_stage: stage, recovery: 'requires-explicit-recovery' };
  for (const [key, name] of [['base', platformName], ['runtime', runtimeName]]) {
    try {
      const stack = await stackRead(io, name);
      observed[`${key}_status`] = /^[A-Z_]{1,64}$/.test(stack?.StackStatus ?? '') ? stack.StackStatus : 'unavailable';
      observed[`${key}_exists`] = stack?.StackName === name;
    } catch {
      observed[`${key}_status`] = 'unavailable'; observed[`${key}_exists`] = 'unavailable';
    }
  }
  // The shared reader preserves each independently known field even when another
  // SSM value is malformed/unavailable. Never retain raw tester addresses.
  let admission;
  try { admission = await readAdmissionState(io); }
  catch (error) { admission = error.observedAdmissionState; }
  for (const key of ['admission_mode', 'admission_recorded_mode']) {
    const value = admission?.[key];
    observed[key] = typeof value === 'string' || value === null ? value : 'unavailable';
  }
  observed.admission_recorded_keys = Array.isArray(admission?.admission_recorded_keys)
    ? admission.admission_recorded_keys : 'unavailable';
  observed.tester_count = Array.isArray(admission?.tester_emails) ? admission.tester_emails.length : 'unavailable';
  observed.tester_allowlist_sha256 = Array.isArray(admission?.tester_emails) ? sha256(canonicalJson(admission.tester_emails)) : 'unavailable';
  return observed;
}

// Called inside the ordinary Infra queue after the reviewed Service release and
// source checks. Only the Base stack is deployed; the Runtime slice is neither
// verified nor deployed here, because both moved to the Service release chain.
export async function runRestoreRelease({ io, infraSha, env = process.env }) {
  // Reject source/context before any authenticated read or deploy.
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
    await io.recordRestoreStage?.({ stage, result: 'succeeded' });
    return result;
  };
  try {
    await io.recordRestoreStage?.({ stage, result: 'began' });
    assertContext(infraSha, env);
    const platform = await stackRead(io, platformName); const runtime = await stackRead(io, runtimeName);
    assertRestoreTarget(platform);
    // "Start first": a restore requires the Runtime stack to exist and be stable.
    // A stopped environment first runs `deploy-egress` and the Service deploy.
    assertRuntimeStarted(runtime);
    const originalPlatformInterface = selectOutputs(outputs(platform), platformInterfaceKeys);
    originalAdmission = await readAdmissionState(io);
    assertClosedAdmission(originalAdmission, originalAdmission); lastAdmission = originalAdmission;
    await io.recordRestoreStage?.({ stage, result: 'succeeded' });

    const readSelected = async () => {
      const actualPlatform = await stackRead(io, platformName); const actualRuntime = await stackRead(io, runtimeName);
      assertRestoredPlatform(actualPlatform); assertRuntimeTerminal(actualRuntime);
      assertInterface(outputs(actualPlatform), originalPlatformInterface);
      await assertDistributionDeployed(io, actualPlatform);
      return actualPlatform;
    };
    await phase('platform-deploy', () => io.deploy(platformName));
    await phase('platform-readback', readSelected);
    await phase('final-readback', readSelected);
    return { restored_stack: platformName, admission: redactedAdmission(lastAdmission) };
  } catch (error) {
    const observed = await failureReadback(io, stage);
    // Evidence-hook failures must never resume a sibling deployment or recovery.
    try { await io.recordRestoreStage?.({ stage, result: 'failed' }); } catch { /* Preserve the original failure. */ }
    try { await io.recordRestoreState?.(observed); } catch { /* Preserve the original failure. */ }
    try { await io.recordRecovery?.('requires-explicit-recovery'); } catch { /* Preserve the original failure. */ }
    throw new Error(`Beta Base restore failed at ${stage}; explicit recovery required; Base=${observed.base_status} (${observed.base_exists}), Runtime=${observed.runtime_status} (${observed.runtime_exists})`, { cause: error });
  }
}
