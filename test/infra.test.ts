import * as cdk from 'aws-cdk-lib';
import { createHash } from 'node:crypto';
import { Template } from 'aws-cdk-lib/assertions';
import { BillingStack } from '../lib/billing-stack';
import { FoundationStack } from '../lib/foundation-stack';
import { DEFAULT_QWEATHER_API_HOST, PlatformStack } from '../lib/platform-stack';
import { WorkloadStack } from '../lib/workload-stack';
import runtimePolicies from './fixtures/runtime-policy.json';
import * as path from 'node:path';
import type { ArtifactInputs } from '../lib/artifact-inputs';
import { readIdentityPhase } from '../lib/identity-phase';
import type { IdentityPhase } from '../lib/identity-phase';
const artifactInputs: ArtifactInputs = {
  lambdas: {
    'pre-sign-up': { path: path.resolve(__dirname, 'fixtures/placeholder.zip') },
    'post-confirmation': { path: path.resolve(__dirname, 'fixtures/placeholder.zip') },
  },
  runtimePolicy: runtimePolicies,
};
import cdkConfig from '../cdk.json';

function synthesizePlatform(stage: string, betaActive?: boolean, identityPhase?: IdentityPhase): Record<string, any> {
  const app = new cdk.App();
  const stack = new PlatformStack(app, `AnyWearPlatformStack-${stage}`, { stage, betaActive, artifactInputs, identityPhase });
  return Template.fromStack(stack).toJSON();
}

function synthesizeWorkload(stage: 'beta' | 'prod', betaActive?: boolean, identityPhase?: IdentityPhase): Record<string, any> {
  const app = new cdk.App();
  const platform = new PlatformStack(app, `AnyWearPlatformStack-${stage}`, { stage, betaActive, artifactInputs, identityPhase });
  const workload = new WorkloadStack(app, `AnyWearWorkloadStack-${stage}`, { stage, platform, betaActive, identityPhase });
  return Template.fromStack(workload).toJSON();
}

function synthesizeFoundation(identityPhase?: IdentityPhase): Record<string, any> {
  const app = new cdk.App();
  return Template.fromStack(new FoundationStack(app, 'AnyWearFoundationStack', { identityPhase, legacyRoleOwnership: 'managed' })).toJSON();
}

function synthesizeBilling(): Record<string, any> {
  const app = new cdk.App();
  return Template.fromStack(new BillingStack(app, 'AnyWearBillingStack-beta', { stage: 'beta' })).toJSON();
}

function hasFunctionNamed(template: Record<string, any>, functionName: string): boolean {
  return Object.values(template.Resources).some((resource: any) => (
    resource.Type === 'AWS::Lambda::Function'
      && resource.Properties?.FunctionName === functionName
  ));
}

function pipelinePolicies(template: Record<string, any>, stage: string): any[] {
  return Object.values(template.Resources).filter((resource: any) => (
    ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)
      && resource.Properties.Roles?.includes(`${stage}-github-actions-pipeline-role`)
  ));
}

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function effectivePipelineGrantHash(template: Record<string, any>, stage: string): string {
  // Normalize authorization, not statement packing; preserve intrinsic/condition array order.
  const grants = pipelinePolicies(template, stage).flatMap((policy) => policy.Properties.PolicyDocument.Statement)
    .flatMap((statement: any) => {
      expect(Object.keys(statement).every((key) => ['Action', 'Resource', 'Effect', 'Condition'].includes(key))).toBe(true);
      return [statement.Action].flat().flatMap((Action) => [statement.Resource].flat().map((Resource) => (
        JSON.stringify(canonical({ Action, Resource, Effect: statement.Effect,
          ...(statement.Condition ? { Condition: statement.Condition } : {}) }))
      )));
    });
  return createHash('sha256').update(JSON.stringify([...new Set(grants)].sort())).digest('hex');
}

function policyValueUpperBound(value: any, template: Record<string, any>): any {
  if (Array.isArray(value)) return value.map((entry) => policyValueUpperBound(entry, template));
  if (!value || typeof value !== 'object') return value;
  if (value['Fn::Join']) {
    const [separator, parts] = value['Fn::Join'];
    return policyValueUpperBound(parts, template).join(separator);
  }
  if (value.Ref === 'AWS::StackId') {
    return `arn:aws:cloudformation:ap-east-1:650880818323:stack/${'X'.repeat(128)}/${'X'.repeat(36)}`;
  }
  if (value.Ref) {
    const resource = template.Resources[value.Ref];
    if (resource?.Type === 'AWS::SSM::Parameter') return resource.Properties.Name;
    // Deliberately over-budget the generated CloudFront distribution ID.
    if (resource?.Type === 'AWS::CloudFront::Distribution') return 'X'.repeat(256);
    throw new Error(`Unbounded policy Ref: ${value.Ref}`);
  }
  if (value['Fn::GetAtt']) {
    const [id, attribute] = value['Fn::GetAtt'];
    expect(attribute).toBe('Arn');
    const resource = template.Resources[id];
    const properties = resource.Properties;
    switch (resource.Type) {
      case 'AWS::S3::Bucket': return `arn:aws:s3:::${properties.BucketName}`;
      case 'AWS::ECR::Repository': return `arn:aws:ecr:ap-east-1:650880818323:repository/${properties.RepositoryName}`;
      case 'AWS::ECS::Cluster': return `arn:aws:ecs:ap-east-1:650880818323:cluster/${properties.ClusterName}`;
      case 'AWS::IAM::Role': return `arn:aws:iam::650880818323:role/${properties.RoleName}`;
      case 'AWS::Lambda::Function': return `arn:aws:lambda:ap-east-1:650880818323:function:${properties.FunctionName}`;
      case 'AWS::SQS::Queue': return `arn:aws:sqs:ap-east-1:650880818323:${properties.QueueName}`;
      // Cognito UserPoolId has a maximum length of 55.
      case 'AWS::Cognito::UserPool': return `arn:aws:cognito-idp:ap-east-1:650880818323:userpool/${'X'.repeat(55)}`;
      default: throw new Error(`Unbounded policy attribute: ${id}.${attribute}`);
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, policyValueUpperBound(entry, template)]));
}

