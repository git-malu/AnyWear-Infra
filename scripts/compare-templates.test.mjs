import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTemplates } from './compare-templates.mjs';

// A miniature stage-base template. The comparator is generic; the allowances are
// keyed by stack name and identity phase.
const base = () => ({
  Parameters: { BetaApiSizingProfile: { Type: 'String', Default: 's1' } },
  Conditions: { BetaApiS2: { 'Fn::Equals': [{ Ref: 'BetaApiSizingProfile' }, 's2-api'] } },
  Resources: {
    Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'x' } },
    PreSignUp: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'beta-anywear-pre-sign-up',
      Code: { S3Key: `${'a'.repeat(64)}.zip` } }, Metadata: { 'aws:asset:path': 'asset.old', 'aws:asset:is-bundled': 'true' } },
    Meta: { Type: 'AWS::CDK::Metadata', Properties: { Analytics: 'v1:count=1' } },
    Database: { Type: 'AWS::RDS::DBCluster', Properties: { DeletionProtection: false } },
    Repo: { Type: 'AWS::ECR::Repository', Properties: { RepositoryName: 'beta-anywear-service',
      LifecyclePolicy: { LifecyclePolicyText: JSON.stringify({ rules: [{ rulePriority: 1, selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 30 }, action: { type: 'expire' } }] }) } } },
    BetaE2EQualificationRoleABCD1234: { Type: 'AWS::IAM::Role', Properties: { RoleName: 'beta-e2e-qualification-role' } },
  },
  Outputs: {
    Existing: { Value: 'x' },
    PublishOutputRefAnyWearVpcA8B15590: { Value: { Ref: 'AnyWearVpc' } },
  },
});
const options = (overrides = {}) => ({ phase: 'legacy', stage: 'beta', stackName: 'AnyWearPlatformStack-beta', ...overrides });

test('an unchanged template is accepted in every phase', () => {
  for (const phase of ['legacy', 'roles-added', 'retired']) {
    const report = compareTemplates(base(), base(), options({ phase }));
    assert.equal(report.accepted, true); assert.deepEqual(report.rejected, []);
  }
});

test('the release-slice weak cross-stack outputs may disappear in every phase and stage', () => {
  const after = base(); delete after.Outputs.PublishOutputRefAnyWearVpcA8B15590;
  for (const phase of ['legacy', 'roles-added', 'retired']) {
    for (const stage of ['beta', 'prod']) {
      const report = compareTemplates(base(), after, options({ phase, stage, stackName: 'AnyWearPlatformStack-beta' }));
      assert.equal(report.accepted, true, `${stage} ${phase}`);
      assert.equal(report.allowed.length, 1);
      assert.match(report.allowed[0].reason, /Release-slice-only weak cross-stack output/);
    }
  }
  // A real output change is not a removal and still fails.
  const changed = base(); changed.Outputs.Existing = { Value: 'y' };
  assert.equal(compareTemplates(base(), changed, options()).accepted, false);
  // Removing any other output fails.
  const other = base(); delete other.Outputs.Existing;
  assert.equal(compareTemplates(base(), other, options()).accepted, false);
});

test('only the reviewed resource allowances pass', () => {
  const telemetry = base(); telemetry.Resources.Meta = { Type: 'AWS::CDK::Metadata', Properties: { Analytics: 'v2:count=2' } };
  assert.equal(compareTemplates(base(), telemetry, options()).accepted, true);
  const lambda = base(); lambda.Resources.PreSignUp.Properties.Code.S3Key = `${'b'.repeat(64)}.zip`;
  lambda.Resources.PreSignUp.Metadata['aws:asset:path'] = 'asset.new';
  const lambdaReport = compareTemplates(base(), lambda, options());
  assert.equal(lambdaReport.accepted, true);
  assert.ok(lambdaReport.allowed.every(entry => entry.reason === 'Verified prebuilt Lambda asset location'));
  const retention = base();
  retention.Resources.Repo.Properties.LifecyclePolicy.LifecyclePolicyText = JSON.stringify({ rules: [
    { rulePriority: 1, selection: { tagStatus: 'tagged', tagPrefixList: ['protected-service-'], countType: 'imageCountMoreThan', countNumber: 1000 }, action: { type: 'expire' } },
    { rulePriority: 2, selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 30 }, action: { type: 'expire' } }] });
  assert.equal(compareTemplates(base(), retention, options({ ecrImageRetention: true })).accepted, true);
  assert.equal(compareTemplates(base(), retention, options({ ecrImageRetention: false })).accepted, false);
  const recovery = base();
  recovery.Resources.Database.Properties = { BackupRetentionPeriod: 7, PreferredBackupWindow: '16:00-16:30', DeletionProtection: true };
  assert.equal(compareTemplates(base(), recovery, options()).accepted, true);
});

test('dedicated identity resources are allowed only outside the legacy phase', () => {
  const without = base(); delete without.Resources.BetaE2EQualificationRoleABCD1234;
  const added = base();
  const foundation = options({ phase: 'roles-added', stackName: 'AnyWearFoundationStack' });
  assert.equal(compareTemplates(without, added, foundation).accepted, true);
  const report = compareTemplates(without, added, foundation);
  assert.equal(report.allowed[0].reason, 'Dedicated Beta identity resource');
  assert.equal(compareTemplates(without, added, { ...foundation, phase: 'legacy' }).accepted, false);
});

test('any other resource or output change is rejected with its exact path', () => {
  const before = base(); const after = base();
  after.Resources.Bucket.Properties.BucketName = 'y';
  const report = compareTemplates(before, after, options());
  assert.equal(report.accepted, false);
  assert.deepEqual(report.rejected.map(entry => entry.path), ['/Resources/Bucket/Properties/BucketName']);
});

test('the release slice sizing, telemetry, cleanup and machine-auth allowances are gone', () => {
  const after = base();
  after.Resources.ApiService = { Type: 'AWS::ECS::Service', Properties: { ServiceName: 'beta-anywear-api', DesiredCount: 1 } };
  after.Conditions.BetaApiS2 = { 'Fn::Equals': [{ Ref: 'BetaApiSizingProfile' }, 's2-api'] };
  const report = compareTemplates({ ...base(), Resources: { ...base().Resources } }, after, options({ stackName: 'AnyWearWorkloadStack-beta' }));
  assert.equal(report.accepted, false);
  assert.ok(report.rejected.some(entry => entry.path === '/Resources/ApiService'));
});
