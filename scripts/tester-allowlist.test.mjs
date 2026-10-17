import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTesterEmails, runTesterAllowlist } from './tester-allowlist.mjs';
import { WINDOW_MINUTES_DEFAULT } from './admission-window.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';

const selector = { image: { service_sha: '1'.repeat(40), digest: `sha256:${'2'.repeat(64)}` } };
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
function ioFixture({ active = true, digest = selector.image.digest } = {}) {
  const calls = []; const events = [];
  let suspended = true;
  return { calls, events, now: () => NOW, async aws(args) {
    if (args[0] === 'cloudformation') return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE',
      Parameters: Object.entries({ ServiceImageDigest: digest, ServiceCommitSha: selector.image.service_sha, VlmConfigArn: "arn:aws:secretsmanager:ap-east-1:650880818323:secret:test", CloudFrontPrefixListId: "pl-test" }).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
      Outputs: Object.entries({ BetaActive: String(active), EcsClusterName: 'beta-anywear', ApiBaseUrl: 'https://example.cloudfront.net' }).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] };
    if (args[0] === 'ssm') {
      const name = args.at(-1);
      const value = name.endsWith('tester_allowlist') ? '["existing@example.com"]'
        : name.endsWith('admission_suspended') ? String(suspended) : 'false';
      return { Parameter: { Name: name, Value: value } };
    }
    return {};
  }, async verifyHealth() { calls.push(['health']); }, async oneShot(role, revision, action, payload) {
    calls.push([role, revision, action, payload]);
    // `configure-testers` closes, writes the tester list and opens with the
    // Service's documented default bound, so the mirror reads unsuspended after.
    if (action === 'configure-testers') suspended = false;
  }, recordAdmissionState(event) { events.push(structuredClone(event)); } };
}
test('Infra tester add merges exact emails and retains the running revision; inactive or unselected image performs no task', async () => {
  const io = ioFixture();
  await runTesterAllowlist('add', '[" NEW@example.com ", "new@example.com"]', io, selector);
  const lifecycle = io.calls.find(call => call[0] === 'lifecycle');
  assert.equal(lifecycle[2], 'configure-testers');
  assert.equal(lifecycle[3], '["existing@example.com","new@example.com"]');
  for (const options of [{ active: false }, { digest: `sha256:${'3'.repeat(64)}` }]) {
    const blocked = ioFixture(options);
    await assert.rejects(runTesterAllowlist('replace', '[]', blocked, selector));
    assert.equal(blocked.calls.length, 0);
  }
  await assert.rejects(runTesterAllowlist('cleanup', '[]', io, selector));
  for (const input of ['["*@example.com"]', '["@example.com"]', JSON.stringify(Array(51).fill('a@example.com'))]) assert.throws(() => normalizeTesterEmails(input));
});
test('tester operations record the admission read-back their evidence claim rests on, with the derived default bound', async () => {
  const io = ioFixture();
  await runTesterAllowlist('add', '["new@example.com"]', io, selector);
  assert.deepEqual(io.events.map(event => [event.phase, event.result]), [['original', 'observed'], ['opened', 'observed']]);
  assert.deepEqual(io.events[0].state, { admission_suspended: true, intake_open: false, tester_emails: ['existing@example.com'] });
  assert.equal(io.events[1].state.admission_suspended, false);
  // `configure-testers` opens with the Service default; the tester operations may
  // not run `status`, so the expiry is recorded as derived, never as observed.
  assert.equal(io.events[1].window_minutes, WINDOW_MINUTES_DEFAULT);
  assert.equal(io.events[1].admission_window_expires_at, new Date(NOW + WINDOW_MINUTES_DEFAULT * 60_000).toISOString());
  assert.match(io.events[1].admission_window_source, /derived from the documented Service default/);
  assert.equal(Object.hasOwn(io.events[1], 'lifecycle_status_sha256'), false);
  // A status read mutates nothing, so it records no admission phase.
  const status = ioFixture();
  await runTesterAllowlist('status', '[]', status, selector);
  assert.deepEqual(status.events, []);
});
test('tester operation validates protected executor and explicit normalized payload before credentials', () => {
  const env = { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: '4'.repeat(40),
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/beta-admission.yml@refs/heads/main',
    AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_DEPLOY: 'true', INFRA_OPERATION: 'tester-add',
    INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true', SELECTION_FILE: 'selections/beta.json', SELECTION_SHA256: '5'.repeat(64), TESTER_EMAILS: '["test@example.com"]' };
  validateOperationInputs(env);
  validateOperationInputs({ ...env, TESTER_EMAILS: '[" OTHER@example.com "]', INFRA_OPERATION: 'tester-replace' });
  for (const change of [{ TESTER_EMAILS: '["*@example.com"]' }, { INFRA_OPERATION: 'tester-cleanup' }, { GITHUB_SHA: 'short' },
    { INFRA_OPERATION: 'tester-status' }, { GITHUB_EVENT_NAME: 'push' }]) assert.throws(() => validateOperationInputs({ ...env, ...change }));
  validateOperationInputs({ ...env, INFRA_OPERATION: 'tester-status', TESTER_EMAILS: '[]' });
});
