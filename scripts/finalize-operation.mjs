import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { canonicalJson, parseJson } from './json-contract.mjs';
import { recordRecovery, readOperationRecord } from './operation-record.mjs';

// Final observation remains strict and separate. Its failure must not leave a
// succeeded operation artifact after a partially completed release recovery.
export function finalizeOperationRecord(record, operationOutcome, observationOutcome) {
  const outcomes = ['success', 'failure', 'cancelled', 'skipped'];
  if (!outcomes.includes(operationOutcome) || !outcomes.includes(observationOutcome)) throw new Error('Invalid final operation outcome');
  readOperationRecord(record);
  record.final_observation = record.operation === 'state' ? 'not-applicable' : observationOutcome;
  const finalActivity = record.events?.findLast(event => event.type === 'final-beta-activity');
  const requiresObservation = record.operation !== 'state' && (finalActivity?.platform_active === 'true' || finalActivity?.workload_active === 'true'
    || ['restore-release', 'close-admission', 'open-admission'].includes(record.operation));
  if (operationOutcome !== 'success' || ['failure', 'cancelled'].includes(observationOutcome)
    || (requiresObservation && observationOutcome !== 'success')) {
    record.result = 'failed';
    if (record.operation === 'restore-release' && record.recovery === 'not-required') recordRecovery(record, 'requires-explicit-recovery');
  }
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = 'deployment-evidence/operation-record.json';
  let bytes;
  try { bytes = await readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bytes) await writeFile(file, canonicalJson(finalizeOperationRecord(structuredClone(parseJson(bytes)), process.env.OPERATION_OUTCOME, process.env.OBSERVATION_OUTCOME)));
}
