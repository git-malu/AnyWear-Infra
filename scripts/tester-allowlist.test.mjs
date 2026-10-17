import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from './json-contract.mjs';
import { normalizeTesterEmails, runTesterAllowlist } from './tester-allowlist.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';

const selector = { image: { service_sha: '1'.repeat(40), digest: `sha256:${'2'.repeat(64)}` } };
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
function ioFixture({ active = true, digest = selector.image.digest } = {}) {
  const calls = []; const events = [];
  // The tester write refuses while admission is not provably closed, and it must
  // leave the recorded decision exactly as it found it.
  const mirror = { mode: 'closed' };
  let testers = ['existing@example.com'];
  return { calls, events, async aws(args) {
    if (args[0] === 'cloudformation') return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE',
      Parameters: Object.entries({ ServiceImageDigest: digest, ServiceCommitSha: selector.image.service_sha, VlmConfigArn: "arn:aws:secretsmanager:ap-east-1:650880818323:secret:test", CloudFrontPrefixListId: "pl-test" }).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
      Outputs: Object.entries({ BetaActive: String(active), EcsClusterName: 'beta-anywear', ApiBaseUrl: 'https://example.cloudfront.net' }).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] };
    if (args[0] === 'ssm') {
      const name = args.at(-1);
      if (name.endsWith('tester_allowlist')) return { Parameter: { Name: name, Value: canonicalJson(testers) } };
      assert.equal(name, '/anywear/beta/admission_mode');
      return { Parameter: { Name: name, Value: canonicalJson(mirror) } };
    }
    return {};
  }, async verifyHealth() { calls.push(['health']); }, async oneShot(role, revision, action, payload) {
    calls.push([role, revision, action, payload]);
    // `set-testers` replaces the exact list and changes no admission state.
    if (action === 'set-testers') testers = JSON.parse(payload);
    if (action === 'status') {
      return { admission_mode: 'closed', admission_window_expires_at: null, admission_record: 'closed',
        database_record_differs: false, tester_count: testers.length, database_policy_matches_ssm: true };
    }
  }, recordAdmissionState(event) { events.push(structuredClone(event)); } };
}
test('Infra tester add merges exact emails and retains the running revision; inactive or unselected image performs no task', async () => {
  const io = ioFixture();
  await runTesterAllowlist('add', '[" NEW@example.com ", "new@example.com"]', io, selector);
  const lifecycle = io.calls.find(call => call[0] === 'lifecycle');
  assert.equal(lifecycle[2], 'set-testers');
  assert.equal(lifecycle[3], '["existing@example.com","new@example.com"]');
  for (const options of [{ active: false }, { digest: `sha256:${'3'.repeat(64)}` }]) {
    const blocked = ioFixture(options);
    await assert.rejects(runTesterAllowlist('set', '[]', blocked, selector));
    assert.equal(blocked.calls.length, 0);
  }
  await assert.rejects(runTesterAllowlist('cleanup', '[]', io, selector));
  for (const input of ['["*@example.com"]', '["@example.com"]', JSON.stringify(Array(51).fill('a@example.com'))]) assert.throws(() => normalizeTesterEmails(input));
});
test('tester operations record the admission read-back their evidence claim rests on, with admission unchanged', async () => {
  const io = ioFixture();
  await runTesterAllowlist('add', '["new@example.com"]', io, selector);
  assert.deepEqual(io.events.map(event => [event.phase, event.result]), [['original', 'observed'], ['written', 'observed']]);
  // The mirror is self-describing, so the record shows the write changed no
  // admission state: no derived expiry, no window, the same recorded decision.
  for (const event of io.events) {
    assert.equal(event.state.admission_mode, 'closed');
    assert.equal(event.state.admission_window_expires_at, null);
    assert.equal(Object.hasOwn(event, 'window_minutes'), false);
    assert.equal(Object.hasOwn(event, 'admission_window_source'), false);
    assert.equal(Object.hasOwn(event, 'lifecycle_status_sha256'), false);
  }
  assert.deepEqual(io.events[0].state.tester_emails, ['existing@example.com']);
  assert.deepEqual(io.events[1].state.tester_emails, ['existing@example.com', 'new@example.com']);
});
test('admission status publishes the effective decision, the raw record and their disagreement separately', async () => {
  const io = ioFixture();
  await runTesterAllowlist('status', '[]', io, selector);
  assert.equal(io.events.length, 1);
  const [event] = io.events;
  assert.equal(event.phase, 'status');
  // The effective decision is what every gate uses; the raw record is reported
  // beside it, so a status line cannot say "testers are admitted" about a closed
  // environment. One boolean cannot serve both jobs.
  assert.equal(event.state.admission_mode, 'closed');
  assert.equal(event.state.admission_recorded_mode, 'closed');
  assert.equal(event.effective_matches, true);
  assert.equal(event.database_record_differs, false);
  assert.equal(event.mirror_record_differs, false);
  assert.equal(event.database.admission_mode, 'closed');
  assert.equal(event.database.admission_record, 'closed');
  assert.equal(event.database.admission_window_expires_at, null);
  assert.equal(event.database.tester_count, 1);
  // A status read mutates nothing.
  assert.equal(io.calls.some(call => call[2] === 'set-testers'), false);
});
test('tester operation validates protected executor and explicit normalized payload before credentials', () => {
  const env = { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: '4'.repeat(40),
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
    AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true', INFRA_OPERATION: 'add-testers',
    INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true', SELECTION_FILE: 'selections/beta.json', SELECTION_SHA256: '5'.repeat(64), TESTER_EMAILS: '["test@example.com"]' };
  validateOperationInputs(env);
  validateOperationInputs({ ...env, TESTER_EMAILS: '[" OTHER@example.com "]', INFRA_OPERATION: 'set-testers' });
  for (const change of [{ TESTER_EMAILS: '["*@example.com"]' }, { INFRA_OPERATION: 'tester-cleanup' }, { GITHUB_SHA: 'short' },
    { INFRA_OPERATION: 'admission-status' }, { GITHUB_EVENT_NAME: 'push' }]) assert.throws(() => validateOperationInputs({ ...env, ...change }));
  validateOperationInputs({ ...env, INFRA_OPERATION: 'admission-status', TESTER_EMAILS: '[]' });
});
