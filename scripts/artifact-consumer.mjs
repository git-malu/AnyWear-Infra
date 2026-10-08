import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJson, canonicalJson, sha256, exact, matches, integer, HASH } from './json-contract.mjs';
import { validateManifest, verifyAssetBytes, SERVICE_REPOSITORY } from './vendor/service-artifact-contract.mjs';
import { assertNativeReleaseAttestation } from './vendor/service-release-attestation.mjs';
import { loadPublicationAcceptance } from './publication-acceptance.mjs';

const execute = promisify(execFile);
export function validateSelection(selector) {
  exact(selector, ['schema_version', 'record_type', 'release', 'publication_acceptance', 'image', 'lambdas', 'runtime_policy', 'schema'], 'Infra selection');
  if (selector.schema_version !== 1 || selector.record_type !== 'anywear_infra_selection') throw new Error('Unknown selection schema');
  exact(selector.release, ['repository', 'id', 'manifest_asset_id', 'manifest_sha256'], 'selected release');
  if (selector.release.repository !== SERVICE_REPOSITORY) throw new Error('Unexpected Service artifact repository');
  integer(selector.release.id, 'release ID'); integer(selector.release.manifest_asset_id, 'manifest ID'); matches(selector.release.manifest_sha256, HASH, 'manifest SHA256');
  exact(selector.publication_acceptance, ['file', 'sha256'], 'publication acceptance');
  if (selector.publication_acceptance.file !== `publications/${selector.release.manifest_sha256}.json`) throw new Error('Receipt path must bind the selected manifest');
  matches(selector.publication_acceptance.sha256, HASH, 'receipt byte hash');
  exact(selector.lambdas, ['pre_sign_up', 'post_confirmation'], 'selected Lambdas');
  const ids = [selector.release.manifest_asset_id];
  for (const component of [...Object.values(selector.lambdas), selector.runtime_policy, selector.schema]) {
    integer(component?.asset_id, 'component asset ID'); ids.push(component.asset_id);
  }
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate selected asset IDs');
  // A complete Service validator enforces the same fields/provenance on selector
  // expectations after removing only the external release asset identity.
  const stripId = component => { const copy = { ...component }; delete copy.asset_id; return copy; };
  const components = { image: selector.image, lambdas: Object.fromEntries(Object.entries(selector.lambdas).map(([k, v]) => [k, stripId(v)])),
    runtime_policy: stripId(selector.runtime_policy), schema: stripId(selector.schema) };
  validateManifest({ schema_version: 1, record_type: 'anywear_service_artifacts',
    kind: components.image.original_evidence ? 'deployed-baseline-import' : 'source-build',
    producer: { repository: SERVICE_REPOSITORY, workflow_sha: components.image.service_sha,
      workflow_ref: `${SERVICE_REPOSITORY}/.github/workflows/service-artifacts.yml@refs/heads/main`, run_id: 1, run_attempt: 1 }, components });
  return selector;
}
export function assertSelectionManifest(selector, manifest) {
  validateSelection(selector); validateManifest(manifest);
  const stripId = component => { const copy = { ...component }; delete copy.asset_id; return copy; };
  const expected = { image: selector.image, lambdas: Object.fromEntries(Object.entries(selector.lambdas).map(([k, v]) => [k, stripId(v)])),
    runtime_policy: stripId(selector.runtime_policy), schema: stripId(selector.schema) };
  if (canonicalJson(expected) !== canonicalJson(manifest.components)) throw new Error('Selected components differ from immutable manifest');
}
export function liveArtifactIo() {
  return {
    async api(endpoint) { return parseJson((await execute('gh', ['api', endpoint], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 })).stdout); },
    async asset(repository, id) {
      if (!process.env.GH_TOKEN) throw new Error('Read-only GitHub App GH_TOKEN required for private artifact access');
      const response = await fetch(`https://api.github.com/repos/${repository}/releases/assets/${id}`, {
        headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Exact release asset retrieval failed (${response.status})`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > 100 * 1024 * 1024) throw new Error('Release asset size invalid');
      return bytes;
    },
    async attestation(tag, file) {
      return parseJson((await execute('gh', ['release', file ? 'verify-asset' : 'verify', tag, ...(file ? [file] : []), '--repo', SERVICE_REPOSITORY, '--format', 'json'],
        { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout);
    },
    async publicationArchive(id) {
      integer(id, 'publication artifact ID');
      if (!process.env.GH_TOKEN) throw new Error('Read-only private artifact token required');
      const response = await fetch(`https://api.github.com/repos/${SERVICE_REPOSITORY}/actions/artifacts/${id}/zip`, {
        headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(60_000) });
      if (!response.ok || !response.body) throw new Error('Exact publication archive retrieval failed');
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length;
        if (size > 2 * 1024 * 1024) throw new Error('Publication archive exceeds bound'); chunks.push(Buffer.from(next.value)); }
      } finally { await reader.cancel(); }
      return Buffer.concat(chunks);
    },
  };
}
export function assertPublisherRun(run, producer) {
  if (run.id !== producer.run_id || run.run_attempt !== producer.run_attempt || run.head_sha !== producer.workflow_sha
    || run.head_branch !== 'main' || run.path !== '.github/workflows/service-artifacts.yml' || run.event !== 'workflow_dispatch'
    || run.repository?.full_name !== SERVICE_REPOSITORY || run.repository.id !== 1158460323 || run.repository.owner?.id !== 11473072
    || run.head_repository?.full_name !== SERVICE_REPOSITORY || run.head_repository.id !== 1158460323
    || run.status !== 'completed' || run.conclusion !== 'success') throw new Error('Trusted publisher run must complete successfully');
  return run;
}
export async function verifySelection(selector, directory, io = liveArtifactIo(), { trustedInfraRoot, expectedInfraSha } = {}) {
  validateSelection(selector); await mkdir(directory, { recursive: true });
  const release = await io.api(`repos/${SERVICE_REPOSITORY}/releases/${selector.release.id}`);
  if (release.id !== selector.release.id || release.immutable !== true || release.draft !== false || !Array.isArray(release.assets)) throw new Error('Selected release is not sealed immutable');
  const selected = [...Object.values(selector.lambdas), selector.runtime_policy, selector.schema];
  const assetNames = ['service-artifacts.json', ...selected.map(item => item.file)].sort();
  if (release.assets.length !== assetNames.length || JSON.stringify(release.assets.map(item => item.name).sort()) !== JSON.stringify(assetNames)) throw new Error('Unexpected or duplicate release assets');
  const manifestAsset = release.assets.filter(asset => asset.id === selector.release.manifest_asset_id);
  if (manifestAsset.length !== 1 || manifestAsset[0].name !== 'service-artifacts.json' || manifestAsset[0].state !== 'uploaded') throw new Error('Exact manifest asset unavailable');
  const manifestBytes = await io.asset(SERVICE_REPOSITORY, selector.release.manifest_asset_id);
  if (sha256(manifestBytes) !== selector.release.manifest_sha256) throw new Error('Manifest byte hash mismatch');
  const manifest = validateManifest(parseJson(manifestBytes)); assertSelectionManifest(selector, manifest);
  const producer = manifest.producer;
  const tag = manifest.kind === 'source-build' ? `service-artifacts-${manifest.components.image.service_sha}` : `service-baseline-${selector.release.manifest_sha256}`;
  if (release.tag_name !== tag) throw new Error('Release tag does not bind selected artifact kind');
  const gitRef = await io.api(`repos/${SERVICE_REPOSITORY}/git/ref/tags/${tag}`);
  const source = manifest.kind === 'source-build' ? manifest.components.image.service_sha : producer.workflow_sha;
  if (gitRef.object?.type !== 'commit' || gitRef.object.sha !== source) throw new Error('Immutable tag source binding mismatch');
  const run = await io.api(`repos/${SERVICE_REPOSITORY}/actions/runs/${producer.run_id}/attempts/${producer.run_attempt}`);
  assertPublisherRun(run, producer);
  const assetHashes = { 'service-artifacts.json': selector.release.manifest_sha256, ...Object.fromEntries(selected.map(component => [component.file, component.sha256])) };
  const nativeExpected = { releaseId: release.id, tag, target: source, assetHashes };
  const nativeVerification = await io.attestation(tag);
  const signed = assertNativeReleaseAttestation(nativeVerification, nativeExpected);
  const manifestPath = path.join(directory, 'service-artifacts.json'); await writeFile(manifestPath, manifestBytes);
  if (canonicalJson(assertNativeReleaseAttestation(await io.attestation(tag, manifestPath), nativeExpected)) !== canonicalJson(signed)) throw new Error('Manifest verified against a different native statement');
  const receipt = await (io.loadPublicationAcceptance ?? loadPublicationAcceptance)(selector, { trustedInfraRoot, expectedInfraSha, manifest, release, nativeVerification });
  const assets = {};
  for (const component of selected) {
    const found = release.assets.filter(asset => asset.id === component.asset_id && asset.name === component.file && asset.state === 'uploaded');
    if (found.length !== 1) throw new Error('Selected component asset ID/name is unavailable');
    const bytes = await io.asset(SERVICE_REPOSITORY, component.asset_id);
    if (sha256(bytes) !== component.sha256) throw new Error(`Asset bytes differ: ${component.file}`);
    const file = path.join(directory, component.file); await writeFile(file, bytes);
    if (canonicalJson(assertNativeReleaseAttestation(await io.attestation(tag, file), nativeExpected)) !== canonicalJson(signed)) throw new Error('Asset verified against a different native statement');
    assets[component.file] = bytes;
  }
  const verified = verifyAssetBytes(manifest, assets);
  await writeFile(path.join(directory, 'selection.json'), `${JSON.stringify(selector, null, 2)}\n`);
  assertPublisherRun(await io.api(`repos/${SERVICE_REPOSITORY}/actions/runs/${producer.run_id}/attempts/${producer.run_attempt}`), producer);
  return { manifest, ...verified, receipt, directory };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = name => process.argv[process.argv.indexOf(name) + 1];
  if (!process.argv.includes('--selection') || !process.argv.includes('--output-dir')) throw new Error('Usage: --selection <file> --output-dir <directory>');
  if (!process.argv.includes('--trusted-infra-root') || !process.argv.includes('--infra-sha')) throw new Error('Explicit trusted Infra root and immutable SHA required');
  await verifySelection(parseJson(await readFile(option('--selection'))), path.resolve(option('--output-dir')), undefined,
    { trustedInfraRoot: path.resolve(option('--trusted-infra-root')), expectedInfraSha: option('--infra-sha') });
}
