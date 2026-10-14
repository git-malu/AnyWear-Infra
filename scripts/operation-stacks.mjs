const stackChanges = Object.freeze({
  'deploy-foundation': ['AnyWearFoundationStack'],
  'deploy-billing': ['AnyWearBillingStack-beta'],
  'deploy-platform': ['AnyWearPlatformStack-beta'],
  'deploy-workload': ['AnyWearWorkloadStack-beta'],
  'restore-release': ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta'],
  start: ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta'],
  stop: ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta'],
});

// One authoritative table for the configured stack set. Operation records,
// observation and provenance validation all read this instead of repeating
// stack names, regions and count assertions locally.
export const configuredStacks = Object.freeze([
  Object.freeze({ stack_name: 'AnyWearFoundationStack', region: 'ap-east-1' }),
  Object.freeze({ stack_name: 'AnyWearPlatformStack-beta', region: 'ap-east-1' }),
  Object.freeze({ stack_name: 'AnyWearWorkloadStack-beta', region: 'ap-east-1' }),
  Object.freeze({ stack_name: 'AnyWearBillingStack-beta', region: 'us-east-1' }),
]);

export function configuredStackNames() {
  return configuredStacks.map(stack => stack.stack_name);
}

export function configuredStack(stackName) {
  return configuredStacks.find(stack => stack.stack_name === stackName);
}

export function changedStackNames(operation) {
  return [...(stackChanges[operation] ?? [])];
}

// The validated all-stack manifest is defined by the configured set, never by
// the operation's changed-stack subset.
export function validateStackManifest(rows, label) {
  if (!Array.isArray(rows) || rows.length !== configuredStacks.length) throw new Error(`Every configured stack required in ${label}`);
  const names = new Set();
  for (const row of rows) {
    const configured = configuredStack(row?.stack_name);
    if (!configured || names.has(row.stack_name) || row.region !== configured.region) throw new Error(`Invalid stack identity in ${label}`);
    names.add(row.stack_name);
  }
  return rows;
}
