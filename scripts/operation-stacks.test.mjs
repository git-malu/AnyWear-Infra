import test from 'node:test';
import assert from 'node:assert/strict';
import { changedStackNames } from './operation-stacks.mjs';

test('source provenance binds every stack mutated by deployment and lifecycle operations', () => {
  assert.deepEqual(changedStackNames('deploy-foundation'), ['AnyWearFoundationStack']);
  assert.deepEqual(changedStackNames('deploy-billing'), ['AnyWearBillingStack-beta']);
  assert.deepEqual(changedStackNames('deploy-platform'), ['AnyWearPlatformStack-beta']);
  assert.deepEqual(changedStackNames('deploy-workload'), ['AnyWearWorkloadStack-beta']);
  for (const operation of ['start', 'stop']) assert.deepEqual(changedStackNames(operation), ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta']);
  assert.deepEqual(changedStackNames('observe'), []);
});
