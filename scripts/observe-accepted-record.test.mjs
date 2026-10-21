import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from './json-contract.mjs';
import { configuredStacks } from './operation-stacks.mjs';
import { stageContractSchemaHash, validateDeploymentRecord } from './deployment-contract.mjs';
import {
  acceptedObservationOperations, acceptedObservationRequired, preM4Operations,
} from './observation-record.mjs';
import { assertAcceptedObservationOperation, observeAcceptedRecord } from './observe-accepted-record.mjs';

// Issue #181: the deployment chain's accepted-record producer. These tests run the
// producer with an injected observation, so the record envelope, the refusal set,
// the Runtime-absence rule and the pre-M4 allowance are pinned without AWS.
const infraSha = 'a'.repeat(40);
const endpoint = 'https://d111111abcdef8.cloudfront.net';
const inputs = () => [{ parameter: '/anywear/beta/vpc_id', version: '4', value_sha256: 'd'.repeat(64) },
  { parameter: '/anywear/beta/vpc_secondary_id', version: '7', value_sha256: 'e'.repeat(64) }];
// A complete authenticated observation body. `inputs` deliberately omits
// `api_base_url`, which is exactly the reviewed pre-M4 published subset.
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
const releaseOperations = ['deploy-platform', 'restore-release'];
const env = (operation = 'deploy-platform', overrides = {}) => ({
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: infraSha, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '2',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
  INFRA_OPERATION: operation, INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true', TESTER_EMAILS: '[]',
  SERVICE_RELEASE_TAG: releaseOperations.includes(operation) ? 'beta-2026-10-18' : '',
  SERVICE_COMMIT: releaseOperations.includes(operation) ? 'b'.repeat(40) : '',
  ...overrides,
});

function spy(value = body()) {
  const calls = [];
  return { calls, observe: async options => { calls.push(options); return value; } };
}

test('the producer refuses every operation outside the derived trigger set', () => {
  assert.deepEqual(acceptedObservationOperations.filter(operation => operation !== 'observe'),
    ['deploy-foundation', 'deploy-billing', 'deploy-platform', 'restore-release']);
  for (const operation of ['deploy-foundation', 'deploy-billing', 'deploy-platform', 'restore-release', 'observe']) {
    assert.equal(assertAcceptedObservationOperation(operation), operation);
  }
  for (const operation of ['state', 'migrate', 'deploy-egress', 'delete-egress', 'admission-status', 'add-testers',
    'set-testers', 'open-admission', 'close-admission']) {
    assert.equal(acceptedObservationRequired(operation), false, operation);
    assert.throws(() => assertAcceptedObservationOperation(operation), /does not produce an accepted deployment record/, operation);
  }
});

test('the producer writes the accepted mutate.yml record with this run\'s identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'infra-observe-accepted-'));
  try {
    const { calls, observe } = spy();
    const record = await observeAcceptedRecord(env('deploy-platform'), { observe, root });
    assert.equal(calls.length, 1);
    assert.deepEqual(record, validateDeploymentRecord(record));
    assert.equal(record.schema_version, 3);
    assert.equal(record.record_type, 'anywear_infra_deployment');
    assert.deepEqual(record.producer, { repository: 'git-malu/AnyWear-Infra', sha: infraSha,
      workflow_path: '.github/workflows/mutate.yml',
      workflow_ref: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main', run_id: 77, run_attempt: 2 });
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'deployment-evidence/deployment-record.json'), 'utf8')), record);
    assert.equal(await readFile(path.join(root, 'deployment-evidence/deployment-record.json'), 'utf8'), canonicalJson(record));
    // The record body is exactly what the observer read: three configured stacks
    // and the published stage-contract subset.
    assert.deepEqual(record.stacks.map(row => row.name), configuredStacks.map(stack => stack.stack_name));
    assert.equal(record.inputs.some(row => row.parameter === '/anywear/beta/api_base_url'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the producer never reads or requires the Service-owned Runtime stack', async () => {
  for (const operation of ['deploy-foundation', 'deploy-billing', 'deploy-platform', 'restore-release']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'infra-observe-accepted-'));
    try {
      const { calls, observe } = spy();
      const options = env(operation);
      await observeAcceptedRecord(options, { observe, root });
      assert.equal(calls.length, 1);
      // Runtime readiness stays the manual observe's qualification: a Foundation
      // or Billing deploy while Beta is stopped is a complete deployment.
      assert.equal(calls[0].requireRuntime, false, operation);
      assert.equal(calls[0].infraSha, infraSha, operation);
      assert.equal(calls[0].env, options, operation);
      assert.equal(typeof calls[0].io.aws, 'function', operation);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('only the pre-M4 deploys carry the api_base_url allowance', async () => {
  for (const operation of ['deploy-foundation', 'deploy-billing']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'infra-observe-accepted-'));
    try {
      const { calls, observe } = spy();
      const record = await observeAcceptedRecord(env(operation), { observe, root });
      assert.deepEqual(calls[0].allowUnpublishedStageInputs, ['api_base_url'], operation);
      // A record whose inputs are the published subset still validates.
      assert.equal(record.schema.content_sha256, stageContractSchemaHash(record.inputs));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  for (const operation of ['deploy-platform', 'restore-release']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'infra-observe-accepted-'));
    try {
      const { calls, observe } = spy();
      await observeAcceptedRecord(env(operation), { observe, root });
      assert.deepEqual(calls[0].allowUnpublishedStageInputs, [], operation);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('the producer refuses an excluded operation before it observes anything', async () => {
  for (const operation of ['deploy-egress', 'delete-egress', 'migrate', 'admission-status']) {
    const { calls, observe } = spy();
    await assert.rejects(observeAcceptedRecord(env(operation), { observe, root: os.tmpdir() }),
      /does not produce an accepted deployment record/, operation);
    assert.deepEqual(calls, [], operation);
  }
});
