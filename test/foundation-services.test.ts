import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import {
  DEFAULT_FOUNDATION_SERVICE,
  readFoundationServices,
  SERVICE_SET_CONTEXT,
  serviceWorkloadStackName,
} from '../lib/foundation-stack';
import cdkConfig from '../cdk.json';
import provenance from './fixtures/foundation-live-provenance.json';

// Issue #158 round 4, bullet 8: Foundation's service set is reviewed CDK context
// (`infraServices`) instead of a hardcoded first service. The default context is
// exactly today's single service, so the synthesized Foundation template stays
// byte-identical; a second service is a context value plus a deploy, never an
// Infra source edit.

const root = path.resolve(__dirname, '..');
const cdkCli = path.join(root, 'node_modules', 'aws-cdk', 'bin', 'cdk');
const accountEnv = {
  AWS_REGION: 'ap-east-1', AWS_DEFAULT_REGION: 'ap-east-1',
  CDK_DEFAULT_ACCOUNT: '650880818323', CDK_DEFAULT_REGION: 'ap-east-1', BILLING_REGION: 'us-east-1',
};
// Neither child may inherit a host CDK context; the CLI reads cdk.json and the
// context synthesis below passes its own.
function childEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CDK_CONTEXT_JSON;
  delete env.CDK_OUTDIR;
  return { ...env, ...accountEnv, ...extra };
}

const secondService = Object.freeze({
  service: 'ocr', repository: 'AnyWear-OCR', repositoryId: 1189999999, environment: 'beta',
});

// Directories are created per synthesis and removed after the suite; they live
// outside the repository.
const directories: string[] = [];
function outputDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function templateOf(directory: string): any {
  return JSON.parse(readFileSync(path.join(directory, 'AnyWearFoundationStack.template.json'), 'utf8'));
}

// The reviewed Foundation-only CLI entry exactly as CI synthesizes it. This is
// the path the live-Foundation comparison consumes, so its bytes are the
// pre-change proof rather than a second synthesis implementation.
function synthesizeDefaultWithCli(): { directory: string; template: any } {
  const output = outputDirectory('infra-foundation-cli-');
  execFileSync(process.execPath, [cdkCli, 'synth', 'AnyWearFoundationStack', '--lookups', 'false',
    '--output', output, '-c', 'deployScope=foundation', '-c', 'identityPhase=roles-added',
    '-c', 'legacyRoleSource=external', '--quiet'],
  { cwd: root, stdio: 'pipe', timeout: 300_000, env: childEnvironment() });
  return { directory: output, template: templateOf(output) };
}

// The app entry with an explicit CDK context, the form a reviewed
// `-c infraServices='[...]'` dispatch or `CDK_CONTEXT_JSON` uses.
function synthesizeWithContext(infraServices?: unknown): any {
  const output = outputDirectory('infra-foundation-context-');
  const context = { ...cdkConfig.context, deployScope: 'foundation', identityPhase: 'roles-added',
    legacyRoleSource: 'external', ...(infraServices === undefined ? {} : { [SERVICE_SET_CONTEXT]: infraServices }) };
  execFileSync(process.execPath, [path.join(root, 'bin', 'infra.js')], { cwd: root, stdio: 'pipe', timeout: 120_000,
    env: childEnvironment({ CDK_CONTEXT_JSON: JSON.stringify(context), CDK_OUTDIR: output }) });
  return templateOf(output);
}

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

const roleName = (template: any, name: string): any => (Object.values(template.Resources) as any[])
  .find((resource) => resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === name);
const policiesFor = (template: any, role: any): any[] => {
  const roleIds = Object.entries(template.Resources)
    .filter(([, resource]: [string, any]) => resource === role).map(([id]) => id);
  return (Object.values(template.Resources) as any[]).filter((resource) => (
    ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)
    && resource.Properties.Roles?.some((entry: any) => roleIds.includes(entry.Ref))));
};

