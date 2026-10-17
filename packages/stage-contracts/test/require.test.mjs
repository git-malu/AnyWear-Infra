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
  assert.equal(loaded.STAGE_CONTRACT_PARAMETERS.length, 34);
  assert.equal(loaded.STAGE_CONTRACT_CONDITIONAL_PARAMETERS.length, 1);
  assert.equal(loaded.STAGE_CONTRACT_READ_PARAMETERS.length, 35);
  assert.equal(typeof loaded.stageParameters, 'function');
  assert.equal(typeof loaded.validateServiceDeploymentRecord, 'function');
  assert.equal(loaded.serviceDeployRoleName('service'), 'beta-service-deploy-role');
});
