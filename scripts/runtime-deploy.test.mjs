import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RUNTIME_DEPLOY_PARAMETER_KEYS,
  RUNTIME_STACK,
  assertConvergedChangeSet,
  assertCreateOnlyChangeSet,
  assertRuntimePhase,
  buildRuntimeDeploymentRecord,
  classifyChangeSet,
  deployRuntime,
  readRuntimeHealth,
  runtimeCdkDeployArguments,
  runtimeChangeSetName,
  runtimeDeployParameters,
  stopRuntime,
} from './runtime-deploy.mjs';
import {
  RUNTIME_ECS_CLUSTER_INPUT,
  RUNTIME_QUEUE_URL_NAMES,
  RUNTIME_STAGE_INPUT_NAMES,
  readRuntimeStageContract,
  runtimeBakeQueueUrls,
  runtimeEcsClusterName,
  runtimeStageInputBatches,
} from './runtime-stage-inputs.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';
import { createOperationRecord } from './operation-record.mjs';
import { recordDeployment } from './record-deployment.mjs';
import { canonicalJson } from './json-contract.mjs';
import { failedGate } from './bake-gate.mjs';
import { gateBlock, IMAGE_DIGEST, SERVICE_SHA } from '../packages/stage-contracts/test/gate-fixture.mjs';

// Credential-free tests for the `deploy-runtime` operation (#195). The synthesis,
// health probe and bake are injected; every AWS surface is a fake that records
// calls, so each failure leaves the stack untouched and no v5 record is written.
const release = { releaseTag: `service-artifacts-${SERVICE_SHA}`, serviceCommit: SERVICE_SHA, imageDigest: IMAGE_DIGEST };
const env = (overrides = {}) => ({
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '2',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main', GITHUB_REF: 'refs/heads/main',
  INFRA_OPERATION: 'deploy-runtime', INFRA_IDENTITY_PHASE: 'roles-added', INFRA_RETENTION_PROTECTION: 'true', ...overrides,
});
const TEMPLATE = JSON.parse(readFileSync('test/baselines/beta-active/AnyWearRuntimeStack-beta.template.json', 'utf8'));
const SYNTHESIZED = { template: TEMPLATE, raw_sha256: 'a'.repeat(64),
  normalised_sha256: '454340b8d7f561f4293149bdcaab5d91051958bf95d2401bf4b92feb7e0a2c37',
  expected: '454340b8d7f561f4293149bdcaab5d91051958bf95d2401bf4b92feb7e0a2c37' };
const HEALTH = async () => 0;
const BAKE = async () => gateBlock();
const SSM = ['vlm_config_arn', 'cloudfront_prefix_list_id'].map((name) => ({ name }));
// The contract values the deploy reads: the two reviewed constants, the API
// endpoint, the four queue URLs and the ECS cluster name. Never literals in the
// operation itself.
const QUEUE_URLS = Object.freeze({
  '/anywear/beta/vto_queue_url': 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-vto',
  '/anywear/beta/auto_tagging_queue_url': 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-auto-tagging',
  '/anywear/beta/vto_dlq_url': 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-vto-dlq',
  '/anywear/beta/auto_tagging_dlq_url': 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-auto-tagging-dlq',
});
const CONTRACT_VALUES = Object.freeze({
  '/anywear/beta/vlm_config_arn': 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:/anywear/beta/vlm_config-AbCdEf',
  '/anywear/beta/cloudfront_prefix_list_id': 'pl-0123456789abcdef',
  '/anywear/beta/api_base_url': 'https://d111111abcdef8.cloudfront.net',
  '/anywear/beta/ecs_cluster_name': 'beta-anywear',
  ...QUEUE_URLS,
});
const stageValue = (name) => CONTRACT_VALUES[name] ?? `value:${name}`;

// The bake's options are captured so the tests prove what the operation actually
// handed the gate, not only what the helpers would accept.
function capturingBake(gate = () => gateBlock()) {
  const baked = [];
  return { baked, bake: async (options) => { baked.push(options); return gate(); } };
}


