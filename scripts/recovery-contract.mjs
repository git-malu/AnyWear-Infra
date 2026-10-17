import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// These are reviewed recovery targets, not measurements: Production has no
// cluster yet and no drill result is recorded here. DeletionPolicy values are
// template terms; RemovalPolicy is the CDK source term. Aurora offers no
// instance-level deletion protection, so the cluster carries it and the writer
// instance inherits the DeletionPolicy implied by the cluster removal policy.
export const RECOVERY_TARGETS = Object.freeze({
  beta: Object.freeze({
    stage: 'beta',
    stackName: 'AnyWearPlatformStack-beta',
    pitrRetentionDays: 7,
    preferredBackupWindow: '16:00-16:30',
    deletionProtection: true,
    clusterRemovalPolicy: 'DESTROY',
    clusterDeletionPolicy: 'Delete',
  }),
  prod: Object.freeze({
    stage: 'prod',
    stackName: 'AnyWearPlatformStack-prod',
    pitrRetentionDays: 35,
    preferredBackupWindow: '16:00-16:30',
    deletionProtection: true,
    clusterRemovalPolicy: 'RETAIN',
    clusterDeletionPolicy: 'Retain',
  }),
});

export function platformStackName(stage) {
  return `AnyWearPlatformStack-${stage}`;
}

export function platformStackStage(stackName) {
  return /^AnyWearPlatformStack-(dev|beta|prod)$/.exec(stackName ?? '')?.[1];
}

function deletionPolicyForRemovalPolicy(removalPolicy) {
  assert.ok(['DESTROY', 'RETAIN'].includes(removalPolicy), `Unknown removal policy: ${removalPolicy}`);
  return removalPolicy === 'RETAIN' ? 'Retain' : 'Delete';
}

// Every returned entry names the exact violated template path with its expected
// value, so a caller fails on the contract rather than on a bare count.
export function recoveryViolations(template, { stage } = {}) {
  assert.ok(['dev', 'beta', 'prod'].includes(stage), `Unknown stage for the database recovery contract: ${stage}`);
  const resources = template?.Resources ?? {};
  const clusters = Object.entries(resources).filter(([, resource]) => resource?.Type === 'AWS::RDS::DBCluster');
  if (stage === 'dev') {
    return clusters.map(([id]) => ({ path: `/Resources/${id}`, expected: 'absent', actual: 'AWS::RDS::DBCluster' }));
  }
  const target = RECOVERY_TARGETS[stage];
  if (clusters.length !== 1) {
    return [{ path: '/Resources', expected: 'one AWS::RDS::DBCluster', actual: `${clusters.length} AWS::RDS::DBCluster resources` }];
  }
  const [[clusterId, cluster]] = clusters;
  const violations = [];
  for (const [property, expected] of [
    ['BackupRetentionPeriod', target.pitrRetentionDays],
    ['PreferredBackupWindow', target.preferredBackupWindow],
    ['DeletionProtection', target.deletionProtection],
  ]) {
    const actual = cluster.Properties?.[property];
    if (actual !== expected) violations.push({ path: `/Resources/${clusterId}/Properties/${property}`, expected, actual });
  }
  if (cluster.DeletionPolicy !== target.clusterDeletionPolicy) {
    violations.push({ path: `/Resources/${clusterId}/DeletionPolicy`, expected: target.clusterDeletionPolicy, actual: cluster.DeletionPolicy });
  }
  const writers = Object.entries(resources).filter(([, resource]) => resource?.Type === 'AWS::RDS::DBInstance'
    && resource.Properties?.DBClusterIdentifier?.Ref === clusterId);
  if (writers.length !== 1) {
    violations.push({ path: `/Resources/${clusterId}`, expected: `one AWS::RDS::DBInstance writer for ${clusterId}`, actual: `${writers.length} writers` });
    return violations;
  }
  const expectedWriterPolicy = deletionPolicyForRemovalPolicy(target.clusterRemovalPolicy);
  const [[writerId, writer]] = writers;
  if (writer.DeletionPolicy !== expectedWriterPolicy) {
    violations.push({ path: `/Resources/${writerId}/DeletionPolicy`, expected: expectedWriterPolicy, actual: writer.DeletionPolicy });
  }
  return violations;
}

export function recoveryFailureMessage(violations, { stage, stackName }) {
  const details = violations.map(({ path, expected, actual }) => (
    `${path} (expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)})`)).join(', ');
  return `Database recovery contract violated for stage ${stage}, stack ${stackName}: ${details}`;
}

// The matrix and the pre-credential deployment check must synthesize the same
// way: run the existing app directly with the locked local ts-node. CDK auto-
// synthesizes because CDK_OUTDIR is set; no AWS context lookup or CDK CLI
// invocation happens here.
export function synthStage({ repository = repositoryRoot, directory, stage, environmentRunning = true, inputs } = {}) {
  assert.ok(directory, 'Synthesis output directory is required');
  assert.ok(['dev', 'beta', 'prod'].includes(stage), `Unknown stage: ${stage}`);
  mkdirSync(directory, { recursive: true });
  const config = JSON.parse(readFileSync(path.join(repository, 'cdk.json'), 'utf8'));
  const context = { ...config.context, stage, environmentRunning };
  if (inputs) {
    assert.ok(['legacy', 'roles-added', 'retired'].includes(inputs.identityPhase), 'Explicit identity phase required');
    assert.equal(typeof inputs.ecrImageRetention, 'boolean', 'Explicit image retention required');
    assert.ok(['cdk', 'external'].includes(inputs.legacyRoleSource), 'Explicit legacy role source required');
    assert.ok(inputs.artifactDirectory, 'Artifact directory required');
    Object.assign(context, {
      identityPhase: inputs.identityPhase,
      ecrImageRetention: inputs.ecrImageRetention,
      legacyRoleSource: inputs.legacyRoleSource,
      artifactDirectory: path.resolve(inputs.artifactDirectory),
    });
  }
  execFileSync(process.execPath, ['--require', path.join(repository, 'node_modules/ts-node/register'),
    path.join(repository, 'bin/infra.ts')], { cwd: repository, stdio: 'pipe', env: { ...process.env,
    CDK_CONTEXT_JSON: JSON.stringify(context), CDK_OUTDIR: directory,
    CDK_DEFAULT_ACCOUNT: '650880818323', CDK_DEFAULT_REGION: 'ap-east-1', BILLING_REGION: 'us-east-1' } });
  const files = readdirSync(directory).filter((file) => file.endsWith('.template.json'));
  assert.ok(files.includes('AnyWearFoundationStack.template.json'), `Synth failed for ${directory}`);
  return files;
}
