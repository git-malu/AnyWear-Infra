import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DECLARED_DIAGNOSTIC_EXCLUSION,
  DECLARED_DIAGNOSTIC_RESOURCE_TYPES,
  RUNTIME_DEPLOY_PARAMETER_KEYS,
  RUNTIME_STACK,
  acceptedLiveRuntimeHashes,
  assertConvergedChangeSet,
  assertCreateOnlyChangeSet,
  assertLiveRuntimeIdentity,
  assertRuntimePhase,
  classifyChangeSet,
  deployRuntime,
  readRuntimeHealth,
  recordedLivePredecessors,
  recordedRuntimePhaseHash,
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
import { runOperation, validateOperationInputs } from './runtime-operation.mjs';
import { sha256 } from './json-contract.mjs';
import { failedGate } from './bake-gate.mjs';
import { SchemaBoundaryError, runSchemaBoundaryGate } from './schema-gate.mjs';
import { gateBlock, IMAGE_DIGEST, SERVICE_SHA } from '../packages/stage-contracts/test/gate-fixture.mjs';

// Credential-free tests for the `deploy-runtime` operation (#195, #194). The
// synthesis, health probe, bake and schema-boundary gate are injected; every AWS
// surface is a fake that records calls, so each failure leaves the stack untouched
// and writes no deployment record (#207).
const release = { releaseTag: `service-artifacts-${SERVICE_SHA}`, serviceCommit: SERVICE_SHA, imageDigest: IMAGE_DIGEST };
// The gate's admitted comparison is a return value and a log line now, so a fake
// gate that resolves is all the deploy path needs from it.
const SCHEMA_GATE = async () => ({ result: 'compatible' });
const env = (overrides = {}) => ({
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '2',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main', GITHUB_REF: 'refs/heads/main',
  INFRA_OPERATION: 'deploy-runtime', INFRA_IDENTITY_PHASE: 'roles-added', INFRA_RETENTION_PROTECTION: 'true', ...overrides,
});
const TEMPLATE = JSON.parse(readFileSync('test/baselines/beta-active/AnyWearRuntimeStack-beta.template.json', 'utf8'));
const SYNTHESIZED = { template: TEMPLATE, raw_sha256: 'a'.repeat(64),
  normalised_sha256: 'b1a7c86c14bf664f0cede346f1d764cb7b310ac46407c718abc0453da415f56c',
  expected: 'b1a7c86c14bf664f0cede346f1d764cb7b310ac46407c718abc0453da415f56c' };
// The fixture synthesises the legacy-phase baseline (`TEMPLATE`), whose normalised
// hash is its own `expected`, while the recorded roles-added identity differs. The
// live-template acceptance set is a deploy seam, so the fixture pins it to that
// hash rather than widening production's recorded set; the dedicated accepted-set
// test below exercises the real `acceptedLiveRuntimeHashes()` and its precedence.
const FIXTURE_ACCEPTED_LIVE = Object.freeze([SYNTHESIZED.expected]);
const deploy = (options) => deployRuntime({ schemaGate: SCHEMA_GATE,
  acceptedLiveHashes: FIXTURE_ACCEPTED_LIVE, ...options });
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
    LastUpdatedTime: '2026-10-22T12:15:43.000Z',
    RoleARN: 'arn:aws:iam::650880818323:role/beta-service-deploy-cfn-role',
    Parameters: [
      { ParameterKey: 'ServiceCommitSha', ParameterValue: identityUnchanged ? SERVICE_SHA : 'b'.repeat(40) },
      { ParameterKey: 'ServiceImageDigest', ParameterValue: identityUnchanged ? IMAGE_DIGEST : `sha256:${'9'.repeat(64)}` },
      { ParameterKey: 'BetaApiSizingProfile', ParameterValue: 's1' },
      { ParameterKey: 'VlmConfigArn', ParameterValue: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:/anywear/beta/vlm_config-AbCdEf' },
      { ParameterKey: 'CloudFrontPrefixListId', ParameterValue: 'pl-0123456789abcdef' },
    ],
  };
}

