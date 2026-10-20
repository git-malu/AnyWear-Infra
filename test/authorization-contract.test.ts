import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as path from 'node:path';
import { FoundationStack } from '../lib/foundation-stack';
import { PlatformStack } from '../lib/platform-stack';
import type { ArtifactInputs } from '../lib/artifact-inputs';
import runtimePolicies from './fixtures/runtime-policy.json';
import workloadCfnActions from './fixtures/workload-cfn-actions.json';
import workloadBakeReads from './fixtures/workload-bake-reads.json';

// The declared authorization contract (#165). The derivation and the reviewed
// tables live in one module, `scripts/authorization-inventory.mjs`, which the
// pre-mutation canary and the CloudTrail reconciliation also read (D1). This
// suite synthesizes the Foundation and Platform templates in-process and asserts
// both directions per named principal, plus the generated session policies.
/* eslint-disable @typescript-eslint/no-var-requires */
const inventory = require('../scripts/authorization-inventory.mjs');
const boundaries = require('../scripts/operation-boundaries.mjs');

const ACCOUNT = '650880818323';
const REGION = 'ap-east-1';
const base = path.resolve(__dirname, '..');
const artifactInputs: ArtifactInputs = {
  lambdas: {
    'pre-sign-up': { path: path.resolve(__dirname, 'fixtures/placeholder.zip') },
    'post-confirmation': { path: path.resolve(__dirname, 'fixtures/placeholder.zip') },
  },
  runtimePolicy: runtimePolicies,
};

const PRINCIPALS = ['beta-service-deploy-role', 'beta-service-deploy-cfn-role', 'beta-infra-runtime-role'];
// GetCallerIdentity is allowed to every principal and needs no policy grant.
const NO_GRANT_REQUIRED = new Set(['sts:GetCallerIdentity']);

function foundationTemplate(): any {
  const app = new cdk.App();
  return Template.fromStack(new FoundationStack(app, 'AnyWearFoundationStack', {
    env: { account: ACCOUNT, region: REGION }, identityPhase: 'roles-added', legacyRoleSource: 'cdk',
  })).toJSON();
}

function platformTemplate(): any {
  const app = new cdk.App();
  return Template.fromStack(new PlatformStack(app, 'AnyWearPlatformStack-beta', {
    stage: 'beta', artifactInputs, identityPhase: 'roles-added',
    apiOriginDomainName: 'beta-anywear-api-0123456789.ap-east-1.elb.amazonaws.com',
    env: { account: ACCOUNT, region: REGION },
  })).toJSON();
}

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
    if (target?.Type === 'AWS::SQS::Queue' && target.Properties?.QueueName) return `arn:aws:sqs:${REGION}:${ACCOUNT}:${target.Properties.QueueName}`;
    return `${logicalId}.${attribute}`;
  }
  if (value?.Ref === 'AWS::Partition') return 'aws';
  if (value?.Ref) return template.Parameters?.[value.Ref]?.Default ?? JSON.stringify(value);
  return JSON.stringify(value);
}

function statementsFor(template: any, roleName: string): Array<{ actions: string[]; resources: string[]; condition?: any; sid?: string }> {
  const roleId = Object.entries(template.Resources)
    .find(([, resource]: [string, any]) => resource.Type === 'AWS::IAM::Role' && resource.Properties?.RoleName === roleName)?.[0];
  return Object.values(template.Resources)
    .filter((resource: any) => ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)
      && (resource.Properties.Roles ?? []).some((role: any) => (roleId && role?.Ref === roleId) || role === roleName))
    .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
    .map((statement: any) => ({ actions: [statement.Action].flat(),
      resources: [statement.Resource].flat().map((value: any) => renderResource(value, template)),
      condition: statement.Condition, sid: statement.Sid }));
}

function statements(principal: string): Array<{ actions: string[]; resources: string[]; condition?: any; sid?: string }> {
  const foundation = statementsFor(foundationTemplate(), principal);
  const platform = statementsFor(platformTemplate(), principal);
  return [...foundation, ...platform];
}

const covers = (rows: any[], action: string, arn: string) => rows.some((row) => inventory.actionCovered(row.actions, action)
  && row.resources.some((pattern: string) => inventory.policyCovers(pattern, arn)));
const grants = (rows: any[], action: string) => rows.some((row) => inventory.actionCovered(row.actions, action));
const wildcardActions = (rows: any[]) => [...new Set(rows.filter((row) => row.resources.includes('*'))
  .flatMap((row) => row.actions))].sort();

function assertDerivedCoverage(principal: string, actions: string[]): void {
  const rows = statements(principal);
  for (const action of actions) {
    if (NO_GRANT_REQUIRED.has(action)) continue;
    expect({ action, granted: grants(rows, action) }).toEqual({ action, granted: true });
    for (const arn of inventory.RESOURCE_FORMS[action] ?? []) {
      expect({ action, arn, covered: covers(rows, action, arn) }).toEqual({ action, arn, covered: true });
    }
  }
}

