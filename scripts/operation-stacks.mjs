const stackChanges = Object.freeze({
  'deploy-foundation': ['AnyWearFoundationStack'],
  'deploy-billing': ['AnyWearBillingStack-beta'],
  'deploy-platform': ['AnyWearPlatformStack-beta'],
  // Issue #166: Egress is the disposable network edge. It exists only while
  // Beta runs, so it is an operation-owned stack, not part of the always-present
  // configured manifest below.
  'deploy-egress': ['AnyWearEgressStack-beta'],
  'delete-egress': ['AnyWearEgressStack-beta'],
  // Issue #195: the release slice is deployed and stopped by Infra with the same
  // restricted mutations entry. Both operations change only the Runtime stack.
  'deploy-runtime': ['AnyWearRuntimeStack-beta'],
  'stop-runtime': ['AnyWearRuntimeStack-beta'],
  // Release recovery restores the persistent Base stack only.
  'restore-release': ['AnyWearPlatformStack-beta'],
});

// One authoritative table for the configured stack set. Operation records,
// deployment records, observation and provenance validation all read this instead
// of repeating stack names, regions and count assertions locally. It is exactly
// the stack set this repository always produces: Foundation, the Beta Base
// stack and Billing. `AnyWearRuntimeStack-beta` and `AnyWearEgressStack-beta`
// exist only while the environment runs.
export const configuredStacks = Object.freeze([
  Object.freeze({ stack_name: 'AnyWearFoundationStack', region: 'ap-east-1' }),
  Object.freeze({ stack_name: 'AnyWearPlatformStack-beta', region: 'ap-east-1' }),
  Object.freeze({ stack_name: 'AnyWearBillingStack-beta', region: 'us-east-1' }),
]);

// Stacks an operation may change without being part of the always-present
// manifest. A record's `changed_stack_names` may name these; its
// `stack_manifest` stays exactly the configured set.
export const operationOwnedStacks = Object.freeze([
  Object.freeze({ stack_name: 'AnyWearEgressStack-beta', region: 'ap-east-1' }),
  Object.freeze({ stack_name: 'AnyWearRuntimeStack-beta', region: 'ap-east-1' }),
]);

// Every operation with a row in the frozen change table. It is exported rather
// than restated so the accepted-observation trigger set (#181) is derived from the
// same table that scopes deployment authority.
export const mutatingOperations = Object.freeze(Object.keys(stackChanges));

export function configuredStackNames() {
  return configuredStacks.map(stack => stack.stack_name);
}

export function operationStackNames() {
  return [...configuredStacks, ...operationOwnedStacks].map(stack => stack.stack_name);
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
