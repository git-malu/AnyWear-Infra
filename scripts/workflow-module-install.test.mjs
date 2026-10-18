import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';

// Regression guard for observe run 39102443422: the `record` job ran
// `node scripts/record-deployment.mjs` without installing dependencies, so the
// module's pinned `@git-malu/stage-contracts` import failed with
// ERR_MODULE_NOT_FOUND and the run could not produce a pinnable record.
//
// The rule is structural rather than a list of job names: every job in the
// workflow that runs a repository module must install the pinned dependencies
// before its first module-using step. A newly added job of that shape therefore
// fails until it installs.
//
// It is enforced on the qualified-observation entry, which hosts the `record`
// job this change fixes. The rule is derived from the parsed workflow graph, so
// it already covers any job added to this workflow.
const workflowFile = '.github/workflows/runtime.yml';

// A shell command uses a repository module when it executes a module from the
// repository's own source directories, either directly with Node or through a
// require/import of a repository path.
const repositoryModulePatterns = Object.freeze([
  // `node scripts/record-deployment.mjs`, `node .github/scripts/<script>.mjs`,
  // `node --test scripts/*.test.mjs .github/scripts/*.test.mjs`.
  /\bnode\s+(?:--?[\w-]+(?:=\S+)?\s+)*(?:\.\/)?(?:scripts|packages|bin|test|lib|\.github\/scripts)\/[\w./*{}-]+\.(?:mjs|cjs|js|ts)\b/,
  // `require('./scripts/x.mjs')`, `import(...)`, `from '../scripts/x.mjs'`.
  /\b(?:require\s*\(\s*|import\s*\(\s*|from\s+|import\s+)(['"])(?:\.\.?\/)?(?:scripts|packages|bin|test|lib|\.github\/scripts)\/[\w./-]+\1/,
]);

const installPattern = /\bnpm\s+(?:ci|install)\b/;

const isRepositoryModuleStep = step => typeof step.run === 'string'
  && repositoryModulePatterns.some(pattern => pattern.test(step.run));
const isInstallStep = step => typeof step.run === 'string' && installPattern.test(step.run);

async function loadWorkflow(file) {
  return yaml.load(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
}

test('every job that runs a repository module installs dependencies before it', async () => {
  const workflow = await loadWorkflow(workflowFile);
  const jobs = Object.entries(workflow.jobs ?? {});
  assert.ok(jobs.length > 0, `${workflowFile} declares jobs`);
  const moduleJobs = [];
  for (const [jobName, job] of jobs) {
    const steps = job.steps ?? [];
    const firstModule = steps.findIndex(isRepositoryModuleStep);
    // Jobs that never run a repository module (composite actions install their
    // own dependencies) have nothing to order.
    if (firstModule === -1) continue;
    moduleJobs.push(jobName);
    const firstInstall = steps.findIndex(isInstallStep);
    assert.notEqual(firstInstall, -1,
      `${workflowFile} ${jobName} runs a repository module without an npm ci/npm install step`);
    assert.ok(firstInstall < firstModule,
      `${workflowFile} ${jobName} must install dependencies before its first repository-module step`);
  }
  // Keep the rule observable: the workflow still contains module-running jobs, so
  // a rename cannot make this test pass vacuously.
  assert.ok(moduleJobs.length > 0, `${workflowFile} still runs at least one repository module`);
});
