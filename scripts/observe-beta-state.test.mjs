import test from 'node:test';
import assert from 'node:assert/strict';
import { observeBetaState } from './observe-beta-state.mjs';
import { runtimeStack } from './one-writer.mjs';
import { canonicalJson } from './json-contract.mjs';

const baseName = 'AnyWearPlatformStack-beta';

function stackAbsenceError(stackName) {
  const stderr = `aws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stackName} does not exist`;
  return Object.assign(new Error(stderr), { stderr });
}

// The read-only state operation must observe the stopped state without failing:
// Base is present and the Infra-owned Runtime stack is simply absent.
function stateIo({ runtime = undefined, runtimeError } = {}) {
  return {
    async aws(args) {
      if (args[0] === 'cloudformation' && args[1] === 'describe-stacks') {
        const name = args[args.length - 1];
        if (name === baseName) return { Stacks: [{ StackName: baseName, StackStatus: 'UPDATE_COMPLETE' }] };
        if (name === runtimeStack) {
          if (runtimeError) throw runtimeError;
          if (!runtime) throw stackAbsenceError(name);
          return { Stacks: [runtime] };
        }
        throw new Error(`Unexpected stack ${name}`);
      }
      if (args[0] === 'ssm' && args[1] === 'get-parameter') {
        const name = args[args.length - 1];
        if (name.endsWith('tester_allowlist')) return { Parameter: { Name: name, Value: '[]' } };
        return { Parameter: { Name: name, Value: canonicalJson({ mode: 'closed' }) } };
      }
      throw new Error(`Unexpected AWS call ${args.join(' ')}`);
    },
  };
}

test('read-only state observes the stopped state: Base present, Runtime absent, no throw', async () => {
  const state = await observeBetaState(stateIo());
  assert.deepEqual(state.stacks, [
    { stack_name: baseName, status: 'UPDATE_COMPLETE' },
    { stack_name: runtimeStack, status: 'ABSENT', runtime_exists: false },
  ]);
  assert.equal(state.admission.admission_mode, 'closed');
  assert.equal(state.qualification, 'not-applicable');
  assert.equal(Object.hasOwn(state, 'beta_sizing'), false);
});

test('read-only state records a running Runtime and its sizing parameters', async () => {
  const runtime = {
    StackName: runtimeStack, StackStatus: 'UPDATE_COMPLETE',
    Parameters: [
      { ParameterKey: 'ServiceImageDigest', ParameterValue: `sha256:${'a'.repeat(64)}` },
      { ParameterKey: 'ServiceCommitSha', ParameterValue: 'b'.repeat(40) },
      { ParameterKey: 'VlmConfigArn', ParameterValue: 'arn:aws:ssm:ap-east-1:650880818323:parameter/beta-vlm' },
      { ParameterKey: 'CloudFrontPrefixListId', ParameterValue: 'pl-1234' },
      { ParameterKey: 'BetaApiSizingProfile', ParameterValue: 's1' },
      { ParameterKey: 'BetaSizingTelemetry', ParameterValue: 'false' },
    ],
  };
  const state = await observeBetaState(stateIo({ runtime }));
  assert.deepEqual(state.stacks[1], { stack_name: runtimeStack, status: 'UPDATE_COMPLETE', runtime_exists: true });
  assert.deepEqual(state.beta_sizing, {
    beta_api_sizing_profile: 's1', beta_sizing_telemetry: 'false', runtime_verification: 'not-applicable',
  });
});

test('read-only state still fails on a non-absence Runtime read failure', async () => {
  const throttle = Object.assign(new Error('aws: [ERROR]: An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded'),
    { stderr: 'aws: [ERROR]: An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded' });
  await assert.rejects(observeBetaState(stateIo({ runtimeError: throttle })), /Complete Beta state observation unavailable/);
});
