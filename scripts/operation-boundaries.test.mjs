import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowOperations, operationBoundary, operationEvidence, families, assertOneShotAllowed,
  assertDeployAllowed, assertAwsAllowed, sessionPolicy, assertProtectedExecutor } from './operation-boundaries.mjs';

const infraSha = '5'.repeat(40);
const env = (operation, overrides = {}) => {
  const workflow = ['state', 'observe'].includes(operation) ? 'runtime' : 'mutate';
  return { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: infraSha,
    GITHUB_RUN_ID: '11', GITHUB_RUN_ATTEMPT: '1', AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1',
    GITHUB_WORKFLOW_REF: `git-malu/AnyWear-Infra/.github/workflows/${workflow}.yml@refs/heads/main`,
    INFRA_OPERATION: operation, TESTER_EMAILS: '[]', WINDOW_MINUTES: '60', ...overrides };
};

test('the workflow map and family derivation cover every operation', () => {
  assert.deepEqual(Object.keys(workflowOperations).sort(), ['.github/workflows/mutate.yml', '.github/workflows/runtime.yml']);
  assert.deepEqual(workflowOperations['.github/workflows/runtime.yml'], ['state', 'observe']);
  assert.ok(!workflowOperations['.github/workflows/mutate.yml'].includes('deploy-workload'));
  for (const operation of Object.values(workflowOperations).flat()) {
    const boundary = operationBoundary(env(operation));
    assert.ok(boundary.family, `family required for ${operation}`);
    assert.equal(boundary.readOnly, operation === 'state');
    assert.ok(operationEvidence[operation], `evidence entry required for ${operation}`);
  }
  assert.throws(() => operationBoundary(env('deploy-workload')), /forbidden for this workflow family/);
  assert.throws(() => operationBoundary(env('state', { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main' })));
});

test('one-shot roles are exactly the release-slice drivers that remain', () => {
  assert.deepEqual(operationEvidence.observe.roles, []);
  assert.deepEqual(operationEvidence['deploy-platform'].roles, []);
  assert.deepEqual(operationEvidence['restore-release'].roles, []);
  assert.deepEqual(operationEvidence.migrate.roles, ['migrate']);
  assert.deepEqual(operationEvidence['suspend-admission'].roles, ['lifecycle']);
  assert.deepEqual(operationEvidence['resume-admission'].roles, ['lifecycle']);
  assert.deepEqual(families(env('observe'), 'qualification'), []);
  assert.deepEqual(families(env('migrate'), 'operation'), ['migrate']);
  assert.deepEqual(families(env('state'), 'operation'), []);
  assert.throws(() => families(env('state'), 'qualification'), /Read-only observation cannot qualify/);
});

test('one-shot guards admit only the reviewed role/action pairs', () => {
  assertOneShotAllowed(env('migrate'), 'migrate');
  assertOneShotAllowed(env('suspend-admission'), 'lifecycle', 'status');
  assertOneShotAllowed(env('suspend-admission'), 'lifecycle', 'suspend');
  assert.throws(() => assertOneShotAllowed(env('deploy-platform'), 'lifecycle', 'status'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('migrate'), 'verify'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('migrate'), 'artifact-verify'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('migrate'), 'lifecycle', 'suspend'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('add-testers'), 'lifecycle', 'supply'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('add-testers'), 'lifecycle', 'set-testers', '["b@example.com","a@example.com"]'), /canonical/);
  assertOneShotAllowed(env('set-testers', { TESTER_EMAILS: '["e@example.com"]' }), 'lifecycle', 'set-testers', '["e@example.com"]');
  assert.throws(() => assertOneShotAllowed(env('resume-admission'), 'lifecycle', 'resume', '{"window_minutes":30}'), /differs from the dispatch input/);
  assertOneShotAllowed(env('resume-admission'), 'lifecycle', 'resume', '{"window_minutes":60}');
});

test('deploy authority is limited to the configured stack set', () => {
  assertDeployAllowed(env('deploy-platform'), 'AnyWearPlatformStack-beta');
  assertDeployAllowed(env('restore-release'), 'AnyWearPlatformStack-beta');
  assertDeployAllowed(env('deploy-foundation'), 'AnyWearFoundationStack');
  assertDeployAllowed(env('deploy-billing'), 'AnyWearBillingStack-beta');
  assert.throws(() => assertDeployAllowed(env('deploy-platform'), 'AnyWearWorkloadStack-beta'), /forbidden/);
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
  assertAwsAllowed(env('suspend-admission'), ['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify(lifecycle)]);
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

test('the protected executor gate binds repository, workflow, source, account and region', () => {
  assert.equal(assertProtectedExecutor(infraSha, env('observe')).sha, infraSha);
  for (const overrides of [{ GITHUB_SHA: '6'.repeat(40) }, { GITHUB_REF: 'refs/heads/other' }, { AWS_ACCOUNT_ID: '1' },
    { AWS_REGION: 'us-east-1' }, { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Client/.github/workflows/x.yml@refs/heads/main' }]) {
    assert.throws(() => assertProtectedExecutor(infraSha, env('observe', overrides)));
  }
});
