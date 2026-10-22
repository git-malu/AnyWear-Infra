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
import { SUPPRESSIONS, MANAGED_POLICY_REVIEW, STATED_EXCEPTIONS } from './support/authorization-lint-policy';
import type { Suppression } from './support/authorization-lint-policy';

// The IaC policy lint (#165). cdk-nag's AwsSolutions-IAM5 supplies the wildcard
// rule source; this test extends it with a statement scan that covers wildcard
// actions, wildcard resource ARNs (including scoped ones), managed-policy
// attachments and the repository's condition expectations. Every accepted form
// matches the reviewed suppression policy in test/support/, and every entry must
// still match a statement. The lint is credential-free and runs in-process in
// `npm run check`.
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
const managedPolicies: Array<{ template: string; role: string; policy: string }> = [];
for (const { name, template } of entries) {
  for (const [logicalId, resource] of Object.entries(template.Resources) as Array<[string, any]>) {
    if (resource.Type === 'AWS::IAM::Role' && IN_SCOPE_PRINCIPALS.includes(resource.Properties?.RoleName)) {
      for (const policy of resource.Properties?.ManagedPolicyArns ?? []) {
        managedPolicies.push({ template: name, role: resource.Properties.RoleName,
          policy: renderResource(policy, template) });
      }
      continue;
    }
    if (resource.Type === 'AWS::IAM::ManagedPolicy') {
      const policyRoles = (resource.Properties.Roles ?? []).map((role: any) => (role?.Ref
        ? template.Resources[role.Ref]?.Properties?.RoleName : role));
      const principal = policyRoles.find((role: string) => IN_SCOPE_PRINCIPALS.includes(role));
      if (principal) managedPolicies.push({ template: name, role: principal,
        policy: String(resource.Properties.ManagedPolicyName ?? logicalId) });
      if (!principal) continue;
      for (const statement of resource.Properties.PolicyDocument.Statement) {
        statements.push({ template: name, principal, policy: String(resource.Properties.ManagedPolicyName ?? logicalId),
          actions: [statement.Action].flat(),
          resources: [statement.Resource].flat().map((value: any) => renderResource(value, template)),
          condition: statement.Condition });
      }
      continue;
    }
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

const resourceMatches = (patterns: string[], resource: string): boolean => patterns.some((pattern) => (
  pattern === resource || (pattern.endsWith('*') && resource.startsWith(pattern.slice(0, -1)))));

const statementMatches = (statement: ScopedStatement, suppression: Suppression): boolean => (
  suppression.template === statement.template
  && suppression.principals.includes(statement.principal)
  && statement.actions.every((action) => actionCovered(suppression.actions, action))
  && statement.resources.every((resource) => resourceMatches(suppression.resources, resource)));

const hasWildcard = (statement: ScopedStatement): boolean => statement.actions.some((action) => action.includes('*'))
  || statement.resources.some((resource) => resource.includes('*'));

// The cdk-nag finding ids render partition tokens differently from the test's
// statement renderer; normalize before comparing.
const normalizeFinding = (finding: string): string => finding.replaceAll('arn:<AWS::Partition>', 'arn:aws');

describe('IaC policy lint (#165)', () => {
  it('cdk-nag confirms every wildcard the statement scan sees, including scoped ARNs', () => {
    const cdkFindings = new Set<string>();
    for (const { stack } of entries) {
      const report = new AwsSolutionsChecks(stack.node.root as cdk.App).validateScope(stack.node.root);
      for (const violation of report.violations ?? []) {
        if (!violation.ruleName.startsWith('AwsSolutions-IAM5')) continue;
        const finding = violation.ruleName.includes('[')
          ? violation.ruleName.slice(violation.ruleName.indexOf('[') + 1, -1) : '';
        if (finding.startsWith('Action::') || finding.startsWith('Resource::')) {
          cdkFindings.add(normalizeFinding(finding));
        }
      }
    }
    const scanned = new Set<string>();
    for (const statement of statements) {
      for (const action of statement.actions) if (action.includes('*')) scanned.add(`Action::${action}`);
      for (const resource of statement.resources) if (resource.includes('*')) scanned.add(`Resource::${resource}`);
    }
    expect(scanned.size).toBeGreaterThan(20);
    // Subset, not equality: cdk-nag also reports wildcards on roles outside the
    // linted principals (the legacy pipeline role and CDK-generated service roles).
    for (const finding of scanned) expect({ finding, confirmed: cdkFindings.has(finding) })
      .toEqual({ finding, confirmed: true });
  });

  it('every wildcard action or wildcard resource ARN matches a reviewed suppression with a reason', () => {
    let reviewed = 0;
    for (const statement of statements) {
      if (!hasWildcard(statement)) continue;
      const matches = SUPPRESSIONS.filter((suppression) => statementMatches(statement, suppression));
      expect({ statement: `${statement.template}/${statement.principal}/${statement.actions.join(',')}`,
        reviewed: matches.length > 0 }).toEqual({
        statement: `${statement.template}/${statement.principal}/${statement.actions.join(',')}`, reviewed: true });
      expect(matches.every((match) => match.reason.length > 20)).toBe(true);
      reviewed += 1;
    }
    expect(reviewed).toBeGreaterThan(40);
    // Suppressions stay honest: each one is exercised by a statement.
    for (const suppression of SUPPRESSIONS) {
      expect({ reason: suppression.reason,
        exercised: statements.some((statement) => statementMatches(statement, suppression)) })
        .toEqual({ reason: suppression.reason, exercised: true });
    }
  });

  it('an unreviewed scoped-ARN wildcard or managed policy is a finding', () => {
    const scoped = { template: 'platform', principal: 'beta-infra-runtime-role', policy: 'X',
      actions: ['s3:GetObject'], resources: ['arn:aws:s3:::unreviewed-bucket/*'] };
    expect(SUPPRESSIONS.some((suppression) => statementMatches(scoped, suppression))).toBe(false);
    const reviewedScoped = { ...scoped, actions: ['cloudformation:DescribeStacks'],
      resources: [`arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/AnyWearRuntimeStack-beta/*`] };
    expect(SUPPRESSIONS.some((suppression) => statementMatches(reviewedScoped, suppression))).toBe(true);
    // The synthesized roles carry one reviewed managed policy (CDK's overflow
    // policy); any other attachment fails.
    expect(managedPolicies.filter((entry) => !MANAGED_POLICY_REVIEW.some((reviewedPolicy) => (
      reviewedPolicy.role === entry.role && reviewedPolicy.policy === entry.policy)))).toEqual([]);
    const unreviewedPolicy = { role: 'beta-infra-runtime-role',
      policy: 'arn:aws:iam::aws:policy/AdministratorAccess' };
    expect(MANAGED_POLICY_REVIEW.some((reviewedPolicy) => reviewedPolicy.role === unreviewedPolicy.role
      && reviewedPolicy.policy === unreviewedPolicy.policy)).toBe(false);
    // The CDK bootstrap role is a stated exception, not a construct in this app.
    expect(STATED_EXCEPTIONS.map((exception) => exception.name)).toContain('cdk-hnb659fds-cfn-exec-role');
    expect(STATED_EXCEPTIONS.every((exception) => exception.reason.length > 20)).toBe(true);
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

  it('the preflight simulation plan stays inside the declared grants and covers the reviewed forms', () => {
    const env = { INFRA_OPERATION: 'deploy-platform' };
    for (const [kind, role] of [['deploy', 'beta-infra-deploy-role'], ['runtime', 'beta-infra-runtime-role']]) {
      const declaredActions = (declared as any).roles[role] as string[];
      for (const request of preflight.simulationRequests(kind, env) as any[]) {
        for (const action of request.actions) {
          expect({ kind, action, declared: actionCovered(declaredActions, action) })
            .toEqual({ kind, action, declared: true });
        }
        for (const resource of request.resources as string[]) {
          expect({ kind, pair: request.pair, resource: typeof resource }).toEqual({ kind, pair: request.pair, resource: 'string' });
        }
      }
    }
    const runtime = preflight.simulationRequests('runtime', env);
    const ssm = runtime.find((request: any) => request.pair === 'ssm/get-parameters');
    expect(ssm.resources.length).toBe(39);
    expect(ssm.resources).toContain(`arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/anywear/beta/tester_allowlist`);
    expect(ssm.resources).toContain(`arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/anywear/beta/api_base_url`);
    const lambda = runtime.find((request: any) => request.pair === 'lambda/get-function');
    expect(lambda.resources).toContain(`arn:aws:lambda:${REGION}:${ACCOUNT}:function:AnyWearPlatformStack-beta-*`);
    const egress = `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/AnyWearEgressStack-beta/*`;
    for (const pair of ['cloudformation/describe-stacks', 'cloudformation/get-template',
      'cloudformation/list-stack-resources']) {
      const request = runtime.find((entry: any) => entry.pair === pair);
      expect({ pair, egress: request.resources.includes(egress) }).toEqual({ pair, egress: true });
    }
    const deploy = preflight.simulationRequests('deploy', env) as any[];
    expect(deploy.map((request) => request.pair)).toEqual(['cloudformation/describe-stacks', 'ssm/get-parameter',
      'ec2/describe-managed-prefix-lists']);
  });

  it('every deploy-plan read is covered by the deploy role grant and the deploy session policy', () => {
    const opEnv = {
      GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
      GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
      GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', ENABLE_BETA_MUTATION: 'true', AWS_ACCOUNT_ID: ACCOUNT,
      AWS_REGION: REGION, INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true',
      INFRA_OPERATION: 'deploy-platform',
    };
    const boundary = require('../scripts/operation-boundaries.mjs');
    const sessionActions = new Set(JSON.parse(boundary.sessionPolicy('deploy', opEnv, 'operation'))
      .Statement.flatMap((statement: any) => [statement.Action].flat()));
    const deployRoleStatements = statements.filter((statement) => statement.principal === 'beta-infra-deploy-role');
    const plan = preflight.simulationRequests('deploy', { INFRA_OPERATION: 'deploy-platform' }) as any[];
    for (const request of plan) {
      for (const action of request.actions as string[]) {
        expect({ action, inSession: sessionActions.has(action) }).toEqual({ action, inSession: true });
        const covered = deployRoleStatements.some((statement) => actionCovered(statement.actions, action)
          && (request.resources as string[]).every((resource) => statement.resources
            .some((pattern) => resourceMatches([pattern], resource))));
        expect({ action, covered }).toEqual({ action, covered: true });
      }
    }
    const ssm = plan.find((request) => request.pair === 'ssm/get-parameter');
    expect(ssm.resources.length).toBe(9);
    expect(ssm.resources).toContain(`arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/anywear/beta/cognito_user_pool_id`);
    expect(ssm.resources).toContain(`arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/anywear/beta/infra_selection`);
    expect(ssm.resources.some((resource: string) => resource.endsWith('/api_base_url'))).toBe(false);
  });

  it('records every reviewed not-in-plan read with a reason', () => {
    const skips = preflight.SIMULATION_SKIPS;
    expect(Object.keys(skips).sort()).toEqual(['cloudfront/get-distribution', 'ecr/batch-get-image',
      'ecr/describe-images', 'ecr/get-lifecycle-policy', 'ecr/get-lifecycle-policy-preview',
      'ecr/start-lifecycle-policy-preview', 'ecs/register-task-definition', 'ecs/run-task', 'ecs/wait',
      'logs/get-log-events', 'logs/put-retention-policy', 'sts/get-caller-identity']);
    for (const reason of Object.values(skips)) expect(String(reason).length).toBeGreaterThan(20);
  });

  it('pins the lint/simulator/narrowing non-coverage list', () => {
    const list = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'scripts', 'authorization-non-coverage.json'), 'utf8'));
    expect(list.record_type).toBe('anywear_authorization_non_coverage');
    const ids = list.entries.map((entry: any) => entry.id);
    expect(ids).toEqual(['lint-scope', 'lint-rules', 'bootstrap-role', 'runtime-stack', 'simulator-approximation',
      'simulator-scope', 'preflight-reads', 'simulate-disclosure', 'narrowing']);
    for (const entry of list.entries) {
      expect(['lint', 'simulator', 'narrowing']).toContain(entry.layer);
      expect(entry.summary.length).toBeGreaterThan(20);
      expect(entry.consequence.length).toBeGreaterThan(20);
    }
    expect(list.entries.some((entry: any) => /AdministratorAccess/.test(entry.summary))).toBe(true);
    expect(list.entries.some((entry: any) => /release slice|RuntimeStack|release-slice/i.test(entry.summary))).toBe(true);
    expect(list.entries.some((entry: any) => /disclos/i.test(`${entry.summary} ${entry.consequence}`))).toBe(true);
    expect(list.entries.find((entry: any) => entry.id === 'narrowing')?.layer).toBe('narrowing');
  });
});
