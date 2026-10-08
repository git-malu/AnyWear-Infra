import { spawnSync } from 'node:child_process';
import { validateOperationInputs, selectionBinding } from './runtime-operation.mjs';
import { loadCommittedSelection } from './artifact-consumer.mjs';
validateOperationInputs();
await loadCommittedSelection(selectionBinding());
const result = spawnSync('aws', process.argv.slice(2), { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
