import test from 'node:test';
import assert from 'node:assert/strict';
import { deployOperationStack, deleteOperationStack } from './runtime-operation.mjs';
import { runtimeStack } from './one-writer.mjs';

const baseName = 'AnyWearPlatformStack-beta';
const egressName = 'AnyWearEgressStack-beta';

// Minimal mock of the runtime io: CloudFormation stack reads plus deploy/destroy.
function operationMock({ runtimeStatus } = {}) {
  const calls = []; const deployments = []; const destroys = [];
  const stacks = new Map([[baseName, { StackName: baseName, StackStatus: 'UPDATE_COMPLETE' }]]);
  if (runtimeStatus !== undefined) stacks.set(runtimeStack, { StackName: runtimeStack, StackStatus: runtimeStatus });
  return { calls, deployments, destroys,
    async aws(args) {
      calls.push([...args]);
      assert.equal(args[0], 'cloudformation');
      assert.equal(args[1], 'describe-stacks');
      const stack = stacks.get(args[args.indexOf('--stack-name') + 1]);
      return stack ? { Stacks: [stack] } : { Stacks: [] };
    },
    async deploy(stack) { calls.push(['deploy', stack]); deployments.push(stack); },
    async destroy(stack) { calls.push(['destroy', stack]); destroys.push(stack); } };
}

test('deploy-platform reads the Service-owned Runtime stack terminal before any deploy', async () => {
  for (const runtimeStatus of ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']) {
    const io = operationMock({ runtimeStatus });
    assert.equal(await deployOperationStack(io, 'deploy-platform'), baseName);
    assert.deepEqual(io.deployments, [baseName]);
    assert.deepEqual(io.calls.map(call => call.slice(0, 2)), [['cloudformation', 'describe-stacks'], ['deploy', baseName]]);
    assert.ok(io.calls[0].includes(runtimeStack), 'the read targets the Service-owned Runtime stack');
  }
});

test('deploy-platform fails closed before any deploy when the Runtime stack is non-terminal', async () => {
  for (const runtimeStatus of ['UPDATE_IN_PROGRESS', 'CREATE_IN_PROGRESS', 'UPDATE_ROLLBACK_FAILED']) {
    const io = operationMock({ runtimeStatus });
    await assert.rejects(deployOperationStack(io, 'deploy-platform'),
      new RegExp(`deploy-platform requires a terminal ${runtimeStack}; observed ${runtimeStatus}`));
    assert.deepEqual(io.deployments, [], `no deploy for ${runtimeStatus}`);
  }
});

test('only Base and Egress deploys read the Runtime stack', async () => {
  for (const [operation, stack] of [['deploy-foundation', 'AnyWearFoundationStack'],
    ['deploy-billing', 'AnyWearBillingStack-beta']]) {
    const io = operationMock({ runtimeStatus: 'UPDATE_IN_PROGRESS' });
    assert.equal(await deployOperationStack(io, operation), stack);
    assert.deepEqual(io.deployments, [stack]);
    assert.ok(!io.calls.some(call => call[0] === 'cloudformation'), `${operation} needs no Runtime read`);
  }
});

test('deploy-egress reads the Runtime stack terminal before creating the disposable edge', async () => {
  for (const runtimeStatus of [undefined, 'UPDATE_COMPLETE']) {
    const io = operationMock({ runtimeStatus });
    assert.equal(await deployOperationStack(io, 'deploy-egress'), egressName);
    assert.deepEqual(io.deployments, [egressName]);
  }
  const io = operationMock({ runtimeStatus: 'UPDATE_IN_PROGRESS' });
  await assert.rejects(deployOperationStack(io, 'deploy-egress'), /terminal AnyWearRuntimeStack-beta/);
  assert.deepEqual(io.deployments, []);
});

test('delete-egress refuses unless the Runtime stack is absent', async () => {
  const running = operationMock({ runtimeStatus: 'UPDATE_COMPLETE' });
  await assert.rejects(deleteOperationStack(running, 'delete-egress'),
    /requires AnyWearRuntimeStack-beta to be absent; stop the Runtime stack first/);
  assert.deepEqual(running.destroys, []);

  const stopped = operationMock();
  assert.equal(await deleteOperationStack(stopped, 'delete-egress'), egressName);
  assert.deepEqual(stopped.destroys, [egressName]);
  assert.deepEqual(stopped.deployments, []);
});

test('only delete-egress may destroy a stack', async () => {
  const io = operationMock();
  await assert.rejects(deleteOperationStack(io, 'deploy-platform'), /has no stack to delete/);
  await assert.rejects(deleteOperationStack(io, 'delete-platform'), /has no stack to delete/);
  assert.deepEqual(io.destroys, []);
});
