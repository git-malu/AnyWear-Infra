import { validateOperationInputs, selectionBinding } from './runtime-operation.mjs';
import { loadCommittedSelection } from './artifact-consumer.mjs';
validateOperationInputs();
await loadCommittedSelection(selectionBinding());
