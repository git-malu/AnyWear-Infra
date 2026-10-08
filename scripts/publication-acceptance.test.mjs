import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { parseJson, canonicalJson, contentHash, sha256 } from './json-contract.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { RELEASE_PREDICATE_TYPE, assertNativeReleaseAttestation } from './vendor/service-release-attestation.mjs';
import { decodePublicationArchive, createPublicationCandidate, validatePublicationAcceptance, loadPublicationAcceptance,
  MAX_PUBLICATION_ARCHIVE_BYTES, MAX_PUBLICATION_RECORD_BYTES } from './publication-acceptance.mjs';

const execute = promisify(execFile);
const nativeVersions = ['v0.1', 'v0.2'];
const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), 'anywear-publication-source-'));
const { selector: originalSelector, manifest } = await createTestInputs(fixtureDirectory);
const selector = structuredClone(originalSelector); delete selector.publication_acceptance;
const repo = { full_name: 'git-malu/AnyWear-Service', id: 1158460323, owner: { id: 11473072 } };
const producerRun = { id: manifest.producer.run_id, run_attempt: manifest.producer.run_attempt, head_sha: manifest.producer.workflow_sha,
  repository: repo, head_repository: repo, head_branch: 'main', path: '.github/workflows/service-artifacts.yml', event: 'workflow_dispatch',
  status: 'completed', conclusion: 'success', run_started_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:30:00Z' };
const release = { id: selector.release.id, immutable: true, draft: false, tag_name: `service-artifacts-${selector.image.service_sha}`,
  assets: await Promise.all([{ id: selector.release.manifest_asset_id, file: 'service-artifacts.json', sha256: selector.release.manifest_sha256 },
    ...Object.values(selector.lambdas), selector.runtime_policy, selector.schema].map(async item => ({ id: item.asset_id ?? item.id, name: item.file,
      digest: `sha256:${item.sha256}`, state: 'uploaded', size: (await readFile(path.join(fixtureDirectory, item.file))).length }))) };
const hashes = Object.fromEntries(release.assets.map(asset => [asset.name, asset.digest.slice(7)]));
const purl = `pkg:github/git-malu/AnyWear-Service@${release.tag_name}`;
const nativeInputs = { releaseId: release.id, tag: release.tag_name, target: selector.image.service_sha, assetHashes: hashes };

function nativeFixture(nativeVersion) {
  const identity = { ownerId: '11473072', repositoryId: '1158460323', repository: repo.full_name, purl, tag: release.tag_name };
  const statement = { _type: 'https://in-toto.io/Statement/v1',
    predicateType: nativeVersion === 'v0.1' ? RELEASE_PREDICATE_TYPE : 'https://in-toto.io/attestation/release/v0.2',
    predicate: nativeVersion === 'v0.1' ? { ...identity, releaseId: String(release.id) }
      : { ...identity, databaseId: String(release.id), packageId: identity.repositoryId },
    subject: [{ uri: purl, digest: { sha1: selector.image.service_sha } }, ...Object.entries(hashes).map(([name, hash]) => ({ name, digest: { sha256: hash } }))] };
  // Synthetic post-gh result: no cryptographic or live publication success is claimed.
  return { verificationResult: { statement, signature: { certificate: { subjectAlternativeName: 'https://dotcom.releases.github.com' } } },
    attestation: { bundle: { dsseEnvelope: { payload: Buffer.from(canonicalJson(statement)).toString('base64'),
      payloadType: 'application/vnd.in-toto+json', signatures: [{ sig: 'unit-fixture' }] } } } };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(bytes, { method = 8, descriptor = false, signedDescriptor = true, name = 'service-artifact-publication.json', size = bytes.length, trailingCompressed = false } = {}) {
  const filename = Buffer.from(name); let data = method === 8 ? deflateRawSync(bytes) : bytes;
  if (trailingCompressed) data = Buffer.concat([data, Buffer.from('trailing')]);
  const crc = crc32(bytes); const flags = 0x0800 | (descriptor ? 8 : 0);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(method, 8); local.writeUInt16LE(filename.length, 26);
  if (!descriptor) { local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22); }
  const desc = Buffer.alloc(descriptor ? signedDescriptor ? 16 : 12 : 0);
  if (descriptor) { const offset = signedDescriptor ? 4 : 0; if (signedDescriptor) desc.writeUInt32LE(0x08074b50);
    desc.writeUInt32LE(crc, offset); desc.writeUInt32LE(data.length, offset + 4); desc.writeUInt32LE(size, offset + 8); }
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(size, 24); central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + data.length + desc.length, 16);
  return Buffer.concat([local, filename, data, desc, central, filename, end]);
}
function publicationFixture(nativeVersion) {
  const nativeVerification = nativeFixture(nativeVersion);
  const publicationRecord = { schema_version: 1, record_type: 'anywear_service_artifact_publication', repository: repo.full_name,
    release_id: release.id, manifest_asset_id: selector.release.manifest_asset_id, manifest_sha256: selector.release.manifest_sha256,
    tag: release.tag_name, target: selector.image.service_sha, producer: manifest.producer,
    assets: Object.fromEntries(release.assets.map(asset => [asset.name, { id: asset.id, size: asset.size, sha256: hashes[asset.name] }])),
    release_attestation: nativeVerification, native_release_statement_sha256: contentHash(nativeVerification.verificationResult.statement) };
  const recordBytes = Buffer.from(`${JSON.stringify(publicationRecord, null, 2)}\n`); const archiveBytes = zip(recordBytes, { descriptor: true });
  const artifact = { id: 42, name: `service-artifact-publication-${producerRun.id}-${producerRun.run_attempt}`, expired: false,
    workflow_run: { id: producerRun.id, head_sha: producerRun.head_sha }, created_at: '2026-10-08T00:20:00Z', expires_at: '2099-01-01T00:00:00Z',
    size_in_bytes: archiveBytes.length, digest: `sha256:${sha256(archiveBytes)}` };
  const input = { selector, manifest, release, producerRun, artifacts: [artifact], archiveBytes, nativeVerification,
    managerAcceptanceUrl: 'https://github.com/git-malu/AnyWear/issues/54#issuecomment-6041978451', verifiedAt: '2026-10-08T01:00:00Z' };
  return { nativeVerification, publicationRecord, recordBytes, archiveBytes, artifact, input, candidate: createPublicationCandidate(input) };
}
const fixtures = Object.fromEntries(nativeVersions.map(version => [version, publicationFixture(version)]));
const { publicationRecord, recordBytes, archiveBytes, candidate } = fixtures['v0.1'];

