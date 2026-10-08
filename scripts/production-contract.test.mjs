import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, contentHash, sha256 } from './json-contract.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { validateProductionContext, readReviewedSelection, assertTrustedQualificationMetadata, assertStableRelease,
  assertQualifiedSelection, verifyProductionRecord, resolveProductionInputs } from './production-preflight.mjs';
import { assertProductionExecutorReady, buildProductionPromotionPlan, verifyPromotionDigest, verifyPromotionScan } from './promote-production.mjs';

const execute = promisify(execFile);
const directory = await mkdtemp(path.join(os.tmpdir(), 'anywear-production-contract-'));
const { selector } = await createTestInputs(directory);
const selectorBytes = Buffer.from(canonicalJson(selector));
const now = Date.parse('2026-10-08T01:00:00Z');
const infraSha = '5'.repeat(40); const e2eSha = '6'.repeat(40);
const run = { id: 77, run_attempt: 2, head_sha: e2eSha, head_branch: 'main', path: '.github/workflows/beta-qualification.yml',
  repository: { full_name: 'git-malu/AnyWear-E2E' }, head_repository: { full_name: 'git-malu/AnyWear-E2E' },
  event: 'workflow_dispatch', status: 'completed', conclusion: 'success', run_started_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:30:00Z' };
const artifact = { id: 78, expired: false, name: 'beta-qualification-77-2', workflow_run: { id: 77, head_sha: e2eSha },
  created_at: '2026-10-08T00:20:00Z', expires_at: '2099-01-01T00:00:00Z' };
const stable = { id: 79, tag_name: 'v1.2.3', draft: false, prerelease: false, immutable: true };
const env = { ENABLE_PROD_DEPLOY: 'true', GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
  GITHUB_SHA: infraSha, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/production.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '123456789012', AWS_REGION: 'ap-east-1', PROD_DEPLOY_ROLE_ARN: 'arn:aws:iam::123456789012:role/prod-infra-deploy-role',
  QUALIFICATION_RUN_ID: '77', QUALIFICATION_RUN_ATTEMPT: '2', QUALIFICATION_ARTIFACT_ID: '78', QUALIFICATION_E2E_SHA: e2eSha,
  QUALIFICATION_RECORD_SHA256: '7'.repeat(64), STABLE_RELEASE_ID: '79', SELECTION_FILE: 'selections/prod.json', SELECTION_SHA256: sha256(selectorBytes) };

// This fixture exercises the consumer's additional cross-binding. E2E validates
// the entire v2 schema/integrity/observations through its pinned verifier API.
function qualificationFixture() {
  return { schema_version: 2, record_type: 'anywear_beta_qualification',
    revisions: { infra: { repository: 'git-malu/AnyWear-Infra', sha: infraSha },
      service: { repository: 'git-malu/AnyWear-Service', sha: selector.image.service_sha, image_digest: selector.image.digest } },
    service_artifacts: { repository: selector.release.repository, release_id: selector.release.id,
      manifest_asset_id: selector.release.manifest_asset_id, manifest_sha256: selector.release.manifest_sha256 },
    deployment: { record: { infra: { sha: infraSha }, selection: { file: env.SELECTION_FILE, sha256: env.SELECTION_SHA256, release: selector.release,
      components: { image: selector.image, lambdas: selector.lambdas, runtime_policy: selector.runtime_policy, schema: selector.schema } } } } };
}

test('future Production context binds protected source, account, IDs and explicit selection', () => {
  validateProductionContext(env, now);
  for (const patch of [{ ENABLE_PROD_DEPLOY: 'false' }, { GITHUB_REPOSITORY_ID: '1' }, { GITHUB_REF: 'refs/heads/branch' },
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace('production', 'runtime') },
    { PROD_DEPLOY_ROLE_ARN: 'arn:aws:iam::123456789012:role/prod-github-actions-pipeline-role' },
    { QUALIFICATION_RUN_ATTEMPT: '9007199254740992' }, { SELECTION_FILE: '../selection.json' }]) {
    assert.throws(() => validateProductionContext({ ...env, ...patch }, now));
  }
});

