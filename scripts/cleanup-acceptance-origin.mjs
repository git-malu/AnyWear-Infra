import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exact, parseJson, SHA, HASH, sha256, canonicalJson, integer } from './json-contract.mjs';
import { commandEnvironment } from './artifact-consumer.mjs';

const execute = promisify(execFile);
const repository = 'git-malu/AnyWear-E2E';
const workflow = '.github/workflows/beta-cleanup-acceptance.yml';
const originFields = ['repository', 'workflow_path', 'source_sha', 'run_id', 'run_attempt', 'artifact_id', 'artifact_sha256', 'manifest_sha256'];
const tupleFields = ['service_source_sha', 'service_image_digest', 'state_machine_version_arn', 'fixture_source_sha',
  'fixture_task_definition_arn', 'selection_sha256', 'stack_sources_sha256'];
const budget = { maxActiveAccounts: 2, maxNewAccountsPerRun: 2, maxQuarantinedAccounts: 2 };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function parseBootstrapOrigin(json) {
  const origin = exact(parseJson(json), originFields, 'bootstrap origin');
  validateOrigin(origin);
  if (typeof json !== 'string' || Buffer.byteLength(json) > 2048 || canonicalJson(origin) !== json) throw new Error('Canonical bounded bootstrap origin required');
  return origin;
}

function validateOrigin(origin) {
  if (origin.repository !== repository || origin.workflow_path !== workflow || !SHA.test(origin.source_sha ?? '')
    || !HASH.test(origin.artifact_sha256 ?? '') || !HASH.test(origin.manifest_sha256 ?? '')) throw new Error('Exact protected E2E origin and digests required');
  for (const key of ['run_id', 'run_attempt', 'artifact_id']) integer(origin[key], key);
}

export function assertBootstrapRun(run, origin) {
  if (run.id !== origin.run_id || run.run_attempt !== origin.run_attempt || run.head_sha !== origin.source_sha
    || run.head_branch !== 'main' || run.event !== 'workflow_dispatch' || run.path !== workflow
    || run.status !== 'completed' || run.conclusion !== 'success'
    || !timestamp(run.created_at) || !timestamp(run.updated_at) || Date.parse(run.updated_at) < Date.parse(run.created_at)) throw new Error('Completed-success exact protected bootstrap run required');
  for (const repo of [run.repository, run.head_repository]) {
    if (repo?.full_name !== repository || repo.id !== 1317091305 || repo.owner?.login !== 'git-malu' || repo.owner.id !== 11473072) throw new Error('Bootstrap producer repository/owner identity mismatch');
  }
}

export function assertBootstrapArtifact(artifact, origin, kind) {
  if (artifact.id !== origin.artifact_id || artifact.expired !== false || artifact.name !== `beta-cleanup-acceptance-${kind}-${origin.run_id}-${origin.run_attempt}`
    || artifact.digest !== `sha256:${origin.artifact_sha256}` || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 || artifact.size_in_bytes > 2 * 1024 * 1024
    || artifact.workflow_run?.id !== origin.run_id || artifact.workflow_run.head_sha !== origin.source_sha || artifact.workflow_run.head_branch !== 'main'
    || artifact.workflow_run.repository_id !== 1317091305 || artifact.workflow_run.head_repository_id !== 1317091305
    || !timestamp(artifact.created_at) || !timestamp(artifact.expires_at)
    || Date.parse(artifact.expires_at) <= Date.now()) throw new Error('Exact unexpired bootstrap artifact/digest required');
}

