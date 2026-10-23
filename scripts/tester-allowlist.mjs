import { parseJson, canonicalJson } from './json-contract.mjs';
import { workloadRevision } from './workload-revision.mjs';
import { normalizeTesterEmails, observeAdmissionState } from './admission-state.mjs';
import { compareAdmissionDecision, parseLifecycleStatus } from './admission-operation.mjs';
import { runtimeStack, assertRuntimeReady, describeStack } from './one-writer.mjs';

export { normalizeTesterEmails } from './admission-state.mjs';

// A tester write is a tester write: it replaces the exact list and changes no
// admission state. Only `open-admission` is an operator-requestable opener, so the
// operator flow is `add-testers` (or `set-testers`) and then `open-admission`. The
// admission mirror is still read before and after the deployed lifecycle command,
// and the two redacted snapshots are printed to the step log, because the mirror
// carries the mode and its recorded key set, which prove the write changed
// nothing. Tester operations act on the revision the release slice reports; they
// never select or re-verify a Service release.
export async function runTesterAllowlist(action, input, io) {
  if (!['status', 'add', 'set'].includes(action)) throw new Error('Unknown Infra tester action');
  let payload = normalizeTesterEmails(input);
  if (action === 'status' && payload !== '[]') throw new Error('Status does not accept emails');
  const platform = await describeStack(io, 'AnyWearPlatformStack-beta');
  const runtime = await describeStack(io, runtimeStack);
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
    // carry both jobs, and there is no bound to report. The line is redacted: it
    // carries the mode, the recorded key set and a count, never addresses.
    const status = parseLifecycleStatus(await io.oneShot('lifecycle', revision, 'status'));
    const observed = await observeAdmissionState(io);
    const comparison = compareAdmissionDecision(status, observed.state, io.now?.() ?? Date.now());
    process.stdout.write(`${JSON.stringify({ operation: 'admission-status', ...comparison,
      mirror: { admission_mode: observed.state.admission_mode,
        admission_recorded_mode: observed.state.admission_recorded_mode,
        admission_recorded_keys: observed.state.admission_recorded_keys,
        tester_count: Array.isArray(observed.state.tester_emails) ? observed.state.tester_emails.length : 'unavailable' } })}\n`);
    return;
  }
  const summary = state => ({ admission_mode: state.admission_mode,
    admission_recorded_mode: state.admission_recorded_mode,
    admission_recorded_keys: state.admission_recorded_keys,
    tester_count: Array.isArray(state.tester_emails) ? state.tester_emails.length : 'unavailable' });
  // Take the admission read-back before and after the deployed command, so the
  // step log shows the write left admission exactly as it found it. The mirror is
  // self-describing: the mode and its recorded key set are both here.
  const original = await observeAdmissionState(io);
  // The deployed Service `set-testers` command owns the tester list and refuses
  // while admission is not provably closed. It changes no admission state.
  await io.oneShot('lifecycle', revision, 'set-testers', payload);
  const written = await observeAdmissionState(io);
  process.stdout.write(`${JSON.stringify({ operation: `${action}-testers`,
    before: summary(original.state), after: summary(written.state) })}\n`);
}
