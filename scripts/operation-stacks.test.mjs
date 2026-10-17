import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredStacks, configuredStackNames, changedStackNames, validateStackManifest } from './operation-stacks.mjs';
import { cdkDeploymentArguments } from './runtime-operation.mjs';
import { createOperationRecord, readOperationRecord } from './operation-record.mjs';

const env = { GITHUB_SHA: '5'.repeat(40), GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_RUN_ID: '11', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main', INFRA_OPERATION: 'deploy-platform',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true' };

test('the configured stack set is exactly Foundation, the Beta stage base and Billing', () => {
  assert.deepEqual(configuredStacks.map(stack => [stack.stack_name, stack.region]), [
    ['AnyWearFoundationStack', 'ap-east-1'],
    ['AnyWearPlatformStack-beta', 'ap-east-1'],
    ['AnyWearBillingStack-beta', 'us-east-1'],
  ]);
  assert.deepEqual(configuredStackNames(), configuredStacks.map(stack => stack.stack_name));
});

test('no operation can deploy or recover the release slice', () => {
  assert.deepEqual(changedStackNames('deploy-foundation'), ['AnyWearFoundationStack']);
  assert.deepEqual(changedStackNames('deploy-billing'), ['AnyWearBillingStack-beta']);
  assert.deepEqual(changedStackNames('deploy-platform'), ['AnyWearPlatformStack-beta']);
  assert.deepEqual(changedStackNames('restore-release'), ['AnyWearPlatformStack-beta']);
  assert.deepEqual(changedStackNames('deploy-workload'), []);
  assert.deepEqual(changedStackNames('observe'), []);
});

test('the all-stack manifest is the configured set, never the changed subset', () => {
  const rows = configuredStacks.map(({ stack_name, region }) => ({ stack_name, region }));
  assert.deepEqual(validateStackManifest(rows, 'test'), rows);
  assert.throws(() => validateStackManifest(rows.slice(1), 'test'), /Every configured stack required/);
  assert.throws(() => validateStackManifest([...rows, { stack_name: 'AnyWearWorkloadStack-beta', region: 'ap-east-1' }], 'test'));
  assert.throws(() => validateStackManifest([{ ...rows[0] }, { ...rows[0] }, rows[2]], 'test'), /Invalid stack identity/);
  assert.throws(() => validateStackManifest([{ ...rows[0], region: 'us-east-1' }, rows[1], rows[2]], 'test'), /Invalid stack identity/);
});

test('cdk arguments load Service artifacts only for the stage base', () => {
  const platform = cdkDeploymentArguments('AnyWearPlatformStack-beta', '/verified', env);
  assert.ok(platform.includes('deployScope=application'));
  assert.ok(platform.includes('artifactDirectory=/verified'));
  for (const [stack, scope] of [['AnyWearFoundationStack', 'foundation'], ['AnyWearBillingStack-beta', 'billing']]) {
    const args = cdkDeploymentArguments(stack, '/verified', env);
    assert.ok(args.includes(`deployScope=${scope}`), stack);
    assert.ok(!args.some(arg => arg.startsWith('artifactDirectory=')), `${stack} must not load Service artifacts`);
  }
  assert.ok(platform.includes(`identityPhase=${env.INFRA_IDENTITY_PHASE}`));
  assert.ok(platform.includes(`ecrImageRetention=${env.INFRA_RETENTION_PROTECTION}`));
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
  const withoutRelease = createOperationRecord({ env: { ...env, INFRA_OPERATION: 'deploy-billing' } });
  assert.equal(withoutRelease.service_release, null);
});

test('historical operation records stay readable and invalid changed stacks fail', () => {
  const record = createOperationRecord({ env });
  assert.equal(readOperationRecord({ ...record, schema_version: 3 }).schema_version, 3);
  assert.throws(() => readOperationRecord({ ...record, schema_version: 5 }), /Unknown operation record schema/);
  assert.throws(() => readOperationRecord({ ...record, changed_stack_names: ['AnyWearWorkloadStack-beta'] }), /Invalid changed stack names/);
});
