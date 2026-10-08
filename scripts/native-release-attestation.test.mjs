import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { canonicalJson, parseStrictJson, sha256 } from './vendor/service-artifact-contract.mjs';
import { assertNativeReleaseAttestation, RELEASE_PREDICATE_TYPE } from './vendor/service-release-attestation.mjs';
import { assertPublisherRun } from './artifact-consumer.mjs';

const official = parseStrictJson(readFileSync(new URL('../test/fixtures/github-native-release-verification.json', import.meta.url)));
const expected = { releaseId: 123, tag: 'service-artifacts-' + 'a'.repeat(40), target: 'a'.repeat(40),
  assetHashes: { 'service-artifacts.json': 'b'.repeat(64), 'pre-sign-up.zip': 'c'.repeat(64) } };
const genuineBytes = readFileSync(new URL('../test/fixtures/github-native-release-verification-v0.2.json', import.meta.url));
const genuine = parseStrictJson(genuineBytes);
const v02Expected = { releaseId: 406660922,
  tag: 'service-baseline-b5bb8ec69ec68a99a0a9c87ec8a84dc2b1ae8a29bb88e46f6808dc8d71c84332',
  target: '9e322b45ec7e5720b7d21776ac4f056b4fa2176d', assetHashes: {
    'post-confirmation.zip': 'd022c5472106e7d496e40532d8743526ebe3242874c22d9411d5641045b7a8c8',
    'pre-sign-up.zip': '075416781b949d8c936a8abfc1e5e062c4e5447acc056a04db18b45cc754ddc4',
    'runtime-policy.json': 'e53316ce3a694f68df1e49204f46b79f793134b045b8341d5aeb78d0ce8da083',
    'service-artifacts.json': 'b5bb8ec69ec68a99a0a9c87ec8a84dc2b1ae8a29bb88e46f6808dc8d71c84332',
    'service-schema.json': '3191e07204a127e73656028290f833eb38d38f955822390f8b8a803b27deb5fb' } };

// These mutations exercise policy parsing only. Their retained example signature
// does not cryptographically sign the changed Service inputs. Runtime callers
// must execute gh's native cryptographic verifier before invoking this helper.
function offlineFixture(change = () => {}) {
  const result = globalThis.structuredClone(official);
  const statement = result.verificationResult.statement;
  const purl = `pkg:github/git-malu/AnyWear-Service@${expected.tag}`;
  statement.predicate = { ownerId: '11473072', repositoryId: '1158460323', repository: 'git-malu/AnyWear-Service',
    releaseId: String(expected.releaseId), purl, tag: expected.tag };
  statement.subject = [{ uri: purl, digest: { sha1: expected.target } },
    ...Object.entries(expected.assetHashes).map(([name, hash]) => ({ name, digest: { sha256: hash } }))];
  change(statement);
  result.attestation.bundle.dsseEnvelope.payload = Buffer.from(canonicalJson(statement)).toString('base64');
  return result;
}

test('actual native CLI output uses decimal string IDs, Git URI/SHA1, and assets/SHA256', () => {
  const statement = official.verificationResult.statement;
  assert.equal(statement.predicate.releaseId, '222158671');
  assert.equal(statement.subject[0].uri, 'pkg:github/bdehamer/delme@v6');
  assert.match(statement.subject[0].digest.sha1, /^[a-f0-9]{40}$/);
  assert.match(statement.subject[1].digest.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => assertNativeReleaseAttestation(official, expected), /repository\/owner\/ID\/tag/);
  assert.equal(assertNativeReleaseAttestation(offlineFixture(), expected).predicate.repository, 'git-malu/AnyWear-Service');
});

test('native release policy refuses wrong identities, tag, target, and incomplete asset sets', () => {
  for (const change of [
    (s) => { s.predicate.ownerId = '398027'; }, (s) => { s.predicate.repositoryId = '905988044'; },
    (s) => { s.predicate.repository = 'foreign/repository'; }, (s) => { s.predicate.releaseId = '124'; },
    (s) => { s.predicate.releaseId = 123; }, (s) => { s.predicate.tag = 'foreign-tag'; },
    (s) => { s.predicate.purl += '-foreign'; }, (s) => { s.predicate.run_id = 123; },
    (s) => { s.predicateType = 'https://slsa.dev/provenance/v1'; },
    (s) => { s.subject[0].digest.sha1 = 'd'.repeat(40); }, (s) => { s.subject[0].uri += '-foreign'; },
    (s) => { s.subject[0] = { name: s.subject[0].uri, digest: { sha256: 'd'.repeat(64) } }; },
    (s) => { s.subject.pop(); }, (s) => { s.subject.push(s.subject[1]); },
    (s) => { s.subject[2] = globalThis.structuredClone(s.subject[1]); },
    (s) => { s.subject[1].name = 'extra.zip'; }, (s) => { s.subject[1].digest.sha256 = 'e'.repeat(64); },
  ]) assert.throws(() => assertNativeReleaseAttestation(offlineFixture(change), expected));
});

