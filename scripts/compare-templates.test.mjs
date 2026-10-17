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
  Parameters: {},
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
  Parameters: {},
  Outputs: {},
});
const betaWorkload = { stage: 'beta', stackName: 'AnyWearWorkloadStack-beta' };
const profiledTask = (family = 'beta-anywear-api', id = apiTaskId) => ({
  ...sizedTask({ 'Fn::If': ['BetaApiS2', '256', '512'] }, { 'Fn::If': ['BetaApiS2', '512', '1024'] }, family, id),
  Parameters: { BetaApiSizingProfile: { Type: 'String', Default: 's1', AllowedValues: ['s1', 's2-api'],
    Description: 'Retained Beta API sizing profile; s2-api is an unqualified Issue #95 candidate' } },
  Conditions: { BetaApiS2: { 'Fn::Equals': [{ Ref: 'BetaApiSizingProfile' }, 's2-api'] } },
});

test('allows only the complete S2 Beta API size candidate in each identity phase', () => {
  for (const phase of ['legacy', 'roles-added', 'retired']) {
    const result = compareTemplates(sizedTask(), profiledTask(), { ...betaWorkload, phase });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.allowed.map(({ path }) => path), [
      `/Resources/${apiTaskId}/Properties/Cpu`, `/Resources/${apiTaskId}/Properties/Memory`, '/Parameters/BetaApiSizingProfile', '/Conditions',
    ]);
  }
});

test('rejects new sizing declarations when active API still uses fixed S1 CPU and memory', () => {
  const after = profiledTask();
  Object.assign(after.Resources[apiTaskId].Properties, { Cpu: '512', Memory: '1024' });
  const result = compareTemplates(sizedTask(), after, betaWorkload);
  assert.equal(result.accepted, false);
  assert.deepEqual(result.rejected.map(({ path }) => path), ['/Parameters/BetaApiSizingProfile', '/Conditions']);
});

test('new active sizing declarations require both exact expressions even when only one size changes', () => {
  for (const [property, stale, wrongPair] of [['Cpu', '512', '1024'], ['Memory', '1024', '2048']]) {
    for (const mismatch of [stale, { 'Fn::If': ['BetaApiS2', '128', wrongPair] }]) {
      const after = profiledTask(); after.Resources[apiTaskId].Properties[property] = mismatch;
      const result = compareTemplates(sizedTask(), after, betaWorkload);
      assert.equal(result.accepted, false);
      assert.ok(result.rejected.some(({ path }) => path === '/Parameters/BetaApiSizingProfile'));
      assert.ok(result.rejected.some(({ path }) => path === '/Conditions'));
    }
  }
});

test('permits declaration-only sizing retention only in an explicitly stopped template', () => {
  const stopped = { Resources: {}, Parameters: {}, Outputs: { BetaActive: { Value: 'false' } } };
  const declarations = profiledTask();
  for (const phase of ['legacy', 'roles-added', 'retired']) {
    const after = { ...stopped, Parameters: declarations.Parameters, Conditions: declarations.Conditions };
    const result = compareTemplates(stopped, after, { ...betaWorkload, phase });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.allowed.map(({ path }) => path), ['/Parameters/BetaApiSizingProfile', '/Conditions']);
  }
  for (const outputs of [{}, { BetaActive: { Value: 'true' } }]) {
    const before = { ...stopped, Outputs: outputs };
    assert.equal(compareTemplates(before, { ...before, Parameters: declarations.Parameters,
      Conditions: declarations.Conditions }, betaWorkload).accepted, false);
  }
});

test('rejects incomplete or arbitrary S2 size changes and nonbaseline sizes', () => {
  for (const [cpu, memory] of [['256', '1024'], ['512', '512'], ['128', '512'], ['256', '768']]) {
    assert.equal(compareTemplates(sizedTask(), sizedTask(cpu, memory), betaWorkload).accepted, false);
  }
  assert.equal(compareTemplates(sizedTask('1024', '2048'), sizedTask('256', '512'), betaWorkload).accepted, false);
  for (const mutate of [
    (task) => task.Resources[apiTaskId].Properties.Cpu = '256',
    (task) => task.Resources[apiTaskId].Properties.Memory['Fn::If'][2] = '2048',
    (task) => task.Parameters.BetaApiSizingProfile.Default = 's2-api',
    (task) => task.Parameters.BetaApiSizingProfile.AllowedValues.push('other'),
    (task) => task.Conditions.BetaApiS2['Fn::Equals'][1] = 's1',
    (task) => task.Conditions.Other = { 'Fn::Equals': ['x', 'x'] },
  ]) {
    const after = profiledTask(); mutate(after);
    assert.equal(compareTemplates(sizedTask(), after, betaWorkload).accepted, false);
  }
});

