import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, parseJson } from './json-contract.mjs';
import { configuredStacks } from './operation-stacks.mjs';
import { stageContractSchemaHash, validateDeploymentRecord, validateObservationRecord } from './deployment-contract.mjs';
import { createOperationRecord } from './operation-record.mjs';
import { finalizeOperationRecord } from './finalize-operation.mjs';
import { buildDeploymentRecord, familyObservationRecordType } from './observation-record.mjs';
import { recordDeployment } from './record-deployment.mjs';

// Issue #181: the credential-free `record` job decides whether a deployment is
// complete. These tests exercise it in a temporary evidence directory: the accepted
// record must exist for a trigger operation, and a missing one marks the operation
// record incomplete before the run fails.
const infraSha = 'a'.repeat(40);
const endpoint = 'https://d111111abcdef8.cloudfront.net';
const inputs = () => [{ parameter: '/anywear/beta/vpc_id', version: '4', value_sha256: 'd'.repeat(64) },
  { parameter: '/anywear/beta/vpc_secondary_id', version: '7', value_sha256: 'e'.repeat(64) }];
const body = () => {
  const rows = inputs();
  return { stacks: configuredStacks.map(stack => ({ name: stack.stack_name, region: stack.region,
      producer_repository: 'git-malu/AnyWear-Infra', producer_sha: infraSha, template_sha256: 'f'.repeat(64) })),
    inputs: rows,
    observed: { lambdas: {
      'pre-sign-up': { code_sha256: `${'A'.repeat(43)}=`, configuration_sha256: '1'.repeat(64) },
      'post-confirmation': { code_sha256: `${'B'.repeat(43)}=`, configuration_sha256: '2'.repeat(64) } },
    queue_config_sha256: '3'.repeat(64), client_sha: '4'.repeat(40), endpoints: { client: endpoint } },
    schema: { content_sha256: stageContractSchemaHash(rows) } };
};
const runtimeOperations = ['observe', 'state'];
const env = (operation = 'deploy-platform', overrides = {}) => ({
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: infraSha,
  GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '2',
  GITHUB_WORKFLOW_REF: `git-malu/AnyWear-Infra/.github/workflows/${runtimeOperations.includes(operation) ? 'runtime' : 'mutate'}.yml@refs/heads/main`,
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', INFRA_OPERATION: operation,
  INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true', TESTER_EMAILS: '[]',
  SERVICE_RELEASE_TAG: '', SERVICE_COMMIT: '',
  REQUIRE_DEPLOYMENT_RECORD: 'true', DEPLOY_JOB_RESULT: 'success', OBSERVE_JOB_RESULT: 'failure',
  ...overrides,
});

async function operationRecord(root, options, { completed = true, outcomes = ['success', 'success'] } = {}) {
  const record = createOperationRecord({ env: options });
  if (completed) {
    record.events.push({ type: 'stack-deploy', stack_name: 'AnyWearPlatformStack-beta', result: 'complete' });
  }
  finalizeOperationRecord(record, ...outcomes);
  await mkdir(path.join(root, 'deployment-evidence'), { recursive: true });
  await writeFile(path.join(root, 'deployment-evidence/operation-record.json'), canonicalJson(record));
  return record;
}

const evidence = (root, file) => path.join(root, 'deployment-evidence', file);
const readOperation = async root => parseJson(await readFile(evidence(root, 'operation-record.json')));

async function acceptedRecord(root, options, { file = 'accepted/deployment-record.json', workflow = 'mutate' } = {}) {
  const record = buildDeploymentRecord(options, body(), `.github/workflows/${workflow}.yml`);
  return writeRecord(root, file, record);
}

async function familyRecord(root, options) {
  const record = buildDeploymentRecord(options, body(), '.github/workflows/mutate.yml', familyObservationRecordType);
  return writeRecord(root, 'family/deployment-record.json', record);
}

async function writeRecord(root, file, record) {
  await mkdir(path.dirname(evidence(root, file)), { recursive: true });
  await writeFile(evidence(root, file), canonicalJson(record));
  return record;
}

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'infra-record-deployment-'));
// The report line is the CLI's stdout contract; the tests assert the files and
// verdicts instead of the human-readable summary.
const quiet = { stdout: { write() {} } };

test('a run with both records validates, checksums and stays complete', async () => {
  const root = await tmp();
  const options = env('deploy-platform');
  await operationRecord(root, options);
  const accepted = await acceptedRecord(root, options);
  const family = await familyRecord(root, options);
  const result = await recordDeployment(options, { root, ...quiet });
  assert.deepEqual(result.accepted, validateDeploymentRecord(accepted));
  assert.deepEqual(result.family, validateObservationRecord(family));
  assert.equal(result.operation.result, 'succeeded');
  assert.deepEqual(result.checksums.map(row => row.file), [
    'deployment-evidence/operation-record.json',
    'deployment-evidence/accepted/deployment-record.json',
    'deployment-evidence/family/deployment-record.json',
  ]);
  for (const file of ['operation-record.json', 'accepted/deployment-record.json', 'family/deployment-record.json']) {
    assert.ok((await readFile(`${evidence(root, file)}.sha256`, 'utf8')).endsWith(`  ${path.basename(file)}\n`), file);
  }
});

