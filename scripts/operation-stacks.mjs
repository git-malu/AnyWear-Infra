const stackChanges = Object.freeze({
  'deploy-foundation': ['AnyWearFoundationStack'],
  'deploy-billing': ['AnyWearBillingStack-beta'],
  'deploy-platform': ['AnyWearPlatformStack-beta'],
  'deploy-workload': ['AnyWearWorkloadStack-beta'],
  'restore-release': ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta'],
  start: ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta'],
  stop: ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta'],
});

export function changedStackNames(operation) {
  return [...(stackChanges[operation] ?? [])];
}
