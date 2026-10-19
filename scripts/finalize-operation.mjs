import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { canonicalJson, parseJson } from './json-contract.mjs';
import { recordRecovery, readOperationRecord } from './operation-record.mjs';

// Final observation remains strict and separate: its failure still fails the job.
// The durable record distinguishes the two failure situations so a reader never
// has to treat "the mutation did not happen" and "the mutation happened but its
// end state is unverified" as the same outcome.
export function finalizeOperationRecord(record, operationOutcome, observationOutcome) {
  const outcomes = ['success', 'failure', 'cancelled', 'skipped'];
  if (!outcomes.includes(operationOutcome) || !outcomes.includes(observationOutcome)) throw new Error('Invalid final operation outcome');
  readOperationRecord(record);
  record.final_observation = record.operation === 'state' ? 'not-applicable' : observationOutcome;
  // Every non-state operation ends on an observed final stack state (terminal
  // Base plus the observed Runtime existence/status) that must be accepted; the
  // read-only state operation is the only exemption.
  const requiresObservation = record.operation !== 'state';
  if (operationOutcome !== 'success') {
    record.result = 'failed';
  } else if (requiresObservation && observationOutcome !== 'success') {
    // The mutation completed, but the required final observation did not confirm
    // the end state; the job still fails on that observation step.
    record.result = 'partial';
  } else {
    record.result = 'succeeded';
  }
  if (record.result !== 'succeeded' && record.operation === 'restore-release' && record.recovery === 'not-required') recordRecovery(record, 'requires-explicit-recovery');
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = 'deployment-evidence/operation-record.json';
  let bytes;
  try { bytes = await readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bytes) await writeFile(file, canonicalJson(finalizeOperationRecord(structuredClone(parseJson(bytes)), process.env.OPERATION_OUTCOME, process.env.OBSERVATION_OUTCOME)));
}
