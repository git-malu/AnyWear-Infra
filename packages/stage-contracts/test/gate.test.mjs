import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPLOYMENT_GATE_ALARM_STATES,
  DEPLOYMENT_GATE_COMPARISONS,
  DEPLOYMENT_GATE_SIGNAL_NAMES,
  DEPLOYMENT_GATE_THRESHOLDS,
  deploymentAlarmName,
  deploymentAlarmNames,
  deploymentBakeName,
  deploymentQueueNames,
  validateDeploymentGate,
  workloadStageFromStack,
} from '../index.mjs';
import { ENDED_AT, IMAGE_DIGEST, SERVICE_SHA, STARTED_AT, gateBlock } from './gate-fixture.mjs';

const clone = () => structuredClone(gateBlock());
const withChange = (change) => {
  const gate = clone();
  change(gate);
  return gate;
};
const signal = (gate, name) => gate.signals.find((entry) => entry.name === name);

test('a healthy 600-second gate with the six fixed signals validates', () => {
  const gate = clone();
  assert.deepEqual(validateDeploymentGate(gate, 'beta'), gate);
  assert.deepEqual(gate.signals.map((entry) => entry.name), [...DEPLOYMENT_GATE_SIGNAL_NAMES]);
  assert.equal(gate.name, 'beta-anywear-deployment-bake');
  assert.equal(gate.name, deploymentBakeName('beta'));
  assert.equal(gate.duration_seconds, 600);
  assert.equal(Date.parse(gate.ended_at) - Date.parse(gate.started_at), 600_000);
  assert.equal(gate.probe.interval_seconds, 15);
  assert.equal(gate.probe.request_floor, 30);
});

test('the threshold table and comparison strings are stage-free; only names carry the stage', () => {
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
  assert.throws(() => deploymentAlarmName('beta', 'nope'), /Unknown deployment gate signal/);
  assert.throws(() => deploymentBakeName('Beta'), /Invalid deployment stage/);
  assert.equal(workloadStageFromStack('AnyWearWorkloadStack-prod'), 'prod');
  assert.throws(() => workloadStageFromStack('AnyWearPlatformStack-beta'), /Invalid Workload stack identity/);
});

test('the window must be exactly 600 seconds with a coherent duration', () => {
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    gate.ended_at = ENDED_AT.replace('00:10', '00:09');
  }), 'beta'), /not exactly 600 seconds/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => { gate.duration_seconds = 599; }), 'beta'),
    /Invalid deployment gate duration/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => { gate.started_at = 'yesterday'; }), 'beta'),
    /Invalid deployment gate start/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => { gate.result = 'failed'; }), 'beta'),
    /did not pass/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => { gate.name = 'anywear-deployment-bake'; }), 'beta'),
    /Invalid deployment gate name/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => { gate.service_sha = 'b'.repeat(39); }), 'beta'),
    /Invalid deployment gate Service/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => { gate.image_digest = SERVICE_SHA; }), 'beta'),
    /Invalid deployment gate image/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => { gate.extra = true; }), 'beta'),
    /Invalid deployment gate fields/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => { gate.started_at = STARTED_AT; gate.ended_at = IMAGE_DIGEST; }), 'beta'),
    /Invalid deployment gate end/);
});

test('the probe budget fails closed below 30 or above the 40-probe window', () => {
  assert.throws(() => validateDeploymentGate(withChange((gate) => { gate.probe.probes_sent = 29; }), 'beta'),
    /Insufficient deployment gate probes/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => { gate.probe.probes_sent = 41; }), 'beta'),
    /Insufficient deployment gate probes/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => { gate.probe.interval_seconds = 5; }), 'beta'),
    /Invalid deployment gate probe budget/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => { gate.probe.request_floor = 20; }), 'beta'),
    /Invalid deployment gate probe budget/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => { gate.probe.probes_sent = '40'; }), 'beta'),
    /Invalid deployment gate probes/);
});

