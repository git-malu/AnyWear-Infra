import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeOperationRecord, markDeploymentIncomplete } from './finalize-operation.mjs';
import { canonicalJson, parseJson } from './json-contract.mjs';

const fixture = operation => ({ record_type: 'anywear_infra_operation', schema_version: 2, operation,
  result: 'succeeded', recovery: 'not-required', events: [{ type: 'restore-stage', stage: 'final-readback', result: 'succeeded' }] });
test('required final observation failure records partial and requires explicit recovery', () => {
  const record = fixture('restore-release'); const events = structuredClone(record.events);
  assert.equal(finalizeOperationRecord(record, 'success', 'failure').result, 'partial');
  assert.equal(record.recovery, 'requires-explicit-recovery');
  assert.equal(record.final_observation, 'failure'); assert.deepEqual(record.events, events);
  finalizeOperationRecord(record, 'success', 'failure');
  assert.equal(record.recovery, 'requires-explicit-recovery');
  assert.equal(record.result, 'partial');
});
test('successful observation, close failure and operation failure keep accurate outcomes; every non-state operation requires observation', () => {
  assert.equal(finalizeOperationRecord(fixture('restore-release'), 'success', 'success').result, 'succeeded');
  const closed = finalizeOperationRecord(fixture('close-admission'), 'failure', 'skipped');
  assert.equal(closed.result, 'failed'); assert.equal(closed.recovery, 'not-required');
  // A completed mutation cannot skip the final observation; only the read-only
  // state operation is exempt.
  for (const operation of ['deploy-platform', 'deploy-egress', 'observe', 'set-testers', 'restore-release', 'close-admission']) {
    assert.equal(finalizeOperationRecord(fixture(operation), 'success', 'skipped').result, 'partial', operation);
  }
  assert.equal(finalizeOperationRecord(fixture('state'), 'success', 'skipped').result, 'succeeded');
  assert.equal(finalizeOperationRecord(fixture('state'), 'failure', 'skipped').result, 'failed');
  assert.throws(() => finalizeOperationRecord(fixture('restore-release'), 'unknown', 'success'));
});

test('a completed mutation with any unsuccessful required observation records partial', () => {
  for (const operation of ['deploy-platform', 'deploy-egress', 'observe', 'set-testers', 'restore-release', 'close-admission']) {
    for (const observation of ['failure', 'cancelled']) {
      const record = finalizeOperationRecord(fixture(operation), 'success', observation);
      assert.equal(record.result, 'partial', `${operation} ${observation}`);
      assert.equal(record.final_observation, observation);
      assert.equal(record.recovery, operation === 'restore-release' ? 'requires-explicit-recovery' : 'not-required', operation);
    }
  }
});

test('a failed run after a completed stack mutation records partial and requires explicit recovery', () => {
  for (const type of ['stack-deploy', 'stack-destroy']) {
    const record = fixture('deploy-platform');
    record.events.push({ type, stack_name: 'AnyWearPlatformStack-beta', result: 'complete' });
    const finalized = finalizeOperationRecord(record, 'failure', 'skipped');
    assert.equal(finalized.result, 'partial', type);
    assert.equal(finalized.recovery, 'requires-explicit-recovery', type);
    assert.equal(finalized.final_observation, 'skipped');
  }
  // A failure before any completed mutation stays failed without recovery.
  const plain = finalizeOperationRecord(fixture('deploy-platform'), 'failure', 'skipped');
  assert.equal(plain.result, 'failed');
  assert.equal(plain.recovery, 'not-required');
  // A started-but-not-complete stack event is not a completed mutation.
  const incomplete = fixture('deploy-platform');
  incomplete.events.push({ type: 'stack-deploy', stack_name: 'AnyWearPlatformStack-beta', result: 'began' });
  assert.equal(finalizeOperationRecord(incomplete, 'failure', 'skipped').result, 'failed');
  // Already-recorded recovery evidence is never downgraded.
  const observed = fixture('deploy-platform');
  observed.recovery = 'began';
  observed.events.push({ type: 'stack-deploy', stack_name: 'AnyWearPlatformStack-beta', result: 'complete' });
  assert.equal(finalizeOperationRecord(observed, 'failure', 'skipped').result, 'partial');
  assert.equal(observed.recovery, 'began');
});

test('final observation is required regardless of the observed final stack state', () => {
  for (const operation of ['deploy-platform', 'deploy-egress', 'observe', 'set-testers']) {
    for (const active of ['true', 'false']) {
      const record = fixture(operation);
      record.events.push({ type: 'final-stack-state', base_status: 'UPDATE_COMPLETE', runtime_status: active === 'true' ? 'UPDATE_COMPLETE' : 'ABSENT', runtime_exists: active === 'true' });
      assert.equal(finalizeOperationRecord(record, 'success', 'skipped').result, 'partial', `${operation} ${active}`);
    }
  }
});

