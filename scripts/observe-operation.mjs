import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { validateOperationInputs, createRuntimeIo, credentialEnvironment } from './runtime-operation.mjs';
import { observeDeployment } from './observe-deployment.mjs';
import { runAuthorizationPreflight } from './authorization-preflight.mjs';
import { validateDeploymentRecord, validateObservationRecord } from './deployment-contract.mjs';
import { operationBoundary } from './operation-boundaries.mjs';
import { buildDeploymentRecord, deploymentRecordType, observationRecordType, unpublishedStageInputs } from './observation-record.mjs';
import { canonicalJson, parseJson } from './json-contract.mjs';
import { readOperationRecord } from './operation-record.mjs';

// The name the composite action uploads this observation under. The accepted
// record owns the `infra-deployment-<run-id>-<attempt>` name the E2E producer
// convention expects; a `beta-deploy` run's family observation is uploaded under
// `infra-family-observation-<run-id>-<attempt>` instead, so the mutation job can
// never overwrite the accepted record of its own run (#181). The action reads this
// name from the step environment: if it is unset the upload fails rather than
// guessing a name.
export function observationArtifactName(recordType, env = process.env) {
  const prefix = recordType === deploymentRecordType ? 'infra-deployment' : 'infra-family-observation';
  return `${prefix}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
}

validateOperationInputs();
const env = process.env;
const boundary = operationBoundary(env);
if (boundary.readOnly) throw new Error('State observation cannot emit qualification');
const operation = readOperationRecord(parseJson(await readFile('deployment-evidence/operation-record.json')));
const io = await createRuntimeIo(env, operation, { purpose: 'qualification' });
try {
  // Pre-mutation preflight (#165) on the observe path: the qualification session
  // is available, and the policy simulation runs before the observation starts.
  // A deny or simulation failure stops before the observation does any work.
  await runAuthorizationPreflight({ sessions: ['runtime'], env, purpose: 'qualification', assume: credentialEnvironment });
  // The authenticated observation covers the stacks Infra still produces and the
  // stage-contract surface it publishes. The release slice is deployed and
  // recorded by `deploy-runtime`, never from here. Only the `runtime` family
  // (`observe`) qualifies the running slice and requires the Runtime stack; a
  // `beta-deploy` observation runs before M6 or while Beta is stopped, so it never
  // reads or requires Runtime. A `deploy-foundation`/`deploy-billing` observation
  // may record the pre-M4 published subset; every other operation stays strict.
  const body = await observeDeployment({ infraSha: env.GITHUB_SHA, io, env,
    requireRuntime: boundary.family === 'runtime', allowUnpublishedStageInputs: unpublishedStageInputs(env.INFRA_OPERATION) });
  const record = buildDeploymentRecord(env, body, boundary.workflow, observationRecordType(boundary.family));
  if (record.record_type === deploymentRecordType) validateDeploymentRecord(record);
  else validateObservationRecord(record);
  await writeFile('deployment-evidence/deployment-record.json', canonicalJson(record));
  if (env.GITHUB_ENV) await appendFile(env.GITHUB_ENV, `INFRA_OBSERVATION_ARTIFACT=${observationArtifactName(record.record_type, env)}\n`);
} finally {
  await writeFile('deployment-evidence/operation-record.json', canonicalJson(operation));
}
