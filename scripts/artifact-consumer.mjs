import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, realpath, lstat, mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJson, canonicalJson, sha256, exact, matches, integer, HASH, SHA } from './json-contract.mjs';
import { validateManifest, verifyAssetBytes, SERVICE_REPOSITORY } from './vendor/service-artifact-contract.mjs';
import { assertNativeReleaseAttestation } from './vendor/service-release-attestation.mjs';

const execute = promisify(execFile);
export function validateSelection(selector) {
  if (selector?.schema_version !== 2 || selector.record_type !== 'anywear_infra_selection') throw new Error('Unknown selection schema; historical v1 is not a direct-verification input');
  exact(selector, ['schema_version', 'record_type', 'release', 'image', 'lambdas', 'runtime_policy', 'schema'], 'Infra selection');
  exact(selector.release, ['repository', 'id', 'manifest_asset_id', 'manifest_sha256'], 'selected release');
  if (selector.release.repository !== SERVICE_REPOSITORY) throw new Error('Unexpected Service artifact repository');
  integer(selector.release.id, 'release ID'); integer(selector.release.manifest_asset_id, 'manifest ID'); matches(selector.release.manifest_sha256, HASH, 'manifest SHA256');
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
export function commandEnvironment(env, configDirectory, token) {
  const out = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (typeof env[key] === 'string') out[key] = env[key];
  }
  out.GH_HOST = 'github.com'; out.GH_CONFIG_DIR = configDirectory; out.GH_PROMPT_DISABLED = '1';
  // The supported opt-out prevents CLI 2.101.0 from creating a relative
  // telemetry device-id in cwd when the sanitized child has no HOME.
  out.GH_TELEMETRY = 'disabled';
  out.GIT_CONFIG_NOSYSTEM = '1'; out.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  if (token !== undefined) {
    if (typeof token !== 'string' || !token) throw new Error('Explicit read-only Service token required');
    out.GH_TOKEN = token;
  }
  return out;
}
export async function loadCommittedSelection({ trustedInfraRoot, expectedInfraSha, selectionFile, selectionSha256 } = {}) {
  if (typeof trustedInfraRoot !== 'string' || !path.isAbsolute(trustedInfraRoot)) throw new Error('Explicit absolute trusted Infra root required');
  matches(expectedInfraSha, SHA, 'reviewed Infra commit'); matches(selectionSha256, HASH, 'selection byte hash');
  if (!/^selections\/[a-z0-9][a-z0-9._-]{0,127}\.json$/.test(selectionFile ?? '')) throw new Error('Committed relative selection path required');
  const root = await realpath(trustedInfraRoot);
  const git = async args => (await execute('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', root, ...args],
    { encoding: 'buffer', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: commandEnvironment(process.env, '') })).stdout;
  const text = async args => (await git(args)).toString('utf8').trim();
  const assertSource = async () => {
    if (path.resolve(await text(['rev-parse', '--show-toplevel'])) !== root || await text(['rev-parse', 'HEAD']) !== expectedInfraSha) throw new Error('Trusted Infra root/HEAD differs from reviewed pin');
    if (!['https://github.com/git-malu/AnyWear-Infra', 'https://github.com/git-malu/AnyWear-Infra.git', 'git@github.com:git-malu/AnyWear-Infra.git'].includes(await text(['remote', 'get-url', 'origin']))) throw new Error('Trusted Infra origin differs');
    if ((await git(['status', '--porcelain=v1', '--untracked-files=all'])).length || (await git(['for-each-ref', '--format=%(refname)', 'refs/replace'])).length
      || (await git(['ls-files', '-v', '-z'])).toString('utf8').split('\0').filter(Boolean).some(line => !line.startsWith('H '))) throw new Error('Trusted Infra source must be clean without replacement or hidden-index masking');
  };
  await assertSource();
  const tree = (await git(['ls-tree', '-z', expectedInfraSha, '--', selectionFile])).toString('utf8').match(/^100644 blob ([a-f0-9]{40})\t([^\0]+)\0$/);
  if (!tree || tree[2] !== selectionFile) throw new Error('Selection must be a tracked regular blob in reviewed Infra commit');
  const file = path.join(root, selectionFile); const stat = await lstat(file);
  if (await realpath(path.dirname(file)) !== path.dirname(file) || !stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 1024 * 1024) throw new Error('Selection path traverses a link/non-file or exceeds bound');
  const bytes = await readFile(file); const committed = await git(['cat-file', 'blob', `${expectedInfraSha}:${selectionFile}`]);
  if (!bytes.equals(committed) || sha256(bytes) !== selectionSha256) throw new Error('Selection bytes differ from reviewed commit/hash');
  const selector = validateSelection(parseJson(bytes));
  if (bytes.toString('utf8') !== canonicalJson(selector)) throw new Error('Selection must contain exact canonical bytes');
  await assertSource();
  return selector;
}
export async function liveArtifactIo({ token = process.env.GH_TOKEN, env = process.env, configDirectory, run = execute, fetchImpl = fetch } = {}) {
  if (typeof token !== 'string' || !token) throw new Error('Explicit read-only Service token required');
  const directory = configDirectory ?? await mkdtemp(path.join(os.tmpdir(), 'anywear-service-config-'));
  if (!path.isAbsolute(directory) || (await readdir(directory)).length) throw new Error('External empty CLI config required');
  const commandEnv = commandEnvironment(env, directory, token);
  const command = async args => (await run('gh', args, { env: commandEnv, encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024 })).stdout;
  return {
    async api(endpoint) { return parseJson(await command(['api', endpoint])); },
    async asset(repository, id) {
      if (repository !== SERVICE_REPOSITORY) throw new Error('Unexpected private repository'); integer(id, 'release asset ID');
      const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/assets/${id}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok || !response.body) throw new Error('Exact release asset retrieval failed');
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length;
        if (size > 100 * 1024 * 1024) throw new Error('Release asset exceeds bound'); chunks.push(Buffer.from(next.value)); }
      } finally { await reader.cancel(); }
      const bytes = Buffer.concat(chunks); if (!bytes.length) throw new Error('Empty release asset');
      return bytes;
    },
    async attestation(tag, file) {
      return parseJson(await command(['release', file ? 'verify-asset' : 'verify', tag, ...(file ? [file] : []), '--repo', SERVICE_REPOSITORY, '--format', 'json']));
    },
  };
}
export function assertPublisherRun(run, producer) {
  if (run.id !== producer.run_id || run.run_attempt !== producer.run_attempt || run.head_sha !== producer.workflow_sha
    || run.head_branch !== 'main' || run.path !== '.github/workflows/service-artifacts.yml' || run.event !== 'workflow_dispatch'
    || run.repository?.full_name !== SERVICE_REPOSITORY || run.repository.id !== 1158460323 || run.repository.owner?.id !== 11473072
    || run.repository.owner?.login !== 'git-malu' || run.head_repository?.full_name !== SERVICE_REPOSITORY || run.head_repository.id !== 1158460323
    || run.head_repository.owner?.id !== 11473072 || run.head_repository.owner?.login !== 'git-malu'
    || run.status !== 'completed' || run.conclusion !== 'success') throw new Error('Trusted publisher run must complete successfully');
  return run;
}
export async function verifySelection(binding, directory, io) {
  const selector = await loadCommittedSelection(binding);
  const checkSource = async () => {
    if (canonicalJson(await loadCommittedSelection(binding)) !== canonicalJson(selector)) throw new Error('Committed selection changed during verification');
  };
  io ??= await liveArtifactIo();
  const api = async endpoint => { await checkSource(); return io.api(endpoint); };
  const asset = async id => { await checkSource(); return io.asset(SERVICE_REPOSITORY, id); };
  const attestation = async (tag, file) => { await checkSource(); return io.attestation(tag, file); };
  await mkdir(directory, { recursive: true });
  const release = await api(`repos/${SERVICE_REPOSITORY}/releases/${selector.release.id}`);
  if (release.id !== selector.release.id || release.immutable !== true || release.draft !== false || !Array.isArray(release.assets)) throw new Error('Selected release is not sealed immutable');
  const selected = [...Object.values(selector.lambdas), selector.runtime_policy, selector.schema];
  const assetNames = ['service-artifacts.json', ...selected.map(item => item.file)].sort();
  if (release.assets.length !== assetNames.length || JSON.stringify(release.assets.map(item => item.name).sort()) !== JSON.stringify(assetNames)) throw new Error('Unexpected or duplicate release assets');
  const manifestAsset = release.assets.filter(asset => asset.id === selector.release.manifest_asset_id);
  if (manifestAsset.length !== 1 || manifestAsset[0].name !== 'service-artifacts.json' || manifestAsset[0].state !== 'uploaded') throw new Error('Exact manifest asset unavailable');
  const expectations = [{ asset_id: selector.release.manifest_asset_id, file: 'service-artifacts.json', sha256: selector.release.manifest_sha256 }, ...selected];
  for (const expected of expectations) {
    const found = release.assets.filter(asset => asset.id === expected.asset_id && asset.name === expected.file);
    if (found.length !== 1 || found[0].state !== 'uploaded' || found[0].digest !== `sha256:${expected.sha256}`) throw new Error('Selected asset ID/name/uploaded/API digest differs');
    integer(found[0].size, 'asset API size'); if (found[0].size > 100 * 1024 * 1024) throw new Error('Asset API size exceeds bound');
  }
  const download = async expected => { const bytes = await asset(expected.asset_id);
    if (bytes.length !== release.assets.find(item => item.id === expected.asset_id).size || sha256(bytes) !== expected.sha256) throw new Error('Downloaded asset size/hash differs from selected API identity'); return bytes; };
  const manifestBytes = await download(expectations[0]);
  if (sha256(manifestBytes) !== selector.release.manifest_sha256) throw new Error('Manifest byte hash mismatch');
  const manifest = validateManifest(parseJson(manifestBytes)); assertSelectionManifest(selector, manifest);
  const producer = manifest.producer;
  const tag = manifest.kind === 'source-build' ? `service-artifacts-${manifest.components.image.service_sha}` : `service-baseline-${selector.release.manifest_sha256}`;
  if (release.tag_name !== tag) throw new Error('Release tag does not bind selected artifact kind');
  const gitRef = await api(`repos/${SERVICE_REPOSITORY}/git/ref/tags/${tag}`);
  const source = manifest.kind === 'source-build' ? manifest.components.image.service_sha : producer.workflow_sha;
  if (release.target_commitish !== source || gitRef.object?.type !== 'commit' || gitRef.object.sha !== source) throw new Error('Immutable release/tag source binding mismatch');
  const run = await api(`repos/${SERVICE_REPOSITORY}/actions/runs/${producer.run_id}/attempts/${producer.run_attempt}`);
  assertPublisherRun(run, producer);
  const assetHashes = { 'service-artifacts.json': selector.release.manifest_sha256, ...Object.fromEntries(selected.map(component => [component.file, component.sha256])) };
  const nativeExpected = { releaseId: release.id, tag, target: source, assetHashes };
  const nativeVerification = await attestation(tag);
  const signed = assertNativeReleaseAttestation(nativeVerification, nativeExpected);
  const manifestPath = path.join(directory, 'service-artifacts.json'); await writeFile(manifestPath, manifestBytes);
  if (canonicalJson(assertNativeReleaseAttestation(await attestation(tag, manifestPath), nativeExpected)) !== canonicalJson(signed)) throw new Error('Manifest verified against a different native statement');
  const assets = {};
  for (const component of selected) {
    const found = release.assets.filter(asset => asset.id === component.asset_id && asset.name === component.file && asset.state === 'uploaded');
    if (found.length !== 1) throw new Error('Selected component asset ID/name is unavailable');
    const bytes = await download(component);
    if (sha256(bytes) !== component.sha256) throw new Error(`Asset bytes differ: ${component.file}`);
    const file = path.join(directory, component.file); await writeFile(file, bytes);
    if (canonicalJson(assertNativeReleaseAttestation(await attestation(tag, file), nativeExpected)) !== canonicalJson(signed)) throw new Error('Asset verified against a different native statement');
    assets[component.file] = bytes;
  }
  const verified = verifyAssetBytes(manifest, assets);
  assertPublisherRun(await api(`repos/${SERVICE_REPOSITORY}/actions/runs/${producer.run_id}/attempts/${producer.run_attempt}`), producer);
  const finalRelease = await api(`repos/${SERVICE_REPOSITORY}/releases/${selector.release.id}`);
  const identity = value => ({ id: value.id, immutable: value.immutable, draft: value.draft, tag_name: value.tag_name, target_commitish: value.target_commitish,
    assets: value.assets?.map(({ id, name, state, size, digest }) => ({ id, name, state, size, digest })).sort((a, b) => a.id - b.id) });
  if (canonicalJson(identity(finalRelease)) !== canonicalJson(identity(release))) throw new Error('Immutable release identity changed during verification');
  await checkSource(); await writeFile(path.join(directory, 'selection.json'), canonicalJson(selector));
  return { selector, manifest, ...verified, directory };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2); const allowed = ['--selection', '--selection-sha256', '--trusted-infra-root', '--infra-sha', '--output-dir'];
  if (args.length !== allowed.length * 2 || allowed.some(key => args.filter(value => value === key).length !== 1)
    || args.some((value, index) => index % 2 === 0 ? !allowed.includes(value) : value.startsWith('--'))) throw new Error('Explicit selection path/hash, trusted Infra root/SHA and output directory required');
  const option = name => args[args.indexOf(name) + 1];
  await verifySelection({ trustedInfraRoot: option('--trusted-infra-root'), expectedInfraSha: option('--infra-sha'),
    selectionFile: option('--selection'), selectionSha256: option('--selection-sha256') }, path.resolve(option('--output-dir')));
}
