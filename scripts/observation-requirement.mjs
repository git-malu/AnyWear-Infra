import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { acceptedObservationRequired } from './observation-record.mjs';

// Credential-free preflight output for the deployment chain (#181). The trigger
// set lives in `observation-record.mjs` and is derived from the frozen stack
// tables, so the `observe` job gate cannot drift from the predicate a verifier
// reads. `check-operation.mjs` has already refused a forbidden operation by the
// time this runs; an operation outside the trigger set simply reports `false`.
export function requiresAcceptedObservation(env = process.env) {
  return acceptedObservationRequired(env.INFRA_OPERATION);
}

export async function publishObservationRequirement(env = process.env) {
  const line = `requires_accepted_observation=${requiresAcceptedObservation(env)}`;
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `${line}\n`);
  else process.stdout.write(`${line}\n`);
  return line;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await publishObservationRequirement();
}
