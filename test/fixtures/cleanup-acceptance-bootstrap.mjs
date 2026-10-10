import { canonicalJson, sha256 } from '../../scripts/json-contract.mjs';

// Kept compatible with E2E's actual assertIntent/assertBootstrap/assertBudget.
export function cleanupAcceptanceBootstrap() {
  const repository = 'git-malu/AnyWear-E2E';
  const workflow_path = '.github/workflows/beta-cleanup-acceptance.yml';
  const producer = { repository, workflow_path, source_sha: 'a'.repeat(40), run_id: 123, run_attempt: 1 };
  const run_scope = '123-1-0123456789abcdef';
  const budget = { maxActiveAccounts: 2, maxNewAccountsPerRun: 2, maxQuarantinedAccounts: 2 };
  const frozen_tuple = { service_source_sha: 'b'.repeat(40), service_image_digest: `sha256:${'c'.repeat(64)}`,
    state_machine_version_arn: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:7',
    fixture_source_sha: 'd'.repeat(40), fixture_task_definition_arn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-cleanup-acceptance:8',
    selection_sha256: 'e'.repeat(64), stack_sources_sha256: 'f'.repeat(64) };
  const identities = [2, 3].map((slot, index) => ({ slot, email: `e2e-beta-worker-${slot}-chromium@anywear.local`,
    sub: `${index + 1}`.repeat(8) + '-1111-1111-1111-111111111111', username: `captured-user-${slot}`,
    lease_generation: `${index + 3}`.repeat(8) + '-1111-1111-1111-111111111111',
    create_started_at: '2026-10-10T01:00:03Z', captured_at: '2026-10-10T01:00:04Z' }));
  const intent = { schema_version: 1, record_type: 'anywear_e2e_cleanup_acceptance_creation_intent', issue: 86,
    producer, run_scope, account_budget_config: budget,
    identities: identities.map(({ slot, email, lease_generation }) => ({ slot, email, lease_generation, preflight_absent: true })),
    created_at: '2026-10-10T01:00:01Z', frozen_tuple };
  const intentBytes = Buffer.from(JSON.stringify(intent));
  const intentOrigin = { ...producer, artifact_id: 456, artifact_sha256: '0'.repeat(64), manifest_sha256: sha256(intentBytes) };
  const request = { run_scope, users: identities.map(({ slot, sub, email }) => ({ slot, user_id: sub, email })) };
  const fixture_request = JSON.stringify(request);
  const cleanupRequest = users => { const json = JSON.stringify({ runScope: run_scope, users }); return { json, sha256: sha256(json) }; };
  const manifest = { schema_version: 1, record_type: 'anywear_e2e_cleanup_acceptance_bootstrap', issue: 86,
    phase: 'bootstrap', result: 'captured-identities-retained', producer, run_scope, account_budget_config: budget,
    intent_origin: intentOrigin, identities, fixture_request, fixture_request_sha256: sha256(fixture_request), cleanup_requests: {
      primary: cleanupRequest([{ sub: identities[0].sub, email: identities[0].email }]),
      mismatch: cleanupRequest([{ sub: identities[0].sub, email: identities[1].email }]),
      sentinel: cleanupRequest([{ sub: identities[1].sub, email: identities[1].email }]),
    }, frozen_tuple };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const origin = { ...producer, artifact_id: 457, artifact_sha256: '1'.repeat(64), manifest_sha256: sha256(manifestBytes) };
  const repo = { full_name: repository, id: 1317091305, owner: { login: 'git-malu', id: 11473072 } };
  const run = { id: producer.run_id, run_attempt: producer.run_attempt, head_sha: producer.source_sha,
    head_branch: 'main', event: 'workflow_dispatch', path: workflow_path, status: 'completed', conclusion: 'success',
    repository: repo, head_repository: repo, created_at: '2026-10-10T01:00:00Z', updated_at: '2026-10-10T01:00:06Z' };
  const artifact = (value, kind, created_at) => ({ id: value.artifact_id, name: `beta-cleanup-acceptance-${kind}-123-1`,
    expired: false, digest: `sha256:${value.artifact_sha256}`, size_in_bytes: 5000, created_at,
    expires_at: '2099-01-01T00:00:00Z', workflow_run: { id: 123, head_sha: producer.source_sha, head_branch: 'main' } });
  const intentArtifact = artifact(intentOrigin, 'intent', '2026-10-10T01:00:02Z');
  const bootstrapArtifact = artifact(origin, 'bootstrap', '2026-10-10T01:00:05Z');
  const accounts = identities.map((identity, index) => ({ email: identity.email, mode: 'worker', status: 'provisioning',
    leaseId: `${index + 5}`.repeat(8) + '-1111-1111-1111-111111111111', leaseGeneration: identity.lease_generation,
    createdAt: '2026-10-10T01:00:01Z', updatedAt: '2026-10-10T01:00:01Z' }));
  const intentBudget = { version: 1, runScope: run_scope, config: budget, accounts };
  const capturedBudget = { ...intentBudget, accounts: accounts.map((account, index) => ({ ...account,
    subject: identities[index].sub, status: 'cleanup_pending', updatedAt: '2026-10-10T01:00:04Z' })) };
  const env = { FIXTURE_REQUEST: fixture_request, BOOTSTRAP_ORIGIN: canonicalJson(origin), FIXTURE_SOURCE_SHA: frozen_tuple.fixture_source_sha,
    FIXTURE_TASK_DEFINITION_ARN: frozen_tuple.fixture_task_definition_arn, SELECTION_SHA256: frozen_tuple.selection_sha256,
    STACK_SOURCES_SHA256: frozen_tuple.stack_sources_sha256 };
  const selector = { image: { service_sha: frozen_tuple.service_source_sha, digest: frozen_tuple.service_image_digest } };
  return { origin, intentOrigin, run, manifest, intent, intentArtifact, bootstrapArtifact, request, env, selector, capturedBudget, intentBudget,
    files: { 'bootstrap-manifest.json': manifestBytes, 'creation-intent.json': intentBytes, 'account-budget.json': Buffer.from(JSON.stringify(capturedBudget)) },
    intentFiles: { 'creation-intent.json': intentBytes, 'account-budget.json': Buffer.from(JSON.stringify(intentBudget)) } };
}