test('a missing accepted record marks a completed mutation partial and keeps a pre-mutation failure failed', () => {
  const completed = fixture('deploy-platform');
  completed.result = 'succeeded';
  completed.events.push({ type: 'stack-deploy', stack_name: 'AnyWearPlatformStack-beta', result: 'complete' });
  const marked = markDeploymentIncomplete(completed, { observationJob: 'failure', expectedWorkflow: '.github/workflows/mutate.yml' });
  assert.equal(marked, completed);
  assert.equal(marked.result, 'partial');
  assert.equal(marked.recovery, 'requires-explicit-recovery');
  assert.deepEqual(marked.events.at(-1), { type: 'accepted-deployment-record', result: 'missing',
    observation_job: 'failure', expected_workflow: '.github/workflows/mutate.yml' });

  // Nothing was mutated: the record stays failed and claims no recovery.
  const untouched = fixture('deploy-platform');
  untouched.result = 'failed';
  markDeploymentIncomplete(untouched, { observationJob: 'skipped', expectedWorkflow: '.github/workflows/mutate.yml' });
  assert.equal(untouched.result, 'failed');
  assert.equal(untouched.recovery, 'not-required');
  assert.equal(untouched.events.at(-1).type, 'accepted-deployment-record');

  // A began-but-not-complete stack event is not a completed mutation.
  const begun = fixture('deploy-platform');
  begun.result = 'failed';
  begun.events.push({ type: 'stack-deploy', stack_name: 'AnyWearPlatformStack-beta', result: 'began' });
  markDeploymentIncomplete(begun, { observationJob: 'skipped', expectedWorkflow: '.github/workflows/mutate.yml' });
  assert.equal(begun.result, 'failed');
  assert.equal(begun.recovery, 'not-required');

  // A recovery decision already recorded is never downgraded or re-transitioned.
  const restoring = fixture('restore-release');
  restoring.result = 'partial';
  restoring.recovery = 'requires-explicit-recovery';
  restoring.events.push({ type: 'stack-deploy', stack_name: 'AnyWearPlatformStack-beta', result: 'complete' });
  markDeploymentIncomplete(restoring, { observationJob: 'unavailable', expectedWorkflow: '.github/workflows/mutate.yml' });
  assert.equal(restoring.recovery, 'requires-explicit-recovery');

  for (const observationJob of ['unknown', undefined]) {
    assert.throws(() => markDeploymentIncomplete(fixture('deploy-platform'),
      { observationJob, expectedWorkflow: '.github/workflows/mutate.yml' }), /Invalid observation job outcome/);
  }
  for (const expectedWorkflow of ['mutate.yml', undefined, '.github/workflows/mutate.json']) {
    assert.throws(() => markDeploymentIncomplete(fixture('deploy-platform'),
      { observationJob: 'failure', expectedWorkflow }), /Expected deployment workflow required/);
  }
});

test('deploy-runtime is exempt from the separate observation and an executed change set is a completed mutation', () => {
  // The `deploy` job writes the accepted v5 record itself, so the skipped
  // observation job is expected and must not mark a successful deployment partial.
  const succeeded = finalizeOperationRecord(fixture('deploy-runtime'), 'success', 'skipped');
  assert.equal(succeeded.result, 'succeeded');
  assert.equal(succeeded.final_observation, 'skipped');
  assert.equal(succeeded.recovery, 'not-required');

  // A converged no-op executes nothing, so a later failure stays failed.
  const converged = fixture('deploy-runtime');
  converged.events.push({ type: 'runtime-change-set-converged', executed: false });
  const noMutation = finalizeOperationRecord(converged, 'failure', 'skipped');
  assert.equal(noMutation.result, 'failed');
  assert.equal(noMutation.recovery, 'not-required');
  const begun = fixture('deploy-runtime');
  begun.events.push({ type: 'runtime-change-set-executed', executed: false });
  assert.equal(finalizeOperationRecord(begun, 'failure', 'skipped').result, 'failed');

  // An executed Runtime change set is a real mutation: a later bake or /health
  // failure is partial evidence with an explicit recovery decision, and the record
  // job applies the same rule when the v5 record never arrives.
  const mutated = fixture('deploy-runtime');
  mutated.events.push({ type: 'runtime-change-set-executed', executed: true, mode: 'update' });
  const failed = finalizeOperationRecord(mutated, 'failure', 'skipped');
  assert.equal(failed.result, 'partial');
  assert.equal(failed.recovery, 'requires-explicit-recovery');
  const missing = structuredClone(mutated);
  markDeploymentIncomplete(missing, { observationJob: 'unavailable', expectedWorkflow: '.github/workflows/mutate.yml' });
  assert.equal(missing.result, 'partial');
  assert.equal(missing.recovery, 'requires-explicit-recovery');
});