test('native policy rejects raw bundles, mixed statements and a foreign signature identity', () => {
  assert.throws(() => assertNativeReleaseAttestation(official.attestation.bundle, expected));
  const changed = offlineFixture(); changed.verificationResult.statement.subject[1].digest.sha256 = 'f'.repeat(64);
  assert.throws(() => assertNativeReleaseAttestation(changed, expected), /signed envelope/);
  const foreign = offlineFixture(); foreign.verificationResult.signature.certificate.subjectAlternativeName = 'https://attestations.example.invalid';
  assert.throws(() => assertNativeReleaseAttestation(foreign, expected), /signature required/);
});

// Altered statement/payload pairs below are offline policy cases, not new signed
// evidence. The genuine fixture is retained byte-for-byte from the failed run.
function v02Fixture(change) {
  const result = globalThis.structuredClone(genuine);
  change(result.verificationResult.statement);
  result.attestation.bundle.dsseEnvelope.payload = Buffer.from(canonicalJson(result.verificationResult.statement)).toString('base64');
  return result;
}

test('genuine v0.2 output preserves signed bytes and exact release/package/full subject identities', () => {
  assert.equal(RELEASE_PREDICATE_TYPE, 'https://in-toto.io/attestation/release/v0.1');
  assert.equal(genuineBytes.length, 5681);
  assert.equal(sha256(genuineBytes), 'cf0bf9a5550ec9b475cb9b1fea68b793a39a2e640431deb69f075254d23ab0e2');
  const payload = Buffer.from(genuine.attestation.bundle.dsseEnvelope.payload, 'base64');
  assert.equal(payload.length, 1267);
  assert.equal(sha256(payload), 'a146004b9e828e3395fdb6739b4cea1c1da7deff1508aed5d8ef967914369e2f');
  const statement = assertNativeReleaseAttestation(genuine, v02Expected);
  assert.strictEqual(statement, genuine.verificationResult.statement);
  assert.equal(statement.predicate.databaseId, String(v02Expected.releaseId));
  assert.equal(statement.predicate.packageId, '1158460323');
  assert.equal(sha256(canonicalJson(statement)), '88c900b54c66a042490f91ec9a1443bb441f34102e6512b9b9b26040f46baa63');
});

test('known predicate versions reject mixed fields, unknown keys/types and substituted identities', () => {
  for (const change of [
    (s) => { s.predicateType = 'https://in-toto.io/attestation/release/v0.3'; },
    (s) => { s.predicateType = RELEASE_PREDICATE_TYPE; },
    (s) => { s.predicate.releaseId = s.predicate.databaseId; },
    (s) => { delete s.predicate.databaseId; }, (s) => { delete s.predicate.packageId; },
    (s) => { s.predicate.run_id = 37757528038; },
    ...['databaseId', 'packageId', 'ownerId', 'repositoryId'].flatMap((key) => [
      (s) => { s.predicate[key] = Number(s.predicate[key]); },
      (s) => { s.predicate[key] = '0' + s.predicate[key]; },
      (s) => { s.predicate[key] = ''; }, (s) => { s.predicate[key] = '0'; },
      (s) => { s.predicate[key] = '999'; },
    ]),
    (s) => { [s.predicate.databaseId, s.predicate.packageId] = [s.predicate.packageId, s.predicate.databaseId]; },
    (s) => { s.predicate.repository = 'foreign/repository'; },
    (s) => { s.predicate.tag += '-foreign'; }, (s) => { s.predicate.purl += '?repository_url=foreign'; },
    (s) => { s.predicate.purl += '#foreign'; }, (s) => { s.predicate.purl = s.predicate.purl.replace('@', '%40'); },
  ]) assert.throws(() => assertNativeReleaseAttestation(v02Fixture(change), v02Expected));
  assert.throws(() => assertNativeReleaseAttestation(offlineFixture((s) => { s.predicate.databaseId = s.predicate.releaseId; }), expected));
  assert.throws(() => assertNativeReleaseAttestation(offlineFixture((s) => { s.predicateType = 'https://in-toto.io/attestation/release/v0.2'; }), expected));
});

