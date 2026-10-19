import test from 'node:test';
import assert from 'node:assert/strict';
import { runRestoreRelease } from './restore-release.mjs';
import { canonicalJson } from './json-contract.mjs';
import { runtimeStack } from './one-writer.mjs';

const infraSha = '5'.repeat(40);
const env = { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: infraSha,
  GITHUB_RUN_ID: '31', GITHUB_RUN_ATTEMPT: '2', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true' };
const platformOutputs = () => Object.fromEntries(['EcsClusterName', 'PrivateSubnetIds', 'OneShotSecurityGroupId', 'VerificationTaskRoleArn',
  'OneShotExecutionRoleArn', 'OneShotLogGroupName', 'DatabaseSecretArn', 'DatabaseHost', 'DatabasePort', 'DatabaseName',
  'WardrobeBucketName', 'VtoQueueUrl', 'AutoTaggingQueueUrl', 'ServiceRepositoryUri', 'ServiceRepositoryName',
  'ApiDistributionId', 'ApiDistributionDomainName', 'ApiBaseUrl']
  .map(key => [key, key === 'EcsClusterName' ? 'beta-anywear'
    : key === 'ApiDistributionId' ? 'E2ABCDEFGHIJKL'
      : key === 'ApiDistributionDomainName' ? 'd111111abcdef8.cloudfront.net'
      : key === 'ApiBaseUrl' ? 'https://d111111abcdef8.cloudfront.net' : `${key}-value`]));
const entries = outputs => Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));
function stackAbsenceError(stackName) {
  const stderr = `An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stackName} does not exist`;
  return Object.assign(new Error(stderr), { stderr });
}

// The Base stack is the only stack a restore deploys. The Runtime slice is
// AnyWear-Service's; it must exist and stay terminal, but is never deployed.
function mockIo(options = {}) {
  const calls = []; const stages = []; const states = []; let recovered; let deployCount = 0;
  let platform = { StackName: 'AnyWearPlatformStack-beta',
    StackStatus: options.platformStatus ?? 'UPDATE_COMPLETE', Outputs: entries(options.platform ?? platformOutputs()) };
  let runtime = options.runtimeStatus === null ? undefined
    : { StackName: runtimeStack, StackStatus: options.runtimeStatus ?? 'UPDATE_COMPLETE' };
  return { calls, stages, states, get recovered() { return recovered; }, get deployCount() { return deployCount; },
    async aws(args) {
      calls.push([...args]);
      if (args[0] === 'cloudformation') {
        const name = args.at(-1);
        if (name === runtimeStack) {
          if (!runtime) throw stackAbsenceError(name);
          return { Stacks: [runtime] };
        }
        return { Stacks: [platform] };
      }
      if (args[0] === 'cloudfront') {
        assert.equal(args[1], 'get-distribution');
        return { Distribution: { Id: options.distributionId ?? 'E2ABCDEFGHIJKL',
          DomainName: 'd111111abcdef8.cloudfront.net', Status: options.distributionStatus ?? 'Deployed' } };
      }
      if (args[0] === 'ssm') {
        const name = args.at(-1);
        if (name.endsWith('tester_allowlist')) return { Parameter: { Name: name, Value: '[]' } };
        return { Parameter: { Name: name, Value: canonicalJson(options.mirror ?? { mode: 'closed' }) } };
      }
      throw new Error(`Unexpected AWS call ${args.join(' ')}`);
    },
    async deploy(stack) {
      calls.push(['deploy', stack]); deployCount++;
      assert.equal(stack, 'AnyWearPlatformStack-beta', 'only the Base stack is deployed');
      if (options.deployError) throw options.deployError;
      platform = { StackName: 'AnyWearPlatformStack-beta', StackStatus: 'UPDATE_COMPLETE',
        Outputs: entries(options.afterPlatform?.() ?? options.platform ?? platformOutputs()) };
      runtime = options.afterRuntimeStatus === null ? undefined
        : { StackName: runtimeStack, StackStatus: options.afterRuntimeStatus ?? 'UPDATE_COMPLETE' };
    },
    recordRestoreStage(event) { stages.push(event); },
    recordRestoreState(observed) { states.push(observed); },
    recordRecovery(outcome) { recovered = outcome; } };
}

test('restore deploys only the Base stack and leaves the Runtime slice untouched', async () => {
  const io = mockIo();
  const result = await runRestoreRelease({ io, infraSha, env });
  assert.equal(io.deployCount, 1);
  assert.deepEqual(io.calls.filter(call => call[0] === 'deploy'), [['deploy', 'AnyWearPlatformStack-beta']]);
  assert.ok(!io.calls.some(call => call[0] === 'oneShot'), 'no Runtime task runs from a Base restore');
  assert.equal(result.restored_stack, 'AnyWearPlatformStack-beta');
  assert.equal(result.admission.admission_mode, 'closed');
  assert.ok(io.stages.filter(stage => stage.result === 'succeeded').length >= 3);
  assert.equal(io.recovered, undefined);
});

test('restore requires the Runtime stack to exist: the operator starts first', async () => {
  const io = mockIo({ runtimeStatus: null });
  await assert.rejects(runRestoreRelease({ io, infraSha, env }), error => {
    assert.match(error.cause?.message ?? error.message, /requires AnyWearRuntimeStack-beta; start Beta first/); return true;
  });
  assert.equal(io.deployCount, 0);
  assert.equal(io.states.length, 1);
});