test('reviewed selector requires complete strict canonical exact bytes', () => {
  assert.deepEqual(readReviewedSelection(selectorBytes, env), selector);
  const whitespace = Buffer.concat([selectorBytes, Buffer.from('\n')]);
  assert.throws(() => readReviewedSelection(whitespace, { ...env, SELECTION_SHA256: sha256(whitespace) }), /canonical bytes/);
  const duplicate = Buffer.from(selectorBytes.toString().replace('"schema_version":2', '"schema_version":2,"schema_version":2'));
  assert.throws(() => readReviewedSelection(duplicate, { ...env, SELECTION_SHA256: sha256(duplicate) }), /Duplicate/);
});

test('trusted qualification rejects rerun mixing, incomplete jobs, old artifact attempts and expiration', () => {
  assertTrustedQualificationMetadata(run, artifact, env, now);
  for (const patch of [{ run_attempt: 1 }, { head_sha: '8'.repeat(40) }, { head_branch: 'pr' }, { status: 'in_progress' },
    { conclusion: 'failure' }, { head_repository: { full_name: 'other/fork' } }]) {
    assert.throws(() => assertTrustedQualificationMetadata({ ...run, ...patch }, artifact, env, now));
  }
  for (const patch of [{ id: 80 }, { expired: true }, { expires_at: 'invalid' }, { expires_at: '2026-10-08T01:00:00Z' },
    { name: 'beta-qualification-77-1' }, { created_at: '2026-10-07T23:59:00Z' }, { created_at: '2026-10-08T00:31:00Z' },
    { workflow_run: { id: 77, head_sha: '8'.repeat(40) } }]) {
    assert.throws(() => assertTrustedQualificationMetadata(run, { ...artifact, ...patch }, env, now));
  }
});

test('stable release cannot be an artifact prerelease, moved tag, unsealed release or off-main source', () => {
  const commit = { type: 'commit', sha: selector.image.service_sha };
  const main = { status: 'ahead', merge_base_commit: { sha: selector.image.service_sha } };
  assertStableRelease(stable, commit, main, selector, env);
  for (const patch of [{ immutable: false }, { prerelease: true }, { draft: true }, { id: 80 },
    { tag_name: `service-artifacts-${selector.image.service_sha}` }, { tag_name: 'v01.2.3' }]) {
    assert.throws(() => assertStableRelease({ ...stable, ...patch }, commit, main, selector, env));
  }
  assert.throws(() => assertStableRelease(stable, { ...commit, sha: infraSha }, main, selector, env));
  assert.throws(() => assertStableRelease(stable, commit, { ...main, merge_base_commit: { sha: infraSha } }, selector, env));
  assert.throws(() => assertStableRelease(stable, commit, { ...main, status: 'diverged' }, selector, env));
});

test('authenticated input resolver verifies sealed selection and annotated stable tag then keeps metadata outside download directory', async () => {
  const calls = []; const saved = new Map();
  const io = { async api(endpoint) {
    calls.push(endpoint);
    if (endpoint.includes('/actions/runs/')) return run;
    if (endpoint.includes('/actions/artifacts/')) return artifact;
    if (endpoint.includes('/releases/')) return stable;
    if (endpoint.includes('/git/ref/')) return { object: { type: 'tag', sha: '8'.repeat(40) } };
    if (endpoint.includes('/git/tags/')) return { object: { type: 'commit', sha: selector.image.service_sha } };
    if (endpoint.includes('/compare/')) return { status: 'identical', merge_base_commit: { sha: selector.image.service_sha } };
    assert.fail('Unexpected GitHub endpoint');
  }, async loadCommittedSelection(actual) { assert.equal(actual.selectionFile, env.SELECTION_FILE); assert.equal(actual.expectedInfraSha, infraSha); return selector; },
  async verifySelection(actual) { assert.equal(actual.selectionSha256, env.SELECTION_SHA256); assert.equal(actual.selectionFile, env.SELECTION_FILE); calls.push('sealed-selection'); },
  async verifyStableRelease(tag) { assert.equal(tag, stable.tag_name); calls.push('stable-attestation'); },
  async mkdir() {}, async writeFile(file, value) { saved.set(file, value); } };
  await resolveProductionInputs(env, io);
  assert.equal(calls[0], 'sealed-selection'); assert.ok(calls.includes('stable-attestation'));
  assert.deepEqual([...saved.keys()], ['.qualification/trusted/run.json', '.qualification/trusted/artifact.json', '.qualification/trusted/stable-release.json']);
  assert.ok(calls.includes('repos/git-malu/AnyWear-E2E/actions/runs/77/attempts/2'));
  await assert.rejects(resolveProductionInputs(env, { ...io, async api(endpoint) {
    return endpoint.includes('/releases/') ? { ...stable, prerelease: true } : io.api(endpoint);
  } }), /sealed stable/);
});

