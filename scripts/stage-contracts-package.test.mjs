import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contentHash } from './json-contract.mjs';
import * as deployment from './deployment-contract.mjs';
import * as recovery from './recovery-contract.mjs';
import * as stages from './stage-contract-parameters.mjs';
import * as pkg from '@git-malu/stage-contracts';

// The five existing names that predate this contract, plus the one runtime-owned
// Beta parameter; they are not stage-contract names. #213 left the tester
// allowlist as the only admission parameter.
const OTHER_BETA_PARAMETER_NAMES = [
  '/anywear/beta/aws_region',
  '/anywear/beta/cognito_client_id',
  '/anywear/beta/cognito_user_pool_id',
  '/anywear/beta/qweather_api_host',
  '/anywear/beta/s3_bucket_name',
  '/anywear/beta/tester_allowlist',
];

test('the package is the single source of the stage and bake-control exports', () => {
  for (const name of ['STAGE_CONTRACT_STAGE', 'STAGE_CONTRACT_PARAMETERS',
    'STAGE_CONTRACT_CONDITIONAL_PARAMETERS', 'STAGE_CONTRACT_READ_PARAMETERS']) {
    assert.equal(stages[name], pkg[name], `${name} is not re-exported from the package`);
  }
  // #207: the package keeps the stage, stack, normalisation, task-definition and
  // bake-control surface the CDK application and workflows consume. The record and
  // record-gate exports are gone, and so are their re-exports here.
  for (const name of ['DEPLOYMENT_GATE_NAME_SUFFIX', 'DEPLOYMENT_GATE_DURATION_SECONDS',
    'DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS', 'DEPLOYMENT_GATE_REQUEST_FLOOR',
    'DEPLOYMENT_GATE_MAX_PROBES', 'DEPLOYMENT_GATE_SIGNAL_NAMES',
    'DEPLOYMENT_GATE_THRESHOLDS', 'DEPLOYMENT_GATE_COMPARISONS',
    'DEPLOYMENT_SQS_DEPTH_ATTRIBUTES', 'deploymentBakeName', 'deploymentAlarmName',
    'deploymentAlarmNames', 'deploymentQueueNames', 'runtimeStageFromStack']) {
    assert.notEqual(pkg[name], undefined, `${name} must be exported by the package`);
  }
  for (const name of ['DEPLOYMENT_RECORD_MEMBERS', 'SERVICE_DEPLOYMENT_RECORD_SCHEMA',
    'validateServiceDeploymentRecord', 'validateDeploymentGate', 'validateSchemaBoundary',
    'schemaBoundaryPrefixHash', 'DEPLOYMENT_GATE_FIELDS']) {
    assert.equal(pkg[name], undefined, `${name} must not be exported after #207`);
    assert.equal(deployment[name], undefined, `${name} must not be re-exported by deployment-contract.mjs`);
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
  assert.throws(() => pkg.stageContractSchemaHash([...rows].reverse()), /sorted and unique/);
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
