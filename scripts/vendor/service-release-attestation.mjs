import { Buffer } from 'node:buffer';
import { SERVICE_REPOSITORY, parseStrictJson, canonicalJson, exactKeys, positiveInteger } from './service-artifact-contract.mjs';

export const RELEASE_PREDICATE_TYPE = 'https://in-toto.io/attestation/release/v0.1';

// This validates the successful `gh release verify[ -asset] --format json`
// result. Cryptographic verification belongs to gh's GitHub release policy,
// whose certificate SAN is https://dotcom.releases.github.com. The native signed
// statement binds release/tag/assets; it does not bind workflow/run/attempt.
export function assertNativeReleaseAttestation(verified, { releaseId, tag, target, assetHashes }) {
  positiveInteger(releaseId, 'native release ID');
  if (typeof tag !== 'string' || !/^[a-f0-9]{40}$/.test(target ?? '') || !assetHashes || Array.isArray(assetHashes)
    || Object.keys(assetHashes).length === 0 || Object.values(assetHashes).some((hash) => !/^[a-f0-9]{64}$/.test(hash))) throw new Error('Exact native release verification inputs required');
  const result = verified?.verificationResult;
  const envelope = verified?.attestation?.bundle?.dsseEnvelope;
  if (result?.signature?.certificate?.subjectAlternativeName !== 'https://dotcom.releases.github.com'
    || typeof envelope?.payload !== 'string' || envelope.payloadType !== 'application/vnd.in-toto+json'
    || !Array.isArray(envelope.signatures) || envelope.signatures.length === 0) throw new Error('Verified native GitHub release signature required');
  const statement = result.statement;
  if (canonicalJson(parseStrictJson(Buffer.from(envelope.payload, 'base64'))) !== canonicalJson(statement)) throw new Error('Native verified statement differs from signed envelope');
  exactKeys(statement, ['_type', 'predicateType', 'predicate', 'subject'], [], 'native release statement');
  const purl = `pkg:github/${SERVICE_REPOSITORY}@${tag}`;
  const predicate = { ownerId: '11473072', repositoryId: '1158460323', repository: SERVICE_REPOSITORY,
    releaseId: String(releaseId), purl, tag };
  if (statement._type !== 'https://in-toto.io/Statement/v1' || statement.predicateType !== RELEASE_PREDICATE_TYPE
    || canonicalJson(statement.predicate) !== canonicalJson(predicate)) throw new Error('Native release repository/owner/ID/tag differs');
  if (!Array.isArray(statement.subject) || statement.subject.length !== Object.keys(assetHashes).length + 1) throw new Error('Native release subject set differs');
  const expected = [{ uri: purl, digest: { sha1: target } },
    ...Object.entries(assetHashes).map(([name, hash]) => ({ name, digest: { sha256: hash } }))].map(canonicalJson).sort();
  const actual = statement.subject.map(canonicalJson).sort();
  if (new Set(actual).size !== actual.length || canonicalJson(actual) !== canonicalJson(expected)) throw new Error('Native release target or complete asset name/hash set differs');
  return statement;
}
