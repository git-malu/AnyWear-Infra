import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { App, type Stack } from 'aws-cdk-lib';
import { deploymentAlarmName } from '@git-malu/stage-contracts';
import { PLATFORM_REGION, platformInputs, type Stage } from '../lib/platform-inputs';
import { BOOTSTRAP_QUALIFIER, RuntimeStack } from '../lib/runtime-stack';

// Synthesizing a cloud assembly is a little slower than building an in-memory
// template; keep the default Jest timeout out of the way of the identity proof.
jest.setTimeout(180_000);

const infraRoot = path.resolve(__dirname, '..');
const baselines = path.join(infraRoot, 'test', 'baselines');
const provenance = JSON.parse(readFileSync(path.join(baselines, 'provenance.json'), 'utf8')).runtime_identity;
const cdkContext = JSON.parse(readFileSync(path.join(infraRoot, 'cdk.json'), 'utf8')).context;
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const assetsBucket = `cdk-${BOOTSTRAP_QUALIFIER}-assets-650880818323-ap-east-1`;

const VARIANTS = [
  { name: 'beta-active', stage: 'beta' as Stage, stackName: 'AnyWearRuntimeStack-beta' },
  { name: 'prod-active', stage: 'prod' as Stage, stackName: 'AnyWearRuntimeStack-prod' },
];

/**
 * Synthesize the real cloud assembly for one recorded legacy-phase variant.
 * The recorded baseline was synthesized from this source with the same
 * `cdk.json` context, so its template hash is the identity to preserve.
 */