test('ZIP parser returns exact original record bytes for store, deflate and signed/unsigned descriptor archives', () => {
  for (const options of [{ method: 0 }, { method: 8 }, { method: 8, descriptor: true }, { method: 8, descriptor: true, signedDescriptor: false }]) {
    const archive = zip(recordBytes, options); const decoded = decodePublicationArchive(archive);
    assert.ok(decoded.recordBytes.equals(recordBytes)); assert.deepEqual(decoded.publicationRecord, publicationRecord);
    assert.equal(decoded.archiveSha256, sha256(archive));
  }
});

test('ZIP parser rejects paths, extra entries, encryption, symlinks, inconsistent headers, CRC and trailing data', () => {
  for (const name of ['../service-artifact-publication.json', 'sub/service-artifact-publication.json', 'service-artifact-publication.json/', 'another.json']) {
    assert.throws(() => decodePublicationArchive(zip(recordBytes, { name })));
  }
  for (const mutate of [bytes => bytes.writeUInt16LE(2, bytes.length - 22 + 10),
    bytes => bytes.writeUInt16LE(0x0801, bytes.readUInt32LE(bytes.length - 22 + 16) + 8),
    bytes => bytes.writeUInt32LE(0xa0000000, bytes.readUInt32LE(bytes.length - 22 + 16) + 38),
    bytes => bytes.writeUInt16LE(0, 6), bytes => bytes[30] ^= 1,
    bytes => bytes.writeUInt32LE(0, bytes.readUInt32LE(bytes.length - 22 + 16) + 16)]) {
    const bytes = Buffer.from(archiveBytes); mutate(bytes); assert.throws(() => decodePublicationArchive(bytes));
  }
  assert.throws(() => decodePublicationArchive(Buffer.concat([archiveBytes, Buffer.from('extra')])));
  assert.throws(() => decodePublicationArchive(zip(recordBytes, { trailingCompressed: true })), /trailing bytes/);
});

