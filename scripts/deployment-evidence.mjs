// The evidence layout of one Infra run's `deployment-evidence/` directory. The
// producers write the paths below; the `record` job downloads each artifact into
// its own subdirectory, so the accepted record and the mutation job's family
// observation can never share a file name (#181).
export const evidenceDirectory = 'deployment-evidence';
// The producer's own output: the accepted record from `mutate.yml`'s `observe`
// job or the manual `observe`, and the mutation job's family observation.
export const deploymentRecordPath = `${evidenceDirectory}/deployment-record.json`;
// The `record` job's downloaded inputs.
export const acceptedRecordPath = `${evidenceDirectory}/accepted/deployment-record.json`;
export const familyRecordPath = `${evidenceDirectory}/family/deployment-record.json`;
export const operationRecordPath = `${evidenceDirectory}/operation-record.json`;