test('v0.2 still rejects altered complete subjects, signature identity and signed statement mismatch', () => {
  for (const change of [
    (s) => { s._type = 'https://in-toto.io/Statement/v2'; },
    (s) => { s.subject[0].digest.sha1 = 'a'.repeat(40); }, (s) => { s.subject[0].uri += '-foreign'; },
    (s) => { s.subject[0].digest = { sha256: 'a'.repeat(64) }; },
    (s) => { s.subject.pop(); }, (s) => { s.subject.push(s.subject[1]); },
    (s) => { s.subject[2] = globalThis.structuredClone(s.subject[1]); },
    (s) => { s.subject[1].name = 'extra.zip'; }, (s) => { s.subject[1].digest.sha256 = 'a'.repeat(64); },
  ]) assert.throws(() => assertNativeReleaseAttestation(v02Fixture(change), v02Expected));
  const mismatch = globalThis.structuredClone(genuine); mismatch.verificationResult.statement.predicate.databaseId = '999';
  assert.throws(() => assertNativeReleaseAttestation(mismatch, v02Expected), /signed envelope/);
  const foreign = globalThis.structuredClone(genuine); foreign.verificationResult.signature.certificate.subjectAlternativeName = 'https://attestations.example.invalid';
  assert.throws(() => assertNativeReleaseAttestation(foreign, v02Expected), /signature required/);
  const duplicate = globalThis.structuredClone(genuine);
  duplicate.attestation.bundle.dsseEnvelope.payload = Buffer.from('{"predicateType":"one","predicateType":"two"}').toString('base64');
  assert.throws(() => assertNativeReleaseAttestation(duplicate, v02Expected));
  const malformed = globalThis.structuredClone(genuine); malformed.attestation.bundle.dsseEnvelope.payload = Buffer.from('{').toString('base64');
  assert.throws(() => assertNativeReleaseAttestation(malformed, v02Expected));
});

test('a genuine signed native release from a failed producer does not satisfy publisher acceptance', () => {
  const statement = assertNativeReleaseAttestation(genuine, v02Expected);
  assert.equal(statement.subject.length, 6);
  const manifest = { producer: { run_id: 37757528038, run_attempt: 1, workflow_sha: v02Expected.target } };
  const run = { id: 37757528038, run_attempt: 1, head_repository: { full_name: 'git-malu/AnyWear-Service', id: 1158460323 },
    repository: { full_name: 'git-malu/AnyWear-Service', id: 1158460323, owner: { id: 11473072 } }, head_branch: 'main', head_sha: v02Expected.target,
    path: '.github/workflows/service-artifacts.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'failure' };
  assert.throws(() => assertPublisherRun(run, manifest.producer), /complete successfully/);
  assert.doesNotThrow(() => assertPublisherRun({ ...run, conclusion: 'success' }, manifest.producer));
  assert.throws(() => assertPublisherRun({ ...run, conclusion: 'success', run_attempt: 2 }, manifest.producer));
});

test('complete consumer vendor provenance matches every released Service source byte', () => {
  const p = parseStrictJson(readFileSync(new URL('./vendor/provenance.json', import.meta.url)));
  assert.equal(p.repository, 'git-malu/AnyWear-Service');
  assert.equal(p.source_sha, '6a0551b3ea83937d3ac350ee78608784bc2d9dc6');
  assert.deepEqual(Object.keys(p.files).sort(), [
    '.github/scripts/service-artifact-contract.mjs', '.github/scripts/service-release-attestation.mjs',
    '.github/fixtures/github-native-release-verification.json', '.github/fixtures/github-native-release-verification-v0.2.json',
    '.github/fixtures/README.md',
  ].sort());
  for (const entry of Object.values(p.files)) {
    assert.deepEqual(Object.keys(entry).sort(), ['sha256', 'vendored_path']);
    assert.equal(sha256(readFileSync(new URL('../' + entry.vendored_path, import.meta.url))), entry.sha256);
  }
});