test('ZIP parser bounds actual decompression and archive bytes, rejects duplicate JSON keys and unsupported ZIP64', () => {
  assert.throws(() => decodePublicationArchive(Buffer.alloc(MAX_PUBLICATION_ARCHIVE_BYTES + 1)), /size/);
  const bomb = zip(Buffer.alloc(MAX_PUBLICATION_RECORD_BYTES + 1, 'a'), { size: 2 });
  assert.throws(() => decodePublicationArchive(bomb));
  assert.throws(() => decodePublicationArchive(zip(Buffer.from('{"release_id":1,"release_id":2}'))), /Duplicate/);
  const unsupported = Buffer.from(archiveBytes); unsupported.writeUInt16LE(45, unsupported.readUInt32LE(unsupported.length - 22 + 16) + 6);
  assert.throws(() => decodePublicationArchive(unsupported));
});

for (const nativeVersion of nativeVersions) test(`synthetic ${nativeVersion} candidate requires exact successful repository/source/run/attempt and unique unexpired attempt artifact`, () => {
  const { candidate, recordBytes, input, artifact, archiveBytes, nativeVerification } = fixtures[nativeVersion];
  assertNativeReleaseAttestation(nativeVerification, nativeInputs);
  assert.equal(candidate.publication.record_base64, recordBytes.toString('base64'));
  for (const patch of [{ run_attempt: 2 }, { status: 'in_progress' }, { conclusion: 'failure' }, { head_sha: '9'.repeat(40) },
    { repository: { ...repo, id: 1 } }, { head_repository: { ...repo, owner: { id: 1 } } }]) {
    assert.throws(() => createPublicationCandidate({ ...input, producerRun: { ...producerRun, ...patch } }));
  }
  assert.throws(() => createPublicationCandidate({ ...input, artifacts: [artifact, artifact] }), /Exactly one/);
  assert.throws(() => createPublicationCandidate({ ...input, artifacts: [] }), /Exactly one/);
  for (const patch of [{ name: 'service-artifact-publication-1-2' }, { expired: true }, { expires_at: input.verifiedAt },
    { created_at: '2026-10-07T23:59:00Z' }, { workflow_run: { id: producerRun.id, head_sha: '9'.repeat(40) } },
    { digest: `sha256:${'9'.repeat(64)}` }, { size_in_bytes: archiveBytes.length + 1 }]) {
    assert.throws(() => createPublicationCandidate({ ...input, artifacts: [{ ...artifact, ...patch }] }));
  }
  assert.throws(() => createPublicationCandidate({ ...input, nativeVerification: undefined }), /First-hand/);
});

for (const nativeVersion of nativeVersions) test(`synthetic ${nativeVersion} receipt binds repository IDs, every live asset size/hash/ID, exact producer and retained original bytes`, () => {
  const { candidate, publicationRecord, nativeVerification } = fixtures[nativeVersion];
  validatePublicationAcceptance(candidate, { selector, manifest, release, publicationRecord, nativeVerification });
  for (const mutate of [r => r.schema_version = 2, r => r.repository.id = 1, r => r.producer.run_attempt++,
    r => r.release.id++, r => r.release.target = '9'.repeat(40), r => r.release.assets[0].id++,
    r => r.release.assets[0].size++, r => r.release.assets[0].sha256 = '9'.repeat(64), r => r.release.assets.push(r.release.assets[0]),
    r => r.publication.artifact_name = 'service-artifact-publication-1-2', r => r.publication.record_base64 += '\n',
    r => r.publication.record_sha256 = '9'.repeat(64), r => r.unknown = true]) {
    const receipt = structuredClone(candidate); mutate(receipt);
    assert.throws(() => validatePublicationAcceptance(receipt, { selector, manifest, release }));
  }
  const changed = structuredClone(release); changed.assets[0].digest = `sha256:${'9'.repeat(64)}`;
  assert.throws(() => validatePublicationAcceptance(candidate, { selector, manifest, release: changed }));
});

