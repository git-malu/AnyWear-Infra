import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOperationInputs, cdkDeploymentArguments, deleteOperationStack, resolveServiceImageDigest,
  serviceImageTag } from './runtime-operation.mjs';
import { createOperationRecord } from './operation-record.mjs';
import { runtimeStack } from './one-writer.mjs';

const egressStack = 'AnyWearEgressStack-beta';
const allocationId = 'eipalloc-0a5198fb91b876949';
const serviceCommit = 'b'.repeat(40);
const imageDigest = `sha256:${'9'.repeat(64)}`;
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

// #193: a release operation records the deployed image digest, resolved from the
// immutable ECR tag Service's release chain pushes for one Service commit.
test('a release operation resolves the immutable ECR tag to its image digest', async () => {
  const tag = `service-artifacts-${serviceCommit}`;
  const calls = [];
  const io = { async aws(args) { calls.push(args); return { imageDetails: [{ imageDigest, imageTags: [tag] }] }; } };
  assert.equal(serviceImageTag(serviceCommit), tag);
  assert.equal(await resolveServiceImageDigest(io, serviceCommit), imageDigest);
  assert.deepEqual(calls, [['ecr', 'describe-images', '--repository-name', 'beta-anywear-service',
    '--image-ids', `imageTag=${tag}`]]);
  // The runtime session already permits this read; no new grant is minted.
  const record = createOperationRecord({ env: { ...env, INFRA_OPERATION: 'deploy-platform', SERVICE_RELEASE_TAG: tag,
    SERVICE_COMMIT: serviceCommit }, release: { releaseTag: tag, serviceCommit, imageDigest } });
  assert.deepEqual(record.service_release, { releaseTag: tag, serviceCommit, imageDigest });
});

test('a missing, ambiguous or malformed ECR tag fails before the deploy', async () => {
  const tag = `service-artifacts-${serviceCommit}`;
  const cases = [
    ['missing', { imageDetails: [] }, new RegExp(`ECR tag ${tag} does not resolve to exactly one image`)],
    ['absent', {}, new RegExp(`ECR tag ${tag} does not resolve to exactly one image`)],
    ['ambiguous', { imageDetails: [{ imageDigest, imageTags: [tag] },
      { imageDigest: `sha256:${'8'.repeat(64)}`, imageTags: [tag] }] }, new RegExp(`ECR tag ${tag} does not resolve`)],
    ['another tag', { imageDetails: [{ imageDigest, imageTags: ['service-artifacts-deadbeef'] }] },
      new RegExp(`ECR tag ${tag} does not name the resolved image`)],
    ['malformed digest', { imageDetails: [{ imageDigest: 'sha256:short', imageTags: [tag] }] },
      new RegExp(`Invalid ECR tag ${tag} image digest`)],
  ];
  for (const [label, response, pattern] of cases) {
    await assert.rejects(resolveServiceImageDigest({ aws: async () => response }, serviceCommit), pattern, label);
  }
});
