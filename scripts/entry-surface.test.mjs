import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { assertProtectedExecutor, e2eExecutorPaths } from './operation-boundaries.mjs';

// Census guard for the post-#158 Infra surface. It describes the tree that exists
// now: Infra owns Foundation, Billing and the Beta stage base only;
// `AnyWearWorkloadStack-beta` and its deploy chain belong to AnyWear-Service, so
// `deploy-workload` is not an Infra operation. This file asserts the entry files
// and their job/permission shape per job, not per file, so a future file that
// grows a dispatch surface or a credential job fails here.
const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowDirectory = new URL('../.github/workflows/', import.meta.url);
const workflowFile = name => new URL(`../.github/workflows/${name}`, import.meta.url);
const loadWorkflow = async name => yaml.load(await readFile(workflowFile(name), 'utf8'));

const declaresEnvironment = job => Object.hasOwn(job ?? {}, 'environment');
const holdsIdToken = job => job?.permissions?.['id-token'] === 'write';
const credentialJobs = workflow => Object.entries(workflow.jobs ?? {})
  .filter(([, job]) => declaresEnvironment(job) || holdsIdToken(job)).map(([jobName]) => jobName);

const mutateOperations = Object.freeze(['deploy-foundation', 'deploy-billing', 'deploy-platform', 'restore-release',
  'migrate', 'admission-status', 'add-testers', 'set-testers', 'suspend-admission', 'resume-admission']);

test('the workflow directory is exactly the three Beta entries plus the callable and publication files', async () => {
  // GitHub accepts both `.yml` and `.yaml`; the census must see either extension,
  // or a `.yaml` entry would be invisible to every assertion below.
  const files = (await readdir(workflowDirectory)).filter(file => /\.ya?ml$/.test(file)).sort();
  assert.deepEqual(files, ['check.yml', 'mutate.yml', 'production.yml', 'publish-stage-contracts.yml', 'runtime.yml']);
  const workflows = Object.fromEntries(await Promise.all(files.map(async file => [file, await loadWorkflow(file)])));

  const dispatchSurfaces = files.filter(file => Object.hasOwn(workflows[file].on ?? {}, 'workflow_dispatch'));
  assert.deepEqual(dispatchSurfaces, ['mutate.yml', 'runtime.yml'], 'exactly two workflow_dispatch surfaces');

  // The three Beta entries: one automatic check and two manual chains.
  const betaEntries = files.filter(file => file === 'check.yml' || dispatchSurfaces.includes(file));
  assert.deepEqual(betaEntries, ['check.yml', 'mutate.yml', 'runtime.yml']);

  // `check.yml` is the automatic entry: PR plus main pushes, no dispatch surface.
  assert.deepEqual(Object.keys(workflows['check.yml'].on).sort(), ['pull_request', 'push']);
  assert.deepEqual(workflows['check.yml'].on.push, { branches: ['main'] });
  assert.equal(Object.hasOwn(workflows['check.yml'].on, 'workflow_dispatch'), false);

  // `production.yml` stays callable-only and is not an entry.
  assert.deepEqual(Object.keys(workflows['production.yml'].on), ['workflow_call']);
  assert.equal(Object.hasOwn(workflows['production.yml'].on, 'workflow_dispatch'), false);

  // `publish-stage-contracts.yml` is the versioned constructs-package publication
  // workflow, not a Beta entry: it runs only on a `stage-contracts-v*` tag push,
  // holds `packages: write` and no AWS credential.
  assert.deepEqual(Object.keys(workflows['publish-stage-contracts.yml'].on), ['push']);
  assert.deepEqual(workflows['publish-stage-contracts.yml'].on.push, { tags: ['stage-contracts-v*'] });
  assert.equal(Object.hasOwn(workflows['publish-stage-contracts.yml'].on, 'workflow_dispatch'), false);
  assert.equal(workflows['publish-stage-contracts.yml'].permissions?.packages, 'write');
  assert.equal(credentialJobs(workflows['publish-stage-contracts.yml']).length, 0);
});

