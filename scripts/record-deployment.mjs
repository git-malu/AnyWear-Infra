import { readFile, writeFile } from 'node:fs/promises';
import { parseJson, sha256 } from './json-contract.mjs';
import { validateDeploymentRecord, validateSnapshot } from './deployment-contract.mjs';
import { readOperationRecord } from './operation-record.mjs';
import { operationBoundary } from './operation-boundaries.mjs';
import { deploymentRecordType, familyObservationRecordType } from './observation-record.mjs';

// The `record` job holds no credentials and no environment. It validates the
// evidence the credential job produced, binds it to this dispatch, records the
// exact checksums and leaves the artifact upload to assert its presence.
const env = process.env;
const boundary = operationBoundary(env);
const operationBytes = await readFile('deployment-evidence/operation-record.json');
const operation = readOperationRecord(parseJson(operationBytes));
if (operation.operation !== env.INFRA_OPERATION || operation.executor?.workflow_path !== boundary.workflow) {
  throw new Error('Operation record describes another operation or workflow');
}
let deploymentBytes;
try {
  deploymentBytes = await readFile('deployment-evidence/deployment-record.json');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!deploymentBytes && env.REQUIRE_DEPLOYMENT_RECORD === 'true') throw new Error('A successful operation requires a deployment record');
const checksums = [];
const checksum = async name => {
  const bytes = await readFile(`deployment-evidence/${name}`);
  const digest = sha256(bytes);
  await writeFile(`deployment-evidence/${name}.sha256`, `${digest}  ${name}\n`);
  checksums.push({ file: name, sha256: digest });
};
if (deploymentBytes) {
  const record = parseJson(deploymentBytes);
  if (record.infra?.sha !== env.GITHUB_SHA || record.infra?.workflow_path !== boundary.workflow) {
    throw new Error('Deployment record describes another executor source or workflow');
  }
  if (record.record_type === deploymentRecordType) validateDeploymentRecord(record);
  else if (record.record_type === familyObservationRecordType) {
    if (record.schema_version !== 2) throw new Error('Unknown family observation schema');
    validateSnapshot({ stacks: record.stacks, observed: record.observed, schema: record.schema },
      { infraWorkflows: [boundary.workflow] });
  } else throw new Error('Unknown observation record type');
  await checksum('deployment-record.json');
}
await checksum('operation-record.json');
process.stdout.write(`${JSON.stringify({ operation: operation.operation, family: boundary.family,
  result: operation.result, deploy_job_result: env.DEPLOY_JOB_RESULT ?? 'unavailable', records: checksums })}\n`);