function fakeIo({ base = { StackName: 'AnyWearPlatformStack-beta', StackStatus: 'UPDATE_COMPLETE' },
  runtime = liveStack(), changeSet = undefined, executeError = undefined, postExecuteRuntime = undefined } = {}) {
  const calls = [];
  // The changed-stack set the failed-run summary publishes. It starts as the
  // fake's own array and `runOperation` re-binds it to the array it owns.
  const changedStacks = [];
  let runtimeObserved = runtime;
  // A deleted change set can no longer be described. The fail-closed path deletes
  // the set, so a post-delete describe is a test failure: the operation must not
  // depend on re-reading a deleted set.
  let changeSetDeleted = false;
  const io = {
    calls, changedStacks, now: () => 0, sleep: async () => {},
    // The one changed-stack mechanism: the fake proves the operation records a
    // landed mutation through `io.markChanged`, not by reaching into its own state.
    markChanged(stack) { io.changedStacks.push(stack); },
    async aws(args) {
      const key = `${args[0]}/${args[1]}`;
      calls.push({ session: 'runtime', key, args });
      if (key === 'sts/get-caller-identity') return { Account: '650880818323' };
      if (key === 'ecr/describe-images') {
        const tag = args[args.indexOf('--image-ids') + 1].replace(/^imageTag=/, '');
        return { imageDetails: [{ imageTags: [tag], imageDigest: IMAGE_DIGEST }] };
      }
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
      if (args[1] === 'describe-change-set') {
        if (changeSetDeleted) throw new Error('describe-change-set after delete-change-set');
        return changeSet;
      }
      if (args[1] === 'delete-change-set') changeSetDeleted = true;
      if (args[1] === 'execute-change-set') {
        if (executeError) throw executeError;
        runtimeObserved = postExecuteRuntime ?? liveStack();
      }
      return {};
    },
    async deployRuntimeChangeSet({ args }) { calls.push({ session: 'deploy', key: 'cdk/deploy', args }); },
    async runtimeAwsRunner() { return () => '{}'; },
    async destroy(stack) { calls.push({ session: 'deploy', key: 'cdk/destroy', stack }); },
  };
  return { io, calls, setRuntime: (value) => { runtimeObserved = value; } };
}

