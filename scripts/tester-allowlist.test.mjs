import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTesterEmails, runTesterAllowlist } from './tester-allowlist.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';
import { sha256 } from './json-contract.mjs';

const selector = { image: { service_sha: '1'.repeat(40), digest: `sha256:${'2'.repeat(64)}` } };
function ioFixture({ active = true, digest = selector.image.digest } = {}) {
  const calls = [];
  return { calls, async aws(args) {
    if (args[0] === 'cloudformation') return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE',
      Parameters: Object.entries({ ServiceImageDigest: digest, ServiceCommitSha: selector.image.service_sha, VlmConfigArn: "arn:aws:secretsmanager:ap-east-1:650880818323:secret:test", CloudFrontPrefixListId: "pl-test" }).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
      Outputs: Object.entries({ BetaActive: String(active), EcsClusterName: 'beta-anywear', ApiBaseUrl: 'https://example.cloudfront.net' }).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] };
    if (args[0] === 'ssm') return { Parameter: { Value: '["existing@example.com"]' } };
    return {};
  }, async verifyHealth() { calls.push(['health']); }, async oneShot(...args) { calls.push(args); } };
}
test('Infra tester add merges exact emails and retains the running revision; inactive or unselected image performs no task', async () => {
  const io = ioFixture();
  await runTesterAllowlist('add', '[" NEW@example.com ", "new@example.com"]', io, selector);
  assert.equal(io.calls.at(-1)[0], 'lifecycle');
  assert.equal(io.calls.at(-1)[2], 'configure-testers');
  assert.equal(io.calls.at(-1)[3], '["existing@example.com","new@example.com"]');
  for (const options of [{ active: false }, { digest: `sha256:${'3'.repeat(64)}` }]) {
    const blocked = ioFixture(options);
    await assert.rejects(runTesterAllowlist('replace', '[]', blocked, selector));
    assert.equal(blocked.calls.length, 0);
  }
  await assert.rejects(runTesterAllowlist('cleanup', '[]', io, selector));
  for (const input of ['["*@example.com"]', '["@example.com"]', JSON.stringify(Array(51).fill('a@example.com'))]) assert.throws(() => normalizeTesterEmails(input));
});
test('tester action/source/normalized payload remain bound to the explicit manager window before credentials', () => {
  const env = { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: '4'.repeat(40),
    AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_DEPLOY: 'true', INFRA_OPERATION: 'tester-add', INFRA_WINDOW_OPERATION: 'tester-add',
    INFRA_WINDOW_SHA: '4'.repeat(40), INFRA_WRITER_WINDOW: 'window-54-1', WRITER_WINDOW_INPUT: 'window-54-1', INFRA_WINDOW_EXPIRES_AT: '2099-01-01T00:00:00Z',
    INFRA_WINDOW_RECORD_URL: 'https://github.com/git-malu/AnyWear/issues/54#issuecomment-6041978451', INFRA_IDENTITY_PHASE: 'retired', IDENTITY_PHASE_INPUT: 'retired',
    INFRA_RETENTION_PROTECTION: 'true', RETENTION_PROTECTION_INPUT: 'true', SELECTION_FILE: 'selections/beta.json', SELECTION_SHA256: '5'.repeat(64), INFRA_WINDOW_SELECTION_SHA256: '5'.repeat(64),
    TESTER_EMAILS: '["test@example.com"]', INFRA_WINDOW_TESTERS_SHA256: sha256('["test@example.com"]') };
  validateOperationInputs(env);
  for (const change of [{ TESTER_EMAILS: '["other@example.com"]' }, { INFRA_OPERATION: 'tester-replace' }, { GITHUB_SHA: '6'.repeat(40) }]) assert.throws(() => validateOperationInputs({ ...env, ...change }));
});
