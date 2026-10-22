import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { RUNTIME_STAGE_INPUT_NAMES, runtimeStageInputBatches } from './runtime-stage-inputs.mjs';
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
const stageValue = (name) => (name === '/anywear/beta/vlm_config_arn'
  ? 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:/anywear/beta/vlm_config-AbCdEf'
  : name === '/anywear/beta/cloudfront_prefix_list_id' ? 'pl-0123456789abcdef'
    : name === '/anywear/beta/api_base_url' ? 'https://d111111abcdef8.cloudfront.net' : `value:${name}`);

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
  runtime = liveStack(), changeSet = undefined } = {}) {
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
      if (args[1] === 'execute-change-set') runtimeObserved = liveStack();
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

test('an unchanged release identity cannot produce a delta: any Modify fails closed', async () => {
  const { io, calls } = fakeIo({ changeSet: { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
    { Type: 'Modify', ResourceChange: { LogicalResourceId: 'ComputeRuntimeApiServiceD2475D0A', ResourceType: 'AWS::ECS::Service', Replacement: 'False' } }] } });
  await assert.rejects(deployRuntime({ env: env(), release, record: { events: [] }, io,
    synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE }), /must not change the stack/);
  assert.equal(calls.some((call) => call.args?.includes('execute-change-set')), false);
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
});
