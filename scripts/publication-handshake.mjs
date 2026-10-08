import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJson, canonicalJson, sha256, exact, matches, integer, SHA, HASH } from './json-contract.mjs';
import { createCandidate } from './create-publication-candidate.mjs';
import { assertPublisherRun } from './artifact-consumer.mjs';
import { validateManifest, SERVICE_REPOSITORY } from './vendor/service-artifact-contract.mjs';
import { assertNativeReleaseAttestation } from './vendor/service-release-attestation.mjs';
import { decodePublicationArchive, MAX_PUBLICATION_ARCHIVE_BYTES } from './publication-acceptance.mjs';

const execute = promisify(execFile);
const PREFIX = `repos/${SERVICE_REPOSITORY}`;
const WORKFLOW = 'git-malu/AnyWear-Infra/.github/workflows/publication-handshake.yml@refs/heads/main';
export const APP_ID = 3346940;
export const INSTALLATION_ID = 123158580;
export const ASSET_NAMES = Object.freeze(['service-artifacts.json', 'pre-sign-up.zip', 'post-confirmation.zip', 'runtime-policy.json', 'service-schema.json']);
export const EVIDENCE_FILES = Object.freeze(['status.json', 'request.json', 'request-sha256.txt', 'github-cli-version.txt', 'capabilities.json',
  'app-scope.json', 'producer-before.json', 'producer-after.json', 'release.json', 'service-artifacts.json', 'asset-hashes.json', 'artifacts.json',
  'native-release.json', 'native-service-artifacts.json', 'native-pre-sign-up.json', 'native-post-confirmation.json', 'native-runtime-policy.json',
  'native-service-schema.json', 'publication.zip', 'service-artifact-publication.json', 'publication-hashes.json', 'candidate.json', 'candidate-sha256.txt']);
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
const RECORD_URL = /^https:\/\/github\.com\/git-malu\/AnyWear\/issues\/54#issuecomment-[1-9][0-9]*$/;
const fail = code => { throw new HandshakeError(code); };
export class HandshakeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function nonzero(value, pattern, label) {
  matches(value, pattern, label);
  if (/^0+$/.test(value)) fail('placeholder-input');
}
function same(actual, expected, code) { if (canonicalJson(actual) !== canonicalJson(expected)) fail(code); }

export function validateRequest(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16 * 1024) fail('request-size');
  const request = parseJson(text);
  exact(request, ['schema_version', 'record_type', 'app', 'producer', 'release', 'kind', 'assets'], 'handshake request');
  if (request.schema_version !== 1 || request.record_type !== 'anywear_publication_handshake_request'
    || request.kind !== 'deployed-baseline-import') fail('request-schema');
  exact(request.app, ['app_id', 'installation_id', 'permissions_requested'], 'reader App');
  if (request.app.app_id !== APP_ID || request.app.installation_id !== INSTALLATION_ID) fail('app-identity');
  same(request.app.permissions_requested, { contents: 'read', actions: 'read', attestations: 'read' }, 'app-permissions');
  exact(request.producer, ['repository', 'workflow_sha', 'run_id', 'run_attempt'], 'requested producer');
  if (request.producer.repository !== SERVICE_REPOSITORY) fail('producer-repository');
  nonzero(request.producer.workflow_sha, SHA, 'publisher SHA');
  integer(request.producer.run_id, 'publisher run'); integer(request.producer.run_attempt, 'publisher attempt');
  exact(request.release, ['id', 'manifest_asset_id', 'manifest_sha256', 'tag', 'target'], 'requested release');
  integer(request.release.id, 'release ID'); integer(request.release.manifest_asset_id, 'manifest asset ID');
  nonzero(request.release.manifest_sha256, HASH, 'manifest SHA256'); nonzero(request.release.target, SHA, 'release target');
  if (request.release.tag !== `service-baseline-${request.release.manifest_sha256}` || request.release.target !== request.producer.workflow_sha) fail('release-source');
  if (!Array.isArray(request.assets) || request.assets.length !== ASSET_NAMES.length) fail('asset-set');
  for (const asset of request.assets) {
    exact(asset, ['id', 'name', 'size', 'sha256'], 'requested asset'); integer(asset.id, 'asset ID'); integer(asset.size, 'asset size');
    nonzero(asset.sha256, HASH, 'asset SHA256');
    if (!ASSET_NAMES.includes(asset.name) || asset.size > MAX_ASSET_BYTES) fail('asset-bound');
  }
  if (new Set(request.assets.map(asset => asset.id)).size !== 5 || new Set(request.assets.map(asset => asset.name)).size !== 5) fail('asset-set');
  const manifest = request.assets.find(asset => asset.name === 'service-artifacts.json');
  if (manifest.id !== request.release.manifest_asset_id || manifest.sha256 !== request.release.manifest_sha256) fail('manifest-identity');
  return request;
}

