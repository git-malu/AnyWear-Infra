import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBetaSizingInput, selectBetaSizingProfile, validateBetaTelemetryInput,
  selectBetaSizingTelemetry } from './beta-sizing-profile.mjs';
import { cdkDeploymentArguments } from './runtime-operation.mjs';

const operations = ['observe', 'state', 'deploy-platform', 'deploy-foundation', 'deploy-billing',
  'restore-release', 'migrate', 'verify', 'admission-status', 'add-testers', 'set-testers',
  'suspend-admission', 'resume-admission'];

test('defaults to preserve and permits an explicit sizing change only for deploy-workload', () => {
  for (const operation of operations) {
    assert.equal(validateBetaSizingInput({ INFRA_OPERATION: operation }), 'preserve');
    for (const profile of ['s1', 's2-api', 'invalid', '', null]) {
      assert.throws(() => validateBetaSizingInput({ INFRA_OPERATION: operation, INFRA_BETA_API_SIZING_PROFILE: profile }));
    }
  }
  for (const profile of ['preserve', 's1', 's2-api']) {
    assert.equal(validateBetaSizingInput({ INFRA_OPERATION: 'deploy-workload', INFRA_BETA_API_SIZING_PROFILE: profile }), profile);
  }
});

test('telemetry defaults to preserve and rejects explicit or malformed input outside deploy-workload', () => {
  for (const operation of operations) {
    assert.equal(validateBetaTelemetryInput({ INFRA_OPERATION: operation }), 'preserve');
    for (const input of ['enable', 'disable', 'true', 'false', '', null]) {
      assert.throws(() => validateBetaTelemetryInput({ INFRA_OPERATION: operation, INFRA_BETA_SIZING_TELEMETRY: input }));
    }
  }
  for (const input of ['preserve', 'enable', 'disable']) {
    assert.equal(validateBetaTelemetryInput({ INFRA_OPERATION: 'deploy-workload', INFRA_BETA_SIZING_TELEMETRY: input }), input);
  }
  for (const input of ['true', 'false', '', null]) {
    assert.throws(() => validateBetaTelemetryInput({ INFRA_OPERATION: 'deploy-workload', INFRA_BETA_SIZING_TELEMETRY: input }));
  }
});

test('both retained sizing parameters flow through the resident workload deployment arguments', () => {
  for (const operation of ['deploy-workload', 'restore-release']) {
    for (const profile of ['s1', 's2-api']) for (const telemetry of ['true', 'false']) {
      const revision = { parameters: { BetaApiSizingProfile: profile, BetaSizingTelemetry: telemetry } };
      const args = cdkDeploymentArguments('AnyWearWorkloadStack-beta', revision, '/verified', { INFRA_OPERATION: operation });
      assert.ok(args.includes(`AnyWearWorkloadStack-beta:BetaApiSizingProfile=${profile}`));
      assert.ok(args.includes(`AnyWearWorkloadStack-beta:BetaSizingTelemetry=${telemetry}`));
    }
  }
  assert.equal(selectBetaSizingTelemetry({}, { INFRA_OPERATION: 'deploy-workload' }), 'false');
  for (const invalid of ['enable', '', null, false]) {
    assert.throws(() => selectBetaSizingTelemetry({ BetaSizingTelemetry: invalid }, { INFRA_OPERATION: 'deploy-workload' }));
  }
  for (const input of ['enable', 'disable']) {
    const env = { INFRA_OPERATION: 'deploy-workload', INFRA_BETA_SIZING_TELEMETRY: input };
    assert.equal(selectBetaSizingTelemetry({}, env), input === 'enable' ? 'true' : 'false');
  }
});

test('preserves either retained profile through protected Workload arguments', () => {
  for (const operation of ['deploy-workload', 'restore-release']) {
    for (const profile of ['s1', 's2-api']) {
      const revision = { parameters: { ServiceCommitSha: 'a'.repeat(40), ServiceImageDigest: `sha256:${'b'.repeat(64)}`,
        BetaApiSizingProfile: profile } };
      const args = cdkDeploymentArguments('AnyWearWorkloadStack-beta', revision, '/verified', { INFRA_OPERATION: operation });
      assert.ok(args.includes(`AnyWearWorkloadStack-beta:BetaApiSizingProfile=${profile}`));
    }
  }
  assert.equal(selectBetaSizingProfile({}, { INFRA_OPERATION: 'deploy-workload' }), 's1');
  for (const invalid of ['other', '', null, 0]) {
    assert.throws(() => selectBetaSizingProfile({ BetaApiSizingProfile: invalid }, { INFRA_OPERATION: 'deploy-workload' }));
  }
});

test('the resident deploy arguments never switch activity or request a no-rollback deploy', () => {
  const args = cdkDeploymentArguments('AnyWearWorkloadStack-beta', { parameters: {} }, '/verified', { INFRA_OPERATION: 'deploy-workload' });
  assert.equal(args.includes('--no-rollback'), false);
  assert.equal(args.some(value => value.startsWith('environmentRunning=')), false);
  assert.ok(args.includes('legacyRoleSource=external'));
  assert.ok(args.includes('artifactDirectory=/verified'));
});
