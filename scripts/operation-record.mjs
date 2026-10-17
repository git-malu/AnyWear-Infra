import { canonicalJson, sha256, SHA, matches } from './json-contract.mjs';
import { operationBoundary } from './operation-boundaries.mjs';
import { changedStackNames, configuredStackNames, validateStackManifest } from './operation-stacks.mjs';

export function createOperationRecord({ env, selector, stackManifest }) {
  matches(env.GITHUB_SHA, SHA, 'operation executor source');
  if (env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Infra') throw new Error('Operation provenance unavailable');
  const stacks = validateStackManifest(stackManifest, 'operation record');
  const boundary = operationBoundary(env);
  return { schema_version: 3, record_type: 'anywear_infra_operation', operation: env.INFRA_OPERATION, family: boundary.family,
    executor: { repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA, workflow_path: boundary.workflow,
      run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT) },
    context: { account: env.AWS_ACCOUNT_ID, region: env.AWS_REGION, identity_phase: env.INFRA_IDENTITY_PHASE, retention_protection: env.INFRA_RETENTION_PROTECTION === 'true' },
    selection: { file: env.SELECTION_FILE, sha256: sha256(canonicalJson(selector)), release: selector.release,
      components: { image: selector.image, lambdas: selector.lambdas, runtime_policy: selector.runtime_policy, schema: selector.schema } },
    lifecycle_implementation_origin: { repository: 'git-malu/AnyWear-Service', sha: '885b2989b0f908f050998329f5c97677cba2a242', path: '.github/scripts/beta-lifecycle.mjs' },
    stack_manifest: stacks, changed_stack_names: changedStackNames(env.INFRA_OPERATION), original_stack_templates: [], events: [], recovery: 'not-required', result: 'running' };
}

// Historical v2 records carried hand-authored per-stack producer sources. They
// remain readable so dual-run comparison can prove the new provenance agrees.
export function readOperationRecord(value) {
  if (value?.record_type !== 'anywear_infra_operation' || ![2, 3].includes(value.schema_version)) throw new Error('Unknown operation record schema');
  if (value.schema_version === 3) {
    validateStackManifest(value.stack_manifest, 'operation record');
    const configured = configuredStackNames();
    if (!Array.isArray(value.changed_stack_names) || value.changed_stack_names.some(name => !configured.includes(name))) throw new Error('Invalid changed stack names');
  }
  return value;
}

export function recordRecovery(record, outcome) {
  const transitions = { 'not-required': ['began', 'requires-explicit-recovery'], began: ['succeeded', 'failed'] };
  if (!transitions[record.recovery]?.includes(outcome)) throw new Error('Invalid recovery evidence transition');
  record.recovery = outcome;
}
