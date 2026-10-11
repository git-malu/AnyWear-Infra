import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseFixtureRequest, validateFixtureInputs, fixtureSessionPolicy, fixtureCredentials,
  assertFixtureDefinition, assertStoppedFixture, readFixtureState, readFixtureResult, executeFixture, fixtureOperationRecord, persistFixtureRecord, fixtureFamily, fixtureMarker } from './cleanup-acceptance.mjs';
import { canonicalJson, sha256 } from './json-contract.mjs';

const cluster = 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear';
const taskArn = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'c'.repeat(32)}`;
const taskDefinitionArn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-cleanup-acceptance:7';
const request = { run_scope: '123-1-0123456789abcdef', users: [
  { slot: 2, user_id: '11111111-1111-1111-1111-111111111111', email: 'e2e-beta-worker-2-chromium@anywear.local' },
  { slot: 3, user_id: '22222222-2222-2222-2222-222222222222', email: 'e2e-beta-worker-3-chromium@anywear.local' },
] };
const env = { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
  GITHUB_REPOSITORY_OWNER: 'git-malu', GITHUB_REPOSITORY_OWNER_ID: '11473072', GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
  GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '234', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/beta-cleanup-acceptance.yml@refs/heads/main', ENABLE_BETA_CLEANUP_ACCEPTANCE: 'true',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', INFRA_RUNTIME_ROLE_ARN: 'arn:aws:iam::650880818323:role/beta-infra-runtime-role',
  FIXTURE_ACTION: 'prepare', FIXTURE_REQUEST: JSON.stringify(request), FIXTURE_TASK_DEFINITION_ARN: taskDefinitionArn, FIXTURE_SOURCE_SHA: 'b'.repeat(40),
  SELECTION_FILE: 'selections/test.json', SELECTION_SHA256: 'd'.repeat(64), STACK_SOURCES_FILE: 'stack-sources/test.json', STACK_SOURCES_SHA256: 'e'.repeat(64) };
env.BOOTSTRAP_ORIGIN = canonicalJson({ repository: 'git-malu/AnyWear-E2E', workflow_path: '.github/workflows/beta-cleanup-acceptance.yml',
  source_sha: 'b'.repeat(40), run_id: 123, run_attempt: 1, artifact_id: 456, artifact_sha256: 'a'.repeat(64), manifest_sha256: 'c'.repeat(64) });
const stateMachineVersionArn = 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:7';
const selector = { image: { repository_uri: '650880818323.dkr.ecr.ap-east-1.amazonaws.com/beta-anywear-service', service_sha: 'f'.repeat(40), digest: `sha256:${'e'.repeat(64)}` } };
const platform = { BetaActive: 'true', EcsClusterName: 'beta-anywear', OneShotLogGroupName: '/anywear/beta/one-shot',
  CleanupTaskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-tester-cleanup-task',
  OneShotExecutionRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution',
  DatabaseSecretArn: 'secret-fixture', DatabaseHost: 'db.example.invalid', DatabasePort: '5432', DatabaseName: 'anywear',
  WardrobeBucketName: 'beta-fixture', VtoQueueUrl: 'vto', AutoTaggingQueueUrl: 'tagging',
  PrivateSubnetIds: 'subnet-12345678', OneShotSecurityGroupId: 'sg-12345678' };
const fixedCommand = ['node', 'dist/ops/beta-cleanup-acceptance-fixture.js'];
const definition = { taskDefinitionArn, family: fixtureFamily, status: 'ACTIVE', networkMode: 'awsvpc', cpu: '512', memory: '1024',
  requiresCompatibilities: ['FARGATE'], taskRoleArn: platform.CleanupTaskRoleArn, executionRoleArn: platform.OneShotExecutionRoleArn,
  containerDefinitions: [{ name: 'OneShot', essential: true, command: fixedCommand, image: `${selector.image.repository_uri}@${selector.image.digest}`,
    environment: Object.entries({ STAGE: 'beta', NODE_ENV: 'production', AWS_REGION: 'ap-east-1', BETA_CLEANUP_ACCEPTANCE_ISSUE: '86',
      SERVICE_COMMIT_SHA: selector.image.service_sha, IMAGE_DIGEST: selector.image.digest,
      DB_SECRET_ARN: platform.DatabaseSecretArn, DB_HOST: platform.DatabaseHost, DB_PORT: platform.DatabasePort, DB_NAME: platform.DatabaseName,
      S3_BUCKET_NAME: platform.WardrobeBucketName, TASK_TRANSPORT: 'sqs', SQS_VTO_QUEUE_URL: platform.VtoQueueUrl, SQS_AUTO_TAGGING_QUEUE_URL: platform.AutoTaggingQueueUrl })
      .map(([name, value]) => ({ name, value })),
    logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/anywear/beta/one-shot', 'awslogs-region': 'ap-east-1', 'awslogs-stream-prefix': fixtureFamily } } }] };
const task = { taskArn, clusterArn: cluster, taskDefinitionArn, lastStatus: 'STOPPED',
  containers: [{ name: 'OneShot', lastStatus: 'STOPPED', exitCode: 0, imageDigest: selector.image.digest }],
  overrides: { containerOverrides: [{ name: 'OneShot', command: [...fixedCommand, env.FIXTURE_ACTION, env.FIXTURE_REQUEST] }] } };
const result = { schema_version: 1, record_type: 'anywear_beta_cleanup_acceptance_result', action: 'prepare', run_scope: request.run_scope,
  request_sha256: sha256(env.FIXTURE_REQUEST), service_commit_sha: selector.image.service_sha, service_image_digest: selector.image.digest,
  transaction_committed: true, queue_calls: 0, provider_calls: 0, lifecycle_changes: 0,
  before: request.users.map((user, index) => ({ ...user, role: index === 0 ? 'primary' : 'sentinel' })),
  after: request.users.map((user, index) => ({ ...user, role: index === 0 ? 'primary' : 'sentinel' })) };

function fixture(overrides = {}) {
  const calls = []; let clock = 0; let launched;
  const stacks = ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta'].map((StackName, index) => ({ StackName,
    StackId: `arn:aws:cloudformation:ap-east-1:650880818323:stack/${StackName}/id`, StackStatus: 'UPDATE_COMPLETE', LastUpdatedTime: '2026-10-10T01:00:00Z',
    Outputs: Object.entries(index === 0 ? platform : { BetaActive: 'true', CleanupAcceptanceTaskDefinitionArn: taskDefinitionArn,
      CleanupOperationCleanupStateMachineVersionArn18053210: stateMachineVersionArn })
      .map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })),
    Parameters: Object.entries({ ServiceCommitSha: selector.image.service_sha, ServiceImageDigest: selector.image.digest })
      .map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })) }));
  const io = { now: () => clock, sleep: async ms => { clock += ms; }, async aws(args) {
    calls.push(args);
    if (overrides[args[1]]) return overrides[args[1]](args, calls, stacks);
    switch (args[1]) {
      case 'describe-stacks': return { Stacks: [stacks.find(stack => stack.StackName === args[3])] };
      case 'get-parameters': return { Parameters: [{ Name: args[3], Value: args[3].endsWith('tester_allowlist') ? '[]' : args[3].endsWith('admission_suspended') ? 'true' : 'false' }] };
      case 'describe-task-definition': return { taskDefinition: definition };
      case 'get-template': return { TemplateBody: { Resources: { FixtureTask: { Type: 'AWS::ECS::TaskDefinition', Properties: { Family: fixtureFamily } } }, Outputs: { CleanupAcceptanceTaskDefinitionArn: { Value: { Ref: 'FixtureTask' } } } } };
      case 'list-tasks': return { taskArns: [] };
      case 'describe-tasks': return { tasks: [task] };
      case 'get-log-events': return { events: args.includes('--next-token') ? [] : [{ message: `${fixtureMarker}${JSON.stringify(result)}` }], nextForwardToken: 'end' };
      default: throw new Error(`Unexpected fixture AWS call ${args[1]}`);
    }
  } };
  return { io, calls, stacks, stateMachineVersionArn, runTask: async (input, roles, beforeLaunch) => { await beforeLaunch(); launched = { input, roles }; return { tasks: [{ taskArn }] }; }, launch: () => launched };
}

test('dedicated protected executor and exact canonical captured slots reject unsafe inputs', () => {
  assert.deepEqual(validateFixtureInputs(env), request);
  for (const change of [{ ENABLE_BETA_CLEANUP_ACCEPTANCE: 'false' }, { GITHUB_REF: 'refs/heads/candidate' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main' }, { GITHUB_REPOSITORY_ID: '1158460323' },
    { GITHUB_REPOSITORY_OWNER_ID: '1' }, { GITHUB_REPOSITORY_OWNER: 'other' }, { GITHUB_WORKFLOW_SHA: '0'.repeat(40) },
    { AWS_ACCOUNT_ID: '111111111111' }, { AWS_REGION: 'us-east-1' }, { FIXTURE_ACTION: 'start' }, { FIXTURE_TASK_DEFINITION_ARN: fixtureFamily },
    { FIXTURE_TASK_DEFINITION_ARN: taskDefinitionArn.replace('acceptance', 'cleanup') }, { FIXTURE_SOURCE_SHA: '@executor' }, { SELECTION_FILE: '../bad.json' }]) {
    assert.throws(() => validateFixtureInputs({ ...env, ...change }));
  }
  for (const mutate of [r => r.users[1].user_id = r.users[0].user_id, r => r.users[0].slot = 0,
    r => r.users[0].email = 'other@anywear.local', r => r.users[0].unknown = true, r => r.run_scope = '123', r => r.users.pop()]) {
    const bad = structuredClone(request); mutate(bad); assert.throws(() => parseFixtureRequest(JSON.stringify(bad)));
  }
  for (const text of [` ${env.FIXTURE_REQUEST}`, JSON.stringify(request, null, 2), env.FIXTURE_REQUEST.replace('"run_scope":', '"run_scope":"x","run_scope":'), 'x'.repeat(2049)]) {
    assert.throws(() => parseFixtureRequest(text));
  }
});

test('read and run STS sessions are independent, bounded and omit broad runtime authority', () => {
  const read = fixtureSessionPolicy('read', env); const run = fixtureSessionPolicy('run', env, [platform.CleanupTaskRoleArn, platform.OneShotExecutionRoleArn]);
  assert.ok(Buffer.byteLength(read) <= 2048); assert.ok(Buffer.byteLength(run) <= 2048);
  assert.doesNotMatch(read, /RunTask|PassRole|Register|PutParameter|StopTask/);
  assert.doesNotMatch(run, /Register|Deregister|StopTask|ssm:|states:|cloudformation:|ecr:|logs:/);
  const readPolicy = JSON.parse(read);
  const taskDefinitionRead = readPolicy.Statement.find(statement => statement.Action === 'ecs:DescribeTaskDefinition');
  assert.equal(taskDefinitionRead.Resource, '*');
  assert.deepEqual(taskDefinitionRead.Condition, { StringEquals: { 'aws:RequestedRegion': 'ap-east-1' } });
  const policy = JSON.parse(run);
  assert.equal(policy.Statement[0].Resource, taskDefinitionArn);
  assert.deepEqual(policy.Statement[1].Resource, [platform.CleanupTaskRoleArn, platform.OneShotExecutionRoleArn]);
  for (const roles of [undefined, [], [platform.OneShotExecutionRoleArn, platform.CleanupTaskRoleArn], [platform.CleanupTaskRoleArn, 'arn:aws:iam::650880818323:role/Administrator'],
    [platform.CleanupTaskRoleArn, 'arn:aws:iam::650880818323:role/AnyWearPlatformStack-beta-OneShotExecutionRole12345678-abcd1234']]) {
    assert.throws(() => fixtureSessionPolicy('run', env, roles));
  }
});

test('fixture credential exchange carries measured inline policy and discards inherited AWS credentials', async () => {
  const policy = fixtureSessionPolicy('read', env);
  let observed;
  const credentials = await fixtureCredentials('read', policy, { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-request', AWS_ACCESS_KEY_ID: 'unsafe', AWS_SECRET_ACCESS_KEY: 'unsafe', AWS_PROFILE: 'unsafe' }, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ value: 'fixed-token' }) }),
    run: async (binary, args, options) => { observed = { binary, args, options }; return { stdout: JSON.stringify({
      AssumedRoleUser: { Arn: 'arn:aws:sts::650880818323:assumed-role/beta-infra-runtime-role/fixture' },
      Credentials: { AccessKeyId: 'scoped-key', SecretAccessKey: 'scoped-secret', SessionToken: 'scoped-token' } }) }; },
  });
  assert.equal(observed.args[observed.args.indexOf('--policy') + 1], policy);
  assert.equal(observed.options.env.AWS_ACCESS_KEY_ID, undefined); assert.equal(observed.options.env.AWS_PROFILE, undefined);
  assert.equal(credentials.AWS_ACCESS_KEY_ID, 'scoped-key');
});

test('credential failures omit secret argv and reject unrecognized session kinds or policies before OIDC', async () => {
  const policy = fixtureSessionPolicy('read', env);
  const input = { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret-request' };
  let fetched = 0;
  const io = { fetchImpl: async () => { fetched++; return { ok: true, json: async () => ({ value: 'secret-web-identity' }) }; },
    run: async () => { throw new Error('aws --web-identity-token secret-web-identity'); } };
  for (const [kind, supplied] of [['other', policy], ['read', '{}'], ['read', JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] })]]) {
    await assert.rejects(fixtureCredentials(kind, supplied, input, io));
  }
  assert.equal(fetched, 0);
  await assert.rejects(fixtureCredentials('read', policy, input, io), error => {
    assert.equal(error.message, 'Fixture credential exchange failed');
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.stack, /secret-web-identity|secret-request|--web-identity-token/);
    return true;
  });
  await assert.rejects(fixtureCredentials('read', policy, input, { ...io,
    fetchImpl: async () => { throw new Error('Authorization: Bearer secret-request'); },
  }), error => error.message === 'Fixture OIDC request failed' && !error.cause && !error.stack.includes('secret-request'));
});

test('fixed definition accepts absent or empty entryPoint and rejects non-empty drift', () => {
  assertFixtureDefinition(definition, platform, selector, env);
  const empty = structuredClone(definition); empty.containerDefinitions[0].entryPoint = [];
  assertFixtureDefinition(empty, platform, selector, env);
  const invalid = structuredClone(definition); invalid.containerDefinitions[0].entryPoint = ['sh'];
  assert.throws(() => assertFixtureDefinition(invalid, platform, selector, env));
});

test('fixed definition rejects image, command, environment, role, volume and log drift', () => {
  assertFixtureDefinition(definition, platform, selector, env);
  for (const mutate of [d => d.taskRoleArn = platform.OneShotExecutionRoleArn, d => d.family = 'other', d => d.cpu = '1024',
    d => d.containerDefinitions[0].image += '0', d => d.containerDefinitions[0].command = ['node', '-e', 'bad'],
    d => d.containerDefinitions[0].entryPoint = ['sh'], d => d.containerDefinitions[0].environment.push({ name: 'BETA_TESTER_ALLOWLIST_PARAMETER', value: 'bad' }),
    d => d.containerDefinitions[0].environment.push(d.containerDefinitions[0].environment[0]), d => d.volumes = [{ name: 'other' }],
    d => d.containerDefinitions[0].logConfiguration.options['awslogs-stream-prefix'] = 'other']) {
    const bad = structuredClone(definition); mutate(bad); assert.throws(() => assertFixtureDefinition(bad, platform, selector, env));
  }
});

test('stopped fixture proof isolates exit, status, identity, digest and forbidden overrides', () => {
  assertStoppedFixture(task, env, selector, request);
  assertStoppedFixture({ ...task, overrides: { ...task.overrides, cpu: '512', memory: '1024' } }, env, selector, request);
  for (const mutate of [t => t.lastStatus = 'RUNNING', t => t.taskDefinitionArn = `${taskDefinitionArn}0`, t => t.clusterArn += '0',
    t => t.containers[0].exitCode = 1, t => delete t.containers[0].exitCode, t => t.containers[0].lastStatus = 'RUNNING',
    t => t.containers[0].imageDigest += '0', t => t.containers[0].name = 'Other', t => t.containers.push(t.containers[0]),
    t => t.overrides.cpu = '1024', t => t.overrides.memory = '2048', t => t.overrides.taskRoleArn = platform.CleanupTaskRoleArn,
    t => t.overrides.containerOverrides[0].environment = [{ name: 'STAGE', value: 'prod' }],
    t => t.overrides.containerOverrides[0].command[2] = 'cleanup']) {
    const bad = structuredClone(task); mutate(bad); assert.throws(() => assertStoppedFixture(bad, env, selector, request));
  }
});

test('successful operation records actual task and committed Service proof while preserving admission/tuple', async () => {
  const f = fixture(); const record = {};
  await executeFixture({ ...f, selector, env, record });
  assert.equal(record.task_arn, taskArn); assert.equal(record.service_result.transaction_committed, true);
  assert.equal(record.launch_attempted, true);
  assert.deepEqual(record.launch_response, { task_arns: [taskArn], task_count: 1, failure_count: 0, unidentified_task_count: 0, identities_truncated: false });
  assert.deepEqual(record.task_observation, { task_arn: taskArn, cluster_arn: cluster, task_definition_arn: taskDefinitionArn,
    status: 'STOPPED', container: { name: 'OneShot', status: 'STOPPED', exit_code: 0, image_digest: selector.image.digest }, overrides: task.overrides });
  assert.equal(f.launch().input.taskDefinition, taskDefinitionArn);
  assert.deepEqual(f.launch().input.overrides, task.overrides);
  assert.equal(f.launch().input.networkConfiguration.awsvpcConfiguration.assignPublicIp, 'DISABLED');
  assert.ok(f.calls.every(args => !['register-task-definition', 'deregister-task-definition', 'stop-task', 'put-parameter', 'update-stack'].includes(args[1])));
});

test('operation record binds exact reviewed stack-source file and raw hash before credentials', () => {
  assert.deepEqual(fixtureOperationRecord(env).stack_sources, { file: env.STACK_SOURCES_FILE, sha256: env.STACK_SOURCES_SHA256 });
  for (const change of [{ STACK_SOURCES_FILE: '../map.json' }, { STACK_SOURCES_SHA256: 'invalid' }]) {
    assert.throws(() => fixtureOperationRecord({ ...env, ...change }));
  }
});

test('durable launch checkpoint precedes mutation and preserves unknown submission after interruption', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cleanup86-checkpoint-'));
  const file = path.join(directory, 'operation.json');
  try {
    const f = fixture(); const record = fixtureOperationRecord(env); let attempts = 0;
    await assert.rejects(executeFixture({ ...f, selector, env, record, checkpoint: value => persistFixtureRecord(value, file),
      runTask: async (input, roles, beforeLaunch) => {
        await beforeLaunch();
        const durable = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(durable.launch_attempted, true);
        assert.equal(durable.launch_input_sha256, sha256(canonicalJson(input)));
        assert.equal(durable.task_arn, undefined);
        attempts++;
        throw new Error('Simulated interruption after AWS submission');
      } }), /Simulated interruption/);
    assert.equal(attempts, 1);
    const durable = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(durable.launch_attempted, true); assert.equal(durable.result, 'failed');
    assert.equal(durable.task_arn, undefined);
    assert.ok(f.calls.every(args => args[1] !== 'stop-task'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed pre-mutation checkpoint prevents RunTask and no retry occurs', async () => {
  const f = fixture(); let attempts = 0;
  await assert.rejects(executeFixture({ ...f, selector, env, checkpoint: async () => { throw new Error('Storage unavailable'); },
    runTask: async (input, roles, beforeLaunch) => { await beforeLaunch(); attempts++; return { tasks: [{ taskArn }] }; } }), /Storage unavailable/);
  assert.equal(attempts, 0);
});

test('returned identities persist before rejection of partial or ambiguous launch responses', async () => {
  for (const response of [{ tasks: [{ taskArn }], failures: [{ reason: 'partial' }] },
    { tasks: [{ taskArn }, {}] }, { tasks: [{ taskArn }, { taskArn: taskArn.replace(/c{32}$/, 'd'.repeat(32)) }] },
    { tasks: [{}] }, {}]) {
    const f = fixture(); const snapshots = []; let attempts = 0;
    await assert.rejects(executeFixture({ ...f, selector, env, record: fixtureOperationRecord(env), checkpoint: async value => snapshots.push(structuredClone(value)),
      runTask: async (input, roles, beforeLaunch) => { await beforeLaunch(); attempts++; return response; } }), /Unique fixture launch/);
    assert.equal(attempts, 1);
    const durable = snapshots.at(-1);
    assert.equal(durable.launch_attempted, true);
    assert.deepEqual(durable.launch_response.task_arns, (response.tasks ?? []).map(task => task.taskArn).filter(arn => typeof arn === 'string'));
    if (response.tasks?.length === 1 && response.tasks[0].taskArn) assert.equal(durable.task_arn, taskArn);
    assert.equal(durable.service_result, undefined);
  }
});

test('returned unique identity survives interrupted tracking and observation persists before log proof', async () => {
  const f = fixture({ 'describe-tasks': () => { throw new Error('Tracking interrupted'); } }); const snapshots = [];
  await assert.rejects(executeFixture({ ...f, selector, env, checkpoint: async value => snapshots.push(structuredClone(value)) }), /Tracking interrupted/);
  assert.equal(snapshots.at(-1).task_arn, taskArn);
  const failedLogs = fixture({ 'get-log-events': () => { throw new Error('Log unavailable'); } }); const observed = [];
  await assert.rejects(executeFixture({ ...failedLogs, selector, env, checkpoint: async value => observed.push(structuredClone(value)) }), /Log unavailable/);
  assert.equal(observed.at(-1).task_observation.status, 'STOPPED');
  assert.equal(observed.at(-1).task_observation.container.exit_code, 0);
  assert.equal(observed.at(-1).service_result, undefined);
});

test('real admission parser adapter issues only the exact SSM action and identities allowed by the read session', async () => {
  const f = fixture();
  const policy = JSON.parse(fixtureSessionPolicy('read', env));
  const grant = policy.Statement.find(statement => statement.Action === 'ssm:GetParameters');
  const aws = f.io.aws;
  f.io.aws = async args => {
    if (args[0] === 'ssm') {
      assert.equal(args[1], 'get-parameters');
      assert.equal(args[2], '--names');
      assert.equal(args.length, 4);
      assert.ok(grant.Resource.includes(`arn:aws:ssm:ap-east-1:650880818323:parameter${args[3]}`));
    }
    return aws(args);
  };
  const state = await readFixtureState(f.io, selector, env, stateMachineVersionArn);
  assert.deepEqual(state.admission, { admission_suspended: true, intake_open: false, tester_emails: [] });
  assert.deepEqual(f.calls.filter(args => args[0] === 'ssm').map(args => args[3]).sort(),
    ['/anywear/beta/admission_suspended', '/anywear/beta/intake_open', '/anywear/beta/tester_allowlist']);
});

test('inactive, mixed, drifted, paginated or active fixture states reject before launching', async () => {
  for (const change of [f => f.stacks[0].Outputs[0].OutputValue = 'false', f => f.stacks[1].Outputs[0].OutputValue = 'false',
    f => f.stacks[0].StackStatus = 'UPDATE_IN_PROGRESS', f => f.stacks[1].Parameters[0].ParameterValue = '0'.repeat(40)]) {
    const f = fixture(); change(f);
    await assert.rejects(executeFixture({ ...f, selector, env })); assert.equal(f.launch(), undefined);
  }
  for (const overrides of [{ 'list-tasks': () => ({ taskArns: [], nextToken: 'more' }) },
    { 'list-tasks': () => ({ taskArns: [taskArn] }), 'describe-tasks': () => ({ tasks: [{ ...task, lastStatus: 'RUNNING' }] }) },
    { 'get-parameters': args => ({ Parameters: [{ Name: args[3], Value: 'false' }] }) }]) {
    const f = fixture(overrides); await assert.rejects(executeFixture({ ...f, selector, env })); assert.equal(f.launch(), undefined);
  }
  const f = fixture();
  await assert.rejects(executeFixture({ ...f, selector, env, guard: async () => { f.stacks[0].LastUpdatedTime = 'changed'; } }));
  assert.equal(f.launch(), undefined);
});

test('result requires one complete matching committed marker across bounded stable log scans', async () => {
  for (const messages of [[], [`${fixtureMarker}{`], [JSON.stringify(result)],
    [`${fixtureMarker}${JSON.stringify(result)}`, `${fixtureMarker}${JSON.stringify(result)}`],
    [`prefix ${fixtureMarker}${JSON.stringify(result)}`]]) {
    const f = fixture({ 'get-log-events': args => ({ events: args.includes('--next-token') ? [] : messages.map(message => ({ message })), nextForwardToken: 'end' }) });
    await assert.rejects(readFixtureResult(f.io, task, selector, env));
  }
  for (const mutate of [r => r.transaction_committed = false, r => r.request_sha256 = '0'.repeat(64), r => r.service_commit_sha = '0'.repeat(40),
    r => r.after[1].user_id = request.users[0].user_id, r => r.queue_calls = 1, r => r.action = 'cleanup']) {
    const bad = structuredClone(result); mutate(bad);
    const f = fixture({ 'get-log-events': args => ({ events: args.includes('--next-token') ? [] : [{ message: `${fixtureMarker}${JSON.stringify(bad)}` }], nextForwardToken: 'end' }) });
    await assert.rejects(readFixtureResult(f.io, task, selector, env));
  }
  let reads = 0;
  const changing = fixture({ 'get-log-events': args => ({ events: args.includes('--next-token') ? [] : [{ message: `${fixtureMarker}${JSON.stringify({ ...result, sequence: ++reads === 1 ? 1 : 2 })}` }], nextForwardToken: 'end' }) });
  await assert.rejects(readFixtureResult(changing.io, task, selector, env), /changed/);
});

test('dedicated workflow keeps its own default-closed gate, queue, executor and read-only artifact access', async () => {
  const workflow = await readFile(new URL('../.github/workflows/beta-cleanup-acceptance.yml', import.meta.url), 'utf8');
  assert.match(workflow, /ENABLE_BETA_CLEANUP_ACCEPTANCE == 'true'/);
  assert.ok(workflow.indexOf('Canonicalize validated bootstrap origin') < workflow.indexOf('--preflight'));
  assert.match(workflow, /group: anywear-infra-runtime\s+cancel-in-progress: false/);
  assert.match(workflow, /environment: beta/);
  assert.match(workflow, /permission-actions: read/);
  assert.doesNotMatch(workflow, /ENABLE_BETA_DEPLOY|permission-actions: write|configure-aws-credentials|runtime-operation\.mjs|check-operation\.mjs/);
  assert.ok(workflow.indexOf('--preflight') < workflow.indexOf('Create read-only private artifact token'));
  assert.equal((workflow.match(/node scripts\/cleanup-acceptance\.mjs\n/g) ?? []).length, 1);
});
