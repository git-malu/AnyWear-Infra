import { readFile } from 'node:fs/promises';
import { parseJson, exact, matches, SHA, DIGEST, integer } from './json-contract.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';
import { operationBoundary } from './operation-boundaries.mjs';
import { validateReleaseInput, STAGE_BASE_ASSETS, SERVICE_REPOSITORY, SELECTED_RELEASE_DIRECTORY,
  assertSelectedReleaseBytes } from './release-inputs.mjs';
import { loadLocalArtifactInputs } from './local-artifact-inputs.mjs';

// The deploy job downloads the verify job's artifact and proves it describes this
// exact dispatch before it requests an OIDC token or an STS session. Both
// stage-base operations re-hash the three travelled release files, each exactly
// once, in the exact directory the CDK deploy consumes.
const env = process.env;
validateOperationInputs(env);
const boundary = operationBoundary(env);
const expectedRelease = validateReleaseInput(env);
const value = exact(parseJson(await readFile('deployment-evidence/verified-inputs.json')), ['schema_version', 'record_type',
  'operation', 'workflow', 'family', 'executor', 'release', 'assets'], 'verified inputs');
if (value.schema_version !== 3 || value.record_type !== 'anywear_infra_verified_inputs') throw new Error('Unknown verified inputs record');
if (value.operation !== env.INFRA_OPERATION || value.workflow !== boundary.workflow || value.family !== boundary.family) {
  throw new Error('Verified inputs describe another operation or workflow');
}
exact(value.executor, ['repository', 'sha', 'run_id', 'run_attempt'], 'verified inputs executor');
if (value.executor.repository !== env.GITHUB_REPOSITORY || value.executor.sha !== env.GITHUB_SHA) throw new Error('Verified inputs describe another executor source');
matches(value.executor.sha, SHA, 'verified executor source');
integer(value.executor.run_id, 'verified run'); integer(value.executor.run_attempt, 'verified attempt');
if (!expectedRelease) {
  if (value.release !== null || value.assets !== null) throw new Error('Verified inputs carry a release this operation does not take');
  process.stdout.write(`Verified inputs bind ${value.workflow} ${value.operation} at ${value.executor.sha} with no Service release.\n`);
} else {
  exact(value.release, ['id', 'tag', 'source_sha'], 'verified release');
  integer(value.release.id, 'verified release ID');
  if (value.release.tag !== expectedRelease.releaseTag || value.release.source_sha !== expectedRelease.serviceCommit) {
    throw new Error('Verified release differs from this dispatch');
  }
  matches(value.release.source_sha, SHA, 'verified Service source');
  exact(value.assets, [...STAGE_BASE_ASSETS], 'verified release assets');
  for (const name of STAGE_BASE_ASSETS) matches(value.assets[name], DIGEST, `verified asset ${name}`);
  // The artifact directory travelled between jobs; hash its three files once each
  // so a modified upload cannot reach CDK under an accepted record.
  await assertSelectedReleaseBytes(value.assets, SELECTED_RELEASE_DIRECTORY);
  // The same strict loader CDK uses, so the downloaded policy bytes are proven
  // parseable before the restricted session is requested.
  loadLocalArtifactInputs(SELECTED_RELEASE_DIRECTORY);
  process.stdout.write(`Verified inputs bind ${value.workflow} ${value.operation} to ${SERVICE_REPOSITORY} ${value.release.tag}@${value.release.source_sha}.\n`);
}
