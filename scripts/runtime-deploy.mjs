import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalDeployedTemplateHash,
  stageContractSchemaHash,
  stableTaskDefinition,
  taskDefinitionContentHash,
  validateServiceDeploymentRecord,
  normaliseDeployedTemplate,
} from '@git-malu/stage-contracts';
import { canonicalJson, parseJson, sha256, DIGEST, SHA } from './json-contract.mjs';
import { describeStack, runtimeExists, runtimeStack, terminalStackStatuses } from './one-writer.mjs';
import { synthStage } from './recovery-contract.mjs';
import { readRuntimeDeployValues, readRuntimeStageContract, runtimeBakeQueueUrls, runtimeEcsClusterName } from './runtime-stage-inputs.mjs';
import { runBakeGate } from './bake-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNTIME_STACK = runtimeStack;
export const BASE_STACK = 'AnyWearPlatformStack-beta';
export const RUNTIME_REGION = 'ap-east-1';
export const SERVICE_DEPLOYMENT_PATH = 'deployment-evidence/service-deployment.json';
export const PHASE = 'roles-added';
// The six template parameters a `deploy-runtime` passes. The first two identify
// the release, the sizing pair is retained from the live stack (the reviewed
// defaults apply only when the stack has never carried them), and the final pair
// comes from the reviewed stage contract.
export const RUNTIME_DEPLOY_PARAMETER_KEYS = Object.freeze([
  'ServiceImageDigest', 'ServiceCommitSha', 'BetaApiSizingProfile', 'BetaSizingTelemetry',
  'VlmConfigArn', 'CloudFrontPrefixListId',
]);
const SIZING_PROFILES = Object.freeze(['s1', 's2-api']);
const TELEMETRY_VALUES = Object.freeze(['false', 'true']);
const CHANGE_SET_NAME = /^[A-Za-z][-A-Za-z0-9]{0,127}$/;
const SERVICE_NAMES = Object.freeze(['beta-anywear-api', 'beta-anywear-worker']);

export function assertRuntimePhase(operation, env = process.env) {
  if (!['deploy-runtime', 'stop-runtime'].includes(operation)) {
    throw new Error(`Runtime operation required; got ${operation}`);
  }
  // The live Runtime stack is at the recorded `roles-added` phase. Both other
  // phases would change the template's cleanup surface, so they fail closed
  // before any AWS call rather than synthesizing a different stack.
  if (env.INFRA_IDENTITY_PHASE !== PHASE) {
    throw new Error(`${operation} requires the recorded live identity phase ${PHASE}; got ${env.INFRA_IDENTITY_PHASE}`);
  }
}

export function runtimeChangeSetName(env) {
  const name = `anywear-runtime-${env.GITHUB_RUN_ID}`;
  if (!CHANGE_SET_NAME.test(name)) throw new Error('Invalid Runtime change-set name');
  return name;
}

/** The recorded normalised identity of the live Runtime phase. */
export function recordedRuntimePhaseHash() {
  const provenance = JSON.parse(readFileSync(path.join(ROOT, 'test/baselines/provenance.json'), 'utf8'));
  const hash = provenance.runtime_identity?.identity_phases?.[PHASE];
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('The recorded Runtime roles-added identity is missing');
  }
  return hash;
}

/**
 * Resolve the six deploy parameters. The live stack's retained sizing pair wins;
 * the documented defaults apply only when the stack never carried them. Release
 * identity values are validated before they reach a template.
 */
