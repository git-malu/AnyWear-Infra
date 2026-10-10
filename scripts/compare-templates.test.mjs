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

const apiTaskId = 'ComputeRuntimeApiTaskDefinitionABCDEF12';
const sizedTask = (cpu = '512', memory = '1024', family = 'beta-anywear-api', id = apiTaskId) => ({
  Resources: {
    [id]: { Type: 'AWS::ECS::TaskDefinition', Properties: {
      Family: family, Cpu: cpu, Memory: memory,
      ContainerDefinitions: [{ Name: 'ApiContainer', HealthCheck: { StartPeriod: 30 } }],
    } },
  },
  Outputs: {},
});
const betaWorkload = { stage: 'beta', stackName: 'AnyWearWorkloadStack-beta' };

test('allows only the complete S2 Beta API size candidate in each identity phase', () => {
  for (const phase of ['legacy', 'roles-added', 'retired']) {
    const result = compareTemplates(sizedTask(), sizedTask('256', '512'), { ...betaWorkload, phase });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.allowed.map(({ path }) => path), [
      `/Resources/${apiTaskId}/Properties/Cpu`, `/Resources/${apiTaskId}/Properties/Memory`,
    ]);
  }
});

test('rejects incomplete or arbitrary S2 size changes and nonbaseline sizes', () => {
  for (const [cpu, memory] of [['256', '1024'], ['512', '512'], ['128', '512'], ['256', '768']]) {
    assert.equal(compareTemplates(sizedTask(), sizedTask(cpu, memory), betaWorkload).accepted, false);
  }
  assert.equal(compareTemplates(sizedTask('1024', '2048'), sizedTask('256', '512'), betaWorkload).accepted, false);
});

test('rejects Worker/helper size changes and an unrelated logical ID under S2', () => {
  for (const [family, id] of [
    ['beta-anywear-worker', apiTaskId],
    ['beta-anywear-cleanup', apiTaskId],
    ['beta-anywear-api', 'OtherApiTaskDefinitionABCDEF12'],
  ]) {
    assert.equal(compareTemplates(sizedTask('512', '1024', family, id),
      sizedTask('256', '512', family, id), betaWorkload).accepted, false);
  }
});

test('rejects S2 size changes outside the exact Beta Workload stack', () => {
  for (const options of [
    { stage: 'prod', stackName: 'AnyWearWorkloadStack-prod' },
    { stage: 'dev', stackName: 'AnyWearWorkloadStack-dev' },
    { stage: 'beta', stackName: 'AnyWearPlatformStack-beta' },
  ]) {
    assert.equal(compareTemplates(sizedTask(), sizedTask('256', '512'), options).accepted, false);
  }
});

test('does not hide container, output or resource drift alongside the S2 size pair', () => {
  const before = sizedTask();
  const after = sizedTask('256', '512');
  after.Resources[apiTaskId].Properties.ContainerDefinitions[0].HealthCheck.StartPeriod = 1;
  after.Outputs.ApiBaseUrl = { Value: 'https://changed.example' };
  after.Resources.UnrelatedResourceABCDEF12 = { Type: 'AWS::S3::Bucket' };
  const result = compareTemplates(before, after, betaWorkload);
  assert.equal(result.accepted, false);
  assert.equal(result.allowed.length, 2);
  assert.equal(result.rejected.length, 3);
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
