import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { APP_ID, INSTALLATION_ID, createAppJwt, sanitizeRegistration,
  collectRegistrationMetadata } from './app-registration-metadata.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
const sha = 'a'.repeat(40);
const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra',
  PREFLIGHT_PR_NUMBER: '1', PREFLIGHT_HEAD_REPOSITORY_ID: '1409047265',
  PREFLIGHT_HEAD_REF: 'codex/issue-54-infra-extraction', PREFLIGHT_BASE_REF: 'main',
  APP_ACCESS_REVIEWED_SHA: sha, PREFLIGHT_SOURCE_SHA: sha };
function fixture() {
  return { app: { id: APP_ID, slug: 'actual-anywear-app', owner: { id: 70001, login: 'app-owner', type: 'User' },
    permissions: { contents: 'write', actions: 'read', issues: 'read', attestations: 'read' },
    client_secret: 'must-not-persist', private_key: 'must-not-persist' },
  installation: { id: INSTALLATION_ID, app_id: APP_ID, account: { id: 11473072, login: 'git-malu', type: 'User' },
    permissions: { contents: 'write' }, repository_selection: 'selected', suspended_at: null,
    access_tokens_url: 'must-not-persist', token: 'must-not-persist' } };
}
const options = () => ({ env, checkoutSha: sha, keyProvider: () => pem, nowSeconds: 1_800_000_000 });

test('JWT has a valid RS256 signature, fixed App issuer and bounded ten-minute claims', () => {
  const jwt = createAppJwt(pem, 1_800_000_000);
  const [header, payload, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iat: 1_799_999_940, exp: 1_800_000_540, iss: String(APP_ID) });
  assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), true);
});

test('guard runs before protected key access or any metadata request', async () => {
  for (const patch of [{ APP_ACCESS_REVIEWED_SHA: '' }, { PREFLIGHT_HEAD_REPOSITORY_ID: '1' },
    { PREFLIGHT_HEAD_REF: 'foreign' }, { PREFLIGHT_PR_NUMBER: '2' }, { PREFLIGHT_BASE_REF: 'foreign' }]) {
    let touched = false;
    await assert.rejects(collectRegistrationMetadata({ ...options(), env: { ...env, ...patch },
      keyProvider: () => { touched = true; return pem; }, fetchImpl: () => { touched = true; } }));
    assert.equal(touched, false);
  }
});

test('invalid and non-RSA signing keys fail without exposing key text', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' });
  for (const key of ['PRIVATE-KEY-SENTINEL', undefined, ec]) {
    assert.throws(() => createAppJwt(key, 1_800_000_000), /^Error: App signing key is missing or invalid$/);
  }
  assert.throws(() => createAppJwt(pem, NaN), /Invalid App JWT clock/);
});

test('metadata uses only two fixed GET endpoints and rejects credential-bearing redirects', async () => {
  const data = fixture(); const calls = [];
  const result = await collectRegistrationMetadata({ ...options(), fetchImpl: async (url, init) => {
    calls.push(url); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    const token = init.headers.authorization.slice('Bearer '.length);
    const pieces = token.split('.');
    assert.equal(verify('RSA-SHA256', Buffer.from(pieces.slice(0, 2).join('.')), publicKey, Buffer.from(pieces[2], 'base64url')), true);
    return { ok: true, json: async () => calls.length === 1 ? data.app : data.installation };
  } });
  assert.deepEqual(calls, ['https://api.github.com/app', `https://api.github.com/app/installations/${INSTALLATION_ID}`]);
  assert.equal(result.metadata_only, true); assert.equal(result.scoped_access_verified, false);
  assert.equal(JSON.stringify(result).includes('must-not-persist'), false);
  assert.equal(JSON.stringify(result).includes(pem.toString()), false);
});

test('a different authenticated App stops before the installation request', async () => {
  let calls = 0;
  await assert.rejects(collectRegistrationMetadata({ ...options(), fetchImpl: async () => {
    calls++; return { ok: true, json: async () => ({ id: 1 }) };
  } }), /Authenticated App identity mismatch/);
  assert.equal(calls, 1);
});