describe('Foundation reviewed service set (CDK context)', () => {
  it('keeps the default context byte-identical to the pre-change Foundation template', () => {
    const { directory, template } = synthesizeDefaultWithCli();
    // The committed live-Foundation provenance and the round-3 comparison pin the
    // default candidate: four original resources plus exactly the twelve reviewed
    // additions, and the normalized content hash recorded before this change.
    // Run the same comparison script CI runs rather than a second implementation.
    const reportPath = path.join(outputDirectory('infra-foundation-report-'), 'comparison.json');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'compare-live-foundation.mjs'),
      '--candidate', path.join(directory, 'AnyWearFoundationStack.template.json'), '--output', reportPath],
    { cwd: root, stdio: 'pipe', timeout: 60_000, env: childEnvironment() });
    const comparison = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(comparison.accepted).toBe(true);
    expect(comparison.original_resource_count).toBe(4);
    expect(comparison.candidate_resource_count).toBe(16);
    expect(comparison.added).toHaveLength(12);
    // sha256 of the normalized live candidate; the comparison normalizes only
    // the declared CDK diagnostic metadata. Re-recorded when the round-10
    // `logs:DescribeLogGroups` statement joined the execution role's policy.
    expect(comparison.normalized_canonical_sha256)
      .toBe('c5462c1d80a97a1df46e729c4cbae835fbe3bf49148e719b87ff8da632ee99e7');
    for (const id of provenance.addition_allowlist) expect(template.Resources[id]).toBeDefined();
    expect(roleName(template, 'beta-service-deploy-role')).toBeDefined();
    expect(roleName(template, 'beta-service-deploy-cfn-role')).toBeDefined();
    expect(readFoundationServices()).toEqual([DEFAULT_FOUNDATION_SERVICE]);
    expect(readFoundationServices(null)).toEqual([DEFAULT_FOUNDATION_SERVICE]);
  }, 300_000);

  it('synthesizes the second service from context alone and leaves the existing service unchanged', () => {
    const baseline = synthesizeWithContext();
    const withSecond = synthesizeWithContext([DEFAULT_FOUNDATION_SERVICE, secondService]);
    // Every existing resource and output is unchanged; the second service only
    // adds its own two roles and their policies.
    for (const [id, resource] of Object.entries(baseline.Resources)) {
      expect(withSecond.Resources[id]).toEqual(resource);
    }
    expect(withSecond.Outputs).toEqual(baseline.Outputs);
    const added = Object.keys(withSecond.Resources).filter((id) => baseline.Resources[id] === undefined).sort();
    expect(added).toHaveLength(4);
    expect(added.filter((id) => withSecond.Resources[id].Type === 'AWS::IAM::Role')).toHaveLength(2);
    expect(added.filter((id) => withSecond.Resources[id].Type === 'AWS::IAM::Policy')).toHaveLength(2);

    const deploy = roleName(withSecond, 'beta-ocr-deploy-role');
    const cfn = roleName(withSecond, 'beta-ocr-deploy-cfn-role');
    expect(deploy).toBeDefined();
    expect(cfn).toBeDefined();
    expect(roleName(withSecond, 'beta-service-deploy-role')).toEqual(baseline.Resources[
      Object.keys(baseline.Resources).find((id) => baseline.Resources[id].Properties?.RoleName === 'beta-service-deploy-role')!]);
    expect(serviceWorkloadStackName('ocr')).toBe('AnyWearWorkloadStack-ocr-beta');
    expect(serviceWorkloadStackName('service')).toBe('AnyWearWorkloadStack-beta');

    // The OIDC subject is derived from the descriptor's repository id, repository
    // name and environment; the CFN role keeps CloudFormation-only trust.
    const deployTrust = deploy.Properties.AssumeRolePolicyDocument.Statement;
    expect(deployTrust).toHaveLength(1);
    expect(deployTrust[0]).toMatchObject({
      Action: 'sts:AssumeRoleWithWebIdentity', Effect: 'Allow',
      Condition: { StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': 'repo:git-malu@11473072/AnyWear-OCR@1189999999:environment:beta',
      } },
    });
    expect(cfn.Properties.AssumeRolePolicyDocument.Statement).toEqual([
      { Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'cloudformation.amazonaws.com' } },
    ]);

    // The added policies are the same Service role shape, scoped to the second
    // service's own workload stack and resource families. No bootstrap role
    // assumption, no bootstrap/account-wide widening.
    const cfnStatements = policiesFor(withSecond, cfn).flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const deployStatements = policiesFor(withSecond, deploy).flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const cfnActions = cfnStatements.flatMap((statement) => [statement.Action].flat());
    const cfnText = JSON.stringify(cfnStatements);
    const deployText = JSON.stringify(deployStatements);
    // The OIDC role can drive only the second service's workload stack and its
    // change sets; the execution role keeps CloudFormation read-only and owns
    // only that workload's resource families.
    expect(deployText).toContain('arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearWorkloadStack-ocr-beta/*');
    expect(deployText).toContain('"cloudformation:*"');
    expect(deployText).not.toContain('stack/AnyWearWorkloadStack-beta/*');
    expect(cfnText).toContain('arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearPlatformStack-beta/*');
    expect(cfnText).not.toContain('AnyWearWorkloadStack-ocr-beta');
    expect(cfnActions.filter((action) => action.startsWith('cloudformation:'))).toEqual(['cloudformation:DescribeStacks']);
    expect(cfnText).toContain('beta-anywear-ocr-api');
    expect(cfnText).toContain('beta-anywear-ocr-*');
    expect(cfnText).toContain('anywearworkloadstack-ocr-beta-*');
    expect(deployText).toContain('beta-anywear-ocr');
    expect(deployText).not.toContain('sts:AssumeRole');
    expect(deployText).toContain('arn:aws:ssm:ap-east-1:650880818323:parameter/cdk-bootstrap/hnb659fds/version');
    expect(deployText).toContain('cdk-hnb659fds-assets-650880818323-ap-east-1');
    for (const text of [cfnText, deployText]) {
      expect(text).not.toContain('AdministratorAccess');
      expect(text).not.toContain('iam:*');
      expect(text).not.toContain('github-actions-pipeline-role');
    }
    expect(deployText).not.toContain('"cdk-hnb659fds-deploy-role');
    const roleIds = (Object.entries(withSecond.Resources) as [string, any][])
      .filter(([, resource]) => resource === cfn).map(([id]) => id);
    expect(deployText).toContain(roleIds[0]);
  }, 120_000);

  it('rejects unknown keys and malformed service entries instead of ignoring them', () => {
    const base = { ...DEFAULT_FOUNDATION_SERVICE };
    expect(() => readFoundationServices([{ ...base, extra: 'ignored' }]))
      .toThrow(/descriptor must have exactly service, repository, repositoryId and environment/);
    expect(() => readFoundationServices([{ service: 'service', repository: 'AnyWear-Service', repositoryId: 1158460323 }]))
      .toThrow(/descriptor must have exactly/);
    expect(() => readFoundationServices([{ ...base, service: 'OCR' }])).toThrow(/service must be a lowercase service slug/);
    expect(() => readFoundationServices([{ ...base, repository: 'git-malu/AnyWear-Service' }]))
      .toThrow(/repository must be a plain repository name/);
    expect(() => readFoundationServices([{ ...base, repositoryId: '1158460323' }]))
      .toThrow(/repositoryId must be GitHub's immutable repository id/);
    expect(() => readFoundationServices([{ ...base, repositoryId: 0 }]))
      .toThrow(/repositoryId must be GitHub's immutable repository id/);
    expect(() => readFoundationServices([{ ...base, environment: 'Beta' }]))
      .toThrow(/environment must be a lowercase GitHub environment/);
    expect(() => readFoundationServices([{ ...base, environment: '' }]))
      .toThrow(/environment must be a lowercase GitHub environment/);
    expect(() => readFoundationServices({ service: 'service' })).toThrow(/must be a JSON array of service descriptors/);
    expect(() => readFoundationServices('not-json')).toThrow(/must be a JSON array of service descriptors/);
    expect(() => readFoundationServices([base, base])).toThrow(/Duplicate infraServices service service/);
    expect(() => readFoundationServices([secondService])).toThrow(/must include the reviewed default service/);
    expect(() => readFoundationServices([{ ...base, repositoryId: 1189999999 }, secondService]))
      .toThrow(/must keep the reviewed default service descriptor unchanged/);
    // The reviewed JSON-string form a `-c infraServices='[...]'` dispatch produces
    // is accepted; the descriptors are validated exactly like the array form.
    expect(readFoundationServices(JSON.stringify([base, secondService])))
      .toEqual([DEFAULT_FOUNDATION_SERVICE, secondService]);
  });

  it('fails the app before synthesis when the context carries an unknown descriptor key', () => {
    expect(() => synthesizeWithContext([{ ...DEFAULT_FOUNDATION_SERVICE, unexpected: true }]))
      .toThrow();
  }, 120_000);
});
