import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { AwsSolutionsChecks } from 'cdk-nag';
import { FoundationStack } from '../lib/foundation-stack';
import { PlatformStack } from '../lib/platform-stack';
import type { ArtifactInputs } from '../lib/artifact-inputs';
import runtimePolicies from './fixtures/runtime-policy.json';
import declared from './fixtures/authorization-declared.json';

// The IaC policy lint (#165). cdk-nag's AwsSolutions-IAM5 is the rule source for
// wildcard actions and bare `*` resources; this test pins a reviewed suppression
// policy (every accepted wildcard carries a reason), the repository's own
// condition expectations, and the declaration artifact the observed layer
// reconciles against. It is credential-free and runs in-process in `npm run check`.
/* eslint-disable @typescript-eslint/no-var-requires */
const preflight = require('../scripts/authorization-preflight.mjs');

const ACCOUNT = '650880818323';
const REGION = 'ap-east-1';
const IN_SCOPE_PRINCIPALS = ['beta-service-deploy-role', 'beta-service-deploy-cfn-role',
  'beta-infra-runtime-role', 'beta-infra-deploy-role'];
const artifactInputs: ArtifactInputs = {
  lambdas: {
    'pre-sign-up': { path: path.resolve(__dirname, 'fixtures/placeholder.zip') },
    'post-confirmation': { path: path.resolve(__dirname, 'fixtures/placeholder.zip') },
  },
  runtimePolicy: runtimePolicies,
};

interface Suppression {
  template: string; principal: string; actions: string[]; resource: string;
  conditionRequired: boolean; reason: string;
}

// Reviewed suppression policy. Every accepted wildcard action or bare-* resource
// names the principal and the reason; a suppression that no longer matches a
// statement fails the test, so a stale entry cannot hide a regression.
const SUPPRESSIONS: Suppression[] = [
  { template: 'foundation', principal: 'beta-infra-runtime-role',
    actions: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'],
    resource: 'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearRuntimeStack-beta/*',
    conditionRequired: false,
    reason: 'The runtime role reads the Service-owned Runtime stack terminal before a Base mutation; the stack UUID is the only wildcard position.' },
  { template: 'foundation', principal: 'beta-service-deploy-role', actions: ['cloudformation:*'],
    resource: 'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearRuntimeStack-beta/*',
    conditionRequired: false,
    reason: 'The Service release chain drives change sets for its own runtime stack only; the wildcard action is confined to that stack ARN.' },
  { template: 'foundation', principal: 'beta-service-deploy-role', actions: ['cloudwatch:GetMetricStatistics'],
    resource: '*', conditionRequired: true,
    reason: 'CloudWatch metrics have no resource scope; the grant is region-conditioned.' },
  { template: 'foundation', principal: 'beta-service-deploy-cfn-role', actions: ['ecs:DeregisterTaskDefinition'],
    resource: '*', conditionRequired: false,
    reason: 'ECS evaluates deregistration against *; the statement is the single action and is the reviewed rollback/deletion path.' },
  { template: 'foundation', principal: 'beta-service-deploy-cfn-role',
    actions: ['elasticloadbalancing:DescribeLoadBalancers', 'elasticloadbalancing:DescribeLoadBalancerAttributes',
      'elasticloadbalancing:DescribeTargetGroups', 'elasticloadbalancing:DescribeTargetGroupAttributes',
      'elasticloadbalancing:DescribeListeners', 'elasticloadbalancing:DescribeRules'],
    resource: '*', conditionRequired: false,
    reason: 'ELBv2 read actions have no resource-level scope in IAM.' },
  { template: 'foundation', principal: 'beta-service-deploy-cfn-role', actions: ['logs:DescribeLogGroups'],
    resource: '*', conditionRequired: false,
    reason: 'IAM evaluates DescribeLogGroups in its list form with an empty log-group name; no named log-group ARN can match.' },
  { template: 'foundation', principal: 'beta-service-deploy-cfn-role', actions: ['states:CreateStateMachine'],
    resource: '*', conditionRequired: false,
    reason: 'Step Functions has no resource type for CreateStateMachine in its service authorization table.' },
  ...['beta-infra-deploy-role', 'beta-infra-runtime-role'].map((principal) => ({
    template: 'platform', principal, actions: ['ecs:ListTasks'], resource: '*', conditionRequired: true,
    reason: 'ECS ListTasks has no resource type; the grant is cluster-conditioned.' })),
  ...['beta-infra-deploy-role', 'beta-infra-runtime-role'].map((principal) => ({
    template: 'platform', principal, actions: ['ecs:DescribeTaskDefinition'], resource: '*', conditionRequired: true,
    reason: 'ECS DescribeTaskDefinition has no resource type; the grant is region-conditioned.' })),
  ...['beta-infra-deploy-role', 'beta-infra-runtime-role'].map((principal) => ({
    template: 'platform', principal, actions: ['iam:SimulatePrincipalPolicy', 'iam:SimulateCustomPolicy'],
    resource: '*', conditionRequired: false,
    reason: 'The IAM policy simulator actions have no resource-level scope; the grant is those two actions alone and is executed only by the pre-mutation preflight.' })),
  { template: 'platform', principal: 'beta-infra-deploy-role', actions: ['ec2:DescribeManagedPrefixLists'],
    resource: '*', conditionRequired: true,
    reason: 'EC2 prefix-list reads have no resource scope; the grant is region-conditioned.' },
  { template: 'platform', principal: 'beta-infra-runtime-role', actions: ['ecs:DeregisterTaskDefinition'],
    resource: '*', conditionRequired: true,
    reason: 'ECS evaluates deregistration against *; the runtime role needs it for the rollback path and the grant is region-conditioned.' },
  { template: 'platform', principal: 'beta-infra-runtime-role',
    actions: ['rds:DescribeDBClusters', 'rds:DescribeEvents', 'cloudwatch:GetMetricStatistics'],
    resource: '*', conditionRequired: true,
    reason: 'RDS and CloudWatch reads have no resource scope; the grant is region-conditioned.' },
  { template: 'platform', principal: 'beta-infra-runtime-role', actions: ['logs:DescribeLogGroups'],
    resource: '*', conditionRequired: true,
    reason: 'The list form cannot match a named log group; the grant is region-conditioned.' },
  { template: 'platform', principal: 'beta-infra-runtime-role', actions: ['cloudtrail:LookupEvents'],
    resource: '*', conditionRequired: true,
    reason: 'The observed layer reads CloudTrail for the run window; LookupEvents has no resource scope and the grant is region-conditioned.' },
];