test('rejects Worker/helper size changes and an unrelated logical ID under S2', () => {
  for (const [family, id] of [
    ['beta-anywear-worker', apiTaskId],
    ['beta-anywear-cleanup', apiTaskId],
    ['beta-anywear-api', 'OtherApiTaskDefinitionABCDEF12'],
  ]) {
    assert.equal(compareTemplates(sizedTask('512', '1024', family, id),
      profiledTask(family, id), betaWorkload).accepted, false);
  }
});

test('rejects S2 size changes outside the exact Beta Workload stack', () => {
  for (const options of [
    { stage: 'prod', stackName: 'AnyWearWorkloadStack-prod' },
    { stage: 'dev', stackName: 'AnyWearWorkloadStack-dev' },
    { stage: 'beta', stackName: 'AnyWearPlatformStack-beta' },
  ]) {
    assert.equal(compareTemplates(sizedTask(), profiledTask(), options).accepted, false);
  }
});

test('does not hide container, output or resource drift alongside the S2 size pair', () => {
  const before = sizedTask();
  const after = profiledTask();
  after.Resources[apiTaskId].Properties.ContainerDefinitions[0].HealthCheck.StartPeriod = 1;
  after.Outputs.ApiBaseUrl = { Value: 'https://changed.example' };
  after.Resources.UnrelatedResourceABCDEF12 = { Type: 'AWS::S3::Bucket' };
  const result = compareTemplates(before, after, betaWorkload);
  assert.equal(result.accepted, false);
  assert.equal(result.allowed.length, 4);
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

const telemetryTask = (enabled = false, purpose = 'api') => {
  const result = sizedTask('512', '1024', `beta-anywear-${purpose}`, `ComputeRuntime${purpose === 'api' ? 'Api' : 'Worker'}TaskDefinitionABCDEF12`);
  const container = Object.values(result.Resources)[0].Properties.ContainerDefinitions[0];
  container.Environment = [{ Name: 'STAGE', Value: 'beta' }];
  if (enabled) {
    result.Parameters.BetaSizingTelemetry = { Type: 'String', Default: 'false', AllowedValues: ['false', 'true'],
      Description: 'Retained Beta API and Worker sizing telemetry; disabled by default' };
    container.Environment.unshift({ Name: 'BETA_SIZING_TELEMETRY', Value: { Ref: 'BetaSizingTelemetry' } });
  }
  return result;
};

test('telemetry comparator permits only the exact default-off parameter and API/Worker environment reference', () => {
  for (const purpose of ['api', 'worker']) {
    assert.equal(compareTemplates(telemetryTask(false, purpose), telemetryTask(true, purpose), betaWorkload).accepted, true);
    for (const mutate of [
      after => after.Parameters.BetaSizingTelemetry.Default = 'true',
      after => after.Parameters.BetaSizingTelemetry.AllowedValues.push('other'),
      after => Object.values(after.Resources)[0].Properties.ContainerDefinitions[0].Environment[0].Value = 'true',
      after => Object.values(after.Resources)[0].Properties.ContainerDefinitions[0].Environment[1].Value = 'prod',
      after => Object.values(after.Resources)[0].Properties.ContainerDefinitions[0].Environment.push({ Name: 'OTHER', Value: 'x' }),
      after => Object.values(after.Resources)[0].Properties.ContainerDefinitions[0].HealthCheck.StartPeriod = 1,
    ]) {
      const after = telemetryTask(true, purpose); mutate(after);
      assert.equal(compareTemplates(telemetryTask(false, purpose), after, betaWorkload).accepted, false);
    }
    for (const options of [{ stage: 'prod', stackName: 'AnyWearWorkloadStack-prod' },
      { stage: 'dev', stackName: 'AnyWearWorkloadStack-dev' }, { stage: 'beta', stackName: 'AnyWearPlatformStack-beta' }]) {
      assert.equal(compareTemplates(telemetryTask(false, purpose), telemetryTask(true, purpose), options).accepted, false);
    }
  }
});

const machineAuthArn = 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:/anywear/beta/cleanup_machine_auth';
const machineAuthPolicyArn = `${machineAuthArn}-??????`;
const machineAuthWorkload = (roleName, purpose = 'api') => {
  const roleId = `${purpose === 'api' ? 'Api' : 'Worker'}TaskRoleABCDEF12`;
  const policyId = `${purpose === 'api' ? 'Api' : 'Worker'}TaskRoleDefaultPolicyABCDEF12`;
  const taskId = `ComputeRuntime${purpose === 'api' ? 'Api' : 'Worker'}TaskDefinitionABCDEF12`;
  const role = { Type: 'AWS::IAM::Role', Properties: { RoleName: roleName } };
  const policyStatement = purpose === 'api'
    ? { Effect: 'Allow', Action: ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'], Resource: 'existing-secret' }
    : { Effect: 'Allow', Action: ['s3:GetObject'], Resource: 'existing-bucket' };
  const policy = { Type: 'AWS::IAM::Policy', Properties: {
    Roles: [{ Ref: roleId }], PolicyDocument: { Version: '2012-10-17', Statement: [policyStatement] },
  } };
  const container = { Name: purpose === 'api' ? 'ApiContainer' : 'WorkerContainer', Secrets: [{ Name: 'EXISTING', ValueFrom: 'existing-secret' }] };
  return { Resources: {
    [roleId]: role, [policyId]: policy,
    [taskId]: { Type: 'AWS::ECS::TaskDefinition', Properties: { Family: `beta-anywear-${purpose}`, ContainerDefinitions: [container] } },
  }, Parameters: {}, Outputs: {} };
};

test('allows only the exact Beta API cleanup machine-auth secret binding', () => {
  const before = machineAuthWorkload('beta-anywear-api-task');
  before.Resources.ApiTaskRoleDefaultPolicyABCDEF12.Properties.PolicyDocument.Statement[0].Resource = 'database-secret';
  const after = structuredClone(before);
  after.Resources.ApiTaskRoleDefaultPolicyABCDEF12.Properties.PolicyDocument.Statement[0].Resource = [machineAuthPolicyArn, 'database-secret'];
  after.Resources.ComputeRuntimeApiTaskDefinitionABCDEF12.Properties.ContainerDefinitions[0].Secrets.push({
    Name: 'CLEANUP_MACHINE_AUTH_SECRET', ValueFrom: machineAuthArn,
  });
  const result = compareTemplates(before, after, { ...betaWorkload, phase: 'legacy' });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.allowed.length, 2);
});

test('machine-auth binding rejects Worker, Production, wrong secret, and extra changes', () => {
  const before = machineAuthWorkload('beta-anywear-worker-task', 'worker');
  const workerAfter = structuredClone(before);
  workerAfter.Resources.ComputeRuntimeWorkerTaskDefinitionABCDEF12.Properties.ContainerDefinitions[0].Secrets.push({
    Name: 'CLEANUP_MACHINE_AUTH_SECRET', ValueFrom: machineAuthArn,
  });
  assert.equal(compareTemplates(before, workerAfter, { ...betaWorkload, phase: 'legacy' }).accepted, false);

  const apiBefore = machineAuthWorkload('beta-anywear-api-task');
  const apiAfter = structuredClone(apiBefore);
  apiAfter.Resources.ComputeRuntimeApiTaskDefinitionABCDEF12.Properties.ContainerDefinitions[0].Secrets.push({
    Name: 'CLEANUP_MACHINE_AUTH_SECRET', ValueFrom: `${machineAuthArn}-other`,
  });
  assert.equal(compareTemplates(apiBefore, apiAfter, { stage: 'prod', stackName: 'AnyWearWorkloadStack-prod' }).accepted, false);

  const policyBefore = machineAuthWorkload('beta-anywear-api-task');
  const policyAfter = structuredClone(policyBefore);
  policyAfter.Resources.ApiTaskRoleDefaultPolicyABCDEF12.Properties.PolicyDocument.Statement[0].Resource = [machineAuthPolicyArn, 'database-secret'];
  policyAfter.Resources.ApiTaskRoleDefaultPolicyABCDEF12.Properties.PolicyDocument.Statement.push({ Effect: 'Allow', Action: '*', Resource: '*' });
  assert.equal(compareTemplates(policyBefore, policyAfter, { ...betaWorkload, phase: 'legacy' }).accepted, false);
});

const databaseClusterId = 'AnyWearDatabase2CD487D8';
const databaseWriterId = 'AnyWearDatabasewriter936467CD';
function platformDatabase(stage, { protection, retention, window }) {
  const properties = { Engine: 'aurora-postgresql', DeletionProtection: protection };
  if (retention !== undefined) properties.BackupRetentionPeriod = retention;
  if (window !== undefined) properties.PreferredBackupWindow = window;
  const policy = stage === 'prod' ? 'Retain' : 'Delete';
  return { Resources: {
    [databaseClusterId]: { Type: 'AWS::RDS::DBCluster', DeletionPolicy: policy, Properties: properties },
    [databaseWriterId]: { Type: 'AWS::RDS::DBInstance', DeletionPolicy: policy,
      Properties: { DBClusterIdentifier: { Ref: databaseClusterId } } },
  }, Outputs: {} };
}
const recoveryPaths = (...properties) => properties.map((property) => `/Resources/${databaseClusterId}/Properties/${property}`).sort();

test('allows exactly the Beta database recovery delta from the baseline cluster', () => {
  const before = platformDatabase('beta', { protection: false });
  const after = platformDatabase('beta', { protection: true, retention: 7, window: '16:00-16:30' });
  for (const phase of ['legacy', 'roles-added', 'retired']) {
    const result = compareTemplates(before, after, { phase, stage: 'beta', stackName: 'AnyWearPlatformStack-beta' });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.rejected, []);
    assert.deepEqual(result.allowed.map(({ path }) => path).sort(),
      recoveryPaths('BackupRetentionPeriod', 'PreferredBackupWindow', 'DeletionProtection'));
    assert.ok(result.allowed.every(({ reason }) => reason === 'Issue #161 explicit database recovery targets'));
  }
});

test('allows exactly the Production database recovery delta from the baseline cluster', () => {
  const before = platformDatabase('prod', { protection: true });
  const after = platformDatabase('prod', { protection: true, retention: 35, window: '16:00-16:30' });
  for (const phase of ['legacy', 'roles-added', 'retired']) {
    const result = compareTemplates(before, after, { phase, stage: 'prod', stackName: 'AnyWearPlatformStack-prod' });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.rejected, []);
    assert.deepEqual(result.allowed.map(({ path }) => path).sort(),
      recoveryPaths('BackupRetentionPeriod', 'PreferredBackupWindow'));
    assert.ok(result.allowed.every(({ reason }) => reason === 'Issue #161 explicit database recovery targets'));
  }
});

