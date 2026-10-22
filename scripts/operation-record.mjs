import { canonicalJson, sha256, SHA, DIGEST, matches } from './json-contract.mjs';
import { operationBoundary } from './operation-boundaries.mjs';
import { changedStackNames, configuredStacks, operationStackNames, validateStackManifest } from './operation-stacks.mjs';

const RELEASE_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SERVICE_RELEASE_KEYS = Object.freeze(['releaseTag', 'serviceCommit']);

// The v4 `service_release` block: the reviewed release tag and Service commit a
// `deploy-platform`/`restore-release` run consumed, plus the image digest ECR
// resolves for that immutable tag before the deploy. It is `null` for every other
// operation.
export function validateServiceRelease(release) {
  if (release === null || release === undefined) return null;
  if (typeof release !== 'object' || Array.isArray(release)) throw new Error('Invalid operation service release');
  const keys = Object.keys(release);
  if (!SERVICE_RELEASE_KEYS.every(key => keys.includes(key))
    || keys.some(key => ![...SERVICE_RELEASE_KEYS, 'imageDigest'].includes(key))) {
    throw new Error('Invalid operation service release fields');
  }
  matches(release.releaseTag, RELEASE_TAG, 'operation release tag');
  matches(release.serviceCommit, SHA, 'operation Service commit');
  if (release.imageDigest !== undefined) matches(release.imageDigest, DIGEST, 'operation image digest');
  return release;
}

// v4 replaces the v2/v3 `selection` block with the reviewed Service release
// identity the operation consumed (only `deploy-platform` and `restore-release`
// carry one). Historical v2/v3 records stay readable as evidence; they are not
// operation inputs.
export function createOperationRecord({ env, release = null }) {
  matches(env.GITHUB_SHA, SHA, 'operation executor source');
  if (env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Infra') throw new Error('Operation provenance unavailable');
  const stackManifest = validateStackManifest(configuredStacks.map(stack => ({ ...stack,
    source_repository: 'git-malu/AnyWear-Infra', source_sha: env.GITHUB_SHA })), 'operation record');
  const boundary = operationBoundary(env);
  return { schema_version: 4, record_type: 'anywear_infra_operation', operation: env.INFRA_OPERATION, family: boundary.family,
    executor: { repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA, workflow_path: boundary.workflow,
      run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT) },
    context: { account: env.AWS_ACCOUNT_ID, region: env.AWS_REGION, identity_phase: env.INFRA_IDENTITY_PHASE, retention_protection: env.INFRA_RETENTION_PROTECTION === 'true',
      ...(env.INFRA_OPERATION === 'deploy-egress' && env.NAT_EIP_ALLOCATION_ID
        ? { nat_eip_allocation_id: env.NAT_EIP_ALLOCATION_ID } : {}) },
    service_release: validateServiceRelease(release),
    lifecycle_implementation_origin: { repository: 'git-malu/AnyWear-Service', sha: '885b2989b0f908f050998329f5c97677cba2a242', path: '.github/scripts/beta-lifecycle.mjs' },
    stack_manifest: stackManifest, changed_stack_names: changedStackNames(env.INFRA_OPERATION), original_stack_templates: [], events: [], recovery: 'not-required', result: 'running' };
}

// Historical v2/v3 records carried a committed selection or hand-authored stack
// producers. They remain readable as evidence so an older accepted record can be
// compared instead of rejected outright.
export function readOperationRecord(value) {
  if (value?.record_type !== 'anywear_infra_operation' || ![2, 3, 4].includes(value.schema_version)) throw new Error('Unknown operation record schema');
  if ([3, 4].includes(value.schema_version)) {
    validateStackManifest(value.stack_manifest, 'operation record');
    const allowed = operationStackNames();
    if (!Array.isArray(value.changed_stack_names) || value.changed_stack_names.some(name => !allowed.includes(name))) throw new Error('Invalid changed stack names');
  }
  // Version 4 is the current shape; v2/v3 are historical evidence with their own
  // selection/provenance members and are read as recorded.
  if (value.schema_version === 4) validateServiceRelease(value.service_release ?? null);
  return value;
}

export function recordRecovery(record, outcome) {
  const transitions = { 'not-required': ['began', 'requires-explicit-recovery'], began: ['succeeded', 'failed'] };
  if (!transitions[record.recovery]?.includes(outcome)) throw new Error('Invalid recovery evidence transition');
  record.recovery = outcome;
}

export function canonicalOperationRecord(record) {
  return canonicalJson(record);
}
