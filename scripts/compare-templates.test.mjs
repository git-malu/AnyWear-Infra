import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.equal(unrelated.accepted, false);
  const production = compareTemplates(before, cleanup, {
    phase: 'roles-added', stage: 'prod', stackName: 'AnyWearWorkloadStack-prod',
  });
  assert.equal(production.accepted, false);
});

test('fixture allowances require complete reviewed resources and reject broadened IAM or task configuration', () => {
  const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/cleanup-acceptance-resources.json', import.meta.url), 'utf8'));
  const before = { Resources: {}, Outputs: {} };
  const options = { phase: 'retired', stage: 'beta', stackName: 'AnyWearWorkloadStack-beta' };
  assert.equal(compareTemplates(before, fixture, options).accepted, true);
  const [taskId, policyId] = Object.keys(fixture.Resources);
  for (const mutate of [f => f.Resources[policyId].Properties.PolicyDocument.Statement[0].Resource = '*',
    f => delete f.Resources[policyId].Properties.PolicyDocument.Statement[0].Condition,
    f => f.Resources[policyId].Properties.PolicyDocument.Statement[1].Resource = ['*'],
    f => f.Resources[policyId].Properties.PolicyDocument.Statement[2].Effect = 'Deny',
    f => f.Resources[policyId].Properties.PolicyDocument.Statement.push({ Effect: 'Allow', Action: '*', Resource: '*' }),
    f => f.Resources[taskId].Properties.ContainerDefinitions[0].Environment.push({ Name: 'OTHER', Value: 'override' }),
    f => f.Resources[taskId].Properties.TaskRoleArn = 'other-role', f => f.Resources[taskId].DeletionPolicy = 'Delete',
    f => f.Outputs.CleanupAcceptanceTaskDefinitionArn.Value.Ref = 'other-task']) {
    const bad = structuredClone(fixture); mutate(bad);
    assert.equal(compareTemplates(before, bad, options).accepted, false);
  }
  assert.equal(compareTemplates(before, fixture, { ...options, phase: 'legacy' }).accepted, false);
});
