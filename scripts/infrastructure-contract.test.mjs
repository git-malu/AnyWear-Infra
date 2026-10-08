import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseJson, canonicalJson, contentHash, sha256 } from './json-contract.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { validateSelection, verifySelection } from './artifact-consumer.mjs';
import { assertNativeReleaseAttestation } from './vendor/service-release-attestation.mjs';
import { validateDeploymentRecord, assertObservedMatchesDeployment, stableLambdaConfiguration } from './deployment-contract.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateOperationInputs, betaDeploymentActivity } from './runtime-operation.mjs';
import { verifyRetentionPolicy, verifyProtectedImages, verifyLifecyclePreview } from './ecr-retention.mjs';

const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), 'anywear-infra-contract-'));
const { selector, manifest } = await createTestInputs(fixtureDirectory);
const sha = '5'.repeat(40);
const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'anywear-infra-trusted-contract-'));
const execute = promisify(execFile);
const git = async args => (await execute('git', ['-C', sourceRoot, ...args])).stdout.trim();
await git(['init', '--quiet']); await git(['config', 'core.autocrlf', 'false']);
await git(['config', 'user.name', 'Contract fixture']); await git(['config', 'user.email', 'fixture@invalid.local']);
await git(['remote', 'add', 'origin', 'https://github.com/git-malu/AnyWear-Infra.git']);
await mkdir(path.join(sourceRoot, 'selections')); await writeFile(path.join(sourceRoot, 'selections/beta.json'), canonicalJson(selector));
await git(['add', '.']); await git(['commit', '--quiet', '-m', 'Reviewed selection']);
const binding = { trustedInfraRoot: sourceRoot, expectedInfraSha: await git(['rev-parse', 'HEAD']), selectionFile: 'selections/beta.json', selectionSha256: contentHash(selector) };
const env = { AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', GITHUB_SHA: sha, GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265', ENABLE_BETA_DEPLOY: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main',
  INFRA_OPERATION: 'observe', INFRA_IDENTITY_PHASE: 'legacy', INFRA_RETENTION_PROTECTION: 'false',
  SELECTION_FILE: binding.selectionFile, SELECTION_SHA256: binding.selectionSha256 };