// Child commands cannot inherit OAuth/enterprise tokens, credential helpers,
// GH_DEBUG, NODE_OPTIONS or arbitrary Git overrides from the runner environment.
export function commandEnvironment(env, configDirectory, token) {
  const out = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (typeof env[key] === 'string') out[key] = env[key];
  }
  out.GH_HOST = 'github.com'; out.GH_CONFIG_DIR = configDirectory; out.GH_PROMPT_DISABLED = '1';
  // cli/cli v2.101.0 initializes telemetry even for --version/--help. Without
  // HOME, its Unix state path is relative to cwd; GH_CONFIG_DIR does not govern
  // that state. Use the supported fixed opt-out, never an inherited override.
  out.GH_TELEMETRY = 'disabled';
  out.GIT_CONFIG_NOSYSTEM = '1'; out.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  if (token !== undefined) {
    if (typeof token !== 'string' || !token) fail('reader-token-missing');
    out.GH_TOKEN = token;
  }
  return out;
}

export function validateContext(env, checkoutSha, now = new Date().toISOString()) {
  const request = validateRequest(env.HANDSHAKE_REQUEST_JSON);
  nonzero(env.HANDSHAKE_SOURCE_SHA, SHA, 'reviewed Infra SHA');
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Infra'
    || env.GITHUB_REPOSITORY_ID !== '1409047265' || env.GITHUB_REPOSITORY_OWNER_ID !== '11473072'
    || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_WORKFLOW_REF !== WORKFLOW
    || env.GITHUB_ACTOR !== 'git-malu' || env.GITHUB_TRIGGERING_ACTOR !== 'git-malu'
    || env.PUBLICATION_HANDSHAKE_ACTOR !== 'git-malu' || env.GITHUB_RUN_ATTEMPT !== '1'
    || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !Number.isSafeInteger(Number(env.GITHUB_RUN_ID))
    || env.GITHUB_WORKFLOW_SHA !== env.HANDSHAKE_SOURCE_SHA || env.GITHUB_SHA !== env.HANDSHAKE_SOURCE_SHA
    || env.PUBLICATION_HANDSHAKE_SOURCE_SHA !== env.HANDSHAKE_SOURCE_SHA || checkoutSha !== env.HANDSHAKE_SOURCE_SHA) fail('executor-context');
  if (env.ENABLE_PUBLICATION_HANDSHAKE !== 'true' || !/^[A-Za-z0-9_-]{16,128}$/.test(env.HANDSHAKE_WINDOW_TOKEN ?? '')
    || env.HANDSHAKE_WINDOW_TOKEN !== env.PUBLICATION_HANDSHAKE_WINDOW_TOKEN) fail('reader-window');
  matches(env.PUBLICATION_HANDSHAKE_EXPIRES_AT, UTC, 'reader expiry'); matches(now, UTC, 'current UTC time');
  if (!Number.isFinite(Date.parse(env.PUBLICATION_HANDSHAKE_EXPIRES_AT)) || !Number.isFinite(Date.parse(now))
    || Date.parse(now) >= Date.parse(env.PUBLICATION_HANDSHAKE_EXPIRES_AT)) fail('reader-expired');
  matches(env.PUBLICATION_HANDSHAKE_RECORD_URL, RECORD_URL, 'manager reader record');
  if (sha256(canonicalJson(request)) !== env.PUBLICATION_HANDSHAKE_REQUEST_SHA256) fail('request-hash');
  return request;
}

