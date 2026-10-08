import { createPrivateKey, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateGuard } from './app-access-preflight.mjs';

export const APP_ID = 3346940;
export const INSTALLATION_ID = 123158580;
const ACCOUNT_ID = 11473072;
const ACCOUNT_LOGIN = 'git-malu';
const ENDPOINTS = Object.freeze(['/app', `/app/installations/${INSTALLATION_ID}`]);
const PERMISSION_LEVELS = Object.freeze({ read: 1, write: 2, admin: 3 });

export function createAppJwt(privateKey, nowSeconds) {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 60) throw new Error('Invalid App JWT clock');
  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('Unsupported key');
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: nowSeconds - 60,
      exp: nowSeconds + 540, iss: String(APP_ID) })}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
  } catch {
    throw new Error('App signing key is missing or invalid');
  }
}

function identity(value) {
  if (!Number.isSafeInteger(value?.id) || value.id <= 0
    || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(value.login ?? '')
    || !['User', 'Organization', 'Bot'].includes(value.type)) throw new Error('Invalid App identity metadata');
  return { id: value.id, login: value.login, type: value.type };
}

function permissions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid App permission metadata');
  const entries = Object.entries(value);
  if (entries.some(([name, level]) => !/^[a-z][a-z_]{0,79}$/.test(name)
    || !Object.hasOwn(PERMISSION_LEVELS, level))) throw new Error('Invalid App permission metadata');
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

export function sanitizeRegistration(app, installation) {
  if (app?.id !== APP_ID || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(app.slug ?? '')
    || installation?.id !== INSTALLATION_ID || installation.app_id !== APP_ID
    || installation.account?.id !== ACCOUNT_ID || installation.account.login !== ACCOUNT_LOGIN
    || !['all', 'selected'].includes(installation.repository_selection)
    || (installation.suspended_at !== null && (typeof installation.suspended_at !== 'string'
      || !Number.isFinite(Date.parse(installation.suspended_at))))) throw new Error('App or installation identity mismatch');
  const owner = identity(app.owner);
  const account = identity(installation.account);
  const configured = permissions(app.permissions);
  const installed = permissions(installation.permissions);
  const comparison = Object.fromEntries(['contents', 'actions', 'issues', 'attestations'].map(name => [name, {
    configured: configured[name] ?? null, installed: installed[name] ?? null,
    configured_read_declared: (PERMISSION_LEVELS[configured[name]] ?? 0) >= PERMISSION_LEVELS.read,
    installed_read_declared: (PERMISSION_LEVELS[installed[name]] ?? 0) >= PERMISSION_LEVELS.read,
  }]));
  return { schema_version: 1, record_type: 'anywear_app_registration_metadata', metadata_only: true,
    scoped_access_verified: false, mutation_performed: false, app_id: APP_ID, app_slug: app.slug,
    app_owner: owner, installation_id: INSTALLATION_ID, installation_account: account,
    configured_permissions: configured, installation_permissions: installed, permission_comparison: comparison,
    repository_selection: installation.repository_selection, suspended_at: installation.suspended_at,
    attestations_comparison_purpose: 'Later native immutable-release read gate; no scope is requested by this diagnostic',
    app_permissions_url: owner.type === 'Organization'
      ? `https://github.com/organizations/${owner.login}/settings/apps/${app.slug}/permissions`
      : `https://github.com/settings/apps/${app.slug}/permissions` };
}

export async function collectRegistrationMetadata({ env, checkoutSha, keyProvider,
  fetchImpl = fetch, nowSeconds = Math.floor(Date.now() / 1000) }) {
  validateGuard(env, checkoutSha);
  const jwt = createAppJwt(keyProvider(), nowSeconds);
  const get = async endpoint => {
    if (!ENDPOINTS.includes(endpoint)) throw new Error('Unreviewed App metadata endpoint');
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${endpoint}`, { method: 'GET', redirect: 'error',
        headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error('GitHub App metadata request failed');
    }
    if (!response.ok) throw new Error(`GitHub App metadata read failed (${response.status})`);
    try { return await response.json(); } catch { throw new Error('Invalid GitHub App metadata response'); }
  };
  const app = await get(ENDPOINTS[0]);
  if (app?.id !== APP_ID) throw new Error('Authenticated App identity mismatch');
  return sanitizeRegistration(app, await get(ENDPOINTS[1]));
}

async function main() {
  try {
    const checkoutSha = execFileSync('git', ['--no-replace-objects', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const result = await collectRegistrationMetadata({ env: process.env, checkoutSha,
      keyProvider: () => process.env.APP_PRIVATE_KEY });
    const evidence = { ...result, preflight_source_sha: checkoutSha, preflight_run_id: process.env.GITHUB_RUN_ID,
      preflight_run_attempt: process.env.GITHUB_RUN_ATTEMPT, observed_at: new Date().toISOString() };
    await mkdir('app-access-evidence', { recursive: true });
    await writeFile('app-access-evidence/registration-metadata.json', `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`App ${APP_ID} installation ${INSTALLATION_ID}: metadata recorded; scoped access remains unverified\n`);
  } catch {
    // Do not print request/client/crypto error objects: they can contain credentials.
    process.stderr.write('App registration metadata check failed; no scoped access proof produced\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