test('a missing accepted record after a completed mutation marks the deployment incomplete', async () => {
  const root = await tmp();
  const options = env('deploy-platform');
  await operationRecord(root, options);
  await familyRecord(root, options);
  await assert.rejects(recordDeployment(options, { root, ...quiet }), /accepted deployment record is missing/);
  const marked = await readOperation(root);
  assert.equal(marked.result, 'partial');
  assert.equal(marked.recovery, 'requires-explicit-recovery');
  assert.deepEqual(marked.events.at(-1), { type: 'accepted-deployment-record', result: 'missing',
    observation_job: 'failure', expected_workflow: '.github/workflows/mutate.yml' });
  // The mark survives the failure: the operation record and its checksum are the
  // evidence the `if: always()` upload preserves.
  assert.ok((await readFile(`${evidence(root, 'operation-record.json')}.sha256`, 'utf8')).endsWith('  operation-record.json\n'));
  assert.ok((await readFile(`${evidence(root, 'family/deployment-record.json')}.sha256`, 'utf8')).endsWith('  deployment-record.json\n'));
});

test('a missing accepted record before any mutation stays failed without recovery', async () => {
  const root = await tmp();
  const options = env('deploy-platform');
  const before = await operationRecord(root, options, { completed: false, outcomes: ['failure', 'skipped'] });
  assert.equal(before.result, 'failed');
  await assert.rejects(recordDeployment(options, { root, ...quiet }), /accepted deployment record is missing/);
  const marked = await readOperation(root);
  assert.equal(marked.result, 'failed');
  assert.equal(marked.recovery, 'not-required');
  assert.deepEqual(marked.events.at(-1), { type: 'accepted-deployment-record', result: 'missing',
    observation_job: 'failure', expected_workflow: '.github/workflows/mutate.yml' });
});

test('a record from another run or workflow is invalid evidence, not an incomplete deployment', async () => {
  const root = await tmp();
  const options = env('deploy-platform');
  const operation = await operationRecord(root, options);
  const foreign = buildDeploymentRecord({ ...options, GITHUB_RUN_ID: '78' }, body(), '.github/workflows/mutate.yml');
  await writeRecord(root, 'accepted/deployment-record.json', foreign);
  await assert.rejects(recordDeployment(options, { root, ...quiet }), /another executor source, workflow or run/);
  const unmarked = await readOperation(root);
  assert.equal(unmarked.result, operation.result);
  assert.equal(unmarked.events.some(event => event.type === 'accepted-deployment-record'), false);
});

test('an operation outside the trigger set requires its family observation only', async () => {
  for (const operation of ['deploy-egress', 'delete-egress', 'migrate', 'admission-status']) {
    const root = await tmp();
    const options = env(operation);
    await operationRecord(root, options);
    await familyRecord(root, options);
    const result = await recordDeployment(options, { root, ...quiet });
    assert.equal(result.accepted, undefined, operation);
    assert.deepEqual(result.checksums.map(row => row.file), [
      'deployment-evidence/operation-record.json', 'deployment-evidence/family/deployment-record.json'], operation);
    // No accepted record is invented for the stop/start drill or a data operation.
    await assert.rejects(readFile(evidence(root, 'accepted/deployment-record.json')), /ENOENT/);
  }
});

test('the read-only state run requires no record at all', async () => {
  const root = await tmp();
  const options = { ...env('state'), REQUIRE_DEPLOYMENT_RECORD: 'false', OBSERVE_JOB_RESULT: 'skipped' };
  await operationRecord(root, options, { completed: false, outcomes: ['success', 'skipped'] });
  const result = await recordDeployment(options, { root, ...quiet });
  assert.equal(result.accepted, undefined);
  assert.deepEqual(result.checksums.map(row => row.file), ['deployment-evidence/operation-record.json']);
});

test('runtime.yml keeps its single-artifact layout and the manual observe producer', async () => {
  const root = await tmp();
  const options = env('observe');
  await operationRecord(root, options);
  const accepted = await acceptedRecord(root, options, { file: 'deployment-record.json', workflow: 'runtime' });
  const result = await recordDeployment(options, { root, ...quiet });
  assert.deepEqual(result.accepted, validateDeploymentRecord(accepted));
  assert.equal(result.accepted.producer.workflow_path, '.github/workflows/runtime.yml');
  assert.deepEqual(result.checksums.map(row => row.file), [
    'deployment-evidence/operation-record.json', 'deployment-evidence/deployment-record.json']);
});

test('a required family observation that never arrived fails the record job', async () => {
  const root = await tmp();
  const options = env('deploy-egress');
  await operationRecord(root, options);
  await assert.rejects(recordDeployment(options, { root, ...quiet }), /requires its family observation record/);
});
