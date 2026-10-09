import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeOperationRecord } from './finalize-operation.mjs';

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
test('successful observation, close failure, and stopped operations keep accurate outcomes', () => {
  assert.equal(finalizeOperationRecord(fixture('restore-release'), 'success', 'success').result, 'succeeded');
  const closed = finalizeOperationRecord(fixture('close-admission'), 'failure', 'skipped');
  assert.equal(closed.result, 'failed'); assert.equal(closed.recovery, 'not-required');
  assert.equal(finalizeOperationRecord(fixture('stop'), 'success', 'skipped').result, 'succeeded');
  assert.equal(finalizeOperationRecord(fixture('restore-release'), 'success', 'skipped').result, 'failed');
  assert.equal(finalizeOperationRecord(fixture('close-admission'), 'success', 'skipped').result, 'failed');
  assert.throws(() => finalizeOperationRecord(fixture('restore-release'), 'unknown', 'success'));
});
