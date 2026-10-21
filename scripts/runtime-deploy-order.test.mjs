import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeIo } from './runtime-operation.mjs';
import { runtimeStack } from './one-writer.mjs';

const baseName = 'AnyWearPlatformStack-beta';
const workloadName = 'AnyWearWorkloadStack-beta';
const origin = 'beta-anywear-api-0123456789.ap-east-1.elb.amazonaws.com';
const env = {
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
  INFRA_OPERATION: 'deploy-platform', INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true',
  SERVICE_RELEASE_TAG: 'beta-test', SERVICE_COMMIT: 'b'.repeat(40),
};


// The pre-mutation preflight simulates the deploy and runtime roles before the
// mutation; answer its IAM simulator calls with an allowed evaluation.
function simulatorAllowed(args) {
  const actions = args.slice(args.indexOf('--action-names') + 1, args.indexOf('--resource-arns'));
  const resources = args.slice(args.indexOf('--resource-arns') + 1, args.indexOf('--context-entries'));
  const results = [];
  for (const action of actions.filter((value) => value.includes(':'))) {
    for (const resource of resources.filter((value) => value.includes(':') || value === '*')) {
      results.push({ EvalActionName: action, EvalResourceName: resource, EvalDecision: 'allowed' });
    }
  }
  return { stdout: JSON.stringify({ EvaluationResults: results }) };
}

function stackAbsenceError(stackName) {
  const stderr = `aws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stackName} does not exist`;
  return Object.assign(new Error(stderr), { stderr });
}

test('a completed Base deploy is recorded before a failing log-retention step', async () => {
  const record = { events: [] };
  const run = async (command, args) => {
    if (command === 'npx') return { stdout: '', stderr: '' };
    assert.equal(command, 'aws');
    const [service, action] = args;
    if (service === 'iam' && action?.startsWith('simulate-')) return simulatorAllowed(args);
    if (service === 'cloudformation' && action === 'describe-stacks') {
      const name = args[args.indexOf('--stack-name') + 1];
      if (name === runtimeStack) throw stackAbsenceError(name);
      if (name === baseName) return { stdout: JSON.stringify({ Stacks: [{ StackName: baseName, StackStatus: 'UPDATE_COMPLETE' }] }) };
      if (name === workloadName) {
        return { stdout: JSON.stringify({ Stacks: [{ StackName: workloadName, StackStatus: 'UPDATE_COMPLETE',
          Outputs: [{ OutputKey: 'ApiLoadBalancerDnsName', OutputValue: origin }] }] }) };
      }
      throw new Error(`Unexpected stack ${name}`);
    }
    if (service === 'cloudformation' && action === 'get-template') {
      return { stdout: JSON.stringify({ TemplateBody: { Resources: {} } }) };
    }
    // Retention's account check returns a foreign account, so the post-deploy
    // retention step throws after the CDK deploy already completed.
    if (service === 'sts' && action === 'get-caller-identity') {
      return { stdout: JSON.stringify({ Account: '111111111111' }) };
    }
    throw new Error(`Unexpected AWS call ${args.join(' ')}`);
  };
  const io = await createRuntimeIo(env, record, {
    purpose: 'operation', run,
    assume: async () => ({ AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y', AWS_SESSION_TOKEN: 'z' }),
  });
  await assert.rejects(io.deploy(baseName), /Unexpected Beta log retention account/);
  assert.deepEqual(record.events, [{
    type: 'stack-deploy', stack_name: baseName, source_repository: env.GITHUB_REPOSITORY,
    source_sha: env.GITHUB_SHA, result: 'complete',
  }]);
  // The retention event is written only after retention actually succeeds.
  assert.equal(record.events.some((event) => event.type === 'beta-platform-log-retention'), false);
});

test('a completed non-Base deploy does not run retention and records its event', async () => {
  const record = { events: [] };
  const foundationEnv = { ...env, INFRA_OPERATION: 'deploy-foundation', SERVICE_RELEASE_TAG: '', SERVICE_COMMIT: '' };
  const run = async (command, args) => {
    if (command === 'npx') return { stdout: '', stderr: '' };
    if (command === 'aws' && args[0] === 'iam' && args[1]?.startsWith('simulate-')) return simulatorAllowed(args);
    throw new Error('No AWS read is required for a Foundation deploy');
  };
  const io = await createRuntimeIo(foundationEnv, record, {
    purpose: 'operation', run,
    assume: async () => ({ AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y', AWS_SESSION_TOKEN: 'z' }),
  });
  await io.deploy('AnyWearFoundationStack');
  assert.deepEqual(record.events, [{
    type: 'stack-deploy', stack_name: 'AnyWearFoundationStack', source_repository: env.GITHUB_REPOSITORY,
    source_sha: env.GITHUB_SHA, result: 'complete',
  }]);
});
