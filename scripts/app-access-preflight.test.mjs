import test from 'node:test';
import assert from 'node:assert/strict';
import { targets, validateGuard, verifyAccess } from './app-access-preflight.mjs';

const sha = 'a'.repeat(40);
const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra',
  PREFLIGHT_PR_NUMBER: '1', PREFLIGHT_HEAD_REPOSITORY_ID: '1409047265',
  PREFLIGHT_HEAD_REF: 'codex/issue-54-infra-extraction', PREFLIGHT_BASE_REF: 'main',
  APP_ACCESS_REVIEWED_SHA: sha, PREFLIGHT_SOURCE_SHA: sha };
const repo = target => ({ id: target.id, full_name: `git-malu/${target.name}`, private: true,
  owner: { id: 11473072, login: 'git-malu' } });
function fixtures(mode) {
  const target = targets[mode]; const prefix = `/repos/git-malu/${target.name}`;
  const values = { '/installation/repositories?per_page=100': { total_count: 1, repositories: [repo(target)] },
    [prefix]: repo(target) };
  if (mode === 'issue') {
    values[`${prefix}/issues/54`] = { number: 54, state: 'open', html_url: 'https://github.com/git-malu/AnyWear/issues/54' };
    values[`${prefix}/issues/comments/${target.comment}`] = { id: target.comment,
      user: { id: 11473072, login: 'git-malu' }, issue_url: `https://api.github.com${prefix}/issues/54`,
      body: 'Issue owner: `/root/issue54`; Transfer: 0' };
  } else {
    values[`${prefix}/git/commits/${target.sha}`] = { sha: target.sha };
    values[`${prefix}/actions/runs/${target.run}/attempts/1`] = { id: target.run, run_attempt: 1,
      head_sha: target.sha, path: target.workflow, status: 'completed', conclusion: 'success', repository: repo(target) };
  }
  return { target, prefix, values, get: async endpoint => { assert.ok(Object.hasOwn(values, endpoint)); return values[endpoint]; } };
}

test('secret guard rejects foreign PR/ref, unreviewed SHA, and checkout substitution', () => {
  validateGuard(env, sha);
  for (const patch of [{ GITHUB_EVENT_NAME: 'push' }, { PREFLIGHT_PR_NUMBER: '2' },
    { PREFLIGHT_HEAD_REPOSITORY_ID: '9' }, { PREFLIGHT_HEAD_REF: 'foreign' }, { PREFLIGHT_BASE_REF: 'branch' },
    { APP_ACCESS_REVIEWED_SHA: '' }, { PREFLIGHT_SOURCE_SHA: 'b'.repeat(40) }]) {
    assert.throws(() => validateGuard({ ...env, ...patch }, sha));
  }
  assert.throws(() => validateGuard(env, 'b'.repeat(40)));
});

test('separate tokens prove exact private repository and source/attempt or claim reads', async () => {
  for (const mode of ['service', 'infra', 'issue']) {
    const fixture = fixtures(mode); const result = await verifyAccess(mode, fixture.get);
    assert.equal(result.verified, true); assert.equal(result.mutation_performed, false);
    fixture.values['/installation/repositories?per_page=100'].total_count = 2;
    await assert.rejects(verifyAccess(mode, fixture.get), /exactly one/);
  }
});

test('access proof rejects repository substitution and failed or replaced exact attempts', async () => {
  for (const patch of [{ conclusion: 'failure' }, { run_attempt: 2 }, { head_sha: sha }, { path: '.github/workflows/other.yml' }]) {
    const fixture = fixtures('service'); Object.assign(fixture.values[`${fixture.prefix}/actions/runs/${fixture.target.run}/attempts/1`], patch);
    await assert.rejects(verifyAccess('service', fixture.get), /attempt mismatch/);
  }
  const fixture = fixtures('infra'); fixture.values[fixture.prefix].owner.id = 1;
  await assert.rejects(verifyAccess('infra', fixture.get), /identity mismatch/);
});

test('root issues read rejects a different owner claim even if the issue is accessible', async () => {
  const fixture = fixtures('issue'); fixture.values[`${fixture.prefix}/issues/comments/${fixture.target.comment}`].body = 'Other owner';
  await assert.rejects(verifyAccess('issue', fixture.get), /owner claim mismatch/);
});