test('metadata rejects installation substitution and preserves independently identified App owner', () => {
  for (const patch of [{ id: 1 }, { app_id: 1 }, { account: { id: 1, login: 'git-malu', type: 'User' } },
    { account: { id: 11473072, login: 'someone-else', type: 'User' } }, { repository_selection: 'unknown' },
    { suspended_at: 'not-a-date' }]) {
    const data = fixture(); assert.throws(() => sanitizeRegistration(data.app, { ...data.installation, ...patch }));
  }
  const data = fixture(); const result = sanitizeRegistration(data.app, data.installation);
  assert.deepEqual(result.app_owner, { id: 70001, login: 'app-owner', type: 'User' });
  assert.equal(result.app_permissions_url, 'https://github.com/settings/apps/actual-anywear-app/permissions');
});

test('configured versus installed permissions remain metadata, including the future attestations read gap', () => {
  const data = fixture(); const result = sanitizeRegistration(data.app, data.installation);
  assert.equal(result.permission_comparison.actions.configured_read_declared, true);
  assert.equal(result.permission_comparison.actions.installed_read_declared, false);
  assert.equal(result.permission_comparison.attestations.configured, 'read');
  assert.equal(result.permission_comparison.attestations.installed, null);
  assert.equal(result.scoped_access_verified, false);
  data.app.owner = { id: 9, login: 'app-org', type: 'Organization' };
  data.installation.suspended_at = '2026-10-08T01:00:00Z';
  assert.equal(sanitizeRegistration(data.app, data.installation).app_permissions_url,
    'https://github.com/organizations/app-org/settings/apps/actual-anywear-app/permissions');
});

test('credential-shaped API fields, invalid permission levels and URL injection never enter evidence', () => {
  for (const mutate of [d => { d.app.slug = 'app/../../secret'; },
    d => { d.installation.permissions.actions = 'JWT-SECRET-SENTINEL'; },
    d => { d.app.owner.login = 'owner?secret'; }]) {
    const data = fixture(); mutate(data); assert.throws(() => sanitizeRegistration(data.app, data.installation));
  }
});

test('network and HTTP errors do not expose JWT, key or response body', async () => {
  await assert.rejects(collectRegistrationMetadata({ ...options(), fetchImpl: async (_url, init) => {
    throw new Error(`${init.headers.authorization} ${pem}`);
  } }), /^Error: GitHub App metadata request failed$/);
  let bodyRead = false;
  await assert.rejects(collectRegistrationMetadata({ ...options(), fetchImpl: async () => ({ ok: false, status: 422,
    json: async () => { bodyRead = true; return { secret: pem }; } }) }), /^Error: GitHub App metadata read failed \(422\)$/);
  assert.equal(bodyRead, false);
});

test('workflow puts metadata credentials after checkout guard and keeps failed scopes independent', async () => {
  const workflow = await readFile(new URL('../.github/workflows/app-access-preflight.yml', import.meta.url), 'utf8');
  const guard = workflow.indexOf('run: node scripts/app-access-preflight.mjs guard');
  const metadata = workflow.indexOf('run: node scripts/app-registration-metadata.mjs');
  const service = workflow.indexOf('- name: Create Service read token');
  assert.ok(guard >= 0 && metadata > guard && service > metadata);
  assert.match(workflow.slice(guard, service), /steps\.guard\.outcome == 'success'/);
  assert.match(workflow.slice(guard, service), /APP_PRIVATE_KEY: \$\{\{ secrets\.APP_PRIVATE_KEY \}\}/);
  assert.doesNotMatch(workflow, /id-token:|permission-actions: write/);
  const serviceToken = workflow.slice(service, workflow.indexOf('- name: Verify exact Service source'));
  assert.match(serviceToken, /repositories: AnyWear-Service\s+permission-contents: read\s+permission-actions: read\s+permission-attestations: read/);
  assert.doesNotMatch(workflow.slice(workflow.indexOf('- name: Create Infra read token')), /permission-attestations:/);
});
