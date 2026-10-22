import { changedStackNames, configuredStackNames, mutatingOperations } from './operation-stacks.mjs';

// Two runs produce the accepted E2E deployment record: `runtime.yml`'s manual
// `observe` and, since #181, the `observe` job of a `mutate.yml` deployment run.
// `operationBoundaries.operationBoundary` derives the family from the operation,
// so `runtime.yml` hosting both `state` and `observe` can never stamp `state` as a
// deployment record, and the mutation job's own evidence stays a family
// observation. `scripts/deployment-contract.mjs` pins both record types and the
// `.github/workflows/runtime.yml`/`.github/workflows/mutate.yml` producer paths.
export const deploymentWorkflowFamily = 'runtime';
export const deploymentRecordType = 'anywear_infra_deployment';
export const familyObservationRecordType = 'anywear_infra_family_observation';
// Issue #195: `deploy-runtime` produces the v5 Service deployment record itself
// instead of a separate accepted `anywear_infra_deployment` observation.
export const serviceDeploymentRecordType = 'anywear_service_deployment';

export function serviceDeploymentRequired(operation) {
  return operation === 'deploy-runtime';
}

export function isDeploymentFamily(family) {
  return family === deploymentWorkflowFamily;
}

export function observationRecordType(family) {
  return isDeploymentFamily(family) ? deploymentRecordType : familyObservationRecordType;
}

// The trigger set is derived from the two frozen stack tables, not restated as a
// list of operation names: an operation requires the accepted record exactly when
// it changes at least one stack the accepted record lists, plus the manual
// `observe` producer itself (#181). `deploy-egress`/`delete-egress`,
// `deploy-runtime`/`stop-runtime` change only operation-owned stacks, so a
// correctly executed operation is never marked incomplete; `deploy-runtime`
// writes its own v5 record instead (see `serviceDeploymentRequired`).
export function acceptedObservationRequired(operation) {
  return operation === 'observe'
    || changedStackNames(operation).some(name => configuredStackNames().includes(name));
}

// Exactly the operations whose runs must produce the accepted record, derived in
// the change table's order with the manual producer last.
export const acceptedObservationOperations = Object.freeze(
  [...new Set([...mutatingOperations, 'observe'])].filter(acceptedObservationRequired));

// `deploy-foundation` and `deploy-billing` run before M4 (the `api_base_url`
// publication), so their authenticated observation may record the published
// subset of the stage-contract surface. Every other producer keeps the strict
// 0.3.0 surface: a Base or restore record fails rather than record a partial one.
export const preM4Operations = Object.freeze(['deploy-foundation', 'deploy-billing']);

export function unpublishedStageInputs(operation) {
  return preM4Operations.includes(operation) ? ['api_base_url'] : [];
}

// One record envelope for both producers: the accepted deployment record and the
// mutation job's family observation share the producer block and the observation
// body, and differ only in `record_type`.
export function buildDeploymentRecord(env, body, workflowPath, recordType = deploymentRecordType) {
  if (typeof workflowPath !== 'string' || !workflowPath.startsWith('.github/workflows/')) {
    throw new Error('Deployment record workflow path required');
  }
  return {
    schema_version: 3,
    record_type: recordType,
    producer: {
      repository: env.GITHUB_REPOSITORY,
      sha: env.GITHUB_SHA,
      workflow_path: workflowPath,
      workflow_ref: env.GITHUB_WORKFLOW_REF,
      run_id: Number(env.GITHUB_RUN_ID),
      run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
    },
    ...body,
  };
}