function renderResource(value: any, template: any): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((entry) => renderResource(entry, template)).join('');
  if (value?.['Fn::Join']) {
    const [separator, parts] = value['Fn::Join'];
    return parts.map((part: any) => renderResource(part, template)).join(separator);
  }
  if (value?.['Fn::GetAtt']) {
    const [logicalId, attribute] = value['Fn::GetAtt'];
    const target = template.Resources[logicalId];
    if (target?.Type === 'AWS::IAM::Role') return `arn:aws:iam::${ACCOUNT}:role/${target.Properties?.RoleName ?? logicalId}`;
    if (target?.Type === 'AWS::ECR::Repository') return `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/${target.Properties?.RepositoryName ?? logicalId}`;
    if (target?.Type === 'AWS::Lambda::Function') return `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${target.Properties?.FunctionName ?? logicalId}`;
    return `${logicalId}.${attribute}`;
  }
  if (value?.Ref === 'AWS::Partition') return 'aws';
  if (value?.Ref) return template.Parameters?.[value.Ref]?.Default ?? JSON.stringify(value);
  return JSON.stringify(value);
}

interface ScopedStatement {
  template: string; principal: string; policy: string;
  actions: string[]; resources: string[]; condition?: any;
}

function synthesize(): Array<{ name: string; stack: cdk.Stack; template: any }> {
  const foundationApp = new cdk.App();
  const foundation = new FoundationStack(foundationApp, 'AnyWearFoundationStack', {
    env: { account: ACCOUNT, region: REGION }, identityPhase: 'roles-added', legacyRoleSource: 'cdk' });
  const platformApp = new cdk.App();
  const platform = new PlatformStack(platformApp, 'AnyWearPlatformStack-beta', {
    stage: 'beta', artifactInputs, identityPhase: 'roles-added',
    apiOriginDomainName: 'beta-anywear-api-0123456789.ap-east-1.elb.amazonaws.com',
    env: { account: ACCOUNT, region: REGION } });
  return [
    { name: 'foundation', stack: foundation, template: Template.fromStack(foundation).toJSON() },
    { name: 'platform', stack: platform, template: Template.fromStack(platform).toJSON() },
  ];
}