test('the five deploy parameters are the release identity, the retained sizing profile and the two reviewed constants', () => {
  assert.deepEqual([...RUNTIME_DEPLOY_PARAMETER_KEYS], ['ServiceImageDigest', 'ServiceCommitSha',
    'BetaApiSizingProfile', 'VlmConfigArn', 'CloudFrontPrefixListId']);
  const parameters = runtimeDeployParameters({ liveParameters: [], deployValues: { VlmConfigArn: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:x', CloudFrontPrefixListId: 'pl-1' },
    release });
  assert.deepEqual(Object.keys(parameters).sort(), [...RUNTIME_DEPLOY_PARAMETER_KEYS].sort());
  assert.equal(Object.keys(parameters).length, 5);
  // The reviewed default applies only when the live stack never carried it.
  assert.equal(parameters.BetaApiSizingProfile, 's1');
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

test('the CDK arguments pass one stack-qualified flag per parameter and disable previous parameters', () => {
  const parameters = Object.fromEntries(RUNTIME_DEPLOY_PARAMETER_KEYS.map((key) => [key, `${key}-value`]));
  const args = runtimeCdkDeployArguments({ parameters, changeSetName: 'anywear-runtime-1', identityPhase: 'roles-added', retentionProtection: 'true' });
  assert.deepEqual(args.slice(0, 6), ['cdk', 'deploy', RUNTIME_STACK, '--exclusively', '--require-approval', 'never']);
  assert.ok(args.includes('--no-execute'));
  assert.ok(args.includes('deployScope=runtime'));
  assert.ok(args.includes('identityPhase=roles-added'));
  assert.ok(!args.some((arg) => arg.startsWith('artifactDirectory=')));
  assert.ok(!args.includes('--role-arn'), 'the standard synthesizer chooses the execution role');
  // Issue #194: the CLI's `--parameters` is an `array` option with `nargs: 1` and
  // documents `STACK:KEY=VALUE`, so the single-flag form kept only its first value
  // and `--previous-parameters` (default true) retained the rest. The exact array
  // is asserted, so a missing pair or a missing fail-closed flag fails this test.
  assert.deepEqual(args, ['cdk', 'deploy', RUNTIME_STACK, '--exclusively', '--require-approval', 'never',
    '--no-execute', '--change-set-name', 'anywear-runtime-1',
    '-c', 'deployScope=runtime', '-c', 'stage=beta', '-c', 'legacyRoleSource=external',
    '-c', 'identityPhase=roles-added', '-c', 'ecrImageRetention=true',
    '--previous-parameters=false',
    ...RUNTIME_DEPLOY_PARAMETER_KEYS.flatMap((key) => ['--parameters', `${RUNTIME_STACK}:${key}=${key}-value`])]);
  assert.equal(args.filter((arg) => arg === '--parameters').length, 5,
    'every parameter needs its own --parameters flag (nargs: 1)');
  for (const key of RUNTIME_DEPLOY_PARAMETER_KEYS) {
    assert.ok(args.includes(`${RUNTIME_STACK}:${key}=${key}-value`), key);
    assert.ok(!args.includes(`${key}=${key}-value`), `${key} must be stack-qualified`);
  }
  assert.throws(() => runtimeCdkDeployArguments({ parameters: { ServiceCommitSha: 'x' }, changeSetName: 'anywear-runtime-1',
    identityPhase: 'roles-added', retentionProtection: 'true' }), /exactly the five reviewed parameters/);
});

// Issue #183 step 8: the recorded Runtime identity transition deployed on
// 2026-10-23 (run 39929648413), so its one recorded live predecessor is retired and
// the live record accepts only the recorded roles-added identity. The read path
// keeps its predecessor support — inert and fail-closed for the live record — while
// the synthesis check and the post-deploy read-back stay exact against the recorded
// identity, which the deploy tests above prove with the fixture-pinned seam.
test('the live record accepts only the recorded identity, with its one predecessor retired', () => {
  const RECORDED = 'ed4e99ee6e8c640ea6e71349f74bd7fed31f60627914f92121b1bc3b1f93c8be';
  const PREDECESSOR = '6126c8b90f19d2319a6ddc5eede1f4762f195dcc77ee6c2d7b4bc42cc8bcc71f';
  // Against the live record the accepted set is exactly the recorded identity: the
  // pre-transition template the deploy started from is no longer accepted.
  assert.deepEqual(acceptedLiveRuntimeHashes(), [RECORDED]);
  assert.equal(acceptedLiveRuntimeHashes()[0], recordedRuntimePhaseHash());
  assert.doesNotThrow(() => assertLiveRuntimeIdentity(RECORDED));
  assert.equal(assertLiveRuntimeIdentity(RECORDED), RECORDED);
  assert.throws(() => assertLiveRuntimeIdentity(PREDECESSOR), /not the recorded roles-added identity/);
  assert.throws(() => assertLiveRuntimeIdentity('f'.repeat(64)), /not the recorded roles-added identity/);
  // An empty accepted set can never pass.
  assert.throws(() => assertLiveRuntimeIdentity(RECORDED, []), /accepted Runtime live identities are unavailable/);
  // The absent-member case is now the live record itself: it carries no predecessor
  // member and its reader yields none.
  const liveRecord = JSON.parse(readFileSync('test/baselines/provenance.json', 'utf8'));
  assert.equal(Object.hasOwn(liveRecord.runtime_identity.identity_revision, 'accepted_live_predecessors'), false);
  assert.deepEqual(recordedLivePredecessors(liveRecord.runtime_identity.identity_revision), []);
  // A record that does carry one predecessor still yields [recorded, predecessor] and
  // accepts it, so the read path stays inert rather than removed; a malformed list or
  // entry fails closed instead of widening the drift allowance.
  const record = (identityRevision) => ({ runtime_identity: { identity_phases: { 'roles-added': RECORDED },
    identity_revision: identityRevision } });
  assert.deepEqual(acceptedLiveRuntimeHashes(record(undefined)), [RECORDED]);
  assert.deepEqual(acceptedLiveRuntimeHashes(record({})), [RECORDED]);
  assert.deepEqual(recordedLivePredecessors(undefined), []);
  assert.deepEqual(acceptedLiveRuntimeHashes(record({ accepted_live_predecessors: [PREDECESSOR] })), [RECORDED, PREDECESSOR]);
  assert.doesNotThrow(() => assertLiveRuntimeIdentity(PREDECESSOR,
    acceptedLiveRuntimeHashes(record({ accepted_live_predecessors: [PREDECESSOR] }))));
  for (const malformed of [{ accepted_live_predecessors: PREDECESSOR },
    { accepted_live_predecessors: ['not-a-digest'] },
    { accepted_live_predecessors: [PREDECESSOR, 'a'.repeat(63)] }]) {
    assert.throws(() => acceptedLiveRuntimeHashes(record(malformed)), /Runtime live predecessor/);
  }
});

test('a change set is classified as converged or as a delta, and the guards fail closed', () => {
  assert.deepEqual(classifyChangeSet(undefined).converged, true);
  assert.deepEqual(classifyChangeSet({ Status: 'FAILED', StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." }), {
    converged: true, failed: false, status: 'FAILED', execution_status: 'unknown',
    reason: "The submitted information didn't contain changes. Submit different information to create a change set.",
    changes: [], resource_changes: [], diagnostic_changes: [], replacement: false,
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

  // Issue #195: `AWS::CDK::Metadata` is the declared diagnostic metadata the
  // template normalisation drops, so a change to it is evidence, not a stack
  // change, a delta or a replacement.
  assert.deepEqual(DECLARED_DIAGNOSTIC_RESOURCE_TYPES, ['AWS::CDK::Metadata']);
  const diagnostic = classifyChangeSet({ Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
    { Type: 'Modify', ResourceChange: { LogicalResourceId: 'CDKMetadata', ResourceType: 'AWS::CDK::Metadata', Replacement: 'Conditional' } }] });
  const diagnosticRow = { action: 'Modify', logical_id: 'CDKMetadata', resource_type: 'AWS::CDK::Metadata',
    action_type: 'Modify', replacement: 'Conditional', declared_diagnostic: true, excluded: DECLARED_DIAGNOSTIC_EXCLUSION };
  assert.equal(diagnostic.converged, true);
  assert.equal(diagnostic.failed, false);
  assert.equal(diagnostic.replacement, false, 'a diagnostic conditional replacement is not a replacement');
  assert.deepEqual(diagnostic.resource_changes, []);
  assert.deepEqual(diagnostic.diagnostic_changes, [diagnosticRow]);
  assert.deepEqual(diagnostic.changes, [diagnosticRow]);
  assert.doesNotThrow(() => assertConvergedChangeSet(diagnostic));

  // A real resource keeps the unchanged fail-closed guard even when a diagnostic
  // row is present: only real rows count and only their replacement flags report.
  const mixed = classifyChangeSet({ Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
    { Type: 'Modify', ResourceChange: { LogicalResourceId: 'ComputeRuntimeApiServiceD2475D0A', ResourceType: 'AWS::ECS::Service', Replacement: 'False' } },
    { Type: 'Modify', ResourceChange: { LogicalResourceId: 'CDKMetadata', ResourceType: 'AWS::CDK::Metadata', Replacement: 'Conditional' } }] });
  assert.equal(mixed.converged, false);
  assert.equal(mixed.replacement, false, 'the diagnostic row does not raise the replacement flag');
  assert.throws(() => assertConvergedChangeSet(mixed), /the change set lists 1: Modify ComputeRuntimeApiServiceD2475D0A \(False\)/);
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
  await assert.rejects(deploy({ env: env(), release,
    io: fakeIo({ base: { StackName: 'AnyWearPlatformStack-beta', StackStatus: 'UPDATE_IN_PROGRESS' } }).io,
    synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE }), /terminal Base stack/);
  const nonTerminal = fakeIo({ runtime: liveStack({ terminal: false }) });
  await assert.rejects(deploy({ env: env(), release, io: nonTerminal.io,
    synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE }), /terminal Runtime stack/);
  assert.equal(nonTerminal.calls.some((call) => call.key === 'cdk/deploy'), false);
});

// Issue #194 acceptance: a schema-boundary refusal stops the run at the gate. The
// gate is the real runner (only its asset, probe, log and comparison transport are
// injected), so the refusal is the production one. Nothing after the gate runs: no
// synthesis, no CDK change-set call, no deployed identity.
test('a schema-boundary refusal fails the run before synthesis, the change set and the record', async () => {
  const { io, calls } = fakeIo({ changeSet: { Status: 'FAILED',
    StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." } });
  const assetBytes = readFileSync('test/fixtures/schema-boundary/schema-asset.json');
  const liveRead = JSON.parse(readFileSync('test/fixtures/schema-boundary/live-read-compatible.json', 'utf8'));
  // Synthetic ahead variant: one applied row the release does not contain. The
  // captured last serial is 133, so the next applied row would be 134.
  const ahead = structuredClone(liveRead);
  ahead.applied.push({ id: 134, tag: '0026_newer_fly', created_at: ahead.applied.at(-1).created_at + 1000,
    hash: 'f'.repeat(64) });
  const definitionArn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-verify:7';
  const task = { taskArn: `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'a'.repeat(32)}`,
    clusterArn: 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear', lastStatus: 'STOPPED',
    taskDefinitionArn: definitionArn,
    containers: [{ name: 'OneShot', exitCode: 0, imageDigest: IMAGE_DIGEST }] };
  const definition = { family: 'beta-anywear-verify', taskDefinitionArn: definitionArn };
  let synthesized = 0;
  await assert.rejects(deploy({ env: env(), release, io,
    synthesize: async () => { synthesized += 1; return SYNTHESIZED; }, health: HEALTH, bake: BAKE,
    schemaGate: (options) => runSchemaBoundaryGate({ ...options,
      loadAsset: async () => ({ asset: JSON.parse(assetBytes.toString('utf8')), bytes: assetBytes,
        sha256: sha256(assetBytes) }),
      probe: async () => ({ task, definition }), readLog: async () => ahead }) }),
  (error) => error instanceof SchemaBoundaryError && error.reason === 'applied-beyond-release'
    && /expected release journal ends at 0025_new_human_fly/.test(error.message)
    && /observed database row 134 at index 26 0026_newer_fly/.test(error.message));
  assert.equal(synthesized, 0, 'synthesis never runs after a refusal');
  assert.equal(calls.some((call) => call.key === 'cdk/deploy'), false, 'no CDK change-set call');
  assert.equal(calls.some((call) => call.key === 'cloudformation/describe-change-set'), false);
});

test('a converged stack records an empty change set, executes nothing and returns the deployed identity', async () => {
  const { io, calls } = fakeIo({ changeSet: { Status: 'FAILED',
    StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." } });
  let gateOptions;
  const deployment = await deploy({ env: env(), release, io,
    synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE,
    schemaGate: async (options) => { gateOptions = options; return { result: 'compatible' }; } });
  assert.deepEqual(deployment, { service_sha: SERVICE_SHA, image_digest: IMAGE_DIGEST,
    minimum_client_version: 0, template_sha256: SYNTHESIZED.normalised_sha256 });
  // Issue #194: the gate runs on the release identity and the revision the
  // pre-state parameters pin.
  assert.deepEqual(gateOptions.release, { releaseTag: release.releaseTag, serviceCommit: SERVICE_SHA,
    imageDigest: IMAGE_DIGEST });
  assert.deepEqual(gateOptions.deployedRevision, { serviceCommit: SERVICE_SHA, imageDigest: IMAGE_DIGEST });
  assert.equal(calls.some((call) => call.args?.includes('execute-change-set')), false, 'a converged no-op executes nothing');
  assert.ok(calls.some((call) => call.args?.includes('delete-change-set')));
});

// Issue #195 blocking fix: `deploy-runtime` must hand the bake the four queue
// URLs and the cluster name from the 39-name stage-contract read. A queue name
// makes every `sqs get-queue-attributes --queue-url` read fail at Deployment, so
// the gate can never pass and the run fails.
test('the bake receives the contract queue URLs and cluster, not hardcoded names', async () => {
  const { io } = fakeIo({ changeSet: { Status: 'FAILED',
    StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." } });
  const captured = capturingBake();
  await deploy({ env: env(), release, io, synthesize: async () => SYNTHESIZED, health: HEALTH,
    bake: captured.bake });
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
});

test('an unchanged release identity cannot produce a delta: Add, Remove and Modify still fail closed and delete the change set', async () => {
  for (const action of ['Add', 'Modify', 'Remove']) {
    const { io, calls } = fakeIo({ changeSet: { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
      { Type: action, ResourceChange: { LogicalResourceId: 'ComputeRuntimeApiServiceD2475D0A', ResourceType: 'AWS::ECS::Service', Replacement: 'False' } }] } });
    await assert.rejects(deploy({ env: env(), release, io,
      synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE }), /must not change the stack/, action);
    assert.equal(calls.some((call) => call.args?.includes('execute-change-set')), false, action);
    assert.ok(calls.some((call) => call.args?.includes('delete-change-set')), `${action}: fail-closed delete`);
  }
});

// Issue #195 acceptance: a converged release's only change is the CDKMetadata
// Analytics payload, which the declared normalisation drops. It must execute
// nothing, delete the change set, and let the operation continue to read back and
// bake.
test('a CDKMetadata-only change set is converged: it executes nothing and is deleted', async () => {
  const { io, calls } = fakeIo({ changeSet: { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
    { Type: 'Modify', ResourceChange: { LogicalResourceId: 'CDKMetadata', ResourceType: 'AWS::CDK::Metadata', Replacement: 'Conditional' } }] } });
  const deployment = await deploy({ env: env(), release, io,
    synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE });
  assert.equal(deployment.template_sha256, SYNTHESIZED.normalised_sha256);
  assert.equal(deployment.service_sha, SERVICE_SHA);
  assert.equal(calls.some((call) => call.args?.includes('execute-change-set')), false, 'the diagnostic delta executes nothing');
  assert.ok(calls.some((call) => call.args?.includes('delete-change-set')), 'the diagnostic-only change set is deleted');
  const deleteIndex = calls.findIndex((call) => call.args?.includes('delete-change-set'));
  assert.equal(calls.slice(deleteIndex + 1).some((call) => call.args?.includes('describe-change-set')), false,
    'the operation does not depend on describing the deleted change set');
});

// Issue #195 acceptance: only AWS::CDK::Metadata is declared diagnostics. A
// conditional replacement on a real resource still fails closed before execution,
// and the fail-closed path deletes the change set.
test('a Modify with Replacement: Conditional on a real resource fails closed and deletes the change set', async () => {
  const { io, calls } = fakeIo({ changeSet: { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
    { Type: 'Modify', ResourceChange: { LogicalResourceId: 'ComputeRuntimeApiServiceD2475D0A', ResourceType: 'AWS::ECS::Service', Replacement: 'Conditional' } }] } });
  await assert.rejects(deploy({ env: env(), release, io,
    synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE }),
  /must not change the stack; the change set lists 1: Modify ComputeRuntimeApiServiceD2475D0A \(Conditional\)/);
  assert.equal(calls.some((call) => call.args?.includes('execute-change-set')), false, 'a real delta never executes');
  assert.ok(calls.some((call) => call.args?.includes('delete-change-set')), 'the fail-closed path deletes the change set');
});

// Issue #195 acceptance: a change-set execute failure leaves a failed run, and the
// bake never runs.
test('a change-set execute failure fails the run before the bake', async () => {
  const { io, calls } = fakeIo({ runtime: liveStack({ identityUnchanged: false }),
    changeSet: { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
      { Type: 'Add', ResourceChange: { LogicalResourceId: 'BetaReleaseChange', ResourceType: 'AWS::S3::Bucket', Replacement: 'False' } }] },
    executeError: Object.assign(new Error('An error occurred (AccessDenied) when calling the ExecuteChangeSet operation'), {
      stderr: 'An error occurred (AccessDenied)' }) });
  const captured = capturingBake();
  await assert.rejects(deploy({ env: env(), release, io,
    synthesize: async () => SYNTHESIZED, health: HEALTH, bake: captured.bake }), /AccessDenied/);
  assert.ok(calls.some((call) => call.args?.includes('execute-change-set')));
  assert.equal(captured.baked.length, 0, 'the bake never runs after a failed execution');
});

test('a breaching or insufficient-data bake fails the run', async () => {
  const healthy = gateBlock();
  const breaching = { ...healthy, result: 'failed', signals: healthy.signals.map((signal, index) => (index === 3
    ? { ...signal, state: 'breaching', exceptions: ['vto oldest-message age 151s exceeds 150s'] }
    : signal)) };
  const insufficient = failedGate({ stage: 'beta', cluster: 'beta-anywear',
    logGroup: '/anywear/beta/worker', serviceSha: SERVICE_SHA, imageDigest: IMAGE_DIGEST });
  assert.equal(insufficient.result, 'failed');
  assert.ok(insufficient.signals.every((signal) => signal.state === 'insufficient'));
  for (const [label, gate] of [['breaching', breaching], ['insufficient', insufficient]]) {
    const { io, calls } = fakeIo({ changeSet: { Status: 'FAILED',
      StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." } });
    await assert.rejects(deploy({ env: env(), release, io,
      synthesize: async () => SYNTHESIZED, health: HEALTH, bake: async () => gate }),
    /The 300-second bake failed/, label);
    // A converged no-op still never executes a change set before a failed bake.
    assert.equal(calls.some((call) => call.args?.includes('execute-change-set')), false, label);
  }
});

test('an absent Runtime stack is an Add-only create that executes, and stop of an absent stack is a no-op', async () => {
  const { io, calls, setRuntime } = fakeIo({ runtime: null,
    changeSet: { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
      { Type: 'Add', ResourceChange: { LogicalResourceId: 'ComputeRuntimeApiServiceD2475D0A', ResourceType: 'AWS::ECS::Service', Replacement: 'False' } }] } });
  const deployment = await deploy({ env: env(), release, io, synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE });
  assert.equal(deployment.service_sha, SERVICE_SHA);
  assert.ok(calls.some((call) => call.args?.includes('execute-change-set')));

  setRuntime(undefined);
  assert.equal(await stopRuntime({ env: env({ INFRA_OPERATION: 'stop-runtime' }), io }), 'absent');
  assert.equal(calls.some((call) => call.key === 'cdk/destroy'), false);
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

test('one contract read yields both the hashed stage inputs and the bake values', async () => {
  const { io } = fakeIo();
  const contract = await readRuntimeStageContract(io);
  assert.equal(contract.inputs.length, 39);
  assert.equal(contract.values.size, 39);
  assert.equal(contract.values.get('/anywear/beta/ecs_cluster_name'), 'beta-anywear');
  // The bake consumes the same read the schema-boundary gate compares, so the
  // queue URL bytes can never differ between the operation's reads and the gate's
  // transport.
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

// Review I-B1: `deploy-runtime` executes the change set itself, so the mutation has
// to be recorded at the point it happens — after `execute-change-set` returns and
// before the stack read-back, the ECS identity proof, `/health` and the bake. A
// landed update whose later gate refuses must still leave the one step-summary line
// that says "changed but unqualified"; a converged no-op must leave none.
const DELTA_CHANGE_SET = { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
  { Type: 'Modify', ResourceChange: { LogicalResourceId: 'ComputeRuntimeApiServiceD2475D0A', ResourceType: 'AWS::ECS::Service', Replacement: 'False' } }] };

// The dispatch `validateOperationInputs` accepts for `deploy-runtime`, plus the step
// summary the operation's catch appends to.
const operationEnv = (overrides = {}) => ({ ...env(), GITHUB_REPOSITORY_ID: '1409047265', GITHUB_EVENT_NAME: 'workflow_dispatch',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
  SERVICE_RELEASE_TAG: release.releaseTag, SERVICE_COMMIT: SERVICE_SHA, ...overrides });

async function withSummary(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'infra-runtime-summary-'));
  try {
    return await run(path.join(directory, 'summary.md'));
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

test('a bake refusal after the change set executed appends exactly one summary line naming the Runtime stack', async () => {
  await withSummary(async (summary) => {
    const { io, calls } = fakeIo({ runtime: liveStack({ identityUnchanged: false }), changeSet: DELTA_CHANGE_SET });
    const createIo = async (_environment, { changedStacks }) => { io.changedStacks = changedStacks; return io; };
    await assert.rejects(runOperation(operationEnv({ GITHUB_STEP_SUMMARY: summary }), {
      createIo,
      // Only the deploy's own collaborators are fake; the change-set judgement, the
      // mutation, the read-back and the gate ordering are the production ones.
      deployRuntimeDependencies: { schemaGate: SCHEMA_GATE, synthesize: async () => SYNTHESIZED, health: HEALTH,
        acceptedLiveHashes: FIXTURE_ACCEPTED_LIVE,
        bake: async () => failedGate({ stage: 'beta', cluster: 'beta-anywear', logGroup: '/anywear/beta/worker',
          serviceSha: SERVICE_SHA, imageDigest: IMAGE_DIGEST }) },
    }), /The 300-second bake failed/);
    assert.ok(calls.some((call) => call.args?.includes('execute-change-set')), 'the change set executed first');
    const lines = (await readFile(summary, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1, 'exactly one summary line');
    assert.match(lines[0], /Infra operation deploy-runtime already changed AnyWearRuntimeStack-beta and did not complete/);
    assert.equal((lines[0].match(/AnyWearRuntimeStack-beta/g) ?? []).length, 1,
      'the Runtime stack is named exactly once');
    assert.deepEqual(io.changedStacks, [RUNTIME_STACK], 'the landed mutation is recorded once');
  });
});

test('a converged deploy-runtime appends no changed-stack summary line', async () => {
  await withSummary(async (summary) => {
    const { io, calls } = fakeIo({ changeSet: { Status: 'FAILED',
      StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." } });
    const createIo = async (_environment, { changedStacks }) => { io.changedStacks = changedStacks; return io; };
    await runOperation(operationEnv({ GITHUB_STEP_SUMMARY: summary }), {
      createIo,
      deployRuntimeDependencies: { schemaGate: SCHEMA_GATE, synthesize: async () => SYNTHESIZED, health: HEALTH,
        acceptedLiveHashes: FIXTURE_ACCEPTED_LIVE, bake: BAKE },
    });
    assert.equal(calls.some((call) => call.args?.includes('execute-change-set')), false,
      'a converged no-op executes nothing');
    const lines = (await readFile(summary, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1, 'only the completed-operation line');
    assert.match(lines[0], /Infra operation deploy-runtime; source a{40}\./);
    assert.equal(lines[0].includes('already changed'), false);
    assert.deepEqual(io.changedStacks, [], 'a converged no-op records no changed stack');
  });
});

test('the executed change set is recorded as changed before the stack read-back can fail', async () => {
  const { io } = fakeIo({ runtime: liveStack({ identityUnchanged: false }), changeSet: DELTA_CHANGE_SET,
    postExecuteRuntime: { ...liveStack(), StackStatus: 'ROLLBACK_IN_PROGRESS' } });
  await assert.rejects(deploy({ env: env(), release, io, synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE }),
    /ended in ROLLBACK_IN_PROGRESS/);
  assert.deepEqual(io.changedStacks, [RUNTIME_STACK]);
});