export function runtimeDeployParameters({ liveParameters = [], deployValues, release }) {
  if (!Array.isArray(liveParameters)) throw new Error('Invalid live Runtime parameters');
  if (!release || typeof release !== 'object') throw new Error('A sealed release identity is required');
  if (!SHA.test(release.serviceCommit ?? '')) throw new Error('Invalid release Service commit');
  if (!DIGEST.test(release.imageDigest ?? '')) throw new Error('Invalid release image digest');
  if (!deployValues || typeof deployValues !== 'object') throw new Error('The Runtime deploy inputs were not read');
  const live = new Map();
  for (const entry of liveParameters) {
    if (typeof entry?.ParameterKey !== 'string' || typeof entry.ParameterValue !== 'string') {
      throw new Error('Invalid live Runtime parameter');
    }
    live.set(entry.ParameterKey, entry.ParameterValue);
  }
  const profile = live.get('BetaApiSizingProfile') ?? 's1';
  const telemetry = live.get('BetaSizingTelemetry') ?? 'false';
  if (!SIZING_PROFILES.includes(profile)) throw new Error(`Unreviewed retained Beta sizing profile ${profile}`);
  if (!TELEMETRY_VALUES.includes(telemetry)) throw new Error(`Unreviewed retained Beta sizing telemetry ${telemetry}`);
  return Object.freeze({
    ServiceImageDigest: release.imageDigest,
    ServiceCommitSha: release.serviceCommit,
    BetaApiSizingProfile: profile,
    BetaSizingTelemetry: telemetry,
    VlmConfigArn: deployValues.VlmConfigArn,
    CloudFrontPrefixListId: deployValues.CloudFrontPrefixListId,
  });
}

/** The exact CDK deploy arguments for the Runtime change set. */
export function runtimeCdkDeployArguments({ parameters, changeSetName, identityPhase, retentionProtection }) {
  const keys = Object.keys(parameters).sort();
  if (canonicalJson(keys) !== canonicalJson([...RUNTIME_DEPLOY_PARAMETER_KEYS].sort())) {
    throw new Error('The Runtime deploy must pass exactly the six reviewed parameters');
  }
  if (!CHANGE_SET_NAME.test(changeSetName ?? '')) throw new Error('Invalid Runtime change-set name');
  return ['cdk', 'deploy', RUNTIME_STACK, '--exclusively', '--require-approval', 'never', '--no-execute',
    '--change-set-name', changeSetName,
    '-c', 'deployScope=runtime', '-c', 'stage=beta', '-c', 'legacyRoleSource=external',
    '-c', `identityPhase=${identityPhase}`, '-c', `ecrImageRetention=${retentionProtection}`,
    '--parameters', ...RUNTIME_DEPLOY_PARAMETER_KEYS.map((key) => `${key}=${parameters[key]}`)];
}

/** The CDK destroy arguments for `stop-runtime`. */
export function runtimeCdkDestroyArguments(identityPhase, retentionProtection) {
  return ['cdk', 'destroy', RUNTIME_STACK, '--force', '--exclusively',
    '-c', 'deployScope=runtime', '-c', 'stage=beta', '-c', 'legacyRoleSource=external',
    '-c', `identityPhase=${identityPhase}`, '-c', `ecrImageRetention=${retentionProtection}`];
}

/**
 * Classify a CloudFormation change set as the AC 4 evidence.
 *
 * A converged stack has no update to make. CloudFormation may answer that with an
 * empty change set, with a `FAILED` set whose reason is "didn't contain changes",
 * or with no change set at all (the CDK CLI short-circuits); all three are
 * `converged: true`. Any Add/Remove/Modify is a delta the caller must judge.
 */
export function classifyChangeSet(changeSet) {
  if (changeSet === undefined || changeSet === null) {
    return Object.freeze({ converged: true, status: 'absent', executionStatus: 'absent', reason: 'no change set', changes: [], replacement: false });
  }
  const status = String(changeSet.Status ?? 'unknown');
  const executionStatus = String(changeSet.ExecutionStatus ?? 'unknown');
  const reason = String(changeSet.StatusReason ?? '');
  const changes = (changeSet.Changes ?? []).map((row) => ({
    action: String(row?.Type ?? 'unknown'),
    logical_id: row?.ResourceChange?.LogicalResourceId ?? 'unavailable',
    resource_type: row?.ResourceChange?.ResourceType ?? 'unavailable',
    action_type: row?.ResourceChange?.Action ?? row?.Type ?? 'unknown',
    replacement: row?.ResourceChange?.Replacement ?? 'False',
  }));
  const noChanges = /didn'?t contain changes|did not contain changes/i.test(reason);
  const failed = status === 'FAILED' && !noChanges;
  const converged = !failed && (noChanges || changes.length === 0);
  return Object.freeze({
    converged, failed, status, execution_status: executionStatus, reason, changes,
    replacement: changes.some((change) => change.replacement === 'True' || change.replacement === 'Conditional'),
  });
}

