import { mkdir, writeFile } from 'node:fs/promises';
import { canonicalJson } from './json-contract.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';
import { operationBoundary } from './operation-boundaries.mjs';
import { runVerifyInputs, verifyReleaseIdentity } from './release-inputs.mjs';

// The `verify` job completes every immutable-input check before any job acquires
// AWS credentials, and publishes exactly what it proved. The `deploy` job binds
// that artifact back to its own dispatch inputs and re-hashes the travelled bytes
// once. `deploy-platform` and `restore-release` both deploy the stage base, so
// both read the release identity over REST and download the three files it
// consumes into `.service-artifacts/selected`. Since #195 `deploy-runtime` proves
// the same release identity and every published asset over REST but downloads
// none of them: the Runtime template carries no Service-built file. Every other
// operation publishes the binding with no release and deploys no Service code.
const env = process.env;
validateOperationInputs(env);
const boundary = operationBoundary(env);
const release = env.INFRA_OPERATION === 'deploy-runtime'
  ? await verifyReleaseIdentity({ env })
  : await runVerifyInputs({ env });
await mkdir('deployment-evidence', { recursive: true });
const record = {
  schema_version: 3,
  record_type: 'anywear_infra_verified_inputs',
  operation: env.INFRA_OPERATION,
  workflow: boundary.workflow,
  family: boundary.family,
  executor: { repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA,
    run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT) },
  release: release?.release ?? null,
  assets: release?.assets ?? null,
};
await writeFile('deployment-evidence/verified-inputs.json', canonicalJson(record));
process.stdout.write(`${JSON.stringify({ record_type: record.record_type, operation: record.operation,
  release: record.release })}\n`);