export async function assertCheckout(root, expectedSha, { run = execute, env = process.env } = {}) {
  const actualRoot = await realpath(root);
  const git = async args => (await run('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', actualRoot, ...args],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: commandEnvironment(env, '') })).stdout;
  if (path.resolve((await git(['rev-parse', '--show-toplevel'])).trim()) !== actualRoot
    || (await git(['rev-parse', 'HEAD'])).trim() !== expectedSha) fail('checkout-source');
  if (!['https://github.com/git-malu/AnyWear-Infra', 'https://github.com/git-malu/AnyWear-Infra.git', 'git@github.com:git-malu/AnyWear-Infra.git']
    .includes((await git(['remote', 'get-url', 'origin'])).trim())) fail('checkout-origin');
  if ((await git(['status', '--porcelain=v1', '--untracked-files=all'])).trim()
    || (await git(['for-each-ref', '--format=%(refname)', 'refs/replace'])).trim()
    || (await git(['ls-files', '-v', '-z'])).split('\0').filter(Boolean).some(line => !line.startsWith('H '))) fail('checkout-unclean');
  return actualRoot;
}

function paths(env) {
  integer(Number(env.GITHUB_RUN_ID), 'consumer run'); integer(Number(env.GITHUB_RUN_ATTEMPT), 'consumer attempt');
  if (!path.isAbsolute(env.RUNNER_TEMP ?? '') || !path.isAbsolute(env.GITHUB_WORKSPACE ?? '')) fail('runner-path');
  const base = path.join(env.RUNNER_TEMP, `service-publication-handshake-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`);
  const relative = path.relative(env.GITHUB_WORKSPACE, base);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) fail('evidence-inside-source');
  return { base, evidenceDirectory: path.join(base, 'evidence'), assetsDirectory: path.join(base, 'assets'), configDirectory: path.join(base, 'gh-config') };
}
const putJson = (directory, file, value) => writeFile(path.join(directory, file), canonicalJson(value));
export function initialStatus(env) {
  return { schema_version: 1, record_type: 'anywear_publication_handshake_evidence', source_sha: env.HANDSHAKE_SOURCE_SHA,
    actor: env.GITHUB_ACTOR, triggering_actor: env.GITHUB_TRIGGERING_ACTOR, run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
    manager_record_url: env.PUBLICATION_HANDSHAKE_RECORD_URL, expires_at: env.PUBLICATION_HANDSHAKE_EXPIRES_AT,
    request_sha256: env.PUBLICATION_HANDSHAKE_REQUEST_SHA256, window_token_sha256: sha256(env.HANDSHAKE_WINDOW_TOKEN),
    phase: 'guard', outcome: 'pending', verified: false, scope_mint_accepted: false, actual_native_read_verified: false,
    candidate_only: true, receipt_committed: false, selection_accepted: false, deployment_authorized: false, mutation_performed: false };
}
async function inventory(directory) {
  const files = [];
  for (const name of EVIDENCE_FILES) {
    try { const bytes = await readFile(path.join(directory, name)); files.push({ name, size: bytes.length, sha256: sha256(bytes) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await putJson(directory, 'inventory.json', { schema_version: 1, files });
}

async function readBounded(response, limit) {
  if (!response.ok || !response.body) fail('github-read-failed');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length;
      if (size > limit) fail('github-response-bound'); chunks.push(Buffer.from(next.value)); }
  } finally { await reader.cancel(); }
  if (size === 0) fail('github-response-empty');
  return Buffer.concat(chunks);
}
export function liveReaderIo({ token, configDirectory, env = process.env, run = execute, fetchImpl = fetch }) {
  if (typeof token !== 'string' || !token) fail('reader-token-missing');
  const commandEnv = commandEnvironment(env, configDirectory, token);
  const get = async (endpoint, limit, accept = 'application/vnd.github+json') => readBounded(await fetchImpl(`https://api.github.com/${endpoint}`, {
    method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(60_000),
  }), limit);
  return {
    api: async endpoint => parseJson(await get(endpoint, 10 * 1024 * 1024)),
    asset: async (repository, id) => get(`repos/${repository}/releases/assets/${id}`, MAX_ASSET_BYTES, 'application/octet-stream'),
    publicationArchive: async id => get(`${PREFIX}/actions/artifacts/${id}/zip`, MAX_PUBLICATION_ARCHIVE_BYTES),
    attestation: async (tag, file) => Buffer.from((await run('gh', ['release', file ? 'verify-asset' : 'verify', tag, ...(file ? [file] : []),
      '--repo', SERVICE_REPOSITORY, '--format', 'json'], { encoding: 'buffer', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: commandEnv })).stdout),
  };
}
function repository(value) {
  if (value?.id !== 1158460323 || value.full_name !== SERVICE_REPOSITORY || value.private !== true
    || value.owner?.id !== 11473072 || value.owner?.login !== 'git-malu') fail('service-identity');
  return { id: value.id, full_name: value.full_name, private: true, owner: { id: value.owner.id, login: value.owner.login } };
}
function publisher(value, expected) {
  assertPublisherRun(value, expected);
  if (value.head_repository?.owner?.id !== 11473072) fail('publisher-owner');
  return { id: value.id, run_attempt: value.run_attempt, head_sha: value.head_sha, head_branch: value.head_branch, path: value.path,
    event: value.event, status: value.status, conclusion: value.conclusion, run_started_at: value.run_started_at, updated_at: value.updated_at,
    repository: { id: value.repository.id, full_name: value.repository.full_name, owner: { id: value.repository.owner.id } },
    head_repository: { id: value.head_repository.id, full_name: value.head_repository.full_name, owner: { id: value.head_repository.owner.id } } };
}
function releaseInventory(value, request) {
  if (value?.id !== request.release.id || value.immutable !== true || value.draft !== false || value.tag_name !== request.release.tag
    || !Array.isArray(value.assets) || value.assets.length !== 5) fail('sealed-release');
  const assets = request.assets.map(expected => {
    const found = value.assets.filter(asset => asset.id === expected.id && asset.name === expected.name);
    if (found.length !== 1 || found[0].state !== 'uploaded' || found[0].size !== expected.size || found[0].digest !== `sha256:${expected.sha256}`) fail('release-assets');
    return { ...expected, state: 'uploaded', digest: found[0].digest };
  });
  return { id: value.id, immutable: true, draft: false, tag_name: value.tag_name, target: request.release.target, assets };
}
function preparationSelector(request, manifest) {
  same(manifest.producer, { ...request.producer, workflow_ref: `${SERVICE_REPOSITORY}/.github/workflows/service-artifacts.yml@refs/heads/main` }, 'external-producer');
  if (manifest.kind !== request.kind) fail('manifest-kind');
  const component = (value, name) => {
    const asset = request.assets.find(item => item.name === name);
    if (value.file !== name || value.sha256 !== asset.sha256) fail('manifest-component');
    return { ...value, asset_id: asset.id };
  };
  return { schema_version: 1, record_type: 'anywear_infra_selection',
    release: { repository: SERVICE_REPOSITORY, id: request.release.id, manifest_asset_id: request.release.manifest_asset_id, manifest_sha256: request.release.manifest_sha256 },
    publication_acceptance: { file: `publications/${request.release.manifest_sha256}.json`, sha256: '0'.repeat(64) },
    image: manifest.components.image,
    lambdas: { pre_sign_up: component(manifest.components.lambdas.pre_sign_up, 'pre-sign-up.zip'),
      post_confirmation: component(manifest.components.lambdas.post_confirmation, 'post-confirmation.zip') },
    runtime_policy: component(manifest.components.runtime_policy, 'runtime-policy.json'), schema: component(manifest.components.schema, 'service-schema.json') };
}

export async function runHandshake({ request, evidenceDirectory, assetsDirectory, status, installationId, tokenMintOutcome,
  io, contextCheck, now = () => new Date().toISOString() }) {
  let phase = 'app-scope'; let producerReads = 0; let nativeStatement; let nativeCount = 0;
  const artifacts = []; const assetHashes = new Map(); let archiveId; let manifest;
  const runEndpoint = `${PREFIX}/actions/runs/${request.producer.run_id}/attempts/${request.producer.run_attempt}`;
  const releaseEndpoint = `${PREFIX}/releases/${request.release.id}`;
  const tagEndpoint = `${PREFIX}/git/ref/tags/${request.release.tag}`;
  const expectedNative = { releaseId: request.release.id, tag: request.release.tag, target: request.release.target,
    assetHashes: Object.fromEntries(request.assets.map(asset => [asset.name, asset.sha256])) };
  const checkpoint = async nextPhase => { phase = nextPhase; status.phase = phase; await contextCheck(); await putJson(evidenceDirectory, 'status.json', status); };
  const remote = async (nextPhase, operation) => { await checkpoint(nextPhase); const result = await operation(); await contextCheck(); return result; };
  const recordingIo = {
    async api(endpoint) {
      const page = endpoint.startsWith(`${PREFIX}/actions/runs/${request.producer.run_id}/artifacts?per_page=100&page=`)
        ? endpoint.slice(endpoint.lastIndexOf('=') + 1) : null;
      if (!['installation/repositories?per_page=100', PREFIX, runEndpoint, releaseEndpoint, tagEndpoint].includes(endpoint)
        && (!/^(?:[1-9]|10)$/.test(page ?? ''))) fail('endpoint-allowlist');
      const value = await remote(endpoint === runEndpoint ? 'publisher' : endpoint === releaseEndpoint ? 'release' : page ? 'publication-inventory' : phase, () => io.api(endpoint));
      if (endpoint === runEndpoint) {
        const snapshot = publisher(value, request.producer); await putJson(evidenceDirectory, producerReads++ ? 'producer-after.json' : 'producer-before.json', snapshot);
      } else if (endpoint === releaseEndpoint) await putJson(evidenceDirectory, 'release.json', releaseInventory(value, request));
      else if (endpoint === tagEndpoint && (value.object?.type !== 'commit' || value.object.sha !== request.release.target)) fail('release-tag-target');
      else if (page) {
        if (!Array.isArray(value.artifacts) || !Number.isSafeInteger(value.total_count) || value.total_count < 0 || value.total_count > 1000
          || value.artifacts.length > 100 || artifacts.length + value.artifacts.length > 1000) fail('artifact-inventory-bound');
        artifacts.push(...value.artifacts.map(item => ({ id: item.id, name: item.name, expired: item.expired, created_at: item.created_at,
          expires_at: item.expires_at, size_in_bytes: item.size_in_bytes, digest: item.digest,
          workflow_run: { id: item.workflow_run?.id, head_sha: item.workflow_run?.head_sha } })));
        await putJson(evidenceDirectory, 'artifacts.json', { total_count: value.total_count, artifacts });
        const matching = artifacts.filter(item => item.name === `service-artifact-publication-${request.producer.run_id}-${request.producer.run_attempt}`);
        if (matching.length > 1) fail('duplicate-publication');
        archiveId = matching.length === 1 ? integer(matching[0].id, 'publication artifact ID') : undefined;
      }
      return value;
    },
    async asset(repo, id) {
      const expected = request.assets.find(asset => asset.id === id);
      if (repo !== SERVICE_REPOSITORY || !expected) fail('asset-allowlist');
      const bytes = await remote('assets', () => io.asset(repo, id));
      if (!(bytes instanceof Uint8Array) || bytes.length !== expected.size || sha256(bytes) !== expected.sha256) fail('asset-bytes');
      const normalizedBytes = Buffer.from(bytes);
      assetHashes.set(expected.name, { id, name: expected.name, size: normalizedBytes.length, sha256: sha256(normalizedBytes) });
      await putJson(evidenceDirectory, 'asset-hashes.json', [...assetHashes.values()]);
      if (expected.name === 'service-artifacts.json') {
        manifest = validateManifest(parseJson(normalizedBytes)); preparationSelector(request, manifest);
        await writeFile(path.join(evidenceDirectory, 'service-artifacts.json'), normalizedBytes);
      }
      return normalizedBytes;
    },
    async attestation(tag, file) {
      const name = file ? path.basename(file) : null;
      if (tag !== request.release.tag || file && (!ASSET_NAMES.includes(name) || path.resolve(file) !== path.join(assetsDirectory, name))) fail('native-allowlist');
      const raw = await remote('native', () => io.attestation(tag, file));
      if (!Buffer.isBuffer(raw) || raw.length < 2 || raw.length > 4 * 1024 * 1024) fail('native-json-bound');
      await writeFile(path.join(evidenceDirectory, name ? `native-${name.replace(/\.(json|zip)$/, '')}.json` : 'native-release.json'), raw);
      const value = parseJson(raw); const statement = assertNativeReleaseAttestation(value, expectedNative);
      if (nativeStatement) same(statement, nativeStatement, 'native-statement-drift');
      nativeStatement = statement;
      if (++nativeCount === 6) { status.actual_native_read_verified = true; await putJson(evidenceDirectory, 'status.json', status); }
      return value;
    },
    async publicationArchive(id) {
      if (!archiveId || id !== archiveId) fail('archive-allowlist');
      const bytes = await remote('publication-archive', () => io.publicationArchive(id));
      if (!(bytes instanceof Uint8Array) || bytes.length > MAX_PUBLICATION_ARCHIVE_BYTES) fail('archive-bound');
      const normalizedBytes = Buffer.from(bytes);
      await writeFile(path.join(evidenceDirectory, 'publication.zip'), normalizedBytes);
      const decoded = decodePublicationArchive(normalizedBytes);
      await writeFile(path.join(evidenceDirectory, 'service-artifact-publication.json'), decoded.recordBytes);
      await putJson(evidenceDirectory, 'publication-hashes.json', { archive_sha256: decoded.archiveSha256, record_sha256: sha256(decoded.recordBytes) });
      return normalizedBytes;
    },
  };
  try {
    await checkpoint('app-scope');
    if (tokenMintOutcome !== 'success') fail('app-token-mint-failed');
    status.scope_mint_accepted = true; await putJson(evidenceDirectory, 'status.json', status);
    if (installationId !== String(INSTALLATION_ID) || request.app.installation_id !== INSTALLATION_ID) fail('app-installation');
    const scope = await recordingIo.api('installation/repositories?per_page=100');
    if (scope.total_count !== 1 || !Array.isArray(scope.repositories) || scope.repositories.length !== 1) fail('app-repository-scope');
    const scopedRepo = repository(scope.repositories[0]); const directRepo = repository(await recordingIo.api(PREFIX));
    await putJson(evidenceDirectory, 'app-scope.json', { app_id: APP_ID, installation_id: INSTALLATION_ID,
      permissions_requested: request.app.permissions_requested, scope_mint_accepted: true, token_repository_count: 1, repository: scopedRepo, direct_repository: directRepo });
    await recordingIo.api(runEndpoint); await recordingIo.api(releaseEndpoint);
    await recordingIo.asset(SERVICE_REPOSITORY, request.release.manifest_asset_id);
    const selector = preparationSelector(request, manifest);
    const candidate = await createCandidate(selector, { directory: assetsDirectory, managerAcceptanceUrl: status.manager_record_url, io: recordingIo, now: now() });
    await recordingIo.api(runEndpoint);
    await checkpoint('final');
    if (nativeCount !== 6 || assetHashes.size !== 5 || !status.actual_native_read_verified) fail('incomplete-handshake');
    const completedAt = now(); matches(completedAt, UTC, 'completion UTC time');
    const publication = artifacts.find(item => item.id === archiveId);
    if (!Number.isFinite(Date.parse(completedAt)) || !publication || Date.parse(publication.expires_at) <= Date.parse(completedAt)) fail('publication-expired-at-completion');
    candidate.verified_at = completedAt;
    const bytes = Buffer.from(canonicalJson(candidate));
    await writeFile(path.join(evidenceDirectory, 'candidate.json'), bytes, { flag: 'wx' });
    await writeFile(path.join(evidenceDirectory, 'candidate-sha256.txt'), `${sha256(bytes)}\n`, { flag: 'wx' });
    await contextCheck();
    status.phase = 'complete'; status.outcome = 'success'; status.verified = true; status.candidate_sha256 = sha256(bytes);
    await putJson(evidenceDirectory, 'status.json', status); await inventory(evidenceDirectory);
    return candidate;
  } catch (error) {
    status.phase = phase; status.outcome = 'failure'; status.verified = false;
    status.error_category = error instanceof HandshakeError ? error.code : `${phase}-verification-failed`;
    delete status.candidate_sha256;
    for (const file of ['candidate.json', 'candidate-sha256.txt']) await rm(path.join(evidenceDirectory, file), { force: true });
    await putJson(evidenceDirectory, 'status.json', status); await inventory(evidenceDirectory);
    throw new HandshakeError(status.error_category);
  }
}

async function main() {
  const env = process.env; const mode = process.argv[2]; const directories = paths(env);
  const contextCheck = async () => {
    validateContext(env, env.HANDSHAKE_SOURCE_SHA);
    await assertCheckout(env.GITHUB_WORKSPACE, env.HANDSHAKE_SOURCE_SHA);
    validateContext(env, env.HANDSHAKE_SOURCE_SHA);
  };
  if (mode === 'guard') {
    await contextCheck(); const request = validateRequest(env.HANDSHAKE_REQUEST_JSON);
    const tempRoot = await realpath(env.RUNNER_TEMP); const sourceRoot = await realpath(env.GITHUB_WORKSPACE);
    const relative = path.relative(sourceRoot, tempRoot);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) fail('evidence-inside-source');
    await mkdir(directories.base); await mkdir(directories.evidenceDirectory); await mkdir(directories.configDirectory);
    await putJson(directories.evidenceDirectory, 'status.json', initialStatus(env));
    await putJson(directories.evidenceDirectory, 'request.json', request);
    await writeFile(path.join(directories.evidenceDirectory, 'request-sha256.txt'), `${sha256(canonicalJson(request))}\n`);
    await appendFile(env.GITHUB_OUTPUT, 'initialized=true\n'); return;
  }
  if (!['probes', 'candidate', 'finalize'].includes(mode)) fail('unknown-mode');
  // Strict parsing uses non-writable properties; this process updates its own
  // retained status, so clone only that locally generated record.
  const status = structuredClone(parseJson(await readFile(path.join(directories.evidenceDirectory, 'status.json'))));
  if (mode === 'finalize') {
    if (env.HANDSHAKE_CANDIDATE_OUTCOME !== 'success' || !status.verified || status.outcome !== 'success') {
      status.verified = false; status.outcome = 'failure';
      if (!status.error_category) { status.phase = env.HANDSHAKE_PROBES_OUTCOME !== 'success' ? 'cli-probes' : env.HANDSHAKE_TOKEN_MINT_OUTCOME !== 'success' ? 'app-scope' : 'candidate';
        status.error_category = `${status.phase}-step-failed`; }
      if (env.HANDSHAKE_TOKEN_MINT_OUTCOME !== 'success') status.scope_mint_accepted = false;
      delete status.candidate_sha256;
      for (const file of ['candidate.json', 'candidate-sha256.txt']) await rm(path.join(directories.evidenceDirectory, file), { force: true });
    }
    await putJson(directories.evidenceDirectory, 'status.json', status); await inventory(directories.evidenceDirectory); return;
  }
  try {
    await contextCheck();
    if (mode === 'probes') {
      status.phase = 'cli-probes'; await putJson(directories.evidenceDirectory, 'status.json', status);
      const options = { encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024, env: commandEnvironment(env, directories.configDirectory) };
      const version = await execute('gh', ['--version'], options);
      await writeFile(path.join(directories.evidenceDirectory, 'github-cli-version.txt'), version.stdout);
      for (const command of ['verify', 'verify-asset']) await execute('gh', ['release', command, '--format', 'json', '--help'], options);
      await contextCheck(); await putJson(directories.evidenceDirectory, 'capabilities.json', { offline_json_cli_probes_passed: true, actual_native_read_verified: false }); return;
    }
    const io = liveReaderIo({ token: env.GH_TOKEN, configDirectory: directories.configDirectory });
    await runHandshake({ ...directories, status, request: validateRequest(env.HANDSHAKE_REQUEST_JSON),
      installationId: env.HANDSHAKE_APP_INSTALLATION_ID, tokenMintOutcome: env.HANDSHAKE_TOKEN_MINT_OUTCOME, io, contextCheck });
    process.stdout.write(`candidate_only=true sha256=${status.candidate_sha256}\n`);
  } catch (error) {
    if (status.outcome !== 'failure') {
      status.verified = false; status.outcome = 'failure'; status.error_category = error instanceof HandshakeError ? error.code : `${status.phase}-step-failed`;
      await putJson(directories.evidenceDirectory, 'status.json', status); await inventory(directories.evidenceDirectory);
    }
    throw new HandshakeError(status.error_category);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`HANDSHAKE_FAILED:${error instanceof HandshakeError ? error.code : 'local-step-failed'}\n`); process.exitCode = 1; });
}
