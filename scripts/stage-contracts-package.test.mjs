import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contentHash } from './json-contract.mjs';
import * as deployment from './deployment-contract.mjs';
import * as recovery from './recovery-contract.mjs';
import * as stages from './stage-contract-parameters.mjs';
import * as pkg from '@git-malu/stage-contracts';

// The four existing names that predate this contract, plus the three
// runtime-owned Beta parameters; they are not stage-contract names.
const OTHER_BETA_PARAMETER_NAMES = [
  '/anywear/beta/admission_mode',
  '/anywear/beta/aws_region',
  '/anywear/beta/cognito_client_id',
  '/anywear/beta/cognito_user_pool_id',
  '/anywear/beta/qweather_api_host',
  '/anywear/beta/s3_bucket_name',
  '/anywear/beta/tester_allowlist',
];

test('the package is the single source of the stage and record exports', () => {
  for (const name of ['STAGE_CONTRACT_STAGE', 'STAGE_CONTRACT_PARAMETERS',
    'STAGE_CONTRACT_CONDITIONAL_PARAMETERS', 'STAGE_CONTRACT_READ_PARAMETERS']) {
    assert.equal(stages[name], pkg[name], `${name} is not re-exported from the package`);
  }
  for (const name of ['DEPLOYMENT_RECORD_MEMBERS', 'DEPLOYMENT_PRODUCER_FIELDS', 'DEPLOYMENT_STACK_FIELDS',
    'DEPLOYMENT_INPUT_FIELDS', 'SERVICE_OBSERVED_FIELDS', 'SERVICE_ECS_IDENTITY_FIELDS',
    'SERVICE_DEPLOYMENT_RECORD_SCHEMA', 'INFRA_REPOSITORY', 'SERVICE_REPOSITORY', 'SERVICE_RUNTIME_STACK',
    'validateStageInputs', 'stageContractSchemaHash', 'stableTaskDefinition', 'taskDefinitionContentHash',
    'validateServiceDeploymentRecord', 'runtimeStageFromStack', 'validateServiceStacks']) {
    assert.equal(deployment[name], pkg[name], `${name} is not re-exported from the package`);
  }
  assert.equal(recovery.platformStackName, pkg.platformStackName);
});

test('the package schema hash is the local canonical-JSON content hash', () => {
  const rows = [
    { parameter: '/anywear/beta/public_subnet_ids', version: '2', value_sha256: 'b'.repeat(64) },
    { parameter: '/anywear/beta/vpc_id', version: '4', value_sha256: 'd'.repeat(64) },
  ];
  assert.equal(pkg.stageContractSchemaHash(rows),
    contentHash(rows.map(({ parameter, version }) => ({ parameter, version }))));
  assert.equal(pkg.stageContractSchemaHash([]), contentHash([]));
  assert.throws(() => deployment.stageContractSchemaHash([...rows].reverse()), /sorted and unique/);
});

test('the package definitions match the synthesized Beta Platform stage surface', () => {
  const template = JSON.parse(readFileSync(new URL(
    '../test/baselines/beta-active/AnyWearPlatformStack-beta.template.json', import.meta.url), 'utf8'));
  const published = Object.values(template.Resources)
    .filter(resource => resource?.Type === 'AWS::SSM::Parameter'
      && typeof resource.Properties?.Name === 'string'
      && resource.Properties.Name.startsWith('/anywear/beta/'))
    .map(resource => resource.Properties.Name)
    .sort();
  const contractNames = published.filter(name => !OTHER_BETA_PARAMETER_NAMES.includes(name));
  // The anchor baseline is the split Base synthesis: it publishes exactly the 35
  // unconditional names, including `api_base_url` from the adopted API
  // distribution. A silently missing or extra published name fails here.
  assert.deepEqual(contractNames, [...pkg.STAGE_CONTRACT_PARAMETERS]);
  assert.deepEqual(published.filter(name => contractNames.includes(name)), contractNames);
  assert.deepEqual(published.filter(name => !contractNames.includes(name)), [...OTHER_BETA_PARAMETER_NAMES].sort());
  const definitions = pkg.stageParameters();
  assert.equal(definitions.length, 36);
  assert.deepEqual(definitions.map(definition => definition.parameter), [...pkg.STAGE_CONTRACT_READ_PARAMETERS]);
  assert.deepEqual(definitions.filter(definition => pkg.STAGE_CONTRACT_CONDITIONAL_PARAMETERS
    .includes(definition.parameter)).map(definition => definition.name), ['cleanup_task_role_arn']);
  assert.deepEqual(definitions.filter(definition => definition.kind === 'List').map(definition => definition.name),
    ['isolated_subnet_ids', 'private_subnet_ids', 'public_subnet_ids']);
});