test('restore does not treat a non-absence Runtime read failure as "start first"', async () => {
  const io = mockIo();
  io.aws = async () => {
    throw Object.assign(new Error('An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded'),
      { stderr: 'An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded' });
  };
  await assert.rejects(runRestoreRelease({ io, infraSha, env }), error => {
    assert.match(error.cause?.message ?? error.message, /Throttling/);
    return true;
  });
  assert.equal(io.deployCount, 0);
  assert.equal(io.recovered, 'requires-explicit-recovery');
});

test('restore refuses a non-terminal Runtime before deploying the Base stack', async () => {
  for (const runtimeStatus of ['UPDATE_IN_PROGRESS', 'UPDATE_ROLLBACK_FAILED', 'CREATE_IN_PROGRESS']) {
    const io = mockIo({ runtimeStatus });
    await assert.rejects(runRestoreRelease({ io, infraSha, env }), error => {
      assert.match(error.cause?.message ?? error.message, /terminal AnyWearRuntimeStack-beta/); return true;
    });
    assert.equal(io.deployCount, 0);
    assert.equal(io.states.length, 1);
  }
});

test('restore refuses a non-terminal Base, an open admission or a non-beta cluster before any deploy', async () => {
  const cause = pattern => error => { assert.match(error.cause?.message ?? error.message, pattern); return true; };
  await assert.rejects(runRestoreRelease({ io: mockIo({ platformStatus: 'UPDATE_IN_PROGRESS' }), infraSha, env }), cause(/stable AnyWearPlatformStack-beta/));
  await assert.rejects(runRestoreRelease({ io: mockIo({ mirror: { mode: 'testers' } }), infraSha, env }),
    cause(/not proven closed/));
  const otherCluster = { ...platformOutputs(), EcsClusterName: 'other' };
  await assert.rejects(runRestoreRelease({ io: mockIo({ platform: otherCluster }), infraSha, env }), cause(/restricted to beta-anywear/));
});

test('restore fails closed when a consumed interface output changes or disappears after deploy', async () => {
  const changed = mockIo({ afterPlatform: () => ({ ...platformOutputs(), DatabaseHost: 'changed' }) });
  await assert.rejects(runRestoreRelease({ io: changed, infraSha, env }), error => {
    assert.match(error.message, /Beta Base restore failed at platform-readback/); assert.match(error.cause.message, /interface output DatabaseHost changed/); return true;
  });
  const missing = mockIo({ afterPlatform: () => { const outputs = platformOutputs(); delete outputs.VtoQueueUrl; return outputs; } });
  await assert.rejects(runRestoreRelease({ io: missing, infraSha, env }), error => {
    assert.match(error.message, /Beta Base restore failed at platform-readback/); assert.match(error.cause.message, /interface output VtoQueueUrl missing/); return true;
  });
  // The adopted API distribution domain is part of the Base interface: a restore
  // that changed it would move the public endpoint.
  const distribution = mockIo({ afterPlatform: () => ({ ...platformOutputs(), ApiDistributionDomainName: 'other.cloudfront.net' }) });
  await assert.rejects(runRestoreRelease({ io: distribution, infraSha, env }), error => {
    assert.match(error.cause.message, /interface output ApiDistributionDomainName changed/); return true;
  });
  assert.equal(changed.recovered, 'requires-explicit-recovery');
  assert.equal(missing.recovered, 'requires-explicit-recovery');
  assert.equal(distribution.recovered, 'requires-explicit-recovery');
  assert.equal(changed.states.length, 1);
  assert.match(changed.states[0].base_status, /UPDATE_COMPLETE/);
});

test('restore requires the adopted API distribution to report Deployed', async () => {
  for (const options of [{ distributionStatus: 'InProgress' }, { distributionId: 'E2OTHER' }]) {
    const io = mockIo(options);
    await assert.rejects(runRestoreRelease({ io, infraSha, env }), error => {
      assert.match(error.message, /Beta Base restore failed at platform-readback/);
      assert.match(error.cause.message, /to be Deployed with its recorded domain/);
      return true;
    });
    assert.equal(io.recovered, 'requires-explicit-recovery');
  }
});

test('restore never resumes admission or deploys a sibling stack when a deploy fails', async () => {
  const io = mockIo({ deployError: new Error('CloudFormation failed') });
  await assert.rejects(runRestoreRelease({ io, infraSha, env }), /Beta Base restore failed at platform-deploy/);
  assert.equal(io.deployCount, 1);
  assert.equal(io.recovered, 'requires-explicit-recovery');
  assert.ok(!io.calls.some(call => call[0] === 'oneShot'));
  assert.equal(io.states[0].failure_stage, 'platform-deploy');
});

test('restore rejects an unreviewed source, workflow or identity context before any AWS read', async () => {
  const io = mockIo();
  await assert.rejects(runRestoreRelease({ io, infraSha: '6'.repeat(40), env }), /Protected executor/);
  await assert.rejects(runRestoreRelease({ io, infraSha, env: { ...env, GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main' } }), /Restore requires the reviewed Infra executor source/);
  await assert.rejects(runRestoreRelease({ io, infraSha, env: { ...env, INFRA_IDENTITY_PHASE: 'legacy' } }), /retired identity/);
  assert.equal(io.calls.length, 0);
});