test('finalizer CLI rewrites strictly parsed state and ordinary records with the three-value result and recovery evidence', async () => {
  const execute = promisify(execFile);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'infra-finalize-file-'));
  await mkdir(path.join(directory, 'deployment-evidence'));
  const file = path.join(directory, 'deployment-evidence/operation-record.json');
  const script = fileURLToPath(new URL('./finalize-operation.mjs', import.meta.url));
  const cases = [
    ['state', 'success', 'skipped', 'succeeded', 'not-required', false],
    ['state', 'failure', 'skipped', 'failed', 'not-required', false],
    ['observe', 'success', 'success', 'succeeded', 'not-required', true],
    ['observe', 'success', 'failure', 'partial', 'not-required', true],
    ['observe', 'success', 'skipped', 'partial', 'not-required', true],
    ['deploy-platform', 'success', 'success', 'succeeded', 'not-required', true],
    // `deploy-runtime` writes its accepted v5 record in the deploy job itself, so
    // the skipped observation is expected and the operation record is `succeeded`.
    ['deploy-runtime', 'success', 'skipped', 'succeeded', 'not-required', true],
    ['deploy-platform', 'failure', 'success', 'failed', 'not-required', true],
    ['deploy-platform', 'success', 'skipped', 'partial', 'not-required', false],
    ['deploy-platform', 'cancelled', 'success', 'failed', 'not-required', false],
    ['restore-release', 'success', 'failure', 'partial', 'requires-explicit-recovery', true],
    ['restore-release', 'success', 'skipped', 'partial', 'requires-explicit-recovery', true],
    ['restore-release', 'cancelled', 'skipped', 'failed', 'requires-explicit-recovery', true],
    ['close-admission', 'failure', 'skipped', 'failed', 'not-required', true],
    // A completed stack mutation followed by a failed post-deploy read is
    // partial evidence that requires an explicit recovery decision.
    ['deploy-platform', 'failure', 'success', 'partial', 'requires-explicit-recovery', true, true],
  ];
  for (const [operation, operationOutcome, observationOutcome, result, recovery, active, completed = false] of cases) {
    const record = fixture(operation);
    record.final_observation = operation === 'state' ? 'not-applicable' : 'pending';
    record.events.push({ type: 'final-stack-state', base_status: 'UPDATE_COMPLETE', runtime_status: active ? 'UPDATE_COMPLETE' : 'ABSENT', runtime_exists: active });
    if (completed) record.events.push({ type: 'stack-deploy', stack_name: 'AnyWearFoundationStack', result: 'complete' });
    if (operation === 'state') record.state_observation = { qualification: 'not-applicable', admission: { tester_count: 2 } };
    await writeFile(file, canonicalJson(record));
    const parsed = parseJson(await readFile(file));
    assert.equal(Object.getOwnPropertyDescriptor(parsed, 'final_observation').writable, false);
    const run = () => execute(process.execPath, [script], { cwd: directory, timeout: 10_000,
      env: { ...process.env, OPERATION_OUTCOME: operationOutcome, OBSERVATION_OUTCOME: observationOutcome } });
    await run();
    const finalized = parseJson(await readFile(file));
    assert.equal(finalized.final_observation, operation === 'state' ? 'not-applicable' : observationOutcome);
    assert.equal(finalized.result, result); assert.equal(finalized.recovery, recovery);
    assert.deepEqual(finalized.events, record.events);
    if (operation === 'state') assert.deepEqual(finalized.state_observation, record.state_observation);
    const first = await readFile(file, 'utf8');
    await run();
    assert.equal(await readFile(file, 'utf8'), first);
  }
  const duplicate = '{"record_type":"anywear_infra_operation","schema_version":2,"operation":"state","result":"succeeded","result":"failed"}';
  await writeFile(file, duplicate);
  await assert.rejects(execute(process.execPath, [script], { cwd: directory,
    env: { ...process.env, OPERATION_OUTCOME: 'success', OBSERVATION_OUTCOME: 'skipped' } }), /Duplicate JSON key/);
  assert.equal(await readFile(file, 'utf8'), duplicate);
});