test('rejects recovery values that differ from the stage targets', () => {
  const cases = [
    ['beta', 'AnyWearPlatformStack-beta', { protection: false },
      { protection: true, retention: 30, window: '16:00-16:30' }],
    ['beta', 'AnyWearPlatformStack-beta', { protection: false },
      { protection: true, retention: 7, window: '17:00-18:00' }],
    ['prod', 'AnyWearPlatformStack-prod', { protection: true },
      { protection: true, retention: 30, window: '16:00-16:30' }],
    ['prod', 'AnyWearPlatformStack-prod', { protection: true },
      { protection: false, retention: 35, window: '16:00-16:30' }],
  ];
  for (const [stage, stackName, baseline, candidate] of cases) {
    const result = compareTemplates(platformDatabase(stage, baseline), platformDatabase(stage, candidate),
      { phase: 'legacy', stage, stackName });
    assert.equal(result.accepted, false);
    assert.ok(result.rejected.length > 0);
  }
});

test('recovery allowance cannot cover a rewrite of an existing cluster property', () => {
  const rewrite = compareTemplates(platformDatabase('prod', { protection: true, retention: 1 }),
    platformDatabase('prod', { protection: true, retention: 35, window: '16:00-16:30' }),
    { phase: 'legacy', stage: 'prod', stackName: 'AnyWearPlatformStack-prod' });
  assert.equal(rewrite.accepted, false);
  assert.ok(rewrite.rejected.some(({ path }) => path === `/Resources/${databaseClusterId}/Properties/BackupRetentionPeriod`));

  const newProtection = compareTemplates(platformDatabase('beta', {}),
    platformDatabase('beta', { protection: true, retention: 7, window: '16:00-16:30' }),
    { phase: 'legacy', stage: 'beta', stackName: 'AnyWearPlatformStack-beta' });
  assert.equal(newProtection.accepted, false);
  assert.ok(newProtection.rejected.some(({ path }) => path === `/Resources/${databaseClusterId}/Properties/DeletionProtection`));
});

test('recovery allowance is scoped to the stage Platform stack and the exact properties', () => {
  const before = platformDatabase('beta', { protection: false });
  const after = platformDatabase('beta', { protection: true, retention: 7, window: '16:00-16:30' });
  for (const options of [
    { phase: 'legacy', stage: 'beta', stackName: 'AnyWearWorkloadStack-beta' },
    { phase: 'legacy', stage: 'prod', stackName: 'AnyWearPlatformStack-beta' },
    { phase: 'legacy', stage: 'dev', stackName: 'AnyWearPlatformStack-dev' },
  ]) {
    assert.equal(compareTemplates(before, after, options).accepted, false);
  }
  const unrelated = structuredClone(after);
  unrelated.Resources[databaseClusterId].Properties.StorageEncrypted = false;
  assert.equal(compareTemplates(before, unrelated,
    { phase: 'legacy', stage: 'beta', stackName: 'AnyWearPlatformStack-beta' }).accepted, false);
});