/** A converged release identity must not produce a delta; this fails closed. */
export function assertConvergedChangeSet(classification) {
  if (classification.failed) throw new Error(`The Runtime change set failed: ${classification.reason || classification.status}`);
  if (!classification.converged) {
    const summary = classification.changes.map((change) => `${change.action} ${change.logical_id} (${change.replacement})`).join(', ');
    throw new Error(`A converged Runtime release must not change the stack; the change set lists ${classification.changes.length}: ${summary}`);
  }
}

/** An absent stack is the Add-only start path; every change must be an Add. */
export function assertCreateOnlyChangeSet(classification) {
  if (classification.failed) throw new Error(`The Runtime change set failed: ${classification.reason || classification.status}`);
  if (classification.converged) return;
  const notAdd = classification.changes.filter((change) => change.action !== 'Add');
  if (notAdd.length) {
    throw new Error(`A missing Runtime stack must be created only with Add changes; observed ${notAdd.map((change) => change.logical_id).join(', ')}`);
  }
}

async function describeChangeSet(io, stack, changeSetName) {
  try {
    return await io.awsAs('deploy', ['cloudformation', 'describe-change-set', '--stack-name', stack,
      '--change-set-name', changeSetName]);
  } catch (error) {
    const text = [error?.stderr, error?.message].filter((value) => typeof value === 'string').join('\n');
    if (/does not exist|ChangeSetNotFound/i.test(text)) return undefined;
    throw error;
  }
}