for (const nativeVersion of nativeVersions) test(`synthetic ${nativeVersion} retained publication cannot change native signed subjects or add workflow claims absent from native signature`, () => {
  const { publicationRecord, recordBytes, candidate } = fixtures[nativeVersion];
  for (const mutate of [r => r.assets['service-artifacts.json'].id++, r => r.native_release_statement_sha256 = '9'.repeat(64),
    r => r.release_attestation.verificationResult.statement.subject.pop(),
    r => r.release_attestation.verificationResult.statement.predicate.workflow_sha = manifest.producer.workflow_sha]) {
    const record = structuredClone(publicationRecord); mutate(record);
    const bytes = Buffer.from(canonicalJson(record)); const receipt = structuredClone(candidate);
    receipt.publication.record_base64 = bytes.toString('base64'); receipt.publication.record_sha256 = sha256(bytes);
    assert.throws(() => validatePublicationAcceptance(receipt, { selector, manifest, release }));
  }
  const corruptRecord = Buffer.from(recordBytes.toString().replace('"schema_version": 1', '"schema_version": 1,"schema_version": 1'));
  const receipt = structuredClone(candidate); receipt.publication.record_base64 = corruptRecord.toString('base64'); receipt.publication.record_sha256 = sha256(corruptRecord);
  assert.throws(() => validatePublicationAcceptance(receipt, { selector, manifest, release }), /Duplicate/);
});

for (const nativeVersion of nativeVersions) test(`synthetic ${nativeVersion} candidate and receipt reject different policy-valid first-hand signed statements`, () => {
  const current = fixtures[nativeVersion]; const reordered = structuredClone(current.nativeVerification);
  reordered.verificationResult.statement.subject.reverse();
  reordered.attestation.bundle.dsseEnvelope.payload = Buffer.from(canonicalJson(reordered.verificationResult.statement)).toString('base64');
  const otherVersion = fixtures[nativeVersion === 'v0.1' ? 'v0.2' : 'v0.1'].nativeVerification;
  for (const differentNative of [reordered, otherVersion]) {
    assertNativeReleaseAttestation(differentNative, nativeInputs);
    assert.throws(() => createPublicationCandidate({ ...current.input, nativeVerification: differentNative }), /First-hand native release statement differs/);
    assert.throws(() => validatePublicationAcceptance(current.candidate, { selector, manifest, release, nativeVerification: differentNative }), /First-hand native release statement differs/);
  }
});

async function gitFixture(current = fixtures['v0.1']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'anywear-publication-git-'));
  const git = async args => (await execute('git', ['-C', root, ...args], { timeout: 30_000 })).stdout.trim();
  await git(['init', '--quiet']); await git(['config', 'user.name', 'Publication contract fixture']);
  await git(['config', 'user.email', 'publication-fixture@invalid.local']); await git(['config', 'core.autocrlf', 'false']);
  await git(['remote', 'add', 'origin', 'https://github.com/git-malu/AnyWear-Infra']);
  await mkdir(path.join(root, 'publications'));
  const file = `publications/${selector.release.manifest_sha256}.json`; const bytes = Buffer.from(canonicalJson(current.candidate));
  await writeFile(path.join(root, file), bytes); await git(['add', '--', file]); await git(['commit', '--quiet', '-m', 'Receipt fixture']);
  const expectedInfraSha = await git(['rev-parse', 'HEAD']);
  return { root, git, file, bytes, expectedInfraSha, selector: { ...selector, publication_acceptance: { file, sha256: sha256(bytes) } } };
}

