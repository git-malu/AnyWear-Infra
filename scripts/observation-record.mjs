// The accepted E2E deployment record has exactly one workflow producer.
// `observe-operation.mjs` derives the record type from the run's own workflow
// family, so a family observation can never be stamped as, or mistaken for, the
// runtime deployment record. `scripts/deployment-contract.mjs` pins both that
// record type and the `.github/workflows/runtime.yml` path.
export const deploymentWorkflowFamily = 'runtime';
export const deploymentRecordType = 'anywear_infra_deployment';
export const familyObservationRecordType = 'anywear_infra_family_observation';

export function isDeploymentFamily(family) {
  return family === deploymentWorkflowFamily;
}

export function observationRecordType(family) {
  return isDeploymentFamily(family) ? deploymentRecordType : familyObservationRecordType;
}
