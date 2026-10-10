import { spawnSync } from 'node:child_process';
import { validateOperationInputs, selectionBinding } from './runtime-operation.mjs';
import { loadCommittedSelection } from './artifact-consumer.mjs';
import { assertAwsAllowed } from './operation-boundaries.mjs';
import { parseJson } from './json-contract.mjs';
validateOperationInputs();
const selector = await loadCommittedSelection(selectionBinding());
assertAwsAllowed(process.env, process.argv.slice(2));
if (process.argv[2] === 'ecs' && process.argv[3] === 'register-task-definition') {
  const definition = parseJson(process.argv[process.argv.indexOf('--cli-input-json') + 1]);
  if (definition.containerDefinitions?.length !== 1
    || definition.containerDefinitions[0].image !== `${selector.image.repository_uri}@${selector.image.digest}`) throw new Error('Task registration must retain the selected immutable image');
}
const result = spawnSync('aws', process.argv.slice(2), { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
