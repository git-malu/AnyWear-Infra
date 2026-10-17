import { mkdir, writeFile } from 'node:fs/promises';
import { canonicalJson } from './json-contract.mjs';
import { validateOperationInputs, selectionBinding } from './runtime-operation.mjs';
import { loadCommittedSelection, verifySelection } from './artifact-consumer.mjs';
import { operationBoundary } from './operation-boundaries.mjs';

// The `verify` job completes every immutable-input check before any job acquires
// AWS credentials, and publishes exactly what it proved. The `deploy` job binds
// that artifact back to its own dispatch inputs, and the operation re-verifies the
// immutable release itself before requesting a restricted session.
const env = process.env;
validateOperationInputs(env);
const boundary = operationBoundary(env);
const binding = selectionBinding(env);
// Committed selection bytes at this exact Infra SHA, before any network read.
const selector = await loadCommittedSelection(binding);
await mkdir('deployment-evidence', { recursive: true });
const verified = await verifySelection(binding, '.service-artifacts/selected');
const record = {
  schema_version: 1,
  record_type: 'anywear_infra_verified_inputs',
  operation: env.INFRA_OPERATION,
  workflow: boundary.workflow,
  family: boundary.family,
  executor: { repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA,
    run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT) },
  selection: { file: env.SELECTION_FILE, sha256: env.SELECTION_SHA256 },
  stack_sources: { file: env.STACK_SOURCES_FILE, sha256: env.STACK_SOURCES_SHA256 },
  release: selector.release,
  components: { image: selector.image, lambdas: selector.lambdas,
    runtime_policy: selector.runtime_policy, schema: selector.schema },
  manifest: { schema_version: verified.manifest.schema_version, record_type: verified.manifest.record_type,
    kind: verified.manifest.kind, producer: verified.manifest.producer },
};
await writeFile('deployment-evidence/verified-inputs.json', canonicalJson(record));
process.stdout.write(`${JSON.stringify({ record_type: record.record_type, operation: record.operation,
  selection_sha256: record.selection.sha256, release_id: record.release.id })}\n`);
