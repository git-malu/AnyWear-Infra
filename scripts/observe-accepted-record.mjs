import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateOperationInputs, createRuntimeIo } from './runtime-operation.mjs';
import { observeDeployment } from './observe-deployment.mjs';
import { validateDeploymentRecord } from './deployment-contract.mjs';
import { operationBoundary } from './operation-boundaries.mjs';
import { acceptedObservationRequired, buildDeploymentRecord, unpublishedStageInputs } from './observation-record.mjs';
import { canonicalJson } from './json-contract.mjs';
import { deploymentRecordPath } from './deployment-evidence.mjs';

// The accepted `anywear_infra_deployment` v3 producer of a deployment run (#181).
// It is the deploy chain's read-only observation job: the runtime role only, the
// `qualification` session policy (no ECS/PassRole, no retention write), no deploy
// role, no App token and no verified-inputs artifact. A mutation run can never
// write this record type from the job that holds the mutation role.
//
// The observation is the same authenticated body the manual `observe` produces,
// with two reviewed differences: it never reads or requires the Infra-owned
// Runtime stack (`requireRuntime: false`, so a Foundation/Billing deploy while
// Beta is stopped is a complete deployment), and only the pre-M4 operations may
// record the published subset of the stage-contract surface.
export function assertAcceptedObservationOperation(operation) {
  if (!acceptedObservationRequired(operation)) {
    throw new Error(`Operation ${operation} does not produce an accepted deployment record`);
  }
  return operation;
}

export async function observeAcceptedRecord(env = process.env, { io, observe = observeDeployment, root = '.' } = {}) {
  validateOperationInputs(env);
  assertAcceptedObservationOperation(env.INFRA_OPERATION);
  const boundary = operationBoundary(env);
  const session = io ?? await createRuntimeIo(env, undefined, { purpose: 'qualification' });
  const body = await observe({ infraSha: env.GITHUB_SHA, io: session, env,
    requireRuntime: false, allowUnpublishedStageInputs: unpublishedStageInputs(env.INFRA_OPERATION) });
  const record = buildDeploymentRecord(env, body, boundary.workflow);
  validateDeploymentRecord(record);
  const file = path.join(root, deploymentRecordPath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, canonicalJson(record));
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await observeAcceptedRecord();
}
