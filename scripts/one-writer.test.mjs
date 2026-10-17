import test from 'node:test';
import assert from 'node:assert/strict';
import { deployOperationStack } from './runtime-operation.mjs';
import { runRestoreRelease } from './restore-release.mjs';
import { canonicalJson } from './json-contract.mjs';

const workloadName = 'AnyWearWorkloadStack-beta';
const platformName = 'AnyWearPlatformStack-beta';

// Minimal mock of the runtime io: CloudFormation stack reads and deploys.
function deployMock({ workloadStatus, platformStatus = 'UPDATE_COMPLETE' } = {}) {
  const calls = []; const deployments = [];
  const stacks = new Map([[platformName, { StackStatus: platformStatus }]]);
  if (workloadStatus !== undefined) stacks.set(workloadName, { StackStatus: workloadStatus });
  return { calls, deployments,
    async aws(args) {
      calls.push([...args]);
      assert.equal(args[0], 'cloudformation');
      assert.equal(args[1], 'describe-stacks');
      const stack = stacks.get(args[args.indexOf('--stack-name') + 1]);
      return stack ? { Stacks: [stack] } : { Stacks: [] };
    },
    async deploy(stack) {
      calls.push(['deploy', stack]);
      deployments.push(stack);
    } };
}

const entries = outputs => Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));
const platformOutputs = () => Object.fromEntries(['EcsClusterName', 'PrivateSubnetIds', 'OneShotSecurityGroupId',
  'VerificationTaskRoleArn', 'OneShotExecutionRoleArn', 'OneShotLogGroupName', 'DatabaseSecretArn', 'DatabaseHost',
  'DatabasePort', 'DatabaseName', 'WardrobeBucketName', 'VtoQueueUrl', 'AutoTaggingQueueUrl', 'ServiceRepositoryUri',
  'ServiceRepositoryName', 'BetaActive']
  .map(key => [key, key === 'EcsClusterName' ? 'beta-anywear' : key === 'BetaActive' ? 'true' : `${key}-value`]));

// The restore driver reads the Platform interface and the closed admission mirror;
// this mock serves only what the precondition path reaches.
function restoreMock({ workloadStatus } = {}) {
  let deploys = 0;
  const stacks = new Map([
    [platformName, { StackStatus: 'UPDATE_COMPLETE', Outputs: entries(platformOutputs()) }],
    [workloadName, { StackStatus: workloadStatus ?? 'UPDATE_COMPLETE', Outputs: entries({ BetaActive: 'true' }) }],
  ]);
  return { get deploys() { return deploys; },
    async aws(args) {
      if (args[0] === 'cloudformation') return { Stacks: [stacks.get(args[args.indexOf('--stack-name') + 1])] };
      if (args[0] === 'ssm') {
        const name = args.at(-1);
        return { Parameter: { Name: name,
          Value: name.endsWith('tester_allowlist') ? '[]' : canonicalJson({ mode: 'closed' }) } };
      }
      throw new Error(`Unexpected AWS call ${args.join(' ')}`);
    },
    async deploy() { deploys++; } };
}

const infraSha = '5'.repeat(40);
const env = { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: infraSha,
  GITHUB_RUN_ID: '31', GITHUB_RUN_ATTEMPT: '2',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', INFRA_IDENTITY_PHASE: 'retired',
  INFRA_RETENTION_PROTECTION: 'true' };

test('deploy-platform reads the release slice terminal before any deploy', async () => {
  for (const workloadStatus of ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']) {
    const io = deployMock({ workloadStatus });
    assert.equal(await deployOperationStack(io, 'deploy-platform'), platformName);
    assert.deepEqual(io.deployments, [platformName]);
    assert.deepEqual(io.calls.map(call => call.slice(0, 2)), [['cloudformation', 'describe-stacks'], ['deploy', platformName]]);
    assert.ok(io.calls[0].includes(workloadName), 'the read targets the Service-owned slice');
  }
});

test('deploy-platform fails closed before any deploy when the release slice is missing or non-terminal', async () => {
  for (const workloadStatus of [undefined, 'UPDATE_IN_PROGRESS', 'CREATE_IN_PROGRESS', 'UPDATE_ROLLBACK_FAILED']) {
    const io = deployMock({ workloadStatus });
    await assert.rejects(deployOperationStack(io, 'deploy-platform'),
      new RegExp(`deploy-platform requires a terminal ${workloadName}; observed ${
        workloadStatus ?? 'unavailable'}`));
    assert.deepEqual(io.deployments, [], `no deploy for ${workloadStatus ?? 'missing'}`);
  }
});

test('only the Platform-mutating operation reads the release slice', async () => {
  for (const [operation, stack] of [['deploy-foundation', 'AnyWearFoundationStack'],
    ['deploy-billing', 'AnyWearBillingStack-beta']]) {
    const io = deployMock({ workloadStatus: 'UPDATE_IN_PROGRESS' });
    assert.equal(await deployOperationStack(io, operation), stack);
    assert.deepEqual(io.deployments, [stack]);
    assert.ok(!io.calls.some(call => call[0] === 'cloudformation'), `${operation} needs no slice read`);
  }
});

test('restore-release still fails closed on a non-terminal release slice before deploying the stage base', async () => {
  for (const workloadStatus of ['UPDATE_IN_PROGRESS', 'CREATE_IN_PROGRESS']) {
    const io = restoreMock({ workloadStatus });
    await assert.rejects(runRestoreRelease({ io, infraSha, env }), error => {
      assert.match(error.cause?.message ?? error.message, new RegExp(`terminal ${workloadName}`));
      return true;
    });
    assert.equal(io.deploys, 0);
  }
  // A terminal slice passes the same gate, so the refusal above is the status and
  // not a blanket block.
  const terminal = restoreMock({});
  await runRestoreRelease({ io: terminal, infraSha, env });
  assert.equal(terminal.deploys, 1);
});
