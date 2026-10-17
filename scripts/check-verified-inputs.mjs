import { readFile } from 'node:fs/promises';
import { parseJson, exact, matches, HASH, SHA } from './json-contract.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';
import { operationBoundary } from './operation-boundaries.mjs';

// The deploy job downloads the verify job's artifact and proves it describes this
// exact dispatch before it requests an OIDC token or an STS session.
const env = process.env;
validateOperationInputs(env);
const boundary = operationBoundary(env);
const value = exact(parseJson(await readFile('deployment-evidence/verified-inputs.json')), ['schema_version', 'record_type', 'operation', 'workflow',
  'family', 'executor', 'selection', 'stack_sources', 'release', 'components', 'manifest'], 'verified inputs');
if (value.schema_version !== 1 || value.record_type !== 'anywear_infra_verified_inputs') throw new Error('Unknown verified inputs record');
if (value.operation !== env.INFRA_OPERATION || value.workflow !== boundary.workflow || value.family !== boundary.family) {
  throw new Error('Verified inputs describe another operation or workflow');
}
exact(value.executor, ['repository', 'sha', 'run_id', 'run_attempt'], 'verified inputs executor');
if (value.executor.repository !== env.GITHUB_REPOSITORY || value.executor.sha !== env.GITHUB_SHA) throw new Error('Verified inputs describe another executor source');
exact(value.selection, ['file', 'sha256'], 'verified selection');
if (value.selection.file !== env.SELECTION_FILE || value.selection.sha256 !== env.SELECTION_SHA256) throw new Error('Verified selection differs from this dispatch');
matches(value.selection.sha256, HASH, 'verified selection hash');
exact(value.stack_sources, ['file', 'sha256'], 'verified stack sources');
if (value.stack_sources.file !== env.STACK_SOURCES_FILE || value.stack_sources.sha256 !== env.STACK_SOURCES_SHA256) throw new Error('Verified stack sources differ from this dispatch');
matches(value.stack_sources.sha256, HASH, 'verified stack sources hash');
exact(value.release, ['repository', 'id', 'manifest_asset_id', 'manifest_sha256'], 'verified release');
matches(value.executor.sha, SHA, 'verified executor source');
process.stdout.write(`Verified inputs bind ${value.workflow} ${value.operation} at ${value.executor.sha}.\n`);
