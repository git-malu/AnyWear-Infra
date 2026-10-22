import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowOperations, operationFamilies, operationBoundary, operationEvidence, families, assertOneShotAllowed,
  assertDeployAllowed, assertAwsAllowed, sessionPolicy, assertProtectedExecutor, reads, readOperations, operationReads } from './operation-boundaries.mjs';

const infraSha = '5'.repeat(40);
const env = (operation, overrides = {}) => {
  const workflow = ['state', 'observe'].includes(operation) ? 'runtime' : 'mutate';
  return { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: infraSha,
    GITHUB_RUN_ID: '11', GITHUB_RUN_ATTEMPT: '1', AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1',
    GITHUB_WORKFLOW_REF: `git-malu/AnyWear-Infra/.github/workflows/${workflow}.yml@refs/heads/main`,
    INFRA_OPERATION: operation, TESTER_EMAILS: '[]', ...overrides };
};

test('the workflow map and family derivation cover every operation', () => {
  assert.deepEqual(Object.keys(workflowOperations).sort(), ['.github/workflows/mutate.yml', '.github/workflows/runtime.yml']);
  assert.deepEqual(workflowOperations['.github/workflows/runtime.yml'], ['state', 'observe']);
  assert.deepEqual(workflowOperations['.github/workflows/mutate.yml'], ['deploy-foundation', 'deploy-billing', 'deploy-platform',
    'deploy-egress', 'delete-egress', 'deploy-runtime', 'stop-runtime', 'restore-release', 'migrate',
    'admission-status', 'add-testers', 'set-testers', 'open-admission', 'close-admission']);
  assert.ok(!workflowOperations['.github/workflows/mutate.yml'].includes('deploy-workload'));
  for (const operation of Object.values(workflowOperations).flat()) {
    const boundary = operationBoundary(env(operation));
    assert.ok(boundary.family, `family required for ${operation}`);
    assert.equal(boundary.readOnly, operation === 'state');
    assert.ok(operationEvidence[operation], `evidence entry required for ${operation}`);
  }
  for (const operation of ['open-admission', 'close-admission']) assert.equal(operationFamilies[operation], 'beta-admission');
  // Issue #166 adds the disposable Egress operations to the same deploy family.
  for (const operation of ['deploy-egress', 'delete-egress']) assert.equal(operationFamilies[operation], 'beta-deploy');
  assert.throws(() => operationBoundary(env('deploy-workload')), /forbidden for this workflow family/);
  assert.throws(() => operationBoundary(env('suspend-admission')), /forbidden for this workflow family/);
  assert.throws(() => operationBoundary(env('resume-admission')), /forbidden for this workflow family/);
  assert.throws(() => operationBoundary(env('state', { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main' })));
});

test('one-shot roles are exactly the release-slice drivers that remain', () => {
  assert.deepEqual(operationEvidence.observe.roles, []);
  assert.deepEqual(operationEvidence['deploy-platform'].roles, []);
  assert.deepEqual(operationEvidence['restore-release'].roles, []);
  assert.deepEqual(operationEvidence.migrate.roles, ['migrate']);
  assert.deepEqual(operationEvidence['close-admission'].roles, ['lifecycle']);
  assert.deepEqual(operationEvidence['open-admission'].roles, ['lifecycle']);
  assert.deepEqual(families(env('observe'), 'qualification'), []);
  assert.deepEqual(families(env('migrate'), 'operation'), ['migrate']);
  assert.deepEqual(families(env('state'), 'operation'), []);
  assert.throws(() => families(env('state'), 'qualification'), /Read-only observation cannot qualify/);
});

test('one-shot guards admit only the reviewed role/action pairs', () => {
  assertOneShotAllowed(env('migrate'), 'migrate');
  assertOneShotAllowed(env('close-admission'), 'lifecycle', 'status');
  assertOneShotAllowed(env('close-admission'), 'lifecycle', 'suspend');
  assertOneShotAllowed(env('open-admission'), 'lifecycle', 'status');
  assertOneShotAllowed(env('open-admission'), 'lifecycle', 'resume');
  assertOneShotAllowed(env('open-admission'), 'lifecycle', 'suspend');
  assert.throws(() => assertOneShotAllowed(env('deploy-platform'), 'lifecycle', 'status'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('migrate'), 'verify'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('migrate'), 'artifact-verify'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('migrate'), 'lifecycle', 'suspend'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('add-testers'), 'lifecycle', 'supply'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('add-testers'), 'lifecycle', 'set-testers', '["b@example.com","a@example.com"]'), /canonical/);
  assertOneShotAllowed(env('set-testers', { TESTER_EMAILS: '["e@example.com"]' }), 'lifecycle', 'set-testers', '["e@example.com"]');
  // Lifecycle `resume` is payload-free: any payload at all is refused, and the
  // operation itself carries no window input.
  assert.throws(() => assertOneShotAllowed(env('open-admission'), 'lifecycle', 'resume', '{"window_minutes":60}'), /takes no payload/);
  assert.throws(() => assertOneShotAllowed(env('open-admission'), 'lifecycle', 'resume', '[]'), /takes no payload/);
  assert.throws(() => assertOneShotAllowed(env('open-admission'), 'lifecycle', 'set-testers', '[]'), /forbidden/);
});

test('deploy authority is limited to the configured stack set', () => {
  assertDeployAllowed(env('deploy-platform'), 'AnyWearPlatformStack-beta');
  assertDeployAllowed(env('restore-release'), 'AnyWearPlatformStack-beta');
  assertDeployAllowed(env('deploy-foundation'), 'AnyWearFoundationStack');
  assertDeployAllowed(env('deploy-billing'), 'AnyWearBillingStack-beta');
  assertDeployAllowed(env('deploy-egress'), 'AnyWearEgressStack-beta');
  assertDeployAllowed(env('delete-egress'), 'AnyWearEgressStack-beta');
  assert.throws(() => assertDeployAllowed(env('deploy-platform'), 'AnyWearEgressStack-beta'), /forbidden/);
  assert.throws(() => assertDeployAllowed(env('deploy-platform'), 'AnyWearWorkloadStack-beta'), /forbidden/);
  assert.throws(() => assertDeployAllowed(env('deploy-platform'), 'AnyWearRuntimeStack-beta'), /forbidden/);
  assert.throws(() => assertDeployAllowed(env('observe'), 'AnyWearPlatformStack-beta'), /forbidden/);
});

test('AWS allow-list keeps reads, one-shots and retention updates scoped', () => {
  assertAwsAllowed(env('migrate'), ['cloudformation', 'describe-stacks']);
  assertAwsAllowed(env('observe'), ['ssm', 'get-parameters']);
  assert.throws(() => assertAwsAllowed(env('state'), ['ssm', 'get-parameters']), /forbidden/);
  assert.throws(() => assertAwsAllowed(env('migrate'), ['ssm', 'get-parameter', '--name', '/x', '--with-decryption']), /decryption is forbidden/);
  assert.throws(() => assertAwsAllowed(env('deploy-platform'), ['ecs', 'run-task']), /forbidden/);
  const lifecycle = { family: 'beta-anywear-lifecycle', taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-lifecycle-task',
    executionRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution',
    containerDefinitions: [{ name: 'OneShot', command: ['node', 'dist/ops/beta-lifecycle.js', 'status'] }] };
  assertAwsAllowed(env('close-admission'), ['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify(lifecycle)]);
  assert.throws(() => assertAwsAllowed(env('deploy-platform'), ['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify(lifecycle)]), /forbidden/);
  assertAwsAllowed(env('deploy-platform'), ['logs', 'put-retention-policy']);
  assert.throws(() => assertAwsAllowed(env('migrate'), ['logs', 'put-retention-policy']), /forbidden/);
});

test('session policies carry only the operation\'s own families', () => {
  const deploy = sessionPolicy('deploy', env('deploy-platform'));
  assert.match(deploy, /cdk-hnb659fds-deploy-role-650880818323-ap-east-1/);
  assert.throws(() => sessionPolicy('deploy', env('observe')), /Deploy credentials are forbidden/);
  const migration = sessionPolicy('runtime', env('migrate'));
  assert.match(migration, /beta-anywear-migrate/);
  assert.doesNotMatch(migration, /beta-anywear-lifecycle/);
  const state = sessionPolicy('runtime', env('state'));
  assert.match(state, /ssm:GetParameter/);
  assert.doesNotMatch(state, /ecs:RegisterTaskDefinition/);
  assert.doesNotMatch(sessionPolicy('runtime', env('deploy-platform')), /ecs:RegisterTaskDefinition/);
});

// Issue #195: the bake runs only inside `deploy-runtime`, and its two new grants
// are installed by a Platform deploy. The read table, the session policy and the
// call allow-list are scoped together so no other operation requires them and
// `deploy-runtime` still does.
test('the runtime read set is scoped to the operation that performs the read', () => {
  const bakeReads = ['cloudwatch/get-metric-statistics', 'cloudwatch/describe-alarms', 'logs/filter-log-events'];
  assert.deepEqual(Object.keys(readOperations).sort(), [...bakeReads].sort());
  for (const pair of bakeReads) {
    assert.ok(pair in reads, `${pair} stays in the reviewed reads table`);
    assert.deepEqual(readOperations[pair], ['deploy-runtime']);
    assert.equal(operationReads(env('deploy-platform')).includes(pair), false, `${pair} is not a Platform-deploy read`);
    assert.equal(operationReads(env('deploy-runtime')).includes(pair), true, `${pair} is a deploy-runtime read`);
  }
  // The universal reads remain in every operation's set.
  for (const pair of ['cloudformation/describe-stacks', 'ssm/get-parameters', 'logs/describe-log-groups']) {
    assert.equal(operationReads(env('migrate')).includes(pair), true, `${pair} is universal`);
  }
  assert.throws(() => assertAwsAllowed(env('deploy-platform'), ['cloudwatch', 'describe-alarms']), /forbidden/);
  assert.throws(() => assertAwsAllowed(env('migrate'), ['logs', 'filter-log-events']), /forbidden/);
  assertAwsAllowed(env('deploy-runtime'), ['cloudwatch', 'describe-alarms']);
  assertAwsAllowed(env('deploy-runtime'), ['logs', 'filter-log-events']);
  const platform = sessionPolicy('runtime', env('deploy-platform'));
  assert.doesNotMatch(platform, /cloudwatch:DescribeAlarms|logs:FilterLogEvents|cloudwatch:GetMetricStatistics/);
  const runtime = sessionPolicy('runtime', env('deploy-runtime'));
  assert.match(runtime, /cloudwatch:DescribeAlarms/);
  assert.match(runtime, /logs:FilterLogEvents/);
  // The read-only state session keeps its own narrower set and never gains a bake read.
  const state = sessionPolicy('runtime', env('state'));
  assert.doesNotMatch(state, /cloudwatch|logs:FilterLogEvents/);
});

test('the protected executor gate binds repository, workflow, source, account and region', () => {
  assert.equal(assertProtectedExecutor(infraSha, env('observe')).sha, infraSha);
  for (const overrides of [{ GITHUB_SHA: '6'.repeat(40) }, { GITHUB_SHA: 'short' }, { GITHUB_REF: 'refs/heads/other' },
    { AWS_ACCOUNT_ID: '1' }, { AWS_REGION: 'us-east-1' },
    { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Client/.github/workflows/x.yml@refs/heads/main' }]) {
    assert.throws(() => assertProtectedExecutor(infraSha, env('observe', overrides)));
  }
  // AnyWear-E2E executes from its own pinned checkout and states the observed
  // Infra revision explicitly. Its run SHA is the executor identity, so it must
  // not be forced to equal the Infra helper SHA.
  const e2e = (overrides = {}) => env('observe', { GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_SHA: '6'.repeat(40),
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main', ...overrides });
  const executor = assertProtectedExecutor(infraSha, e2e());
  assert.equal(executor.repository, 'git-malu/AnyWear-E2E');
  assert.equal(executor.sha, infraSha);
  assert.equal(executor.workflow_path, '.github/workflows/beta-qualification.yml');
  assert.throws(() => assertProtectedExecutor(infraSha, e2e({ GITHUB_WORKFLOW_REF:
    'git-malu/AnyWear-E2E/.github/workflows/other.yml@refs/heads/main' })), /workflow required/);
  assert.throws(() => assertProtectedExecutor(infraSha, e2e({ GITHUB_REF: 'refs/heads/feature' })), /Protected executor/);
  assert.throws(() => assertProtectedExecutor(infraSha, e2e({ GITHUB_SHA: '7'.repeat(39) })), /Protected executor/);
});
