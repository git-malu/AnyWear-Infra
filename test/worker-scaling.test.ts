import { readFileSync } from 'node:fs';
import path from 'node:path';
import { App, type Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { PLATFORM_REGION, platformInputs, type Stage } from '../lib/platform-inputs';
import { RuntimeStack } from '../lib/runtime-stack';

// The defect: the worker's single step-scaling policy used a Visible-only SQS
// depth signal for both directions, so a task claiming a message made the signal
// read zero while that work was still running and the lower policy stopped the
// task holding it. The fix splits the paths: scale-out keeps Visible-only, and
// scale-in reads Visible + NotVisible on both queues for two consecutive periods.
// This test pins that split in the synthesized Beta and Prod templates, so a
// re-record cannot silently return the scale-in path to the waiting-only signal.

const infraRoot = path.resolve(__dirname, '..');

const VARIANTS = [
  { name: 'beta-active', stage: 'beta' as Stage, stackName: 'AnyWearRuntimeStack-beta' },
  { name: 'prod-active', stage: 'prod' as Stage, stackName: 'AnyWearRuntimeStack-prod' },
];

function templateFor(variant: (typeof VARIANTS)[number]): any {
  // Same synthesis path and recorded cdk.json context as the identity proof.
  const app = new App({ context: JSON.parse(readFileSync(path.join(infraRoot, 'cdk.json'), 'utf8')).context });
  const stack = new RuntimeStack(app, variant.stackName, {
    stage: variant.stage,
    env: { account: '650880818323', region: PLATFORM_REGION },
    platform: (scope: Stack) => platformInputs(scope, {
      stage: variant.stage,
      identityPhase: 'legacy',
    }),
  });
  return Template.fromStack(stack).toJSON();
}

/** The one resource whose logical ID contains the fragment, or a failed assertion. */
function resourceWith(template: any, fragment: string): any {
  const matches = Object.entries(template.Resources).filter(([logicalId]) => logicalId.includes(fragment));
  expect(matches.map(([logicalId]) => logicalId)).toHaveLength(1);
  return (matches[0] as [string, any])[1];
}

const metricEntries = (alarm: any): any[] => alarm.Properties.Metrics;
const metricStats = (alarm: any): any[] => metricEntries(alarm).filter((metric) => metric.MetricStat);
const statsNamed = (alarm: any, metricName: string): any[] =>
  metricStats(alarm).filter((metric) => metric.MetricStat.Metric.MetricName === metricName);
const queueRefs = (alarm: any): string[] => [...new Set(metricStats(alarm).map((metric) =>
  metric.MetricStat.Metric.Dimensions.find((dimension: any) => dimension.Name === 'QueueName')?.Value?.Ref))];

const oldLowerPolicy = 'ComputeRuntimeWorkerServiceTaskCountTargetQueueDepthScalingLowerPolicy91A7F542';
const oldLowerAlarm = 'ComputeRuntimeWorkerServiceTaskCountTargetQueueDepthScalingLowerAlarm2A871303';

test.each(VARIANTS.map((variant) => [variant.name, variant] as const))(
  '%s keeps the visible-only scale-out signal and adds the outstanding scale-in signal',
  (name, variant) => {
    const template = templateFor(variant);

    // Scale out: unchanged. Only waiting work adds capacity; the two upper
    // intervals and the threshold-1 alarm are the pre-fix scale-out pair.
    const upperAlarm = resourceWith(template, 'QueueDepthScalingUpperAlarm');
    expect(upperAlarm.Properties.Metrics[0].Expression).toBe('vto + tagging');
    expect(upperAlarm.Properties.ComparisonOperator).toBe('GreaterThanOrEqualToThreshold');
    expect(upperAlarm.Properties.Threshold).toBe(1);
    expect(upperAlarm.Properties.EvaluationPeriods).toBe(1);
    expect(statsNamed(upperAlarm, 'ApproximateNumberOfMessagesVisible')).toHaveLength(2);
    expect(metricStats(upperAlarm)).toHaveLength(2);
    expect(queueRefs(upperAlarm)).toHaveLength(2);

    const upperPolicy = resourceWith(template, 'QueueDepthScalingUpperPolicy');
    expect(upperPolicy.Properties.PolicyType).toBe('StepScaling');
    expect(upperPolicy.Properties.StepScalingPolicyConfiguration).toEqual({
      AdjustmentType: 'ChangeInCapacity',
      Cooldown: 60,
      StepAdjustments: [
        { MetricIntervalLowerBound: 0, MetricIntervalUpperBound: 9, ScalingAdjustment: 1 },
        { MetricIntervalLowerBound: 9, ScalingAdjustment: 2 },
      ],
    });

    // Scale in: the new pair reads waiting plus claimed on both queues, requires
    // two consecutive 60-second periods and removes exactly one task at <= 0.
    const drainPolicy = resourceWith(template, 'QueueDrainScalingLowerPolicy');
    const drainAlarm = resourceWith(template, 'QueueDrainScalingLowerAlarm');
    expect(drainAlarm.Properties.ComparisonOperator).toBe('LessThanOrEqualToThreshold');
    expect(drainAlarm.Properties.Threshold).toBe(0);
    expect(drainAlarm.Properties.EvaluationPeriods).toBe(2);
    expect(drainAlarm.Properties.Metrics[0].Expression)
      .toBe('vto_visible + vto_inflight + tagging_visible + tagging_inflight');
    expect(metricStats(drainAlarm)).toHaveLength(4);
    expect(statsNamed(drainAlarm, 'ApproximateNumberOfMessagesVisible')).toHaveLength(2);
    expect(statsNamed(drainAlarm, 'ApproximateNumberOfMessagesNotVisible')).toHaveLength(2);
    expect(queueRefs(drainAlarm)).toHaveLength(2);
    expect(drainPolicy.Properties.PolicyType).toBe('StepScaling');
    expect(drainPolicy.Properties.StepScalingPolicyConfiguration).toEqual({
      AdjustmentType: 'ChangeInCapacity',
      Cooldown: 60,
      StepAdjustments: [{ MetricIntervalUpperBound: 0, ScalingAdjustment: -1 }],
    });
    expect(drainAlarm.Properties.AlarmActions).toEqual([{ Ref: Object.keys(template.Resources)
      .find((logicalId) => logicalId.includes('QueueDrainScalingLowerPolicy')) }]);

    // The old lower pair, which scaled in on the Visible-only signal, is gone
    // entirely: a policy may not keep scaling in on waiting messages alone.
    expect(template.Resources).not.toHaveProperty(oldLowerPolicy);
    expect(template.Resources).not.toHaveProperty(oldLowerAlarm);
    expect(Object.keys(template.Resources).filter((logicalId) => logicalId.includes('QueueDepthScalingLower')))
      .toEqual([]);
  },
);
