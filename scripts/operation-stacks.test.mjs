import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredStacks, configuredStackNames, changedStackNames, validateStackManifest } from './operation-stacks.mjs';
import { cdkDeploymentArguments, cdkDestroyArguments } from './runtime-operation.mjs';
import { createOperationRecord, readOperationRecord } from './operation-record.mjs';

const env = { GITHUB_SHA: '5'.repeat(40), GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_RUN_ID: '11', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main', INFRA_OPERATION: 'deploy-platform',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true' };
const origin = 'beta-anywear-api-0123456789.ap-east-1.elb.amazonaws.com';

test('the configured stack set is exactly Foundation, the Beta Base stack and Billing', () => {
  assert.deepEqual(configuredStacks.map(stack => [stack.stack_name, stack.region]), [
    ['AnyWearFoundationStack', 'ap-east-1'],
    ['AnyWearPlatformStack-beta', 'ap-east-1'],
    ['AnyWearBillingStack-beta', 'us-east-1'],
  ]);
  assert.deepEqual(configuredStackNames(), configuredStacks.map(stack => stack.stack_name));
});

test('deploy-runtime and stop-runtime own the Runtime slice; Egress stays operation-owned', () => {
  assert.deepEqual(changedStackNames('deploy-foundation'), ['AnyWearFoundationStack']);
  assert.deepEqual(changedStackNames('deploy-billing'), ['AnyWearBillingStack-beta']);
  assert.deepEqual(changedStackNames('deploy-platform'), ['AnyWearPlatformStack-beta']);
  assert.deepEqual(changedStackNames('restore-release'), ['AnyWearPlatformStack-beta']);
  assert.deepEqual(changedStackNames('deploy-egress'), ['AnyWearEgressStack-beta']);
  assert.deepEqual(changedStackNames('delete-egress'), ['AnyWearEgressStack-beta']);
  assert.deepEqual(changedStackNames('deploy-workload'), []);
  assert.deepEqual(changedStackNames('deploy-runtime'), ['AnyWearRuntimeStack-beta']);
  assert.deepEqual(changedStackNames('stop-runtime'), ['AnyWearRuntimeStack-beta']);
  assert.deepEqual(changedStackNames('observe'), []);
});

test('the all-stack manifest is the configured set, never the changed subset', () => {
  const rows = configuredStacks.map(({ stack_name, region }) => ({ stack_name, region }));
  assert.deepEqual(validateStackManifest(rows, 'test'), rows);
  assert.throws(() => validateStackManifest(rows.slice(1), 'test'), /Every configured stack required/);
  assert.throws(() => validateStackManifest([...rows, { stack_name: 'AnyWearRuntimeStack-beta', region: 'ap-east-1' }], 'test'));
  assert.throws(() => validateStackManifest([...rows, { stack_name: 'AnyWearEgressStack-beta', region: 'ap-east-1' }], 'test'));
  assert.throws(() => validateStackManifest([{ ...rows[0] }, { ...rows[0] }, rows[2]], 'test'), /Invalid stack identity/);
  assert.throws(() => validateStackManifest([{ ...rows[0], region: 'us-east-1' }, rows[1], rows[2]], 'test'), /Invalid stack identity/);
});

test('cdk arguments load Service artifacts and the API origin only for the Base stack', () => {
  const platform = cdkDeploymentArguments('AnyWearPlatformStack-beta', '/verified', env, { apiOriginDomainName: origin });
  assert.ok(platform.includes('deployScope=application'));
  assert.ok(platform.includes('artifactDirectory=/verified'));
  assert.ok(platform.includes(`apiOriginDomainName=${origin}`));
  assert.throws(() => cdkDeploymentArguments('AnyWearPlatformStack-beta', '/verified', env), /requires the API origin domain name/);
  for (const [stack, scope] of [['AnyWearFoundationStack', 'foundation'], ['AnyWearBillingStack-beta', 'billing'],
    ['AnyWearEgressStack-beta', 'egress']]) {
    const args = cdkDeploymentArguments(stack, '/verified', env);
    assert.ok(args.includes(`deployScope=${scope}`), stack);
    assert.ok(!args.some(arg => arg.startsWith('artifactDirectory=')), `${stack} must not load Service artifacts`);
    assert.ok(!args.some(arg => arg.startsWith('apiOriginDomainName=')), `${stack} must not take the API origin`);
  }
  assert.ok(platform.includes(`identityPhase=${env.INFRA_IDENTITY_PHASE}`));
  assert.ok(platform.includes(`ecrImageRetention=${env.INFRA_RETENTION_PROTECTION}`));
  // The stop path destroys only the Egress stack through the same reviewed scope.
  const destroy = cdkDestroyArguments('AnyWearEgressStack-beta', env);
  assert.deepEqual(destroy.slice(0, 4), ['cdk', 'destroy', 'AnyWearEgressStack-beta', '--force']);
  assert.ok(destroy.includes('deployScope=egress'));
});

