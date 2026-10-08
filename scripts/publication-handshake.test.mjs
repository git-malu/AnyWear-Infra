import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256, contentHash, parseJson } from './json-contract.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { RELEASE_PREDICATE_TYPE, assertNativeReleaseAttestation } from './vendor/service-release-attestation.mjs';
import { validateRequest, validateContext, commandEnvironment, assertCheckout, initialStatus, runHandshake, liveReaderIo,
  APP_ID, INSTALLATION_ID, ASSET_NAMES, EVIDENCE_FILES } from './publication-handshake.mjs';

const execute = promisify(execFile);
const timestamp = '2026-10-08T01:00:00Z';
const prefix = 'repos/git-malu/AnyWear-Service';
const repo = { id: 1158460323, full_name: 'git-malu/AnyWear-Service', private: true, owner: { id: 11473072, login: 'git-malu' } };
const temporary = async name => mkdtemp(path.join(os.tmpdir(), `anywear-handshake-${name}-`));
function zip(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  crc = (crc ^ 0xffffffff) >>> 0;
  const name = Buffer.from('service-artifact-publication.json'); const local = Buffer.alloc(30); const central = Buffer.alloc(46); const end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + bytes.length, 16);
  return Buffer.concat([local, name, bytes, central, name, end]);
}
function original(component) {
  const result = { repository: repo.full_name, source_sha: component.service_sha,
    workflow_ref: `${repo.full_name}/.github/workflows/pipeline.yml@refs/heads/main`, run_id: 20, run_attempt: 1, job_id: 30,
    run_conclusion: 'failure', job_conclusion: 'success', artifact_phase: { name: 'original-build', conclusion: 'success', log_sha256: '5'.repeat(64),
      start_line: 1, end_line: 2, log_excerpt: 'Original independently observed component build fixture' } };
  if (component.code_sha256) result.deployed = { repository: repo.full_name, source_sha: '6'.repeat(40),
    workflow_ref: `${repo.full_name}/.github/workflows/pipeline.yml@refs/heads/main`, run_id: 21, run_attempt: 1, job_id: 31,
    run_conclusion: 'failure', job_conclusion: 'success', stack_name: 'AnyWearPlatformStack-beta', template_sha256: '7'.repeat(64),
    asset_bucket: 'fixture-original-assets', asset_key: `${'8'.repeat(64)}.zip`, code_sha256: component.code_sha256 };
  return result;
}
async function publicationFixture() {
  const source = await temporary('fixture'); const { manifest } = await createTestInputs(source);
  manifest.kind = 'deployed-baseline-import'; manifest.producer.workflow_sha = '2'.repeat(40); manifest.producer.run_id = 91; manifest.producer.run_attempt = 2;
  for (const component of [manifest.components.image, ...Object.values(manifest.components.lambdas), manifest.components.runtime_policy, manifest.components.schema]) {
    component.original_evidence = original(component);
  }
  await writeFile(path.join(source, 'service-artifacts.json'), canonicalJson(manifest));
  const bytes = Object.fromEntries(await Promise.all(ASSET_NAMES.map(async name => [name, await readFile(path.join(source, name))])));
  const assets = ASSET_NAMES.map((name, index) => ({ id: 301 + index, name, size: bytes[name].length, sha256: sha256(bytes[name]) }));
  const request = { schema_version: 1, record_type: 'anywear_publication_handshake_request',
    app: { app_id: APP_ID, installation_id: INSTALLATION_ID, permissions_requested: { contents: 'read', actions: 'read', attestations: 'read' } },
    producer: { repository: repo.full_name, workflow_sha: manifest.producer.workflow_sha, run_id: 91, run_attempt: 2 },
    release: { id: 73, manifest_asset_id: 301, manifest_sha256: assets[0].sha256, tag: `service-baseline-${assets[0].sha256}`, target: manifest.producer.workflow_sha },
    kind: manifest.kind, assets };
  const release = { id: 73, immutable: true, draft: false, tag_name: request.release.tag,
    assets: assets.map(asset => ({ ...asset, state: 'uploaded', digest: `sha256:${asset.sha256}` })) };
  const producer = { id: 91, run_attempt: 2, head_sha: manifest.producer.workflow_sha, head_branch: 'main', path: '.github/workflows/service-artifacts.yml',
    event: 'workflow_dispatch', status: 'completed', conclusion: 'success', run_started_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:30:00Z',
    repository: structuredClone(repo), head_repository: structuredClone(repo) };
  const purl = `pkg:github/${repo.full_name}@${release.tag_name}`;
  const statement = { _type: 'https://in-toto.io/Statement/v1', predicateType: RELEASE_PREDICATE_TYPE,
    predicate: { ownerId: '11473072', repositoryId: '1158460323', repository: repo.full_name, releaseId: '73', purl, tag: release.tag_name },
    subject: [{ uri: purl, digest: { sha1: request.release.target } }, ...assets.map(asset => ({ name: asset.name, digest: { sha256: asset.sha256 } }))] };
  // Synthetic post-gh results exercise parser/binding. No crypto or live read is claimed.
  const native = { verificationResult: { statement, signature: { certificate: { subjectAlternativeName: 'https://dotcom.releases.github.com' } } },
    attestation: { bundle: { dsseEnvelope: { payload: Buffer.from(canonicalJson(statement)).toString('base64'), payloadType: 'application/vnd.in-toto+json', signatures: [{ sig: 'test-only' }] } } } };
  const record = { schema_version: 1, record_type: 'anywear_service_artifact_publication', repository: repo.full_name, release_id: 73,
    manifest_asset_id: 301, manifest_sha256: request.release.manifest_sha256, tag: release.tag_name, target: request.release.target, producer: manifest.producer,
    assets: Object.fromEntries(assets.map(({ id, name, size, sha256: hash }) => [name, { id, size, sha256: hash }])), release_attestation: native,
    native_release_statement_sha256: contentHash(statement) };
  const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`); const archive = zip(recordBytes);
  const artifact = { id: 801, name: 'service-artifact-publication-91-2', expired: false, created_at: '2026-10-08T00:20:00Z', expires_at: '2099-01-01T00:00:00Z',
    size_in_bytes: archive.length, digest: `sha256:${sha256(archive)}`, workflow_run: { id: 91, head_sha: producer.head_sha } };
  return { request, release, producer, manifest, native, recordBytes, archive, artifact, bytes };
}
const fixture = await publicationFixture();
function environment(request = fixture.request) {
  const source = 'a'.repeat(40);
  return { HANDSHAKE_REQUEST_JSON: canonicalJson(request), HANDSHAKE_SOURCE_SHA: source, GITHUB_SHA: source, GITHUB_WORKFLOW_SHA: source,
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265', GITHUB_REPOSITORY_OWNER_ID: '11473072',
    GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/publication-handshake.yml@refs/heads/main',
    GITHUB_ACTOR: 'git-malu', GITHUB_TRIGGERING_ACTOR: 'git-malu', GITHUB_RUN_ID: '200', GITHUB_RUN_ATTEMPT: '1', ENABLE_PUBLICATION_HANDSHAKE: 'true',
    PUBLICATION_HANDSHAKE_SOURCE_SHA: source, PUBLICATION_HANDSHAKE_ACTOR: 'git-malu', HANDSHAKE_WINDOW_TOKEN: 'manager_reader_fixture_01',
    PUBLICATION_HANDSHAKE_WINDOW_TOKEN: 'manager_reader_fixture_01', PUBLICATION_HANDSHAKE_EXPIRES_AT: '2026-10-08T02:00:00Z',
    PUBLICATION_HANDSHAKE_RECORD_URL: 'https://github.com/git-malu/AnyWear/issues/54#issuecomment-6055545064',
    PUBLICATION_HANDSHAKE_REQUEST_SHA256: sha256(canonicalJson(request)) };
}
async function attempt({ patch = () => {}, check = async () => {}, installationId = String(INSTALLATION_ID), tokenMintOutcome = 'success' } = {}) {
  const current = structuredClone(fixture); patch(current);
  const root = await temporary('attempt'); const evidenceDirectory = path.join(root, 'evidence'); await mkdir(evidenceDirectory);
  const calls = []; let runReads = 0; let nativeReads = 0;
  const io = {
    async api(endpoint) {
      calls.push(endpoint);
      if (endpoint === 'installation/repositories?per_page=100') return current.scope ?? { total_count: 1, repositories: [repo] };
      if (endpoint === prefix) return current.repository ?? repo;
      if (endpoint === `${prefix}/actions/runs/91/attempts/2`) return ++runReads >= (current.driftAfter ?? Infinity) ? { ...current.producer, conclusion: 'failure' } : current.producer;
      if (endpoint === `${prefix}/releases/73`) return current.release;
      if (endpoint === `${prefix}/git/ref/tags/${current.request.release.tag}`) return current.ref ?? { object: { type: 'commit', sha: current.request.release.target } };
      if (endpoint === `${prefix}/actions/runs/91/artifacts?per_page=100&page=1`) return current.artifactInventory ?? { total_count: 1, artifacts: [current.artifact] };
      assert.fail(`Unexpected endpoint ${endpoint}`);
    },
    async asset(repository, id) { calls.push(`asset:${id}`); assert.equal(repository, repo.full_name); return current.bytes[current.request.assets.find(asset => asset.id === id).name]; },
    async attestation(tag, file) {
      calls.push(file ? `native:${path.basename(file)}` : 'native:release'); assert.equal(tag, current.request.release.tag); nativeReads++;
      if (nativeReads === current.nativeFailAt) throw new Error('Simulated raw stderr with PRIVATE_TOKEN that must never be retained');
      return Buffer.from(current.nativeRaw ?? canonicalJson(nativeReads === current.nativeDriftAt ? current.differentNative : current.native));
    },
    async publicationArchive(id) { calls.push(`archive:${id}`); assert.equal(id, current.artifact.id); return current.archive; },
  };
  const status = initialStatus(environment(current.request)); await writeFile(path.join(evidenceDirectory, 'status.json'), canonicalJson(status));
  const options = { request: validateRequest(canonicalJson(current.request)), evidenceDirectory, assetsDirectory: path.join(root, 'assets'),
    status, installationId, tokenMintOutcome, io, contextCheck: check, now: () => timestamp };
  return { current, calls, status, root, evidenceDirectory, options, perform: () => runHandshake(options) };
}

test('strict request accepts the full final baseline identity and canonical hash independent of formatting', () => {
  assert.deepEqual(validateRequest(JSON.stringify(fixture.request, null, 2)), fixture.request);
  const env = environment(); env.HANDSHAKE_REQUEST_JSON = JSON.stringify(fixture.request, null, 2);
  assert.deepEqual(validateContext(env, env.HANDSHAKE_SOURCE_SHA, timestamp), fixture.request);
});
test('request rejects duplicate keys, oversized/unsafe values, placeholders and command/path injection', () => {
  assert.throws(() => validateRequest('{"schema_version":1,"schema_version":1}'), /Duplicate/);
  assert.throws(() => validateRequest(' '.repeat(16 * 1024 + 1)), /request-size/);
  for (const mutate of [r => r.unknown = true, r => r.app.installation_id++, r => r.app.app_id++, r => r.app.permissions_requested.issues = 'read',
    r => r.kind = 'source-build', r => r.producer.run_id = 0, r => r.producer.run_attempt = 0, r => r.producer.run_id = Number.MAX_SAFE_INTEGER + 1,
    r => r.producer.workflow_sha = '0'.repeat(40), r => r.producer.repository = 'foreign/AnyWear-Service', r => r.release.tag += '; echo secret',
    r => r.release.target = 'main', r => r.release.manifest_sha256 = '0'.repeat(64), r => r.assets[1].id = r.assets[0].id,
    r => r.assets[1].name = r.assets[0].name, r => r.assets.pop(), r => r.assets[1].name = '../pre-sign-up.zip', r => r.assets[0].id++,
    r => r.assets[1].size = 100 * 1024 * 1024 + 1, r => r.assets[1].sha256 = '0'.repeat(64)]) {
    const request = structuredClone(fixture.request); mutate(request); assert.throws(() => validateRequest(canonicalJson(request)));
  }
});
for (const [field, value] of Object.entries({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'foreign/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1',
  GITHUB_REPOSITORY_OWNER_ID: '1', GITHUB_REF: 'refs/heads/codex/branch', GITHUB_WORKFLOW_REF: 'foreign', GITHUB_ACTOR: 'someone', GITHUB_TRIGGERING_ACTOR: 'someone',
  GITHUB_RUN_ID: '0', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: 'b'.repeat(40), GITHUB_WORKFLOW_SHA: 'b'.repeat(40), HANDSHAKE_SOURCE_SHA: 'b'.repeat(40),
  ENABLE_PUBLICATION_HANDSHAKE: 'false', PUBLICATION_HANDSHAKE_SOURCE_SHA: 'b'.repeat(40), PUBLICATION_HANDSHAKE_ACTOR: 'someone',
  PUBLICATION_HANDSHAKE_WINDOW_TOKEN: 'another_reader_allocation', HANDSHAKE_WINDOW_TOKEN: '', PUBLICATION_HANDSHAKE_EXPIRES_AT: timestamp,
  PUBLICATION_HANDSHAKE_RECORD_URL: 'https://github.com/git-malu/AnyWear/issues/10#issuecomment-1', PUBLICATION_HANDSHAKE_REQUEST_SHA256: '0'.repeat(64) })) {
  test(`pre-secret guard rejects ${field} substitution`, () => {
    const env = environment(); assert.throws(() => validateContext({ ...env, [field]: value }, env.HANDSHAKE_SOURCE_SHA, timestamp));
  });
}
test('pre-secret guard rejects checkout substitution and expiry crossing', () => {
  const env = environment(); assert.throws(() => validateContext(env, 'b'.repeat(40), timestamp));
  assert.throws(() => validateContext(env, env.HANDSHAKE_SOURCE_SHA, env.PUBLICATION_HANDSHAKE_EXPIRES_AT));
  assert.throws(() => validateContext({ ...env, PUBLICATION_HANDSHAKE_EXPIRES_AT: 'invalid' }, env.HANDSHAKE_SOURCE_SHA, timestamp));
});
async function gitFixture() {
  const root = await temporary('git'); const git = async args => (await execute('git', ['-C', root, ...args], { timeout: 30_000 })).stdout.trim();
  await git(['init', '--quiet']); await git(['config', 'user.name', 'Handshake fixture']); await git(['config', 'user.email', 'fixture@invalid.local']);
  await git(['config', 'core.autocrlf', 'false']); await git(['remote', 'add', 'origin', 'https://github.com/git-malu/AnyWear-Infra.git']);
  await writeFile(path.join(root, 'source.txt'), 'reviewed source'); await git(['add', '--', 'source.txt']); await git(['commit', '--quiet', '-m', 'Fixture']);
  return { root, git, sha: await git(['rev-parse', 'HEAD']) };
}
test('checkout guard proves actual source/origin and rejects untracked, dirty and hidden-index masking', async () => {
  const current = await gitFixture(); await assertCheckout(current.root, current.sha);
  await assert.rejects(assertCheckout(current.root, 'b'.repeat(40)), /checkout-source/);
  await writeFile(path.join(current.root, 'untracked.txt'), 'unreviewed'); await assert.rejects(assertCheckout(current.root, current.sha), /unclean/);
  const second = await gitFixture(); await second.git(['update-index', '--skip-worktree', '--', 'source.txt']);
  await assert.rejects(assertCheckout(second.root, second.sha), /unclean/);
  const third = await gitFixture(); await third.git(['update-index', '--assume-unchanged', '--', 'source.txt']);
  await assert.rejects(assertCheckout(third.root, third.sha), /unclean/);
  const fourth = await gitFixture(); await writeFile(path.join(fourth.root, 'source.txt'), 'changed');
  await assert.rejects(assertCheckout(fourth.root, fourth.sha), /unclean/);
  await fourth.git(['remote', 'set-url', 'origin', 'https://github.com/foreign/AnyWear-Infra.git']);
  await assert.rejects(assertCheckout(fourth.root, fourth.sha), /origin/);
});
test('checkout guard refuses replacement refs even when worktree appears clean', async () => {
  const current = await gitFixture(); await writeFile(path.join(current.root, 'source.txt'), 'replacement');
  await current.git(['add', '--', 'source.txt']); await current.git(['commit', '--quiet', '-m', 'Replacement']);
  await current.git(['replace', current.sha, await current.git(['rev-parse', 'HEAD'])]);
  await current.git(['--no-replace-objects', 'reset', '--hard', current.sha]);
  await assert.rejects(assertCheckout(current.root, current.sha), /unclean/);
});
test('CLI guard failure initializes nothing; failed mint finalization removes stale candidate/hash and retains only sanitized status', async () => {
  const current = await gitFixture(); const temp = await temporary('cli');
  const env = { ...commandEnvironment(process.env, path.join(temp, 'empty-config')), ...environment(), RUNNER_TEMP: temp, GITHUB_WORKSPACE: current.root,
    HANDSHAKE_SOURCE_SHA: current.sha, PUBLICATION_HANDSHAKE_SOURCE_SHA: current.sha, GITHUB_SHA: current.sha, GITHUB_WORKFLOW_SHA: current.sha,
    PUBLICATION_HANDSHAKE_EXPIRES_AT: '2099-01-01T00:00:00Z', GITHUB_OUTPUT: path.join(temp, 'outputs.txt'), APP_PRIVATE_KEY: 'FORBIDDEN_PRIVATE_KEY_SENTINEL' };
  const script = fileURLToPath(new URL('./publication-handshake.mjs', import.meta.url));
  await assert.rejects(execute(process.execPath, [script, 'guard'], { env: { ...env, GITHUB_TRIGGERING_ACTOR: 'someone' } }), error => {
    assert.match(error.stderr, /^HANDSHAKE_FAILED:executor-context\n$/); assert.equal(error.stderr.includes('FORBIDDEN_PRIVATE_KEY'), false); return true;
  });
  assert.deepEqual(await readdir(temp), []);
  await execute(process.execPath, [script, 'guard'], { env });
  assert.equal(await readFile(env.GITHUB_OUTPUT, 'utf8'), 'initialized=true\n');
  const evidence = path.join(temp, 'service-publication-handshake-200-1', 'evidence');
  await writeFile(path.join(evidence, 'candidate.json'), 'stale candidate'); await writeFile(path.join(evidence, 'candidate-sha256.txt'), 'stale hash');
  await execute(process.execPath, [script, 'finalize'], { env: { ...env, HANDSHAKE_PROBES_OUTCOME: 'success',
    HANDSHAKE_TOKEN_MINT_OUTCOME: 'failure', HANDSHAKE_CANDIDATE_OUTCOME: 'skipped' } });
  const status = parseJson(await readFile(path.join(evidence, 'status.json')));
  assert.equal(status.verified, false); assert.equal(status.scope_mint_accepted, false); assert.equal(status.error_category, 'app-scope-step-failed');
  const files = await readdir(evidence); assert.equal(files.includes('candidate.json'), false); assert.equal(files.includes('candidate-sha256.txt'), false);
  for (const name of files) assert.equal((await readFile(path.join(evidence, name))).includes(Buffer.from('FORBIDDEN_PRIVATE_KEY')), false);
});
test('credential environment strips alternate tokens, debug, enterprise, Git and Node overrides', () => {
  const env = commandEnvironment({ PATH: 'system', GH_TOKEN: 'old', GITHUB_TOKEN: 'old', GH_ENTERPRISE_TOKEN: 'old', GH_HOST: 'enterprise',
    GH_DEBUG: 'api', NODE_OPTIONS: '--require attack', GIT_CONFIG_COUNT: '1', APP_PRIVATE_KEY: 'never' }, '/empty/config', 'scoped-test-token');
  assert.equal(env.GH_TOKEN, 'scoped-test-token'); assert.equal(env.GH_HOST, 'github.com'); assert.equal(env.GH_CONFIG_DIR, '/empty/config');
  for (const key of ['GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GH_DEBUG', 'NODE_OPTIONS', 'GIT_CONFIG_COUNT', 'APP_PRIVATE_KEY']) assert.equal(env[key], undefined);
  assert.throws(() => liveReaderIo({ token: '', configDirectory: '/empty' }), /reader-token-missing/);
});
test('absent, omitted and null reader tokens fail before any fetch or native command', () => {
  let calls = 0;
  const options = { configDirectory: '/empty', fetchImpl: async () => { calls++; }, run: async () => { calls++; } };
  for (const token of [undefined, null, '', 1]) assert.throws(() => liveReaderIo({ ...options, token }), /reader-token-missing/);
  assert.throws(() => liveReaderIo(options), /reader-token-missing/);
  assert.equal(calls, 0);
});
test('live adapter executes literal native arguments with only scoped credentials and returns original JSON bytes', async () => {
  const raw = Buffer.from(`${canonicalJson(fixture.native)}\n`); let calls = 0;
  const io = liveReaderIo({ token: 'scoped-test-token', configDirectory: '/empty', env: { PATH: 'system', GITHUB_TOKEN: 'oauth', GH_DEBUG: 'api' },
    run: async (command, args, options) => { calls++; assert.equal(command, 'gh'); assert.deepEqual(args,
      ['release', 'verify-asset', fixture.request.release.tag, '/allowed/asset.zip', '--repo', repo.full_name, '--format', 'json']);
      assert.equal(options.env.GITHUB_TOKEN, undefined); assert.equal(options.env.GH_DEBUG, undefined); assert.equal(options.env.GH_TOKEN, 'scoped-test-token');
      return { stdout: raw }; } });
  assert.ok((await io.attestation(fixture.request.release.tag, '/allowed/asset.zip')).equals(raw)); assert.equal(calls, 1);
});
test('live adapter bounds streamed ZIP, cancels oversized response, and handles non-success without raw diagnostics', async () => {
  let cancelled = false;
  const io = liveReaderIo({ token: 'scoped-test-token', configDirectory: '/empty', fetchImpl: async () => ({ ok: true, body: { getReader: () => ({
    read: async () => ({ done: false, value: Buffer.alloc(2 * 1024 * 1024 + 1) }), cancel: async () => { cancelled = true; } }) } }) });
  await assert.rejects(io.publicationArchive(801), /github-response-bound/); assert.equal(cancelled, true);
  const failure = liveReaderIo({ token: 'scoped-test-token', configDirectory: '/empty', fetchImpl: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(failure.api('installation/repositories?per_page=100'), /github-read-failed/);
});
test('complete simulated handshake preserves raw native/ZIP/record and candidate without an accepted selector', async () => {
  const current = await attempt(); const candidate = await current.perform();
  assert.equal(candidate.producer.workflow_sha, fixture.request.producer.workflow_sha);
  assert.notEqual(candidate.producer.workflow_sha, fixture.manifest.components.image.service_sha);
  assert.equal(candidate.publication.record_base64, fixture.recordBytes.toString('base64'));
  assert.equal(current.status.scope_mint_accepted, true); assert.equal(current.status.actual_native_read_verified, true); assert.equal(current.status.verified, true);
  for (const field of ['receipt_committed', 'selection_accepted', 'deployment_authorized', 'mutation_performed']) assert.equal(current.status[field], false);
  assert.equal(current.calls.filter(value => value.startsWith('native:')).length, 6);
  assert.equal(current.calls.filter(value => value === `${prefix}/actions/runs/91/attempts/2`).length, 4);
  const files = await readdir(current.evidenceDirectory);
  assert.equal(files.includes('selection.json'), false); assert.equal(files.includes('receipt.json'), false);
  assert.ok((await readFile(path.join(current.evidenceDirectory, 'publication.zip'))).equals(fixture.archive));
  assert.ok((await readFile(path.join(current.evidenceDirectory, 'service-artifact-publication.json'))).equals(fixture.recordBytes));
  assert.ok((await readFile(path.join(current.evidenceDirectory, 'native-release.json'))).equals(Buffer.from(canonicalJson(fixture.native))));
  const inventory = parseJson(await readFile(path.join(current.evidenceDirectory, 'inventory.json')));
  for (const file of inventory.files) assert.equal(file.sha256, sha256(await readFile(path.join(current.evidenceDirectory, file.name))));
});
async function rejected(options, expected) {
  const current = await attempt(options); await assert.rejects(current.perform(), expected);
  const files = await readdir(current.evidenceDirectory); assert.equal(files.includes('candidate.json'), false); assert.equal(files.includes('candidate-sha256.txt'), false);
  assert.equal(current.status.verified, false); assert.equal(current.status.outcome, 'failure');
  return current;
}
test('App identity, mint or scope mismatch fails before publisher/native reads', async () => {
  for (const options of [{ installationId: '1' }, { tokenMintOutcome: 'failure' }, { patch: f => f.scope = { total_count: 2, repositories: [repo, repo] } },
    { patch: f => f.scope = { total_count: 1, repositories: [{ ...repo, id: 1 }] } }, { patch: f => f.repository = { ...repo, private: false } }]) {
    const current = await rejected(options); assert.equal(current.calls.some(value => value.includes('/actions/') || value.startsWith('native:')), false);
  }
});
test('external producer binding rejects a different self-consistent manifest before native verification', async () => {
  const current = await attempt(); const different = structuredClone(fixture.manifest); different.producer.run_id = 92;
  current.options.io.asset = async () => Buffer.from(canonicalJson(different));
  // Review this alternate hash/size to reach the independent producer binding.
  const raw = Buffer.from(canonicalJson(different)); const request = structuredClone(current.options.request); current.options.request = request;
  request.assets[0].sha256 = sha256(raw); request.assets[0].size = raw.length; request.release.manifest_sha256 = sha256(raw);
  request.release.tag = `service-baseline-${sha256(raw)}`;
  current.options.io.api = async endpoint => {
    if (endpoint === 'installation/repositories?per_page=100') return { total_count: 1, repositories: [repo] };
    if (endpoint === prefix) return repo;
    if (endpoint.includes('/actions/runs/')) return fixture.producer;
    if (endpoint.includes('/releases/')) return { ...fixture.release, tag_name: request.release.tag,
      assets: request.assets.map(asset => ({ ...asset, state: 'uploaded', digest: `sha256:${asset.sha256}` })) };
    assert.fail('Unexpected read after mismatched producer');
  };
  await assert.rejects(current.perform(), /external-producer/);
  assert.equal(current.status.actual_native_read_verified, false);
});
for (const [label, patch] of [
  ['wrong producer attempt', f => f.producer.run_attempt++], ['wrong producer owner', f => f.producer.head_repository.owner.id++],
  ['unsuccessful producer', f => f.producer.conclusion = 'failure'], ['unsealed draft', f => f.release.draft = true],
  ['mutable release', f => f.release.immutable = false], ['wrong release', f => f.release.id++],
  ['missing asset', f => f.release.assets.pop()], ['different asset ID', f => f.release.assets[1].id++],
  ['different asset size', f => f.release.assets[1].size++], ['different asset digest', f => f.release.assets[1].digest = `sha256:${'9'.repeat(64)}`],
  ['annotated tag', f => f.ref = { object: { type: 'tag', sha: f.request.release.target } }],
  ['wrong target', f => f.ref = { object: { type: 'commit', sha: '9'.repeat(40) } }],
  ['tampered component', f => f.bytes['pre-sign-up.zip'][0] ^= 1],
  ['wrong native SAN', f => f.native.verificationResult.signature.certificate.subjectAlternativeName = 'foreign'],
  ['unsupported native JSON', f => f.nativeRaw = '{}'], ['foreign native release', f => f.native.verificationResult.statement.predicate.releaseId = '74'],
  ['duplicate publication', f => f.artifactInventory = { total_count: 2, artifacts: [f.artifact, f.artifact] }],
  ['expired publication', f => f.artifact.expired = true], ['wrong archive digest', f => f.artifact.digest = `sha256:${'9'.repeat(64)}`],
  ['wrong archive size', f => f.artifact.size_in_bytes++], ['wrong attempt interval', f => f.artifact.created_at = '2026-10-07T23:59:00Z'],
  ['wrong artifact source', f => f.artifact.workflow_run.head_sha = '9'.repeat(40)], ['bounded artifact inventory', f => f.artifactInventory = { total_count: 1001, artifacts: [] }],
  ['corrupt ZIP', f => f.archive[0] = 0], ['oversized ZIP', f => f.archive = Buffer.alloc(2 * 1024 * 1024 + 1)],
  ['producer drift after evidence', f => f.driftAfter = 3],
]) test(`partial failure leaves no candidate: ${label}`, async () => { await rejected({ patch }); });
test('failed native CLI retains bounded earlier evidence and no raw stderr/token', async () => {
  const current = await rejected({ patch: f => f.nativeFailAt = 3 });
  assert.equal(current.status.actual_native_read_verified, false);
  const files = await readdir(current.evidenceDirectory); assert.ok(files.includes('native-release.json')); assert.ok(files.includes('native-service-artifacts.json'));
  for (const name of files) assert.equal((await readFile(path.join(current.evidenceDirectory, name))).includes(Buffer.from('PRIVATE_TOKEN')), false);
});
test('every remote boundary rechecks expiry/source and final source drift prevents candidate output', async () => {
  let checks = 0;
  const current = await rejected({ check: async () => { if (++checks === 10) throw new Error('source changed'); } });
  assert.ok(current.calls.length > 0); assert.equal(current.status.actual_native_read_verified, false);
  const final = await attempt(); let count = 0;
  final.options.contextCheck = async () => { count++; if (final.status.phase === 'final') throw new Error('expired before finalization'); };
  await assert.rejects(final.perform()); assert.equal(final.status.actual_native_read_verified, true); assert.equal(final.status.verified, false);
  assert.equal((await readdir(final.evidenceDirectory)).includes('candidate.json'), false); assert.ok(count > final.calls.length * 2);
});
test('successful native commands using different signed statements are rejected', async () => {
  const differentNative = structuredClone(fixture.native);
  // Both subject orders bind the complete set, but the signed statements differ.
  differentNative.verificationResult.statement.subject.reverse();
  differentNative.attestation.bundle.dsseEnvelope.payload = Buffer.from(canonicalJson(differentNative.verificationResult.statement)).toString('base64');
  const expected = { releaseId: fixture.request.release.id, tag: fixture.request.release.tag, target: fixture.request.release.target,
    assetHashes: Object.fromEntries(fixture.request.assets.map(asset => [asset.name, asset.sha256])) };
  assertNativeReleaseAttestation(fixture.native, expected); assertNativeReleaseAttestation(differentNative, expected);
  await rejected({ patch: f => { f.nativeDriftAt = 2; f.differentNative = differentNative; } }, /native-statement-drift/);
});
test('artifact expiry crossing during retrieval prevents candidate output at completion', async () => {
  const current = await attempt(); let timestamps = 0;
  current.options.now = () => ++timestamps === 1 ? timestamp : '2099-01-01T00:00:00Z';
  await assert.rejects(current.perform(), /publication-expired-at-completion/);
  assert.equal((await readdir(current.evidenceDirectory)).includes('candidate.json'), false);
});
test('context failure after candidate/hash writes removes both files and keeps failed evidence', async () => {
  const current = await attempt(); let sawWrittenCandidate = false;
  current.options.contextCheck = async () => {
    const files = await readdir(current.evidenceDirectory);
    if (files.includes('candidate.json') && files.includes('candidate-sha256.txt')) {
      sawWrittenCandidate = true; throw new Error('source drift after candidate writes');
    }
  };
  await assert.rejects(current.perform(), /final-verification-failed/); assert.equal(sawWrittenCandidate, true);
  assert.equal(current.status.verified, false); assert.equal(current.status.outcome, 'failure');
  const files = await readdir(current.evidenceDirectory); assert.equal(files.includes('candidate.json'), false); assert.equal(files.includes('candidate-sha256.txt'), false);
  assert.ok(files.includes('native-release.json')); assert.ok(files.includes('publication.zip')); assert.ok(files.includes('inventory.json'));
});
test('workflow preserves dispatch-only read scope, pre-secret guards, isolated evidence and automatic token revocation', async () => {
  const workflow = await readFile(new URL('../.github/workflows/publication-handshake.yml', import.meta.url), 'utf8');
  assert.match(workflow, /on:\n  workflow_dispatch:/); assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /repositories: AnyWear-Service/); assert.match(workflow, /app-id: 3346940/);
  for (const permission of ['contents', 'actions', 'attestations']) assert.match(workflow, new RegExp(`permission-${permission}: read`));
  assert.ok(workflow.indexOf('publication-handshake.mjs guard') < workflow.indexOf('private-key:'));
  assert.ok(workflow.indexOf('publication-handshake.mjs probes') < workflow.indexOf('private-key:'));
  assert.match(workflow, /steps\.probes\.outcome == 'success'/);
  assert.equal((workflow.match(/secrets\.APP_PRIVATE_KEY/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /pull_request|id-token|aws-actions|environment:|runtime\.yml|permission-\w+: write|GITHUB_ENV|skip-token-revoke|gh auth|npm ci/);
  assert.match(workflow, /persist-credentials: false/); assert.match(workflow, /retention-days: 90/); assert.match(workflow, /if-no-files-found: error/);
  const uploads = [...workflow.matchAll(/\/evidence\/([^\s]+)$/gm)].map(match => match[1]);
  assert.deepEqual(uploads.sort(), [...EVIDENCE_FILES, 'inventory.json'].sort());
  assert.doesNotMatch(workflow, /\/evidence\/\*/);
});