test('mutate.yml keeps one preflight → verify → deploy → record chain and no workload deploy', async () => {
  const mutate = await loadWorkflow('mutate.yml');
  assert.deepEqual(Object.keys(mutate.jobs), ['preflight', 'verify', 'deploy', 'record']);
  const { preflight, verify, deploy, record } = mutate.jobs;

  assert.equal(preflight.needs, undefined);
  assert.equal(verify.needs, 'preflight');
  assert.equal(deploy.needs, 'verify', 'credentials are acquired only after verification');
  assert.equal(record.needs, 'deploy');

  // Exactly one credential job, scheduled after verify; record holds neither
  // environment nor OIDC.
  assert.deepEqual(credentialJobs(mutate), ['deploy']);
  assert.equal(deploy.environment, 'beta');
  assert.equal(holdsIdToken(deploy), true);
  assert.equal(declaresEnvironment(preflight), false);
  assert.equal(holdsIdToken(preflight), false);
  assert.equal(declaresEnvironment(record), false);
  assert.equal(holdsIdToken(record), false);
  assert.equal(record.environment, undefined);

  // The credential-free preflight is the stage-switch gate.
  assert.match(preflight.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(preflight.if, /vars\.ENABLE_BETA_MUTATION == 'true'/);

  assert.deepEqual(mutate.on.workflow_dispatch.inputs.operation.options, mutateOperations);
  assert.equal(mutate.on.workflow_dispatch.inputs.operation.required, true);
  // #158 step C: the Service-owned release slice is not an Infra operation. No
  // operation, input or step may reintroduce its deploy chain here.
  assert.equal(mutate.on.workflow_dispatch.inputs.operation.options.includes('deploy-workload'), false);
  const text = await readFile(workflowFile('mutate.yml'), 'utf8');
  assert.equal(/deploy-workload/.test(text), false, 'mutate.yml must not name the retired workload operation');
  assert.equal(/AnyWearWorkloadStack-beta/.test(text), false, 'mutate.yml must not deploy the Service-owned release slice');
});

test('runtime.yml keeps state runnable with the switch closed and observe switch-gated', async () => {
  const runtime = await loadWorkflow('runtime.yml');
  assert.deepEqual(Object.keys(runtime.jobs), ['preflight', 'state', 'observe', 'record']);
  const { preflight, state, observe, record } = runtime.jobs;

  assert.equal(preflight.needs, undefined);
  assert.equal(state.needs, 'preflight');
  assert.equal(observe.needs, 'preflight');
  assert.deepEqual(record.needs, ['state', 'observe']);

  // Both observation jobs are credential jobs; the record job is not.
  assert.deepEqual(credentialJobs(runtime), ['state', 'observe']);
  for (const job of [state, observe]) {
    assert.equal(job.environment, 'beta');
    assert.equal(holdsIdToken(job), true);
  }
  assert.equal(declaresEnvironment(record), false);
  assert.equal(holdsIdToken(record), false);
  assert.equal(record.environment, undefined);
  assert.equal(record.if, "always() && (needs.state.result == 'success' || needs.observe.result == 'success')");

  // `state` works with the stage switch closed; only `observe` is switch-gated.
  assert.equal(state.if, "github.ref == 'refs/heads/main' && inputs.operation == 'state'");
  assert.equal(/ENABLE_BETA_MUTATION/.test(state.if), false, 'state must run with the switch closed');
  assert.match(observe.if, /vars\.ENABLE_BETA_MUTATION == 'true'/);
  assert.match(observe.if, /inputs\.operation == 'observe'/);
  assert.deepEqual(runtime.on.workflow_dispatch.inputs.operation.options, ['state', 'observe']);
  assert.equal(runtime.on.workflow_dispatch.inputs.operation.required, true);
});

test('exactly one ENABLE_* switch name exists across workflows and non-test executable sources', async () => {
  // This class regressed before: retired switch names survived the rename in code.
  // Documentation may name them as retired; executable sources and workflows may
  // not, so the retired names are composed here rather than written out and this
  // file is excluded from the scan as a test.
  const retiredNames = [['ENABLE', 'BETA', 'DEPLOY'].join('_'), ['ENABLE', 'BETA', 'CLEANUP', 'ACCEPTANCE'].join('_')];
  const tracked = (await execute('git', ['-C', repositoryRoot, 'ls-files', '.github', 'scripts', 'packages'])).stdout
    .split(/\r?\n/).filter(Boolean)
    .filter(file => /\.(mjs|cjs|ts|yml|yaml)$/.test(file))
    .filter(file => !/(^|\/)(test|tests|__tests__)\//.test(file))
    .filter(file => !/\.(test|spec)\.[^.]+$/.test(file));
  assert.ok(tracked.length > 30, `tracked executable source set too small: ${tracked.length}`);
  const names = new Set();
  for (const file of tracked) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const match of text.matchAll(/ENABLE_[A-Z0-9_]+/g)) names.add(match[0]);
  }
  assert.deepEqual([...names].sort(), ['ENABLE_BETA_MUTATION']);
  for (const retired of retiredNames) assert.equal(names.has(retired), false, `${retired} is retired`);
  // The one switch is referenced by both manual entries.
  for (const file of ['mutate.yml', 'runtime.yml']) {
    assert.match(await readFile(workflowFile(file), 'utf8'), /ENABLE_BETA_MUTATION/, file);
  }
});

test('AnyWear-E2E has exactly one reviewed executor workflow', async () => {
  // `integration.yml` was retired with the E2E consolidation. The allow-list is
  // pinned by identity, not only by behaviour, so a second executor path cannot
  // be added silently.
  assert.deepEqual(e2eExecutorPaths, ['.github/workflows/beta-qualification.yml']);
  const e2e = workflow => ({ GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: '6'.repeat(40),
    GITHUB_RUN_ID: '23', GITHUB_RUN_ATTEMPT: '1', AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1',
    GITHUB_WORKFLOW_REF: `git-malu/AnyWear-E2E/${workflow}@refs/heads/main` });
  const executor = assertProtectedExecutor('5'.repeat(40), e2e('.github/workflows/beta-qualification.yml'));
  assert.equal(executor.repository, 'git-malu/AnyWear-E2E');
  assert.equal(executor.workflow_path, '.github/workflows/beta-qualification.yml');
  for (const retired of ['.github/workflows/integration.yml', '.github/workflows/other.yml']) {
    assert.throws(() => assertProtectedExecutor('5'.repeat(40), e2e(retired)), /workflow required/, retired);
  }
  // The file the retired path named does not exist on disk. Both workflow
  // extensions are enumerated so a `.yaml` file cannot hide the retired name.
  const files = (await readdir(workflowDirectory)).filter(file => /\.ya?ml$/.test(file));
  assert.equal(files.includes('integration.yml'), false);
});