test('qualification v2 binds every component source/hash/asset ID and complete selector, not only image and manifest', () => {
  assert.equal(assertQualifiedSelection(qualificationFixture(), selector, env), selector.image.digest);
  for (const mutate of [r => r.schema_version = 1, r => r.payload = {}, r => r.revisions.infra.sha = e2eSha,
    r => r.revisions.service.image_digest = `sha256:${'9'.repeat(64)}`, r => r.service_artifacts.release_id++,
    r => r.deployment.record.selection.sha256 = '9'.repeat(64), r => r.deployment.record.selection.release.manifest_asset_id++,
    r => r.deployment.record.selection.components.lambdas.pre_sign_up.asset_id++,
    r => r.deployment.record.selection.components.lambdas.post_confirmation.sha256 = '9'.repeat(64),
    r => r.deployment.record.selection.components.runtime_policy.content_sha256 = '9'.repeat(64),
    r => r.deployment.record.selection.components.schema.journal_sha256 = '9'.repeat(64),
    r => r.deployment.record.selection.components.image.service_sha = infraSha]) {
    const value = structuredClone(qualificationFixture()); mutate(value);
    assert.throws(() => assertQualifiedSelection(value, selector, env));
  }
});

test('consumer invokes fixed verifier with authenticated run/attempt/artifact/exact bytes and rejects missing affirmative verification', async () => {
  const record = qualificationFixture(); const recordBytes = Buffer.from(canonicalJson(record));
  const actualEnv = { ...env, QUALIFICATION_RECORD_SHA256: sha256(recordBytes) }; let calls = 0;
  const verifier = (actual, options) => {
    calls++; assert.deepEqual(actual, record); assert.equal(options.recordBytes, recordBytes);
    assert.equal(options.trustedRun, run); assert.equal(options.trustedArtifact, artifact);
    assert.deepEqual(options.expected, { run_id: 77, run_attempt: 2, artifact_id: 78, record_sha256: sha256(recordBytes), e2e_sha: e2eSha });
    return true;
  };
  const input = { recordBytes, selectorBytes, run, artifact, verifier, env: actualEnv, now };
  await verifyProductionRecord(input); assert.equal(calls, 1);
  await assert.rejects(verifyProductionRecord({ ...input, recordBytes: Buffer.concat([recordBytes, Buffer.from('\n')]) }), /exact-byte/);
  assert.equal(calls, 1);
  await assert.rejects(verifyProductionRecord({ ...input, verifier: () => false }), /affirm acceptance/);
  await assert.rejects(verifyProductionRecord({ ...input, verifier: () => { throw new Error('E2E observations mismatch'); } }), /observations mismatch/);
  await assert.rejects(verifyProductionRecord({ ...input, verifier: undefined }), /unavailable/);
});