describe('derived authorization inventory (#165)', () => {
  it('derives the pinned call-site surface and attributes every site', () => {
    const surface = inventory.deriveAuthorizationSurface(base);
    for (const [key, value] of Object.entries(inventory.PINNED_SURFACE)) {
      expect(surface[key]).toBe(value);
    }
    expect(surface.sites.length + surface.shell.length).toBe(surface.total_call_sites);
    expect(surface.dynamic_sites.flatMap((site: any) => site.pairs).sort())
      .toEqual(['cloudformation/list-stack-resources', 'logs/describe-log-groups', 'logs/get-log-events']);
    for (const site of surface.sites) expect(inventory.CREDENTIAL_PATHS[site.credentialPath]).toBeTruthy();
  });

  it('covers every runtime-session derived action and its API-evaluated resource form', () => {
    const surface = inventory.deriveAuthorizationSurface(base);
    const runtimePairs = surface.pairs.filter((entry: any) => entry.credential_paths.includes('runtime-session'));
    const derived = [...new Set(runtimePairs.flatMap((entry: any) => entry.actions))]
      .filter((action) => !inventory.CONDITIONAL_READ_ACTIONS.includes(action)) as string[];
    expect(derived.length).toBeGreaterThan(10);
    // The conditional legacy fallback is recorded in the non-coverage list rather
    // than asserted: its base grant may be denied by design.
    expect(inventory.nonCoverageList(base).some((entry: any) => entry.id === 'conditional-fallback')).toBe(true);
    assertDerivedCoverage('beta-infra-runtime-role', derived);
    // The reviewed required set also names the session-only reads (ECR retention
    // and the observed layer's CloudTrail read), so their grants stay asserted.
    assertDerivedCoverage('beta-infra-runtime-role', inventory.RUNTIME_REQUIRED_ACTIONS);
  });

  it('covers the Service deploy role on the Service-sourced bake reads', () => {
    const reads = (workloadBakeReads as any).reads as Array<{ call: string; action: string; resources: string[] }>;
    const rows = statements('beta-service-deploy-role');
    for (const read of reads) {
      const [service, operation] = read.call.split(':');
      const action = `${service}:${operation.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('')}`;
      for (const arn of read.resources) {
        expect({ action, arn, covered: covers(rows, action, arn) }).toEqual({ action, arn, covered: true });
      }
    }
  });

  it('covers the full Runtime resource-type table with the CloudFormation role', () => {
    const table = (workloadCfnActions as any).resource_types as Array<{ type: string; actions: string[]; wildcard_actions?: string[] }>;
    const rows = statements('beta-service-deploy-cfn-role');
    for (const entry of table) {
      for (const action of entry.actions) {
        expect(grants(rows, action)).toBe(true);
        const wildcard = (entry.wildcard_actions ?? []).includes(action);
        const onWildcard = rows.some((row) => row.actions.includes(action) && row.resources.includes('*'));
        expect({ action, onWildcard, wildcard }).toEqual({ action, onWildcard, wildcard });
      }
    }
    // A concrete resource the fixture names must be covered by the granting
    // statement, not merely by some statement carrying the action.
    const coverage = (workloadCfnActions as any).resource_coverage;
    const stateMachine = coverage.state_machines[0] as string;
    for (const action of ['states:UpdateStateMachine', 'states:DescribeStateMachine', 'states:ListStateMachineVersions']) {
      expect(covers(rows, action, stateMachine)).toBe(true);
    }
    for (const family of coverage.task_definition_families as string[]) {
      expect(covers(rows, 'ecs:RegisterTaskDefinition', family)).toBe(true);
    }
  });

  it('grants nothing outside the reviewed set and pins every reviewed wildcard', () => {
    for (const principal of PRINCIPALS) {
      const rows = statements(principal);
      expect(rows.length).toBeGreaterThan(0);
      const reviewedActions = new Set(inventory.REVIEWED_GRANTED_ACTIONS[principal]);
      const reviewedWildcards = new Set(inventory.REVIEWED_WILDCARDS[principal].map((entry: any) => entry.action));
      const families = inventory.REVIEWED_RESOURCE_FAMILIES[principal];
      for (const row of rows) {
        for (const action of row.actions) {
          expect({ principal, action, reviewed: reviewedActions.has(action) })
            .toEqual({ principal, action, reviewed: true });
          if (row.resources.includes('*')) {
            expect({ principal, action, wildcard: reviewedWildcards.has(action) })
              .toEqual({ principal, action, wildcard: true });
          }
        }
        for (const pattern of row.resources) {
          if (pattern === '*') continue;
          expect({ principal, pattern, inside: inventory.patternWithin(pattern, families) })
            .toEqual({ principal, pattern, inside: true });
        }
      }
      expect(wildcardActions(rows)).toEqual([...reviewedWildcards].sort());
    }
  });

  it('keeps the reviewed-wildcard policy explicit for the deploy roles', () => {
    const cfnRows = statements('beta-service-deploy-cfn-role');
    const cfnWildcards = inventory.REVIEWED_WILDCARDS['beta-service-deploy-cfn-role'].map((entry: any) => entry.action);
    // The pinned baseline grants cloudformation:* only on the service's own stack
    // ARN, and the recorded any-resource grants stay explicit.
    expect(cfnWildcards).toContain('ecs:DeregisterTaskDefinition');
    expect(cfnWildcards).toContain('logs:DescribeLogGroups');
    const deployRows = statements('beta-service-deploy-role');
    const cloudformation = deployRows.filter((row) => row.actions.includes('cloudformation:*'));
    expect(cloudformation).toHaveLength(1);
    expect(cloudformation[0].resources).toEqual([`arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/AnyWearRuntimeStack-beta/*`]);
    // The CFN role has no service-wide CloudFormation grant beyond the one
    // DescribeStacks read it retains.
    expect(cfnRows.filter((row) => row.actions.includes('cloudformation:*'))).toHaveLength(0);
  });
});

