import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeIo, validateOperationInputs, cdkDeploymentArguments, deleteOperationStack,
  resolveServiceImageDigest, serviceImageTag } from './runtime-operation.mjs';
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

// Issue #194: the non-throwing one-shot probe. `deploy-runtime` needs the verify
// task's container exit code as a *result* (the gate refuses `reader-failed`), so
// the probe returns it instead of turning a non-zero read into a launcher crash.
// The launch, authorization, unique identity, STOPPED, image-digest and command
// checks are the same ones `oneShot` performs and still throw.
const verifyEnv = {
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
  GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '2',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
  INFRA_OPERATION: 'deploy-runtime', INFRA_IDENTITY_PHASE: 'roles-added', INFRA_RETENTION_PROTECTION: 'true',
  SERVICE_RELEASE_TAG: `service-artifacts-${serviceCommit}`, SERVICE_COMMIT: serviceCommit,
};
const revision = { commit: serviceCommit, digest: imageDigest };
const verifyTaskArn = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'a'.repeat(32)}`;
const verifyDefinitionArn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-verify:7';
const verifyTask = (exitCode, digest = imageDigest) => ({
  taskArn: verifyTaskArn, clusterArn: 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear',
  lastStatus: 'STOPPED', taskDefinitionArn: verifyDefinitionArn,
  containers: [{ name: 'OneShot', exitCode, imageDigest: digest }],
});
const verifyDefinition = (command = ['node', 'dist/verify.js', 'schema-journal']) => ({
  family: 'beta-anywear-verify', taskDefinitionArn: verifyDefinitionArn,
  containerDefinitions: [{ name: 'OneShot', command }],
});

// The probe's launch surface: the preflight simulator answers allowed, the script
// prints the two identities, and the two ECS describes return the stopped task.
function probeIo({ exitCode = 0, scriptFailure = false, stdout, task = verifyTask(exitCode),
  definition = verifyDefinition() } = {}) {
  const calls = [];
  const assumeCalls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === 'aws' && args[0] === 'iam') {
      return { stdout: JSON.stringify({ EvaluationResults: [{ EvalActionName: 'x', EvalResourceName: '*',
        EvalDecision: 'allowed' }] }) };
    }
    if (command === 'aws' && args[0] === 'ecs' && args[1] === 'describe-tasks') {
      return { stdout: JSON.stringify({ tasks: [task] }) };
    }
    if (command === 'aws' && args[0] === 'ecs' && args[1] === 'describe-task-definition') {
      return { stdout: JSON.stringify({ taskDefinition: definition }) };
    }
    if (command === 'bash') {
      const printed = stdout ?? `Task ARN: ${verifyTaskArn}\nTask definition: ${verifyDefinitionArn}\n`;
      if (scriptFailure) throw Object.assign(new Error('script exited 1'), { stdout: printed, stderr: '' });
      return { stdout: printed, stderr: '' };
    }
    throw new Error(`unexpected run ${command} ${args.join(' ')}`);
  };
  const assume = async (kind, _env, _purpose, options = {}) => {
    assumeCalls.push([kind, options.sessionMarker]);
    return { AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y', AWS_SESSION_TOKEN: 'z' };
  };
  return { calls, assumeCalls, run, assume,
    io: (record) => createRuntimeIo(verifyEnv, record, { purpose: 'operation', run, assume }) };
}

test('the one-shot probe returns a zero container exit and records the probe identity', async () => {
  const surface = probeIo({ exitCode: 0 });
  const record = { events: [] };
  const io = await surface.io(record);
  const result = await io.oneShotProbe('verify', revision, 'schema-journal');
  assert.equal(result.exitCode, 0);
  assert.equal(result.task.taskArn, verifyTaskArn);
  assert.equal(result.definition.taskDefinitionArn, verifyDefinitionArn);
  // The preflight and the runtime session were used, and the script received the
  // exact action as its fifth argument.
  assert.deepEqual(surface.assumeCalls, [['runtime', 'preflight'], ['runtime', undefined]]);
  const script = surface.calls.find(([command]) => command === 'bash');
  assert.deepEqual(script[1], ['.github/scripts/run-one-shot-task.sh', 'beta', 'verify', imageDigest,
    serviceCommit, 'schema-journal']);
  const probe = record.events.find((event) => event.type === 'one-shot-probe');
  assert.equal(probe.result, 'stopped-success');
  assert.equal(probe.exit_code, 0);
  assert.equal(probe.task_arn, verifyTaskArn);
  assert.equal(probe.task_definition_arn, verifyDefinitionArn);
  assert.match(probe.command_sha256, /^[a-f0-9]{64}$/);
});

test('the one-shot probe returns a non-zero container exit instead of throwing, and records it', async () => {
  const surface = probeIo({ exitCode: 3, scriptFailure: true });
  const record = { events: [] };
  const io = await surface.io(record);
  // run-one-shot-task.sh exits 1 after printing the identity; the container exit
  // code is the probe result the schema gate judges as reader-failed.
  const result = await io.oneShotProbe('verify', revision, 'schema-journal');
  assert.equal(result.exitCode, 3);
  const probe = record.events.find((event) => event.type === 'one-shot-probe');
  assert.equal(probe.result, 'stopped-failure');
  assert.equal(probe.exit_code, 3);
});

test('the one-shot probe refuses a wrong action, command, image or missing identity', async () => {
  const surface = probeIo();
  const io = await surface.io({ events: [] });
  // A verify role with any other action is forbidden before a launch.
  await assert.rejects(io.oneShotProbe('verify', revision, 'status'), /One-shot role\/action is forbidden/);
  // Another verify command is not the schema-journal read.
  const wrongCommand = probeIo({ definition: verifyDefinition(['node', 'dist/verify.js']) });
  await assert.rejects((await wrongCommand.io({ events: [] })).oneShotProbe('verify', revision, 'schema-journal'),
    /Actual verify command differs from the requested action/);
  // A task running another image is not the revision the gate asked for. (The
  // existing file's `imageDigest` is `sha256:9…`, so the wrong image uses `8`.)
  const wrongImage = probeIo({ task: verifyTask(0, `sha256:${'8'.repeat(64)}`) });
  await assert.rejects((await wrongImage.io({ events: [] })).oneShotProbe('verify', revision, 'schema-journal'),
    /Actual one-shot image\/result differs from the deployed revision/);
  // A launch that prints no unique identity is a launch failure, not a result.
  const noIdentity = probeIo({ stdout: 'no identity here' });
  const record = { events: [] };
  await assert.rejects((await noIdentity.io(record)).oneShotProbe('verify', revision, 'schema-journal'),
    /One-shot probe identity missing/);
  assert.equal(record.events.at(-1).result, 'launch-failed');
});
