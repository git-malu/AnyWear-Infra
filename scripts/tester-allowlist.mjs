import { parseJson, canonicalJson } from './json-contract.mjs';
import { workloadRevision } from '../.github/scripts/beta-lifecycle.mjs';
import { normalizeTesterEmails, observeAdmissionState } from './admission-state.mjs';
import { WINDOW_MINUTES_DEFAULT } from './admission-window.mjs';

export { normalizeTesterEmails } from './admission-state.mjs';

// `configure-testers` opens admission with the documented Service default bound.
// The tester operations keep the single `configure-testers` lifecycle action and
// may still not run `open` or `status`, so that expiry is not directly
// observable: it is derived here and labelled as derived rather than recorded as
// a read-back the run never made.
function defaultWindowExpiry(openedAt) {
  return new Date(openedAt + WINDOW_MINUTES_DEFAULT * 60_000).toISOString();
}

export async function runTesterAllowlist(action, input, io, selector) {
  if (!['status', 'add', 'replace'].includes(action)) throw new Error('Unknown Infra tester action');
  let payload = normalizeTesterEmails(input);
  if (action === 'status' && payload !== '[]') throw new Error('Status does not accept emails');
  const platform = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearPlatformStack-beta'])).Stacks?.[0];
  const workload = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearWorkloadStack-beta'])).Stacks?.[0];
  const stable = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE']);
  if (!stable.has(platform?.StackStatus) || !stable.has(workload?.StackStatus)) throw new Error('Stable Beta stacks required');
  const values = stack => Object.fromEntries((stack.Outputs ?? []).map(row => [row.OutputKey, row.OutputValue]));
  const outputs = values(platform); const publicOutputs = values(workload);
  if (outputs.BetaActive !== 'true' || publicOutputs.BetaActive !== 'true' || outputs.EcsClusterName !== 'beta-anywear') throw new Error('Active Beta required for tester operations');
  const revision = workloadRevision(workload);
  if (revision.commit !== selector.image.service_sha || revision.digest !== selector.image.digest) throw new Error('Tester operation must retain the deployed selected image');
  await io.aws(['ecs', 'wait', 'services-stable', '--cluster', 'beta-anywear', '--services', 'beta-anywear-api', 'beta-anywear-worker']);
  await io.verifyHealth(publicOutputs.ApiBaseUrl, revision);
  await io.oneShot('verify', revision, publicOutputs.ApiBaseUrl);
  if (action === 'add') {
    const existing = (await io.aws(['ssm', 'get-parameter', '--name', '/anywear/beta/tester_allowlist'])).Parameter?.Value;
    payload = normalizeTesterEmails(canonicalJson([...parseJson(normalizeTesterEmails(existing)), ...parseJson(payload)]));
  }
  // `configure-testers` changes admission, and the operation record claims that
  // admission read-back evidences it. Record the tuple before and after the
  // selected command instead of asserting the claim the record exists to prove.
  const mutating = action !== 'status';
  const original = mutating ? await observeAdmissionState(io) : undefined;
  if (original) io.recordAdmissionState?.({ phase: 'original', state: original.state, result: original.result });
  // Timestamped before the one-shot, so the derived expiry can only understate
  // the window the Service records, never overstate it.
  const openedAt = io.now?.() ?? Date.now();
  // The selected Service command owns DB/SSM admission reconciliation and rejects
  // public intake. Its close/configure/open behavior belongs to Infra runtime.
  await io.oneShot('lifecycle', revision, action === 'status' ? 'status' : 'configure-testers', action === 'status' ? undefined : payload);
  if (mutating) {
    const opened = await observeAdmissionState(io);
    io.recordAdmissionState?.({ phase: 'opened', state: opened.state, result: opened.result,
      window_minutes: WINDOW_MINUTES_DEFAULT,
      admission_window_expires_at: defaultWindowExpiry(openedAt),
      admission_window_source: 'derived from the documented Service default for configure-testers; not observed' });
  }
}
