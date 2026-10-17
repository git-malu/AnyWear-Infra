import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { canonicalJson, contentHash, parseJson, sha256 } from './json-contract.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { configuredStacks, validateStackManifest } from './operation-stacks.mjs';
import { createOperationRecord } from './operation-record.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';

const execute = promisify(execFile);
const evidenceFile = 'deployment-evidence/stack-sources.json';

// Reproduce the read `runtime-operation.mjs` performs for every operation. A
// read-only `state` job has no verify job, so the only thing that can produce this
// file is the deploy-operation pre-credential block fixed alongside this test.
async function stateFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'infra-state-inputs-'));
  const { selector } = await createTestInputs(await mkdtemp(path.join(os.tmpdir(), 'infra-state-inputs-artifacts-')));
  const mapBytes = await readFile(new URL('../stack-sources/beta-restart.json', import.meta.url));
  await cp(new URL('.', import.meta.url), path.join(root, 'scripts'), { recursive: true });
  await cp(new URL('../.github/scripts/', import.meta.url), path.join(root, '.github/scripts'), { recursive: true });
  await mkdir(path.join(root, 'selections'));
  await mkdir(path.join(root, 'stack-sources'));
  await writeFile(path.join(root, '.gitignore'), 'deployment-evidence/\n.service-artifacts/\n');
  await writeFile(path.join(root, 'selections/beta.json'), canonicalJson(selector));
  await writeFile(path.join(root, 'stack-sources/beta-restart.json'), mapBytes);
  const git = async args => (await execute('git', ['-C', root, ...args])).stdout.trim();
  await git(['init', '--quiet']);
  await git(['config', 'core.autocrlf', 'false']);
  await git(['config', 'user.name', 'State inputs fixture']);
  await git(['config', 'user.email', 'fixture@invalid.local']);
  await git(['remote', 'add', 'origin', 'https://github.com/git-malu/AnyWear-Infra.git']);
  await git(['add', '.']);
  await git(['commit', '--quiet', '-m', 'Reviewed state inputs']);
  const env = {
    GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: await git(['rev-parse', 'HEAD']), GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main',
    GITHUB_RUN_ID: '23', GITHUB_RUN_ATTEMPT: '1',
    AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1',
    // Exactly the runtime.yml state job: the stage switch is closed.
    ENABLE_BETA_MUTATION: 'false', INFRA_OPERATION: 'state',
    INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true', TESTER_EMAILS: '[]', WINDOW_MINUTES: '60',
    SELECTION_FILE: 'selections/beta.json', SELECTION_SHA256: contentHash(selector),
    STACK_SOURCES_FILE: 'stack-sources/beta-restart.json', STACK_SOURCES_SHA256: sha256(mapBytes),
  };
  return { root, selector, env };
}

const run = (root, env, script) => execute(process.execPath, [script], { cwd: root, env: { ...process.env, ...env }, timeout: 60_000 });

test('the state job produces the reviewed stack manifest before the operation record reads it', async () => {
  const { root, selector, env } = await stateFixture();
  const readEvidence = async () => parseJson(await readFile(path.join(root, evidenceFile)));
  // Before the composite's pre-credential block runs there is no manifest: this is
  // the production failure the fix removes (ENOENT at runtime-operation.mjs).
  await assert.rejects(readEvidence(), error => error.code === 'ENOENT');
  // The state job's env is valid with the stage switch closed.
  validateOperationInputs(env);
  // The composite creates the evidence directory and runs both checks before the
  // App token. `check-operation.mjs` alone does not write the manifest.
  await mkdir(path.join(root, 'deployment-evidence'), { recursive: true });
  await run(root, env, 'scripts/check-operation.mjs');
  await assert.rejects(readEvidence(), error => error.code === 'ENOENT');
  await run(root, env, 'scripts/check-stack-sources.mjs');
  // The exact read `runtime-operation.mjs` performs now succeeds and builds the
  // same state record: no deployment record, family beta-observe, no stack change.
  const bytes = await readFile(path.join(root, evidenceFile));
  const stackManifest = validateStackManifest(parseJson(bytes), 'state stack sources');
  assert.equal(stackManifest.length, configuredStacks.length);
  const record = createOperationRecord({ env, selector, stackManifest: parseJson(await readFile(path.join(root, evidenceFile))) });
  assert.equal(record.record_type, 'anywear_infra_operation');
  assert.equal(record.operation, 'state');
  assert.equal(record.family, 'beta-observe');
  assert.deepEqual(record.changed_stack_names, []);
  assert.equal(record.stack_manifest.length, configuredStacks.length);
});

test('the state path runs the source and stack checks before the App token', async () => {
  const action = yaml.load(await readFile(new URL('../.github/actions/deploy-operation/action.yml', import.meta.url), 'utf8'));
  const steps = action.runs.steps;
  const checks = steps.findIndex(step => step.if === "inputs.verify_artifact == 'false'"
    && (step.run ?? '').includes('check-stack-sources.mjs'));
  assert.ok(checks >= 0, 'deploy-operation declares the state pre-credential checks');
  assert.ok(checks < steps.findIndex(step => step.id === 'app'), 'checks run before the App token exists');
  assert.match(steps[checks].run, /mkdir -p deployment-evidence/);
  assert.match(steps[checks].run, /check-operation\.mjs/);
  assert.match(steps[checks].run, /check-stack-sources\.mjs/);
  assert.equal(steps[checks].run.includes('check-verified-inputs.mjs'), false);
  // The verified-artifact path stays exclusive: it already ran these checks in the
  // verify job and must not repeat them here.
  const bind = steps.findIndex(step => (step.run ?? '').includes('check-verified-inputs.mjs'));
  assert.ok(bind >= 0 && bind < steps.findIndex(step => step.id === 'app'));
  assert.equal(steps[bind].if, "inputs.verify_artifact == 'true'");
});