const entries = synthesize();
const statements: ScopedStatement[] = [];
for (const { name, template } of entries) {
  for (const [logicalId, resource] of Object.entries(template.Resources) as Array<[string, any]>) {
    if (resource.Type !== 'AWS::IAM::Policy') continue;
    const roles = (resource.Properties.Roles ?? []).map((role: any) => (role?.Ref
      ? template.Resources[role.Ref]?.Properties?.RoleName : role));
    const principal = roles.find((role: string) => IN_SCOPE_PRINCIPALS.includes(role));
    if (!principal) continue;
    for (const statement of resource.Properties.PolicyDocument.Statement) {
      statements.push({ template: name, principal, policy: logicalId,
        actions: [statement.Action].flat(),
        resources: [statement.Resource].flat().map((value: any) => renderResource(value, template)),
        condition: statement.Condition });
    }
  }
}

function actionCovered(entryActions: string[], action: string): boolean {
  return entryActions.some((entry) => entry === action || entry === '*'
    || (entry.endsWith(':*') && action.startsWith(`${entry.slice(0, -1)}`)));
}

const resourceMatches = (suppression: Suppression, resource: string): boolean => (
  suppression.resource === resource
  || (suppression.resource.endsWith('*') && resource.startsWith(suppression.resource.slice(0, -1))));

const statementMatches = (statement: ScopedStatement, suppression: Suppression): boolean => (
  suppression.template === statement.template
  && suppression.principal === statement.principal
  && statement.actions.every((action) => actionCovered(suppression.actions, action))
  && statement.resources.some((resource) => resourceMatches(suppression, resource)));

