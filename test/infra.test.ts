import * as cdk from 'aws-cdk-lib';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { Template } from 'aws-cdk-lib/assertions';
import { BillingStack } from '../lib/billing-stack';
import { EgressStack } from '../lib/egress-stack';
import { FoundationStack } from '../lib/foundation-stack';
import { API_DISTRIBUTION_IDENTITY, DEFAULT_QWEATHER_API_HOST, PlatformStack } from '../lib/platform-stack';
import { stageContractInputs } from '../lib/stage-contract';
import { DEPLOYMENT_SQS_DEPTH_ATTRIBUTES } from '@git-malu/stage-contracts';
import runtimePolicies from './fixtures/runtime-policy.json';
import workloadExtensionResources from './fixtures/workload-extension-resources.json';
import workloadBakeReads from './fixtures/workload-bake-reads.json';
import workloadCfnActions from './fixtures/workload-cfn-actions.json';
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

const root = path.resolve(__dirname, '..');

// Issue #166 removed the stopped topology: one Base template per stage. Beta
// needs the literal API distribution origin the live distribution uses.
const TEST_API_ORIGIN_DOMAIN_NAME = 'beta-anywear-api-0123456789.ap-east-1.elb.amazonaws.com';
function synthesizePlatform(stage: string, identityPhase?: IdentityPhase): Record<string, any> {
  const app = new cdk.App();
  const stack = new PlatformStack(app, `AnyWearPlatformStack-${stage}`, { stage, artifactInputs, identityPhase,
    ...(stage === 'beta' ? { apiOriginDomainName: TEST_API_ORIGIN_DOMAIN_NAME } : {}) });
  return Template.fromStack(stack).toJSON();
}