test('signals are fixed in order and every one is required', () => {
  assert.throws(() => validateDeploymentGate(withChange((gate) => { gate.signals.pop(); }), 'beta'),
    /exactly six signals/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    const [first, second] = gate.signals;
    gate.signals[0] = second;
    gate.signals[1] = first;
  }), 'beta'), /not in fixed order/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => { gate.signals[3].name = 'sqs_dlq_depth'; }), 'beta'),
    /not in fixed order/);
});

test('a breaching value cannot be recorded as not-breaching', () => {
  const breaches = [
    ['alb_5xx_rate', (value) => { value.target_5xx = 1; }],
    ['alb_5xx_rate', (value) => { value.elb_5xx = 1; }],
    ['alb_p95_latency', (value) => { value.p95_milliseconds = 5001; }],
    ['ecs_running_not_desired', (value) => { value.longest_gap_seconds = 120; }],
    ['ecs_running_not_desired', (value) => { value.services.api.deployment_count = 2; }],
    ['ecs_running_not_desired', (value) => { value.services.worker.rollout_state = 'IN_PROGRESS'; }],
    ['sqs_oldest_message_age', (value) => { value.vto_seconds = 301; }],
    ['sqs_oldest_message_age', (value) => { value.auto_tagging_seconds = 301; }],
    ['sqs_dlq_depth', (value) => { value.vto_depth = 1; }],
    ['sqs_dlq_depth', (value) => { value.auto_tagging_depth = 1; }],
    ['outbox_oldest_age', (value) => { value.oldest_age_milliseconds = 300_001; }],
    ['outbox_oldest_age', (value) => { value.oldest_age_milliseconds = null; value.backlog = 1; }],
  ];
  for (const [name, change] of breaches) {
    assert.throws(() => validateDeploymentGate(withChange((gate) => change(signal(gate, name).value)), 'beta'),
      /is breaching/, `${name} must fail closed`);
  }
  // The same value with an explicit non-passing state is refused too.
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'sqs_dlq_depth').state = 'breaching';
  }), 'beta'), /signal sqs_dlq_depth is breaching/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'outbox_oldest_age').state = 'insufficient';
  }), 'beta'), /signal outbox_oldest_age is insufficient/);
});

test('missing, delayed or short data is insufficient and refused', () => {
  assert.throws(() => validateDeploymentGate(withChange((gate) => { signal(gate, 'alb_5xx_rate').value.request_count = 29; }), 'beta'),
    /Insufficient deployment gate requests/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => { signal(gate, 'alb_5xx_rate').reads[2].datapoints = 9; }), 'beta'),
    /Invalid deployment gate RequestCount read/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => { signal(gate, 'alb_p95_latency').reads[0].datapoints = 0; }), 'beta'),
    /Invalid deployment gate TargetResponseTime read/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'ecs_running_not_desired').value.max_sample_gap_seconds = 121;
  }), 'beta'), /Insufficient deployment gate ECS sample cadence/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'ecs_running_not_desired').value.samples = 14;
  }), 'beta'), /Insufficient deployment gate ECS samples/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'sqs_oldest_message_age').reads[2].samples = 14;
  }), 'beta'), /Insufficient deployment gate SQS depth samples/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'outbox_oldest_age').value.lines_observed = 4;
  }), 'beta'), /Insufficient deployment gate outbox log samples/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'outbox_oldest_age').reads[0].samples = 4;
  }), 'beta'), /Insufficient deployment gate outbox log samples/);
});

test('the deployed alarm names and observed states are validated, not used as pass criteria', () => {
  for (const state of DEPLOYMENT_GATE_ALARM_STATES) {
    assert.equal(validateDeploymentGate(withChange((gate) => {
      signal(gate, 'sqs_dlq_depth').alarms.forEach((alarm) => { alarm.state = state; });
    }), 'beta').signals[4].alarms[0].state, state);
  }
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'alb_5xx_rate').alarms[0].name = 'prod-anywear-alb-5xx';
  }), 'beta'), /Invalid deployment gate alb_5xx_rate alarm name/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'alb_5xx_rate').alarms[0].state = 'BREACHING';
  }), 'beta'), /Invalid deployment gate alarm state/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'sqs_dlq_depth').alarms.push({ name: 'beta-anywear-vto-dlq-not-empty', state: 'OK' });
  }), 'beta'), /Invalid deployment gate sqs_dlq_depth alarms/);
});