for (const nativeVersion of nativeVersions) test(`synthetic ${nativeVersion} Git loader requires explicit reviewed root/pin and a clean tracked regular blob with exact actual bytes`, async () => {
  const current = fixtures[nativeVersion]; const fixture = await gitFixture(current);
  const options = { trustedInfraRoot: fixture.root, expectedInfraSha: fixture.expectedInfraSha, manifest, release, nativeVerification: current.nativeVerification };
  assert.deepEqual(await loadPublicationAcceptance(fixture.selector, options), current.candidate);
  await assert.rejects(loadPublicationAcceptance(fixture.selector, { ...options, expectedInfraSha: '9'.repeat(40) }), /HEAD/);
  await assert.rejects(loadPublicationAcceptance(fixture.selector, { ...options, trustedInfraRoot: undefined }), /Explicit/);
  await assert.rejects(loadPublicationAcceptance(fixture.selector, { ...options, expectedInfraSha: undefined }), /reviewed Infra/);
  await assert.rejects(loadPublicationAcceptance({ ...fixture.selector, publication_acceptance: { ...fixture.selector.publication_acceptance, file: '../receipt.json' } }, options), /path/);
  await assert.rejects(loadPublicationAcceptance({ ...fixture.selector, publication_acceptance: { ...fixture.selector.publication_acceptance, sha256: '9'.repeat(64) } }, options), /bytes/);
  await writeFile(path.join(fixture.root, 'unreviewed.txt'), 'untracked source');
  await assert.rejects(loadPublicationAcceptance(fixture.selector, options), /clean/);
});

test('Git loader rejects overwritten receipt even with skip-worktree masking and untracked/unstaged self-acceptance', async () => {
  const fixture = await gitFixture(); const options = { trustedInfraRoot: fixture.root, expectedInfraSha: fixture.expectedInfraSha, manifest, release };
  await fixture.git(['update-index', '--skip-worktree', '--', fixture.file]);
  await writeFile(path.join(fixture.root, fixture.file), Buffer.concat([fixture.bytes, Buffer.from('\n')]));
  assert.equal(await fixture.git(['status', '--porcelain']), '');
  await assert.rejects(loadPublicationAcceptance(fixture.selector, options), /bytes differ/);
  const second = await gitFixture();
  await second.git(['rm', '--cached', '--', second.file]);
  await assert.rejects(loadPublicationAcceptance(second.selector, { ...options, trustedInfraRoot: second.root, expectedInfraSha: second.expectedInfraSha }), /clean/);
});

test('Git replacement refs cannot substitute an unreviewed receipt tree for the caller pin', async () => {
  const fixture = await gitFixture();
  const changed = structuredClone(candidate); changed.manager_acceptance_url = 'https://github.com/git-malu/AnyWear/issues/54#issuecomment-99';
  const changedBytes = Buffer.from(canonicalJson(changed));
  await writeFile(path.join(fixture.root, fixture.file), changedBytes);
  await fixture.git(['add', '--', fixture.file]); await fixture.git(['commit', '--quiet', '-m', 'Unreviewed replacement fixture']);
  const replacement = await fixture.git(['rev-parse', 'HEAD']);
  await fixture.git(['replace', fixture.expectedInfraSha, replacement]);
  await fixture.git(['reset', '--hard', fixture.expectedInfraSha]);
  assert.equal(await fixture.git(['status', '--porcelain']), '');
  await assert.rejects(loadPublicationAcceptance({ ...fixture.selector, publication_acceptance: { file: fixture.file, sha256: sha256(changedBytes) } },
    { trustedInfraRoot: fixture.root, expectedInfraSha: fixture.expectedInfraSha, manifest, release }), /clean|bytes differ/);
});
