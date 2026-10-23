import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPLOYMENT_GATE_COMPARISONS,
  DEPLOYMENT_GATE_DURATION_SECONDS,
  DEPLOYMENT_GATE_MAX_PROBES,
  DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS,
  DEPLOYMENT_GATE_REQUEST_FLOOR,
  DEPLOYMENT_GATE_SIGNAL_NAMES,
  DEPLOYMENT_GATE_THRESHOLDS,
  deploymentAlarmName,
  deploymentAlarmNames,
  deploymentBakeName,
  deploymentQueueNames,
  runtimeStageFromStack,
} from '../index.mjs';

// Issue #207 retired the record-gate block validator, so this file now owns only
// the stage-free bake-control surface the package still ships: the 300-second
// window, the probe budget, the six fixed ordered signal names, the one threshold
// table and the name builders. A breached or short signal is refused by the bake
// itself in AnyWear-Infra's `scripts/bake-gate.mjs`; its test file owns that
// behavioural coverage.
test('the threshold table and comparison strings are stage-free; only names carry the stage', () => {
  assert.equal(DEPLOYMENT_GATE_DURATION_SECONDS, 300);
  assert.equal(DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS, 15);
  assert.equal(DEPLOYMENT_GATE_REQUEST_FLOOR, 15);
  assert.equal(DEPLOYMENT_GATE_MAX_PROBES, 20);
  assert.deepEqual([...DEPLOYMENT_GATE_SIGNAL_NAMES], [
    'alb_5xx_rate', 'alb_p95_latency', 'ecs_running_not_desired',
    'sqs_oldest_message_age', 'sqs_dlq_depth', 'outbox_oldest_age',
  ]);
  assert.deepEqual(Object.keys(DEPLOYMENT_GATE_THRESHOLDS).sort(), [...DEPLOYMENT_GATE_SIGNAL_NAMES].sort());
  const serialized = JSON.stringify(DEPLOYMENT_GATE_THRESHOLDS);
  for (const stage of ['beta', 'prod']) {
    assert.equal(serialized.includes(stage), false);
    for (const name of DEPLOYMENT_GATE_SIGNAL_NAMES) assert.equal(DEPLOYMENT_GATE_THRESHOLDS[name][stage], undefined);
  }
  assert.deepEqual(DEPLOYMENT_GATE_COMPARISONS, {
    alb_5xx_rate: 'sum(target_5xx, elb_5xx) > max_5xx; request_count < min_requests is insufficient',
    alb_p95_latency: 'p95_milliseconds > max_milliseconds',
    ecs_running_not_desired: 'longest_gap_seconds >= max_gap_seconds; a non-single or non-COMPLETED deployment is breaching',
    sqs_oldest_message_age: 'max(vto_seconds, auto_tagging_seconds) > max_seconds',
    sqs_dlq_depth: 'vto_depth + auto_tagging_depth > max_depth',
    outbox_oldest_age: 'oldest_age_milliseconds > max_age_milliseconds; backlog > 0 with a null age is breaching',
  });
  const beta = deploymentAlarmNames('beta');
  const prod = deploymentAlarmNames('prod');
  assert.deepEqual(Object.keys(beta), [...DEPLOYMENT_GATE_SIGNAL_NAMES]);
  for (const name of DEPLOYMENT_GATE_SIGNAL_NAMES) {
    assert.deepEqual(prod[name], beta[name].map((alarm) => alarm.replace(/^beta-/, 'prod-')));
  }
  assert.deepEqual(beta.alb_5xx_rate, ['beta-anywear-alb-5xx']);
  assert.deepEqual(beta.sqs_dlq_depth, ['beta-anywear-vto-dlq-not-empty', 'beta-anywear-auto-tagging-dlq-not-empty']);
  assert.deepEqual(deploymentQueueNames('beta'), {
    vto: 'beta-anywear-vto',
    vto_dlq: 'beta-anywear-vto-dlq',
    auto_tagging: 'beta-anywear-auto-tagging',
    auto_tagging_dlq: 'beta-anywear-auto-tagging-dlq',
  });
  assert.equal(deploymentBakeName('beta'), 'beta-anywear-deployment-bake');
  assert.throws(() => deploymentAlarmName('beta', 'nope'), /Unknown deployment gate signal/);
  assert.throws(() => deploymentBakeName('Beta'), /Invalid deployment stage/);
  assert.equal(runtimeStageFromStack('AnyWearRuntimeStack-prod'), 'prod');
  assert.throws(() => runtimeStageFromStack('AnyWearPlatformStack-beta'), /Invalid Runtime stack identity/);
});
