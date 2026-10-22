import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { canonicalJson, parseJson } from './json-contract.mjs';
import { recordRecovery, readOperationRecord } from './operation-record.mjs';

// A mutation event is written only after the CDK call returned successfully. If
// the run then fails on a post-deploy read, the mutation is real but its end state
// is unverified: that is `partial` with explicit recovery, not `failed` as if
// nothing changed. An operation that fails before any completed stack mutation
// stays `failed`/`not-required`.
//
// `deploy-runtime` records its mutation as `runtime-change-set-executed` with
// `executed: true` once the executed change set reached a terminal stack status,
// because it drives the change set through the CLI rather than `io.deploy`. A
// converged no-op records `executed: false` and is not a mutation.
export function hasCompletedMutation(record) {
  return Array.isArray(record?.events) && record.events.some((event) => (
    (['stack-deploy', 'stack-destroy'].includes(event?.type) && event?.result === 'complete')
    || (event?.type === 'runtime-change-set-executed' && event?.executed === true)));
}

// Every non-state operation normally ends on the separate read-only observation
// job. `deploy-runtime` is the exception: its `deploy` job writes the accepted v5
// `anywear_service_deployment` record itself (the record cannot describe a
// deployment that did not happen), so the operation sets
// `requires_qualification=false` and there is no separate observation to require.
// Treating the skipped job as a missing required observation would mark every
// successful Runtime deployment `partial`, contradicting the recorded design.
const observationRequired = operation => !['state', 'deploy-runtime'].includes(operation);

export function finalizeOperationRecord(record, operationOutcome, observationOutcome) {
  const outcomes = ['success', 'failure', 'cancelled', 'skipped'];
  if (!outcomes.includes(operationOutcome) || !outcomes.includes(observationOutcome)) throw new Error('Invalid final operation outcome');
  readOperationRecord(record);
  const completedMutation = hasCompletedMutation(record);
  record.final_observation = record.operation === 'state' ? 'not-applicable' : observationOutcome;
  // Every non-state operation ends on an observed final stack state (terminal
  // Base plus the observed Runtime existence/status) that must be accepted; the
  // read-only state operation and the self-recording Runtime deploy are the only
  // exemptions.
  const requiresObservation = observationRequired(record.operation);
  let completedMutationFailure = false;
  if (operationOutcome !== 'success') {
    if (completedMutation) { record.result = 'partial'; completedMutationFailure = true; }
    else record.result = 'failed';
  } else if (requiresObservation && observationOutcome !== 'success') {
    // The mutation completed, but the required final observation did not confirm
    // the end state; the job still fails on that observation step.
    record.result = 'partial';
  } else {
    record.result = 'succeeded';
  }
  // A failed run whose stack mutation already completed is `partial` and needs an
  // explicit recovery decision. `restore-release` keeps its pre-existing promotion
  // for any non-succeeded result (including an observation failure after a
  // completed mutation).
  if (completedMutationFailure && record.recovery === 'not-required') recordRecovery(record, 'requires-explicit-recovery');
  if (record.result !== 'succeeded' && record.operation === 'restore-release' && record.recovery === 'not-required') recordRecovery(record, 'requires-explicit-recovery');
  return record;
}

// A deployment is not complete until its accepted record exists (#181). The
// credential-free `record` job owns this verdict: when the chain produced no
// accepted `anywear_infra_deployment`, the operation record becomes `partial` with
// an explicit recovery decision if a stack mutation already completed, and stays
// `failed` when nothing was mutated. Either way the durable record carries the
// missing-evidence event, so a reader never has to infer completeness from a run
// conclusion alone. Pure: it mutates and returns only the record it was given.
export function markDeploymentIncomplete(record, { observationJob, expectedWorkflow } = {}) {
  readOperationRecord(record);
  if (!['success', 'failure', 'cancelled', 'skipped', 'unavailable'].includes(observationJob)) {
    throw new Error('Invalid observation job outcome');
  }
  if (typeof expectedWorkflow !== 'string' || !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(expectedWorkflow)) {
    throw new Error('Expected deployment workflow required');
  }
  const completedMutation = hasCompletedMutation(record);
  record.result = completedMutation ? 'partial' : 'failed';
  if (completedMutation && record.recovery === 'not-required') recordRecovery(record, 'requires-explicit-recovery');
  record.events.push({ type: 'accepted-deployment-record', result: 'missing',
    observation_job: observationJob, expected_workflow: expectedWorkflow });
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = 'deployment-evidence/operation-record.json';
  let bytes;
  try { bytes = await readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bytes) await writeFile(file, canonicalJson(finalizeOperationRecord(structuredClone(parseJson(bytes)), process.env.OPERATION_OUTCOME, process.env.OBSERVATION_OUTCOME)));
}
