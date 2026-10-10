import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBetaSizingInput, selectBetaSizingProfile } from './beta-sizing-profile.mjs';
import { cdkDeploymentArguments } from './runtime-operation.mjs';

test('defaults to preserve and permits an explicit sizing change only for deploy-workload', () => {
  for (const operation of ['start', 'stop', 'observe', 'deploy-platform', 'deploy-foundation', 'deploy-billing',
    'restore-release', 'migrate', 'verify', 'tester-status', 'tester-add', 'tester-replace', 'close-admission']) {
    assert.equal(validateBetaSizingInput({ INFRA_OPERATION: operation }), 'preserve');
    for (const profile of ['s1', 's2-api', 'invalid', '', null]) {
      assert.throws(() => validateBetaSizingInput({ INFRA_OPERATION: operation, INFRA_BETA_API_SIZING_PROFILE: profile }));
    }
  }
  for (const profile of ['preserve', 's1', 's2-api']) {
    assert.equal(validateBetaSizingInput({ INFRA_OPERATION: 'deploy-workload', INFRA_BETA_API_SIZING_PROFILE: profile }), profile);
  }
});

test('preserves either retained profile through active, stopped, start and restore Workload arguments', () => {
  for (const operation of ['deploy-workload', 'start', 'stop', 'restore-release']) {
    for (const active of [true, false]) {
      for (const profile of ['s1', 's2-api']) {
        const revision = { parameters: { ServiceCommitSha: 'a'.repeat(40), ServiceImageDigest: `sha256:${'b'.repeat(64)}`,
          BetaApiSizingProfile: profile } };
        const args = cdkDeploymentArguments('AnyWearWorkloadStack-beta', active, revision, '/verified', { INFRA_OPERATION: operation });
        assert.ok(args.includes(`AnyWearWorkloadStack-beta:BetaApiSizingProfile=${profile}`));
      }
    }
  }
  assert.equal(selectBetaSizingProfile({}, { INFRA_OPERATION: 'deploy-workload' }, true), 's1');
  for (const invalid of ['other', '', null, 0]) {
    assert.throws(() => selectBetaSizingProfile({ BetaApiSizingProfile: invalid }, { INFRA_OPERATION: 'deploy-workload' }, true));
  }
});

test('rejects a sizing override for stopped or unknown Beta before building deploy arguments', () => {
  for (const profile of ['s1', 's2-api']) {
    const env = { INFRA_OPERATION: 'deploy-workload', INFRA_BETA_API_SIZING_PROFILE: profile };
    for (const active of [false, undefined, 'true']) {
      assert.throws(() => cdkDeploymentArguments('AnyWearWorkloadStack-beta', active, { parameters: {} }, '/verified', env));
    }
  }
});
