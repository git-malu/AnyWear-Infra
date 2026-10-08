import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const OWNER_ID = 11473072;
export const targets = Object.freeze({
  service: { name: 'AnyWear-Service', id: 1158460323, sha: '8dfb61b1ff4f671eed27d3a7cb8d315bed3d68ce',
    run: 37659133501, attempt: 1, workflow: '.github/workflows/pipeline.yml' },
  infra: { name: 'AnyWear-Infra', id: 1409047265, sha: '0c514d52f68726cda140200b2ecb2a4c504c635e',
    run: 37660726165, attempt: 1, workflow: '.github/workflows/check.yml' },
  issue: { name: 'AnyWear', id: 1202866423, number: 54, comment: 6041539765 },
});

export function validateGuard(env, checkoutSha) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request' || env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Infra'
    || env.PREFLIGHT_PR_NUMBER !== '1' || env.PREFLIGHT_HEAD_REPOSITORY_ID !== '1409047265'
    || env.PREFLIGHT_HEAD_REF !== 'codex/issue-54-infra-extraction' || env.PREFLIGHT_BASE_REF !== 'main'
    || !/^[0-9a-f]{40}$/.test(env.APP_ACCESS_REVIEWED_SHA ?? '')
    || env.APP_ACCESS_REVIEWED_SHA !== env.PREFLIGHT_SOURCE_SHA || checkoutSha !== env.PREFLIGHT_SOURCE_SHA) {
    throw new Error('App preflight requires the reviewed same-repository PR1 head and exact checkout');
  }
}

function repositoryIdentity(value, target) {
  if (value.id !== target.id || value.full_name !== `git-malu/${target.name}`
    || value.owner?.id !== OWNER_ID || value.owner?.login !== 'git-malu' || value.private !== true) {
    throw new Error('Private repository identity mismatch');
  }
}

export async function verifyAccess(mode, get) {
  const target = targets[mode];
  if (!target) throw new Error('Unknown access scope');
  const prefix = `/repos/git-malu/${target.name}`;
  const installation = await get('/installation/repositories?per_page=100');
  if (installation.total_count !== 1 || installation.repositories?.length !== 1) throw new Error('Token must cover exactly one requested repository');
  repositoryIdentity(installation.repositories[0], target);
  repositoryIdentity(await get(prefix), target);
  const result = { schema_version: 1, record_type: 'anywear_app_access_preflight', app_id: 3346940,
    scope: mode, repository: `git-malu/${target.name}`, repository_id: target.id, owner_id: OWNER_ID,
    token_repository_count: 1, verified: true, mutation_performed: false };
  if (mode === 'issue') {
    const issue = await get(`${prefix}/issues/${target.number}`);
    const comment = await get(`${prefix}/issues/comments/${target.comment}`);
    if (issue.number !== target.number || issue.state !== 'open' || issue.pull_request
      || issue.html_url !== `https://github.com/git-malu/${target.name}/issues/${target.number}`
      || comment.id !== target.comment || comment.user?.id !== OWNER_ID || comment.user?.login !== 'git-malu'
      || comment.issue_url !== `https://api.github.com${prefix}/issues/${target.number}`
      || !comment.body?.includes('Issue owner: `/root/issue54`') || !comment.body?.includes('Transfer: 0')) {
      throw new Error('Issue or original owner claim mismatch');
    }
    return { ...result, permissions_requested: { issues: 'read' }, issue_number: target.number, claim_comment_id: target.comment };
  }
  const commit = await get(`${prefix}/git/commits/${target.sha}`);
  const run = await get(`${prefix}/actions/runs/${target.run}/attempts/${target.attempt}`);
  if (commit.sha !== target.sha || run.id !== target.run || run.run_attempt !== target.attempt
    || run.head_sha !== target.sha || run.path !== target.workflow || run.status !== 'completed'
    || run.conclusion !== 'success') throw new Error('Exact source or successful Actions attempt mismatch');
  repositoryIdentity(run.repository, target);
  return { ...result, permissions_requested: { contents: 'read', actions: 'read' }, source_sha: target.sha,
    source_run_id: target.run, source_run_attempt: target.attempt, source_workflow: target.workflow,
    source_run_conclusion: run.conclusion };
}

async function main() {
  const mode = process.argv[2];
  const checkoutSha = execFileSync('git', ['--no-replace-objects', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  validateGuard(process.env, checkoutSha);
  if (mode === 'guard') return;
  if (!process.env.GH_TOKEN) throw new Error('Scoped App token missing');
  const get = async endpoint => {
    const response = await fetch(`https://api.github.com${endpoint}`, { method: 'GET',
      headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`GitHub read failed (${response.status}) for ${endpoint}`);
    return response.json();
  };
  const evidence = { ...await verifyAccess(mode, get), preflight_source_sha: checkoutSha,
    preflight_run_id: process.env.GITHUB_RUN_ID, preflight_run_attempt: process.env.GITHUB_RUN_ATTEMPT,
    verified_at: new Date().toISOString() };
  await mkdir('app-access-evidence', { recursive: true });
  await writeFile(`app-access-evidence/${mode}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${mode}: verified private repository ${evidence.repository_id}; requested permissions ${JSON.stringify(evidence.permissions_requested)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