export async function bootstrapArtifactIo(env = process.env) {
  if (typeof env.E2E_BOOTSTRAP_TOKEN !== 'string' || !env.E2E_BOOTSTRAP_TOKEN) throw new Error('Separate read-only E2E bootstrap token required');
  const config = await mkdtemp(path.join(os.tmpdir(), 'anywear-cleanup86-gh-'));
  const child = commandEnvironment(env, config, env.E2E_BOOTSTRAP_TOKEN);
  const api = async endpoint => parseJson((await execute('gh', ['api', endpoint], { env: child, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })).stdout);
  return { api, async files(origin, names) {
    // Extract to stdout only. Fixed names, duplicate checks, byte/time bounds and
    // unzip's CRC verification avoid writing or following archive paths/links.
    const bytes = (await execute('gh', ['api', `repos/${repository}/actions/artifacts/${origin.artifact_id}/zip`],
      { env: child, encoding: 'buffer', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
    if (!Buffer.isBuffer(bytes) || bytes.length > 2 * 1024 * 1024 || sha256(bytes) !== origin.artifact_sha256) throw new Error('Bootstrap archive bytes differ from immutable digest');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'anywear-cleanup86-zip-'));
    const file = path.join(directory, 'artifact.zip');
    try {
      await writeFile(file, bytes);
      const listed = (await execute('unzip', ['-Z1', file], { env: child, timeout: 10_000, maxBuffer: 4096 })).stdout.trim().split('\n');
      if (canonicalJson([...listed].sort()) !== canonicalJson([...names].sort())) throw new Error('Unexpected or duplicate bootstrap archive entries');
      const files = {};
      for (const name of names) files[name] = (await execute('unzip', ['-p', file, name], { env: child, encoding: 'buffer', timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout;
      return files;
    } finally { await rm(directory, { recursive: true, force: true }); }
  } };
}

function producerMatches(producer, origin) {
  exact(producer, ['repository', 'workflow_path', 'source_sha', 'run_id', 'run_attempt'], 'bootstrap producer');
  if (['repository', 'workflow_path', 'source_sha', 'run_id', 'run_attempt'].some(key => producer[key] !== origin[key])) throw new Error('Bootstrap manifest producer mismatch');
}

export function assertBootstrapManifests(manifest, intent, origin, env, selector, request, intentArtifact, bootstrapArtifact, run) {
  exact(manifest, ['schema_version', 'record_type', 'issue', 'phase', 'result', 'producer', 'run_scope', 'account_budget_config',
    'intent_origin', 'identities', 'fixture_request', 'fixture_request_sha256', 'cleanup_requests', 'frozen_tuple'], 'bootstrap manifest');
  exact(intent, ['schema_version', 'record_type', 'issue', 'producer', 'run_scope', 'account_budget_config', 'identities', 'created_at', 'frozen_tuple'], 'creation intent');
  if (manifest.schema_version !== 1 || manifest.record_type !== 'anywear_e2e_cleanup_acceptance_bootstrap' || manifest.issue !== 86
    || manifest.phase !== 'bootstrap' || manifest.result !== 'captured-identities-retained'
    || intent.schema_version !== 1 || intent.record_type !== 'anywear_e2e_cleanup_acceptance_creation_intent' || intent.issue !== 86) throw new Error('Successful issue 86 captured bootstrap and creation intent required');
  producerMatches(manifest.producer, origin); producerMatches(intent.producer, origin);
  if (manifest.fixture_request !== env.FIXTURE_REQUEST || manifest.fixture_request_sha256 !== sha256(env.FIXTURE_REQUEST)
    || manifest.run_scope !== request.run_scope || intent.run_scope !== request.run_scope
    || !request.run_scope.startsWith(`${origin.run_id}-${origin.run_attempt}-`)
    || canonicalJson(manifest.account_budget_config) !== canonicalJson(budget) || canonicalJson(intent.account_budget_config) !== canonicalJson(budget)) throw new Error('Exact captured fixture request/scope/budget required');
  exact(manifest.frozen_tuple, tupleFields, 'bootstrap frozen tuple'); exact(intent.frozen_tuple, tupleFields, 'intent frozen tuple');
  const tuple = manifest.frozen_tuple;
  if (canonicalJson(tuple) !== canonicalJson(intent.frozen_tuple) || tuple.service_source_sha !== selector.image.service_sha || tuple.service_image_digest !== selector.image.digest
    || tuple.fixture_source_sha !== env.FIXTURE_SOURCE_SHA || tuple.fixture_task_definition_arn !== env.FIXTURE_TASK_DEFINITION_ARN
    || tuple.selection_sha256 !== env.SELECTION_SHA256 || tuple.stack_sources_sha256 !== env.STACK_SOURCES_SHA256
    || !/^arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:[1-9][0-9]*$/.test(tuple.state_machine_version_arn ?? '')) throw new Error('Frozen cleanup capability/fixture tuple mismatch');
  if (!Array.isArray(manifest.identities) || manifest.identities.length !== 2 || !Array.isArray(intent.identities) || intent.identities.length !== 2) throw new Error('Exactly two captured bootstrap identities required');
  const intentTime = Date.parse(intentArtifact.created_at);
  const bootstrapTime = Date.parse(bootstrapArtifact?.created_at);
  if (!timestamp(intent.created_at) || !Number.isFinite(intentTime) || !Number.isFinite(bootstrapTime)
    || !timestamp(run?.created_at) || !timestamp(run?.updated_at)
    || Date.parse(intent.created_at) < Date.parse(run.created_at) || Date.parse(intent.created_at) > intentTime
    || bootstrapTime < intentTime || bootstrapTime > Date.parse(run.updated_at)) throw new Error('Intent/bootstrap publication time unproven');
  manifest.identities.forEach((identity, index) => {
    exact(identity, ['slot', 'email', 'sub', 'username', 'lease_generation', 'create_started_at', 'captured_at'], 'captured bootstrap identity');
    const planned = exact(intent.identities[index], ['slot', 'email', 'lease_generation', 'preflight_absent'], 'planned fixture identity');
    if (identity.slot !== request.users[index].slot || identity.email !== request.users[index].email || identity.sub !== request.users[index].user_id
      || typeof identity.username !== 'string' || !identity.username || identity.username.length > 128 || identity.username.includes('@')
      || !uuid.test(identity.lease_generation ?? '')
      || planned.slot !== identity.slot || planned.email !== identity.email || planned.lease_generation !== identity.lease_generation || planned.preflight_absent !== true
      || !timestamp(identity.create_started_at) || !timestamp(identity.captured_at)
      || Date.parse(identity.create_started_at) < intentTime || Date.parse(identity.captured_at) < Date.parse(identity.create_started_at)
      || Date.parse(identity.captured_at) > bootstrapTime) throw new Error('Prepublished creation intent and exact captured subjects unproven');
  });
  if (manifest.identities[0].username === manifest.identities[1].username) throw new Error('Distinct captured usernames required');
  exact(manifest.cleanup_requests, ['primary', 'mismatch', 'sentinel'], 'bootstrap cleanup requests');
  for (const [kind, expected] of Object.entries({ primary: [request.users[0]], sentinel: [request.users[1]],
    mismatch: [{ ...request.users[0], email: request.users[1].email }] })) {
    const row = exact(manifest.cleanup_requests[kind], ['json', 'sha256'], 'captured cleanup request');
    const value = { runScope: request.run_scope, users: expected.map(({ user_id: sub, email }) => ({ sub, email })) };
    if (typeof row.json !== 'string' || row.json !== JSON.stringify(value) || row.sha256 !== sha256(row.json)) throw new Error('Frozen primary/mismatch/sentinel cleanup request mismatch');
  }
  return manifest;
}

export function assertBootstrapBudget(value, manifest, intent = false) {
  exact(value, ['version', 'runScope', 'config', 'accounts'], 'bootstrap account budget');
  if (value.version !== 1 || value.runScope !== manifest.run_scope || canonicalJson(value.config) !== canonicalJson(budget)
    || !Array.isArray(value.accounts) || value.accounts.length !== 2) throw new Error('Exact bootstrap account budget required');
  value.accounts.forEach((account, index) => {
    exact(account, ['email', 'mode', 'status', 'leaseId', 'leaseGeneration', 'createdAt', 'updatedAt',
      ...(!intent ? ['subject'] : []), ...(Object.hasOwn(account, 'reason') ? ['reason'] : [])], 'bootstrap account lease');
    const identity = manifest.identities[index];
    if (account.email !== identity.email || account.mode !== 'worker' || account.leaseGeneration !== identity.lease_generation
      || !uuid.test(account.leaseId ?? '') || account.status !== (intent ? 'provisioning' : 'cleanup_pending')
      || !timestamp(account.createdAt) || !timestamp(account.updatedAt) || Date.parse(account.updatedAt) < Date.parse(account.createdAt)
      || !intent && account.subject !== identity.sub || Object.hasOwn(account, 'reason') && typeof account.reason !== 'string') throw new Error('Captured budget lease/status/identity mismatch');
  });
  if (value.accounts[0].leaseId === value.accounts[1].leaseId) throw new Error('Distinct bootstrap account leases required');
  return value;
}

export async function verifyBootstrapOrigin(env, selector, request, io) {
  const origin = parseBootstrapOrigin(env.BOOTSTRAP_ORIGIN);
  io ??= await bootstrapArtifactIo(env);
  const runEndpoint = `repos/${repository}/actions/runs/${origin.run_id}/attempts/${origin.run_attempt}`;
  const artifactEndpoint = value => `repos/${repository}/actions/artifacts/${value.artifact_id}`;
  const readRun = async () => { const value = await io.api(runEndpoint); assertBootstrapRun(value, origin); return value; };
  const run = await readRun();
  const artifact = await io.api(artifactEndpoint(origin)); assertBootstrapArtifact(artifact, origin, 'bootstrap');
  const files = await io.files(origin, ['bootstrap-manifest.json', 'account-budget.json', 'creation-intent.json']);
  if (sha256(files['bootstrap-manifest.json']) !== origin.manifest_sha256) throw new Error('Raw bootstrap manifest digest mismatch');
  const manifest = parseJson(files['bootstrap-manifest.json']);
  const intentOrigin = exact(manifest.intent_origin, originFields, 'intent artifact origin'); validateOrigin(intentOrigin);
  if (['repository', 'workflow_path', 'source_sha', 'run_id', 'run_attempt'].some(key => intentOrigin[key] !== origin[key]) || intentOrigin.artifact_id === origin.artifact_id) throw new Error('Bootstrap intent must come from the same protected run and a distinct preceding artifact');
  const intentArtifact = await io.api(artifactEndpoint(intentOrigin)); assertBootstrapArtifact(intentArtifact, intentOrigin, 'intent');
  const intentFiles = await io.files(intentOrigin, ['creation-intent.json', 'account-budget.json']);
  if (sha256(intentFiles['creation-intent.json']) !== intentOrigin.manifest_sha256
    || !Buffer.from(intentFiles['creation-intent.json']).equals(Buffer.from(files['creation-intent.json']))) throw new Error('Bootstrap creation intent differs from prepublished immutable bytes');
  const intent = parseJson(intentFiles['creation-intent.json']);
  assertBootstrapManifests(manifest, intent, origin, env, selector, request, intentArtifact, artifact, run);
  const capturedBudget = assertBootstrapBudget(parseJson(files['account-budget.json']), manifest);
  const intentBudget = assertBootstrapBudget(parseJson(intentFiles['account-budget.json']), manifest, true);
  if (capturedBudget.accounts.some((account, index) => account.leaseId !== intentBudget.accounts[index].leaseId
    || account.createdAt !== intentBudget.accounts[index].createdAt)) throw new Error('Bootstrap account lease chain changed after intent publication');
  if (canonicalJson(run) !== canonicalJson(await readRun())) throw new Error('Bootstrap run changed during verification');
  const after = await io.api(artifactEndpoint(origin)); assertBootstrapArtifact(after, origin, 'bootstrap');
  const intentAfter = await io.api(artifactEndpoint(intentOrigin)); assertBootstrapArtifact(intentAfter, intentOrigin, 'intent');
  if (canonicalJson(artifact) !== canonicalJson(after) || canonicalJson(intentArtifact) !== canonicalJson(intentAfter)) throw new Error('Bootstrap artifacts changed during verification');
  return { origin, manifest, intent_origin: intentOrigin, intent_artifact_created_at: intentArtifact.created_at };
}
