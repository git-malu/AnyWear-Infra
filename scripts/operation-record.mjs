import { canonicalJson, sha256, SHA, matches } from './json-contract.mjs';

export function createOperationRecord({ env, selector, reviewedStackSources }) {
  matches(env.GITHUB_SHA, SHA, 'operation executor source');
  if (env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Infra' || !Array.isArray(reviewedStackSources) || reviewedStackSources.length !== 4) throw new Error('Operation provenance unavailable');
  return { schema_version: 2, record_type: 'anywear_infra_operation', operation: env.INFRA_OPERATION,
    executor: { repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA, workflow_path: '.github/workflows/runtime.yml',
      run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT) },
    context: { account: env.AWS_ACCOUNT_ID, region: env.AWS_REGION, identity_phase: env.INFRA_IDENTITY_PHASE, retention_protection: env.INFRA_RETENTION_PROTECTION === 'true' },
    selection: { file: env.SELECTION_FILE, sha256: sha256(canonicalJson(selector)), release: selector.release,
      components: { image: selector.image, lambdas: selector.lambdas, runtime_policy: selector.runtime_policy, schema: selector.schema } },
    lifecycle_implementation_origin: { repository: 'git-malu/AnyWear-Service', sha: '885b2989b0f908f050998329f5c97677cba2a242', path: '.github/scripts/beta-lifecycle.mjs' },
    reviewed_stack_sources: reviewedStackSources, original_stack_templates: [], events: [], recovery: 'not-required', result: 'running' };
}

export function recordRecovery(record, outcome) {
  const transitions = { 'not-required': ['began', 'requires-explicit-start'], began: ['succeeded', 'failed'] };
  if (!transitions[record.recovery]?.includes(outcome)) throw new Error('Invalid recovery evidence transition');
  record.recovery = outcome;
}
