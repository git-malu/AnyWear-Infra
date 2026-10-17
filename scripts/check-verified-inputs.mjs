import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseJson, exact, matches, sha256, HASH, SHA, integer, DIGEST } from './json-contract.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';
import { operationBoundary } from './operation-boundaries.mjs';
import { validateReleaseInput, RELEASE_ASSETS, SERVICE_REPOSITORY } from './release-inputs.mjs';

// The deploy job downloads the verify job's artifact and proves it describes this
// exact dispatch before it requests an OIDC token or an STS session.
const env = process.env;
const root = path.resolve(import.meta.dirname, '..');
validateOperationInputs(env);
const boundary = operationBoundary(env);
const expectedRelease = validateReleaseInput(env);
const value = exact(parseJson(await readFile('deployment-evidence/verified-inputs.json')), ['schema_version', 'record_type',
  'operation', 'workflow', 'family', 'executor', 'release', 'assets'], 'verified inputs');
if (value.schema_version !== 2 || value.record_type !== 'anywear_infra_verified_inputs') throw new Error('Unknown verified inputs record');
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
  exact(value.release, ['id', 'tag', 'source_sha', 'image_digest'], 'verified release');
  integer(value.release.id, 'verified release ID');
  if (value.release.tag !== expectedRelease.releaseTag || value.release.source_sha !== expectedRelease.serviceCommit) {
    throw new Error('Verified release differs from this dispatch');
  }
  matches(value.release.source_sha, SHA, 'verified Service source'); matches(value.release.image_digest, DIGEST, 'verified image digest');
  exact(value.assets, [...RELEASE_ASSETS], 'verified release assets');
  for (const name of RELEASE_ASSETS) matches(value.assets[name], HASH, `verified asset ${name}`);
  // The artifact directory travelled between jobs; re-hash it so a modified
  // upload cannot reach CDK under an accepted record.
  for (const name of RELEASE_ASSETS) {
    const digest = sha256(await readFile(path.join(root, '.service-artifacts/selected', name)));
    if (digest !== value.assets[name]) throw new Error(`Verified release asset ${name} differs from the downloaded bytes`);
  }
  process.stdout.write(`Verified inputs bind ${value.workflow} ${value.operation} to ${SERVICE_REPOSITORY} ${value.release.tag}@${value.release.source_sha}.\n`);
}