const fixtureRecord = () => {
  const migrations = [{ id: '2'.repeat(64), created_at: 1000 }];
  return { schema_version: 2, record_type: 'anywear_infra_deployment', infra: { repository: 'git-malu/AnyWear-Infra', sha,
    workflow_path: '.github/workflows/runtime.yml', workflow_ref: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main', run_id: 23, run_attempt: 1 },
    selection: { file: binding.selectionFile, sha256: contentHash(selector), release: selector.release, components: manifest.components },
    stacks: ['AnyWearFoundationStack', 'AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta', 'AnyWearBillingStack-beta'].map(stack_name => ({ stack_name,
      region: stack_name.includes('Billing') ? 'us-east-1' : 'ap-east-1', source_repository: 'git-malu/AnyWear-Service', source_sha: '1'.repeat(40), template_sha256: 'a'.repeat(64) })),
    observed: { service_sha: selector.image.service_sha, image_digest: selector.image.digest,
      ecs: Object.fromEntries(['api', 'worker'].map(purpose => [purpose, {
        service_arn: `arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-${purpose}`,
        task_definition_arn: `arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-${purpose}:1`, image_digest: selector.image.digest }])),
      lambdas: { 'pre-sign-up': { code_sha256: selector.lambdas.pre_sign_up.code_sha256, configuration_sha256: 'b'.repeat(64) },
        'post-confirmation': { code_sha256: selector.lambdas.post_confirmation.code_sha256, configuration_sha256: 'b'.repeat(64) } },
      policy_content_sha256: selector.runtime_policy.content_sha256, queue_config_sha256: 'c'.repeat(64), client_sha: '6'.repeat(40),
      endpoints: { api: 'https://d1pfqujqt29n11.cloudfront.net', client: 'https://d2rztl7o0y7rf8.cloudfront.net' } },
    schema: { selected_journal_sha256: selector.schema.journal_sha256, observed_applied_journal_sha256: contentHash(migrations),
      selected_migration_ids: migrations, applied_migration_ids: migrations, selected_current_version: 16, minimum_schema_version: 16, minimum_migration_count: 1, applied_schema_version: 16,
      compatibility_result: 'compatible', verification: { command_sha256: 'd'.repeat(64), source_repository: 'git-malu/AnyWear-Infra', source_sha: sha,
        image_digest: selector.image.digest, service_sha: selector.image.service_sha,
        executor: { repository: 'git-malu/AnyWear-Infra', sha, workflow_path: '.github/workflows/runtime.yml', run_id: 23, run_attempt: 1 },
        task_arn: `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'a'.repeat(32)}`,
        task_definition_arn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-artifact-verify:1' } } };
};
// Selected component asset IDs live in the selector, outside immutable manifest.
const recordWithIds = () => { const record = fixtureRecord(); record.selection.components = { image: selector.image, lambdas: selector.lambdas,
  runtime_policy: selector.runtime_policy, schema: selector.schema }; return record; };

test('RFC8785 ordering, duplicate escaped keys, invalid UTF8/surrogates fail closed', () => {
  assert.equal(canonicalJson({ z: 1e30, a: -0 }), '{"a":0,"z":1e+30}');
  for (const text of ['{"a":1,"\\u0061":2}', '{"a":{"z":1,"z":2}}', '1e999', '"\\ud800"', '{}true']) assert.throws(() => parseJson(text));
  assert.throws(() => parseJson(Buffer.from([0xff])));
});
test('selection rejects unknown nested fields, traversal and duplicate assets', () => {
  validateSelection(selector);
  for (const mutate of [s => s.lambdas.pre_sign_up.file = '../code.zip', s => s.schema.asset_id = s.runtime_policy.asset_id,
    s => s.image.unknown = true, s => s.release.manifest_sha256 = 'x', s => s.schema.sha256 = undefined]) {
    const value = structuredClone(selector); mutate(value); assert.throws(() => validateSelection(value));
  }
});
function nativeFixture(predicateType = 'https://in-toto.io/attestation/release/v0.1') {
  const tag = `service-artifacts-${selector.image.service_sha}`; const purl = `pkg:github/git-malu/AnyWear-Service@${tag}`;
  const hashes = { 'service-artifacts.json': selector.release.manifest_sha256, ...Object.fromEntries([...Object.values(selector.lambdas), selector.runtime_policy, selector.schema].map(item => [item.file, item.sha256])) };
  const identity = { ownerId: '11473072', repositoryId: '1158460323', repository: 'git-malu/AnyWear-Service', purl, tag };
  const predicate = predicateType.endsWith('/v0.2') ? { ...identity, databaseId: '1', packageId: '1158460323' } : { ...identity, releaseId: '1' };
  const statement = { _type: 'https://in-toto.io/Statement/v1', predicateType, predicate,
    subject: [{ uri: purl, digest: { sha1: selector.image.service_sha } }, ...Object.entries(hashes).map(([name, hash]) => ({ name, digest: { sha256: hash } }))] };
  return { verificationResult: { statement, signature: { certificate: { subjectAlternativeName: 'https://dotcom.releases.github.com' } } },
    attestation: { bundle: { dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64'), signatures: [{ sig: 'test-only' }] } } } };
}

function selectedArtifactIo(native, conclusion = 'success') {
  const ids = new Map([[1, 'service-artifacts.json'], [2, 'pre-sign-up.zip'], [3, 'post-confirmation.zip'], [4, 'runtime-policy.json'], [5, 'service-schema.json']]);
  const nativeChecks = [];
  return { nativeChecks, async api(endpoint) {
    if (endpoint.includes('/releases/')) return { id: 1, immutable: true, draft: false, tag_name: `service-artifacts-${selector.image.service_sha}`,
      target_commitish: selector.image.service_sha,
      assets: await Promise.all([...ids].map(async ([id, name]) => { const bytes = await readFile(path.join(fixtureDirectory, name)); return { id, name, state: 'uploaded', size: bytes.length, digest: `sha256:${sha256(bytes)}` }; })) };
    if (endpoint.includes('/git/ref/')) return { object: { type: 'commit', sha: selector.image.service_sha } };
    return { id: 1, run_attempt: 1, head_sha: manifest.producer.workflow_sha, head_branch: 'main', path: '.github/workflows/service-artifacts.yml',
      repository: { full_name: 'git-malu/AnyWear-Service', id: 1158460323, owner: { id: 11473072, login: 'git-malu' } }, head_repository: { full_name: 'git-malu/AnyWear-Service', id: 1158460323, owner: { id: 11473072, login: 'git-malu' } },
      event: 'workflow_dispatch', status: 'completed', conclusion };
  }, async asset(repo, id) { return readFile(path.join(fixtureDirectory, ids.get(id))); },
  async attestation(tag, file) { nativeChecks.push(file ? path.basename(file) : 'release'); return native; } };
}

for (const predicateType of ['https://in-toto.io/attestation/release/v0.1', 'https://in-toto.io/attestation/release/v0.2']) {
  test(`authenticated ${predicateType} release preserves one complete signed statement across six checks`, async () => {
    const native = nativeFixture(predicateType);
    const original = canonicalJson(native);
    const io = selectedArtifactIo(native);
    const result = await verifySelection(binding, await mkdtemp(path.join(os.tmpdir(), 'anywear-infra-download-')), io);
    assert.equal(result.schema.minimum_version, 16);
    assert.deepEqual(io.nativeChecks, ['release', 'service-artifacts.json', 'post-confirmation.zip', 'pre-sign-up.zip', 'runtime-policy.json', 'service-schema.json']);
    assert.equal(canonicalJson(native), original, 'Consumer must preserve the original native statement/envelope');
    const bytes = await readFile(path.join(fixtureDirectory, 'pre-sign-up.zip'));
    await assert.rejects(verifySelection(binding, await mkdtemp(path.join(os.tmpdir(), 'anywear-infra-download-')),
      { ...io, async asset(repo, id) { return id === 2 ? Buffer.concat([bytes, Buffer.from('tamper')]) : io.asset(repo, id); } }), /Downloaded asset size\/hash differs/);
  });

  test(`${predicateType} consumer rejects a different policy-valid signed statement for each of the five assets`, async () => {
    const native = nativeFixture(predicateType);
    const altered = structuredClone(native);
    altered.verificationResult.statement.subject.reverse();
    altered.attestation.bundle.dsseEnvelope.payload = Buffer.from(canonicalJson(altered.verificationResult.statement)).toString('base64');
    const expected = { releaseId: selector.release.id, tag: `service-artifacts-${selector.image.service_sha}`, target: selector.image.service_sha,
      assetHashes: { 'service-artifacts.json': selector.release.manifest_sha256,
        ...Object.fromEntries([...Object.values(selector.lambdas), selector.runtime_policy, selector.schema].map(item => [item.file, item.sha256])) } };
    assertNativeReleaseAttestation(native, expected); assertNativeReleaseAttestation(altered, expected);
    for (const mismatch of ['service-artifacts.json', 'pre-sign-up.zip', 'post-confirmation.zip', 'runtime-policy.json', 'service-schema.json']) {
      const io = selectedArtifactIo(native);
      await assert.rejects(verifySelection(binding, await mkdtemp(path.join(os.tmpdir(), 'anywear-infra-mixed-native-')),
        { ...io, async attestation(tag, file) { return file && path.basename(file) === mismatch ? altered : native; } }),
        /different native statement/, mismatch);
    }
  });

  test(`${predicateType} policy-valid native evidence cannot qualify a failed producer`, async () => {
    const native = nativeFixture(predicateType);
    const expected = { releaseId: selector.release.id, tag: `service-artifacts-${selector.image.service_sha}`, target: selector.image.service_sha,
      assetHashes: { 'service-artifacts.json': selector.release.manifest_sha256,
        ...Object.fromEntries([...Object.values(selector.lambdas), selector.runtime_policy, selector.schema].map(item => [item.file, item.sha256])) } };
    assertNativeReleaseAttestation(native, expected);
    const io = selectedArtifactIo(native, 'failure');
    await assert.rejects(verifySelection(binding, await mkdtemp(path.join(os.tmpdir(), 'anywear-infra-failed-publisher-')), io), /complete successfully/);
    assert.deepEqual(io.nativeChecks, [], 'Reject failed producer before any native verification');
  });
}

test('operation main workflow/account/region/selection/identity/retention bind before credentials', () => {
  validateOperationInputs(env);
  for (const patch of [{ GITHUB_SHA: 'short' }, { GITHUB_REF: 'refs/heads/branch' }, { INFRA_OPERATION: 'unknown' },
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_WORKFLOW_REF: 'other' }, { ENABLE_BETA_DEPLOY: 'false' }, { AWS_REGION: 'us-east-1' },
    { INFRA_IDENTITY_PHASE: undefined }, { INFRA_RETENTION_PROTECTION: undefined }, { SELECTION_FILE: '../beta.json' }, { SELECTION_SHA256: 'short' }]) assert.throws(() => validateOperationInputs({ ...env, ...patch }));
});
test('maintenance deployment preserves both stopped stacks and rejects either mixed or unknown state', () => {
  const stack = value => ({ Outputs: [{ OutputKey: 'BetaActive', OutputValue: value }] });
  assert.equal(betaDeploymentActivity(stack('false'), stack('false')), false);
  assert.equal(betaDeploymentActivity(stack('true'), stack('true')), true);
  for (const [platform, workload] of [['true', 'false'], ['false', 'true']]) assert.throws(() => betaDeploymentActivity(stack(platform), stack(workload)), new RegExp(`Platform=${platform}, Workload=${workload}`));
  assert.throws(() => betaDeploymentActivity(stack(undefined), stack('false')), /Both/);
});
test('deployment strict binding rejects legacy, undeclared artifact and template/code/schema drift', () => {
  const record = recordWithIds(); validateDeploymentRecord(record);
  const snapshot = { stacks: record.stacks, observed: record.observed, schema: record.schema }; assertObservedMatchesDeployment(record, snapshot);
  for (const mutate of [r => r.schema_version = 1, r => r.selection.components.image.extra = 1,
    r => r.observed.lambdas['pre-sign-up'].code_sha256 = Buffer.alloc(32).toString('base64'),
    r => r.schema.applied_migration_ids[0].id = '0'.repeat(64), r => r.schema.applied_schema_version = 15,
    r => r.infra.workflow_path = '.github/workflows/other.yml']) {
    const value = structuredClone(record); mutate(value); assert.throws(() => validateDeploymentRecord(value));
  }
  const value = structuredClone(snapshot); value.stacks[0].template_sha256 = '0'.repeat(64);
  assert.throws(() => assertObservedMatchesDeployment(record, value), /differs/);
});
test('schema16 image accepts compatible DB17 with independently hashed applied journal', () => {
  const record = recordWithIds(); record.schema.applied_schema_version = 17;
  record.schema.applied_migration_ids = [...record.schema.selected_migration_ids, { id: '9'.repeat(64), created_at: 2000 }];
  record.schema.observed_applied_journal_sha256 = contentHash(record.schema.applied_migration_ids);
  validateDeploymentRecord(record);
  assert.notEqual(record.schema.selected_journal_sha256, record.schema.observed_applied_journal_sha256);
});
test('volatile task/executor identities differ while pinned command/artifacts/schema remain equal', () => {
  const record = recordWithIds(); const snapshot = structuredClone({ stacks: record.stacks, observed: record.observed, schema: record.schema });
  snapshot.schema.verification.executor = { repository: 'git-malu/AnyWear-E2E', sha: '8'.repeat(40), workflow_path: '.github/workflows/beta-qualification.yml', run_id: 24, run_attempt: 2 };
  snapshot.schema.verification.task_arn = snapshot.schema.verification.task_arn.replace('a'.repeat(32), 'b'.repeat(32));
  assertObservedMatchesDeployment(record, snapshot);
  snapshot.schema.verification.command_sha256 = '0'.repeat(64); assert.throws(() => assertObservedMatchesDeployment(record, snapshot), /differs/);
});
test('Lambda stable hash excludes revision time, preserves ordered layers, normalizes set subnet IDs', () => {
  const config = { FunctionName: 'beta-example', Runtime: 'nodejs24.x', Handler: 'index.handler', Role: 'arn:role', MemorySize: 128, Timeout: 3,
    Architectures: ['x86_64'], Layers: [{ Arn: 'layer1', CodeSize: 1 }, { Arn: 'layer2' }], Environment: { Variables: { STAGE: 'beta' } },
    VpcConfig: { SubnetIds: ['b', 'a'], SecurityGroupIds: ['g2', 'g1'], VpcId: 'transient' }, RevisionId: 'volatile', LastModified: 'volatile' };
  const stable = stableLambdaConfiguration(config);
  assert.deepEqual(stable.VpcConfig.SubnetIds, ['a', 'b']); assert.equal(stable.RevisionId, undefined);
  assert.equal(contentHash(stable), contentHash(stableLambdaConfiguration({ ...config, RevisionId: 'new' })));
  assert.notEqual(contentHash(stable), contentHash(stableLambdaConfiguration({ ...config, Layers: [...config.Layers].reverse() })));
});
test('protected retention priority+count bound+authenticated preview fail closed', () => {
  const policy = { rules: [{ rulePriority: 1, selection: { tagStatus: 'tagged', tagPrefixList: ['protected-service-'], countType: 'imageCountMoreThan', countNumber: 1000 }, action: { type: 'expire' } },
    { rulePriority: 2, selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 30 }, action: { type: 'expire' } }] };
  verifyRetentionPolicy(policy, contentHash(policy));
  const required = [{ service_sha: selector.image.service_sha, digest: selector.image.digest }];
  verifyProtectedImages([{ imageDigest: selector.image.digest, imageTags: [`protected-service-${selector.image.service_sha}`] }], required);
  assert.throws(() => verifyProtectedImages([{ imageDigest: selector.image.digest, imageTags: ['normal'] }], required));
  assert.throws(() => verifyProtectedImages(Array.from({ length: 257 }, (_, i) => ({ imageDigest: `sha256:${sha256(String(i))}`, imageTags: ['protected-service-source'] })), required));
  assert.throws(() => verifyLifecyclePreview({ status: 'COMPLETE', previewResults: [{ imageDigest: selector.image.digest, action: { type: 'EXPIRE' } }] }, required));
  assert.throws(() => verifyRetentionPolicy({ rules: [policy.rules[1]] }));
});

test('direct verification rejects publisher repository/owner/fork/source identity before native reads and rechecks producer at completion', async () => {
  const native = nativeFixture();
  for (const after of [false, true]) {
    for (const mutate of [run => run.repository.owner.login = 'other', run => run.head_repository.owner.id = 1,
      run => run.head_repository.full_name = 'fork/AnyWear-Service', run => run.head_sha = '9'.repeat(40),
      run => run.run_attempt++, run => run.conclusion = 'failure']) {
      const base = selectedArtifactIo(native); let reads = 0;
      const io = { ...base, async api(endpoint) {
        const value = await base.api(endpoint);
        if (endpoint.includes('/actions/runs/') && ++reads === (after ? 2 : 1)) mutate(value);
        return value;
      } };
      await assert.rejects(verifySelection(binding, await mkdtemp(path.join(os.tmpdir(), 'infra-producer-negative-')), io), /complete successfully/);
      assert.equal(base.nativeChecks.length, after ? 6 : 0);
    }
  }
});
test('direct verification rejects release target, API asset sizes/digests and end-of-verification release drift', async () => {
  for (const [mutation, expected] of [
    [release => release.target_commitish = '9'.repeat(40), /source binding/],
    [release => release.assets[0].size++, /Downloaded asset size/],
    [release => release.assets[0].digest = `sha256:${'9'.repeat(64)}`, /API digest/],
    [release => release.assets[0].size = 0, /asset API size/]]) {
    const base = selectedArtifactIo(nativeFixture());
    await assert.rejects(verifySelection(binding, await mkdtemp(path.join(os.tmpdir(), 'infra-release-negative-')), {
      ...base, async api(endpoint) { const value = await base.api(endpoint); if (endpoint.includes('/releases/')) mutation(value); return value; },
    }), expected);
  }
  const base = selectedArtifactIo(nativeFixture()); let releases = 0;
  await assert.rejects(verifySelection(binding, await mkdtemp(path.join(os.tmpdir(), 'infra-release-drift-')), {
    ...base, async api(endpoint) { const value = await base.api(endpoint); if (endpoint.includes('/releases/') && ++releases === 2) value.assets[0].size++; return value; },
  }), /identity changed/);
});
