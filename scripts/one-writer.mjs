// One writer per environment. Infra deploys the Beta stage base and AnyWear-Service
// deploys the release slice, so no Platform mutation may cross a release-slice
// deployment. CloudFormation only reports a stack as terminal in these statuses;
// a missing stack is not terminal either, and every reader fails closed on it.
export const releaseSliceStackName = 'AnyWearWorkloadStack-beta';
export const terminalStackStatuses = Object.freeze(new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']));

// Shared by `deploy-platform` and `restore-release`: read the Service-owned stack
// and refuse unless it is terminal. This is a read-only precondition, not a claim
// to deploy, verify or recover the slice's resources.
export function assertTerminalReleaseSlice(workload, action) {
  if (!terminalStackStatuses.has(workload?.StackStatus)) {
    throw new Error(`${action} requires a terminal ${releaseSliceStackName}; observed ${workload?.StackStatus ?? 'unavailable'}`);
  }
}
