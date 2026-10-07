import { matches, SHA } from './json-contract.mjs';

export function assertWriterWindow({ token, operation, now = Date.now(), env = process.env }) {
  const prefix = operation === 'observation' ? 'OBSERVATION' : 'INFRA';
  const expected = env[`${prefix}_WRITER_WINDOW`];
  if (typeof token !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(token) || token !== expected) throw new Error('Recorded writer window mismatch');
  const sha = env[`${prefix}_WINDOW_SHA`]; matches(sha, SHA, 'window source SHA');
  if (sha !== env.GITHUB_SHA || env.GITHUB_REF !== 'refs/heads/main') throw new Error('Window authorizes a different source/ref');
  const expiry = Date.parse(env[`${prefix}_WINDOW_EXPIRES_AT`]);
  if (!Number.isFinite(expiry) || now >= expiry) throw new Error('Writer window expired');
  matches(env[`${prefix}_WINDOW_RECORD_URL`], /^https:\/\/github\.com\/git-malu\/AnyWear\/issues\/54#issuecomment-[1-9][0-9]+$/, 'manager window evidence');
  if (operation !== 'observation' && env.INFRA_WINDOW_OPERATION !== operation) throw new Error('Window authorizes a different operation');
  if (env.AWS_ACCOUNT_ID !== '650880818323' || env.AWS_REGION !== 'ap-east-1') throw new Error('Unexpected account/region');
  if (operation !== 'observation' && (env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Infra' || env.ENABLE_BETA_DEPLOY !== 'true')) throw new Error('Infra activation gate closed');
  return { token, source_sha: sha, record_url: env[`${prefix}_WINDOW_RECORD_URL`], operation };
}
