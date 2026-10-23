import test from 'node:test';
import assert from 'node:assert/strict';
import { retainedBetaSizingProfile, retainedBetaSizingTelemetry } from './beta-sizing-profile.mjs';

// Sizing is a release-slice parameter. It is set by Infra's `deploy-runtime`
// operation; the state observer only reads the retained values to report Beta state.
test('a pre-profile workload reads the source defaults', () => {
  assert.equal(retainedBetaSizingProfile({}), 's1');
  assert.equal(retainedBetaSizingTelemetry({}), 'false');
  assert.equal(retainedBetaSizingProfile({ BetaApiSizingProfile: 's2-api' }), 's2-api');
  assert.equal(retainedBetaSizingTelemetry({ BetaSizingTelemetry: 'true' }), 'true');
});

test('unknown retained values fail closed and change nothing', () => {
  assert.throws(() => retainedBetaSizingProfile({ BetaApiSizingProfile: 's3' }), /Unknown retained Beta API sizing profile/);
  assert.throws(() => retainedBetaSizingTelemetry({ BetaSizingTelemetry: 'on' }), /Unknown retained Beta sizing telemetry/);
});
