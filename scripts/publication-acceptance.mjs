import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { parseJson, canonicalJson, contentHash, sha256, exact, matches, integer, HASH, SHA } from './json-contract.mjs';
import { validateManifest, SERVICE_REPOSITORY } from './vendor/service-artifact-contract.mjs';
import { assertNativeReleaseAttestation } from './vendor/service-release-attestation.mjs';

const execute = promisify(execFile);
export const PUBLICATION_RECORD_FILE = 'service-artifact-publication.json';
export const MAX_PUBLICATION_ARCHIVE_BYTES = 2 * 1024 * 1024;
export const MAX_PUBLICATION_RECORD_BYTES = 256 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const equal = (actual, expected, label) => {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} differs from trusted publication`);
};

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validateExtra(bytes) {
  const ids = new Set();
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) throw new Error('Truncated ZIP extra field');
    const id = bytes.readUInt16LE(offset); const size = bytes.readUInt16LE(offset + 2); offset += 4;
    if (offset + size > bytes.length || ids.has(id) || [0x0001, 0x7075].includes(id)) throw new Error('Unsupported or duplicate ZIP extra field');
    ids.add(id); offset += size;
  }
}

// Parse one bounded archive directly in memory. Never extract paths or invoke a
// shell/unzip utility. GitHub's normal store/deflate and data-descriptor variants
// are supported; split archives, ZIP64 and alternate path encodings are rejected.
export function decodePublicationArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > MAX_PUBLICATION_ARCHIVE_BYTES) throw new Error('Publication ZIP archive size invalid');
  const end = bytes.length - 22;
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 20) !== 0
    || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0
    || bytes.readUInt16LE(end + 8) !== 1 || bytes.readUInt16LE(end + 10) !== 1) throw new Error('Publication ZIP requires one entry, one disk and no archive comment');
  const centralSize = bytes.readUInt32LE(end + 12); const centralOffset = bytes.readUInt32LE(end + 16);
  if (centralSize < 46 || centralOffset + centralSize !== end || centralOffset < 30 || centralOffset + 46 > end
    || bytes.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error('Publication ZIP central directory bounds invalid');
  const flags = bytes.readUInt16LE(centralOffset + 8); const method = bytes.readUInt16LE(centralOffset + 10);
  const expectedCrc = bytes.readUInt32LE(centralOffset + 16); const compressedSize = bytes.readUInt32LE(centralOffset + 20);
  const recordSize = bytes.readUInt32LE(centralOffset + 24); const nameSize = bytes.readUInt16LE(centralOffset + 28);
  const extraSize = bytes.readUInt16LE(centralOffset + 30); const commentSize = bytes.readUInt16LE(centralOffset + 32);
  const unixType = (bytes.readUInt32LE(centralOffset + 38) >>> 16) & 0xf000;
  if (flags & ~0x080e || ![0, 8].includes(method) || method === 0 && flags & 6 || bytes.readUInt16LE(centralOffset + 6) > 20
    || bytes.readUInt16LE(centralOffset + 34) !== 0 || bytes.readUInt32LE(centralOffset + 42) !== 0
    || unixType !== 0 && unixType !== 0x8000 || bytes.readUInt32LE(centralOffset + 38) & 0x10
    || compressedSize < 1 || compressedSize > MAX_PUBLICATION_ARCHIVE_BYTES || recordSize < 2 || recordSize > MAX_PUBLICATION_RECORD_BYTES
    || centralSize !== 46 + nameSize + extraSize + commentSize || commentSize !== 0) throw new Error('Unsupported publication ZIP entry');
  const name = bytes.subarray(centralOffset + 46, centralOffset + 46 + nameSize);
  if (!name.equals(Buffer.from(PUBLICATION_RECORD_FILE))) throw new Error('Publication ZIP contains an unexpected path');
  validateExtra(bytes.subarray(centralOffset + 46 + nameSize, centralOffset + centralSize));
  if (bytes.readUInt32LE(0) !== 0x04034b50 || bytes.readUInt16LE(4) !== bytes.readUInt16LE(centralOffset + 6)
    || bytes.readUInt16LE(6) !== flags || bytes.readUInt16LE(8) !== method || bytes.readUInt16LE(26) !== nameSize) throw new Error('Publication ZIP local/central headers differ');
  const localExtraSize = bytes.readUInt16LE(28); const dataOffset = 30 + nameSize + localExtraSize;
  if (dataOffset > centralOffset || dataOffset + compressedSize > centralOffset || !bytes.subarray(30, 30 + nameSize).equals(name)) throw new Error('Publication ZIP local entry bounds differ');
  validateExtra(bytes.subarray(30 + nameSize, dataOffset));
  const localCrc = bytes.readUInt32LE(14); const localCompressed = bytes.readUInt32LE(18); const localSize = bytes.readUInt32LE(22);
  let dataEnd = dataOffset + compressedSize;
  if (flags & 8) {
    if (![0, expectedCrc].includes(localCrc) || ![0, compressedSize].includes(localCompressed) || ![0, recordSize].includes(localSize)) throw new Error('Publication ZIP descriptor header mismatch');
    if (dataEnd + 12 > centralOffset) throw new Error('Publication ZIP descriptor truncated');
    if (bytes.readUInt32LE(dataEnd) === 0x08074b50) dataEnd += 4;
    if (dataEnd + 12 !== centralOffset || bytes.readUInt32LE(dataEnd) !== expectedCrc
      || bytes.readUInt32LE(dataEnd + 4) !== compressedSize || bytes.readUInt32LE(dataEnd + 8) !== recordSize) throw new Error('Publication ZIP data descriptor mismatch');
    dataEnd += 12;
  } else if (localCrc !== expectedCrc || localCompressed !== compressedSize || localSize !== recordSize) throw new Error('Publication ZIP local size/CRC mismatch');
  if (dataEnd !== centralOffset) throw new Error('Publication ZIP has undeclared entry data');
  const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize); let recordBytes;
  if (method === 0) recordBytes = Buffer.from(compressed);
  else {
    const result = inflateRawSync(compressed, { maxOutputLength: MAX_PUBLICATION_RECORD_BYTES, info: true });
    if (result.engine.bytesWritten !== compressedSize) throw new Error('Publication ZIP deflate stream has trailing bytes');
    recordBytes = result.buffer;
  }
  if (recordBytes.length !== recordSize || crc32(recordBytes) !== expectedCrc) throw new Error('Publication ZIP content size/CRC mismatch');
  return { publicationRecord: parseJson(recordBytes), recordBytes, archiveSha256: sha256(bytes) };
}

function expectedPublication(selector, manifest, release) {
  validateManifest(manifest);
  exact(selector.release, ['repository', 'id', 'manifest_asset_id', 'manifest_sha256'], 'selected release');
  if (selector.release.repository !== SERVICE_REPOSITORY) throw new Error('Unexpected publication repository');
  integer(selector.release.id, 'selected release ID'); integer(selector.release.manifest_asset_id, 'selected manifest ID');
  matches(selector.release.manifest_sha256, HASH, 'selected manifest hash');
  const stripId = component => { const copy = { ...component }; delete copy.asset_id; return copy; };
  equal({ image: selector.image, lambdas: Object.fromEntries(Object.entries(selector.lambdas).map(([name, component]) => [name, stripId(component)])),
    runtime_policy: stripId(selector.runtime_policy), schema: stripId(selector.schema) }, manifest.components, 'Manifest selection');
  const tag = manifest.kind === 'source-build' ? `service-artifacts-${manifest.components.image.service_sha}` : `service-baseline-${selector.release.manifest_sha256}`;
  const target = manifest.kind === 'source-build' ? manifest.components.image.service_sha : manifest.producer.workflow_sha;
  if (release.id !== selector.release.id || release.immutable !== true || release.draft !== false || release.tag_name !== tag || !Array.isArray(release.assets)) {
    throw new Error('Live sealed release identity differs from selected publication');
  }
  const expectedAssets = [{ id: selector.release.manifest_asset_id, name: 'service-artifacts.json', sha256: selector.release.manifest_sha256 },
    ...[...Object.values(selector.lambdas), selector.runtime_policy, selector.schema].map(component => ({ id: component.asset_id, name: component.file, sha256: component.sha256 }))];
  if (release.assets.length !== expectedAssets.length || new Set(expectedAssets.map(asset => asset.id)).size !== expectedAssets.length
    || new Set(expectedAssets.map(asset => asset.name)).size !== expectedAssets.length) throw new Error('Publication asset set is incomplete or duplicated');
  const assets = expectedAssets.map(expected => {
    integer(expected.id, 'selected asset ID'); matches(expected.sha256, HASH, 'selected asset hash');
    const actual = release.assets.filter(asset => asset.id === expected.id && asset.name === expected.name);
    if (actual.length !== 1 || actual[0].state !== 'uploaded' || actual[0].digest !== `sha256:${expected.sha256}`) throw new Error('Live publication asset ID/name/hash differs');
    integer(actual[0].size, 'published asset size'); if (actual[0].size > MAX_ASSET_BYTES) throw new Error('Published asset size exceeds retrieval bound');
    return { ...expected, size: actual[0].size };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { id: release.id, tag, target, manifest_asset_id: selector.release.manifest_asset_id, manifest_sha256: selector.release.manifest_sha256, assets };
}

function validatePublicationRecord(record, expected, manifest) {
  exact(record, ['schema_version', 'record_type', 'repository', 'release_id', 'manifest_asset_id', 'manifest_sha256', 'tag', 'target',
    'producer', 'assets', 'release_attestation', 'native_release_statement_sha256'], 'publication record');
  if (record.schema_version !== 1 || record.record_type !== 'anywear_service_artifact_publication' || record.repository !== SERVICE_REPOSITORY) throw new Error('Unsupported publication record');
  equal(record.producer, manifest.producer, 'Publication producer');
  equal({ id: record.release_id, tag: record.tag, target: record.target, manifest_asset_id: record.manifest_asset_id, manifest_sha256: record.manifest_sha256 },
    { id: expected.id, tag: expected.tag, target: expected.target, manifest_asset_id: expected.manifest_asset_id, manifest_sha256: expected.manifest_sha256 }, 'Publication release');
  equal(record.assets, Object.fromEntries(expected.assets.map(({ id, name, sha256: hash, size }) => [name, { id, size, sha256: hash }])), 'Publication complete asset IDs/hashes/sizes');
  const statement = assertNativeReleaseAttestation(record.release_attestation, { releaseId: expected.id, tag: expected.tag, target: expected.target,
    assetHashes: Object.fromEntries(expected.assets.map(asset => [asset.name, asset.sha256])) });
  matches(record.native_release_statement_sha256, HASH, 'native statement hash');
  if (contentHash(statement) !== record.native_release_statement_sha256) throw new Error('Native publication statement hash differs');
  return statement;
}

export function validatePublicationAcceptance(receipt, { selector, manifest, release, publicationRecord, nativeVerification } = {}) {
  exact(receipt, ['schema_version', 'record_type', 'repository', 'producer', 'release', 'publication', 'manager_acceptance_url', 'verified_at'], 'publication acceptance');
  if (receipt.schema_version !== 1 || receipt.record_type !== 'anywear_service_publication_acceptance') throw new Error('Unknown publication acceptance schema');
  equal(receipt.repository, { name: SERVICE_REPOSITORY, id: 1158460323, owner_id: 11473072 }, 'Service repository identity');
  const expected = expectedPublication(selector, manifest, release);
  equal(receipt.producer, manifest.producer, 'Accepted producer'); equal(receipt.release, expected, 'Accepted complete release');
  exact(receipt.publication, ['artifact_id', 'artifact_name', 'archive_sha256', 'record_sha256', 'record_base64'], 'accepted publication artifact');
  integer(receipt.publication.artifact_id, 'publication artifact ID'); matches(receipt.publication.archive_sha256, HASH, 'publication archive hash');
  matches(receipt.publication.record_sha256, HASH, 'publication record hash');
  if (receipt.publication.artifact_name !== `service-artifact-publication-${manifest.producer.run_id}-${manifest.producer.run_attempt}`) throw new Error('Publication artifact name differs from exact producer attempt');
  const base64 = receipt.publication.record_base64;
  if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_PUBLICATION_RECORD_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('Publication raw record base64 invalid');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 2 || bytes.length > MAX_PUBLICATION_RECORD_BYTES || bytes.toString('base64') !== base64 || sha256(bytes) !== receipt.publication.record_sha256) throw new Error('Publication exact raw bytes/hash differ');
  const retained = parseJson(bytes); if (publicationRecord) equal(publicationRecord, retained, 'Retained publication record');
  const statement = validatePublicationRecord(retained, expected, manifest);
  if (nativeVerification) equal(assertNativeReleaseAttestation(nativeVerification, { releaseId: expected.id, tag: expected.tag, target: expected.target,
    assetHashes: Object.fromEntries(expected.assets.map(asset => [asset.name, asset.sha256])) }), statement, 'First-hand native release statement');
  matches(receipt.manager_acceptance_url, /^https:\/\/github\.com\/git-malu\/AnyWear\/issues\/[1-9][0-9]*#issuecomment-[1-9][0-9]*$/, 'manager acceptance URL');
  matches(receipt.verified_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/, 'publication verification timestamp');
  if (!Number.isFinite(Date.parse(receipt.verified_at))) throw new Error('Invalid publication verification time');
  // This URL is evidence, not authority. Acceptance requires the caller's
  // reviewed immutable Infra pin and clean tracked-byte loader below.
  return receipt;
}

export function createPublicationCandidate({ selector, manifest, release, producerRun, artifacts, archiveBytes, nativeVerification, managerAcceptanceUrl, verifiedAt }) {
  const expected = expectedPublication(selector, manifest, release); const producer = manifest.producer;
  if (producerRun.id !== producer.run_id || producerRun.run_attempt !== producer.run_attempt || producerRun.head_sha !== producer.workflow_sha
    || producerRun.repository?.full_name !== SERVICE_REPOSITORY || producerRun.head_repository?.full_name !== SERVICE_REPOSITORY
    || producerRun.repository?.id !== 1158460323 || producerRun.repository?.owner?.id !== 11473072 || producerRun.head_repository?.id !== 1158460323
    || producerRun.head_repository?.owner?.id !== 11473072
    || producerRun.head_branch !== 'main' || producerRun.path !== '.github/workflows/service-artifacts.yml' || producerRun.event !== 'workflow_dispatch'
    || producerRun.status !== 'completed' || producerRun.conclusion !== 'success') throw new Error('Publication candidate requires exact trusted completed-success producer');
  const name = `service-artifact-publication-${producer.run_id}-${producer.run_attempt}`;
  if (!Array.isArray(artifacts)) throw new Error('Authenticated publication artifact inventory required');
  const matching = artifacts.filter(artifact => artifact.name === name);
  if (matching.length !== 1) throw new Error('Exactly one publication artifact for the trusted attempt is required');
  const artifact = matching[0]; integer(artifact.id, 'publication artifact ID');
  const verifiedTime = Date.parse(verifiedAt); const start = Date.parse(producerRun.run_started_at); const end = Date.parse(producerRun.updated_at);
  const created = Date.parse(artifact.created_at); const expires = Date.parse(artifact.expires_at);
  if (![verifiedTime, start, end, created, expires].every(Number.isFinite) || start > end || verifiedTime < end || created < start || created > end
    || artifact.expired !== false || expires <= verifiedTime || artifact.workflow_run?.id !== producer.run_id
    || artifact.workflow_run?.head_sha !== producer.workflow_sha) throw new Error('Publication artifact attempt interval, lifetime or source differs');
  integer(artifact.size_in_bytes, 'publication archive API size');
  if (artifact.size_in_bytes !== archiveBytes.length || artifact.size_in_bytes > MAX_PUBLICATION_ARCHIVE_BYTES) throw new Error('Publication archive API byte size differs');
  const decoded = decodePublicationArchive(archiveBytes);
  if (artifact.digest !== `sha256:${decoded.archiveSha256}`) throw new Error('Publication archive authenticated digest differs');
  if (!nativeVerification) throw new Error('First-hand successful native release verification required');
  const receipt = { schema_version: 1, record_type: 'anywear_service_publication_acceptance', repository: { name: SERVICE_REPOSITORY, id: 1158460323, owner_id: 11473072 },
    producer: manifest.producer, release: expected, publication: { artifact_id: artifact.id, artifact_name: name, archive_sha256: decoded.archiveSha256,
      record_sha256: sha256(decoded.recordBytes), record_base64: decoded.recordBytes.toString('base64') }, manager_acceptance_url: managerAcceptanceUrl, verified_at: verifiedAt };
  // A candidate is only a review input. This function neither writes a tracked
  // receipt nor returns an accepted selector or any deployment authorization.
  return validatePublicationAcceptance(receipt, { selector, manifest, release, publicationRecord: decoded.publicationRecord, nativeVerification });
}

export async function loadPublicationAcceptance(selector, { trustedInfraRoot, expectedInfraSha, manifest, release, nativeVerification } = {}) {
  if (typeof trustedInfraRoot !== 'string' || !path.isAbsolute(trustedInfraRoot)) throw new Error('Explicit absolute trusted Infra root required');
  matches(expectedInfraSha, SHA, 'reviewed Infra commit');
  exact(selector.publication_acceptance, ['file', 'sha256'], 'publication acceptance selection');
  const selected = selector.publication_acceptance;
  if (selected.file !== `publications/${selector.release.manifest_sha256}.json`) throw new Error('Publication receipt path must bind the exact selected manifest');
  matches(selected.sha256, HASH, 'selected receipt hash');
  const root = await realpath(trustedInfraRoot);
  // Replacement refs must not substitute a different tree for the reviewed SHA.
  const git = async args => (await execute('git', ['--no-replace-objects', '-C', root, ...args], { encoding: 'buffer', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
  const text = async args => (await git(args)).toString('utf8').trim();
  if (path.resolve(await text(['rev-parse', '--show-toplevel'])) !== root || await text(['rev-parse', 'HEAD']) !== expectedInfraSha) throw new Error('Trusted Infra root/HEAD differs from the reviewed immutable pin');
  const origin = await text(['remote', 'get-url', 'origin']);
  if (!['https://github.com/git-malu/AnyWear-Infra', 'https://github.com/git-malu/AnyWear-Infra.git', 'git@github.com:git-malu/AnyWear-Infra.git'].includes(origin)) throw new Error('Trusted Infra checkout origin differs');
  if ((await git(['status', '--porcelain=v1', '--untracked-files=all'])).length !== 0) throw new Error('Trusted Infra source must be clean before publication acceptance');
  const tree = (await git(['ls-tree', '-z', expectedInfraSha, '--', selected.file])).toString('utf8');
  if (!new RegExp(`^100644 blob [a-f0-9]{40}\\t${selected.file.replaceAll('.', '\\.')}\\x00$`).test(tree)) throw new Error('Publication receipt must be a tracked regular blob in the reviewed Infra commit');
  const file = path.join(root, selected.file); const directory = path.dirname(file);
  if ((await realpath(directory)) !== directory || (await lstat(file)).isSymbolicLink() || !(await lstat(file)).isFile()) throw new Error('Publication receipt path traverses a link or non-file');
  const stat = await lstat(file); if (stat.size < 2 || stat.size > MAX_RECEIPT_BYTES) throw new Error('Publication receipt byte size invalid');
  const bytes = await readFile(file); const committed = await git(['cat-file', 'blob', `${expectedInfraSha}:${selected.file}`]);
  if (!bytes.equals(committed) || sha256(bytes) !== selected.sha256) throw new Error('Tracked publication receipt bytes differ from reviewed commit/hash');
  // The pin is supplied by protected Infra main + its exact manager window, or
  // by E2E's reviewed compatibility input. Never derive it from this receipt,
  // an arbitrary branch, the selector itself, or the working directory's HEAD.
  if (await text(['rev-parse', 'HEAD']) !== expectedInfraSha || (await git(['status', '--porcelain=v1', '--untracked-files=all'])).length !== 0) throw new Error('Trusted Infra source changed during publication acceptance');
  return validatePublicationAcceptance(parseJson(bytes), { selector, manifest, release, nativeVerification });
}
