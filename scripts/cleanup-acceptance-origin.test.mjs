import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from './json-contract.mjs';
import { parseBootstrapOrigin, assertBootstrapRun, assertBootstrapArtifact, assertBootstrapManifests,
  assertBootstrapBudget, verifyBootstrapOrigin } from './cleanup-acceptance-origin.mjs';
import { cleanupAcceptanceBootstrap } from '../test/fixtures/cleanup-acceptance-bootstrap.mjs';

const fixture = cleanupAcceptanceBootstrap();
const manifests = value => assertBootstrapManifests(value.manifest, value.intent, value.origin, value.env, value.selector,
  value.request, value.intentArtifact, value.bootstrapArtifact, value.run);

function ioFor(value, mutate) {
  const counts = {};
  return { counts, async api(endpoint) {
    const key = endpoint.includes('/runs/') ? 'run' : endpoint.endsWith('/456') ? 'intentArtifact' : 'bootstrapArtifact';
    counts[key] = (counts[key] ?? 0) + 1;
    const response = structuredClone(value[key]);
    mutate?.(response, key, counts[key]);
    return response;
  }, async files(origin, names) {
    assert.deepEqual(names, origin.artifact_id === 456 ? ['creation-intent.json', 'account-budget.json']
      : ['bootstrap-manifest.json', 'account-budget.json', 'creation-intent.json']);
    return origin.artifact_id === 456 ? value.intentFiles : value.files;
  } };
}

test('exact E2E-shaped bootstrap authenticates intent, budgets, producer tuple and immutable rereads', async () => {
  assert.deepEqual(parseBootstrapOrigin(fixture.env.BOOTSTRAP_ORIGIN), fixture.origin);
  manifests(fixture);
  const io = ioFor(fixture);
  const result = await verifyBootstrapOrigin(fixture.env, fixture.selector, fixture.request, io);
  assert.deepEqual(result, { origin: fixture.origin, manifest: fixture.manifest, intent_origin: fixture.intentOrigin,
    intent_artifact_created_at: fixture.intentArtifact.created_at });
  assert.deepEqual(io.counts, { run: 2, bootstrapArtifact: 2, intentArtifact: 2 });
});

test('bootstrap origin/run/artifact rejects incomplete, unprotected, reused or expired evidence', () => {
  for (const json of [JSON.stringify(fixture.origin), ` ${fixture.env.BOOTSTRAP_ORIGIN}`,
    canonicalJson({ ...fixture.origin, extra: true }), canonicalJson({ ...fixture.origin, run_id: '123' }),
    canonicalJson({ ...fixture.origin, artifact_sha256: `sha256:${fixture.origin.artifact_sha256}` })]) assert.throws(() => parseBootstrapOrigin(json));
  for (const mutate of [r => r.run_attempt = 2, r => r.event = 'push', r => r.conclusion = 'failure', r => r.head_sha = '0'.repeat(40),
    r => r.head_branch = 'candidate', r => r.repository.owner.id++, r => r.head_repository.id++, r => r.updated_at = 'invalid']) {
    const bad = structuredClone(fixture.run); mutate(bad); assert.throws(() => assertBootstrapRun(bad, fixture.origin));
  }
  for (const mutate of [a => a.expired = true, a => a.expires_at = '2000-01-01T00:00:00Z', a => delete a.created_at,
    a => a.digest = `sha256:${'0'.repeat(64)}`, a => a.size_in_bytes = 2 * 1024 * 1024 + 1,
    a => a.workflow_run.head_branch = 'candidate', a => a.name += '-reused']) {
    const bad = structuredClone(fixture.bootstrapArtifact); mutate(bad); assert.throws(() => assertBootstrapArtifact(bad, fixture.origin, 'bootstrap'));
  }
});

test('bootstrap binds creation timing, exact captured UUIDs, scope, frozen tuple and cleanup bytes', () => {
  for (const mutate of [f => f.manifest.identities[0].lease_generation = 1,
    f => f.manifest.identities[1].username = f.manifest.identities[0].username,
    f => f.manifest.identities[0].username = f.manifest.identities[0].email,
    f => f.intent.identities[0].preflight_absent = false, f => f.intent.identities[0].lease_generation = f.intent.identities[1].lease_generation,
    f => f.manifest.identities[0].create_started_at = '2026-10-10T01:00:01Z',
    f => f.manifest.identities[0].captured_at = '2026-10-10T01:00:06Z',
    f => f.intent.created_at = '2026-10-10T01:00:03Z', f => f.bootstrapArtifact.created_at = '2026-10-10T01:00:07Z',
    f => f.manifest.producer.source_sha = '0'.repeat(40), f => f.manifest.frozen_tuple.fixture_source_sha = '0'.repeat(40),
    f => f.manifest.account_budget_config.maxNewAccountsPerRun = 3,
    f => f.manifest.cleanup_requests.primary.json = f.manifest.cleanup_requests.sentinel.json,
    f => f.manifest.cleanup_requests.mismatch.sha256 = '0'.repeat(64), f => f.manifest.extra = true,
    f => { f.origin.run_id = 124; f.manifest.producer.run_id = 124; f.intent.producer.run_id = 124; }]) {
    const bad = structuredClone(fixture); mutate(bad); assert.throws(() => manifests(bad));
  }
});

test('captured and prepublished budgets reject changed status, scope, subjects and lease chain', async () => {
  assertBootstrapBudget(fixture.capturedBudget, fixture.manifest);
  assertBootstrapBudget(fixture.intentBudget, fixture.manifest, true);
  for (const mutate of [b => b.accounts.pop(), b => b.accounts[0].status = 'deleted', b => b.accounts[0].leaseGeneration = 'invalid',
    b => b.accounts[0].subject = fixture.manifest.identities[1].sub, b => b.runScope = 'other',
    b => b.accounts[1].leaseId = b.accounts[0].leaseId, b => b.accounts[0].extra = true]) {
    const bad = structuredClone(fixture.capturedBudget); mutate(bad); assert.throws(() => assertBootstrapBudget(bad, fixture.manifest));
  }
  const bad = cleanupAcceptanceBootstrap();
  bad.capturedBudget.accounts[0].leaseId = '99999999-1111-1111-1111-111111111111';
  bad.files['account-budget.json'] = Buffer.from(JSON.stringify(bad.capturedBudget));
  await assert.rejects(verifyBootstrapOrigin(bad.env, bad.selector, bad.request, ioFor(bad)), /lease chain/);
});

test('raw manifest/intent mismatches and metadata changes fail closed on reread', async () => {
  for (const change of [f => f.files['bootstrap-manifest.json'] = Buffer.from('{}'),
    f => f.files['creation-intent.json'] = Buffer.from('{}'), f => f.intentFiles['creation-intent.json'] = Buffer.from('{}'),
    f => f.files['account-budget.json'] = Buffer.from('{"version":1,"version":1}')]) {
    const bad = cleanupAcceptanceBootstrap(); change(bad);
    await assert.rejects(verifyBootstrapOrigin(bad.env, bad.selector, bad.request, ioFor(bad)));
  }
  for (const key of ['run', 'bootstrapArtifact', 'intentArtifact']) {
    const io = ioFor(fixture, (response, current, count) => { if (current === key && count === 2) response.metadata_changed = true; });
    await assert.rejects(verifyBootstrapOrigin(fixture.env, fixture.selector, fixture.request, io), /changed/);
  }
});
