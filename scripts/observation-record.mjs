// The accepted E2E deployment record has exactly one workflow producer.
// `operationBoundaries.operationBoundary` derives the family from the operation,
// so `runtime.yml` hosting both `state` and `observe` can never stamp `state` as a
// deployment record: only the `observe` operation maps to the `runtime` family.
// `scripts/deployment-contract.mjs` pins both that record type and the
// `.github/workflows/runtime.yml` path.
export const deploymentWorkflowFamily = 'runtime';
export const deploymentRecordType = 'anywear_infra_deployment';
export const familyObservationRecordType = 'anywear_infra_family_observation';

export function isDeploymentFamily(family) {
  return family === deploymentWorkflowFamily;
}

export function observationRecordType(family) {
  return isDeploymentFamily(family) ? deploymentRecordType : familyObservationRecordType;
}
