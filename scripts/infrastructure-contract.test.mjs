import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseJson, canonicalJson, contentHash, sha256 } from './json-contract.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { validateSelection, verifySelection } from './artifact-consumer.mjs';
import { validateDeploymentRecord, assertObservedMatchesDeployment, stableLambdaConfiguration } from './deployment-contract.mjs';
import { assertWriterWindow } from './writer-window.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';
import { verifyRetentionPolicy, verifyProtectedImages, verifyLifecyclePreview } from './ecr-retention.mjs';

const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), 'anywear-infra-contract-'));
const { selector, manifest } = await createTestInputs(fixtureDirectory);
const sha = '5'.repeat(40);
const env = { AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', GITHUB_SHA: sha, GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265', ENABLE_BETA_DEPLOY: 'true',
  INFRA_WRITER_WINDOW: 'window-54-1', WRITER_WINDOW_INPUT: 'window-54-1', INFRA_WINDOW_SHA: sha,
  INFRA_WINDOW_EXPIRES_AT: '2099-01-01T00:00:00Z', INFRA_WINDOW_RECORD_URL: 'https://github.com/git-malu/AnyWear/issues/54#issuecomment-6041978451',
  INFRA_WINDOW_OPERATION: 'observe', INFRA_OPERATION: 'observe', IDENTITY_PHASE_INPUT: 'legacy', INFRA_IDENTITY_PHASE: 'legacy',
  INFRA_RETENTION_PROTECTION: 'false', RETENTION_PROTECTION_INPUT: 'false', SELECTION_FILE: 'selections/beta.json',
  SELECTION_SHA256: contentHash(selector), INFRA_WINDOW_SELECTION_SHA256: contentHash(selector) };
