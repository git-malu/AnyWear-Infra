import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJson, sha256, canonicalJson } from './json-contract.mjs';
import { validateSelection, assertSelectionManifest, assertPublisherRun, liveArtifactIo } from './artifact-consumer.mjs';
import { validateManifest, verifyAssetBytes, SERVICE_REPOSITORY } from './vendor/service-artifact-contract.mjs';
import { assertNativeReleaseAttestation } from './vendor/service-release-attestation.mjs';
import { createPublicationCandidate } from './publication-acceptance.mjs';

export async function createCandidate(selector, { directory, managerAcceptanceUrl, io = liveArtifactIo(), now = new Date().toISOString() }) {
  validateSelection(selector); await mkdir(directory, { recursive: true });
  const release = await io.api(`repos/${SERVICE_REPOSITORY}/releases/${selector.release.id}`);
  if (release.id !== selector.release.id || release.immutable !== true || release.draft !== false || !Array.isArray(release.assets)) throw new Error('Exact sealed release required');
  const manifestBytes = await io.asset(SERVICE_REPOSITORY, selector.release.manifest_asset_id);
  if (sha256(manifestBytes) !== selector.release.manifest_sha256) throw new Error('Manifest byte hash differs');
  const manifest = validateManifest(parseJson(manifestBytes)); assertSelectionManifest(selector, manifest);
  const tag = manifest.kind === 'source-build' ? `service-artifacts-${selector.image.service_sha}` : `service-baseline-${selector.release.manifest_sha256}`;
  const target = manifest.kind === 'source-build' ? selector.image.service_sha : manifest.producer.workflow_sha;
  if (release.tag_name !== tag) throw new Error('Artifact tag differs');
  const ref = await io.api(`repos/${SERVICE_REPOSITORY}/git/ref/tags/${tag}`);
  if (ref.object?.type !== 'commit' || ref.object.sha !== target) throw new Error('Selected immutable source differs');
  const runEndpoint = `repos/${SERVICE_REPOSITORY}/actions/runs/${manifest.producer.run_id}/attempts/${manifest.producer.run_attempt}`;
  const producerRun = assertPublisherRun(await io.api(runEndpoint), manifest.producer);
  const components = [...Object.values(selector.lambdas), selector.runtime_policy, selector.schema];
  const hashes = { 'service-artifacts.json': selector.release.manifest_sha256, ...Object.fromEntries(components.map(component => [component.file, component.sha256])) };
  const expected = { releaseId: release.id, tag, target, assetHashes: hashes };
  const nativeVerification = await io.attestation(tag);
  const nativeStatement = assertNativeReleaseAttestation(nativeVerification, expected);
  const assets = {};
  for (const [id, name, hash] of [[selector.release.manifest_asset_id, 'service-artifacts.json', selector.release.manifest_sha256],
    ...components.map(component => [component.asset_id, component.file, component.sha256])]) {
    const asset = release.assets.filter(item => item.id === id && item.name === name && item.state === 'uploaded');
    if (asset.length !== 1) throw new Error('Exact publication asset unavailable');
    const bytes = name === 'service-artifacts.json' ? manifestBytes : await io.asset(SERVICE_REPOSITORY, id);
    if (sha256(bytes) !== hash || bytes.length !== asset[0].size || asset[0].digest !== `sha256:${hash}`) throw new Error('Actual publication asset ID/size/hash differs');
    const file = path.join(directory, name); await writeFile(file, bytes);
    if (canonicalJson(assertNativeReleaseAttestation(await io.attestation(tag, file), expected)) !== canonicalJson(nativeStatement)) throw new Error('Publication asset used another signed statement');
    if (name !== 'service-artifacts.json') assets[name] = bytes;
  }
  verifyAssetBytes(manifest, assets);
  const artifacts = [];
  for (let page = 1; ; page++) {
    if (page > 10) throw new Error('Publisher artifact inventory exceeds bound');
    const result = await io.api(`repos/${SERVICE_REPOSITORY}/actions/runs/${producerRun.id}/artifacts?per_page=100&page=${page}`);
    if (!Array.isArray(result.artifacts) || !Number.isSafeInteger(result.total_count) || result.total_count > 1000) throw new Error('Publication artifact inventory unavailable');
    artifacts.push(...result.artifacts);
    if (artifacts.length === result.total_count) break;
    if (result.artifacts.length !== 100 || artifacts.length > result.total_count) throw new Error('Publication artifact inventory incomplete');
  }
  const matching = artifacts.filter(item => item.name === `service-artifact-publication-${producerRun.id}-${producerRun.run_attempt}`);
  if (matching.length !== 1) throw new Error('Unique exact publication artifact required');
  const archiveBytes = await io.publicationArchive(matching[0].id);
  const receipt = createPublicationCandidate({ selector, manifest, release, producerRun, artifacts, archiveBytes,
    nativeVerification, managerAcceptanceUrl, verifiedAt: now });
  assertPublisherRun(await io.api(runEndpoint), manifest.producer);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = name => process.argv[process.argv.indexOf(name) + 1];
  for (const name of ['--selection', '--output', '--manager-acceptance-url']) if (!process.argv.includes(name)) throw new Error(`${name} required`);
  const selector = parseJson(await readFile(option('--selection')));
  const receipt = await createCandidate(selector, { directory: '.service-artifacts/handshake', managerAcceptanceUrl: option('--manager-acceptance-url') });
  const bytes = Buffer.from(canonicalJson(receipt)); await writeFile(option('--output'), bytes);
  process.stdout.write(`${JSON.stringify({ candidate_only: true, sha256: sha256(bytes), file: selector.publication_acceptance.file,
    next_step: 'Manager reviews first-hand handshake, then reviews and authorizes the exact Infra receipt commit. This candidate grants no deployment authority.' })}\n`);
}