async function waitForTerminalStack(io, stack, { timeoutMs = 3_600_000, intervalMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const observed = await describeStack(io, stack);
    const status = observed?.StackStatus ?? 'unavailable';
    if (terminalStackStatuses.has(status)) return observed;
    if (/ROLLBACK|FAILED/i.test(status)) throw new Error(`The Runtime stack update ended in ${status}`);
    if (Date.now() + intervalMs > deadline) throw new Error(`The Runtime stack did not become terminal; observed ${status}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Synthesize the Runtime template from the one Infra app and assert its identity. */
export async function synthesizeRuntimeTemplate(env) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anywear-runtime-identity-'));
  try {
    synthStage({ repository: ROOT, directory, stage: 'beta', deployScope: 'runtime',
      inputs: { identityPhase: env.INFRA_IDENTITY_PHASE, ecrImageRetention: env.INFRA_RETENTION_PROTECTION === 'true',
        legacyRoleSource: 'external' } });
    const file = path.join(directory, `${RUNTIME_STACK}.template.json`);
    const template = JSON.parse(await readFile(file, 'utf8'));
    const expected = recordedRuntimePhaseHash();
    const observed = canonicalDeployedTemplateHash(template);
    if (observed !== expected) {
      throw new Error(`The synthesized Runtime template normalises to ${observed}, not the recorded ${PHASE} identity ${expected}`);
    }
    return { template, raw_sha256: sha256(canonicalJson(template)), normalised_sha256: observed, expected };
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function observeEcsIdentities(io, release, cluster) {
  const response = await io.aws(['ecs', 'describe-services', '--cluster', cluster, '--services', ...SERVICE_NAMES]);
  const services = response.services;
  if (!Array.isArray(services) || services.length !== SERVICE_NAMES.length) {
    throw new Error('The Runtime ECS services are not both deployed');
  }
  const observed = {};
  for (const service of services) {
    const purpose = SERVICE_NAMES.includes(service.serviceName) ? service.serviceName.replace('beta-anywear-', '') : undefined;
    if (!purpose || service.status !== 'ACTIVE' || typeof service.taskDefinition !== 'string') {
      throw new Error(`The Runtime ECS service ${service.serviceName} is not usable`);
    }
    if (!Number.isSafeInteger(service.runningCount) || service.runningCount !== service.desiredCount || service.runningCount < 1) {
      throw new Error(`The Runtime ECS service ${service.serviceName} is not at its desired count`);
    }
    if (!Array.isArray(service.deployments) || service.deployments.length !== 1
      || service.deployments[0].rolloutState !== 'COMPLETED') {
      throw new Error(`The Runtime ECS service ${service.serviceName} has not completed its rollout`);
    }
    const definition = (await io.aws(['ecs', 'describe-task-definition', '--task-definition', service.taskDefinition])).taskDefinition;
    const contentHash = taskDefinitionContentHash(definition);
    const image = stableTaskDefinition(definition).container.image;
    if (typeof image !== 'string' || !image.includes(release.imageDigest)) {
      throw new Error(`The deploys task definition for ${service.serviceName} does not carry the deployed image digest`);
    }
    observed[purpose] = {
      service_arn: service.serviceArn,
      task_definition_arn: service.taskDefinition,
      task_definition_sha256: contentHash,
      image_digest: release.imageDigest,
    };
  }
  for (const purpose of ['api', 'worker']) {
    if (!observed[purpose]) throw new Error(`The Runtime ECS ${purpose} identity is missing`);
  }
  return observed;
}

/**
 * Read `/health` under the deployed endpoint and return the minimum Client
 * version floor. Identity mismatches fail immediately; a transient unavailable
 * endpoint is retried within a bounded window.
 */
export async function readRuntimeHealth(apiBaseUrl, release, { fetchImpl = fetch, sleep, timeoutMs = 600_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  if (typeof apiBaseUrl !== 'string' || !/^https:\/\//.test(apiBaseUrl)) throw new Error('Invalid deployed API endpoint');
  const wait = sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + timeoutMs;
  let unavailability = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${apiBaseUrl}/health`, { signal: AbortSignal.timeout(15_000) });
      const body = await response.json();
      if (!response.ok || body?.status !== 'ok') {
        unavailability = `HTTP ${response.status} status ${body?.status ?? 'unavailable'}`;
      } else {
        if (body.service_commit !== release.serviceCommit) {
          throw new Error(`The deployed /health commit ${body.service_commit ?? 'absent'} differs from the release ${release.serviceCommit}`);
        }
        if (body.image_digest !== release.imageDigest) {
          throw new Error(`The deployed /health image digest ${body.image_digest ?? 'absent'} differs from the release ${release.imageDigest}`);
        }
        const floor = body.minimum_client_version;
        if (!Number.isSafeInteger(floor) || floor < 0) {
          throw new Error('The deployed /health minimum client version is not a non-negative safe integer');
        }
        return floor;
      }
    } catch (error) {
      if (/differs from the release|minimum client version/.test(error.message)) throw error;
      unavailability = error.message;
    }
    if (Date.now() + 10_000 > deadline) break;
    await wait(10_000);
  }
  throw new Error(`The deployed /health did not identify the release: ${unavailability}`);
}

/**
 * Build and validate the v5 record. The template hash is the canonical deployed
 * hash after the declared normalisation, so it is directly comparable with the
 * recorded baseline.
 */
