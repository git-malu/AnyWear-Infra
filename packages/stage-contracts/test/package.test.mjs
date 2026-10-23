import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as pkg from '../index.mjs';

const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
const exists = name => existsSync(fileURLToPath(new URL(name, root)));
const packageJson = JSON.parse(read('package.json'));

test('the package identity is the reviewed name, version and tag', () => {
  assert.equal(packageJson.name, '@git-malu/stage-contracts');
  assert.equal(packageJson.version, '0.6.0');
  assert.equal(`stage-contracts-v${packageJson.version}`, 'stage-contracts-v0.6.0');
  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.license, 'UNLICENSED');
  assert.equal(packageJson.engines.node, '>=24');
  assert.equal(packageJson.publishConfig.registry, 'https://npm.pkg.github.com');
  assert.equal(packageJson.private, undefined);
});

test('the published files are exactly the plain ESM entrypoint, its types and the README', () => {
  assert.deepEqual(packageJson.files, ['index.mjs', 'index.d.ts', 'README.md']);
  assert.equal(packageJson.main, './index.mjs');
  assert.equal(packageJson.types, './index.d.ts');
  assert.deepEqual(packageJson.exports['.'], {
    types: './index.d.ts',
    import: './index.mjs',
    default: './index.mjs',
  });
  for (const file of [...packageJson.files, packageJson.main, packageJson.types,
    packageJson.exports['.'].types, packageJson.exports['.'].import, packageJson.exports['.'].default]) {
    assert.ok(exists(file), `Missing published file ${file}`);
  }
});

test('the package has no build step and no runtime dependency', () => {
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.peerDependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
  assert.equal(packageJson.scripts.test, 'node --test test/*.test.mjs');
  assert.equal(packageJson.scripts.pack, 'npm pack');
  const source = read('index.mjs');
  assert.ok(!/from\s+['"]aws-cdk-lib['"]/.test(source), 'The package must not import aws-cdk-lib');
  assert.ok(!/require\(\s*['"]aws-cdk-lib['"]\s*\)/.test(source), 'The package must not require aws-cdk-lib');
  assert.ok(!/from\s+['"]constructs['"]/.test(source), 'The package must not import constructs');
  assert.ok(source.includes("from 'node:crypto'"), 'The package may only use Node built-ins');
});

// Issue #207: the operation/deployment record chain is retired. The package keeps
// the stage, stack, normalisation, task-definition and bake-control surface the
// CDK application and workflows consume, and drops exactly the record and
// record-gate surface. A stale import on either side fails here.
const REMOVED_EXPORTS = Object.freeze([
  'DEPLOYMENT_RECORD_MEMBERS', 'DEPLOYMENT_PRODUCER_FIELDS', 'DEPLOYMENT_STACK_FIELDS',
  'DEPLOYMENT_INPUT_FIELDS', 'SERVICE_OBSERVED_FIELDS', 'SERVICE_ECS_IDENTITY_FIELDS',
  'SERVICE_DEPLOYMENT_RECORD_MEMBERS', 'SERVICE_DEPLOYMENT_RECORD_SCHEMA',
  'validateServiceDeploymentRecord', 'validateServiceStacks',
  'SERVICE_SCHEMA_BOUNDARY_FIELDS', 'SCHEMA_BOUNDARY_ASSET_FIELDS',
  'SCHEMA_BOUNDARY_APPLIED_FIELDS', 'SCHEMA_BOUNDARY_COMPARISON_FIELDS',
  'SCHEMA_BOUNDARY_READER_FIELDS', 'SCHEMA_BOUNDARY_READER_SOURCES', 'SCHEMA_BOUNDARY_RESULTS',
  'schemaBoundaryPrefixHash', 'validateSchemaBoundary',
  'DEPLOYMENT_GATE_FIELDS', 'DEPLOYMENT_GATE_PROBE_FIELDS', 'DEPLOYMENT_GATE_SIGNAL_FIELDS',
  'DEPLOYMENT_GATE_RESULTS', 'DEPLOYMENT_GATE_STATES', 'DEPLOYMENT_GATE_ALARM_STATES',
  'validateDeploymentGate',
]);

const KEPT_EXPORTS = Object.freeze([
  'STAGE_CONTRACT_STAGE', 'STAGE_CONTRACT_PARAMETERS', 'STAGE_CONTRACT_CONDITIONAL_PARAMETERS',
  'STAGE_CONTRACT_READ_PARAMETERS', 'stageParameters', 'validateStageInputs', 'stageContractSchemaHash',
  'INFRA_REPOSITORY', 'SERVICE_REPOSITORY', 'platformStackName', 'runtimeStackName',
  'SERVICE_RUNTIME_STACK', 'DEPLOYED_TEMPLATE_NORMALISATION', 'normaliseDeployedTemplate',
  'canonicalDeployedTemplateHash', 'stableTaskDefinition', 'taskDefinitionContentHash',
  'DEPLOYMENT_GATE_NAME_SUFFIX', 'DEPLOYMENT_GATE_DURATION_SECONDS',
  'DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS', 'DEPLOYMENT_GATE_REQUEST_FLOOR',
  'DEPLOYMENT_GATE_MAX_PROBES', 'DEPLOYMENT_GATE_SIGNAL_NAMES', 'DEPLOYMENT_GATE_THRESHOLDS',
  'DEPLOYMENT_GATE_COMPARISONS', 'DEPLOYMENT_SQS_DEPTH_ATTRIBUTES', 'deploymentBakeName',
  'runtimeStageFromStack', 'deploymentAlarmName', 'deploymentAlarmNames', 'deploymentQueueNames',
]);

test('every removed record/gate export is undefined and every kept export is present', () => {
  for (const name of REMOVED_EXPORTS) {
    assert.equal(pkg[name], undefined, `${name} must not be exported after #207`);
  }
  for (const name of KEPT_EXPORTS) {
    assert.notEqual(pkg[name], undefined, `${name} must stay exported`);
  }
  assert.equal(pkg.DEPLOYMENT_GATE_DURATION_SECONDS, 600);
  assert.equal(pkg.DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS, 15);
  assert.equal(pkg.DEPLOYMENT_GATE_MAX_PROBES, 40);
  assert.equal(pkg.DEPLOYMENT_GATE_REQUEST_FLOOR, 30);
  assert.equal(pkg.STAGE_CONTRACT_PARAMETERS.length, 35);
  assert.equal(pkg.STAGE_CONTRACT_CONDITIONAL_PARAMETERS.length, 1);
  assert.equal(pkg.STAGE_CONTRACT_READ_PARAMETERS.length, 36);
});
