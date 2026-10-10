import { readFile, writeFile } from 'node:fs/promises';
import { validateOperationInputs, selectionBinding, createRuntimeIo } from './runtime-operation.mjs';
import { loadCommittedSelection } from './artifact-consumer.mjs';
import { observeDeployment } from './observe-deployment.mjs';
import { validateDeploymentRecord, validateSnapshot } from './deployment-contract.mjs';
import { operationBoundary } from './operation-boundaries.mjs';
import { canonicalJson, parseJson } from './json-contract.mjs';

validateOperationInputs();
const env = process.env;
const boundary = operationBoundary(env);
if (boundary.readOnly) throw new Error('State observation cannot emit qualification');
const binding = selectionBinding();
const selector = await loadCommittedSelection(binding);
const operation = parseJson(await readFile('deployment-evidence/operation-record.json'));
const io = await createRuntimeIo(selector, '.service-artifacts/selected', env, operation, { purpose: 'qualification' });
try {
  // observeDeployment repeats complete native release verification before lazy STS.
  const snapshot = await observeDeployment({ binding, stackSources: operation.reviewed_stack_sources, infraSha: env.GITHUB_SHA, io, env });
  const { image, lambdas, runtime_policy, schema, release } = selector;
  const record = { schema_version: 2,
    record_type: boundary.family === 'runtime' ? 'anywear_infra_deployment' : 'anywear_infra_family_observation',
    infra: { repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA, workflow_path: boundary.workflow,
      workflow_ref: env.GITHUB_WORKFLOW_REF, run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT) },
    selection: { file: binding.selectionFile, sha256: binding.selectionSha256, release, components: { image, lambdas, runtime_policy, schema } }, ...snapshot };
  if (boundary.family === 'runtime') validateDeploymentRecord(record);
  else validateSnapshot(snapshot, { infraWorkflows: [boundary.workflow] });
  await writeFile('deployment-evidence/deployment-record.json', canonicalJson(record));
} finally {
  await writeFile('deployment-evidence/operation-record.json', canonicalJson(operation));
}
