import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeOperationRecord } from './finalize-operation.mjs';
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

test('final observation is required regardless of the observed final stack state', () => {
  for (const operation of ['deploy-platform', 'deploy-egress', 'observe', 'set-testers']) {
    for (const active of ['true', 'false']) {
      const record = fixture(operation);
      record.events.push({ type: 'final-stack-state', base_status: 'UPDATE_COMPLETE', runtime_status: active === 'true' ? 'UPDATE_COMPLETE' : 'ABSENT', runtime_exists: active === 'true' });
      assert.equal(finalizeOperationRecord(record, 'success', 'skipped').result, 'partial', `${operation} ${active}`);
    }
  }
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
    ['deploy-platform', 'failure', 'success', 'failed', 'not-required', true],
    ['deploy-platform', 'success', 'skipped', 'partial', 'not-required', false],
    ['deploy-platform', 'cancelled', 'success', 'failed', 'not-required', false],
    ['restore-release', 'success', 'failure', 'partial', 'requires-explicit-recovery', true],
    ['restore-release', 'success', 'skipped', 'partial', 'requires-explicit-recovery', true],
    ['restore-release', 'cancelled', 'skipped', 'failed', 'requires-explicit-recovery', true],
    ['close-admission', 'failure', 'skipped', 'failed', 'not-required', true],
  ];
  for (const [operation, operationOutcome, observationOutcome, result, recovery, active] of cases) {
    const record = fixture(operation);
    record.final_observation = operation === 'state' ? 'not-applicable' : 'pending';
    record.events.push({ type: 'final-stack-state', base_status: 'UPDATE_COMPLETE', runtime_status: active ? 'UPDATE_COMPLETE' : 'ABSENT', runtime_exists: active });
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