test('the operation record is v4 with the reviewed release identity and configured manifest', () => {
  const release = { releaseTag: 'beta-2026-10-18', serviceCommit: '6'.repeat(40) };
  const record = createOperationRecord({ env, release });
  assert.equal(record.schema_version, 4);
  assert.equal(record.record_type, 'anywear_infra_operation');
  assert.deepEqual(record.changed_stack_names, ['AnyWearPlatformStack-beta']);
  assert.deepEqual(record.service_release, release);
  assert.deepEqual(record.stack_manifest.map(row => row.stack_name), configuredStackNames());
  assert.ok(record.stack_manifest.every(row => row.source_repository === 'git-malu/AnyWear-Infra' && row.source_sha === env.GITHUB_SHA));
  assert.deepEqual(readOperationRecord(record), record);
  // The deploy resolves the release image digest from its immutable ECR tag and
  // records it in the same block; a historical record without it stays readable.
  const imageDigest = `sha256:${'7'.repeat(64)}`;
  const withDigest = createOperationRecord({ env, release: { ...release, imageDigest } });
  assert.deepEqual(withDigest.service_release, { ...release, imageDigest });
  assert.deepEqual(readOperationRecord(withDigest), withDigest);
  const withoutRelease = createOperationRecord({ env: { ...env, INFRA_OPERATION: 'deploy-billing' } });
  assert.equal(withoutRelease.service_release, null);
  // Egress is an operation-owned changed stack, not a manifest row.
  const egress = createOperationRecord({ env: { ...env, INFRA_OPERATION: 'delete-egress' } });
  assert.deepEqual(egress.changed_stack_names, ['AnyWearEgressStack-beta']);
  assert.deepEqual(egress.stack_manifest.map(row => row.stack_name), configuredStackNames());
  assert.deepEqual(readOperationRecord(egress), egress);
});

test('the v4 service release block validates its exact shape', () => {
  const release = { releaseTag: 'beta-2026-10-18', serviceCommit: '6'.repeat(40) };
  const record = createOperationRecord({ env, release });
  const shape = overrides => ({ ...record, service_release: overrides });
  for (const invalid of [{ releaseTag: release.releaseTag }, { serviceCommit: release.serviceCommit },
    { ...release, extra: true }, 'release', []]) {
    assert.throws(() => readOperationRecord(shape(invalid)), /Invalid operation service release/, JSON.stringify(invalid));
  }
  assert.throws(() => readOperationRecord(shape({ ...release, releaseTag: 'bad tag' })), /Invalid operation release tag/);
  assert.throws(() => readOperationRecord(shape({ ...release, serviceCommit: '6'.repeat(39) })), /Invalid operation Service commit/);
  assert.throws(() => readOperationRecord(shape({ ...release, image_digest: 'sha256:abc' })), /Invalid operation service release fields/);
  assert.throws(() => readOperationRecord(shape({ ...release, imageDigest: 'sha256:abc' })), /Invalid operation image digest/);
  assert.equal(readOperationRecord(shape(null)).service_release, null);
  // Creation refuses the same malformed block instead of writing it.
  assert.throws(() => createOperationRecord({ env, release: { releaseTag: release.releaseTag } }), /Invalid operation service release fields/);
});

test('historical operation records stay readable and invalid changed stacks fail', () => {
  const record = createOperationRecord({ env });
  assert.equal(readOperationRecord({ ...record, schema_version: 3 }).schema_version, 3);
  assert.throws(() => readOperationRecord({ ...record, schema_version: 5 }), /Unknown operation record schema/);
  assert.throws(() => readOperationRecord({ ...record, changed_stack_names: ['AnyWearWorkloadStack-beta'] }), /Invalid changed stack names/);
  // The Runtime stack is operation-owned since #195: naming it is valid, while
  // the retired Workload identity still fails closed.
  assert.deepEqual(readOperationRecord({ ...record, changed_stack_names: ['AnyWearRuntimeStack-beta'] }).changed_stack_names, ['AnyWearRuntimeStack-beta']);
});