describe('Platform and workload safety controls', () => {
  it.each([
    ['dev', true, 'c45a8484eff8aabe92a894d5db6df813457ec863678a55eba153605d00098161'],
    // Includes the Beta-only scoped AdminInitiateAuth grant.
    ['beta', true, '13b5999f9b8da7f006f931679dab38272a1b48d96216915d57ac8456cdb2d4a5'],
    ['beta', false, '13b5999f9b8da7f006f931679dab38272a1b48d96216915d57ac8456cdb2d4a5'],
    ['prod', true, '12feb7f5939fc6e88051f7b16871a679f6d47f6e5eb73c8fb54b44307d0d528b'],
  ] as const)('preserves pre-quota-repair effective pipeline grants for %s (active=%s)', (stage, betaActive, baselineHash) => {
    const app = new cdk.App({ context: cdkConfig.context });
    const stack = new PlatformStack(app, `AnyWearPlatformStack-${stage}`, {
      artifactInputs,
      stage, betaActive, env: { account: '650880818323', region: 'ap-east-1' },
    });
    const template = Template.fromStack(stack).toJSON();
    // Frozen from main 2e03278 before moving the three statements, with deployment CDK flags.
    expect(effectivePipelineGrantHash(template, stage)).toBe(baselineHash);
    const policies = pipelinePolicies(template, stage);
    const inline = policies.filter((policy) => policy.Type === 'AWS::IAM::Policy');
    const managed = policies.filter((policy) => policy.Type === 'AWS::IAM::ManagedPolicy');
    expect(inline).toHaveLength(1);
    expect(managed).toHaveLength(stage === 'beta' ? 1 : 0);
    if (stage === 'beta') {
      const statements = managed[0].Properties.PolicyDocument.Statement;
      expect(managed[0].Properties.Roles).toEqual(['beta-github-actions-pipeline-role']);
      expect(managed[0].Properties.Users).toBeUndefined();
      expect(managed[0].Properties.Groups).toBeUndefined();
      expect(statements).toHaveLength(3);
      expect(statements.map((statement: any) => statement.Action).sort())
        .toEqual(['ecs:ListTagsForResource', 'ecs:TagResource', 'logs:GetLogEvents']);
      expect(inline[0].Properties.PolicyDocument.Statement.every((statement: any) => (
        ![statement.Action].flat().some((action) => statements.some((moved: any) => moved.Action === action))
      ))).toBe(true);
      const inlineBytes = inline.reduce((total, policy) => total
        + Buffer.byteLength(JSON.stringify(policyValueUpperBound(policy.Properties.PolicyDocument, template))), 0);
      // Read-only IAM audit: the externally owned baseline inline policy is 607 bytes.
      expect(inlineBytes + 607).toBeLessThan(10240);
      expect(Buffer.byteLength(JSON.stringify(policyValueUpperBound(managed[0].Properties.PolicyDocument, template))))
        .toBeLessThan(6144);
    }
  });

  it('grants protected lifecycle evidence reads only to the Beta pipeline', () => {
    for (const stage of ['dev', 'beta', 'prod']) {
      const policies = pipelinePolicies(synthesizePlatform(stage), stage);
      const statements = policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement);
      const has = (action: string) => statements.some((statement: any) => [statement.Action].flat().includes(action));
      for (const action of ['logs:GetLogEvents', 'rds:DescribeDBClusters', 'rds:DescribeEvents', 'cloudwatch:GetMetricStatistics', 'ecs:ListTaskDefinitions', 'ecs:DescribeTaskDefinition']) {
        expect(has(action)).toBe(stage === 'beta');
      }
      if (stage === 'beta') {
        const logRead = statements.find((statement: any) => [statement.Action].flat().includes('logs:GetLogEvents'));
        expect(JSON.stringify(logRead.Resource)).toContain('/anywear/beta/one-shot:');
      }
    }
  });

  it('bounds wildcard lifecycle evidence reads to the Beta pipeline region in both runtime states', () => {
    const readActions = ['rds:DescribeDBClusters', 'rds:DescribeEvents', 'cloudwatch:GetMetricStatistics', 'ecs:ListTaskDefinitions', 'ecs:DescribeTaskDefinition'];
    for (const betaActive of [true, false]) {
      const app = new cdk.App();
      const stack = new PlatformStack(app, 'AnyWearPlatformStack-beta', {
        artifactInputs,
        stage: 'beta', betaActive, env: { account: '650880818323', region: 'ap-east-1' },
      });
      const policies = Object.values(Template.fromStack(stack).toJSON().Resources)
        .filter((resource: any) => resource.Type === 'AWS::IAM::Policy') as any[];
      for (const action of readActions) {
        const grants = policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement
          .filter((statement: any) => [statement.Action].flat().includes(action))
          .map((statement: any) => ({ policy, statement })));
        expect(grants).toHaveLength(1);
        expect(grants[0].policy.Properties.Roles).toEqual(['beta-github-actions-pipeline-role']);
        expect([grants[0].statement.Resource].flat()).toEqual(['*']);
        expect(grants[0].statement.Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': 'ap-east-1' } });
      }
    }
  });

  it('covers exact Beta retention inventory without expanding other stages or existing grants', () => {
    const ownedNames = ['beta-anywear-pre-sign-up', 'beta-anywear-post-confirmation-sync', 'AnyWearPlatformStack-beta-*'];
    for (const betaActive of [true, false]) {
      const app = new cdk.App();
      const stack = new PlatformStack(app, 'AnyWearPlatformStack-beta', {
        artifactInputs,
        stage: 'beta', betaActive, env: { account: '650880818323', region: 'ap-east-1' },
      });
      const policies = Object.values(Template.fromStack(stack).toJSON().Resources)
        .filter((resource: any) => resource.Type === 'AWS::IAM::Policy'
          && resource.Properties.Roles.includes('beta-github-actions-pipeline-role')) as any[];
      const grants = (action: string) => policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement
        .filter((statement: any) => [statement.Action].flat().includes(action))
        .map((statement: any) => ({ policy, statement })));
      const expectedResources: Record<string, any[]> = {
        'cloudformation:ListStackResources': [{ Ref: 'AWS::StackId' }],
        'lambda:GetFunction': ownedNames.map((name) => `arn:aws:lambda:ap-east-1:650880818323:function:${name}`),
        'logs:DescribeLogGroups': ['*'],
        'logs:PutRetentionPolicy': ownedNames.map((name) => `arn:aws:logs:ap-east-1:650880818323:log-group:/aws/lambda/${name}:*`),
      };
      for (const [action, resources] of Object.entries(expectedResources)) {
        const matches = grants(action);
        expect(matches).toHaveLength(1);
        expect(matches[0].policy.Properties.Roles).toEqual(['beta-github-actions-pipeline-role']);
        expect(matches[0].statement.Effect).toBe('Allow');
        expect([matches[0].statement.Action].flat()).toEqual([action]);
        expect([matches[0].statement.Resource].flat()).toEqual(resources);
        expect(matches[0].statement.Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': 'ap-east-1' } });
      }
      expect(JSON.stringify(grants('cloudformation:ListStackResources')[0].statement.Resource)).not.toContain('*');
      const describe = grants('cloudformation:DescribeStacks');
      expect(describe).toHaveLength(1);
      expect(describe[0].policy.Properties.Roles).toEqual(['beta-github-actions-pipeline-role']);
      expect(describe[0].statement.Action).toEqual(['cloudformation:DescribeStacks', 'ec2:DescribeManagedPrefixLists', 'ecr:DescribeImages']);
      expect(describe[0].statement.Resource).toBe('*');
      expect(describe[0].statement.Condition).toBeUndefined();
      expect(grants('sts:GetCallerIdentity')).toHaveLength(0);
    }
    for (const stage of ['dev', 'prod']) {
      const statements = (Object.values(synthesizePlatform(stage).Resources) as any[])
        .filter((resource) => resource.Type === 'AWS::IAM::Policy'
          && resource.Properties.Roles.includes(`${stage}-github-actions-pipeline-role`))
        .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
      for (const action of ['cloudformation:ListStackResources', 'lambda:GetFunction', 'logs:DescribeLogGroups', 'logs:PutRetentionPolicy']) {
        expect(statements.some((statement: any) => [statement.Action].flat().includes(action))).toBe(false);
      }
      const describe = statements.filter((statement: any) => [statement.Action].flat().includes('cloudformation:DescribeStacks'));
      expect(describe).toHaveLength(1);
      expect(describe[0].Action).toEqual(['cloudformation:DescribeStacks', 'ec2:DescribeManagedPrefixLists', 'ecr:DescribeImages']);
      expect(describe[0].Resource).toBe('*');
      expect(describe[0].Condition).toBeUndefined();
    }
  });

  it('scopes new runtime drill permissions to Beta resources without unsupported ECS IAM constraints', () => {
    const template = synthesizePlatform('beta');
    const statements = pipelinePolicies(template, 'beta')
      .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement);
    const forAction = (action: string) => statements.filter((statement: any) => [statement.Action].flat().includes(action));
    const register = forAction('ecs:RegisterTaskDefinition');
    expect(register).toHaveLength(3);
    expect(register.every((statement: any) => statement.Resource !== '*')).toBe(true);
    expect(JSON.stringify(register)).toContain('beta-anywear-task-audit:*');
    expect(JSON.stringify(register)).toContain('beta-anywear-migrate:*');
    expect(JSON.stringify(register)).toContain('beta-anywear-verify:*');
    expect(register[1].Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': { Ref: 'AWS::Region' } },
      StringLike: { 'aws:RequestTag/anywear-runtime-run-scope': '?*' } });
    expect(forAction('ecs:TagResource')[0].Condition).toEqual({ StringEquals: {
      'aws:RequestedRegion': { Ref: 'AWS::Region' }, 'ecs:CreateAction': 'RegisterTaskDefinition',
    } });
    for (const action of ['ecs:DescribeTaskDefinition', 'ecs:ListTaskDefinitions', 'ecs:DeregisterTaskDefinition',
      'application-autoscaling:DescribeScalableTargets', 'application-autoscaling:DescribeScalingPolicies',
      'application-autoscaling:DescribeScheduledActions']) {
      expect(forAction(action)).toHaveLength(1);
      expect(forAction(action)[0].Resource).toBe('*');
      expect(forAction(action)[0].Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': { Ref: 'AWS::Region' } } });
    }
    const updates = forAction('ecs:UpdateService');
    expect(updates).toHaveLength(2);
    expect(JSON.stringify(updates[0].Resource)).toContain('service/beta-anywear/beta-anywear-api');
    expect(JSON.stringify(updates[1].Resource)).toContain('service/beta-anywear/beta-anywear-worker');
    expect(JSON.stringify(updates[1].Condition.ArnLike)).toContain('beta-anywear-nonpaid-*');
    expect(JSON.stringify(forAction('ecs:StopTask')[0].Resource)).toContain('task/beta-anywear/*');
    expect(forAction('iam:PassRole').every((statement: any) => statement.Condition.StringEquals['iam:PassedToService']
      === 'ecs-tasks.amazonaws.com')).toBe(true);
    const logs = JSON.stringify(forAction('logs:GetLogEvents')[0].Resource);
    for (const purpose of ['task-audit', 'lifecycle', 'tester-cleanup']) {
      expect(logs).toContain(`/anywear/beta/one-shot:log-stream:beta-anywear-${purpose}/OneShot/*`);
    }
    expect(logs).not.toContain('/anywear/beta/one-shot:*');
    expect(JSON.stringify(forAction('logs:FilterLogEvents')[0].Resource)).toContain('/anywear/beta/worker:*');
    expect(forAction('sqs:ReceiveMessage')[0].Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^AsyncRuntimeAutoTaggingDeadLetterQueue/), 'Arn'] });
    expect(forAction('sqs:DeleteMessage')).toHaveLength(0);
    expect(forAction('ssm:PutParameter')).toHaveLength(0);
    expect(forAction('application-autoscaling:RegisterScalableTarget')).toHaveLength(0);
    expect(forAction('sqs:GetQueueAttributes')[0].Resource).toHaveLength(4);
    expect(forAction('ssm:GetParameter')[0].Resource).toHaveLength(3);
  });

  it('preserves only exact cost families with a separate required request tag and Beta region bound', () => {
    for (const betaActive of [true, false]) {
      const app = new cdk.App();
      const stack = new PlatformStack(app, 'AnyWearPlatformStack-beta', {
        artifactInputs,
        stage: 'beta', betaActive, env: { account: '650880818323', region: 'ap-east-1' },
      });
      const statements = pipelinePolicies(Template.fromStack(stack).toJSON(), 'beta')
        .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement);
      const forAction = (action: string) => statements.filter((statement: any) => [statement.Action].flat().includes(action));
      const register = forAction('ecs:RegisterTaskDefinition');
      const arn = (family: string) => stack.resolve(stack.formatArn({
        service: 'ecs', resource: 'task-definition', resourceName: `${family}:*`,
        arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
      }));
      expect(register).toHaveLength(3);
      const normal = register.find((statement: any) => !statement.Condition.StringLike);
      const runtime = register.find((statement: any) => statement.Condition.StringLike?.['aws:RequestTag/anywear-runtime-run-scope']);
      const cost = register.find((statement: any) => statement.Condition.StringLike?.['aws:RequestTag/anywear-lifecycle-evidence-run-scope']);
      expect([normal.Resource].flat()).toEqual(['migrate', 'verify', 'lifecycle', 'tester-cleanup', 'task-audit']
        .map((purpose) => arn(`beta-anywear-${purpose}`)));
      expect([runtime.Resource].flat()).toEqual([arn('beta-anywear-nonpaid-*')]);
      const costFamilies = ['beta-anywear-lifecycle-fixture', ...['migrate', 'verify', 'lifecycle', 'lifecycle-fixture']
        .map((purpose) => `beta-anywear-${purpose}-evidence-*`)];
      expect([cost.Resource].flat()).toEqual(costFamilies.map(arn));
      expect(cost.Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': 'ap-east-1' },
        StringLike: { 'aws:RequestTag/anywear-lifecycle-evidence-run-scope': '?*' } });
      expect(runtime.Condition.StringLike).toEqual({ 'aws:RequestTag/anywear-runtime-run-scope': '?*' });
      for (const statement of register) expect(statement.Condition.StringEquals['aws:RequestedRegion']).toBe('ap-east-1');
      const resources = register.flatMap((statement: any) => [statement.Resource].flat());
      for (const forbidden of ['*', arn('beta-anywear-*'), arn('prod-anywear-migrate'),
        arn('beta-anywear-task-audit-evidence-*'), arn('beta-anywear-tester-cleanup-evidence-*')]) {
        expect(resources).not.toContainEqual(forbidden);
      }
      const tagging = forAction('ecs:TagResource');
      expect(tagging).toHaveLength(1);
      expect(tagging[0].Condition).toEqual({ StringEquals: {
        'aws:RequestedRegion': 'ap-east-1', 'ecs:CreateAction': 'RegisterTaskDefinition',
      } });
      for (const family of costFamilies) expect([tagging[0].Resource].flat()).toContainEqual(arn(family));
      const logs = forAction('logs:GetLogEvents');
      expect(logs).toHaveLength(1);
      expect(logs[0].Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': 'ap-east-1' } });
      for (const family of costFamilies) {
        expect([logs[0].Resource].flat()).toContainEqual(stack.resolve(stack.formatArn({
          service: 'logs', resource: 'log-group', resourceName: `/anywear/beta/one-shot:log-stream:${family}/OneShot/*`,
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        })));
      }
      expect(JSON.stringify(logs)).not.toContain('/anywear/beta/one-shot:*');
    }
  });

  it('preserves the Production pipeline ECS and PassRole contracts without runtime drill grants', () => {
    const template = synthesizePlatform('prod');
    const statements = Object.values(template.Resources).filter((resource: any) => resource.Type === 'AWS::IAM::Policy'
      && JSON.stringify(resource.Properties.Roles).includes('prod-github-actions-pipeline-role'))
      .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement);
    const ecs = statements.filter((statement: any) => [statement.Action].flat().includes('ecs:RegisterTaskDefinition'));
    expect(ecs).toEqual([{ Action: ['ecs:RegisterTaskDefinition', 'ecs:DeregisterTaskDefinition', 'ecs:RunTask',
      'ecs:DescribeTasks', 'ecs:DescribeServices'], Effect: 'Allow', Resource: '*' }]);
    const pass = statements.find((statement: any) => [statement.Action].flat().includes('iam:PassRole'));
    expect(pass.Resource).toHaveLength(3);
    expect(pass.Condition).toBeUndefined();
    const actions = statements.flatMap((statement: any) => [statement.Action].flat());
    expect(actions).not.toEqual(expect.arrayContaining(['ecs:UpdateService']));
    for (const action of ['ecs:StopTask', 'logs:GetLogEvents', 'logs:FilterLogEvents', 'ecs:TagResource',
      'ecs:ListTaskDefinitions', 'application-autoscaling:DescribeScalableTargets', 'sqs:ReceiveMessage', 'ssm:GetParameter']) {
      expect(actions).not.toContain(action);
    }
  });

  it('lets the API read the immutable E2E marker without making it client-writable', () => {
    const resources = Object.values(synthesizePlatform('beta').Resources) as any[];
    const userPoolClient = resources.find((resource) => resource.Type === 'AWS::Cognito::UserPoolClient');

    expect(userPoolClient.Properties.ReadAttributes).toEqual(expect.arrayContaining([
      'email', 'email_verified', 'custom:e2e_bootstrap',
    ]));
    expect(userPoolClient.Properties.WriteAttributes).not.toContain('custom:e2e_bootstrap');
  });

  it('enables admin password auth only for the Beta Cognito client', () => {
    for (const stage of ['dev', 'beta', 'prod']) {
      const resources = Object.values(synthesizePlatform(stage).Resources) as any[];
      const userPoolClient = resources.find((resource) => resource.Type === 'AWS::Cognito::UserPoolClient');
      const flows = userPoolClient.Properties.ExplicitAuthFlows;
      if (stage === 'beta') expect(flows).toEqual(expect.arrayContaining(['ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH']));
      else expect(flows).not.toContain('ALLOW_ADMIN_USER_PASSWORD_AUTH');
    }
  });

  it('uses the worker visibility and duplicate-delivery budget on both task queues', () => {
    const resources = Object.values(synthesizePlatform('beta').Resources) as any[];
    for (const [taskType, policy] of Object.entries(runtimePolicies)) {
      const queue = resources.find((resource) => resource.Type === 'AWS::SQS::Queue'
        && resource.Properties.QueueName === `beta-anywear-${taskType}`);
      expect(queue.Properties.VisibilityTimeout).toBe(policy.queueVisibilitySeconds);
      expect(queue.Properties.RedrivePolicy.maxReceiveCount).toBe(policy.maxReceives);
      expect(queue.Properties.RedrivePolicy.maxReceiveCount).toBeGreaterThan(policy.maxAttempts);
    }
  });

  it('keeps dev compute local while provisioning managed dependencies', () => {
    const resources = Object.values(synthesizePlatform('dev').Resources) as any[];

    expect(resources.filter((resource) => resource.Type === 'AWS::SQS::Queue')).toHaveLength(4);
    expect(resources.filter((resource) => resource.Type === 'AWS::ECR::Repository')).toHaveLength(1);
    expect(resources.filter((resource) => resource.Type === 'AWS::ECS::Cluster')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::ECS::Service')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::ElasticLoadBalancingV2::LoadBalancer')).toHaveLength(0);
  });

  it('keeps long-lived state and the shared ECS boundary in PlatformStack', () => {
    const template = synthesizePlatform('beta');
    const resources = Object.values(template.Resources) as any[];

    expect(resources.filter((resource) => resource.Type === 'AWS::RDS::DBCluster')).toHaveLength(1);
    expect(resources.filter((resource) => resource.Type === 'AWS::ECR::Repository')).toHaveLength(1);
    expect(resources.filter((resource) => resource.Type === 'AWS::SQS::Queue')).toHaveLength(4);
    expect(resources.filter((resource) => resource.Type === 'AWS::ECS::Cluster')).toHaveLength(1);
    expect(resources.filter((resource) => resource.Type === 'AWS::ECS::Service')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::ElasticLoadBalancingV2::LoadBalancer')).toHaveLength(0);
    const parameters = resources.filter((resource) => resource.Type === 'AWS::SSM::Parameter');
    expect(parameters.some((parameter: any) => parameter.Properties.Name.endsWith('/qweather_api_key'))).toBe(false);
    const roleNames = resources
      .filter((resource) => resource.Type === 'AWS::IAM::Role')
      .map((resource) => resource.Properties?.RoleName);
    expect(roleNames).toContain('beta-anywear-migration-task');
    expect(roleNames).toContain('beta-anywear-verification-task');
  });

  it('uses the dedicated QWeather API host for every stage by default', () => {
    for (const stage of ['dev', 'beta', 'prod']) {
      const resources = Object.values(synthesizePlatform(stage).Resources) as any[];
      const parameter = resources.find((resource) => (
        resource.Type === 'AWS::SSM::Parameter'
        && resource.Properties?.Name === `/anywear/${stage}/qweather_api_host`
      ));

      expect(parameter?.Properties?.Value).toBe(DEFAULT_QWEATHER_API_HOST);
    }
  });

  it('keeps versioned API and worker compute in WorkloadStack', () => {
    const template = synthesizeWorkload('beta');
    const resources = Object.values(template.Resources) as any[];
    const taskDefinitions = resources.filter((resource) => resource.Type === 'AWS::ECS::TaskDefinition');
    const services = resources.filter((resource) => resource.Type === 'AWS::ECS::Service');
    const taskRoles = resources.filter((resource) => (
      resource.Type === 'AWS::IAM::Role'
      && resource.Properties?.AssumeRolePolicyDocument?.Statement?.some(
        (statement: any) => statement.Principal?.Service === 'ecs-tasks.amazonaws.com',
      )
    ));

    expect(taskDefinitions).toHaveLength(2);
    expect(services).toHaveLength(2);
    expect(taskRoles).toHaveLength(4);
    expect(template.Parameters.ServiceImageDigest.AllowedPattern).toBe('^sha256:[a-f0-9]{64}$');
    expect(template.Parameters.ServiceCommitSha.AllowedPattern).toBe('^[a-f0-9]{40}$');
    expect(template.Parameters.CloudFrontPrefixListId.AllowedPattern).toBe('^pl-[a-z0-9]+$');
    expect(template.Parameters.CloudFrontOriginHeaderValue).toBeUndefined();
    const distribution = Object.values(template.Resources).find(
      (resource: any) => resource.Type === 'AWS::CloudFront::Distribution',
    ) as any;
    const originHeader = distribution.Properties.DistributionConfig.Origins[0].OriginCustomHeaders[0];
    expect(JSON.stringify(originHeader.HeaderValue)).toContain('resolve:secretsmanager:');
    const apiContainer = taskDefinitions
      .flatMap((task: any) => task.Properties.ContainerDefinitions)
      .find((container: any) => container.Name === 'ApiContainer');
    const qweatherSecret = apiContainer.Secrets.find((secret: any) => secret.Name === 'QWEATHER_API_KEY');
    expect(JSON.stringify(qweatherSecret.ValueFrom))
      .toContain('/anywear/beta/qweather_api_key');
    const qweatherHost = apiContainer.Environment.find((entry: any) => entry.Name === 'QWEATHER_API_HOST');
    expect(qweatherHost).toBeDefined();
    expect(qweatherHost.Value.Ref).toMatch(/^SsmParameterValue/);
  });

  it('reduces only the active Beta API baseline to one task and keeps Production HA', () => {
    const beta = Object.values(synthesizeWorkload('beta').Resources) as any[];
    const prod = Object.values(synthesizeWorkload('prod').Resources) as any[];
    const service = (resources: any[], name: string) => resources.find((resource) => (
      resource.Type === 'AWS::ECS::Service' && resource.Properties?.ServiceName === name
    ));
    const target = (resources: any[], logicalId: string) => resources.find((resource) => (
      resource.Type === 'AWS::ApplicationAutoScaling::ScalableTarget' && resource.__logicalId === logicalId
    ));
    const betaTargetId = Object.keys(synthesizeWorkload('beta').Resources).find((id) => id.includes('ApiServiceTaskCountTarget'))!;
    const prodTargetId = Object.keys(synthesizeWorkload('prod').Resources).find((id) => id.includes('ApiServiceTaskCountTarget'))!;
    const betaWithIds = Object.entries(synthesizeWorkload('beta').Resources).map(([id, resource]) => ({ ...(resource as any), __logicalId: id }));
    const prodWithIds = Object.entries(synthesizeWorkload('prod').Resources).map(([id, resource]) => ({ ...(resource as any), __logicalId: id }));
    expect(service(beta, 'beta-anywear-api').Properties.DesiredCount).toBe(1);
    expect(service(beta, 'beta-anywear-worker').Properties.DesiredCount).toBe(1);
    expect(target(betaWithIds, betaTargetId).Properties.MinCapacity).toBe(1);
    expect(service(prod, 'prod-anywear-api').Properties.DesiredCount).toBe(2);
    expect(target(prodWithIds, prodTargetId).Properties.MinCapacity).toBe(2);
  });

  it('publishes a fixed, versioned Beta cleanup state machine with E2E read-only execution', () => {
    const template = synthesizeWorkload('beta', true, 'roles-added');
    const resources = Object.values(template.Resources) as any[];
    const machines = resources.filter((resource) => resource.Type === 'AWS::StepFunctions::StateMachine');
    const versions = resources.filter((resource) => resource.Type === 'AWS::StepFunctions::StateMachineVersion');
    const definitions = resources.filter((resource) => resource.Type === 'AWS::ECS::TaskDefinition');
    expect(machines).toHaveLength(1);
    expect(machines[0].Properties.StateMachineType).toBe('STANDARD');
    expect(machines[0].Properties.StateMachineName).toBe('beta-anywear-tester-cleanup');
    expect(versions).toHaveLength(1);
    expect(definitions.map((definition) => definition.Properties.Family)).toEqual(expect.arrayContaining([
      'beta-anywear-cleanup-verify', 'beta-anywear-cleanup',
    ]));
    const definition = JSON.stringify(machines[0].Properties.DefinitionString);
    expect(definition).toContain('beta-tester-cleanup.js');
    expect(definition).toContain('cleanup_request');
    const policies = resources.filter((resource) => resource.Type === 'AWS::IAM::Policy');
    const e2ePolicy = policies.find((policy) => JSON.stringify(policy.Properties.Roles).includes('beta-e2e-qualification-role'));
    expect(JSON.stringify(e2ePolicy)).toContain('states:StartExecution');
    expect(JSON.stringify(e2ePolicy)).toContain('states:DescribeExecution');
    expect(JSON.stringify(e2ePolicy)).toContain('states:GetExecutionHistory');
    expect(JSON.stringify(e2ePolicy)).not.toContain('ecs:RunTask');
  });

  it('stops only Beta paid workload resources while preserving CloudFront and maintenance origin', () => {
    const template = synthesizeWorkload('beta', false);
    const resources = Object.values(template.Resources) as any[];
    expect(resources.filter((resource) => resource.Type === 'AWS::ECS::Service')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::ECS::TaskDefinition')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::ElasticLoadBalancingV2::LoadBalancer')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::ElasticLoadBalancingV2::Listener')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::CloudFront::Distribution')).toHaveLength(1);
    expect(resources.filter((resource) => resource.Type === 'AWS::S3::Bucket')).toHaveLength(1);
    expect(template.Outputs.BetaActive.Value).toBe('false');
    expect(template.Outputs.ApiBaseUrl).toBeDefined();
  });

  it('allows the Beta database to pause at zero ACU after five minutes without connections', () => {
    const resources = Object.values(synthesizePlatform('beta').Resources) as any[];
    const database = resources.find((resource) => resource.Type === 'AWS::RDS::DBCluster');
    const instances = resources.filter((resource) => resource.Type === 'AWS::RDS::DBInstance');

    expect(database.Properties.Engine).toBe('aurora-postgresql');
    expect(database.Properties.EngineVersion).toBe('17.7');
    expect(database.Properties.ServerlessV2ScalingConfiguration).toEqual({
      MinCapacity: 0,
      MaxCapacity: 2,
      SecondsUntilAutoPause: 300,
    });
    expect(instances).toHaveLength(1);
    expect(instances[0].Properties.DBInstanceClass).toBe('db.serverless');
  });

  it('removes Beta NAT gateways in stopped state while keeping subnets and database', () => {
    const template = synthesizePlatform('beta', false);
    const resources = Object.values(template.Resources) as any[];
    expect(resources.filter((resource) => resource.Type === 'AWS::EC2::NatGateway')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::EC2::Subnet')).toHaveLength(6);
    expect(resources.filter((resource) => resource.Type === 'AWS::RDS::DBCluster')).toHaveLength(1);
    expect(resources.filter((resource) => resource.Type === 'AWS::ECS::Cluster')).toHaveLength(1);
    expect(resources.find((resource) => resource.Type === 'AWS::EC2::VPCEndpoint')).toBeDefined();
    expect(template.Outputs.BetaActive.Value).toBe('false');
  });

  it('uses CloudFront HTTPS with caching disabled and restricts direct ALB traffic', () => {
    const template = synthesizeWorkload('beta');
    const resources = Object.values(template.Resources) as any[];
    const distributions = resources.filter((resource) => resource.Type === 'AWS::CloudFront::Distribution');
    const listeners = resources.filter((resource) => resource.Type === 'AWS::ElasticLoadBalancingV2::Listener');
    const listenerRules = resources.filter((resource) => resource.Type === 'AWS::ElasticLoadBalancingV2::ListenerRule');
    const prefixIngress = resources.find((resource) => (
      resource.Type === 'AWS::EC2::SecurityGroupIngress'
      && resource.Properties?.SourcePrefixListId?.Ref === 'CloudFrontPrefixListId'
    ));

    expect(distributions).toHaveLength(1);
    expect(distributions[0].Properties.DistributionConfig.DefaultCacheBehavior.CachePolicyId)
      .toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    expect(distributions[0].Properties.DistributionConfig.Origins[0].OriginCustomHeaders[0].HeaderName)
      .toBe('X-AnyWear-Origin-Verify');
    expect(distributions[0].Properties.DistributionConfig.Origins[0].CustomOriginConfig.OriginReadTimeout)
      .toBe(60);
    expect(distributions[0].Properties.DistributionConfig.Origins[0].ResponseCompletionTimeout)
      .toBeUndefined();
    expect(listeners).toHaveLength(1);
    expect(listenerRules).toHaveLength(1);
    expect(prefixIngress).toBeDefined();
  });

  it('adds queue, DLQ, and API failure alarms with the Beta operations topic', () => {
    const alarms = Object.values(synthesizeWorkload('beta').Resources).filter(
      (resource: any) => resource.Type === 'AWS::CloudWatch::Alarm'
        && resource.Properties?.AlarmName?.startsWith('beta-anywear-'),
    );
    expect(alarms).toHaveLength(5);
    expect(alarms.every((alarm: any) => alarm.Properties.AlarmActions?.length === 1)).toBe(true);
  });

  it('keeps billing controls out of regional platform stacks', () => {
    const betaResources = Object.values(synthesizePlatform('beta').Resources) as any[];
    const prodResources = Object.values(synthesizePlatform('prod').Resources) as any[];
    const betaS3Endpoint = betaResources.find((resource) => resource.Type === 'AWS::EC2::VPCEndpoint');

    expect(JSON.stringify(betaS3Endpoint.Properties.ServiceName)).toContain('s3');
    expect(betaResources.some((resource) => resource.Type === 'AWS::Budgets::Budget')).toBe(false);
    expect(betaResources.some((resource) => resource.Type === 'AWS::CE::AnomalyMonitor')).toBe(false);
    expect(prodResources.some((resource) => resource.Type === 'AWS::Budgets::Budget')).toBe(false);
  });

  it('configures the approved Beta budget and anomaly notifications in the billing stack', () => {
    const resources = Object.values(synthesizeBilling().Resources) as any[];
    const budget = resources.find((resource) => resource.Type === 'AWS::Budgets::Budget');
    const anomalyMonitor = resources.find((resource) => resource.Type === 'AWS::CE::AnomalyMonitor');
    const anomalySubscription = resources.find((resource) => resource.Type === 'AWS::CE::AnomalySubscription');
    const subscriptions = resources.filter((resource) => resource.Type === 'AWS::SNS::Subscription');

    expect(budget.Properties.Budget.BudgetLimit).toEqual({ Amount: 300, Unit: 'USD' });
    expect(budget.Properties.NotificationsWithSubscribers).toHaveLength(4);
    expect(budget.Properties.NotificationsWithSubscribers.map((entry: any) => entry.Notification.NotificationType))
      .toEqual(['ACTUAL', 'ACTUAL', 'ACTUAL', 'FORECASTED']);
    expect(anomalyMonitor.Properties.MonitorType).toBe('DIMENSIONAL');
    expect(anomalyMonitor.Properties.MonitorDimension).toBe('SERVICE');
    expect(anomalySubscription.Properties.Threshold).toBe(10);
    expect(anomalySubscription.Properties.Frequency).toBe('IMMEDIATE');
    expect(anomalySubscription.Properties.Subscribers).toHaveLength(1);
    expect(anomalySubscription.Properties.Subscribers[0].Type).toBe('SNS');
    expect(anomalySubscription.Properties.Subscribers[0].Address.Ref).toBeDefined();
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions.map((resource: any) => resource.Properties.Endpoint).sort()).toEqual([
      'luma26c@gmail.com',
      'windy005@126.com',
    ]);
  });

  it('configures only the approved recipients on Beta operations', () => {
    const resources = Object.values(synthesizePlatform('beta').Resources) as any[];
    const subscriptions = resources.filter((resource) => resource.Type === 'AWS::SNS::Subscription');

    expect(subscriptions.map((resource: any) => resource.Properties.Endpoint).sort()).toEqual([
      'luma26c@gmail.com',
      'windy005@126.com',
    ]);
  });

  it('expires only unpromoted task attempts after seven days', () => {
    const template = synthesizePlatform('beta');
    const bucket = Object.values(template.Resources).find(
      (resource: any) => resource.Type === 'AWS::S3::Bucket',
    ) as any;
    expect(bucket.Properties.LifecycleConfiguration.Rules).toContainEqual(expect.objectContaining({
      Id: 'ExpireUnpromotedTaskAttempts',
      Prefix: 'task-attempts/',
      ExpirationInDays: 7,
    }));
  });

  it('creates the test-user trigger only outside production', () => {
    const devTemplate = synthesizePlatform('dev');
    const prodTemplate = synthesizePlatform('prod');
    expect(hasFunctionNamed(devTemplate, 'dev-anywear-pre-sign-up')).toBe(true);
    expect(hasFunctionNamed(prodTemplate, 'prod-anywear-pre-sign-up')).toBe(false);
  });

  it('retains every Beta Lambda log group for two weeks without changing Production', () => {
    const beta = synthesizePlatform('beta');
    const betaResources = Object.entries(beta.Resources) as [string, any][];
    const betaFunctions = betaResources.filter(([, resource]) => resource.Type === 'AWS::Lambda::Function');
    const betaApplicationFunctions = betaFunctions.filter(([, resource]) => resource.Properties?.FunctionName);
    const betaLambdaLogGroups = betaApplicationFunctions.map(([functionId]) => {
      const logGroup = betaResources.find(([, resource]) => resource.Type === 'AWS::Logs::LogGroup'
        && JSON.stringify(resource.Properties?.LogGroupName).includes(`"Ref":"${functionId}"`));
      expect(logGroup).toBeDefined();
      return logGroup![1];
    });

    expect(betaApplicationFunctions).toHaveLength(2);
    expect(betaLambdaLogGroups).toHaveLength(betaApplicationFunctions.length);
    expect(betaLambdaLogGroups.every((logGroup) => logGroup.Properties.RetentionInDays === 14)).toBe(true);

    const betaRetentionResources = betaResources.filter(([, resource]) => resource.Type === 'Custom::LogRetention'
      && JSON.stringify(resource.Properties.LogGroupName).includes('CustomResourceProviderHandler'));
    const betaCustomProviderHandlers = betaFunctions.filter(([functionId]) => functionId.includes('CustomResourceProviderHandler'));
    expect(betaRetentionResources).toHaveLength(betaCustomProviderHandlers.length);
    expect(betaRetentionResources.every(([, resource]) => resource.Properties.RetentionInDays === 14)).toBe(true);
    expect(betaRetentionResources.every(([, resource]) => JSON.stringify(resource.Properties.LogGroupName).includes('CustomResourceProviderHandler'))).toBe(true);
    expect(betaResources.some(([, resource]) => resource.Type === 'AWS::Logs::LogGroup'
      && JSON.stringify(resource.Properties?.LogGroupName).includes('CustomResourceProvider'))).toBe(false);

    const prod = synthesizePlatform('prod');
    const prodResources = Object.entries(prod.Resources) as [string, any][];
    const prodFunctions = prodResources.filter(([, resource]) => resource.Type === 'AWS::Lambda::Function');
    const prodApplicationFunctions = prodFunctions.filter(([, resource]) => resource.Properties?.FunctionName);
    for (const [functionId] of prodApplicationFunctions) {
      const logGroup = prodResources.find(([, resource]) => resource.Type === 'AWS::Logs::LogGroup'
        && JSON.stringify(resource.Properties?.LogGroupName).includes(`"Ref":"${functionId}"`));
      if (logGroup) {
        expect(logGroup[1].Properties.RetentionInDays).toBe(731);
      }
    }

    expect(prodApplicationFunctions).toHaveLength(1);
    expect(prodResources.some(([, resource]) => resource.Type === 'AWS::Logs::LogGroup'
      && resource.Properties?.RetentionInDays === 14)).toBe(false);
  });

  it('retains the Beta Container Insights performance log group for two weeks', () => {
    const betaResources = Object.values(synthesizePlatform('beta').Resources) as any[];
    const betaContainerInsightsRetentionResources = betaResources.filter((resource) => (
      resource.Type === 'Custom::LogRetention'
        && resource.Properties?.LogGroupName === '/aws/ecs/containerinsights/beta-anywear/performance'
    ));

    expect(betaContainerInsightsRetentionResources).toHaveLength(1);
    expect(betaContainerInsightsRetentionResources[0].Properties.RetentionInDays).toBe(14);

    const prodResources = Object.values(synthesizePlatform('prod').Resources) as any[];
    expect(prodResources.some((resource) => (
      resource.Type === 'Custom::LogRetention'
        && resource.Properties?.LogGroupName === '/aws/ecs/containerinsights/prod-anywear/performance'
    ))).toBe(false);
  });

  it('creates runtime-owned Beta admission parameters with fail-closed defaults only in Beta', () => {
    const beta = synthesizePlatform('beta');
    const betaParameters = Object.values(beta.Resources).filter(
      (resource: any) => resource.Type === 'AWS::SSM::Parameter'
        && ['/anywear/beta/intake_open', '/anywear/beta/tester_allowlist', '/anywear/beta/admission_suspended']
          .includes(resource.Properties.Name),
    ) as any[];
    expect(betaParameters.map((parameter) => parameter.Properties)).toEqual(expect.arrayContaining([
      expect.objectContaining({ Name: '/anywear/beta/intake_open', Type: 'String', Value: 'false' }),
      expect.objectContaining({ Name: '/anywear/beta/tester_allowlist', Type: 'String', Value: '[]' }),
      expect.objectContaining({ Name: '/anywear/beta/admission_suspended', Type: 'String', Value: 'true' }),
    ]));
    expect(betaParameters).toHaveLength(3);
    const betaPolicies = Object.values(beta.Resources).filter((resource: any) => resource.Type === 'AWS::IAM::Policy');
    const verificationGrant = betaPolicies.flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
      .find((statement: any) => JSON.stringify(statement.Action).includes('cognito-idp:AdminUpdateUserAttributes'));
    expect(verificationGrant).toBeDefined();
    expect(verificationGrant.Action).toEqual(expect.arrayContaining([
      'cognito-idp:AdminUpdateUserAttributes', 'cognito-idp:AdminGetUser',
    ]));
    expect(JSON.stringify(verificationGrant.Resource)).toContain('AnyWearUserPool');
    expect(JSON.stringify(verificationGrant.Resource)).not.toContain('*');
    const adminAuthGrant = betaPolicies.flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
      .find((statement: any) => [statement.Action].flat().includes('cognito-idp:AdminInitiateAuth'));
    expect(adminAuthGrant).toBeDefined();
    expect([adminAuthGrant.Action].flat()).toContain('cognito-idp:AdminInitiateAuth');
    expect(JSON.stringify(adminAuthGrant.Resource)).toContain('AnyWearUserPool');
    expect(JSON.stringify(adminAuthGrant.Resource)).not.toContain('*');
    for (const stage of ['dev', 'prod']) {
      const template = synthesizePlatform(stage);
      expect(Object.values(template.Resources).some((resource: any) => resource.Type === 'AWS::SSM::Parameter'
        && /\/(intake_open|tester_allowlist|admission_suspended)$/.test(resource.Properties.Name))).toBe(false);
      expect(JSON.stringify(template)).not.toContain('cognito-idp:AdminUpdateUserAttributes');
      expect(JSON.stringify(template)).not.toContain('cognito-idp:AdminGetUser');
      expect(JSON.stringify(template)).not.toContain('cognito-idp:AdminInitiateAuth');
    }
  });

  it('limits both Beta Cognito triggers and lifecycle to the three admission parameters', () => {
    const template = synthesizePlatform('beta');
    const resources = Object.values(template.Resources) as any[];
    const expectedNames = ['intake_open', 'tester_allowlist', 'admission_suspended'];
    const expectedParameterIds = expectedNames.map((name) => Object.entries(template.Resources).find(
      ([, resource]: [string, any]) => resource.Type === 'AWS::SSM::Parameter'
        && resource.Properties.Name === `/anywear/beta/${name}`,
    )![0]);
    for (const functionName of ['beta-anywear-pre-sign-up', 'beta-anywear-post-confirmation-sync']) {
      const trigger = resources.find((resource) => resource.Type === 'AWS::Lambda::Function'
        && resource.Properties.FunctionName === functionName);
      expect(trigger.Properties.Environment.Variables.BETA_ACTIVE).toBe('true');
      const roleId = trigger.Properties.Role['Fn::GetAtt'][0];
      const policies = resources.filter((resource) => resource.Type === 'AWS::IAM::Policy'
        && resource.Properties.Roles.some((role: any) => role.Ref === roleId));
      const statements = policies.flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
        .filter((statement: any) => JSON.stringify(statement.Action).includes('ssm:'));
      expect(statements).toHaveLength(1);
      expect(statements[0].Action).toEqual(['ssm:GetParameter', 'ssm:GetParameters']);
      expect(statements[0].Resource).toHaveLength(3);
      expect(statements[0].Resource.map((resource: any) => resource['Fn::Join'][1].at(-1).Ref))
        .toEqual(expectedParameterIds);
      expect(JSON.stringify(statements[0].Resource)).not.toContain('*');
    }
    const lifecycleRoleId = Object.entries(template.Resources).find(([, resource]: [string, any]) => (
      resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === 'beta-anywear-lifecycle-task'
    ))![0];
    const lifecycleStatements = resources.filter((resource) => resource.Type === 'AWS::IAM::Policy'
      && resource.Properties.Roles.some((role: any) => role.Ref === lifecycleRoleId))
      .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
      .filter((statement: any) => JSON.stringify(statement.Action).includes('ssm:'));
    expect(lifecycleStatements).toHaveLength(1);
    expect(lifecycleStatements[0].Action).toEqual(['ssm:GetParameter', 'ssm:GetParameters', 'ssm:PutParameter']);
    expect(lifecycleStatements[0].Resource).toHaveLength(3);
    expect(lifecycleStatements[0].Resource.map((resource: any) => resource['Fn::Join'][1].at(-1).Ref))
      .toEqual(expectedParameterIds);
    expect(JSON.stringify(lifecycleStatements[0].Resource)).not.toContain('*');
  });

  it('limits synthetic lifecycle message cleanup to the two Beta dead-letter queues', () => {
    const template = synthesizePlatform('beta');
    const lifecycleRoleId = Object.entries(template.Resources).find(([, resource]: [string, any]) => (
      resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === 'beta-anywear-lifecycle-task'
    ))![0];
    const statements = (Object.values(template.Resources) as any[])
      .filter((resource) => resource.Type === 'AWS::IAM::Policy'
        && resource.Properties.Roles.some((role: any) => role.Ref === lifecycleRoleId))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .filter((statement) => JSON.stringify(statement.Action).includes('sqs:ReceiveMessage'));
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toEqual(['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility']);
    const queueIds = statements[0].Resource.map((resource: any) => resource['Fn::GetAtt'][0]);
    expect(queueIds).toHaveLength(2);
    expect(queueIds.map((id: string) => template.Resources[id].Properties.QueueName).sort())
      .toEqual(['beta-anywear-auto-tagging-dlq', 'beta-anywear-vto-dlq']);
    expect(JSON.stringify(statements[0])).not.toContain('PurgeQueue');
    expect(JSON.stringify(statements[0].Resource)).not.toContain('*');
  });

  it('retains production storage and protects the database', () => {
    const template = synthesizePlatform('prod');
    const bucket = Object.values(template.Resources).find(
      (resource: any) => resource.Type === 'AWS::S3::Bucket',
    ) as any;
    const database = Object.values(template.Resources).find(
      (resource: any) => resource.Type === 'AWS::RDS::DBCluster',
    ) as any;

    expect(bucket.DeletionPolicy).toBe('Retain');
    expect(database.DeletionPolicy).toBe('Retain');
    expect(database.Properties.DeletionProtection).toBe(true);
    expect(database.Properties.StorageEncrypted).toBe(true);
    expect(database.Properties.ServerlessV2ScalingConfiguration).toEqual({
      MinCapacity: 0.5,
      MaxCapacity: 2,
    });
  });

  it('bootstraps stage roles and excludes E2E from Production trust', () => {
    const template = synthesizeFoundation();
    const roles = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::Role'
        && resource.Properties?.RoleName?.endsWith('-github-actions-pipeline-role'),
    ) as any[];
    expect(roles).toHaveLength(3);
    const prod = roles.find((role) => role.Properties.RoleName === 'prod-github-actions-pipeline-role');
    const beta = roles.find((role) => role.Properties.RoleName === 'beta-github-actions-pipeline-role');
    const subjects = (role: any): string[] => role.Properties.AssumeRolePolicyDocument.Statement[0]
      .Condition.StringEquals['token.actions.githubusercontent.com:sub'];
    const e2eBetaSubject = 'repo:git-malu@11473072/AnyWear-E2E@1317091305:environment:beta';
    const clientBetaSubject = 'repo:git-malu@11473072/AnyWear-Client@1176104200:environment:beta';
    const serviceBetaSubject = 'repo:git-malu@11473072/AnyWear-Service@1158460323:environment:beta';
    const serviceProdSubject = 'repo:git-malu@11473072/AnyWear-Service@1158460323:environment:prod';
    expect(subjects(beta)).toHaveLength(3);
    expect(subjects(beta)).toEqual(expect.arrayContaining([e2eBetaSubject, clientBetaSubject, serviceBetaSubject]));
    expect(subjects(prod)).toEqual([serviceProdSubject]);

    const policies = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::Policy',
    ) as any[];
    const devPolicy = JSON.stringify(policies.find((policy) => (
      JSON.stringify(policy.Properties.PolicyDocument.Statement).includes('secretsmanager:GetSecretValue')
    )));
    expect(devPolicy).toContain('/anywear/dev/qweather_api_key-*');
    expect(devPolicy).toContain('/anywear/dev/cloudfront_origin_header-*');
  });
});

