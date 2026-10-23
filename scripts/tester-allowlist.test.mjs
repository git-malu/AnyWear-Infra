import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from './json-contract.mjs';
import { normalizeTesterEmails, runTesterAllowlist } from './tester-allowlist.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';
import { runtimeStack } from './one-writer.mjs';

const selector = { image: { service_sha: '1'.repeat(40), digest: `sha256:${'2'.repeat(64)}` } };
function ioFixture({ runtimeStatus = 'UPDATE_COMPLETE', digest = selector.image.digest } = {}) {
  const calls = [];
  // The tester write refuses while admission is not provably closed, and it must
  // leave the recorded decision exactly as it found it.
  const mirror = { mode: 'closed' };
  let testers = ['existing@example.com'];
  // Issue #166: the Base stack publishes the public API URL; the Runtime stack
  // exists while Beta runs and reports the pinned revision.
  const platform = { StackName: 'AnyWearPlatformStack-beta', StackStatus: 'UPDATE_COMPLETE',
    Outputs: Object.entries({ EcsClusterName: 'beta-anywear', ApiBaseUrl: 'https://example.cloudfront.net' })
      .map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
  const runtime = runtimeStatus === null ? undefined : { StackName: runtimeStack, StackStatus: runtimeStatus,
    Parameters: Object.entries({ ServiceImageDigest: digest, ServiceCommitSha: selector.image.service_sha,
      VlmConfigArn: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:test', CloudFrontPrefixListId: 'pl-test' })
      .map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
    Outputs: Object.entries({ ApiBaseUrl: 'https://example.cloudfront.net' })
      .map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
  const stacks = new Map([['AnyWearPlatformStack-beta', platform], [runtimeStack, runtime]]);
  return { calls, async aws(args) {
    if (args[0] === 'cloudformation') {
      const name = args.at(-1);
      const stack = stacks.get(name);
      if (!stack) {
        const stderr = `aws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${name} does not exist`;
        throw Object.assign(new Error(stderr), { stderr });
      }
      return { Stacks: [stack] };
    }
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
      return { admission_mode: 'closed', admission_record: 'closed',
        database_record_differs: false, tester_count: testers.length, database_policy_matches_ssm: true };
    }
  } };
}
// The run's evidence is its printed line, not a record. Capture stdout for the
// duration of one driver call so a test can assert exactly what an operator sees.
async function captureStdout(run) {
  const lines = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
  try { return { value: await run(), lines }; }
  finally { process.stdout.write = original; }
}
test('Infra tester add merges exact emails on the revision the Runtime stack reports; a non-running Runtime performs no task', async () => {
  const io = ioFixture();
  await runTesterAllowlist('add', '[" NEW@example.com ", "new@example.com"]', io);
  const lifecycle = io.calls.find(call => call[0] === 'lifecycle');
  assert.equal(lifecycle[2], 'set-testers');
  assert.equal(lifecycle[3], '["existing@example.com","new@example.com"]');
  for (const options of [{ runtimeStatus: null }, { runtimeStatus: 'UPDATE_IN_PROGRESS' }]) {
    const blocked = ioFixture(options);
    await assert.rejects(runTesterAllowlist('set', '[]', blocked));
    assert.ok(!blocked.calls.some(call => call[0] === 'lifecycle' || call[0] === 'health'), JSON.stringify(options));
  }
  await assert.rejects(runTesterAllowlist('cleanup', '[]', io));
  for (const input of ['["*@example.com"]', '["@example.com"]', JSON.stringify(Array(51).fill('a@example.com'))]) assert.throws(() => normalizeTesterEmails(input));
});
test('tester operations print the admission read-back their evidence rests on, with admission unchanged', async () => {
  const io = ioFixture();
  const { lines } = await captureStdout(() => runTesterAllowlist('add', '["new@example.com"]', io));
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]);
  assert.equal(line.operation, 'add-testers');
  // The mirror is self-describing, so the two snapshots show the write changed the
  // tester list but no admission state: the same mode, the same recorded key set,
  // no reportable bound. The line is redacted and never names an address.
  const keys = ['admission_mode', 'admission_recorded_mode', 'admission_recorded_keys', 'tester_count'];
  for (const snapshot of [line.before, line.after]) {
    assert.deepEqual(Object.keys(snapshot).sort(), [...keys].sort());
    assert.equal(snapshot.admission_mode, 'closed');
    assert.equal(snapshot.admission_recorded_mode, 'closed');
    assert.deepEqual(snapshot.admission_recorded_keys, ['mode']);
    assert.equal(Object.hasOwn(snapshot, 'admission_window_expires_at'), false);
    assert.equal(Object.hasOwn(snapshot, 'lifecycle_status_sha256'), false);
  }
  assert.equal(line.before.tester_count, 1);
  assert.equal(line.after.tester_count, 2);
  assert.equal(/@example\.com/.test(lines[0]), false, 'the printed line never carries tester addresses');
});
test('admission status publishes the effective decision, the raw record and their disagreement separately', async () => {
  const io = ioFixture();
  const { lines } = await captureStdout(() => runTesterAllowlist('status', '[]', io, selector));
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.operation, 'admission-status');
  // The effective decision is what every gate uses; the raw record is reported
  // beside it, so a status line cannot say "testers are admitted" about a closed
  // environment. One boolean cannot serve both jobs.
  assert.equal(event.mirror.admission_mode, 'closed');
  assert.equal(event.mirror.admission_recorded_mode, 'closed');
  assert.deepEqual(event.mirror.admission_recorded_keys, ['mode']);
  assert.equal(event.effective_matches, true);
  assert.equal(event.database_record_differs, false);
  assert.equal(event.mirror_record_differs, false);
  assert.equal(event.database.admission_mode, 'closed');
  assert.equal(event.database.admission_record, 'closed');
  assert.equal(Object.hasOwn(event.database, 'admission_window_expires_at'), false);
  assert.equal(event.database.tester_count, 1);
  assert.equal(/@example\.com/.test(lines[0]), false, 'the status line never carries tester addresses');
  // A status read mutates nothing.
  assert.equal(io.calls.some(call => call[2] === 'set-testers'), false);
});
test('tester operation validates protected executor and explicit normalized payload before credentials', () => {
  const env = { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: '4'.repeat(40),
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
    AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true', INFRA_OPERATION: 'add-testers',
    INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true', TESTER_EMAILS: '["test@example.com"]' };
  validateOperationInputs(env);
  validateOperationInputs({ ...env, TESTER_EMAILS: '[" OTHER@example.com "]', INFRA_OPERATION: 'set-testers' });
  for (const change of [{ TESTER_EMAILS: '["*@example.com"]' }, { INFRA_OPERATION: 'tester-cleanup' }, { GITHUB_SHA: 'short' },
    { INFRA_OPERATION: 'admission-status' }, { GITHUB_EVENT_NAME: 'push' }]) assert.throws(() => validateOperationInputs({ ...env, ...change }));
  validateOperationInputs({ ...env, INFRA_OPERATION: 'admission-status', TESTER_EMAILS: '[]' });
});