test('each signal read identity is exact', () => {
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'alb_5xx_rate').reads[0].metric_name = 'HTTPCode_ELB_5XX_Count';
  }), 'beta'), /Invalid deployment gate HTTPCode_Target_5XX_Count read/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'alb_5xx_rate').reads[0].dimensions.LoadBalancer = 'app/prod-anywear-api/abc123';
  }), 'beta'), /Invalid deployment gate load balancer dimension/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'alb_5xx_rate').reads[1].dimensions.TargetGroup = 'targetgroup/beta-anywear-api/abc123';
  }), 'beta'), /Invalid deployment gate read dimensions/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'alb_p95_latency').reads[0].statistic = 'Average';
  }), 'beta'), /Invalid deployment gate TargetResponseTime read/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'ecs_running_not_desired').reads[0].cluster = 'beta-anywear-2';
  }), 'beta'), /Invalid deployment gate ECS read identity/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'ecs_running_not_desired').reads[0].services = ['beta-anywear-api'];
  }), 'beta'), /Invalid deployment gate ECS read services/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'sqs_oldest_message_age').reads[0].dimensions.QueueName = 'beta-anywear-vto-dlq';
  }), 'beta'), /Invalid deployment gate SQS age queue/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'sqs_oldest_message_age').reads[0].statistic = 'Average';
  }), 'beta'), /Invalid deployment gate sqs_oldest_message_age CloudWatch read/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'sqs_oldest_message_age').reads[2].attributes[0] = 'ApproximateNumberOfMessagesVisible';
  }), 'beta'), /Invalid deployment gate SQS depth attributes/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'sqs_dlq_depth').reads[0].attribute = 'ApproximateAgeOfOldestMessage';
  }), 'beta'), /Invalid deployment gate sqs_dlq_depth read/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'outbox_oldest_age').reads[0].log_group = '/anywear/prod/worker';
  }), 'beta'), /Invalid deployment gate logs read identity/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'outbox_oldest_age').reads[0].filter_pattern = 'outbox';
  }), 'beta'), /Invalid deployment gate logs read identity/);
});

test('the threshold and comparison are fixed per signal and the exception list is bounded', () => {
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'sqs_oldest_message_age').threshold.max_seconds = 600;
  }), 'beta'), /Invalid deployment gate sqs_oldest_message_age threshold/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'alb_p95_latency').comparison = 'p95_milliseconds >= max_milliseconds';
  }), 'beta'), /Invalid deployment gate alb_p95_latency comparison/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'outbox_oldest_age').exceptions = ['x', 'y', 'z', 'w', 'v'];
  }), 'beta'), /Invalid deployment gate outbox_oldest_age exceptions/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'outbox_oldest_age').exceptions = [''];
  }), 'beta'), /Invalid deployment gate outbox_oldest_age exception/);
  assert.throws(() => validateDeploymentGate(withChange((gate) => {
    signal(gate, 'sqs_oldest_message_age').exceptions = [42];
  }), 'beta'), /Invalid deployment gate sqs_oldest_message_age exception/);
});

test('a prod gate is validated with prod names and the same thresholds', () => {
  const prod = gateBlock('prod');
  assert.deepEqual(validateDeploymentGate(prod, 'prod'), prod);
  assert.throws(() => validateDeploymentGate(prod, 'beta'), /Invalid deployment gate name/);
  const crossed = structuredClone(prod);
  crossed.name = deploymentBakeName('beta');
  assert.throws(() => validateDeploymentGate(crossed, 'beta'), /Invalid deployment gate alb_5xx_rate alarm name/);
});
