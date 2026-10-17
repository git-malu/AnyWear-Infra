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
test('strict final observation failure preserves earlier phase evidence and requires explicit recovery', () => {
  const record = fixture('restore-release'); const events = structuredClone(record.events);
  assert.equal(finalizeOperationRecord(record, 'success', 'failure').result, 'failed');
  assert.equal(record.recovery, 'requires-explicit-recovery');
  assert.equal(record.final_observation, 'failure'); assert.deepEqual(record.events, events);
  finalizeOperationRecord(record, 'success', 'failure');
  assert.equal(record.recovery, 'requires-explicit-recovery');
});
test('successful observation and close failure keep accurate outcomes; every non-state operation requires observation', () => {
  assert.equal(finalizeOperationRecord(fixture('restore-release'), 'success', 'success').result, 'succeeded');
  const closed = finalizeOperationRecord(fixture('suspend-admission'), 'failure', 'skipped');
  assert.equal(closed.result, 'failed'); assert.equal(closed.recovery, 'not-required');
  // Beta is resident, so no protected operation can end stopped and skip the
  // final observation; only the read-only state operation is exempt.
  for (const operation of ['deploy-platform', 'deploy-workload', 'observe', 'set-testers', 'restore-release', 'suspend-admission']) {
    assert.equal(finalizeOperationRecord(fixture(operation), 'success', 'skipped').result, 'failed', operation);
  }
  assert.equal(finalizeOperationRecord(fixture('state'), 'success', 'skipped').result, 'succeeded');
  assert.throws(() => finalizeOperationRecord(fixture('restore-release'), 'unknown', 'success'));
});

test('final observation is required regardless of the observed final activity', () => {
  for (const operation of ['deploy-platform', 'deploy-workload', 'observe', 'set-testers']) {
    for (const active of ['true', 'false']) {
      const record = fixture(operation);
      record.events.push({ type: 'final-beta-activity', platform_active: active, workload_active: active });
      assert.equal(finalizeOperationRecord(record, 'success', 'skipped').result, 'failed', `${operation} ${active}`);
    }
  }
});

test('finalizer CLI rewrites strictly parsed state and ordinary records with accurate success, failure and recovery evidence', async () => {
  const execute = promisify(execFile);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'infra-finalize-file-'));
  await mkdir(path.join(directory, 'deployment-evidence'));
  const file = path.join(directory, 'deployment-evidence/operation-record.json');
  const script = fileURLToPath(new URL('./finalize-operation.mjs', import.meta.url));
  const cases = [
    ['state', 'success', 'skipped', 'succeeded', 'not-required', false],
    ['state', 'failure', 'skipped', 'failed', 'not-required', false],
    ['observe', 'success', 'success', 'succeeded', 'not-required', true],
    ['observe', 'success', 'failure', 'failed', 'not-required', true],
    ['observe', 'success', 'skipped', 'failed', 'not-required', true],
    ['deploy-platform', 'success', 'success', 'succeeded', 'not-required', true],
    ['deploy-platform', 'failure', 'success', 'failed', 'not-required', true],
    ['deploy-platform', 'success', 'skipped', 'failed', 'not-required', false],
    ['restore-release', 'success', 'failure', 'failed', 'requires-explicit-recovery', true],
    ['restore-release', 'cancelled', 'skipped', 'failed', 'requires-explicit-recovery', true],
    ['suspend-admission', 'failure', 'skipped', 'failed', 'not-required', true],
  ];
  for (const [operation, operationOutcome, observationOutcome, result, recovery, active] of cases) {
    const record = fixture(operation);
    record.final_observation = operation === 'state' ? 'not-applicable' : 'pending';
    record.events.push({ type: 'final-beta-activity', platform_active: String(active), workload_active: String(active) });
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
