import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOperationInputs, cdkDeploymentArguments, deleteOperationStack } from './runtime-operation.mjs';
import { createOperationRecord } from './operation-record.mjs';
import { runtimeStack } from './one-writer.mjs';

const egressStack = 'AnyWearEgressStack-beta';
const allocationId = 'eipalloc-0a5198fb91b876949';
const env = {
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
  GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
  INFRA_OPERATION: 'deploy-egress', INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true',
};
const stackAbsence = stackName => Object.assign(new Error(`aws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stackName} does not exist`), {
  stderr: `aws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stackName} does not exist`,
});

test('the Egress EIP allocation is accepted only for deploy-egress and must be an eipalloc id', () => {
  const inputs = validateOperationInputs({ ...env, NAT_EIP_ALLOCATION_ID: allocationId });
  assert.equal(inputs.nat_eip_allocation_id, allocationId);
  // Empty means absence, as the workflow input's default.
  assert.equal(Object.hasOwn(validateOperationInputs({ ...env, NAT_EIP_ALLOCATION_ID: '' }), 'nat_eip_allocation_id'), false);
  assert.throws(() => validateOperationInputs({ ...env, INFRA_OPERATION: 'delete-egress', NAT_EIP_ALLOCATION_ID: allocationId }),
    /belongs only to deploy-egress/);
  for (const value of ['eipalloc-XYZ', 'eipalloc-', 'eip-0a5198fb91b876949', 'eipalloc-0a5198fb91b876949 ']) {
    assert.throws(() => validateOperationInputs({ ...env, NAT_EIP_ALLOCATION_ID: value }),
      /must be an Elastic IP allocation id/, value);
  }
});

test('the Egress deploy passes the retained allocation as CDK context and the record carries it', () => {
  const args = cdkDeploymentArguments(egressStack, '/tmp/artifacts', env, { natEipAllocationId: allocationId });
  assert.ok(args.includes('natEipAllocationId=eipalloc-0a5198fb91b876949'));
  assert.ok(args.includes('-c'));
  assert.equal(cdkDeploymentArguments(egressStack, '/tmp/artifacts', env).some(arg => arg.startsWith('natEipAllocationId=')), false);
  const record = createOperationRecord({ env: { ...env, NAT_EIP_ALLOCATION_ID: allocationId } });
  assert.equal(record.context.nat_eip_allocation_id, allocationId);
  assert.equal(Object.hasOwn(createOperationRecord({ env }).context, 'nat_eip_allocation_id'), false);
});

test('delete-egress records the retained EIP allocation before destroying the stack', async () => {
  const record = { events: [] };
  const destroyed = [];
  const io = {
    async aws(args) {
      const name = args[args.indexOf('--stack-name') + 1];
      if (name === runtimeStack) throw stackAbsence(name);
      if (name === egressStack) {
        return { Stacks: [{ StackName: egressStack, StackStatus: 'UPDATE_COMPLETE',
          Outputs: [{ OutputKey: 'EgressNatEipAllocationId', OutputValue: allocationId }] }] };
      }
      throw new Error(`Unexpected stack ${name}`);
    },
    async destroy(stack) { destroyed.push(stack); },
  };
  assert.equal(await deleteOperationStack(io, 'delete-egress', record), egressStack);
  assert.deepEqual(record.events, [{ type: 'egress-nat-eip', action: 'delete', stack_name: egressStack, allocation_id: allocationId }]);
  assert.deepEqual(destroyed, [egressStack]);
});
