import { parseJson, canonicalJson } from './json-contract.mjs';
import { workloadRevision } from '../.github/scripts/beta-lifecycle.mjs';

export function normalizeTesterEmails(bytes) {
  const emails = parseJson(bytes);
  if (!Array.isArray(emails) || emails.length > 50 || emails.some(email => typeof email !== 'string')) throw new Error('At most 50 exact tester emails required');
  const normalized = [...new Set(emails.map(email => email.trim().toLowerCase()))].sort();
  if (normalized.some(email => email.length > 254 || email.includes('*') || !/^[a-z0-9.!#$%&'+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email))) throw new Error('Exact tester email required');
  const payload = canonicalJson(normalized);
  if (Buffer.byteLength(payload) > 4096) throw new Error('Tester list exceeds SSM capacity');
  return payload;
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
  // The selected Service command owns DB/SSM admission reconciliation and rejects
  // public intake. Its close/configure/open behavior belongs to Infra runtime.
  await io.oneShot('lifecycle', revision, action === 'status' ? 'status' : 'configure-testers', action === 'status' ? undefined : payload);
}
