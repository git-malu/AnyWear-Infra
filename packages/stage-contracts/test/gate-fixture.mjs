// Shared shape fixture for one healthy 600-second six-signal bake.
//
// Issue #207 retired the record gate block this fixture used to feed, so only the
// bake's own output shape remains: the six signals with their thresholds,
// comparisons, alarm names and read identities. It is a shape fixture only —
// nothing here reads AWS, the filesystem or a clock — and the behavioural tests
// live in AnyWear-Infra's `scripts/bake-gate.test.mjs`.
import {
  DEPLOYMENT_GATE_COMPARISONS,
  DEPLOYMENT_GATE_THRESHOLDS,
  deploymentAlarmName,
  deploymentBakeName,
} from '../index.mjs';

export const SERVICE_SHA = 'b'.repeat(40);
export const IMAGE_DIGEST = `sha256:${'c'.repeat(64)}`;
export const STAGE = 'beta';
export const STARTED_AT = '2026-10-18T00:00:00.000Z';
export const ENDED_AT = '2026-10-18T00:10:00.000Z';

function signal(name, value, reads, exceptions = []) {
  return {
    name,
    state: 'not-breaching',
    value,
    threshold: { ...DEPLOYMENT_GATE_THRESHOLDS[name] },
    comparison: DEPLOYMENT_GATE_COMPARISONS[name],
    alarms: deploymentAlarmName(STAGE, name).map((alarmName) => ({ name: alarmName, state: 'OK' })),
    reads,
    exceptions,
  };
}

/** One healthy gate block for `stage`; tests clone and mutate it. */
export function gateBlock(stage = STAGE) {
  const alarms = (name) => deploymentAlarmName(stage, name).map((alarmName) => ({ name: alarmName, state: 'OK' }));
  const withAlarms = (block) => ({ ...block, alarms: alarms(block.name) });
  const loadBalancer = `app/${stage}-anywear-api/0123456789abcdef`;
  const cloudWatch = (metricName, statistic, periodSeconds, datapoints) => ({
    source: 'cloudwatch',
    namespace: 'AWS/ApplicationELB',
    metric_name: metricName,
    dimensions: { LoadBalancer: loadBalancer },
    statistic,
    period_seconds: periodSeconds,
    datapoints,
  });
  return {
    name: deploymentBakeName(stage),
    result: 'passed',
    started_at: STARTED_AT,
    ended_at: ENDED_AT,
    duration_seconds: 600,
    service_sha: SERVICE_SHA,
    image_digest: IMAGE_DIGEST,
    probe: { interval_seconds: 15, probes_sent: 40, request_floor: 30 },
    signals: [
      withAlarms(signal('alb_5xx_rate', { target_5xx: 0, elb_5xx: 0, request_count: 40 }, [
        cloudWatch('HTTPCode_Target_5XX_Count', 'Sum', 60, 10),
        cloudWatch('HTTPCode_ELB_5XX_Count', 'Sum', 60, 10),
        cloudWatch('RequestCount', 'Sum', 60, 10),
      ])),
      withAlarms(signal('alb_p95_latency', { p95_milliseconds: 120 }, [
        cloudWatch('TargetResponseTime', 'p95', 600, 1),
      ])),
      withAlarms(signal('ecs_running_not_desired', {
        longest_gap_seconds: 0,
        max_sample_gap_seconds: 30,
        samples: 20,
        services: {
          api: { running_count: 1, desired_count: 1, deployment_count: 1, rollout_state: 'COMPLETED' },
          worker: { running_count: 1, desired_count: 1, deployment_count: 1, rollout_state: 'COMPLETED' },
        },
      }, [{
        source: 'ecs',
        cluster: `${stage}-anywear`,
        services: [`${stage}-anywear-api`, `${stage}-anywear-worker`],
        samples: 20,
      }])),
      withAlarms(signal('sqs_oldest_message_age', { vto_seconds: 0, auto_tagging_seconds: 0 }, [
        { source: 'cloudwatch', namespace: 'AWS/SQS', metric_name: 'ApproximateAgeOfOldestMessage',
          dimensions: { QueueName: `${stage}-anywear-vto` }, statistic: 'Maximum', period_seconds: 600, datapoints: 1 },
        { source: 'cloudwatch', namespace: 'AWS/SQS', metric_name: 'ApproximateAgeOfOldestMessage',
          dimensions: { QueueName: `${stage}-anywear-auto-tagging` }, statistic: 'Maximum', period_seconds: 600, datapoints: 1 },
        { source: 'sqs', queue_name: `${stage}-anywear-vto`,
          attributes: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible',
            'ApproximateNumberOfMessagesDelayed'], samples: 20 },
        { source: 'sqs', queue_name: `${stage}-anywear-auto-tagging`,
          attributes: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible',
            'ApproximateNumberOfMessagesDelayed'], samples: 20 },
      ], [`${stage} work queues are idle (visible, in-flight and delayed all 0); the oldest age is recorded as 0`])),
      withAlarms(signal('sqs_dlq_depth', { vto_depth: 0, auto_tagging_depth: 0 }, [
        { source: 'sqs', queue_name: `${stage}-anywear-vto-dlq`, attribute: 'ApproximateNumberOfMessages', samples: 20 },
        { source: 'sqs', queue_name: `${stage}-anywear-auto-tagging-dlq`, attribute: 'ApproximateNumberOfMessages', samples: 20 },
      ])),
      withAlarms(signal('outbox_oldest_age', { oldest_age_milliseconds: null, backlog: 0, lines_observed: 10 }, [{
        source: 'logs',
        log_group: `/anywear/${stage}/worker`,
        filter_pattern: '"Durable task outbox metrics"',
        samples: 10,
      }], ['outbox backlog is 0; the oldest age is null by construction'])),
    ],
  };
}