function operationEnvironment(operation: string, workflow = 'mutate'): Record<string, string> {
  return { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: `git-malu/AnyWear-Infra/.github/workflows/${workflow}.yml@refs/heads/main`,
    GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', ENABLE_BETA_MUTATION: 'true', AWS_ACCOUNT_ID: ACCOUNT,
    AWS_REGION: REGION, INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true',
    INFRA_OPERATION: operation, TESTER_EMAILS: '[]' };
}

const MUTATE_OPERATIONS = ['deploy-foundation', 'deploy-billing', 'deploy-platform', 'deploy-egress',
  'delete-egress', 'restore-release', 'migrate', 'admission-status', 'add-testers', 'set-testers',
  'open-admission', 'close-admission'];
const RUNTIME_OPERATIONS = ['state', 'observe'];

describe('generated session policies (#165)', () => {
  it('the runtime session policy never contains an action outside the reviewed set', () => {
    const readsActions = new Set(Object.values(boundaries.reads));
    const mutationActions = new Set(['ecs:RegisterTaskDefinition', 'ecs:RunTask', 'ecs:DeregisterTaskDefinition',
      'iam:PassRole', 'logs:PutRetentionPolicy']);
    const allowed = new Set([...readsActions, ...mutationActions]);
    for (const [workflow, operations] of [['mutate', MUTATE_OPERATIONS], ['runtime', RUNTIME_OPERATIONS]] as const) {
      for (const operation of operations) {
        const env = operationEnvironment(operation, workflow);
        for (const purpose of ['operation', 'qualification']) {
          let policy: string;
          try {
            policy = boundaries.sessionPolicy('runtime', env, purpose);
          } catch (error) {
            // Only a read-only state run or a qualification session with no
            // mutation family may refuse; nothing else is allowed to throw.
            if (operation === 'state') continue;
            throw error;
          }
          const document = JSON.parse(policy);
          const actions = document.Statement.flatMap((statement: any) => [statement.Action].flat());
          for (const action of actions) {
            expect({ operation, purpose, action, allowed: allowed.has(action) })
              .toEqual({ operation, purpose, action, allowed: true });
          }
          const expectedReads = operation === 'state' ? new Set(Object.entries(boundaries.reads)
            .filter(([key]) => boundaries.stateReads.includes(key)).map(([, action]) => action)) : readsActions;
          for (const action of expectedReads) {
            expect({ operation, purpose, action, present: actions.includes(action) })
              .toEqual({ operation, purpose, action, present: true });
          }
          if (purpose === 'qualification') {
            expect(actions.some((action: string) => mutationActions.has(action))).toBe(false);
          }
        }
      }
    }
  });

  it('the deploy session policy is exactly the reviewed read surface', () => {
    for (const operation of ['deploy-foundation', 'deploy-billing', 'deploy-platform', 'deploy-egress', 'restore-release']) {
      const document = JSON.parse(boundaries.sessionPolicy('deploy', operationEnvironment(operation), 'operation'));
      const actions = [...new Set(document.Statement.flatMap((statement: any) => [statement.Action].flat()))].sort();
      expect(actions).toEqual([...new Set([...inventory.DEPLOY_SESSION_READS, 'sts:AssumeRole',
        'secretsmanager:GetSecretValue'])].sort());
    }
    expect(() => boundaries.sessionPolicy('deploy', operationEnvironment('migrate'), 'operation'))
      .toThrow(/Deploy credentials are forbidden/);
  });
});