function synthesize(variant: (typeof VARIANTS)[number]) {
  const outdir = mkdtempSync(path.join(tmpdir(), 'anywear-runtime-assembly-'));
  try {
    const app = new App({ outdir, context: cdkContext });
    new RuntimeStack(app, variant.stackName, {
      stage: variant.stage,
      env: { account: '650880818323', region: PLATFORM_REGION },
      platform: (scope: Stack) => platformInputs(scope, {
        stage: variant.stage,
        identityPhase: 'legacy',
      }),
    });
    app.synth();
    const manifestText = readFileSync(path.join(outdir, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    const artifact = manifest.artifacts[variant.stackName];
    const assetsText = readFileSync(path.join(outdir, `${variant.stackName}.assets.json`), 'utf8');
    return {
      manifest,
      manifestText,
      artifact,
      assets: JSON.parse(assetsText),
      assetsText,
      template: JSON.parse(readFileSync(path.join(outdir, artifact.properties.templateFile), 'utf8')),
      templateSha256: sha256(readFileSync(path.join(outdir, artifact.properties.templateFile))),
    };
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

test.each(VARIANTS.map((variant) => [variant.name, variant] as const))(
  '%s maps a JSON metric value with a JSON filter pattern',
  (name, variant) => {
    const { template } = synthesize(variant);
    const filters = Object.entries(template.Resources).filter(([, resource]: [string, any]) =>
      resource.Type === 'AWS::Logs::MetricFilter');
    expect(filters.length).toBeGreaterThan(0);
    // CloudWatch Logs rejects a `$.field` metric value under a literal text
    // pattern ("requires metric values to be static numbers"). Every filter that
    // extracts a JSON field must therefore use a JSON filter pattern.
    for (const [, filter] of filters as Array<[string, any]>) {
      for (const transformation of filter.Properties.MetricTransformations ?? []) {
        if (!String(transformation.MetricValue).startsWith('$.')) continue;
        const pattern = String(filter.Properties.FilterPattern).trim();
        expect(pattern.startsWith('{')).toBe(true);
        expect(pattern.endsWith('}')).toBe(true);
      }
    }
    // The outbox filter selects the pino `msg` field and keeps the JSON metric
    // value; the default covers a null outboxOldestAgeMs on an empty backlog.
    const outbox = filters.find(([, filter]: [string, any]) =>
      filter.Properties.MetricTransformations?.some((transformation: any) =>
        transformation.MetricName === 'OutboxOldestAgeMs'));
    expect(outbox).toBeDefined();
    const outboxFilter = (outbox as [string, any])[1];
    expect(outboxFilter.Properties.FilterPattern).toContain('$.msg');
    expect(outboxFilter.Properties.FilterPattern).toContain('Durable task outbox metrics');
    expect(outboxFilter.Properties.MetricTransformations[0].MetricValue).toBe('$.outboxOldestAgeMs');
    expect(outboxFilter.Properties.MetricTransformations[0].DefaultValue).toBe(0);
  });

test.each(VARIANTS.map((variant) => [variant.name, variant] as const))(
  '%s uses supported metric math for the ALB 5xx alarm',
  (name, variant) => {
    const { template } = synthesize(variant);
    const alarms = Object.entries(template.Resources).filter(([, resource]: [string, any]) =>
      resource.Type === 'AWS::CloudWatch::Alarm');
    expect(alarms.length).toBeGreaterThan(0);
    // CloudWatch metric math's MAX/MIN/AVG take time series; an array form may
    // contain several time series, but a scalar literal in that array mixes the
    // types and is rejected at CREATE. (The ECS alarm's MAX over two time series
    // is valid and must stay allowed.)
    for (const [, alarm] of alarms as Array<[string, any]>) {
      for (const metric of alarm.Properties.Metrics ?? []) {
        if (typeof metric.Expression !== 'string') continue;
        for (const match of metric.Expression.matchAll(/\b(?:MAX|MIN|AVG)\s*\(\s*\[([^\]]*)\]/g)) {
          expect(match[1]).not.toMatch(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/);
        }
      }
    }
    const alarmNames = alarms.map(([, alarm]: [string, any]) => alarm.Properties.AlarmName);
    // The other three bake alarms stay present; only the 5xx expression changed.
    for (const signal of ['alb_p95_latency', 'ecs_running_not_desired', 'outbox_oldest_age']) {
      expect(alarmNames).toContain(deploymentAlarmName(variant.stage, signal)[0]);
    }
    const alb5xx = (alarms as Array<[string, any]>).find(([, alarm]) =>
      alarm.Properties.AlarmName === deploymentAlarmName(variant.stage, 'alb_5xx_rate')[0]);
    expect(alb5xx).toBeDefined();
    const alb5xxAlarm = (alb5xx as [string, any])[1];
    const expressionMetric = alb5xxAlarm.Properties.Metrics.find((metric: any) =>
      typeof metric.Expression === 'string');
    expect(expressionMetric.Expression)
      .toBe('IF(requests > 0, 100 * (target5xx + elb5xx) / requests, 0)');
    const metricIds = alb5xxAlarm.Properties.Metrics.map((metric: any) => metric.Id);
    for (const id of ['target5xx', 'elb5xx', 'requests', 'expr_1']) expect(metricIds).toContain(id);
  });


test.each(VARIANTS.map((variant) => [variant.name, variant] as const))(
  '%s synthesizes the standard CDK bootstrap cloud assembly with the recorded template bytes',
  (name, variant) => {
    const { manifest, artifact, assets, manifestText, assetsText, templateSha256 } = synthesize(variant);
    expect(artifact.type).toBe('aws:cloudformation:stack');
    // Issue #195: the Runtime stack moved into Infra and deploys through the
    // standard CDK bootstrap path that `beta-infra-deploy-role` already assumes.
    // The assembly names the bootstrap deploy, file-publishing and cfn-exec
    // roles explicitly, and the template asset is still the recorded bytes.
    expect(artifact.properties.assumeRoleArn)
      .toBe(`arn:\${AWS::Partition}:iam::650880818323:role/cdk-${BOOTSTRAP_QUALIFIER}-deploy-role-650880818323-ap-east-1`);
    expect(manifestText).toContain(`cdk-${BOOTSTRAP_QUALIFIER}-deploy-role`);
    // The parent design check (#195): the CloudFormation execution role the
    // deploy passes is the bootstrap cfn-exec role, never the retired
    // beta-service-deploy-cfn-role and never an explicit `--role-arn` override.
    expect(artifact.properties.cloudFormationExecutionRoleArn)
      .toBe(`arn:\${AWS::Partition}:iam::650880818323:role/cdk-${BOOTSTRAP_QUALIFIER}-cfn-exec-role-650880818323-ap-east-1`);
    expect(artifact.properties.stackTemplateAssetObjectUrl)
      .toMatch(new RegExp(`^s3://${assetsBucket}/[a-f0-9]{64}\\.json$`));

    const files = Object.values(assets.files as Record<string, {
      displayName: string; destinations: Record<string, Record<string, unknown>>;
    }>);
    expect(files).toHaveLength(1);
    for (const file of files) {
      expect(file.displayName).toContain('Template');
      const destinations = Object.values(file.destinations);
      expect(destinations).toHaveLength(1);
      for (const destination of destinations) {
        expect(destination.bucketName).toBe(assetsBucket);
        expect(destination.assumeRoleArn)
          .toBe(`arn:\${AWS::Partition}:iam::650880818323:role/cdk-${BOOTSTRAP_QUALIFIER}-file-publishing-role-650880818323-ap-east-1`);
      }
    }
    expect(assetsText).toContain(`cdk-${BOOTSTRAP_QUALIFIER}-file-publishing-role`);

    // No context lookup is declared, so the CLI never needs the bootstrap
    // lookup role either.
    expect(manifest.missing ?? []).toEqual([]);

    // The template identity is unchanged: this is the recorded template hash
    // for the same variant, source and CDK context.
    expect(templateSha256).toBe(provenance.templates[`${variant.name}/${variant.stackName}.template.json`]);
  },
);
