import { runtimeStackName } from '@git-malu/stage-contracts';

// One writer per environment. Infra deploys the persistent Beta Base stack and
// AnyWear-Service deploys the Runtime stack, so no Base mutation may cross a
// Runtime deployment. CloudFormation only reports a stack as terminal in these
// statuses; a missing stack is not terminal either, and every reader fails closed.
export const runtimeStack = runtimeStackName('beta');
export const terminalStackStatuses = Object.freeze(new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']));

// Issue #166: Beta run state is one fact — whether the Runtime stack exists. It
// replaced the per-stack `BetaActive` outputs and the stopped topology. A missing
// StackName is absence, not an inactive state to maintain.
export function runtimeExists(stack) {
  return stack?.StackName === runtimeStack;
}

export function assertTerminalRuntime(runtime, action) {
  if (!terminalStackStatuses.has(runtime?.StackStatus)) {
    throw new Error(`${action} requires a terminal ${runtimeStack}; observed ${runtime?.StackStatus ?? 'unavailable'}`);
  }
}

// Operations that act on deployed compute need the stack present and stable.
export function assertRuntimeReady(runtime, action) {
  if (!runtimeExists(runtime)) {
    throw new Error(`${action} requires ${runtimeStack}; start Beta first (deploy-egress, then the Service deploy)`);
  }
  assertTerminalRuntime(runtime, action);
}

// `delete-egress` is the stop path's second step: the Runtime stack must already
// be gone, or deleting Egress would strand running tasks without NAT.
export function assertRuntimeAbsent(runtime, action) {
  if (runtimeExists(runtime)) {
    throw new Error(`${action} requires ${runtimeStack} to be absent; stop the Runtime stack first`);
  }
}