test('future plan preserves all OCI manifests, digest identity, explicit schema operation and compute-only rollback without being executable', () => {
  const plan = buildProductionPromotionPlan({ selector, qualification: qualificationFixture(), stableRelease: stable, env });
  assert.equal(plan.executable, false); assert.equal(plan.image.digest, selector.image.digest);
  assert.deepEqual(plan.copy.args.slice(0, 3), ['copy', '--all', '--preserve-digests']);
  assert.equal(plan.copy.args[3], `docker://${selector.image.repository_uri}@${selector.image.digest}`);
  assert.match(plan.copy.args[4], /^docker:\/\/123456789012\.dkr\.ecr\.ap-east-1\.amazonaws\.com\/prod-anywear-service:/);
  assert.match(plan.schema.migration, /separate explicit reviewed forward migration/);
  assert.match(plan.schema.rollback, /Workload image only/);
  assert.equal(verifyPromotionDigest(selector.image.digest, selector.image.digest), true);
  assert.throws(() => verifyPromotionDigest(`sha256:${'8'.repeat(64)}`, selector.image.digest), /differs/);
});

test('scan guard binds repository+digest, completes after copy, blocks critical and requires exact high approval', () => {
  const uri = '123456789012.dkr.ecr.ap-east-1.amazonaws.com/prod-anywear-service';
  const scan = { registryId: '123456789012', repositoryName: 'prod-anywear-service', imageId: { imageDigest: selector.image.digest },
    imageScanStatus: { status: 'COMPLETE' }, imageScanFindings: { imageScanCompletedAt: '2026-10-08T00:45:00Z',
      vulnerabilitySourceUpdatedAt: '2026-10-08T00:40:00Z', findingSeverityCounts: { HIGH: 0, CRITICAL: 0, MEDIUM: 2 } } };
  const options = { expectedDigest: selector.image.digest, expectedRepositoryUri: uri, notBefore: Date.parse('2026-10-08T00:35:00Z'), env, now };
  verifyPromotionScan(scan, options);
  for (const mutate of [s => s.registryId = '650880818323', s => s.imageId.imageDigest = `sha256:${'8'.repeat(64)}`,
    s => s.imageScanStatus.status = 'IN_PROGRESS', s => s.imageScanFindings.imageScanCompletedAt = '2026-10-08T00:30:00Z',
    s => s.imageScanFindings.findingSeverityCounts.CRITICAL = 1, s => s.imageScanFindings.findingSeverityCounts.UNDEFINED = 1,
    s => s.imageScanFindings.findingSeverityCounts.HIGH = -1, s => s.imageScanFindings.findingSeverityCounts.OTHER = 1]) {
    const value = structuredClone(scan); mutate(value); assert.throws(() => verifyPromotionScan(value, options));
  }
  const high = structuredClone(scan); high.imageScanFindings.findingSeverityCounts.HIGH = 1;
  assert.throws(() => verifyPromotionScan(high, options));
  const approval = { repository_uri: uri, image_digest: selector.image.digest, scan_sha256: contentHash(high), finding_counts: high.imageScanFindings.findingSeverityCounts,
    infra_sha: infraSha };
  const approved = { ...options, highApproval: approval, env: { ...env, PROD_SCAN_APPROVAL_SHA256: contentHash(approval) } };
  verifyPromotionScan(high, approved);
  assert.throws(() => verifyPromotionScan(high, { ...approved, highApproval: { ...approval, infra_sha: '8'.repeat(40) } }));
});

test('Production remains source-disabled before AWS credentials even when activation/readiness variables are enabled', async () => {
  assert.throws(() => assertProductionExecutorReady(), /Production execution remains disabled/);
  await assert.rejects(execute(process.execPath, ['scripts/promote-production.mjs'], {
    env: { ...process.env, ...env, PROD_PROMOTION_READY: 'true' }, timeout: 10_000,
  }), error => error.code === 1 && /Production execution remains disabled/.test(error.stderr));
  const workflow = await readFile(new URL('../.github/workflows/production.yml', import.meta.url), 'utf8');
  assert.ok(workflow.indexOf('run: node scripts/promote-production.mjs') < workflow.indexOf('actions/create-github-app-token'));
  assert.equal(/configure-aws-credentials|id-token:\s*write/.test(workflow), false);
});
