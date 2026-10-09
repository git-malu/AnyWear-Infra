import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTemplates } from './compare-templates.mjs';

const workload = (desired = 2, min = 2, service = 'beta-anywear-api') => ({
  Resources: {
    Api: { Type: 'AWS::ECS::Service', Properties: { ServiceName: service, DesiredCount: desired } },
    [`${service === 'beta-anywear-api' ? 'Api' : 'Worker'}ServiceTaskCountTargetABCDEF12`]: {
      Type: 'AWS::ApplicationAutoScaling::ScalableTarget', Properties: { MinCapacity: min },
    },
  },
  Outputs: {},
});

test('allows the bounded S1 Beta API desired/minimum reduction', () => {
  const before = workload();
  const after = workload(1, 1);
  const result = compareTemplates(before, after, {
    phase: 'legacy', stage: 'beta', stackName: 'AnyWearWorkloadStack-beta',
  });
  assert.equal(result.accepted, true);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.allowed.length, 2);
});

test('rejects a Worker desired-count change under the S1 comparator', () => {
  const before = workload(2, 2, 'beta-anywear-worker');
  const after = workload(1, 1, 'beta-anywear-worker');
  const result = compareTemplates(before, after, {
    phase: 'legacy', stage: 'beta', stackName: 'AnyWearWorkloadStack-beta',
  });
  assert.equal(result.accepted, false);
  assert.equal(result.rejected.length, 2);
});

test('rejects replica changes outside the Beta Workload stack', () => {
  const result = compareTemplates(workload(), workload(1, 1), {
    phase: 'legacy', stage: 'prod', stackName: 'AnyWearWorkloadStack-prod',
  });
  assert.equal(result.accepted, false);
  assert.equal(result.rejected.length, 2);
});

test('scopes cleanup template allowances to nonlegacy Beta phases and exact resource prefixes', () => {
  const before = { Resources: {}, Outputs: {} };
  const cleanup = { Resources: {
    CleanupOperationStateMachineABCDEF12: { Type: 'AWS::StepFunctions::StateMachine' },
  }, Outputs: { CleanupOperationVersion: { Value: 'version-arn' } } };
  const allowed = compareTemplates(before, cleanup, {
    phase: 'roles-added', stage: 'beta', stackName: 'AnyWearWorkloadStack-beta',
  });
  assert.equal(allowed.accepted, true);
  const legacy = compareTemplates(before, cleanup, {
    phase: 'legacy', stage: 'beta', stackName: 'AnyWearWorkloadStack-beta',
  });
  assert.equal(legacy.accepted, false);
  const unrelated = compareTemplates(before, {
    Resources: { UnrelatedResourceABCDEF12: { Type: 'AWS::S3::Bucket' } }, Outputs: {},
  }, { phase: 'roles-added', stage: 'beta', stackName: 'AnyWearWorkloadStack-beta' });
  assert.equal(unrelated.accepted, true);
  const production = compareTemplates(before, cleanup, {
    phase: 'roles-added', stage: 'prod', stackName: 'AnyWearWorkloadStack-prod',
  });
  assert.equal(production.accepted, false);
});