export function buildRuntimeDeploymentRecord({ env, inputs, templateSha256, observed, gate }) {
  const record = {
    schema_version: 5,
    record_type: 'anywear_service_deployment',
    producer: {
      repository: env.GITHUB_REPOSITORY,
      sha: env.GITHUB_SHA,
      workflow_path: '.github/workflows/mutate.yml',
      workflow_ref: env.GITHUB_WORKFLOW_REF,
      run_id: Number(env.GITHUB_RUN_ID),
      run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
    },
    stacks: [{
      name: RUNTIME_STACK,
      region: RUNTIME_REGION,
      producer_repository: env.GITHUB_REPOSITORY,
      producer_sha: env.GITHUB_SHA,
      template_sha256: templateSha256,
    }],
    inputs,
    observed,
    schema: { content_sha256: stageContractSchemaHash(inputs) },
    gate,
  };
  return validateServiceDeploymentRecord(record);
}

export async function writeServiceDeployment(record, file = SERVICE_DEPLOYMENT_PATH) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${canonicalJson(record)}`);
  return file;
}

/** Resolve the deployed parameters as a plain map for the retain/compare checks. */
export function deployedParameterMap(stack) {
  const map = new Map();
  for (const entry of stack?.Parameters ?? []) {
    if (typeof entry?.ParameterKey === 'string') map.set(entry.ParameterKey, entry.ParameterValue);
  }
  return map;
}

/** `deploy-runtime`: one converged-or-additive mutation that produces the v5 record. */
export async function deployRuntime({ io, env, record, release,
  synthesize = synthesizeRuntimeTemplate, health = readRuntimeHealth, bake = runBakeGate,
  outputPath = SERVICE_DEPLOYMENT_PATH }) {
  assertRuntimePhase('deploy-runtime', env);
  const base = await describeStack(io, BASE_STACK);
  if (!terminalStackStatuses.has(base?.StackStatus)) {
    throw new Error(`deploy-runtime requires a terminal Base stack; observed ${base?.StackStatus ?? 'unavailable'}`);
  }
  const runtime = await describeStack(io, RUNTIME_STACK);
  const stackExists = runtimeExists(runtime);
  if (stackExists && !terminalStackStatuses.has(runtime.StackStatus)) {
    throw new Error(`deploy-runtime requires a terminal Runtime stack; observed ${runtime.StackStatus}`);
  }
  const deployed = deployedParameterMap(runtime);
  const identityUnchanged = stackExists && deployed.get('ServiceCommitSha') === release.serviceCommit
    && deployed.get('ServiceImageDigest') === release.imageDigest;
  const roleArnBefore = runtime?.RoleARN ?? 'absent';
  record?.events.push({ type: 'runtime-pre-state', base_status: base?.StackStatus, runtime_status: runtime?.StackStatus ?? 'absent',
    runtime_exists: stackExists, stack_role_arn: roleArnBefore, release_identity_unchanged: identityUnchanged });

  const deployValues = await readRuntimeDeployValues(io);
  // The bake's queue URLs and ECS cluster are contract values from the same
  // reviewed 39-name read whose bytes the record hashes; they are never
  // account/region literals or guessed queue names. Both fail closed here, before
  // the change set exists, if the contract value is missing or malformed.
  const contract = await readRuntimeStageContract(io);
  const inputs = contract.inputs;
  const cluster = runtimeEcsClusterName(contract.values);
  const queueUrls = runtimeBakeQueueUrls(contract.values);
  const parameters = runtimeDeployParameters({ liveParameters: runtime?.Parameters ?? [], deployValues, release });
  const synthesized = await synthesize(env);
  record?.events.push({ type: 'runtime-synthesized-template', raw_sha256: synthesized.raw_sha256,
    normalised_sha256: synthesized.normalised_sha256, recorded_phase_sha256: synthesized.expected, identity_phase: PHASE });

  // A running stack's deployed template must already be the recorded identity;
  // otherwise the change set is drift, not this release, and must fail closed.
  if (stackExists) {
    const liveBody = (await io.aws(['cloudformation', 'get-template', '--stack-name', RUNTIME_STACK,
      '--template-stage', 'Original'])).TemplateBody;
    const liveTemplate = typeof liveBody === 'string' ? parseJson(liveBody) : liveBody;
    const liveHash = canonicalDeployedTemplateHash(liveTemplate);
    if (liveHash !== synthesized.expected) {
      throw new Error(`The deployed Runtime template normalises to ${liveHash}, not the recorded ${PHASE} identity ${synthesized.expected}`);
    }
  }

  const changeSetName = runtimeChangeSetName(env);
  await io.deployRuntimeChangeSet({
    parameters, changeSetName,
    args: runtimeCdkDeployArguments({ parameters, changeSetName, identityPhase: env.INFRA_IDENTITY_PHASE,
      retentionProtection: env.INFRA_RETENTION_PROTECTION }),
  });
  const changeSet = await describeChangeSet(io, RUNTIME_STACK, changeSetName);
  const classification = classifyChangeSet(changeSet);
  record?.events.push({ type: 'runtime-change-set', name: changeSetName, ...classification });

  if (classification.converged) {
    if (changeSet !== undefined) {
      await io.awsAs('deploy', ['cloudformation', 'delete-change-set', '--stack-name', RUNTIME_STACK,
        '--change-set-name', changeSetName]);
    }
    if (identityUnchanged) {
      // The reviewed converged no-op: nothing executes, and the read-back below
      // still proves the deployed identity.
      record?.events.push({ type: 'runtime-change-set-converged', executed: false });
    }
  } else if (identityUnchanged) {
    assertConvergedChangeSet(classification);
  } else if (!stackExists) {
    assertCreateOnlyChangeSet(classification);
    await io.awsAs('deploy', ['cloudformation', 'execute-change-set', '--stack-name', RUNTIME_STACK,
      '--change-set-name', changeSetName]);
    await waitForTerminalStack(io, RUNTIME_STACK);
    record?.events.push({ type: 'runtime-change-set-executed', executed: true, mode: 'create' });
  } else {
    await io.awsAs('deploy', ['cloudformation', 'execute-change-set', '--stack-name', RUNTIME_STACK,
      '--change-set-name', changeSetName]);
    await waitForTerminalStack(io, RUNTIME_STACK);
    record?.events.push({ type: 'runtime-change-set-executed', executed: true, mode: 'update',
      replacement: classification.replacement, changes: classification.changes });
  }

  // Read back the deployed template and parameters, then prove the identity.
  const stack = await describeStack(io, RUNTIME_STACK);
  if (!runtimeExists(stack) || !terminalStackStatuses.has(stack.StackStatus)) {
    throw new Error(`The Runtime stack is not terminal after deploy; observed ${stack?.StackStatus ?? 'absent'}`);
  }
  const body = (await io.aws(['cloudformation', 'get-template', '--stack-name', RUNTIME_STACK,
    '--template-stage', 'Original'])).TemplateBody;
  const template = typeof body === 'string' ? parseJson(body) : body;
  const rawTemplateSha256 = sha256(canonicalJson(template));
  const templateSha256 = canonicalDeployedTemplateHash(template);
  if (templateSha256 !== synthesized.expected) {
    throw new Error(`The deployed Runtime template normalises to ${templateSha256}, not the recorded ${PHASE} identity ${synthesized.expected}`);
  }
  normaliseDeployedTemplate(template);
  const after = deployedParameterMap(stack);
  for (const key of RUNTIME_DEPLOY_PARAMETER_KEYS) {
    if (after.get(key) !== parameters[key]) {
      throw new Error(`The deployed Runtime parameter ${key} does not match the requested deployment`);
    }
  }
  const roleArnAfter = stack.RoleARN ?? 'absent';
  record?.events.push({ type: 'runtime-deployed-template', raw_sha256: rawTemplateSha256,
    normalised_sha256: templateSha256, identity_phase: PHASE });
  record?.events.push({ type: 'runtime-stack-role', before: roleArnBefore, after: roleArnAfter,
    execution_role_source: 'standard CDK bootstrap synthesizer (cdk-hnb659fds-cfn-exec-role)' });

  const ecs = await observeEcsIdentities(io, release, cluster);
  const apiBaseUrl = new Map(inputs.map((row) => [row.parameter, row])).has('/anywear/beta/api_base_url')
    ? (await io.aws(['ssm', 'get-parameter', '--name', '/anywear/beta/api_base_url'])).Parameter?.Value : undefined;
  if (typeof apiBaseUrl !== 'string' || !/^https:\/\//.test(apiBaseUrl)) throw new Error('The stage contract api_base_url is unavailable');
  const minimumClientVersion = await health(apiBaseUrl, release, { sleep: io.sleep });
  const gate = await bake({ stage: 'beta', stack: RUNTIME_STACK, apiBaseUrl, cluster,
    queueUrls, logGroup: '/anywear/beta/worker',
    serviceSha: release.serviceCommit, imageDigest: release.imageDigest,
    now: io.now, sleep: io.sleep, fetchImpl: fetch, runAws: await io.runtimeAwsRunner() });
  if (gate.result !== 'passed') {
    record?.events.push({ type: 'release-bake', result: 'failed', gate });
    const failures = gate.signals.filter((signal) => signal.state !== 'not-breaching')
      .map((signal) => ({ signal: signal.name, state: signal.state, exceptions: signal.exceptions }));
    throw new Error(`The 600-second bake failed: ${JSON.stringify(failures)}`);
  }
  record?.events.push({ type: 'release-bake', result: 'passed', name: gate.name,
    duration_seconds: gate.duration_seconds, probes_sent: gate.probe.probes_sent });

  const deployment = buildRuntimeDeploymentRecord({ env, inputs, templateSha256,
    observed: {
      service_sha: release.serviceCommit,
      image_digest: release.imageDigest,
      minimum_client_version: minimumClientVersion,
      ecs,
      endpoints: { api: apiBaseUrl },
    }, gate });
  const file = await writeServiceDeployment(deployment, outputPath);
  if (record) {
    record.service_deployment = { path: file, template_sha256: templateSha256,
      service_sha: release.serviceCommit, image_digest: release.imageDigest, minimum_client_version: minimumClientVersion };
  }
  record?.events.push({ type: 'service-deployment-record', path: file, template_sha256: templateSha256,
    service_sha: release.serviceCommit, image_digest: release.imageDigest });
  return deployment;
}

/** `stop-runtime`: delete only the release slice; absent is the accepted no-op. */
export async function stopRuntime({ io, env, record }) {
  assertRuntimePhase('stop-runtime', env);
  const base = await describeStack(io, BASE_STACK);
  if (!terminalStackStatuses.has(base?.StackStatus)) {
    throw new Error(`stop-runtime requires a terminal Base stack; observed ${base?.StackStatus ?? 'unavailable'}`);
  }
  const runtime = await describeStack(io, RUNTIME_STACK);
  if (!runtimeExists(runtime)) {
    record?.events.push({ type: 'runtime-stop-extent', extent: 'absent', executed: false });
    return 'absent';
  }
  if (!terminalStackStatuses.has(runtime.StackStatus)) {
    throw new Error(`stop-runtime requires a terminal Runtime stack; observed ${runtime.StackStatus}`);
  }
  record?.events.push({ type: 'runtime-pre-state', base_status: base?.StackStatus, runtime_status: runtime.StackStatus,
    runtime_exists: true, stack_role_arn: runtime.RoleARN ?? 'absent' });
  await io.destroy(RUNTIME_STACK);
  record?.events.push({ type: 'runtime-stack-role', before: runtime.RoleARN ?? 'absent', after: 'absent',
    execution_role_source: 'stack deleted' });
  record?.events.push({ type: 'runtime-stop', stack_name: RUNTIME_STACK, result: 'complete' });
  return 'destroyed';
}