describe('Explicit infrastructure identity cutover', () => {
  const names = ['infra-deploy', 'infra-runtime', 'service-artifact', 'service-data', 'client-publish', 'e2e-qualification'];
  const policiesFor = (template: any, name: string) => Object.values(template.Resources).filter((resource: any) =>
    ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)
      && resource.Properties.Roles?.some((role: any) => role === `beta-${name}-role` || (role.Ref && template.Resources[role.Ref]?.Properties?.RoleName === `beta-${name}-role`))) as any[];
  const grantsFor = (template: any, name: string): any[] => policiesFor(template, name)
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
  const actionsFor = (template: any, name: string): string[] => grantsFor(template, name).flatMap((statement) =>
    [statement.Action].flat());

  it('fails closed for unknown phases and defaults to legacy', () => {
    expect(readIdentityPhase(undefined)).toBe('legacy');
    for (const value of [null, '', true, 'production', 'cutover']) expect(() => readIdentityPhase(value)).toThrow();
  });

  it('adds six distinct immutable OIDC identities without changing existing Foundation resources', () => {
    const legacy = synthesizeFoundation();
    const added = synthesizeFoundation('roles-added');
    for (const [id, resource] of Object.entries(legacy.Resources)) expect(added.Resources[id]).toEqual(resource);
    expect(added.Outputs).toEqual(legacy.Outputs);
    const roles = (Object.values(added.Resources) as any[]).filter((resource) => resource.Type === 'AWS::IAM::Role'
      && names.some((name) => resource.Properties.RoleName === `beta-${name}-role`));
    expect(roles).toHaveLength(6);
    for (const role of roles) {
      const statement = role.Properties.AssumeRolePolicyDocument.Statement[0];
      expect(statement.Action).toBe('sts:AssumeRoleWithWebIdentity');
      const condition = statement.Condition.StringEquals;
      expect(condition['token.actions.githubusercontent.com:aud']).toBe('sts.amazonaws.com');
      const subject = condition['token.actions.githubusercontent.com:sub'];
      const name = role.Properties.RoleName;
      if (name.startsWith('beta-infra-')) expect(subject)
        .toBe('repo:git-malu@11473072/AnyWear-Infra@1409047265:environment:beta');
      else if (name.startsWith('beta-service-')) expect(subject)
        .toBe(`repo:git-malu@11473072/AnyWear-Service@1158460323:environment:${name === 'beta-service-artifact-role' ? 'service-artifacts' : 'beta'}`);
      else if (name === 'beta-client-publish-role') expect(subject)
        .toBe('repo:git-malu@11473072/AnyWear-Client@1176104200:environment:beta');
      else expect(subject).toBe('repo:git-malu@11473072/AnyWear-E2E@1317091305:environment:beta');
    }
  });

  it.each([true, false])('adds policies while retaining every legacy Beta resource and output (active=%s)', (active) => {
    const legacy = synthesizePlatform('beta', active);
    const added = synthesizePlatform('beta', active, 'roles-added');
    for (const [id, resource] of Object.entries(legacy.Resources)) expect(added.Resources[id]).toEqual(resource);
    for (const [key, value] of Object.entries(legacy.Outputs)) expect(added.Outputs[key]).toEqual(value);
    expect(Object.keys(added.Outputs).filter(key => !legacy.Outputs[key])).toEqual(['CleanupTaskRoleArn']);
    const newResources = Object.entries(added.Resources).filter(([id]) => !legacy.Resources[id]);
    expect(newResources).toHaveLength(7);
    expect(newResources.filter(([, resource]: [string, any]) => resource.Type === 'AWS::IAM::Policy')).toHaveLength(6);
    const cleanup = newResources.find(([, resource]: [string, any]) => resource.Type === 'AWS::IAM::Role')![1] as any;
    expect(cleanup.Properties.RoleName).toBe('beta-anywear-tester-cleanup-task');
  });

  it('keeps the old Beta role identity but removes its trust and template-owned grants only at retirement', () => {
    const before = synthesizeFoundation('roles-added');
    const retired = synthesizeFoundation('retired');
    const roleId = Object.entries(before.Resources).find(([, resource]: [string, any]) =>
      resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === 'beta-github-actions-pipeline-role')![0];
    expect(retired.Resources[roleId].Properties.RoleName).toBe('beta-github-actions-pipeline-role');
    expect(retired.Resources[roleId].Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals
      ['token.actions.githubusercontent.com:sub']).toEqual(['anywear:retired:beta-github-actions-pipeline-role']);
    for (const [id, resource] of Object.entries(before.Resources) as [string, any][]) {
      if (resource.Type === 'AWS::IAM::Role' && ['dev', 'prod'].some((stage) =>
        resource.Properties.RoleName === `${stage}-github-actions-pipeline-role`)) expect(retired.Resources[id]).toEqual(resource);
    }
    expect(pipelinePolicies(synthesizePlatform('beta', true, 'retired'), 'beta')).toHaveLength(0);
    for (const stage of ['dev', 'prod']) {
      expect(synthesizePlatform(stage, true, 'retired')).toEqual(synthesizePlatform(stage, true, 'legacy'));
    }
  });

  it('separates artifact, data, Client, runtime and qualification capabilities', () => {
    const template = synthesizePlatform('beta', true, 'roles-added');
    const artifactActions = actionsFor(synthesizeFoundation('roles-added'), 'service-artifact');
    expect(artifactActions).toContain('ecr:PutImage');
    expect(artifactActions.every((action) => action.startsWith('ecr:'))).toBe(true);
    for (const name of ['service-artifact', 'service-data', 'client-publish', 'e2e-qualification', 'infra-runtime']) {
      expect(actionsFor(template, name)).not.toContain('sts:AssumeRole');
      expect(actionsFor(template, name)).not.toContain('cloudformation:CreateChangeSet');
    }
    const clientActions = actionsFor(template, 'client-publish');
    expect(clientActions).toContain('s3:PutObject');
    expect(clientActions).toContain('cloudfront:CreateInvalidation');
    expect(clientActions.every((action) => ['cloudformation:DescribeStacks', 'ssm:GetParameter', 'ssm:GetParameters',
      's3:ListBucket', 's3:GetBucketLocation', 's3:GetObject', 's3:PutObject', 's3:DeleteObject',
      'cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'].includes(action))).toBe(true);
    const clientWrites = grantsFor(template, 'client-publish').filter((grant) =>
      [grant.Action].flat().some((action) => ['s3:PutObject', 's3:DeleteObject', 'cloudfront:CreateInvalidation'].includes(action)));
    expect(JSON.stringify(clientWrites)).toContain('AnyWearClientBucket');
    expect(JSON.stringify(clientWrites)).toContain('AnyWearClientDistribution');
    expect(JSON.stringify(clientWrites)).not.toContain('AnyWearWardrobeBucket');
    for (const [name, families] of [['service-data', ['verify', 'tester-cleanup']],
      ['e2e-qualification', ['artifact-verify']]] as const) {
      const registration = grantsFor(template, name).filter((grant) => [grant.Action].flat().includes('ecs:RegisterTaskDefinition'));
      expect(registration).toHaveLength(1);
      const resources = JSON.stringify(registration[0].Resource);
      for (const family of families) expect(resources).toContain(`beta-anywear-${family}:*`);
      expect([registration[0].Resource].flat()).toHaveLength(families.length);
      expect(resources).not.toContain('beta-anywear-api');
      expect(resources).not.toContain('beta-anywear-worker');
    }
    const runtimeWrites = grantsFor(template, 'infra-runtime').filter((grant) => [grant.Action].flat().includes('ssm:PutParameter'));
    expect(runtimeWrites).toHaveLength(1);
    expect(JSON.stringify(runtimeWrites[0].Resource)).toContain('/infra_selection');
    expect(JSON.stringify(runtimeWrites[0].Resource)).toContain('/infra_deployment');
    expect(JSON.stringify(runtimeWrites[0].Resource)).not.toContain('admission_suspended');
    const passRoles = grantsFor(template, 'e2e-qualification').find((grant) => [grant.Action].flat().includes('iam:PassRole'));
    expect([passRoles.Resource].flat()).toHaveLength(2);
    for (const forbidden of ['MigrationTaskRole', 'LifecycleTaskRole', 'CleanupTaskRole']) expect(JSON.stringify(passRoles)).not.toContain(forbidden);
    const dataPassRoles = grantsFor(template, 'service-data').find((grant) => [grant.Action].flat().includes('iam:PassRole'));
    expect(JSON.stringify(dataPassRoles)).toContain('CleanupTaskRole');
    expect(JSON.stringify(dataPassRoles)).not.toContain('LifecycleTaskRole');
    const cleanupPolicy = (Object.values(template.Resources) as any[]).find(resource => resource.Type === 'AWS::IAM::Policy' && JSON.stringify(resource.Properties.Roles).includes('CleanupTaskRole'));
    expect(JSON.stringify(cleanupPolicy)).not.toContain('ssm:');
    const e2eRegistration = grantsFor(template, 'e2e-qualification')
      .find((grant) => [grant.Action].flat().includes('ecs:RegisterTaskDefinition'));
    expect(JSON.stringify(e2eRegistration.Resource)).not.toContain('beta-anywear-lifecycle:');
  });

  it('constrains CDK assumption to the reviewed bootstrap roles and regions', () => {
    const foundation = synthesizeFoundation('roles-added');
    const statements = (Object.values(foundation.Resources) as any[]).filter((resource) => resource.Type === 'AWS::IAM::Policy')
      .flatMap((resource) => resource.Properties.PolicyDocument.Statement);
    const assumptions = statements.filter((statement) => [statement.Action].flat().includes('sts:AssumeRole'));
    const dedicated = assumptions.find((statement) => JSON.stringify(statement.Resource).includes('cdk-hnb659fds-deploy-role'));
    expect(dedicated).toBeDefined();
    expect([dedicated.Resource].flat()).toHaveLength(6);
    expect(JSON.stringify(dedicated.Resource)).not.toContain('image-publishing');
    expect(JSON.stringify(dedicated.Resource)).not.toContain('cfn-exec');
    expect(JSON.stringify(dedicated.Resource)).not.toContain('cdk-*');
  });

  it('keeps every dedicated role within the aggregate IAM inline policy quota', () => {
    const env = { account: '650880818323', region: 'ap-east-1' };
    const app = new cdk.App({ context: cdkConfig.context });
    const foundationStack = new FoundationStack(app, 'AnyWearFoundationStack', {
      env, identityPhase: 'roles-added', legacyRoleOwnership: 'managed',
    });
    const platformStack = new PlatformStack(app, 'AnyWearPlatformStack-beta', {
      stage: 'beta', env, identityPhase: 'roles-added', artifactInputs,
    });
    const foundation = Template.fromStack(foundationStack).toJSON();
    const platform = Template.fromStack(platformStack).toJSON();
    for (const name of names) {
      const local = policiesFor(platform, name);
      const roleId = Object.entries(foundation.Resources).find(([, resource]: [string, any]) =>
        resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === `beta-${name}-role`)![0];
      const base = (Object.values(foundation.Resources) as any[]).filter((resource) => resource.Type === 'AWS::IAM::Policy'
        && resource.Properties.Roles?.some((role: any) => role.Ref === roleId));
      const bytes = local.reduce((size, policy) => size + Buffer.byteLength(JSON.stringify(
        policyValueUpperBound(policy.Properties.PolicyDocument, platform))), 0)
        + base.reduce((size, policy) => size + Buffer.byteLength(JSON.stringify(policy.Properties.PolicyDocument)), 0);
      expect(bytes).toBeLessThan(10240);
    }
  });

  it('activates rollback retention only explicitly and preserves the original any-image threshold', () => {
    for (const stage of ['beta', 'prod']) {
      const app = new cdk.App();
      const protectedStack = new PlatformStack(app, `AnyWearPlatformStack-${stage}`, {
        stage, artifactInputs, retentionProtection: true,
      });
      const template = Template.fromStack(protectedStack).toJSON();
      const repository = (Object.values(template.Resources) as any[]).find((resource) => resource.Type === 'AWS::ECR::Repository');
      const policy = JSON.parse(repository.Properties.LifecyclePolicy.LifecyclePolicyText);
      expect(policy.rules).toHaveLength(2);
      expect(policy.rules[0]).toEqual(expect.objectContaining({ rulePriority: 1,
        selection: { tagStatus: 'tagged', tagPrefixList: ['protected-service-'],
          countType: 'imageCountMoreThan', countNumber: 1000 }, action: { type: 'expire' } }));
      expect(policy.rules[1]).toEqual(expect.objectContaining({ rulePriority: 2,
        selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: stage === 'beta' ? 30 : 100 },
        action: { type: 'expire' } }));
      const original = (Object.values(synthesizePlatform(stage).Resources) as any[])
        .find((resource) => resource.Type === 'AWS::ECR::Repository');
      const originalPolicy = JSON.parse(original.Properties.LifecyclePolicy.LifecyclePolicyText);
      expect(originalPolicy.rules).toHaveLength(1);
      expect(originalPolicy.rules[0].selection).toEqual({ tagStatus: 'any',
        countType: 'imageCountMoreThan', countNumber: stage === 'beta' ? 30 : 100 });
    }
  });
});
