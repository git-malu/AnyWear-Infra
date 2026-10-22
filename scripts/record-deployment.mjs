import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, parseJson, sha256 } from './json-contract.mjs';
import { validateDeploymentRecord, validateObservationRecord } from './deployment-contract.mjs';
import { readOperationRecord } from './operation-record.mjs';
import { operationBoundary } from './operation-boundaries.mjs';
import { acceptedObservationRequired, deploymentRecordType, familyObservationRecordType, serviceDeploymentRecordType, serviceDeploymentRequired } from './observation-record.mjs';
import { markDeploymentIncomplete } from './finalize-operation.mjs';
import { acceptedRecordPath, deploymentRecordPath, familyRecordPath, operationRecordPath, serviceDeploymentRecordPath } from './deployment-evidence.mjs';

// The `record` job holds no credentials and no environment. It validates the
// evidence the credential jobs produced, binds it to this dispatch, decides
// whether the run is a complete deployment, records the exact checksums and leaves
// the artifact upload to assert its presence.
//
// Two layouts share this script. `mutate.yml` downloads the accepted record into
// `deployment-evidence/accepted/` and the mutation job's own observation into
// `deployment-evidence/family/`; `runtime.yml` still downloads its single artifact
// straight into `deployment-evidence/`. Files are classified by record type, never
// by which job happened to upload them.
const evidenceCandidates = Object.freeze([acceptedRecordPath, familyRecordPath, deploymentRecordPath, serviceDeploymentRecordPath]);
// The result values GitHub reports for a job that ran; `unavailable` means this
// run had no separate observation job to report (the manual `observe` producer).
const observationOutcomes = Object.freeze(['success', 'failure', 'cancelled', 'skipped', 'unavailable']);

async function readOptional(file) {
  try { return { file, value: parseJson(await readFile(file)) }; }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function recordDeployment(env = process.env, { root = '.', stdout = process.stdout } = {}) {
  const at = file => path.join(root, file);
  const boundary = operationBoundary(env);
  // The parsed JSON contract defines non-writable members; the incomplete mark is
  // written through a mutable copy, exactly as the finalizer CLI does.
  const operation = structuredClone(readOperationRecord(parseJson(await readFile(at(operationRecordPath)))));
  if (operation.operation !== env.INFRA_OPERATION || operation.executor?.workflow_path !== boundary.workflow) {
    throw new Error('Operation record describes another operation or workflow');
  }
  const accepted = [];
  const family = [];
  for (const entry of await Promise.all(evidenceCandidates.map(file => readOptional(at(file))))) {
    if (!entry) continue;
    if (entry.value?.record_type === deploymentRecordType || entry.value?.record_type === serviceDeploymentRecordType) accepted.push(entry);
    else if (entry.value?.record_type === familyObservationRecordType) family.push(entry);
    else throw new Error(`Unknown observation record type in ${entry.file}`);
  }
  if (accepted.length > 1 || family.length > 1) throw new Error('Duplicate deployment evidence in this run');
  // A record from another dispatch is invalid evidence, not an incomplete
  // deployment: the producer block must name this run, this source and this
  // workflow before either contract is validated. An older run's artifact can
  // therefore never stand in for this deployment's record.
  const requireThisRun = (entry, validate) => {
    const record = entry.value;
    if (record.producer?.sha !== env.GITHUB_SHA || record.producer?.workflow_path !== boundary.workflow
      || Number(record.producer?.run_id) !== Number(env.GITHUB_RUN_ID)
      || Number(record.producer?.run_attempt) !== Number(env.GITHUB_RUN_ATTEMPT)) {
      throw new Error('Deployment record describes another executor source, workflow or run');
    }
    validate(record);
    return entry;
  };
  const acceptedEntry = accepted[0] ? requireThisRun(accepted[0], validateDeploymentRecord) : undefined;
  const familyEntry = family[0] ? requireThisRun(family[0], validateObservationRecord) : undefined;
  // `deploy-runtime` produces the v5 Service record in its own mutation job; a
  // missing one is an incomplete deployment, exactly like a missing accepted
  // observation.
  const requiresAccepted = acceptedObservationRequired(operation.operation) || serviceDeploymentRequired(operation.operation);
  const requireRecord = env.REQUIRE_DEPLOYMENT_RECORD === 'true';
  const observeJob = env.OBSERVE_JOB_RESULT ?? 'unavailable';
  if (!observationOutcomes.includes(observeJob)) throw new Error('Invalid observation job result');
  const checksums = [];
  const checksum = async file => {
    const target = path.isAbsolute(file) ? file : at(file);
    const bytes = await readFile(target);
    const digest = sha256(bytes);
    await writeFile(`${target}.sha256`, `${digest}  ${path.basename(target)}\n`);
    checksums.push({ file: path.isAbsolute(file) ? path.relative(root, file).split(path.sep).join('/') : file, sha256: digest });
    return digest;
  };
  const report = () => stdout.write(`${JSON.stringify({ operation: operation.operation, family: boundary.family,
    result: operation.result, requires_accepted_observation: requiresAccepted, deploy_job_result: env.DEPLOY_JOB_RESULT ?? 'unavailable',
    observe_job_result: observeJob, records: checksums })}\n`);
  // A deployment is not complete until its accepted record exists. The marked
  // operation record is written before the failure so the `if: always()` upload
  // preserves it, and only a completed stack mutation earns an explicit recovery.
  if (requiresAccepted && requireRecord && !acceptedEntry) {
    markDeploymentIncomplete(operation, { observationJob: observeJob, expectedWorkflow: boundary.workflow });
    await writeFile(at(operationRecordPath), canonicalJson(operation));
    await checksum(operationRecordPath);
    if (familyEntry) await checksum(familyEntry.file);
    report();
    throw new Error('The accepted deployment record is missing');
  }
  // For an operation outside the trigger set, the required evidence follows the
  // operation record's own terminal result: only a `succeeded` operation can be
  // followed by the family observation, so only it requires one. A `failed` or
  // `partial` operation publishes its operation record, which already states the
  // absent observation and the recovery decision; `state` claims no record at all.
  const familyScope = requireRecord && !requiresAccepted && operation.operation !== 'state';
  if (familyScope && !['succeeded', 'failed', 'partial'].includes(operation.result)) {
    throw new Error('The operation record has no final result');
  }
  if (familyScope && operation.result === 'succeeded' && !familyEntry) {
    await checksum(operationRecordPath);
    report();
    throw new Error('A successful operation requires its family observation record');
  }
  await checksum(operationRecordPath);
  if (acceptedEntry) await checksum(acceptedEntry.file);
  if (familyEntry) await checksum(familyEntry.file);
  report();
  return { operation, accepted: acceptedEntry?.value, family: familyEntry?.value, checksums };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await recordDeployment();
}