function synthesizeFoundation(identityPhase?: IdentityPhase): Record<string, any> {
  const app = new cdk.App();
  return Template.fromStack(new FoundationStack(app, 'AnyWearFoundationStack', { identityPhase, legacyRoleSource: 'cdk' })).toJSON();
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

describe('Platform safety controls', () => {
  it.each([
    ['dev', true, 'c45a8484eff8aabe92a894d5db6df813457ec863678a55eba153605d00098161'],
    // Includes the Beta-only scoped AdminInitiateAuth grant. The Beta hash moves
    // with the admission parameter set: one mode record and the tester allowlist
    // replace the two boolean parameters, so exactly two SSM ARNs remain.
    ['beta', true, 'c86fc2f59b97a97b932565443c53a5d96311a73d012950a39079885108ef60d4'],
    ['beta', false, 'c86fc2f59b97a97b932565443c53a5d96311a73d012950a39079885108ef60d4'],
    ['prod', true, '12feb7f5939fc6e88051f7b16871a679f6d47f6e5eb73c8fb54b44307d0d528b'],
  ] as const)('preserves pre-quota-repair effective pipeline grants for %s (active=%s)', (stage, environmentRunning, baselineHash) => {
    const app = new cdk.App({ context: cdkConfig.context });
    const stack = new PlatformStack(app, `AnyWearPlatformStack-${stage}`, {
      artifactInputs,
      stage, apiOriginDomainName: TEST_API_ORIGIN_DOMAIN_NAME, env: { account: '650880818323', region: 'ap-east-1' },
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

  it('bounds wildcard lifecycle evidence reads to the Beta pipeline region in the single topology', () => {
    const readActions = ['rds:DescribeDBClusters', 'rds:DescribeEvents', 'cloudwatch:GetMetricStatistics', 'ecs:ListTaskDefinitions', 'ecs:DescribeTaskDefinition'];
    {
      const app = new cdk.App();
      const stack = new PlatformStack(app, 'AnyWearPlatformStack-beta', {
        artifactInputs,
        stage: 'beta', apiOriginDomainName: TEST_API_ORIGIN_DOMAIN_NAME, env: { account: '650880818323', region: 'ap-east-1' },
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
    {
      const app = new cdk.App();
      const stack = new PlatformStack(app, 'AnyWearPlatformStack-beta', {
        artifactInputs,
        stage: 'beta', apiOriginDomainName: TEST_API_ORIGIN_DOMAIN_NAME, env: { account: '650880818323', region: 'ap-east-1' },
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
    expect(forAction('ssm:GetParameter')[0].Resource).toHaveLength(2);
  });

  it('preserves only exact cost families with a separate required request tag and Beta region bound', () => {
    {
      const app = new cdk.App();
      const stack = new PlatformStack(app, 'AnyWearPlatformStack-beta', {
        artifactInputs,
        stage: 'beta', apiOriginDomainName: TEST_API_ORIGIN_DOMAIN_NAME, env: { account: '650880818323', region: 'ap-east-1' },
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

    expect(resources.filter((resource) => resource.Type === 'AWS::RDS::DBCluster')).toHaveLength(0);
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
    expect(database.Properties.DeletionProtection).toBe(true);
    expect(database.Properties.BackupRetentionPeriod).toBe(7);
    expect(database.Properties.PreferredBackupWindow).toBe('16:00-16:30');
    expect(database.Properties.PreferredBackupWindow).toMatch(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/);
    // Issue #166: Beta's data is persistent Base state; a Base update can never
    // replace or delete the cluster.
    expect(database.DeletionPolicy).toBe('Retain');
    expect(database.UpdateReplacePolicy).toBe('Retain');
  });

  it('keeps Beta egress and compute out of the persistent Base stack', () => {
    const template = synthesizePlatform('beta');
    const resources = Object.values(template.Resources) as any[];
    // The disposable Egress stack owns the NAT, the EIP and the S3 gateway
    // endpoint; deleting it leaves the Base subnets isolated.
    expect(resources.filter((resource) => resource.Type === 'AWS::EC2::NatGateway')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::EC2::EIP')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::EC2::VPCEndpoint')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::EC2::Subnet')).toHaveLength(6);
    // The public route tables carry only the internet-gateway default route; no
    // Base route table has a NAT route or an S3 prefix-list route.
    const routes = resources.filter((resource) => resource.Type === 'AWS::EC2::Route');
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((route) => route.Properties.NatGatewayId === undefined
      && route.Properties.GatewayId !== undefined)).toBe(true);
    expect(resources.filter((resource) => resource.Type === 'AWS::RDS::DBCluster')).toHaveLength(1);
    expect(resources.filter((resource) => resource.Type === 'AWS::ECS::Cluster')).toHaveLength(1);
    // No environment activity output exists any more: run state is the existence
    // of the Runtime stack.
    expect(template.Outputs.BetaActive).toBeUndefined();
    expect(JSON.stringify(template.Outputs)).not.toContain('BetaActive');

    // The API distribution is pinned to the live source logical ID, uses the
    // literal origin, and is retained.
    const distributions = Object.entries(template.Resources)
      .filter(([, resource]: [string, any]) => resource.Type === 'AWS::CloudFront::Distribution');
    expect(distributions).toHaveLength(2);
    expect(distributions.map(([id]) => id)).toContain(API_DISTRIBUTION_IDENTITY.logicalId);
    expect(distributions.map(([id]) => id)).toContainEqual(expect.stringMatching(/^AnyWearClientDistribution[A-F0-9]{8}$/));
    const [, apiDistribution] = distributions.find(([id]) => id === API_DISTRIBUTION_IDENTITY.logicalId)! as [string, any];
    expect(apiDistribution.Properties.DistributionConfig.Origins[0]).toMatchObject({
      Id: API_DISTRIBUTION_IDENTITY.originId,
      DomainName: TEST_API_ORIGIN_DOMAIN_NAME,
    });
    expect(apiDistribution.Properties.DistributionConfig.DefaultCacheBehavior.TargetOriginId)
      .toBe(API_DISTRIBUTION_IDENTITY.originId);
    expect(apiDistribution.DeletionPolicy).toBe('Retain');
    expect(apiDistribution.UpdateReplacePolicy).toBe('Retain');

    // Persistent Base resources are retained together.
    for (const resource of resources.filter((entry) => entry.Type === 'AWS::S3::Bucket')) {
      expect(resource.UpdateReplacePolicy).toBe('Retain');
      expect(resource.DeletionPolicy).toBe('Retain');
    }
    const userPool = resources.find((resource) => resource.Type === 'AWS::Cognito::UserPool');
    expect(userPool.UpdateReplacePolicy).toBe('Retain');
    const repository = resources.find((resource) => resource.Type === 'AWS::ECR::Repository');
    expect(repository.UpdateReplacePolicy).toBe('Retain');
    expect(repository.DeletionPolicy).toBe('Retain');
  });


  it('keeps billing controls out of regional platform stacks', () => {
    const betaResources = Object.values(synthesizePlatform('beta').Resources) as any[];
    const prodResources = Object.values(synthesizePlatform('prod').Resources) as any[];

    expect(betaResources.some((resource) => resource.Type === 'AWS::EC2::VPCEndpoint')).toBe(false);
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
        && ['/anywear/beta/admission_mode', '/anywear/beta/tester_allowlist']
          .includes(resource.Properties.Name),
    ) as any[];
    expect(betaParameters.map((parameter) => parameter.Properties)).toEqual(expect.arrayContaining([
      expect.objectContaining({ Name: '/anywear/beta/admission_mode', Type: 'String', Value: '{"mode":"closed"}' }),
      expect.objectContaining({ Name: '/anywear/beta/tester_allowlist', Type: 'String', Value: '[]' }),
    ]));
    expect(betaParameters).toHaveLength(2);
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
        && /\/(admission_mode|tester_allowlist)$/.test(resource.Properties.Name))).toBe(false);
      expect(JSON.stringify(template)).not.toContain('cognito-idp:AdminUpdateUserAttributes');
      expect(JSON.stringify(template)).not.toContain('cognito-idp:AdminGetUser');
      expect(JSON.stringify(template)).not.toContain('cognito-idp:AdminInitiateAuth');
    }
  });

  it('limits both Beta Cognito triggers and lifecycle to the two admission parameters', () => {
    const template = synthesizePlatform('beta');
    const resources = Object.values(template.Resources) as any[];
    const expectedNames = ['admission_mode', 'tester_allowlist'];
    const expectedParameterIds = expectedNames.map((name) => Object.entries(template.Resources).find(
      ([, resource]: [string, any]) => resource.Type === 'AWS::SSM::Parameter'
        && resource.Properties.Name === `/anywear/beta/${name}`,
    )![0]);
    for (const functionName of ['beta-anywear-pre-sign-up', 'beta-anywear-post-confirmation-sync']) {
      const trigger = resources.find((resource) => resource.Type === 'AWS::Lambda::Function'
        && resource.Properties.FunctionName === functionName);
      // The trigger-level activity variable is gone: the admission decision gates
      // the same paths, and the stopped state is carried by the stack outputs.
      expect(trigger.Properties.Environment?.Variables?.BETA_ACTIVE).toBeUndefined();
      expect(JSON.stringify(trigger.Properties.Environment ?? {})).not.toContain('BETA_ACTIVE');
      const roleId = trigger.Properties.Role['Fn::GetAtt'][0];
      const policies = resources.filter((resource) => resource.Type === 'AWS::IAM::Policy'
        && resource.Properties.Roles.some((role: any) => role.Ref === roleId));
      const statements = policies.flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
        .filter((statement: any) => JSON.stringify(statement.Action).includes('ssm:'));
      expect(statements).toHaveLength(1);
      expect(statements[0].Action).toEqual(['ssm:GetParameter', 'ssm:GetParameters']);
      expect(statements[0].Resource).toHaveLength(2);
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
    expect(lifecycleStatements[0].Resource).toHaveLength(2);
    expect(lifecycleStatements[0].Resource.map((resource: any) => resource['Fn::Join'][1].at(-1).Ref))
      .toEqual(expectedParameterIds);
    expect(JSON.stringify(lifecycleStatements[0].Resource)).not.toContain('*');
  });

  it('publishes exactly the 35 unconditional Beta stage-contract parameters without duplicates', () => {
    const resources = Object.values(synthesizePlatform('beta').Resources) as any[];
    const parameters = resources.filter((resource) => resource.Type === 'AWS::SSM::Parameter');
    const names = parameters.map((parameter) => parameter.Properties.Name);
    expect(new Set(names).size).toBe(names.length);
    expect(parameters).toHaveLength(42);
    const stageContract = parameters.filter((parameter) => (
      parameter.Properties.Description?.startsWith('AnyWear-Service AnyWearRuntimeStack-beta stage contract: ')));
    expect(stageContract).toHaveLength(35);
    expect(stageContract.map((parameter) => parameter.Properties.Name).sort()).toEqual([
      'api_base_url', 'api_security_group_id', 'auto_tagging_dlq_name', 'auto_tagging_dlq_url', 'auto_tagging_queue_arn',
      'auto_tagging_queue_name', 'auto_tagging_queue_url', 'cloudfront_prefix_list_id', 'database_host',
      'database_port', 'database_secret_arn', 'ecs_cluster_arn', 'ecs_cluster_name', 'isolated_subnet_ids',
      'load_balancer_security_group_id', 'one_shot_execution_role_arn', 'one_shot_log_group_arn',
      'one_shot_log_group_name', 'one_shot_security_group_id', 'operations_topic_arn', 'private_subnet_ids',
      'public_subnet_ids', 's3_bucket_arn', 'service_repository_arn', 'service_repository_name',
      'service_repository_uri', 'verification_task_role_arn', 'vlm_config_arn', 'vpc_id', 'vto_dlq_name',
      'vto_dlq_url', 'vto_queue_arn', 'vto_queue_name', 'vto_queue_url', 'worker_security_group_id',
    ].map((name) => `/anywear/beta/${name}`).sort());
    expect(stageContract.filter((parameter) => parameter.Properties.Type === 'StringList')
      .map((parameter) => parameter.Properties.Name).sort())
      .toEqual(['/anywear/beta/isolated_subnet_ids', '/anywear/beta/private_subnet_ids', '/anywear/beta/public_subnet_ids']);
    expect(stageContract.every((parameter) => ['String', 'StringList'].includes(parameter.Properties.Type))).toBe(true);
    expect(stageContract.every((parameter) => parameter.Properties.Name.startsWith('/anywear/beta/'))).toBe(true);
    expect(stageContract.every((parameter) => parameter.Properties.Description.length > 60)).toBe(true);
    expect(stageContract.find((parameter) => parameter.Properties.Name === '/anywear/beta/vlm_config_arn')!.Properties.Value)
      .toBe('arn:aws:secretsmanager:ap-east-1:650880818323:secret:/anywear/beta/doubao_vlm_config-FEH2DQ');
    expect(stageContract.find((parameter) => parameter.Properties.Name === '/anywear/beta/cloudfront_prefix_list_id')!
      .Properties.Value).toBe('pl-14b2577d');
    // The cleanup role exists only outside the legacy phase, so neither the role
    // nor its ARN parameter is in the legacy synth.
    expect(resources.some((resource) => resource.Type === 'AWS::IAM::Role'
      && resource.Properties.RoleName === 'beta-anywear-tester-cleanup-task')).toBe(false);
    expect(stageContract.some((parameter) => parameter.Properties.Name === '/anywear/beta/cleanup_task_role_arn')).toBe(false);
    // The four reused published names and the three runtime-owned parameters
    // keep their existing single resource.
    for (const name of ['cognito_user_pool_id', 'cognito_client_id', 's3_bucket_name', 'qweather_api_host',
      'admission_mode', 'tester_allowlist', 'aws_region']) {
      expect(parameters.filter((parameter) => parameter.Properties.Name === `/anywear/beta/${name}`)).toHaveLength(1);
    }
    for (const stage of ['dev', 'prod']) {
      const other = Object.values(synthesizePlatform(stage).Resources) as any[];
      expect(other.filter((resource) => resource.Type === 'AWS::SSM::Parameter'
        && resource.Properties.Description?.includes('stage contract'))).toHaveLength(0);
    }

    expect(stageContractInputs('beta')).toEqual({
      vlmConfigArn: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:/anywear/beta/doubao_vlm_config-FEH2DQ',
      cloudFrontPrefixListId: 'pl-14b2577d',
    });
    expect(() => stageContractInputs('prod')).toThrow(/requires explicit vlmConfigArn and cloudFrontPrefixListId/);
    expect(() => stageContractInputs('dev')).toThrow(/requires explicit vlmConfigArn and cloudFrontPrefixListId/);
  });

  it('publishes the phase-dependent cleanup role ARN only while the identity phase creates the role', () => {
    {
      const legacy = Object.values(synthesizePlatform('beta').Resources) as any[];
      const added = Object.values(synthesizePlatform('beta', 'roles-added').Resources) as any[];
      const retired = Object.values(synthesizePlatform('beta', 'retired').Resources) as any[];
      const contract = (resources: any[]) => resources.filter((resource) => resource.Type === 'AWS::SSM::Parameter'
        && resource.Properties.Description?.startsWith('AnyWear-Service AnyWearRuntimeStack-beta stage contract: '));
      expect(contract(legacy)).toHaveLength(35);
      expect(contract(added)).toHaveLength(36);
      expect(contract(retired)).toHaveLength(36);
      for (const resources of [added, retired]) {
        const cleanup = contract(resources).filter((resource) => resource.Properties.Name === '/anywear/beta/cleanup_task_role_arn');
        expect(cleanup).toHaveLength(1);
        expect(cleanup[0].Properties.Type).toBe('String');
        expect(cleanup[0].Properties.Value).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^CleanupTaskRole[A-F0-9]{8}$/), 'Arn'] });
      }
    }
  });

  it('keeps the live one-shot execution-role log-stream grant', () => {
    for (const stage of ['beta', 'prod'] as const) {
      const app = new cdk.App();
      const stack = new PlatformStack(app, `AnyWearPlatformStack-${stage}`, {
        artifactInputs, stage, apiOriginDomainName: TEST_API_ORIGIN_DOMAIN_NAME,
        env: { account: '650880818323', region: 'ap-east-1' },
      });
      const template = Template.fromStack(stack).toJSON();
      const roleId = Object.entries(template.Resources).find(([, resource]: [string, any]) => (
        resource.Type === 'AWS::IAM::Role'
          && resource.Properties.RoleName === `${stage}-anywear-one-shot-execution`
      ))?.[0];
      expect(roleId).toBeDefined();
      const policy = Object.values(template.Resources).find((resource: any) => (
        resource.Type === 'AWS::IAM::Policy'
          && resource.Properties.Roles?.length === 1
          && resource.Properties.Roles[0]?.Ref === roleId
      )) as any;
      expect(policy).toBeDefined();
      const [logGroupId] = Object.entries(template.Resources).find(([, resource]: [string, any]) => (
        resource.Type === 'AWS::Logs::LogGroup'
          && resource.Properties.LogGroupName === `/anywear/${stage}/one-shot`
      ))!;
      expect(logGroupId).toMatch(/^OneShotLogGroup[A-F0-9]{8}$/);
      const statements = policy.Properties.PolicyDocument.Statement;
      // The live role has exactly three statements; the third is the awslogs
      // stream grant that `AwsLogDriver.bind()` appended while the release slice
      // was synthesized in this app.
      expect(statements).toHaveLength(3);
      expect(statements[0].Action).toEqual(expect.arrayContaining([
        'ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer',
      ]));
      expect(statements[1]).toEqual({ Action: 'ecr:GetAuthorizationToken', Effect: 'Allow', Resource: '*' });
      expect(statements[2]).toEqual({
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Effect: 'Allow',
        // The live grant's ARN ends in `:*`. Reference the log group's
        // CloudFormation `Arn` attribute (which includes that suffix) instead of
        // a hand-written literal that can omit it.
        Resource: { 'Fn::GetAtt': [logGroupId, 'Arn'] },
      });
      expect(statements[2].Resource)
        .not.toBe(`arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/${stage}/one-shot`);
    }
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
    const resources = Object.entries(template.Resources) as [string, any][];
    const bucket = resources.map(([, resource]) => resource).find(
      (resource) => resource.Type === 'AWS::S3::Bucket',
    ) as any;
    const [databaseId, database] = resources.find(
      ([, resource]) => resource.Type === 'AWS::RDS::DBCluster',
    )!;
    const writer = resources.find(([, resource]) => resource.Type === 'AWS::RDS::DBInstance'
      && resource.Properties.DBClusterIdentifier?.Ref === databaseId)?.[1];

    expect(bucket.DeletionPolicy).toBe('Retain');
    expect(database.DeletionPolicy).toBe('Retain');
    expect(database.Properties.DeletionProtection).toBe(true);
    expect(database.Properties.BackupRetentionPeriod).toBe(35);
    expect(database.Properties.PreferredBackupWindow).toBe('16:00-16:30');
    expect(database.Properties.StorageEncrypted).toBe(true);
    expect(writer.DeletionPolicy).toBe('Retain');
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
  // Issue #158 step A adds the Service deployment identities. Their grants live
  // in Foundation, not in the Platform-side dedicated role map.
  const serviceDeployRoleNames = ['service-deploy', 'service-deploy-cfn'];
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

  it('adds six distinct immutable OIDC identities and two Service deployment roles without changing existing Foundation resources', () => {
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
    const serviceRoles = (Object.values(added.Resources) as any[]).filter((resource) => resource.Type === 'AWS::IAM::Role'
      && serviceDeployRoleNames.some((name) => resource.Properties.RoleName === `beta-${name}-role`));
    expect(serviceRoles).toHaveLength(2);
    const deployRole = serviceRoles.find((role) => role.Properties.RoleName === 'beta-service-deploy-role')!;
    const cfnRole = serviceRoles.find((role) => role.Properties.RoleName === 'beta-service-deploy-cfn-role')!;
    const deployTrust = deployRole.Properties.AssumeRolePolicyDocument.Statement;
    expect(deployTrust).toHaveLength(1);
    expect(deployTrust[0]).toMatchObject({
      Action: 'sts:AssumeRoleWithWebIdentity',
      Effect: 'Allow',
      Condition: { StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': 'repo:git-malu@11473072/AnyWear-Service@1158460323:environment:beta',
      } },
    });
    expect(deployTrust[0].Principal.Federated.Ref).toMatch(/^GitHubProvider[A-F0-9]{8}$/);
    expect(cfnRole.Properties.AssumeRolePolicyDocument.Statement).toEqual([
      { Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'cloudformation.amazonaws.com' } },
    ]);
    for (const role of serviceRoles) expect(role.Properties.ManagedPolicyArns).toBeUndefined();
  });

  it('inventories the Service deployment roles as least privilege', () => {
    const env = { account: '650880818323', region: 'ap-east-1' };
    const app = new cdk.App();
    const foundation = Template.fromStack(new FoundationStack(app, 'AnyWearFoundationStack', {
      env, identityPhase: 'roles-added', legacyRoleSource: 'cdk',
    })).toJSON();
    const resources = Object.values(foundation.Resources) as any[];
    const roleId = (roleName: string) => Object.entries(foundation.Resources).find(([, resource]: [string, any]) => (
      resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === roleName))![0];
    const statementsFor = (roleName: string): any[] => {
      const id = roleId(roleName);
      return resources.filter((resource) => ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)
        && resource.Properties.Roles?.some((role: any) => role.Ref === id))
        .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    };
    const deploy = statementsFor('beta-service-deploy-role');
    const cfn = statementsFor('beta-service-deploy-cfn-role');
    const flatten = (values: any[]) => values.flatMap((value) => [value].flat());
    const actions = (statements: any[]) => flatten(statements.map((statement) => statement.Action)).sort();
    // Foundation synthesizes the partition as a token; resolve the fixed
    // partition and keep structural GetAtt references as their JSON form.
    const resourceOf = (value: any): string | string[] => {
      if (Array.isArray(value)) return value.map((entry) => resourceOf(entry) as string);
      if (typeof value === 'string') return value;
      if (value?.['Fn::Join']) {
        const [separator, parts] = value['Fn::Join'];
        return parts.map((part: any) => (part?.Ref === 'AWS::Partition' ? 'aws' : part)).join(separator);
      }
      return JSON.stringify(value);
    };
    const normalized = (statements: any[]) => statements.map((statement) => ({
      ...statement,
      Action: Array.isArray(statement.Action) ? [...statement.Action].sort() : statement.Action,
      Resource: resourceOf(statement.Resource),
    }));
    const resourcesOf = (statements: any[]) => new Set(flatten(statements.map((statement) => statement.Resource))
      .map(resourceOf) as string[]);

    // Positive: the OIDC role can only drive the Workload stack and pass one
    // CloudFormation execution role.
    expect(normalized(deploy)).toContainEqual({
      Action: 'cloudformation:*', Effect: 'Allow',
      Resource: 'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearWorkloadStack-beta/*',
    });
    expect(normalized(deploy)).toContainEqual({
      Action: ['cloudformation:CreateChangeSet', 'cloudformation:DeleteChangeSet', 'cloudformation:DescribeChangeSet'],
      Effect: 'Allow', Resource: 'arn:aws:cloudformation:ap-east-1:650880818323:changeSet/*',
    });
    expect(normalized(deploy)).toContainEqual({
      Action: 'cloudformation:DescribeStacks', Effect: 'Allow',
      Resource: 'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearPlatformStack-beta/*',
    });
    const deployPassRole = deploy.filter((statement) => [statement.Action].flat().includes('iam:PassRole'));
    expect(deployPassRole).toHaveLength(1);
    expect(JSON.stringify(deployPassRole[0].Resource)).toContain('BetaServiceDeployCfnRole');
    expect(deployPassRole[0].Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } });
    expect(normalized(deploy)).toContainEqual({
      Action: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'], Effect: 'Allow',
      Resource: 'arn:aws:ssm:ap-east-1:650880818323:parameter/anywear/beta/*',
    });
    expect(normalized(deploy)).toContainEqual({
      Action: 'ecr:DescribeImages', Effect: 'Allow',
      Resource: 'arn:aws:ecr:ap-east-1:650880818323:repository/beta-anywear-service',
    });

    // Positive: the deploy job's own 600-second bake (#162) reads the six named
    // signals live as this OIDC principal, so the read-only grants are here and
    // not on the CloudFormation execution role.
    expect(normalized(deploy)).toContainEqual({
      Action: 'cloudwatch:GetMetricStatistics', Effect: 'Allow', Resource: '*',
      Condition: { StringEquals: { 'aws:RequestedRegion': 'ap-east-1' } },
    });
    expect(normalized(deploy)).toContainEqual({
      Action: 'cloudwatch:DescribeAlarms', Effect: 'Allow',
      Resource: 'arn:aws:cloudwatch:ap-east-1:650880818323:alarm:beta-anywear-*',
    });
    expect(normalized(deploy)).toContainEqual(expect.objectContaining({
      Action: 'ecs:DescribeServices', Effect: 'Allow',
    }));
    const ecsRead = deploy.filter((statement) => statement.Action === 'ecs:DescribeServices');
    expect(ecsRead).toHaveLength(1);
    expect(new Set(([ecsRead[0].Resource].flat()).map(resourceOf))).toEqual(new Set([
      'arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-api',
      'arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-worker',
    ]));
    const sqsRead = deploy.filter((statement) => statement.Action === 'sqs:GetQueueAttributes');
    expect(sqsRead).toHaveLength(1);
    expect(new Set(([sqsRead[0].Resource].flat()).map(resourceOf))).toEqual(new Set([
      'arn:aws:sqs:ap-east-1:650880818323:beta-anywear-auto-tagging',
      'arn:aws:sqs:ap-east-1:650880818323:beta-anywear-auto-tagging-dlq',
      'arn:aws:sqs:ap-east-1:650880818323:beta-anywear-vto',
      'arn:aws:sqs:ap-east-1:650880818323:beta-anywear-vto-dlq',
    ]));
    expect(normalized(deploy)).toContainEqual({
      Action: 'logs:FilterLogEvents', Effect: 'Allow',
      Resource: ['arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/beta/worker',
        'arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/beta/worker:*'],
    });
    // The drill's one-off DLQ write is never a standing grant.
    expect(actions(deploy)).not.toEqual(expect.arrayContaining(['sqs:SendMessage']));

    // Positive: the CLI's own-credentials path from #158 round 3 is limited to
    // the bootstrap version read and the dedicated CDK assets bucket object.
    expect(normalized(deploy)).toContainEqual({
      Action: 'ssm:GetParameter', Effect: 'Allow',
      Resource: 'arn:aws:ssm:ap-east-1:650880818323:parameter/cdk-bootstrap/hnb659fds/version',
    });
    expect(normalized(deploy)).toContainEqual({
      Action: ['s3:GetObject', 's3:PutObject'], Effect: 'Allow',
      Resource: 'arn:aws:s3:::cdk-hnb659fds-assets-650880818323-ap-east-1/*',
    });
    expect(normalized(deploy)).toContainEqual({
      Action: ['s3:GetBucketLocation', 's3:ListBucket'], Effect: 'Allow',
      Resource: 'arn:aws:s3:::cdk-hnb659fds-assets-650880818323-ap-east-1',
    });

    // Negative: no wildcard, managed or administrative authority, and no
    // resource outside the reviewed Workload-stack and bake-read surface.
    expect(actions(deploy)).toEqual([
      'cloudformation:*', 'cloudformation:CreateChangeSet', 'cloudformation:DeleteChangeSet',
      'cloudformation:DescribeChangeSet', 'cloudformation:DescribeStacks',
      'cloudwatch:DescribeAlarms', 'cloudwatch:GetMetricStatistics',
      'ecr:DescribeImages', 'ecs:DescribeServices', 'iam:PassRole', 'logs:FilterLogEvents',
      's3:GetBucketLocation', 's3:GetObject', 's3:ListBucket', 's3:PutObject', 'sqs:GetQueueAttributes',
      'ssm:GetParameter', 'ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath',
    ]);
    expect(deploy.every((statement) => statement.Effect === 'Allow')).toBe(true);
    expect(resourcesOf(deploy)).toEqual(new Set([
      'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearWorkloadStack-beta/*',
      'arn:aws:cloudformation:ap-east-1:650880818323:changeSet/*',
      'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearPlatformStack-beta/*',
      'arn:aws:ssm:ap-east-1:650880818323:parameter/anywear/beta/*',
      'arn:aws:ssm:ap-east-1:650880818323:parameter/cdk-bootstrap/hnb659fds/version',
      'arn:aws:s3:::cdk-hnb659fds-assets-650880818323-ap-east-1',
      'arn:aws:s3:::cdk-hnb659fds-assets-650880818323-ap-east-1/*',
      'arn:aws:ecr:ap-east-1:650880818323:repository/beta-anywear-service',
      'arn:aws:cloudwatch:ap-east-1:650880818323:alarm:beta-anywear-*',
      'arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-api',
      'arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-worker',
      'arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/beta/worker',
      'arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/beta/worker:*',
      'arn:aws:sqs:ap-east-1:650880818323:beta-anywear-vto',
      'arn:aws:sqs:ap-east-1:650880818323:beta-anywear-vto-dlq',
      'arn:aws:sqs:ap-east-1:650880818323:beta-anywear-auto-tagging',
      'arn:aws:sqs:ap-east-1:650880818323:beta-anywear-auto-tagging-dlq',
      JSON.stringify({ 'Fn::GetAtt': ['BetaServiceDeployCfnRoleB6333451', 'Arn'] }),
      // The region-bound cloudwatch:GetMetricStatistics read has no narrower
      // resource scope; every other bake grant names a deployed resource.
      '*',
    ]));

    // Positive: the CloudFormation execution role covers exactly the Workload
    // template's resource families.
    const expectedCfnActions = [
      'application-autoscaling:DeleteScalingPolicy', 'application-autoscaling:DeregisterScalableTarget',
      'application-autoscaling:DescribeScalableTargets', 'application-autoscaling:DescribeScalingPolicies',
      'application-autoscaling:PutScalingPolicy', 'application-autoscaling:RegisterScalableTarget',
      'cloudformation:DescribeStacks',
      'cloudfront:CreateDistribution', 'cloudfront:CreateFunction', 'cloudfront:DeleteDistribution',
      'cloudfront:DeleteFunction', 'cloudfront:DescribeFunction', 'cloudfront:GetDistribution',
      'cloudfront:GetDistributionConfig', 'cloudfront:GetFunction', 'cloudfront:PublishFunction',
      'cloudfront:UpdateDistribution', 'cloudfront:UpdateFunction',
      'cloudwatch:DeleteAlarms', 'cloudwatch:DescribeAlarms', 'cloudwatch:PutMetricAlarm',
      'ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress',
      'ecs:CreateService', 'ecs:DeleteService', 'ecs:DeregisterTaskDefinition', 'ecs:DescribeServices',
      'ecs:DescribeTaskDefinition', 'ecs:RegisterTaskDefinition', 'ecs:UpdateService',
      'elasticloadbalancing:CreateListener', 'elasticloadbalancing:CreateLoadBalancer',
      'elasticloadbalancing:CreateRule', 'elasticloadbalancing:CreateTargetGroup',
      'elasticloadbalancing:DeleteListener', 'elasticloadbalancing:DeleteLoadBalancer',
      'elasticloadbalancing:DeleteRule', 'elasticloadbalancing:DeleteTargetGroup',
      'elasticloadbalancing:DescribeListeners', 'elasticloadbalancing:DescribeLoadBalancerAttributes',
      'elasticloadbalancing:DescribeLoadBalancers', 'elasticloadbalancing:DescribeRules',
      'elasticloadbalancing:DescribeTargetGroupAttributes', 'elasticloadbalancing:DescribeTargetGroups',
      'elasticloadbalancing:ModifyListener', 'elasticloadbalancing:ModifyLoadBalancerAttributes',
      'elasticloadbalancing:ModifyRule', 'elasticloadbalancing:ModifyTargetGroup',
      'elasticloadbalancing:ModifyTargetGroupAttributes', 'elasticloadbalancing:SetSecurityGroups',
      'elasticloadbalancing:SetSubnets',
      'iam:AttachRolePolicy', 'iam:CreateRole', 'iam:DeleteRole', 'iam:DeleteRolePolicy', 'iam:DetachRolePolicy',
      'iam:GetRole', 'iam:GetRolePolicy', 'iam:ListAttachedRolePolicies', 'iam:ListRolePolicies',
      'iam:PassRole', 'iam:PutRolePolicy',
      'logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:DeleteMetricFilter', 'logs:DeleteRetentionPolicy',
      'logs:DescribeLogGroups', 'logs:DescribeMetricFilters', 'logs:PutMetricFilter', 'logs:PutRetentionPolicy',
      's3:CreateBucket', 's3:DeleteBucket', 's3:DeleteBucketPolicy', 's3:DeleteBucketPublicAccessBlock',
      's3:GetBucketPolicy', 's3:GetBucketPublicAccessBlock', 's3:PutBucketPolicy',
      's3:PutBucketPublicAccessBlock',
      'ssm:GetParameter', 'ssm:GetParameters',
      'states:CreateStateMachine', 'states:DeleteStateMachine', 'states:DeleteStateMachineVersion',
      'states:DescribeStateMachine', 'states:ListStateMachineVersions', 'states:PublishStateMachineVersion',
      'states:UpdateStateMachine',
    ].sort();
    expect([...new Set(actions(cfn))].sort()).toEqual(expectedCfnActions);
    expect(cfn.every((statement) => statement.Effect === 'Allow')).toBe(true);
    expect(cfn.some((statement) => statement.NotAction !== undefined || statement.NotResource !== undefined)).toBe(false);
    // Positive: CloudFormation resolves the Workload stack's two
    // `AWS::Logs::LogGroup` `Arn` values with this role while it re-renders the
    // four policies that reference them, so the role needs the log-group read.
    // IAM evaluates `logs:DescribeLogGroups` in its list form -- CloudTrail
    // records the evaluated resource as
    // `arn:aws:logs:ap-east-1:650880818323:log-group::log-stream:` -- which no
    // named log-group ARN can match. The role therefore has exactly one such
    // grant, on the wildcard resource, with exactly this one action.
    const describeLogGroups = normalized(cfn).filter((statement) => [statement.Action].flat()
      .includes('logs:DescribeLogGroups'));
    expect(describeLogGroups).toHaveLength(1);
    expect(describeLogGroups[0]).toEqual({
      Action: 'logs:DescribeLogGroups', Effect: 'Allow', Resource: '*', Sid: 'DescribeWorkloadLogGroups',
    });
    // The wildcard is the only DescribeLogGroups statement: the same read is not
    // also carried in a named-resource form, and no other statement names a
    // log group (the lifecycle/retention statement is the only one left).
    expect(cfn.filter((statement) => [statement.Action].flat().includes('logs:DescribeLogGroups')))
      .toHaveLength(1);
    // Two statements name a log group: the lifecycle/retention statement and the
    // #162 worker metric-filter statement. The DescribeLogGroups wildcard names no
    // log group.
    expect(cfn.filter((statement) => JSON.stringify(statement.Resource).includes('log-group:')))
      .toHaveLength(2);
    expect(normalized(cfn)).toContainEqual({
      Action: ['logs:DeleteMetricFilter', 'logs:DescribeMetricFilters', 'logs:PutMetricFilter'],
      Effect: 'Allow',
      Resource: 'arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/beta/worker',
    });
    // The existing lifecycle/retention statement is unchanged: four actions on
    // the two log-group ARNs without the `:*` suffix.
    expect(normalized(cfn)).toContainEqual({
      Action: ['logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:DeleteRetentionPolicy', 'logs:PutRetentionPolicy'],
      Effect: 'Allow',
      Resource: ['arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/beta/api',
        'arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/beta/worker'],
    });
    // Negative: the CFN role's complete logs action set is exactly the lifecycle
    // four preserved above plus the one list-form read; every log content
    // read/write/delete/filter/tag/KMS action is absent, and the deployment role
    // holds no logs action at all.
    const allowedLogsActions = ['logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:DeleteMetricFilter',
      'logs:DeleteRetentionPolicy', 'logs:DescribeLogGroups', 'logs:DescribeMetricFilters',
      'logs:PutMetricFilter', 'logs:PutRetentionPolicy'];
    const cfnLogsActions = [...new Set(actions(cfn).filter((action) => action.startsWith('logs:')))].sort();
    expect(cfnLogsActions).toEqual(allowedLogsActions);
    // The deploy role's only log read is the #162 bake's FilterLogEvents; the
    // metric-filter writes belong to the CloudFormation execution role.
    expect(actions(deploy).filter((action) => action.startsWith('logs:'))).toEqual(['logs:FilterLogEvents']);
    for (const action of ['logs:PutMetricFilter', 'logs:DescribeMetricFilters', 'logs:DeleteMetricFilter']) {
      expect(actions(deploy)).not.toContain(action);
    }
    for (const action of ['logs:FilterLogEvents', 'logs:GetLogEvents', 'logs:PutLogEvents', 'logs:CreateLogStream',
      'logs:DeleteLogStream', 'logs:PutSubscriptionFilter', 'logs:TagResource',
      'logs:UntagResource', 'logs:AssociateKmsKey', 'logs:DisassociateKmsKey', 'logs:PutDataProtectionPolicy',
      'logs:DeleteSubscriptionFilter', 'logs:GetLogRecord', 'logs:DescribeLogStreams',
      'logs:DescribeSubscriptionFilters', 'logs:GetLogGroupFields',
      'logs:StartQuery', 'logs:StopQuery', 'logs:GetQueryResults', 'logs:CreateExportTask', 'logs:CancelExportTask',
      'logs:DescribeExportTasks', 'logs:PutResourcePolicy', 'logs:DeleteResourcePolicy',
      'logs:PutDestination', 'logs:DeleteDestination', 'logs:PutLogGroupDeletionProtection']) {
      expect(cfnLogsActions).not.toContain(action);
    }
    // Exactly three statements carry logs actions: the lifecycle/retention
    // statement, the single wildcard DescribeLogGroups statement and the #162
    // worker metric-filter statement.
    expect(cfn.filter((statement) => [statement.Action].flat()
      .some((action: string) => action.startsWith('logs:')))).toHaveLength(3);
    // Issue #158 round 13 / #162 D8: CloudFormation manages the Workload
    // template's CleanupOperation state machine and its StateMachineVersion.
    // Update/delete/version actions are authorized on the unqualified
    // state-machine ARN; CreateStateMachine has no resource type in the Step
    // Functions service authorization table, so it is the one service-level
    // action on `*`.
    const stateMachineArn = 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup';
    const stateActions = ['states:DeleteStateMachine', 'states:DeleteStateMachineVersion',
      'states:DescribeStateMachine', 'states:ListStateMachineVersions', 'states:PublishStateMachineVersion',
      'states:UpdateStateMachine'];
    const stateMachineStatement = normalized(cfn).filter((statement) => [statement.Action].flat()
      .includes('states:UpdateStateMachine'));
    expect(stateMachineStatement).toHaveLength(1);
    expect([...stateMachineStatement[0].Action].sort()).toEqual([...stateActions].sort());
    expect(stateMachineStatement[0].Resource).toBe(stateMachineArn);
    const stateCreate = normalized(cfn).filter((statement) => [statement.Action].flat()
      .includes('states:CreateStateMachine'));
    expect(stateCreate).toHaveLength(1);
    expect(stateCreate[0]).toEqual({
      Action: 'states:CreateStateMachine', Effect: 'Allow', Resource: '*',
    });
    expect(cfn.filter((statement) => [statement.Action].flat()
      .some((action: string) => action.startsWith('states:')))).toHaveLength(2);
    expect([...new Set(actions(cfn).filter((action) => action.startsWith('states:')))].sort())
      .toEqual([...stateActions, 'states:CreateStateMachine'].sort());
    for (const action of ['states:StartExecution', 'states:StartSyncExecution', 'states:StopExecution',
      'states:RedriveExecution', 'states:DescribeExecution', 'states:DescribeStateMachineForExecution',
      'states:GetExecutionHistory', 'states:ListExecutions', 'states:ListMapRuns', 'states:DescribeMapRun',
      'states:ListActivities', 'states:DescribeActivity', 'states:GetActivityTask',
      'states:ListStateMachines',
      'states:CreateStateMachineAlias', 'states:UpdateStateMachineAlias', 'states:DeleteStateMachineAlias',
      'states:ListStateMachineAliases', 'states:ListTagsForResource', 'states:TagResource', 'states:UntagResource',
      'states:TestState', 'states:RevealSecrets', 'states:InvokeHTTPEndpoint', 'states:SendTaskSuccess',
      'states:SendTaskFailure', 'states:SendTaskHeartbeat', 'states:ValidateStateMachineDefinition', 'states:*']) {
      expect(actions(cfn)).not.toContain(action);
    }
    expect(actions(deploy).filter((action) => action.startsWith('states:'))).toEqual([]);
    const taskRoleArns = ['task', 'execution'].flatMap((purpose) => ['api', 'worker'].map((service) => (
      `arn:aws:iam::650880818323:role/beta-anywear-${service}-${purpose}`))).sort();
    // Issue #158 round 12: the Workload template also creates the CleanupOperation
    // StateMachine role. CloudFormation reads it with `iam:GetRole`, so it joins
    // only the role-management statement's resources; it is not a compute
    // task/execution role, so `iam:PassRole` and the attach/detach statement keep
    // exactly the four task-role ARNs plus the three one-shot task roles.
    const cleanupOperationRoleArn = 'arn:aws:iam::650880818323:role/beta-anywear-tester-cleanup-operation';
    const workloadRoleArns = [...taskRoleArns, cleanupOperationRoleArn].sort();
    const cleanupTaskRoleArns = ['beta-anywear-tester-cleanup-task', 'beta-anywear-verification-task',
      'beta-anywear-one-shot-execution'].map((roleName) => `arn:aws:iam::650880818323:role/${roleName}`).sort();
    const externalInlinePolicyRoleArns = ['beta-e2e-qualification-role', 'beta-infra-runtime-role']
      .map((roleName) => `arn:aws:iam::650880818323:role/${roleName}`).sort();
    const iamPassRole = cfn.filter((statement) => [statement.Action].flat().includes('iam:PassRole'));
    expect(iamPassRole).toHaveLength(2);
    const ecsPassRole = iamPassRole.find((statement) =>
      statement.Condition?.StringEquals?.['iam:PassedToService'] === 'ecs-tasks.amazonaws.com');
    expect(ecsPassRole).toBeDefined();
    expect(([ecsPassRole!.Resource].flat() as any[]).map(resourceOf).sort())
      .toEqual([...taskRoleArns, ...cleanupTaskRoleArns].sort());
    expect(([ecsPassRole!.Resource].flat() as any[]).map(resourceOf)).not.toContain(cleanupOperationRoleArn);
    const statesPassRole = iamPassRole.find((statement) =>
      statement.Condition?.StringEquals?.['iam:PassedToService'] === 'states.amazonaws.com');
    expect(statesPassRole).toBeDefined();
    expect(([statesPassRole!.Resource].flat() as any[]).map(resourceOf)).toEqual([cleanupOperationRoleArn]);
    const attachPolicy = cfn.filter((statement) => [statement.Action].flat().includes('iam:AttachRolePolicy'));
    expect(attachPolicy).toHaveLength(1);
    expect(([attachPolicy[0].Resource].flat() as any[]).map(resourceOf).sort()).toEqual(taskRoleArns);
    expect(resourceOf(attachPolicy[0].Condition.ArnEquals['iam:PolicyARN']))
      .toBe('arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy');
    const roleManagement = cfn.filter((statement) => [statement.Action].flat().includes('iam:CreateRole'));
    expect(roleManagement).toHaveLength(1);
    expect(([roleManagement[0].Resource].flat() as any[]).map(resourceOf).sort()).toEqual(workloadRoleArns);
    // No action is added by the round-12 resource extension: the statement keeps
    // exactly its eight role read/manage actions, its unconditional form and no
    // wildcard resource.
    expect([roleManagement[0].Action].flat().sort()).toEqual(['iam:CreateRole', 'iam:DeleteRole',
      'iam:DeleteRolePolicy', 'iam:GetRole', 'iam:GetRolePolicy', 'iam:ListAttachedRolePolicies',
      'iam:ListRolePolicies', 'iam:PutRolePolicy']);
    expect(roleManagement[0].Condition).toBeUndefined();
    expect(([roleManagement[0].Resource].flat() as any[]).map(resourceOf)).not.toContain('*');
    const externalInlinePolicy = cfn.filter((statement) => [statement.Action].flat()
      .includes('iam:PutRolePolicy')
      && [statement.Resource].flat().map(resourceOf).includes('arn:aws:iam::650880818323:role/beta-e2e-qualification-role'));
    expect(externalInlinePolicy).toHaveLength(1);
    expect([externalInlinePolicy[0].Action].flat().sort())
      .toEqual(['iam:DeleteRolePolicy', 'iam:GetRolePolicy', 'iam:PutRolePolicy']);
    expect(([externalInlinePolicy[0].Resource].flat() as any[]).map(resourceOf).sort())
      .toEqual(externalInlinePolicyRoleArns);
    expect(externalInlinePolicy[0].Condition).toBeUndefined();
    const ec2Ingress = cfn.filter((statement) => [statement.Action].flat().includes('ec2:AuthorizeSecurityGroupIngress'));
    expect(ec2Ingress).toHaveLength(1);
    expect(ec2Ingress[0].Condition).toEqual({ StringEquals: {
      'ec2:ResourceTag/aws:cloudformation:stack-name': 'AnyWearPlatformStack-beta',
      'ec2:ResourceTag/aws:cloudformation:logical-id': 'LoadBalancerSecurityGroup3036A0FC',
    } });
    expect(resourcesOf(cfn)).toEqual(new Set([
      'arn:aws:application-autoscaling:ap-east-1:650880818323:scalable-target/*',
      'arn:aws:application-autoscaling:ap-east-1:650880818323:scaling-policy/*',
      'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearPlatformStack-beta/*',
      'arn:aws:cloudfront::650880818323:distribution/*',
      'arn:aws:cloudfront::650880818323:function/*',
      'arn:aws:cloudwatch:ap-east-1:650880818323:alarm:beta-anywear-*',
      'arn:aws:ec2:ap-east-1:650880818323:security-group/*',
      'arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-api',
      'arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-worker',
      'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-api:*',
      'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-cleanup:*',
      'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-cleanup-verify:*',
      'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-worker:*',
      'arn:aws:elasticloadbalancing:ap-east-1:650880818323:listener-rule/app/beta-anywear-api/*',
      'arn:aws:elasticloadbalancing:ap-east-1:650880818323:listener/app/beta-anywear-api/*',
      'arn:aws:elasticloadbalancing:ap-east-1:650880818323:loadbalancer/app/beta-anywear-api/*',
      'arn:aws:elasticloadbalancing:ap-east-1:650880818323:targetgroup/beta-anywear-api/*',
      'arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/beta/api',
      'arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/beta/worker',
      'arn:aws:s3:::anywearworkloadstack-beta-*',
      'arn:aws:ssm:ap-east-1:650880818323:parameter/anywear/beta/*',
      'arn:aws:ssm:ap-east-1:650880818323:parameter/cdk-bootstrap/hnb659fds/version',
      'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup',
      ...workloadRoleArns,
      ...cleanupTaskRoleArns,
      ...externalInlinePolicyRoleArns,
      '*',
    ]));

    // The acceptance criterion: neither role can modify the VPC, Aurora,
    // Cognito, the wardrobe/client buckets, SQS configuration or ECR
    // configuration, or the Foundation stack and its existing roles. The only
    // SQS grant is the deploy job's read-only bake read of the four stage queues.
    for (const [roleName, statements] of [['beta-service-deploy-role', deploy],
      ['beta-service-deploy-cfn-role', cfn]] as const) {
      const allActions = actions(statements);
      const serialized = JSON.stringify(statements);
      expect(allActions).not.toContain('*');
      for (const forbidden of ['rds:', 'cognito-idp:', 'secretsmanager:', 'kms:',
        's3:DeleteObject', 's3:PutBucketAcl', 's3:PutObjectAcl',
        'ecr:PutImage', 'ecr:SetRepositoryPolicy', 'ecr:DeleteRepository',
        'ecr:CreateRepository', 'ec2:CreateVpc', 'ec2:DeleteVpc', 'ec2:ModifyVpcAttribute',
        'ec2:CreateSubnet', 'ec2:DeleteSubnet', 'ec2:CreateSecurityGroup', 'ec2:DeleteSecurityGroup',
        'ec2:AuthorizeSecurityGroupEgress', 'cloudformation:CreateStack', 'cloudformation:UpdateStack',
        'cloudformation:DeleteStack', 'iam:CreatePolicy', 'iam:CreatePolicyVersion', 'iam:PutRolePermissionsBoundary',
        'iam:AttachUserPolicy', 'iam:CreateUser', 'iam:UpdateAssumeRolePolicy']) {
        expect(allActions.some((action) => action.startsWith(forbidden))).toBe(false);
      }
      expect(allActions.filter((action) => action.startsWith('sqs:')))
        .toEqual(roleName === 'beta-service-deploy-role' ? ['sqs:GetQueueAttributes'] : []);
      expect(serialized).not.toContain('AdministratorAccess');
      expect(serialized).not.toContain('AnyWearFoundationStack');
      expect(serialized).not.toContain('AnyWearWardrobeBucket');
      expect(serialized).not.toContain('AnyWearClientBucket');
      expect(serialized).not.toContain('AnyWearUserPool');
      expect(serialized).not.toContain('github-actions-pipeline-role');
      for (const resource of resourcesOf(statements)) {
        if (resource.startsWith('arn:aws:iam::')) {
          expect([...workloadRoleArns, ...cleanupTaskRoleArns, ...externalInlinePolicyRoleArns]).toContain(resource);
        }
      }
      expect(resources.some((resource) => resource.Type === 'AWS::IAM::ManagedPolicy'
        && JSON.stringify(resource.Properties.Roles).includes(`beta-${roleName}`))).toBe(false);
    }
    // The CloudFormation role carries exactly five IAM statements (role
    // management, external inline-policy targets, attach/detach, ECS PassRole,
    // states PassRole), and every IAM resource is one of the ten Workload-owned
    // or Foundation-managed role ARNs: no wildcard, policy, user or group.
    const iamStatements = cfn.filter((statement) => [statement.Action].flat()
      .some((action: string) => action.startsWith('iam:')));
    expect(iamStatements).toHaveLength(5);
    for (const statement of iamStatements) {
      for (const resource of ([statement.Resource].flat() as any[]).map(resourceOf)) {
        expect(resource).toMatch(/^arn:aws:iam::650880818323:role\/beta-(?:anywear|e2e|infra)-[a-z0-9-]+$/);
      }
    }
    // The only object write either role holds is the template asset in the
    // dedicated CDK assets bucket; no other bucket, bucket configuration or
    // object deletion grant returns with it.
    const cdkAssetsBucketArns = new Set([
      'arn:aws:s3:::cdk-hnb659fds-assets-650880818323-ap-east-1',
      'arn:aws:s3:::cdk-hnb659fds-assets-650880818323-ap-east-1/*',
    ]);
    const deployS3Resources = [...resourcesOf(deploy)].filter((resource) => resource.startsWith('arn:aws:s3:::'));
    expect(new Set(deployS3Resources)).toEqual(cdkAssetsBucketArns);
    expect(actions(deploy).filter((action) => action.startsWith('s3:')))
      .toEqual(['s3:GetBucketLocation', 's3:GetObject', 's3:ListBucket', 's3:PutObject']);
    for (const forbidden of ['s3:CreateBucket', 's3:DeleteBucket', 's3:PutBucketPolicy', 's3:DeleteBucketPolicy',
      's3:PutBucketPublicAccessBlock', 's3:DeleteBucketPublicAccessBlock', 's3:DeleteObject']) {
      expect(actions(deploy)).not.toContain(forbidden);
    }
    expect(resourcesOf(cfn).has('arn:aws:s3:::anywearworkloadstack-beta-*')).toBe(true);
    expect([...resourcesOf(cfn)].some((resource) => resource.includes('cdk-hnb659fds-assets'))).toBe(false);
    // The CloudFormation role can read the producer stack for
    // `Fn::GetStackOutput`, but it cannot drive CloudFormation itself; only the
    // OIDC role owns the Workload stack's stack-level authority.
    expect(actions(cfn).filter((action) => action.startsWith('cloudformation:')))
      .toEqual(['cloudformation:DescribeStacks']);
    expect(resourceOf(cfn.filter((statement) => [statement.Action].flat().includes('cloudformation:DescribeStacks'))[0]
      .Resource)).toBe('arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearPlatformStack-beta/*');
  });

  // Regression for the #162 Testing failure: a CloudWatch alarm ARN is
  // `arn:aws:cloudwatch:<region>:<account>:alarm:<AlarmName>`. A slash resource
  // form (`...:alarm/<AlarmName>`) matches no alarm, so `DescribeAlarms` in the
  // bake and the CloudFormation role's alarm writes were both AccessDenied. The
  // fail-closed gate then reported all six signals insufficient and no v4 record
  // could exist. This test pins the canonical colon form for both roles.
  it('scopes CloudWatch alarm ARNs with the colon resource form', () => {
    const env = { account: '650880818323', region: 'ap-east-1' };
    const app = new cdk.App();
    const foundation = Template.fromStack(new FoundationStack(app, 'AnyWearFoundationStack', {
      env, identityPhase: 'roles-added', legacyRoleSource: 'cdk',
    })).toJSON();
    const resources = foundation.Resources as Record<string, any>;
    const roleId = (roleName: string): string => Object.entries(resources).find(([, resource]: [string, any]) => (
      resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === roleName))![0];
    const statementsFor = (roleName: string): any[] => (Object.values(resources) as any[])
      .filter((resource) => ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)
        && resource.Properties.Roles?.some((role: any) => role.Ref === roleId(roleName)))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const render = (value: any): string => {
      if (typeof value === 'string') return value;
      if (value?.['Fn::Join']) {
        const [separator, parts] = value['Fn::Join'];
        return parts.map((part: any) => (part?.Ref === 'AWS::Partition' ? 'aws' : part)).join(separator);
      }
      return JSON.stringify(value);
    };
    const canonical = 'arn:aws:cloudwatch:ap-east-1:650880818323:alarm:beta-anywear-*';
    for (const [roleName, action] of [['beta-service-deploy-role', 'cloudwatch:DescribeAlarms'],
      ['beta-service-deploy-cfn-role', 'cloudwatch:PutMetricAlarm']] as const) {
      const matching = statementsFor(roleName).filter((statement) => [statement.Action].flat().includes(action));
      expect(matching).toHaveLength(1);
      expect([matching[0].Resource].flat().map(render)).toEqual([canonical]);
    }
    for (const roleName of ['beta-service-deploy-role', 'beta-service-deploy-cfn-role']) {
      for (const statement of statementsFor(roleName)) {
        if (![statement.Action].flat().some((action: string) => action.startsWith('cloudwatch:'))) continue;
        for (const resource of [statement.Resource].flat().map(render)) {
          expect(resource).not.toContain(':alarm/');
          if (resource !== '*') expect(resource).toMatch(/^arn:aws:cloudwatch:ap-east-1:650880818323:alarm:[A-Za-z0-9_*?.-]+$/);
        }
      }
    }
  });

  /**
   * The actions CloudFormation's handlers need to create, update, read and
   * delete each resource type the #162 Workload extension adds. The execution
   * role, not the deploy role, applies these resources. The fixture lists the
   * exact recorded extension resources: adding a resource type to that fixture
   * without extending this table fails the test, and the Service-side
   * `extension-grants` test fails when the recorded extension adds a type this
   * table does not cover.
   */
  const WORKLOAD_EXTENSION_ACTIONS: Record<string, string[]> = {
    'AWS::CloudWatch::Alarm': ['cloudwatch:PutMetricAlarm', 'cloudwatch:DescribeAlarms', 'cloudwatch:DeleteAlarms'],
    'AWS::Logs::MetricFilter': ['logs:PutMetricFilter', 'logs:DescribeMetricFilters', 'logs:DeleteMetricFilter'],
  };

  it('grants the CloudFormation execution role every action the #162 extension resource types need', () => {
    const recordedTypes = [...new Set(workloadExtensionResources.resources.map((resource) => resource.type))].sort();
    expect(recordedTypes).toEqual(Object.keys(WORKLOAD_EXTENSION_ACTIONS).sort());
    const env = { account: '650880818323', region: 'ap-east-1' };
    const app = new cdk.App();
    const foundation = Template.fromStack(new FoundationStack(app, 'AnyWearFoundationStack', {
      env, identityPhase: 'roles-added', legacyRoleSource: 'cdk',
    })).toJSON();
    const resources = Object.values(foundation.Resources) as any[];
    const roleId = Object.entries(foundation.Resources).find(([, resource]: [string, any]) => (
      resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === 'beta-service-deploy-cfn-role'))![0];
    const statements = resources.filter((resource) => ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)
      && resource.Properties.Roles?.some((role: any) => role.Ref === roleId))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const granted = new Set(statements.flatMap((statement) => [statement.Action].flat()));
    for (const [type, required] of Object.entries(WORKLOAD_EXTENSION_ACTIONS)) {
      for (const action of required) {
        expect({ type, action, granted: granted.has(action) }).toEqual({ type, action, granted: true });
      }
    }
    const render = (value: any): string => {
      if (typeof value === 'string') return value;
      if (value?.['Fn::Join']) {
        const [separator, parts] = value['Fn::Join'];
        return parts.map((part: any) => (part?.Ref === 'AWS::Partition' ? 'aws' : part)).join(separator);
      }
      return JSON.stringify(value);
    };
    // The metric-filter grant is worker-log-group-only and uses the log-group
    // resource ARN (no `:*` suffix: the CloudWatch Logs metric-filter APIs
    // authorize on the log-group resource type, not the log-stream one). No
    // filter exists on the api log group, so its grant is not repeated there.
    const filterStatements = statements.filter((statement) => [statement.Action].flat().includes('logs:PutMetricFilter'));
    expect(filterStatements).toHaveLength(1);
    expect([filterStatements[0].Resource].flat().map(render)).toEqual([
      'arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/beta/worker',
    ]);
    const alarmStatements = statements.filter((statement) => [statement.Action].flat().includes('cloudwatch:PutMetricAlarm'));
    expect(alarmStatements).toHaveLength(1);
    expect([alarmStatements[0].Resource].flat().map(render)).toEqual([
      'arn:aws:cloudwatch:ap-east-1:650880818323:alarm:beta-anywear-*',
    ]);
  });

  it('grants every declared bake AWS call on the API resource form inside its target', () => {
    // The table is the Infra half of the bake-read contract. The Service half
    // (infra/test/bake-reads.test.mjs in AnyWear-Service) derives the same call
    // set from scripts/bake-gate.mjs and fails when a call is added without an
    // entry here. Each entry must have exactly one grant, in the API's resource
    // form, inside the reviewed target.
    const reads = (workloadBakeReads as any).reads as Array<{
      call: string; action: string; grant: string; target: string; resources: string[];
      condition?: unknown; attributes?: string[]; namespaces?: string[];
    }>;
    expect(reads).toHaveLength(6);
    expect(new Set(reads.map((read) => read.call)).size).toBe(6);
    const env = { account: '650880818323', region: 'ap-east-1' };
    const app = new cdk.App();
    const foundation = Template.fromStack(new FoundationStack(app, 'AnyWearFoundationStack', {
      env, identityPhase: 'roles-added', legacyRoleSource: 'cdk',
    })).toJSON();
    const resources = Object.values(foundation.Resources) as any[];
    const roleId = Object.entries(foundation.Resources).find(([, resource]: [string, any]) => (
      resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === 'beta-service-deploy-role'))![0];
    const statements = resources.filter((resource) => ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)
      && resource.Properties.Roles?.some((role: any) => role.Ref === roleId))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const render = (value: any): string => {
      if (typeof value === 'string') return value;
      if (value?.['Fn::Join']) {
        const [separator, parts] = value['Fn::Join'];
        return parts.map((part: any) => (part?.Ref === 'AWS::Partition' ? 'aws' : part)).join(separator);
      }
      return JSON.stringify(value);
    };
    for (const read of reads) {
      const matching = statements.filter((statement) => [statement.Action].flat().includes(read.action));
      expect(matching).toHaveLength(1);
      expect(new Set([matching[0].Resource].flat().map(render)))
        .toEqual(new Set(read.resources));
      expect(matching[0].Condition).toEqual(read.condition);
      if (read.attributes !== undefined) {
        // The SQS read names only the three live-valid depth attributes; the
        // age is the AWS/SQS CloudWatch metric, not a GetQueueAttributes name.
        expect(read.attributes).toEqual([...DEPLOYMENT_SQS_DEPTH_ATTRIBUTES]);
        expect(read.attributes).not.toContain('ApproximateAgeOfOldestMessage');
        expect(read.attributes).not.toContain('ApproximateNumberOfMessagesVisible');
      }
      if (read.namespaces !== undefined) {
        expect(read.namespaces).toEqual(['AWS/ApplicationELB', 'AWS/SQS']);
      }
    }
    // Only the CloudFormation stack-resource read predates #162; the other five
    // grants are part of this extension.
    expect(reads.filter((read) => read.grant === '#162')).toHaveLength(5);
    expect(reads.filter((read) => read.grant === 'pre-existing').map((read) => read.call))
      .toEqual(['cloudformation:list-stack-resources']);
  });

  it('grants every CFN action the full Workload resource-type table requires', () => {
    // The table is derived from the synthesized roles-added Workload template.
    // The recorded template has 20 types: MetricFilter is present and CDK
    // Metadata is not, despite the prose list naming the latter and omitting the
    // former. A type added to the Workload template must be added here (and its
    // handler actions granted) before the deploy can create it.
    const table = (workloadCfnActions as any).resource_types as Array<{
      type: string; actions: string[]; wildcard_actions?: string[];
    }>;
    expect(table).toHaveLength(20);
    const types = table.map((entry) => entry.type);
    expect(new Set(types).size).toBe(types.length);
    expect(types).toContain('AWS::Logs::MetricFilter');
    expect(types).not.toContain('AWS::CDK::Metadata');
    const env = { account: '650880818323', region: 'ap-east-1' };
    const app = new cdk.App();
    const foundation = Template.fromStack(new FoundationStack(app, 'AnyWearFoundationStack', {
      env, identityPhase: 'roles-added', legacyRoleSource: 'cdk',
    })).toJSON();
    const resources = Object.values(foundation.Resources) as any[];
    const roleId = Object.entries(foundation.Resources).find(([, resource]: [string, any]) => (
      resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === 'beta-service-deploy-cfn-role'))![0];
    const statements = resources.filter((resource) => ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)
      && resource.Properties.Roles?.some((role: any) => role.Ref === roleId))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const render = (value: any): string => {
      if (typeof value === 'string') return value;
      if (value?.['Fn::Join']) {
        const [separator, parts] = value['Fn::Join'];
        return parts.map((part: any) => (part?.Ref === 'AWS::Partition' ? 'aws' : part)).join(separator);
      }
      return JSON.stringify(value);
    };
    const granted = new Set(statements.flatMap((statement) => [statement.Action].flat()));
    for (const entry of table) {
      expect(entry.actions.length).toBeGreaterThan(0);
      expect(new Set(entry.actions).size).toBe(entry.actions.length);
      for (const action of entry.actions) {
        expect(granted.has(action)).toBe(true);
        const matching = statements.filter((statement) => [statement.Action].flat().includes(action));
        expect(matching.length).toBeGreaterThan(0);
        const resourcesForAction = matching.flatMap((statement) => [statement.Resource].flat().map(render));
        if ((entry.wildcard_actions ?? []).includes(action)) {
          expect(resourcesForAction).toContain('*');
        } else {
          expect(resourcesForAction).not.toContain('*');
        }
      }
    }
  });

  it('covers every concrete Workload resource with the granted actions', () => {
    // Action presence is not enough: the statement that grants an action must
    // also name the concrete resource. The previous #84 grant passed the action
    // table but missed the Foundation-managed E2E and Infra-runtime role policies
    // that the Workload template rewrites.
    const coverage = (workloadCfnActions as any).resource_coverage as {
      iam_policy_target_roles: string[]; task_definition_families: string[]; ecs_services: string[];
      log_groups: string[]; metric_filter_log_group: string; state_machines: string[]; queues: string[];
    };
    const env = { account: '650880818323', region: 'ap-east-1' };
    const app = new cdk.App();
    const foundation = Template.fromStack(new FoundationStack(app, 'AnyWearFoundationStack', {
      env, identityPhase: 'roles-added', legacyRoleSource: 'cdk',
    })).toJSON();
    const resources = Object.values(foundation.Resources) as any[];
    const roleId = Object.entries(foundation.Resources).find(([, resource]: [string, any]) => (
      resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === 'beta-service-deploy-cfn-role'))![0];
    const statements = resources.filter((resource) => ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)
      && resource.Properties.Roles?.some((role: any) => role.Ref === roleId))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const render = (value: any): string => {
      if (typeof value === 'string') return value;
      if (value?.['Fn::Join']) {
        const [separator, parts] = value['Fn::Join'];
        return parts.map((part: any) => (part?.Ref === 'AWS::Partition' ? 'aws' : part)).join(separator);
      }
      return JSON.stringify(value);
    };
    const covers = (action: string, resource: string) => statements.some((statement) => (
      [statement.Action].flat().includes(action)
      && [statement.Resource].flat().map(render).includes(resource)));
    for (const role of coverage.iam_policy_target_roles) {
      for (const action of ['iam:PutRolePolicy', 'iam:GetRolePolicy', 'iam:DeleteRolePolicy']) {
        expect(covers(action, role)).toBe(true);
      }
    }
    for (const family of coverage.task_definition_families) {
      expect(covers('ecs:RegisterTaskDefinition', family)).toBe(true);
    }
    for (const service of coverage.ecs_services) {
      for (const action of ['ecs:CreateService', 'ecs:UpdateService', 'ecs:DeleteService', 'ecs:DescribeServices']) {
        expect(covers(action, service)).toBe(true);
      }
    }
    for (const logGroup of coverage.log_groups) {
      for (const action of ['logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:PutRetentionPolicy',
        'logs:DeleteRetentionPolicy']) {
        expect(covers(action, logGroup)).toBe(true);
      }
    }
    for (const action of ['logs:PutMetricFilter', 'logs:DescribeMetricFilters', 'logs:DeleteMetricFilter']) {
      expect(covers(action, coverage.metric_filter_log_group)).toBe(true);
    }
    for (const stateMachine of coverage.state_machines) {
      for (const action of ['states:UpdateStateMachine', 'states:DeleteStateMachine',
        'states:PublishStateMachineVersion', 'states:DeleteStateMachineVersion',
        'states:DescribeStateMachine', 'states:ListStateMachineVersions']) {
        expect(covers(action, stateMachine)).toBe(true);
      }
    }
    // The Workload template declares no SQS queue resources; the task
    // definitions read queue URLs from SSM at runtime. No CFN SQS action may
    // appear on the execution role.
    expect(coverage.queues).toEqual([]);
    const grantedActions = [...new Set(statements.flatMap((statement) => [statement.Action].flat()))];
    expect(grantedActions.filter((action) => action.startsWith('sqs:'))).toEqual([]);
  });

  it('leaves every cdk-hnb659fds-* role unassumable and confines CloudFormation to AnyWearWorkloadStack-beta', () => {
    const env = { account: '650880818323', region: 'ap-east-1' };
    const app = new cdk.App();
    const foundation = Template.fromStack(new FoundationStack(app, 'AnyWearFoundationStack', {
      env, identityPhase: 'roles-added', legacyRoleSource: 'cdk',
    })).toJSON();
    const resources = Object.values(foundation.Resources) as any[];
    const roleId = Object.entries(foundation.Resources).find(([, resource]: [string, any]) => (
      resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === 'beta-service-deploy-role'))![0];
    const statements = resources.filter((resource) => ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)
      && resource.Properties.Roles?.some((role: any) => role.Ref === roleId))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const flatten = (values: any[]) => values.flatMap((value) => [value].flat());
    const actions = flatten(statements.map((statement) => statement.Action)) as string[];
    const resolve = (value: any): string | string[] => {
      if (Array.isArray(value)) return value.map((entry) => resolve(entry) as string);
      if (typeof value === 'string') return value;
      if (value?.['Fn::Join']) {
        const [separator, parts] = value['Fn::Join'];
        return parts.map((part: any) => (part?.Ref === 'AWS::Partition' ? 'aws' : part)).join(separator);
      }
      return JSON.stringify(value);
    };
    // Round 3 puts the asset publish on the deploy job's own credentials. That is
    // not authority to reassume the bootstrap deploy/file-publishing/lookup
    // roles: the role keeps no sts:AssumeRole at all.
    expect(actions).not.toContain('sts:AssumeRole');
    const serializedResources = JSON.stringify(statements.map((statement) => statement.Resource));
    for (const purpose of ['deploy', 'file-publishing', 'lookup']) {
      expect(serializedResources).not.toContain(`cdk-hnb659fds-${purpose}-role`);
    }
    expect(serializedResources).not.toMatch(/role\/cdk-/);
    // Every CloudFormation action is bound to the Workload stack, its change
    // sets, or the exact producer-stack read; nothing else can be deployed.
    const cloudformationResources = new Set<string>();
    for (const statement of statements.filter((statement) => [statement.Action].flat()
      .some((action: string) => action.startsWith('cloudformation:')))) {
      const statementActions = [statement.Action].flat() as string[];
      for (const resource of flatten([statement.Resource]).map(resolve) as string[]) {
        cloudformationResources.add(resource);
        if (resource === 'arn:aws:cloudformation:ap-east-1:650880818323:changeSet/*') {
          for (const action of statementActions) expect(['cloudformation:CreateChangeSet',
            'cloudformation:DeleteChangeSet', 'cloudformation:DescribeChangeSet']).toContain(action);
        } else if (resource === 'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearWorkloadStack-beta/*') {
          expect(statementActions.every((action) => action === 'cloudformation:*')).toBe(true);
        } else if (resource === 'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearPlatformStack-beta/*') {
          expect(statementActions).toEqual(['cloudformation:DescribeStacks']);
        } else {
          throw new Error(`Unreviewed CloudFormation resource ${resource}`);
        }
      }
    }
    expect(cloudformationResources).toEqual(new Set([
      'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearWorkloadStack-beta/*',
      'arn:aws:cloudformation:ap-east-1:650880818323:changeSet/*',
      'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearPlatformStack-beta/*',
    ]));
    // `cloudformation:*` appears once, on the Workload stack, so no other stack
    // can be created, updated or deleted.
    const wildcardStatements = statements.filter((statement) => [statement.Action].flat()
      .includes('cloudformation:*'));
    expect(wildcardStatements).toHaveLength(1);
    expect(flatten([wildcardStatements[0].Resource]).map(resolve))
      .toEqual(['arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearWorkloadStack-beta/*']);
    for (const action of ['cloudformation:CreateStack', 'cloudformation:UpdateStack', 'cloudformation:DeleteStack']) {
      expect(actions).not.toContain(action);
    }
  });

  it('adds policies while retaining every legacy Beta resource and output', () => {
    const legacy = synthesizePlatform('beta');
    const added = synthesizePlatform('beta', 'roles-added');
    for (const [id, resource] of Object.entries(legacy.Resources)) expect(added.Resources[id]).toEqual(resource);
    for (const [key, value] of Object.entries(legacy.Outputs)) expect(added.Outputs[key]).toEqual(value);
    expect(Object.keys(added.Outputs).filter(key => !legacy.Outputs[key])).toEqual(['CleanupTaskRoleArn']);
    const newResources = Object.entries(added.Resources).filter(([id]) => !legacy.Resources[id]);
    expect(newResources).toHaveLength(8);
    expect(newResources.filter(([, resource]: [string, any]) => resource.Type === 'AWS::IAM::Policy')).toHaveLength(6);
    const cleanup = newResources.find(([, resource]: [string, any]) => resource.Type === 'AWS::IAM::Role')![1] as any;
    expect(cleanup.Properties.RoleName).toBe('beta-anywear-tester-cleanup-task');
    const cleanupParameter = newResources
      .filter(([, resource]: [string, any]) => resource.Type === 'AWS::SSM::Parameter') as [string, any][];
    expect(cleanupParameter).toHaveLength(1);
    expect(cleanupParameter[0][1].Properties.Name).toBe('/anywear/beta/cleanup_task_role_arn');
    expect(cleanupParameter[0][1].Properties.Description).toContain('stage contract: dedicated cleanup task role ARN');
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
    expect(pipelinePolicies(synthesizePlatform('beta', 'retired'), 'beta')).toHaveLength(0);
    for (const stage of ['dev', 'prod']) {
      expect(synthesizePlatform(stage, 'retired')).toEqual(synthesizePlatform(stage, 'legacy'));
    }
  });

  it('separates artifact, data, Client, runtime and qualification capabilities', () => {
    const template = synthesizePlatform('beta', 'roles-added');
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
    // The selection/deployment records are emitted as artifacts and never
    // written. compare-templates.mjs allows a dedicated Beta identity policy
    // wholesale, so this negative assertion is what stops the grant returning.
    const runtimePuts = grantsFor(template, 'infra-runtime')
      .filter((grant) => [grant.Action].flat().includes('ssm:PutParameter'));
    for (const record of ['/anywear/beta/infra_selection', '/anywear/beta/infra_deployment']) {
      expect(JSON.stringify(runtimePuts.map((grant) => grant.Resource))).not.toContain(record);
    }
    // Round 15: the observe path's first exercise of the stage-contract SSM
    // surface. The Workload conversion made the release slice read every value
    // under `/anywear/beta/`, and the E2E qualification observer validates every
    // value under the prefix against the platform record, so the runtime and E2E
    // principals both get the prefix read on top of the nine pre-contract named
    // reads. Pin the effective authorization (the CDK CLI merges statements with
    // equal actions, so statement packing is not the contract): exactly the two
    // read actions, exactly the prefix plus the nine names on both prefix readers,
    // the unchanged nine-name surface on the deploy neighbour, and the whole
    // write/delete/version negative inventory.
    const resolvePolicyArn = (value: any): any => {
      if (Array.isArray(value)) return value.map(resolvePolicyArn);
      if (value?.['Fn::Join']) {
        const [separator, parts] = value['Fn::Join'];
        return parts.map((part: any) => resolvePolicyArn(part)).join(separator);
      }
      if (value?.Ref === 'AWS::Partition') return 'aws';
      if (value?.Ref === 'AWS::Region') return 'ap-east-1';
      if (value?.Ref === 'AWS::AccountId') return '650880818323';
      return value;
    };
    const preContractParameters = ['cognito_user_pool_id', 'cognito_client_id', 'aws_region', 's3_bucket_name',
      'qweather_api_host', 'admission_mode', 'tester_allowlist', 'infra_selection', 'infra_deployment']
      .map((parameter) => `arn:aws:ssm:ap-east-1:650880818323:parameter/anywear/beta/${parameter}`).sort();
    const stageContractPrefix = 'arn:aws:ssm:ap-east-1:650880818323:parameter/anywear/beta/*';
    const ssmInventory = (name: string) => {
      const statements = grantsFor(template, name)
        .filter((grant) => [grant.Action].flat().some((action) => action.startsWith('ssm:')));
      expect(statements.length).toBeGreaterThan(0);
      for (const grant of statements) expect(grant.Effect).toBe('Allow');
      const actions = [...new Set(statements.flatMap((grant) => [grant.Action].flat()))].sort();
      const resources = statements.flatMap((grant) => [grant.Resource].flat().map(resolvePolicyArn)).sort();
      return { actions, resources };
    };
    expect(ssmInventory('infra-runtime')).toEqual({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [...preContractParameters, stageContractPrefix].sort(),
    });
    // The E2E qualification observer reads the same stage-contract prefix the
    // runtime observer does; removing or widening either prefix grant fails here.
    expect(ssmInventory('e2e-qualification')).toEqual({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [...preContractParameters, stageContractPrefix].sort(),
    });
    expect(ssmInventory('infra-deploy')).toEqual({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: preContractParameters,
    });
    for (const name of ['infra-runtime', 'e2e-qualification']) {
      for (const forbidden of ['ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:DeleteParameters',
        'ssm:PutParameterVersion', 'ssm:GetParametersByPath', 'ssm:DescribeParameters', 'ssm:*']) {
        expect(actionsFor(template, name)).not.toContain(forbidden);
      }
    }
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

    // Issue #95 sizing pre-flight read. The qualification principal had no
    // Application Auto Scaling grant, so its opt-in sizing stage failed before
    // any paid workload started. The grant stays on the E2E principal, stays
    // read-only, and stays bound to the Beta region.
    const scalableTargetId = 'application-autoscaling:DescribeScalableTargets';
    const scalableTargetGrants = grantsFor(template, 'e2e-qualification')
      .filter((grant) => [grant.Action].flat().includes(scalableTargetId));
    expect(scalableTargetGrants).toHaveLength(1);
    expect([scalableTargetGrants[0].Action].flat()).toEqual([scalableTargetId]);
    expect(scalableTargetGrants[0].Effect).toBe('Allow');
    expect(scalableTargetGrants[0].Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': { Ref: 'AWS::Region' } } });
    // Resolve the region/account/partition tokens so this pins the exact ARN.
    const scalableResource = (values: any): string => values['Fn::Join'][1]
      .map((part: any) => (part.Ref === 'AWS::Partition' ? 'aws' : part.Ref === 'AWS::Region' ? 'ap-east-1'
        : part.Ref === 'AWS::AccountId' ? '650880818323' : part)).join(values['Fn::Join'][0]);
    expect(scalableResource(scalableTargetGrants[0].Resource))
      .toBe('arn:aws:application-autoscaling:ap-east-1:650880818323:scalable-target/*');
    expect(policiesFor(template, 'e2e-qualification')
      .filter((policy) => JSON.stringify(policy.Properties.PolicyDocument).includes(scalableTargetId)))
      .toHaveLength(1);
    // Widening either the shared helper or a neighbor's grants would fail here.
    for (const name of names) {
      expect(actionsFor(template, name).filter((action) => action.startsWith('application-autoscaling:')))
        .toEqual(name === 'e2e-qualification' ? [scalableTargetId] : []);
    }
    expect(actionsFor(synthesizePlatform('beta'), 'infra-deploy')).not.toContain(scalableTargetId);
    const pipelineBetaActions = (Object.values(synthesizePlatform('beta').Resources) as any[])
      .filter((resource) => ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)
        && JSON.stringify(resource.Properties.Roles).includes('beta-github-actions-pipeline-role'))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .flatMap((statement: any) => [statement.Action].flat());
    for (const forbidden of ['application-autoscaling:RegisterScalableTarget', 'application-autoscaling:PutScalingPolicy',
      'application-autoscaling:DeleteScalingPolicy', 'application-autoscaling:DeregisterScalableTarget',
      'application-autoscaling:TagResource']) {
      expect(actionsFor(template, 'e2e-qualification')).not.toContain(forbidden);
      expect(actionsFor(template, 'infra-runtime')).not.toContain(forbidden);
      expect(pipelineBetaActions).not.toContain(forbidden);
    }
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
      env, identityPhase: 'roles-added', legacyRoleSource: 'cdk',
    });
    const platformStack = new PlatformStack(app, 'AnyWearPlatformStack-beta', {
      stage: 'beta', env, identityPhase: 'roles-added', artifactInputs,
      apiOriginDomainName: TEST_API_ORIGIN_DOMAIN_NAME,
    });
    const foundation = Template.fromStack(foundationStack).toJSON();
    const platform = Template.fromStack(platformStack).toJSON();
    for (const name of [...names, ...serviceDeployRoleNames]) {
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
        stage, artifactInputs, ecrImageRetention: true,
        ...(stage === 'beta' ? { apiOriginDomainName: TEST_API_ORIGIN_DOMAIN_NAME } : {}),
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

describe('Disposable Beta Egress stack', () => {
  function synthesizeEgress(): Record<string, any> {
    const app = new cdk.App();
    return Template.fromStack(new EgressStack(app, 'AnyWearEgressStack-beta', {
      env: { account: '650880818323', region: 'ap-east-1' },
    })).toJSON();
  }

  it('holds only the recreatable NAT, EIP, per-AZ routes and the S3 gateway endpoint', () => {
    const template = synthesizeEgress();
    const resources = Object.values(template.Resources) as any[];
    const ofType = (type: string) => resources.filter((resource) => resource.Type === type);

    expect(ofType('AWS::EC2::NatGateway')).toHaveLength(1);
    expect(ofType('AWS::EC2::EIP')).toHaveLength(1);
    expect(ofType('AWS::EC2::RouteTable')).toHaveLength(2);
    expect(ofType('AWS::EC2::SubnetRouteTableAssociation')).toHaveLength(2);
    const routes = ofType('AWS::EC2::Route');
    expect(routes).toHaveLength(2);
    expect(routes.every((route) => route.Properties.DestinationCidrBlock === '0.0.0.0/0'
      && route.Properties.NatGatewayId !== undefined)).toBe(true);
    const endpoint = ofType('AWS::EC2::VPCEndpoint');
    expect(endpoint).toHaveLength(1);
    expect(String(endpoint[0].Properties.ServiceName)).toContain('s3');
    expect(endpoint[0].Properties.RouteTableIds).toHaveLength(2);
    // The Egress stack owns no Base or Runtime resource: no subnet, VPC, Aurora,
    // Cognito, bucket, ECR, SSM parameter or distribution is recreated here.
    for (const type of ['AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::RDS::DBCluster', 'AWS::S3::Bucket',
      'AWS::Cognito::UserPool', 'AWS::ECR::Repository', 'AWS::SSM::Parameter', 'AWS::CloudFront::Distribution']) {
      expect(ofType(type)).toHaveLength(0);
    }
    // Inputs are the Base stage-contract SSM parameters, not CDK lookups. The
    // fourth parameter is CDK's own bootstrap-version read.
    const stageParameterDefaults = (Object.values(template.Parameters) as any[])
      .map((parameter) => parameter.Default).filter((value) => String(value).startsWith('/anywear/beta/')).sort();
    expect(stageParameterDefaults).toEqual([
      '/anywear/beta/private_subnet_ids', '/anywear/beta/public_subnet_ids', '/anywear/beta/vpc_id',
    ]);
    for (const parameter of Object.values(template.Parameters) as any[]) {
      expect(parameter.Type).toMatch(/^AWS::SSM::Parameter::Value</);
    }
    expect(Object.keys(template.Outputs).sort()).toEqual([
      'EgressNatEipAllocationId', 'EgressNatGatewayId', 'EgressPrivateRouteTableIds',
    ]);
  });

  it('synthesizes from the egress-only app scope without Service artifacts', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'anywear-egress-scope-'));
    try {
      execFileSync(process.execPath, [path.join(root, 'bin', 'infra.js')], {
        cwd: root, stdio: 'pipe', timeout: 120_000,
        env: { ...process.env, CDK_CONTEXT_JSON: JSON.stringify({ deployScope: 'egress', identityPhase: 'retired',
          legacyRoleSource: 'external', ecrImageRetention: 'true' }), CDK_OUTDIR: directory,
          CDK_DEFAULT_ACCOUNT: '650880818323', CDK_DEFAULT_REGION: 'ap-east-1', BILLING_REGION: 'us-east-1' },
      });
      const files = readdirSync(directory).filter((file) => file.endsWith('.template.json')).sort();
      expect(files).toEqual(['AnyWearEgressStack-beta.template.json', 'AnyWearFoundationStack.template.json']);
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 180_000);
});
