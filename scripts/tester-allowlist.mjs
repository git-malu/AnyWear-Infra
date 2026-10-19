import { parseJson, canonicalJson } from './json-contract.mjs';
import { workloadRevision } from './workload-revision.mjs';
import { normalizeTesterEmails, observeAdmissionState } from './admission-state.mjs';
import { compareAdmissionDecision, parseLifecycleStatus } from './admission-operation.mjs';
import { runtimeStack, assertRuntimeReady } from './one-writer.mjs';

export { normalizeTesterEmails } from './admission-state.mjs';

// A tester write is a tester write: it replaces the exact list and changes no
// admission state. Only `open-admission` is an operator-requestable opener, so the
// operator flow is `add-testers` (or `set-testers`) and then `open-admission`. The
// admission mirror is still read before and after the deployed lifecycle command,
// because the operation record claims that read-back as its evidence and the
// mirror carries the mode and its recorded key set, which prove the write changed
// nothing. Tester operations act on the revision the release slice reports; they
// never select or re-verify a Service release.
export async function runTesterAllowlist(action, input, io) {
  if (!['status', 'add', 'set'].includes(action)) throw new Error('Unknown Infra tester action');
  let payload = normalizeTesterEmails(input);
  if (action === 'status' && payload !== '[]') throw new Error('Status does not accept emails');
  const platform = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearPlatformStack-beta'])).Stacks?.[0];
  const runtime = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', runtimeStack])).Stacks?.[0];
  const stable = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE']);
  if (!stable.has(platform?.StackStatus)) throw new Error('Stable Beta Base stack required');
  // Issue #166: Beta runs only when the Runtime stack exists; there is no
  // `BetaActive` output any more. The tester operations act on the revision that
  // stack reports.
  assertRuntimeReady(runtime, 'Tester operations');
  const values = stack => Object.fromEntries((stack.Outputs ?? []).map(row => [row.OutputKey, row.OutputValue]));
  const outputs = values(platform); const publicOutputs = values(runtime);
  if (outputs.EcsClusterName !== 'beta-anywear') throw new Error('Running Beta Base cluster required for tester operations');
  // The public API endpoint is now the Base distribution's published URL; the
  // Runtime output is the pre-split fallback while the Service stack still owns
  // the distribution.
  const apiBaseUrl = outputs.ApiBaseUrl ?? publicOutputs.ApiBaseUrl;
  if (typeof apiBaseUrl !== 'string' || !apiBaseUrl) throw new Error('Public API endpoint unavailable for tester operations');
  const revision = workloadRevision(runtime);
  await io.aws(['ecs', 'wait', 'services-stable', '--cluster', 'beta-anywear', '--services', 'beta-anywear-api', 'beta-anywear-worker']);
  // The public endpoint must answer for the revision the slice reports before any
  // admission write.
  await io.verifyHealth(apiBaseUrl, revision);
  if (action === 'add') {
    const existing = (await io.aws(['ssm', 'get-parameter', '--name', '/anywear/beta/tester_allowlist'])).Parameter?.Value;
    payload = normalizeTesterEmails(canonicalJson([...parseJson(normalizeTesterEmails(existing)), ...parseJson(payload)]));
  }
  if (action === 'status') {
    // `admission-status` publishes the effective decision, the raw record each
    // surface stores and whether those raw records disagree. One boolean cannot
    // carry both jobs, and there is no bound to report.
    const status = parseLifecycleStatus(await io.oneShot('lifecycle', revision, 'status'));
    const observed = await observeAdmissionState(io);
    const comparison = compareAdmissionDecision(status, observed.state, io.now?.() ?? Date.now());
    io.recordAdmissionState?.({ phase: 'status', state: observed.state, result: observed.result, ...comparison });
    return;
  }
  // The operation record claims this admission read-back, so take it before and
  // after the deployed command instead of asserting the claim the record exists to
  // prove. The mirror is self-describing: the mode and its recorded key set are
  // both here, so the record shows the write left admission exactly as it found it.
  const original = await observeAdmissionState(io);
  io.recordAdmissionState?.({ phase: 'original', state: original.state, result: original.result });
  // The deployed Service `set-testers` command owns the tester list and refuses
  // while admission is not provably closed. It changes no admission state.
  await io.oneShot('lifecycle', revision, 'set-testers', payload);
  const written = await observeAdmissionState(io);
  io.recordAdmissionState?.({ phase: 'written', state: written.state, result: written.result });
}
