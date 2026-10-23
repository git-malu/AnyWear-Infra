import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// AnyWear-Infra's CDK app compiles to CommonJS (`module: NodeNext` with no
// `"type": "module"` in the repository root), so it loads this ESM package through
// Node 24's synchronous `require()` of an ES module. This test fixes that
// consumption path explicitly; the ESM import path is every other test here.
const require = createRequire(import.meta.url);

test('Node 24 CommonJS require() can load the ESM package', () => {
  const loaded = require('../index.mjs');
  assert.equal(loaded.STAGE_CONTRACT_STAGE, 'beta');
  assert.equal(loaded.STAGE_CONTRACT_PARAMETERS.length, 35);
  assert.equal(loaded.STAGE_CONTRACT_CONDITIONAL_PARAMETERS.length, 1);
  assert.equal(loaded.STAGE_CONTRACT_READ_PARAMETERS.length, 36);
  assert.equal(typeof loaded.stageParameters, 'function');
  // Issue #207: the record/gate-block validator is gone; the bake-control builders
  // and the template/task-definition identity are what a CommonJS consumer loads.
  assert.equal(typeof loaded.validateDeploymentGate, 'undefined');
  assert.equal(typeof loaded.validateServiceDeploymentRecord, 'undefined');
  assert.equal(typeof loaded.deploymentAlarmNames, 'function');
  assert.equal(loaded.DEPLOYMENT_GATE_DURATION_SECONDS, 300);
  assert.equal(typeof loaded.normaliseDeployedTemplate, 'function');
  assert.equal(typeof loaded.canonicalDeployedTemplateHash, 'function');
  assert.equal(typeof loaded.stableTaskDefinition, 'function');
  assert.equal(loaded.SERVICE_RUNTIME_STACK.workflow_path, '.github/workflows/mutate.yml');
  assert.equal(loaded.serviceDeployRoleName, undefined);
});