describe('IaC policy lint (#165)', () => {
  it('cdk-nag and the statement scan agree on every policy-quality wildcard', () => {
    const cdkFindings = new Set<string>();
    for (const { stack } of entries) {
      const report = new AwsSolutionsChecks(stack.node.root as cdk.App).validateScope(stack.node.root);
      for (const violation of report.violations ?? []) {
        if (!violation.ruleName.startsWith('AwsSolutions-IAM5')) continue;
        const finding = violation.ruleName.includes('[')
          ? violation.ruleName.slice(violation.ruleName.indexOf('[') + 1, -1) : '';
        if (finding === 'Resource::*' || finding.startsWith('Action::')) cdkFindings.add(finding);
      }
    }
    const scanned = new Set<string>();
    for (const statement of statements) {
      if (statement.resources.includes('*')) scanned.add('Resource::*');
      for (const action of statement.actions) if (action.includes('*')) scanned.add(`Action::${action}`);
    }
    expect(scanned.size).toBeGreaterThan(0);
    expect(cdkFindings.size).toBeGreaterThan(0);
    // Every wildcard the in-scope scan sees is also a cdk-nag finding. Findings
    // outside the deployment principals (the legacy pipeline role) are out of the
    // lint scope and recorded in the non-coverage list.
    for (const finding of scanned) expect(cdkFindings.has(finding)).toBe(true);
  });

  it('every wildcard action or bare-* resource matches a reviewed suppression with a reason', () => {
    for (const statement of statements) {
      const wildcard = statement.resources.includes('*') || statement.actions.some((action) => action.includes('*'));
      if (!wildcard) continue;
      const matches = SUPPRESSIONS.filter((suppression) => statementMatches(statement, suppression));
      expect({ statement: `${statement.template}/${statement.principal}/${statement.actions.join(',')}`,
        reviewed: matches.length > 0 }).toEqual({
        statement: `${statement.template}/${statement.principal}/${statement.actions.join(',')}`, reviewed: true });
      expect(matches.every((match) => match.reason.length > 20)).toBe(true);
    }
    // Suppressions stay honest: each one is exercised by a statement.
    for (const suppression of SUPPRESSIONS) {
      expect({ reason: suppression.reason, exercised: statements.some((statement) => statementMatches(statement, suppression)) })
        .toEqual({ reason: suppression.reason, exercised: true });
    }
  });

  it('conditions the repository expects are present', () => {
    for (const statement of statements) {
      if (statement.actions.includes('iam:PassRole')) {
        const passedToService = statement.condition?.StringEquals?.['iam:PassedToService'];
        expect({ policy: `${statement.template}/${statement.policy}`, passedToService: typeof passedToService })
          .toEqual({ policy: `${statement.template}/${statement.policy}`, passedToService: 'string' });
        expect(['cloudformation.amazonaws.com', 'ecs-tasks.amazonaws.com', 'states.amazonaws.com'])
          .toContain(passedToService);
      }
      if (!statement.resources.includes('*')) continue;
      const suppression = SUPPRESSIONS.find((entry) => statementMatches(statement, entry));
      if (suppression && !suppression.conditionRequired) continue;
      const conditioned = Boolean(statement.condition?.StringEquals?.['aws:RequestedRegion']
        || statement.condition?.ArnEquals?.['ecs:cluster']);
      expect({ policy: `${statement.template}/${statement.policy}`, actions: statement.actions, conditioned })
        .toEqual({ policy: `${statement.template}/${statement.policy}`, actions: statement.actions, conditioned: true });
    }
  });

  it('the declaration artifact is exactly the synthesized Allow actions per role', () => {
    const byRole: Record<string, Set<string>> = {};
    for (const statement of statements) {
      byRole[statement.principal] ??= new Set();
      for (const action of statement.actions) byRole[statement.principal].add(action);
    }
    const expected = Object.fromEntries(Object.entries(byRole)
      .map(([role, actions]) => [role, [...actions].sort()]));
    expect((declared as any).record_type).toBe('anywear_authorization_declared_actions');
    expect((declared as any).roles).toEqual(expected);
  });

  it('the preflight simulation plan stays inside the declared grants', () => {
    const env = { INFRA_OPERATION: 'deploy-platform' };
    for (const [kind, role] of [['deploy', 'beta-infra-deploy-role'], ['runtime', 'beta-infra-runtime-role']]) {
      const declaredActions = (declared as any).roles[role] as string[];
      for (const request of preflight.simulationRequests(kind, env)) {
        for (const action of request.actions) {
          expect({ kind, action, declared: actionCovered(declaredActions, action) })
            .toEqual({ kind, action, declared: true });
        }
      }
    }
  });

  it('keeps the CloudTrail observed-layer read region-scoped on the runtime role only', () => {
    const cloudtrail = statements.filter((statement) => statement.actions.includes('cloudtrail:LookupEvents'));
    expect(cloudtrail).toHaveLength(1);
    expect(cloudtrail[0].principal).toBe('beta-infra-runtime-role');
    expect(cloudtrail[0].resources).toEqual(['*']);
    expect(cloudtrail[0].condition).toEqual({ StringEquals: { 'aws:RequestedRegion': 'ap-east-1' } });
  });

  it('pins the lint/simulator/observed non-coverage list', () => {
    const list = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'scripts', 'authorization-non-coverage.json'), 'utf8'));
    expect(list.record_type).toBe('anywear_authorization_non_coverage');
    const ids = list.entries.map((entry: any) => entry.id);
    expect(ids).toEqual(['lint-scope', 'lint-rules', 'bootstrap-role', 'runtime-stack', 'simulator-approximation',
      'simulator-scope', 'preflight-reads', 'observed-scope']);
    for (const entry of list.entries) {
      expect(['lint', 'simulator', 'observed']).toContain(entry.layer);
      expect(entry.summary.length).toBeGreaterThan(20);
      expect(entry.consequence.length).toBeGreaterThan(20);
    }
    expect(list.entries.some((entry: any) => /AdministratorAccess/.test(entry.summary))).toBe(true);
    expect(list.entries.some((entry: any) => /RuntimeStack/.test(entry.summary))).toBe(true);
  });
});
