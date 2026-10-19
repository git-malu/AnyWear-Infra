import { readFile, writeFile } from 'node:fs/promises';
import { validateOperationInputs, createRuntimeIo } from './runtime-operation.mjs';
import { observeDeployment } from './observe-deployment.mjs';
import { validateDeploymentRecord, validateObservationRecord } from './deployment-contract.mjs';
import { operationBoundary } from './operation-boundaries.mjs';
import { deploymentRecordType, observationRecordType } from './observation-record.mjs';
import { canonicalJson, parseJson } from './json-contract.mjs';
import { readOperationRecord } from './operation-record.mjs';

validateOperationInputs();
const env = process.env;
const boundary = operationBoundary(env);
if (boundary.readOnly) throw new Error('State observation cannot emit qualification');
const operation = readOperationRecord(parseJson(await readFile('deployment-evidence/operation-record.json')));
const io = await createRuntimeIo(env, operation, { purpose: 'qualification' });
try {
  // The authenticated observation covers the stacks Infra still produces and the
  // stage-contract surface it publishes. The release slice is observed by
  // AnyWear-Service's release chain, never from here. Only the `runtime` family
  // (`observe`) qualifies the running slice and requires the Runtime stack; a
  // `beta-deploy` observation runs before M6 or while Beta is stopped.
  // `deploy-foundation`/`deploy-billing` run before M4 (the `api_base_url`
  // publication), so they may record the published subset; every other
  // operation keeps the strict 0.3.0 surface.
  const allowUnpublishedStageInputs = ['deploy-foundation', 'deploy-billing'].includes(env.INFRA_OPERATION)
    ? ['api_base_url'] : [];
  const body = await observeDeployment({ infraSha: env.GITHUB_SHA, io, env,
    requireRuntime: boundary.family === 'runtime', allowUnpublishedStageInputs });
  const record = { schema_version: 3,
    record_type: observationRecordType(boundary.family),
    producer: { repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA, workflow_path: boundary.workflow,
      workflow_ref: env.GITHUB_WORKFLOW_REF, run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT) },
    ...body };
  if (record.record_type === deploymentRecordType) validateDeploymentRecord(record);
  else validateObservationRecord(record);
  await writeFile('deployment-evidence/deployment-record.json', canonicalJson(record));
} finally {
  await writeFile('deployment-evidence/operation-record.json', canonicalJson(operation));
}
