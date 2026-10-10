import test from 'node:test';
import assert from 'node:assert/strict';
import { observeBetaSizing } from './observe-beta-sizing.mjs';

const fixture = (profile = 's1', telemetry = 'false') => ({
  stack: { Parameters: Object.entries({ BetaApiSizingProfile: profile, BetaSizingTelemetry: telemetry })
    .map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })) },
  definitions: Object.fromEntries(['api', 'worker'].map(purpose => [purpose, {
    taskDefinitionArn: `arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-${purpose}:7`,
    cpu: purpose === 'worker' ? '1024' : profile === 's2-api' ? '256' : '512',
    memory: purpose === 'worker' ? '2048' : profile === 's2-api' ? '512' : '1024',
    containerDefinitions: [{ name: purpose === 'api' ? 'ApiContainer' : 'WorkerContainer',
      environment: [{ name: 'BETA_SIZING_TELEMETRY', value: telemetry }] }],
  }])),
});

test('sizing observer binds both actual task definitions to retained sizing and telemetry', () => {
  for (const profile of ['s1', 's2-api']) for (const telemetry of ['false', 'true']) {
    const { stack, definitions } = fixture(profile, telemetry);
    const observed = observeBetaSizing(stack, definitions);
    assert.equal(observed.beta_api_sizing_profile, profile);
    assert.equal(observed.beta_sizing_telemetry, telemetry);
    assert.equal(observed.ecs.api.cpu, profile === 's2-api' ? '256' : '512');
    assert.equal(observed.ecs.worker.memory, '2048');
    assert.equal(observed.ecs.worker.task_definition_arn, definitions.worker.taskDefinitionArn);
    assert.equal(observed.ecs.api.beta_sizing_telemetry, telemetry);
  }
});

test('sizing observer rejects wrong/missing/duplicate telemetry and CPU/memory drift in either task', () => {
  for (const purpose of ['api', 'worker']) for (const mutate of [
    task => task.cpu = '4096', task => task.memory = '8192',
    task => task.containerDefinitions[0].environment[0].value = 'false',
    task => task.containerDefinitions[0].environment = [],
    task => task.containerDefinitions[0].environment.push({ name: 'BETA_SIZING_TELEMETRY', value: 'true' }),
  ]) {
    const { stack, definitions } = fixture('s2-api', 'true'); mutate(definitions[purpose]);
    assert.throws(() => observeBetaSizing(stack, definitions), /differs from retained/);
  }
});

test('pre-parameter source can prove S1 with absent, disabled telemetry but cannot enable it', () => {
  const { definitions } = fixture();
  for (const task of Object.values(definitions)) task.containerDefinitions[0].environment = [];
  assert.equal(observeBetaSizing({}, definitions).ecs.api.beta_sizing_telemetry, 'absent-disabled');
  definitions.worker.containerDefinitions[0].environment.push({ name: 'BETA_SIZING_TELEMETRY', value: 'true' });
  assert.throws(() => observeBetaSizing({}, definitions), /telemetry differs/);
});