function liveStack({ identityUnchanged = true, terminal = true } = {}) {
  return {
    StackName: RUNTIME_STACK, StackStatus: terminal ? 'UPDATE_COMPLETE' : 'UPDATE_IN_PROGRESS',
    RoleARN: 'arn:aws:iam::650880818323:role/beta-service-deploy-cfn-role',
    Parameters: [
      { ParameterKey: 'ServiceCommitSha', ParameterValue: identityUnchanged ? SERVICE_SHA : 'b'.repeat(40) },
      { ParameterKey: 'ServiceImageDigest', ParameterValue: identityUnchanged ? IMAGE_DIGEST : `sha256:${'9'.repeat(64)}` },
      { ParameterKey: 'BetaApiSizingProfile', ParameterValue: 's1' },
      { ParameterKey: 'BetaSizingTelemetry', ParameterValue: 'false' },
      { ParameterKey: 'VlmConfigArn', ParameterValue: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:/anywear/beta/vlm_config-AbCdEf' },
      { ParameterKey: 'CloudFrontPrefixListId', ParameterValue: 'pl-0123456789abcdef' },
    ],
  };
}

function fakeIo({ base = { StackName: 'AnyWearPlatformStack-beta', StackStatus: 'UPDATE_COMPLETE' },
  runtime = liveStack(), changeSet = undefined, executeError = undefined } = {}) {
  const calls = [];
  let runtimeObserved = runtime;
  const io = {
    calls, now: () => 0, sleep: async () => {},
    async aws(args) {
      const key = `${args[0]}/${args[1]}`;
      calls.push({ session: 'runtime', key, args });
      if (key === 'cloudformation/describe-stacks') {
        const name = args[args.indexOf('--stack-name') + 1];
        if (name === 'AnyWearPlatformStack-beta') {
          if (base) return { Stacks: [base] };
          const error = new Error('Stack AnyWearPlatformStack-beta does not exist'); throw error;
        }
        if (name === RUNTIME_STACK) {
          if (runtimeObserved) return { Stacks: [runtimeObserved] };
          throw new Error(`Stack with id ${RUNTIME_STACK} does not exist`);
        }
        throw new Error(`unexpected stack ${name}`);
      }
      if (key === 'cloudformation/get-template') return { TemplateBody: JSON.stringify(TEMPLATE) };
      if (key === 'ssm/get-parameters') {
        const names = args.slice(args.indexOf('--names') + 1);
        return { Parameters: names.map((name) => ({ Name: name, Version: 3, Value: stageValue(name) })) };
      }
      if (key === 'ssm/get-parameter') {
        const name = args[args.indexOf('--name') + 1];
        return { Parameter: { Name: name, Version: 3, Value: stageValue(name) } };
      }
      if (key === 'ecs/describe-services') {
        return { services: ['api', 'worker'].map((purpose) => ({
          serviceName: `beta-anywear-${purpose}`, status: 'ACTIVE',
          serviceArn: `arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-${purpose}`,
          taskDefinition: `arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-${purpose}:7`,
          runningCount: 1, desiredCount: 1, deployments: [{ rolloutState: 'COMPLETED' }],
        })) };
      }
      if (key === 'ecs/describe-task-definition') {
        const arn = args[args.indexOf('--task-definition') + 1];
        const purpose = arn.includes('worker') ? 'worker' : 'api';
        return { taskDefinition: { family: `beta-anywear-${purpose}`, taskRoleArn: `arn:aws:iam::650880818323:role/beta-anywear-${purpose}-task`,
          executionRoleArn: `arn:aws:iam::650880818323:role/beta-anywear-${purpose}-execution`, networkMode: 'awsvpc', cpu: '512', memory: '1024',
          containerDefinitions: [{ name: `${purpose}`, image: `650880818323.dkr.ecr.ap-east-1.amazonaws.com/beta-anywear-service@${IMAGE_DIGEST}`,
            command: ['node', 'dist/index.js'], environment: [] }] } };
      }
      throw new Error(`unexpected runtime read ${key}`);
    },
    async awsAs(session, args) {
      calls.push({ session, key: `${args[0]}/${args[1]}`, args });
      if (args[1] === 'describe-change-set') return changeSet;
      if (args[1] === 'execute-change-set') {
        if (executeError) throw executeError;
        runtimeObserved = liveStack();
      }
      return {};
    },
    async deployRuntimeChangeSet({ args }) { calls.push({ session: 'deploy', key: 'cdk/deploy', args }); },
    async runtimeAwsRunner() { return () => '{}'; },
    async destroy(stack) { calls.push({ session: 'deploy', key: 'cdk/destroy', stack }); },
  };
  return { io, calls, setRuntime: (value) => { runtimeObserved = value; } };
}

test('the six deploy parameters are the release identity, the retained sizing pair and the two reviewed constants', () => {
  const parameters = runtimeDeployParameters({ liveParameters: [], deployValues: { VlmConfigArn: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:x', CloudFrontPrefixListId: 'pl-1' },
    release });
  assert.deepEqual(Object.keys(parameters).sort(), [...RUNTIME_DEPLOY_PARAMETER_KEYS].sort());
  // The reviewed defaults apply only when the live stack never carried them.
  assert.equal(parameters.BetaApiSizingProfile, 's1');
  assert.equal(parameters.BetaSizingTelemetry, 'false');
  const retained = runtimeDeployParameters({ liveParameters: liveStack().Parameters,
    deployValues: { VlmConfigArn: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:x', CloudFrontPrefixListId: 'pl-1' }, release });
  assert.equal(retained.BetaApiSizingProfile, 's1');
  assert.throws(() => runtimeDeployParameters({ liveParameters: [{ ParameterKey: 'BetaApiSizingProfile', ParameterValue: 's3' }],
    deployValues: { VlmConfigArn: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:x', CloudFrontPrefixListId: 'pl-1' }, release }), /Unreviewed retained Beta sizing profile/);
  assert.throws(() => runtimeDeployParameters({ liveParameters: [], deployValues: { VlmConfigArn: 'x', CloudFrontPrefixListId: 'pl-1' },
    release: { ...release, imageDigest: 'not-a-digest' } }), /Invalid release image digest/);
});

test('the bake input helpers accept only full contract URLs and the contract cluster, never queue names', () => {
  const values = new Map(Object.entries(CONTRACT_VALUES));
  const queueUrls = runtimeBakeQueueUrls(values);
  assert.deepEqual(queueUrls, {
    vto: QUEUE_URLS['/anywear/beta/vto_queue_url'],
    auto_tagging: QUEUE_URLS['/anywear/beta/auto_tagging_queue_url'],
    vto_dlq: QUEUE_URLS['/anywear/beta/vto_dlq_url'],
    auto_tagging_dlq: QUEUE_URLS['/anywear/beta/auto_tagging_dlq_url'],
  });
  assert.ok(Object.isFrozen(queueUrls));
  // Issue #195 blocking fix: the review found the deploy passing queue *names* to
  // `sqs get-queue-attributes --queue-url`. Every value must be a full https URL.
  for (const url of Object.values(queueUrls)) assert.match(url, /^https:\/\/sqs\./);
  assert.equal(runtimeEcsClusterName(values), 'beta-anywear');
  // The hardcoded names the operation used before the fix now fail closed.
  const HARDCODED_NAMES = { vto: 'beta-anywear-vto', auto_tagging: 'beta-anywear-auto-tagging',
    vto_dlq: 'beta-anywear-vto-dlq', auto_tagging_dlq: 'beta-anywear-auto-tagging-dlq' };
  for (const [purpose, name] of Object.entries(RUNTIME_QUEUE_URL_NAMES)) {
    assert.throws(() => runtimeBakeQueueUrls(new Map(values).set(name, HARDCODED_NAMES[purpose])),
      new RegExp(`${name} is not an https://sqs\\. queue URL`), purpose);
    const missing = new Map(values);
    missing.delete(name);
    assert.throws(() => runtimeBakeQueueUrls(missing), /is not an https:\/\/sqs\. queue URL/, purpose);
    for (const malformed of [`http://sqs.ap-east-1.amazonaws.com/650880818323/q`, 'https://sqs.', 'beta-anywear-vto']) {
      assert.throws(() => runtimeBakeQueueUrls(new Map(values).set(name, malformed)), /not an https:\/\/sqs\./,
        `${purpose}: ${malformed}`);
    }
  }
  for (const cluster of [undefined, '', 'beta anywear', 'beta-anywear/other']) {
    assert.throws(() => runtimeEcsClusterName(new Map(values).set(RUNTIME_ECS_CLUSTER_INPUT, cluster)),
      /ecs_cluster_name is not an ECS cluster name/, String(cluster));
  }
  assert.throws(() => runtimeEcsClusterName(new Map()), /ecs_cluster_name is not an ECS cluster name/);
});

test('the CDK arguments pass exactly the six parameters in the runtime scope', () => {
  const parameters = Object.fromEntries(RUNTIME_DEPLOY_PARAMETER_KEYS.map((key) => [key, `${key}-value`]));
  const args = runtimeCdkDeployArguments({ parameters, changeSetName: 'anywear-runtime-1', identityPhase: 'roles-added', retentionProtection: 'true' });
  assert.deepEqual(args.slice(0, 6), ['cdk', 'deploy', RUNTIME_STACK, '--exclusively', '--require-approval', 'never']);
  assert.ok(args.includes('--no-execute'));
  assert.ok(args.includes('deployScope=runtime'));
  assert.ok(args.includes('identityPhase=roles-added'));
  assert.ok(!args.some((arg) => arg.startsWith('artifactDirectory=')));
  assert.ok(!args.includes('--role-arn'), 'the standard synthesizer chooses the execution role');
  for (const key of RUNTIME_DEPLOY_PARAMETER_KEYS) assert.ok(args.includes(`${key}=${key}-value`), key);
  assert.throws(() => runtimeCdkDeployArguments({ parameters: { ServiceCommitSha: 'x' }, changeSetName: 'anywear-runtime-1',
    identityPhase: 'roles-added', retentionProtection: 'true' }), /exactly the six reviewed parameters/);
});

test('a change set is classified as converged or as a delta, and the guards fail closed', () => {
  assert.deepEqual(classifyChangeSet(undefined).converged, true);
  assert.deepEqual(classifyChangeSet({ Status: 'FAILED', StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." }), {
    converged: true, failed: false, status: 'FAILED', execution_status: 'unknown',
    reason: "The submitted information didn't contain changes. Submit different information to create a change set.",
    changes: [], replacement: false,
  });
  assert.equal(classifyChangeSet({ Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [] }).converged, true);
  const delta = classifyChangeSet({ Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
    { Type: 'Modify', ResourceChange: { LogicalResourceId: 'ComputeRuntimeApiServiceD2475D0A', ResourceType: 'AWS::ECS::Service', Replacement: 'Conditional' } },
    { Type: 'Add', ResourceChange: { LogicalResourceId: 'New', ResourceType: 'AWS::S3::Bucket', Replacement: 'False' } },
  ] });
  assert.equal(delta.converged, false);
  assert.equal(delta.replacement, true);
  assert.throws(() => assertConvergedChangeSet(delta), /must not change the stack/);
  assert.throws(() => assertConvergedChangeSet({ ...classifyChangeSet({ Status: 'FAILED', StatusReason: 'AccessDenied' }) }),
    /change set failed/);
  assert.doesNotThrow(() => assertCreateOnlyChangeSet(classifyChangeSet({ Status: 'CREATE_COMPLETE', Changes: [
    { Type: 'Add', ResourceChange: { LogicalResourceId: 'A', ResourceType: 'AWS::S3::Bucket', Replacement: 'False' } }] })));
  assert.throws(() => assertCreateOnlyChangeSet(delta), /created only with Add changes/);
});

test('only the recorded live identity phase passes for the Runtime operations', () => {
  assert.doesNotThrow(() => assertRuntimePhase('deploy-runtime', env()));
  for (const phase of ['legacy', 'retired', undefined]) {
    assert.throws(() => assertRuntimePhase('deploy-runtime', { ...env(), INFRA_IDENTITY_PHASE: phase }),
      /requires the recorded live identity phase roles-added/);
  }
  assert.throws(() => assertRuntimePhase('deploy-platform', env()), /Runtime operation required/);
  assert.equal(runtimeChangeSetName({ GITHUB_RUN_ID: '123' }), 'anywear-runtime-123');
});

test('/health identity mismatches fail immediately and an unavailable endpoint times out', async () => {
  const fetchJson = (body) => async () => ({ ok: true, status: 200, json: async () => body });
  await assert.rejects(readRuntimeHealth('https://example.cloudfront.net', release,
    { fetchImpl: fetchJson({ status: 'ok', service_commit: 'd'.repeat(40), image_digest: IMAGE_DIGEST, minimum_client_version: 0 }) }),
  /health commit/);
  await assert.rejects(readRuntimeHealth('https://example.cloudfront.net', release,
    { fetchImpl: fetchJson({ status: 'ok', service_commit: SERVICE_SHA, image_digest: IMAGE_DIGEST, minimum_client_version: -1 }) }),
  /minimum client version/);
  await assert.rejects(readRuntimeHealth('https://example.cloudfront.net', release,
    { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), timeoutMs: 1 }), /did not identify the release/);
  assert.equal(await readRuntimeHealth('https://example.cloudfront.net', release,
    { fetchImpl: fetchJson({ status: 'ok', service_commit: SERVICE_SHA, image_digest: IMAGE_DIGEST, minimum_client_version: 4 }) }), 4);
});

test('a non-terminal Base or Runtime fails before any change set or mutation', async () => {
  await assert.rejects(deployRuntime({ env: env(), release, record: { events: [] },
    io: fakeIo({ base: { StackName: 'AnyWearPlatformStack-beta', StackStatus: 'UPDATE_IN_PROGRESS' } }).io,
    synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE }), /terminal Base stack/);
  const nonTerminal = fakeIo({ runtime: liveStack({ terminal: false }) });
  await assert.rejects(deployRuntime({ env: env(), release, record: { events: [] }, io: nonTerminal.io,
    synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE }), /terminal Runtime stack/);
  assert.equal(nonTerminal.calls.some((call) => call.key === 'cdk/deploy'), false);
});

test('a converged stack records an empty change set, executes nothing and writes the v5 record', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-deploy-converged-'));
  try {
    const { io, calls } = fakeIo({ changeSet: { Status: 'FAILED',
      StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." } });
    const record = { events: [] };
    const deployment = await deployRuntime({ env: env(), release, record, io,
      synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE,
      outputPath: path.join(directory, 'service-deployment.json') });
    assert.equal(deployment.schema_version, 5);
    assert.equal(deployment.stacks[0].template_sha256, SYNTHESIZED.normalised_sha256);
    assert.equal(deployment.observed.service_sha, SERVICE_SHA);
    assert.equal(deployment.observed.image_digest, IMAGE_DIGEST);
    assert.equal(deployment.observed.minimum_client_version, 0);
    assert.equal(calls.some((call) => call.args?.includes('execute-change-set')), false, 'a converged no-op executes nothing');
    assert.ok(calls.some((call) => call.args?.includes('delete-change-set')));
    const role = record.events.find((event) => event.type === 'runtime-stack-role');
    assert.equal(role.before, 'arn:aws:iam::650880818323:role/beta-service-deploy-cfn-role');
    assert.equal(role.after, 'arn:aws:iam::650880818323:role/beta-service-deploy-cfn-role',
      'a converged no-op must not rebind the stack execution role');
    assert.equal(JSON.parse(readFileSync(path.join(directory, 'service-deployment.json'), 'utf8')).record_type, 'anywear_service_deployment');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Issue #195 blocking fix: `deploy-runtime` must hand the bake the four queue
// URLs and the cluster name from the 39-name stage-contract read. A queue name
// makes every `sqs get-queue-attributes --queue-url` read fail at Deployment, so
// the gate can never pass and no v5 record is written.
test('the bake receives the contract queue URLs and cluster, not hardcoded names', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-deploy-bake-inputs-'));
  try {
    const { io } = fakeIo({ changeSet: { Status: 'FAILED',
      StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." } });
    const captured = capturingBake();
    const record = { events: [] };
    await deployRuntime({ env: env(), release, record, io, synthesize: async () => SYNTHESIZED, health: HEALTH,
      bake: captured.bake, outputPath: path.join(directory, 'service-deployment.json') });
    assert.equal(captured.baked.length, 1);
    const options = captured.baked[0];
    assert.deepEqual(options.queueUrls, {
      vto: QUEUE_URLS['/anywear/beta/vto_queue_url'],
      auto_tagging: QUEUE_URLS['/anywear/beta/auto_tagging_queue_url'],
      vto_dlq: QUEUE_URLS['/anywear/beta/vto_dlq_url'],
      auto_tagging_dlq: QUEUE_URLS['/anywear/beta/auto_tagging_dlq_url'],
    });
    for (const [purpose, url] of Object.entries(options.queueUrls)) {
      assert.match(url, /^https:\/\/sqs\.[a-z0-9.-]+\/\d{12}\/[A-Za-z0-9_.-]+$/, purpose);
    }
    assert.equal(options.cluster, 'beta-anywear');
    // The bake still selects the CloudWatch QueueName dimensions by name; the
    // contract read supplies the URLs and the cluster, and nothing in the
    // operation hardcodes an account, region or queue URL.
    const source = readFileSync('scripts/runtime-deploy.mjs', 'utf8');
    assert.equal(/beta-anywear-vto'|sqs\.ap-east-1\.amazonaws\.com/.test(source), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an unchanged release identity cannot produce a delta: Add, Remove and Modify all fail closed', async () => {
  for (const action of ['Add', 'Modify', 'Remove']) {
    const { io, calls } = fakeIo({ changeSet: { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
      { Type: action, ResourceChange: { LogicalResourceId: 'ComputeRuntimeApiServiceD2475D0A', ResourceType: 'AWS::ECS::Service', Replacement: 'False' } }] } });
    await assert.rejects(deployRuntime({ env: env(), release, record: { events: [] }, io,
      synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE }), /must not change the stack/, action);
    assert.equal(calls.some((call) => call.args?.includes('execute-change-set')), false, action);
  }
});

// Issue #195 acceptance: the change-set execute failure writes no v5 record and
// leaves the change-set event as the operation evidence.
test('a change-set execute failure writes no v5 record and leaves the failed execution as evidence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-deploy-execute-failure-'));
  try {
    const { io, calls } = fakeIo({ runtime: liveStack({ identityUnchanged: false }),
      changeSet: { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
        { Type: 'Add', ResourceChange: { LogicalResourceId: 'BetaReleaseChange', ResourceType: 'AWS::S3::Bucket', Replacement: 'False' } }] },
      executeError: Object.assign(new Error('An error occurred (AccessDenied) when calling the ExecuteChangeSet operation'), {
        stderr: 'An error occurred (AccessDenied)' }) });
    const record = { events: [] };
    await assert.rejects(deployRuntime({ env: env(), release, record, io,
      synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE,
      outputPath: path.join(directory, 'service-deployment.json') }), /AccessDenied/);
    assert.ok(calls.some((call) => call.args?.includes('execute-change-set')));
    assert.equal(record.events.some((event) => event.type === 'runtime-change-set-executed'), false,
      'a failed execution is not recorded as a completed change set');
    assert.equal(record.events.some((event) => event.type === 'service-deployment-record'), false);
    assert.equal(record.events.some((event) => event.type === 'release-bake'), false, 'the bake never runs');
    await assert.rejects(readFile(path.join(directory, 'service-deployment.json')), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a breaching or insufficient-data bake writes no v5 record and keeps the failed gate as evidence', async () => {
  const healthy = gateBlock();
  const breaching = { ...healthy, result: 'failed', signals: healthy.signals.map((signal, index) => (index === 3
    ? { ...signal, state: 'breaching', exceptions: ['vto oldest-message age 301s exceeds 300s'] }
    : signal)) };
  const insufficient = failedGate({ stage: 'beta', cluster: 'beta-anywear',
    logGroup: '/anywear/beta/worker', serviceSha: SERVICE_SHA, imageDigest: IMAGE_DIGEST });
  assert.equal(insufficient.result, 'failed');
  assert.ok(insufficient.signals.every((signal) => signal.state === 'insufficient'));
  for (const [label, gate] of [['breaching', breaching], ['insufficient', insufficient]]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `runtime-deploy-bake-${label}-`));
    try {
      const { io, calls } = fakeIo({ changeSet: { Status: 'FAILED',
        StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." } });
      const record = { events: [] };
      await assert.rejects(deployRuntime({ env: env(), release, record, io,
        synthesize: async () => SYNTHESIZED, health: HEALTH, bake: async () => gate,
        outputPath: path.join(directory, 'service-deployment.json') }), /The 600-second bake failed/, label);
      const evidence = record.events.find((event) => event.type === 'release-bake');
      assert.equal(evidence.result, 'failed', label);
      assert.deepEqual(evidence.gate, gate, label);
      assert.equal(record.events.some((event) => event.type === 'service-deployment-record'), false, label);
      await assert.rejects(readFile(path.join(directory, 'service-deployment.json')), /ENOENT/, label);
      // A converged no-op still never executes a change set before a failed bake.
      assert.equal(calls.some((call) => call.args?.includes('execute-change-set')), false, label);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('an absent Runtime stack is an Add-only create that executes, and stop of an absent stack is a no-op', async () => {
  const { io, calls, setRuntime } = fakeIo({ runtime: null,
    changeSet: { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
      { Type: 'Add', ResourceChange: { LogicalResourceId: 'ComputeRuntimeApiServiceD2475D0A', ResourceType: 'AWS::ECS::Service', Replacement: 'False' } }] } });
  const record = { events: [] };
  await deployRuntime({ env: env(), release, record, io, synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE,
    outputPath: path.join(os.tmpdir(), `runtime-deploy-create-${process.pid}.json`) });
  assert.ok(calls.some((call) => call.args?.includes('execute-change-set')));
  const events = record.events.filter((event) => event.type === 'runtime-change-set-executed');
  assert.equal(events.length, 1);
  assert.equal(events[0].mode, 'create');

  setRuntime(undefined);
  const stopRecord = { events: [] };
  assert.equal(await stopRuntime({ env: env({ INFRA_OPERATION: 'stop-runtime' }), record: stopRecord, io }), 'absent');
  assert.equal(stopRecord.events.at(-1).extent, 'absent');
  assert.equal(calls.some((call) => call.key === 'cdk/destroy'), false);
});

test('the v5 record fails closed on a wrong producer, stack or template hash', () => {
  const inputs = [{ parameter: '/anywear/beta/vpc_id', version: '4', value_sha256: 'd'.repeat(64) }];
  const base = { env: env(), inputs, templateSha256: 'e'.repeat(64),
    observed: { service_sha: SERVICE_SHA, image_digest: IMAGE_DIGEST, minimum_client_version: 0,
      ecs: { api: { service_arn: 'arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-api',
        task_definition_arn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-api:7',
        task_definition_sha256: 'f'.repeat(64), image_digest: IMAGE_DIGEST },
      worker: { service_arn: 'arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-worker',
        task_definition_arn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-worker:7',
        task_definition_sha256: '1'.repeat(64), image_digest: IMAGE_DIGEST } },
      endpoints: { api: 'https://example.cloudfront.net' } },
    gate: gateBlock() };
  const record = buildRuntimeDeploymentRecord(base);
  assert.deepEqual(record.stacks.map((row) => row.name), [RUNTIME_STACK]);
  assert.throws(() => buildRuntimeDeploymentRecord({ ...base, templateSha256: 'not-a-hash' }), /Invalid deployed template hash/);
  assert.throws(() => buildRuntimeDeploymentRecord({ ...base, env: { ...base.env, GITHUB_SHA: 'short' } }), /Invalid deployment producer SHA/);
  assert.throws(() => buildRuntimeDeploymentRecord({ ...base, inputs: [{ ...inputs[0], parameter: '/elsewhere/x' }] }), /Invalid stage contract parameter/);
});

test('the stage-input reader reads the reviewed 39 names in bounded batches', () => {
  assert.equal(RUNTIME_STAGE_INPUT_NAMES.length, 39);
  assert.equal(new Set(RUNTIME_STAGE_INPUT_NAMES).size, 39);
  assert.equal(RUNTIME_STAGE_INPUT_NAMES.includes('/anywear/beta/isolated_subnet_ids'), false);
  for (const name of ['/anywear/beta/api_base_url', '/anywear/beta/vlm_config_arn',
    '/anywear/beta/cloudfront_prefix_list_id', '/anywear/beta/qweather_api_host']) assert.ok(RUNTIME_STAGE_INPUT_NAMES.includes(name), name);
  const batches = runtimeStageInputBatches();
  assert.equal(batches.flat().length, 39);
  assert.ok(batches.every((batch) => batch.length <= 10));
  assert.deepEqual(batches.map((batch) => batch.length), [10, 10, 10, 9]);
  // Every queue URL and the cluster name are contract names inside that read.
  for (const name of Object.values(RUNTIME_QUEUE_URL_NAMES)) assert.ok(RUNTIME_STAGE_INPUT_NAMES.includes(name), name);
  assert.ok(RUNTIME_STAGE_INPUT_NAMES.includes(RUNTIME_ECS_CLUSTER_INPUT));
});

test('one contract read yields both the hashed record inputs and the bake values', async () => {
  const { io } = fakeIo();
  const contract = await readRuntimeStageContract(io);
  assert.equal(contract.inputs.length, 39);
  assert.equal(contract.values.size, 39);
  assert.equal(contract.values.get('/anywear/beta/ecs_cluster_name'), 'beta-anywear');
  // The bake consumes the same read the record hashes, so the queue URL bytes can
  // never differ between the operation's evidence and the gate's transport.
  assert.deepEqual(runtimeBakeQueueUrls(contract.values), {
    vto: QUEUE_URLS['/anywear/beta/vto_queue_url'],
    auto_tagging: QUEUE_URLS['/anywear/beta/auto_tagging_queue_url'],
    vto_dlq: QUEUE_URLS['/anywear/beta/vto_dlq_url'],
    auto_tagging_dlq: QUEUE_URLS['/anywear/beta/auto_tagging_dlq_url'],
  });
  assert.equal(runtimeEcsClusterName(contract.values), 'beta-anywear');
  for (const row of contract.inputs) {
    assert.match(row.value_sha256, /^[a-f0-9]{64}$/, row.parameter);
  }
});

test('a deploy-runtime dispatch from the wrong source, workflow family, account or region fails before credentials', () => {
  const dispatch = { ...env(), GITHUB_REPOSITORY_ID: '1409047265', GITHUB_EVENT_NAME: 'workflow_dispatch',
    AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
    SERVICE_RELEASE_TAG: release.releaseTag, SERVICE_COMMIT: SERVICE_SHA };
  const inputs = validateOperationInputs(dispatch);
  assert.equal(inputs.operation, 'deploy-runtime');
  assert.deepEqual(inputs.service_release, { releaseTag: release.releaseTag, serviceCommit: SERVICE_SHA });
  // Another repository's dispatch cannot execute this operation, even with a
  // mutate.yml workflow ref.
  assert.throws(() => validateOperationInputs({ ...dispatch, GITHUB_REPOSITORY: 'git-malu/AnyWear-Service' }),
    /Protected Infra main executor and activation required/);
  assert.throws(() => validateOperationInputs({ ...dispatch, GITHUB_REPOSITORY_ID: '1158460323' }),
    /Protected Infra main executor and activation required/);
  // Only reviewed main, and only a dispatch event, may run it.
  assert.throws(() => validateOperationInputs({ ...dispatch, GITHUB_REF: 'refs/heads/issue/195-release-slice-merge' }),
    /Protected Infra main executor and activation required/);
  assert.throws(() => validateOperationInputs({ ...dispatch, GITHUB_EVENT_NAME: 'push' }),
    /Protected Infra main executor and activation required/);
  // Wrong account, wrong region and the wrong workflow family fail closed.
  assert.throws(() => validateOperationInputs({ ...dispatch, AWS_ACCOUNT_ID: '111111111111' }), /Unexpected account\/region/);
  assert.throws(() => validateOperationInputs({ ...dispatch, AWS_REGION: 'us-east-1' }), /Unexpected account\/region/);
  assert.throws(() => validateOperationInputs({ ...dispatch,
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main' }),
  /Operation is forbidden for this workflow family/);
  // The sealed release identity is mandatory for this operation.
  assert.throws(() => validateOperationInputs({ ...dispatch, SERVICE_RELEASE_TAG: '' }),
    /deploy-runtime requires the explicit Service release tag/);
  assert.throws(() => validateOperationInputs({ ...dispatch, SERVICE_COMMIT: 'not-a-sha' }),
    /Service release source commit/);
});

test('a deploy-runtime run whose v5 record never arrives is marked incomplete by the record job', async () => {
  // A converged no-op changed no stack, so losing its record stays `failed`; an
  // executed change set is a real mutation, so losing its record is `partial` with
  // an explicit recovery decision. Both are incomplete, never a silent success.
  for (const [label, event, result, recovery] of [
    ['converged', { type: 'runtime-change-set-converged', executed: false }, 'failed', 'not-required'],
    ['executed', { type: 'runtime-change-set-executed', executed: true, mode: 'update' }, 'partial', 'requires-explicit-recovery'],
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `runtime-deploy-record-${label}-`));
    try {
      const recordEnv = { ...env(), GITHUB_REPOSITORY_ID: '1409047265', GITHUB_EVENT_NAME: 'workflow_dispatch',
        AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', REQUIRE_DEPLOYMENT_RECORD: 'true',
        DEPLOY_JOB_RESULT: 'success', OBSERVE_JOB_RESULT: 'skipped' };
      const operationRecord = createOperationRecord({ env: recordEnv,
        release: { releaseTag: release.releaseTag, serviceCommit: SERVICE_SHA } });
      // A deploy-runtime has no separate `observe` job: the v5 record is the run's
      // accepted evidence, so losing it leaves the operation incomplete.
      operationRecord.events.push(event);
      operationRecord.result = 'succeeded';
      operationRecord.final_observation = 'skipped';
      await mkdir(path.join(root, 'deployment-evidence'), { recursive: true });
      await writeFile(path.join(root, 'deployment-evidence/operation-record.json'), canonicalJson(operationRecord));
      await assert.rejects(recordDeployment(recordEnv, { root, stdout: { write() {} } }),
        /The accepted deployment record is missing/, label);
      const marked = JSON.parse(await readFile(path.join(root, 'deployment-evidence/operation-record.json'), 'utf8'));
      assert.equal(marked.operation, 'deploy-runtime');
      assert.equal(marked.result, result, label);
      assert.equal(marked.recovery, recovery, label);
      assert.deepEqual(marked.events.at(-1), { type: 'accepted-deployment-record', result: 'missing',
        observation_job: 'skipped', expected_workflow: '.github/workflows/mutate.yml' }, label);
      // The marked record and its checksum are the evidence the run uploads.
      assert.ok((await readFile(path.join(root, 'deployment-evidence/operation-record.json.sha256'), 'utf8'))
        .endsWith('  operation-record.json\n'), label);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