const fixtureRecord = () => {
  const migrations = [{ id: '2'.repeat(64), created_at: 1000 }];
  return { schema_version: 1, record_type: 'anywear_infra_deployment', infra: { repository: 'git-malu/AnyWear-Infra', sha,
    workflow_path: '.github/workflows/runtime.yml', workflow_ref: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main', run_id: 23, run_attempt: 1 },
    selection: { sha256: contentHash(selector), release: selector.release, publication_acceptance: selector.publication_acceptance, components: manifest.components },
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
test('publisher run must finish success; release published event is insufficient', async () => {
  const ids = new Map([[1, 'service-artifacts.json'], [2, 'pre-sign-up.zip'], [3, 'post-confirmation.zip'], [4, 'runtime-policy.json'], [5, 'service-schema.json']]);
  const io = { async api(endpoint) {
    if (endpoint.includes('/releases/')) return { id: 1, immutable: true, draft: false, tag_name: `service-artifacts-${selector.image.service_sha}`,
      assets: [...ids].map(([id, name]) => ({ id, name, state: 'uploaded' })) };
    if (endpoint.includes('/git/ref/')) return { object: { type: 'commit', sha: selector.image.service_sha } };
    return { id: 1, run_attempt: 1, head_sha: manifest.producer.workflow_sha, head_branch: 'main', path: '.github/workflows/service-artifacts.yml',
      repository: { full_name: 'git-malu/AnyWear-Service', id: 1158460323, owner: { id: 11473072 } }, head_repository: { full_name: 'git-malu/AnyWear-Service', id: 1158460323 },
      event: 'workflow_dispatch', status: 'in_progress', conclusion: null };
  }, async asset(repo, id) { return readFile(path.join(fixtureDirectory, ids.get(id))); }, async attestation() { assert.fail('Early release must not reach attestation'); } };
  await assert.rejects(verifySelection(selector, await mkdtemp(path.join(os.tmpdir(), 'anywear-infra-download-')), io), /complete successfully/);
});
function nativeFixture() {
  const tag = `service-artifacts-${selector.image.service_sha}`; const purl = `pkg:github/git-malu/AnyWear-Service@${tag}`;
  const hashes = { 'service-artifacts.json': selector.release.manifest_sha256, ...Object.fromEntries([...Object.values(selector.lambdas), selector.runtime_policy, selector.schema].map(item => [item.file, item.sha256])) };
  const statement = { _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://in-toto.io/attestation/release/v0.1',
    predicate: { ownerId: '11473072', repositoryId: '1158460323', repository: 'git-malu/AnyWear-Service', releaseId: '1', purl, tag },
    subject: [{ uri: purl, digest: { sha1: selector.image.service_sha } }, ...Object.entries(hashes).map(([name, hash]) => ({ name, digest: { sha256: hash } }))] };
  return { verificationResult: { statement, signature: { certificate: { subjectAlternativeName: 'https://dotcom.releases.github.com' } } },
    attestation: { bundle: { dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64'), signatures: [{ sig: 'test-only' }] } } } };
}

test('authenticated release exact hashes and source are verified before asset use', async () => {
  const ids = new Map([[1, 'service-artifacts.json'], [2, 'pre-sign-up.zip'], [3, 'post-confirmation.zip'], [4, 'runtime-policy.json'], [5, 'service-schema.json']]);
  let attestations = 0;
  const io = { async api(endpoint) {
    if (endpoint.includes('/releases/')) return { id: 1, immutable: true, draft: false, tag_name: `service-artifacts-${selector.image.service_sha}`,
      assets: [...ids].map(([id, name]) => ({ id, name, state: 'uploaded' })) };
    if (endpoint.includes('/git/ref/')) return { object: { type: 'commit', sha: selector.image.service_sha } };
    return { id: 1, run_attempt: 1, head_sha: manifest.producer.workflow_sha, head_branch: 'main', path: '.github/workflows/service-artifacts.yml',
      repository: { full_name: 'git-malu/AnyWear-Service', id: 1158460323, owner: { id: 11473072 } }, head_repository: { full_name: 'git-malu/AnyWear-Service', id: 1158460323 },
      event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
  }, async asset(repo, id) { return readFile(path.join(fixtureDirectory, ids.get(id))); }, async attestation() { attestations++; return nativeFixture(); }, async loadPublicationAcceptance() { return {}; } };
  const result = await verifySelection(selector, await mkdtemp(path.join(os.tmpdir(), 'anywear-infra-download-')), io);
  assert.equal(result.schema.minimum_version, 16); assert.equal(attestations, 6);
  const bytes = await readFile(path.join(fixtureDirectory, 'pre-sign-up.zip'));
  await assert.rejects(verifySelection(selector, await mkdtemp(path.join(os.tmpdir(), 'anywear-infra-download-')),
    { ...io, async asset(repo, id) { return id === 2 ? Buffer.concat([bytes, Buffer.from('tamper')]) : io.asset(repo, id); } }), /Asset bytes differ/);
});
test('writer source/ref/window/expiry/operation/artifact and retention phase bind before credentials', () => {
  validateOperationInputs(env);
  for (const patch of [{ INFRA_WINDOW_SHA: '0'.repeat(40) }, { GITHUB_REF: 'refs/heads/branch' }, { INFRA_OPERATION: 'stop' },
    { WRITER_WINDOW_INPUT: 'other-54' }, { ENABLE_BETA_DEPLOY: 'false' }, { INFRA_WINDOW_EXPIRES_AT: '2000-01-01' },
    { INFRA_RETENTION_PROTECTION: 'true' }, { SELECTION_FILE: '../beta.json' }, { INFRA_WINDOW_SELECTION_SHA256: '0'.repeat(64) }]) assert.throws(() => validateOperationInputs({ ...env, ...patch }));
  assert.throws(() => assertWriterWindow({ token: 'window-54-1', operation: 'observe', env, now: Date.parse('2100-01-01') }));
});
test('deployment strict binding rejects legacy, undeclared artifact and template/code/schema drift', () => {
  const record = recordWithIds(); validateDeploymentRecord(record);
  const snapshot = { stacks: record.stacks, observed: record.observed, schema: record.schema }; assertObservedMatchesDeployment(record, snapshot);
  for (const mutate of [r => r.schema_version = 2, r => r.selection.components.image.extra = 1,
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
