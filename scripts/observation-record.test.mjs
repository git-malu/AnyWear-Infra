import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { changedStackNames, configuredStackNames, mutatingOperations, operationOwnedStacks } from './operation-stacks.mjs';
import {
  acceptedObservationOperations, acceptedObservationRequired, buildDeploymentRecord,
  deploymentRecordType, familyObservationRecordType, observationRecordType, preM4Operations, unpublishedStageInputs,
  deploymentWorkflowFamily,
} from './observation-record.mjs';
import { publishObservationRequirement, requiresAcceptedObservation } from './observation-requirement.mjs';

// Issue #181: an operation requires the accepted `anywear_infra_deployment` v3
// record exactly when it changes a stack that record lists. The trigger set is
// derived from the two frozen stack tables, so this file pins the derivation
// rather than a hand-maintained list of operation names.
const excluded = Object.freeze(['deploy-egress', 'delete-egress', 'deploy-runtime', 'stop-runtime', 'migrate',
  'admission-status', 'add-testers', 'set-testers', 'open-admission', 'close-admission', 'state']);

test('the trigger set is exactly the configured-stack mutations plus the manual observe producer', () => {
  assert.deepEqual([...acceptedObservationOperations].sort(),
    ['deploy-billing', 'deploy-foundation', 'deploy-platform', 'observe', 'restore-release']);
  assert.deepEqual([...acceptedObservationOperations],
    [...acceptedObservationOperations].filter(operation => acceptedObservationRequired(operation)));
  for (const operation of acceptedObservationOperations) assert.equal(acceptedObservationRequired(operation), true, operation);
  for (const operation of excluded) assert.equal(acceptedObservationRequired(operation), false, operation);
});

test('the requirement is the stack-set derivation, not a name list', () => {
  // For every mutating operation the predicate must equal "changes a configured
  // stack". A future operation that mutates Foundation, Base or Billing is then in
  // the set without editing it here; one that mutates only an operation-owned stack
  // stays out.
  const configured = configuredStackNames();
  assert.deepEqual([...mutatingOperations].sort(),
    ['delete-egress', 'deploy-billing', 'deploy-egress', 'deploy-foundation', 'deploy-platform',
      'deploy-runtime', 'restore-release', 'stop-runtime']);
  for (const operation of mutatingOperations) {
    const derived = changedStackNames(operation).some(name => configured.includes(name));
    assert.equal(acceptedObservationRequired(operation), derived, operation);
  }
  // #166's stop/start is excluded because Egress is operation-owned, not because
  // its name is missing: both Egress operations do change a stack. Since #195 the
  // same holds for the Runtime operations.
  for (const operation of ['deploy-egress', 'delete-egress']) {
    assert.deepEqual(changedStackNames(operation), ['AnyWearEgressStack-beta']);
    assert.ok(operationOwnedStacks.some(stack => stack.stack_name === 'AnyWearEgressStack-beta'));
    assert.equal(configured.includes('AnyWearEgressStack-beta'), false);
  }
  for (const operation of ['deploy-runtime', 'stop-runtime']) {
    assert.deepEqual(changedStackNames(operation), ['AnyWearRuntimeStack-beta']);
    assert.ok(operationOwnedStacks.some(stack => stack.stack_name === 'AnyWearRuntimeStack-beta'));
    assert.equal(configured.includes('AnyWearRuntimeStack-beta'), false);
  }
  // `observe` changes nothing and is still required: it is the manual producer.
  assert.deepEqual(changedStackNames('observe'), []);
  assert.equal(acceptedObservationRequired('observe'), true);
  // The read-only and data-only operations change nothing at all.
  for (const operation of ['state', 'migrate', 'admission-status', 'add-testers', 'set-testers', 'open-admission', 'close-admission']) {
    assert.deepEqual(changedStackNames(operation), [], operation);
  }
});

test('only the pre-M4 deploys may record the published stage-contract subset', () => {
  assert.deepEqual([...preM4Operations], ['deploy-foundation', 'deploy-billing']);
  for (const operation of preM4Operations) assert.deepEqual(unpublishedStageInputs(operation), ['api_base_url'], operation);
  for (const operation of ['deploy-platform', 'restore-release', 'observe', 'deploy-egress']) {
    assert.deepEqual(unpublishedStageInputs(operation), [], operation);
  }
});

test('the credential-free preflight output is the same trigger-set predicate', async () => {
  for (const operation of acceptedObservationOperations) {
    assert.equal(requiresAcceptedObservation({ INFRA_OPERATION: operation }), true, operation);
  }
  for (const operation of excluded) {
    assert.equal(requiresAcceptedObservation({ INFRA_OPERATION: operation }), false, operation);
  }
  // The `observe` job gate reads this exact output name.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'infra-observation-requirement-'));
  try {
    const GITHUB_OUTPUT = path.join(directory, 'output');
    assert.equal(await publishObservationRequirement({ INFRA_OPERATION: 'deploy-platform', GITHUB_OUTPUT }),
      'requires_accepted_observation=true');
    assert.equal(await publishObservationRequirement({ INFRA_OPERATION: 'deploy-egress', GITHUB_OUTPUT }),
      'requires_accepted_observation=false');
    assert.equal(await readFile(GITHUB_OUTPUT, 'utf8'),
      'requires_accepted_observation=true\nrequires_accepted_observation=false\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('one builder produces the accepted record and the family observation envelope', () => {
  const env = { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
    GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '2' };
  const body = { stacks: [], inputs: [], observed: {}, schema: {} };
  const accepted = buildDeploymentRecord(env, body, '.github/workflows/mutate.yml');
  assert.deepEqual(Object.keys(accepted), ['schema_version', 'record_type', 'producer', 'stacks', 'inputs', 'observed', 'schema']);
  assert.equal(accepted.schema_version, 3);
  assert.equal(accepted.record_type, deploymentRecordType);
  assert.deepEqual(accepted.producer, { repository: 'git-malu/AnyWear-Infra', sha: env.GITHUB_SHA,
    workflow_path: '.github/workflows/mutate.yml', workflow_ref: env.GITHUB_WORKFLOW_REF, run_id: 77, run_attempt: 2 });
  const family = buildDeploymentRecord(env, body, '.github/workflows/mutate.yml', familyObservationRecordType);
  assert.equal(family.record_type, familyObservationRecordType);
  assert.deepEqual(family.producer, accepted.producer);
  assert.throws(() => buildDeploymentRecord(env, body, 'mutate.yml'), /workflow path required/);
  // The family identity is unchanged: manual `observe` keeps the accepted type.
  assert.equal(deploymentWorkflowFamily, 'runtime');
  assert.equal(observationRecordType('runtime'), deploymentRecordType);
  assert.equal(observationRecordType('beta-deploy'), familyObservationRecordType);
});
