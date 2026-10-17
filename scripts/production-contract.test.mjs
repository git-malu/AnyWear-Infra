import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { canonicalJson, contentHash, sha256 } from './json-contract.mjs';
import { configuredStacks } from './operation-stacks.mjs';
import { stageContractSchemaHash } from './deployment-contract.mjs';
import { validateProductionContext, readReviewedRelease, assertTrustedQualificationMetadata, assertStableRelease,
  assertQualifiedRelease, verifyProductionRecord, resolveProductionInputs } from './production-preflight.mjs';
import { assertProductionExecutorReady, buildProductionPromotionPlan, verifyPromotionDigest, verifyPromotionScan } from './promote-production.mjs';

const execute = promisify(execFile);
const now = Date.parse('2026-10-08T01:00:00Z');
const infraSha = '5'.repeat(40); const e2eSha = '6'.repeat(40); const serviceSha = '1'.repeat(40);
const imageDigest = `sha256:${'4'.repeat(64)}`;
const run = { id: 77, run_attempt: 2, head_sha: e2eSha, head_branch: 'main', path: '.github/workflows/beta-qualification.yml',
  repository: { full_name: 'git-malu/AnyWear-E2E' }, head_repository: { full_name: 'git-malu/AnyWear-E2E' },
  event: 'workflow_dispatch', status: 'completed', conclusion: 'success', run_started_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:30:00Z' };
const artifact = { id: 78, expired: false, name: 'beta-qualification-77-2', workflow_run: { id: 77, head_sha: e2eSha },
  created_at: '2026-10-08T00:20:00Z', expires_at: '2099-01-01T00:00:00Z' };
const stable = { id: 79, tag_name: 'v1.2.3', draft: false, prerelease: false, immutable: true };
const env = { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
  GITHUB_SHA: infraSha, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/production.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '123456789012', AWS_REGION: 'ap-east-1', PROD_DEPLOY_ROLE_ARN: 'arn:aws:iam::123456789012:role/prod-infra-deploy-role',
  QUALIFICATION_RUN_ID: '77', QUALIFICATION_RUN_ATTEMPT: '2', QUALIFICATION_ARTIFACT_ID: '78', QUALIFICATION_E2E_SHA: e2eSha,
  QUALIFICATION_RECORD_SHA256: '7'.repeat(64), STABLE_RELEASE_ID: '79', SERVICE_RELEASE_ID: '76',
  SERVICE_SOURCE_SHA: serviceSha, SERVICE_IMAGE_DIGEST: imageDigest };
const release = () => readReviewedRelease(env);

// The deployment record the qualification embeds is a v3 Infra record: producer
// identity, the configured stack set, the consumed stage-contract inputs, the
// observation and the derived schema hash. There is no selection.
function deploymentRecord() {
  const inputs = [{ parameter: '/anywear/beta/vpc_id', version: '2', value_sha256: 'd'.repeat(64) }];
  return { schema_version: 3, record_type: 'anywear_infra_deployment',
    producer: { repository: 'git-malu/AnyWear-Infra', sha: infraSha, workflow_path: '.github/workflows/runtime.yml',
      workflow_ref: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main', run_id: 41, run_attempt: 1 },
    stacks: configuredStacks.map(stack => ({ name: stack.stack_name, region: stack.region,
      producer_repository: 'git-malu/AnyWear-Infra', producer_sha: infraSha, template_sha256: 'f'.repeat(64) })),
    inputs,
    observed: { lambdas: {
      'pre-sign-up': { code_sha256: `${'A'.repeat(43)}=`, configuration_sha256: '1'.repeat(64) },
      'post-confirmation': { code_sha256: `${'B'.repeat(43)}=`, configuration_sha256: '2'.repeat(64) } },
    queue_config_sha256: '3'.repeat(64), client_sha: '4'.repeat(40), endpoints: { client: 'https://d111111abcdef8.cloudfront.net' } },
    schema: { content_sha256: stageContractSchemaHash(inputs) } };
}

// This fixture exercises the consumer's additional cross-binding. E2E validates
// the entire v2 schema/integrity/observations through its pinned verifier API.
function qualificationFixture() {
  const record = deploymentRecord();
  return { schema_version: 2, record_type: 'anywear_beta_qualification',
    revisions: { infra: { repository: 'git-malu/AnyWear-Infra', sha: infraSha },
      service: { repository: 'git-malu/AnyWear-Service', sha: serviceSha, image_digest: imageDigest } },
    service_artifacts: { repository: 'git-malu/AnyWear-Service', release_id: 76,
      manifest_asset_id: 1, manifest_sha256: 'e'.repeat(64) },
    deployment: { record } };
}

test('future Production context binds protected source, account, IDs and the reviewed release identity', () => {
  validateProductionContext(env);
  assert.deepEqual(release(), { release_id: 76, source_sha: serviceSha, image_digest: imageDigest });
  for (const patch of [{ GITHUB_REPOSITORY_ID: '1' }, { GITHUB_REF: 'refs/heads/branch' },
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace('production', 'runtime') },
    { PROD_DEPLOY_ROLE_ARN: 'arn:aws:iam::123456789012:role/prod-github-actions-pipeline-role' },
    { QUALIFICATION_RUN_ATTEMPT: '9007199254740992' },
    { SERVICE_SOURCE_SHA: 'not-a-sha' }, { SERVICE_IMAGE_DIGEST: 'sha256:short' }, { SERVICE_RELEASE_ID: '0' }]) {
    assert.throws(() => validateProductionContext({ ...env, ...patch }));
  }
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
  const commit = { type: 'commit', sha: serviceSha };
  const main = { status: 'ahead', merge_base_commit: { sha: serviceSha } };
  assertStableRelease(stable, commit, main, release(), env);
  for (const patch of [{ immutable: false }, { prerelease: true }, { draft: true }, { id: 80 },
    { tag_name: `service-artifacts-${serviceSha}` }, { tag_name: 'v01.2.3' }]) {
    assert.throws(() => assertStableRelease({ ...stable, ...patch }, commit, main, release(), env));
  }
  assert.throws(() => assertStableRelease(stable, { ...commit, sha: infraSha }, main, release(), env));
  assert.throws(() => assertStableRelease(stable, commit, { ...main, merge_base_commit: { sha: infraSha } }, release(), env));
  assert.throws(() => assertStableRelease(stable, commit, { ...main, status: 'diverged' }, release(), env));
});

test('authenticated input resolver keeps metadata outside the download directory and rejects an unsealed release', async () => {
  const calls = []; const saved = new Map();
  const io = { async api(endpoint) {
    calls.push(endpoint);
    if (endpoint.includes('/actions/runs/')) return run;
    if (endpoint.includes('/actions/artifacts/')) return artifact;
    if (endpoint.includes('/releases/')) return stable;
    if (endpoint.includes('/git/ref/')) return { object: { type: 'tag', sha: '8'.repeat(40) } };
    if (endpoint.includes('/git/tags/')) return { object: { type: 'commit', sha: serviceSha } };
    if (endpoint.includes('/compare/')) return { status: 'identical', merge_base_commit: { sha: serviceSha } };
    assert.fail('Unexpected GitHub endpoint');
  }, async mkdir() {}, async writeFile(file, value) { saved.set(file, value); } };
  await resolveProductionInputs(env, io);
  assert.deepEqual([...saved.keys()], ['.qualification/trusted/run.json', '.qualification/trusted/artifact.json', '.qualification/trusted/stable-release.json']);
  assert.ok(calls.includes('repos/git-malu/AnyWear-E2E/actions/runs/77/attempts/2'));
  await assert.rejects(resolveProductionInputs(env, { ...io, async api(endpoint) {
    return endpoint.includes('/releases/') ? { ...stable, prerelease: true } : io.api(endpoint);
  } }), /sealed stable/);
});

test('qualification v2 binds the reviewed release identity and a valid v3 deployment record', () => {
  assert.equal(assertQualifiedRelease(qualificationFixture(), release(), env), imageDigest);
  for (const mutate of [r => r.schema_version = 1, r => r.payload = {}, r => r.revisions.infra.sha = e2eSha,
    r => r.revisions.service.sha = '9'.repeat(40), r => r.revisions.service.image_digest = `sha256:${'9'.repeat(64)}`,
    r => r.service_artifacts.release_id = 75, r => r.deployment.record.producer.sha = e2eSha,
    r => delete r.deployment.record.schema]) {
    const value = structuredClone(qualificationFixture()); mutate(value);
    assert.throws(() => assertQualifiedRelease(value, release(), env));
  }
});

test('consumer invokes the fixed verifier with authenticated run/attempt/artifact/exact bytes and requires affirmative verification', async () => {
  const record = qualificationFixture(); const recordBytes = Buffer.from(canonicalJson(record));
  const actualEnv = { ...env, QUALIFICATION_RECORD_SHA256: sha256(recordBytes) }; let calls = 0;
  const verifier = (actual, options) => {
    calls++; assert.deepEqual(actual, record); assert.equal(options.recordBytes, recordBytes);
    assert.equal(options.trustedRun, run); assert.equal(options.trustedArtifact, artifact);
    assert.deepEqual(options.expected, { run_id: 77, run_attempt: 2, artifact_id: 78, record_sha256: sha256(recordBytes), e2e_sha: e2eSha });
    return true;
  };
  const input = { recordBytes, run, artifact, verifier, env: actualEnv, now };
  await verifyProductionRecord(input); assert.equal(calls, 1);
  await assert.rejects(verifyProductionRecord({ ...input, recordBytes: Buffer.concat([recordBytes, Buffer.from('\n')]) }), /exact-byte/);
  assert.equal(calls, 1);
  await assert.rejects(verifyProductionRecord({ ...input, verifier: () => false }), /affirm acceptance/);
  await assert.rejects(verifyProductionRecord({ ...input, verifier: () => { throw new Error('E2E observations mismatch'); } }), /observations mismatch/);
  await assert.rejects(verifyProductionRecord({ ...input, verifier: undefined }), /unavailable/);
});

test('future plan preserves all OCI manifests, digest identity, explicit schema operation and compute-only rollback without being executable', () => {
  const plan = buildProductionPromotionPlan({ release: release(), qualification: qualificationFixture(), stableRelease: stable, env });
  assert.equal(plan.executable, false); assert.equal(plan.image.digest, imageDigest);
  assert.deepEqual(plan.copy.args.slice(0, 3), ['copy', '--all', '--preserve-digests']);
  assert.equal(plan.copy.args[3], `docker://650880818323.dkr.ecr.ap-east-1.amazonaws.com/beta-anywear-service@${imageDigest}`);
  assert.match(plan.copy.args[4], /^docker:\/\/123456789012\.dkr\.ecr\.ap-east-1\.amazonaws\.com\/prod-anywear-service:/);
  assert.match(plan.schema.migration, /separate explicit reviewed forward migration/);
  assert.match(plan.schema.rollback, /Workload image only/);
  assert.equal(plan.service_sha, serviceSha);
  assert.equal(verifyPromotionDigest(imageDigest, imageDigest), true);
  assert.throws(() => verifyPromotionDigest(`sha256:${'8'.repeat(64)}`, imageDigest), /differs/);
});

test('scan guard binds repository+digest, completes after copy, blocks critical and requires exact high approval', () => {
  const uri = '123456789012.dkr.ecr.ap-east-1.amazonaws.com/prod-anywear-service';
  const scan = { registryId: '123456789012', repositoryName: 'prod-anywear-service', imageId: { imageDigest },
    imageScanStatus: { status: 'COMPLETE' }, imageScanFindings: { imageScanCompletedAt: '2026-10-08T00:45:00Z',
      vulnerabilitySourceUpdatedAt: '2026-10-08T00:40:00Z', findingSeverityCounts: { HIGH: 0, CRITICAL: 0, MEDIUM: 2 } } };
  const options = { expectedDigest: imageDigest, expectedRepositoryUri: uri, notBefore: Date.parse('2026-10-08T00:35:00Z'), env, now };
  verifyPromotionScan(scan, options);
  for (const mutate of [s => s.registryId = '650880818323', s => s.imageId.imageDigest = `sha256:${'8'.repeat(64)}`,
    s => s.imageScanStatus.status = 'IN_PROGRESS', s => s.imageScanFindings.imageScanCompletedAt = '2026-10-08T00:30:00Z',
    s => s.imageScanFindings.findingSeverityCounts.CRITICAL = 1, s => s.imageScanFindings.findingSeverityCounts.UNDEFINED = 1,
    s => s.imageScanFindings.findingSeverityCounts.HIGH = -1, s => s.imageScanFindings.findingSeverityCounts.OTHER = 1]) {
    const value = structuredClone(scan); mutate(value); assert.throws(() => verifyPromotionScan(value, options));
  }
  const high = structuredClone(scan); high.imageScanFindings.findingSeverityCounts.HIGH = 1;
  assert.throws(() => verifyPromotionScan(high, options));
  const approval = { repository_uri: uri, image_digest: imageDigest, scan_sha256: contentHash(high), finding_counts: high.imageScanFindings.findingSeverityCounts,
    infra_sha: infraSha };
  const approved = { ...options, highApproval: approval, env: { ...env, PROD_SCAN_APPROVAL_SHA256: contentHash(approval) } };
  verifyPromotionScan(high, approved);
  assert.throws(() => verifyPromotionScan(high, { ...approved, highApproval: { ...approval, infra_sha: '8'.repeat(40) } }));
});

test('Production remains source-disabled before AWS credentials even when readiness variables are enabled', async () => {
  assert.throws(() => assertProductionExecutorReady(), /Production execution remains disabled/);
  await assert.rejects(execute(process.execPath, ['scripts/promote-production.mjs'], {
    env: { ...process.env, ...env, PROD_PROMOTION_READY: 'true' }, timeout: 10_000,
  }), error => error.code === 1 && /Production execution remains disabled/.test(error.stderr));
  const workflow = await readFile(new URL('../.github/workflows/production.yml', import.meta.url), 'utf8');
  assert.ok(workflow.indexOf('run: node scripts/promote-production.mjs') < workflow.indexOf('actions/create-github-app-token'));
  assert.equal(/configure-aws-credentials|id-token:\s*write/.test(workflow), false);
  const job = workflow.slice(workflow.indexOf('  promotion:'));
  const condition = job.match(/^\s*if: (.*)$/m);
  assert.ok(condition, 'Production job keeps an explicit source condition');
  assert.equal(/\bvars\./.test(condition[1]), false, 'No repository variable may gate the Production job');
  assert.equal(/^\s*environment:/m.test(job), false, 'An unregistered protected environment must not be materialised');
  const steps = [...job.matchAll(/^\s*run: (.+)$/gm)].map((match) => match[1].trim());
  assert.equal(steps[0], 'node scripts/promote-production.mjs', 'The source blocker stays the first executed step');
});
