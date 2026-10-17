import test from 'node:test';
import assert from 'node:assert/strict';
import { assertClosedAdmission, parseLifecycleStatus,
  classifyCloseKind, compareAdmissionDecision, runSuspendAdmission, runResumeAdmission
} from './admission-operation.mjs';
import { admissionClosureProof, effectiveAdmissionBound, isAdmissionClosed,
  isAdmissionProvablyClosed, resolveAdmissionDecision } from './admission-mode.mjs';
import { admissionWindowPayload } from './admission-window.mjs';
import { assertOneShotAllowed } from './operation-boundaries.mjs';
import { canonicalJson, contentHash } from './json-contract.mjs';

// The release slice is deployed by AnyWear-Service; these drivers act on the
// revision the Workload stack reports. The fixture records that revision in the
// stack parameters, so no selection or manifest participates.
const digest = `sha256:${'4'.repeat(64)}`; const serviceSha = '1'.repeat(40);
const infraSha = '5'.repeat(40);
const env = { GITHUB_SHA: infraSha, GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra',
  GITHUB_RUN_ID: '23', GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', WINDOW_MINUTES: '60', TESTER_EMAILS: '[]' };
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const FUTURE = new Date(NOW + 60 * 60_000).toISOString();
const PAST = new Date(NOW - 60 * 60_000).toISOString();
const closedRecord = { mode: 'closed' };
const windowRecord = (expires = FUTURE) => ({ mode: 'testers', expires_at: expires });
const originalTesters = ['first@example.com', 'second@example.com'];
const openMirror = windowRecord();
const closedMirror = closedRecord;
const closedState = (testers = originalTesters) => ({ admission_mode: 'closed', admission_window_expires_at: null,
  admission_mode_source: 'record', admission_mode_reason: null,
  admission_recorded_mode: 'closed', admission_recorded_expires_at: null, tester_emails: testers });
const stackOutputs = Object.assign(Object.fromEntries(['PrivateSubnetIds', 'OneShotSecurityGroupId', 'VerificationTaskRoleArn',
  'OneShotExecutionRoleArn', 'OneShotLogGroupName', 'DatabaseSecretArn', 'DatabaseHost', 'DatabasePort', 'DatabaseName', 'WardrobeBucketName']
  .map(key => [key, key])), { EcsClusterName: 'beta-anywear', BetaActive: 'true' });
const outputEntries = outputs => Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));
const guardEnv = (operation, windowMinutes) => ({ GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  INFRA_OPERATION: operation, WINDOW_MINUTES: String(windowMinutes), TESTER_EMAILS: '[]' });

// The one-shot mock is operation-scoped and runs the real reviewed guard. It keeps
// the mirror and the stored database decision separate and reports the status the
// way Service does: the effective mode plus the raw stored pair.
function mockIo(options = {}) {
  const operation = options.operation ?? 'suspend-admission';
  const windowMinutes = options.windowMinutes ?? 60;
  const calls = []; const events = [];
  const world = { mirror: structuredClone(options.mirror ?? closedMirror), testers: structuredClone(options.testers ?? originalTesters) };
  world.database = structuredClone(options.database ?? (world.mirror.mode === 'testers'
    ? { admission_mode: 'testers', admission_window_expires_at: world.mirror.expires_at }
    : { admission_mode: 'closed', admission_window_expires_at: null }));
  const now = () => options.now ?? NOW;
  const actionSet = operation === 'resume-admission' ? ['resume', 'suspend', 'status'] : ['suspend', 'status'];
  let statusReads = 0;
  const platform = { StackStatus: options.platformStatus ?? 'UPDATE_COMPLETE', Outputs: outputEntries({ ...stackOutputs, BetaActive: options.platformActive ?? 'true' }) };
  const workload = { StackStatus: options.workloadStatus ?? 'UPDATE_COMPLETE', Outputs: outputEntries({ BetaActive: options.workloadActive ?? 'true' }),
    Parameters: Object.entries({ ServiceImageDigest: options.digest ?? digest, ServiceCommitSha: options.commit ?? serviceSha,
      VlmConfigArn: 'arn:aws:ssm:ap-east-1:650880818323:parameter/beta-vlm', CloudFrontPrefixListId: 'pl-1234' })
      .map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })) };
  return { calls, events, world, operation, now, async aws(args) {
    calls.push(['aws', ...args]);
    if (args[0] === 'cloudformation') return { Stacks: [args.at(-1).includes('Platform') ? platform : workload] };
    if (args[0] === 'ssm') {
      assert.equal(args[1], 'get-parameter');
      const name = args.at(-1);
      if (name.endsWith('tester_allowlist')) return { Parameter: { Name: name, Value: JSON.stringify(world.testers) } };
      assert.equal(name, '/anywear/beta/admission_mode');
      return { Parameter: { Name: name, Value: canonicalJson(world.mirror) } };
    }
    throw new Error(`Unexpected AWS call ${args[0]} ${args[1]}`);
  }, async oneShot(role, revision, action, payload) {
    calls.push(['oneShot', role, revision, action, ...(payload === undefined ? [] : [payload])]);
    assert.equal(role, 'lifecycle');
    assert.equal(revision.digest, digest); assert.equal(revision.commit, serviceSha);
    assertOneShotAllowed(guardEnv(operation, windowMinutes), role, action, payload);
    assert.ok(actionSet.includes(action), `No drain, migration or tester configuration is permitted for ${operation}: ${action}`);
    if (action === 'resume') {
      assert.equal(operation, 'resume-admission', 'Only resume-admission may resume admission');
      assert.equal(payload, admissionWindowPayload({ WINDOW_MINUTES: String(windowMinutes) }));
      if (options.resumeError) throw options.resumeError;
      const expires = options.resumeExpiry !== undefined ? options.resumeExpiry
        : new Date(now() + (options.resumeMinutes ?? windowMinutes) * 60_000).toISOString();
      world.mirror = expires === null ? { mode: 'testers' } : { mode: 'testers', expires_at: expires };
      world.database = { admission_mode: 'testers', admission_window_expires_at: expires };
      return;
    }
    if (action === 'suspend') {
      if (options.suspendError) throw options.suspendError;
      world.mirror = closedRecord; world.database = { admission_mode: 'closed', admission_window_expires_at: null };
      options.afterSuspend?.(world);
      return;
    }
    const effective = resolveAdmissionDecision(world.database.admission_mode, world.database.admission_window_expires_at ?? null, now());
    const status = { admission_mode: effective.admission_mode,
      ...(options.omitExpiry ? {} : { admission_window_expires_at: effectiveAdmissionBound(effective) }),
      admission_record: world.database.admission_mode, database_record_differs: world.database.admission_mode !== effective.admission_mode,
      tester_count: world.testers.length, database_policy_matches_ssm: true, tasks: 3, outbox: 2 };
    const index = statusReads++;
    return options.status ? options.status(status, index) : status;
  }, recordAdmissionState(event) { events.push(structuredClone(event)); } };
}
const suspend = (io, extra = {}) => runSuspendAdmission({ io, infraSha, env, ...extra });
const resume = (io, extra = {}) => runResumeAdmission({ io, infraSha, env, ...extra });
const lifecycleActionsRun = io => io.calls.filter(call => call[0] === 'oneShot').map(call => call[3]);

test('the mode value and lifecycle status readers stay fail-closed and self-describing', () => {
  const closedDecision = resolveAdmissionDecision('closed', null, NOW);
  assert.equal(closedDecision.admission_mode, 'closed');
  assert.equal(closedDecision.admission_window_expires_at, null);
  assert.equal(isAdmissionClosed(resolveAdmissionDecision('testers', PAST, NOW)), true);
  assert.equal(isAdmissionProvablyClosed(resolveAdmissionDecision('testers', PAST, NOW)), true);
  assert.equal(admissionClosureProof(resolveAdmissionDecision('testers', FUTURE, NOW)), 'open');
  assert.equal(parseLifecycleStatus({ admission_mode: 'closed', admission_record: 'closed', database_record_differs: false,
    database_policy_matches_ssm: true, tester_count: 2 }).tester_count, 2);
  assert.throws(() => parseLifecycleStatus({ admission_mode: 'closed', admission_record: 'closed', database_record_differs: false,
    database_policy_matches_ssm: true, tester_count: -1 }), /Invalid lifecycle tester count/);
  assert.equal(classifyCloseKind({ admission_mode: 'testers', admission_record: 'testers' }), 'ordinary');
  assert.equal(classifyCloseKind({ admission_mode: 'closed', admission_record: 'testers' }), 'recovery');
  assert.equal(classifyCloseKind({ admission_mode: 'closed', admission_record: 'closed' }), 'already-closed');
  const comparison = compareAdmissionDecision({ admission_mode: 'closed', admission_record: 'closed', admission_window_expires_at: null,
    database_record_differs: false, tester_count: 2, database_policy_matches_ssm: true },
  { admission_mode: 'closed', admission_recorded_mode: 'closed', admission_window_expires_at: null, tester_emails: originalTesters }, NOW);
  assert.equal(comparison.effective_matches, true);
  assert.equal(comparison.database.tester_count, 2);
});

test('suspend ends a live window on the revision the release slice reports', async () => {
  const io = mockIo({ now: NOW, mirror: openMirror }); const result = await suspend(io);
  assert.deepEqual(result.original, { admission_mode: 'testers', admission_window_expires_at: FUTURE, admission_mode_source: 'record',
    admission_mode_reason: null, admission_recorded_mode: 'testers', admission_recorded_expires_at: FUTURE, tester_emails: originalTesters });
  assert.deepEqual(result.state, closedState());
  assert.equal(result.status.outbox, 2);
  assert.equal(result.close_kind, 'ordinary');
  assert.equal(result.prior_expires_at, FUTURE);
  assert.deepEqual(lifecycleActionsRun(io), ['status', 'suspend', 'status']);
  assert.ok(!io.calls.some(call => ['put-parameter', 'update-stack', 'update-service'].includes(call[2])));
  assert.deepEqual(io.events.map(event => [event.phase, event.result]), [['original', 'observed'], ['suspended', 'observed'], ['suspended', 'verified']]);
  for (const event of io.events.filter(event => event.phase !== 'original')) {
    assert.equal(event.close_kind, 'ordinary'); assert.equal(event.prior_expires_at, FUTURE);
  }
  assert.equal(io.events.at(-1).lifecycle_status_sha256, contentHash(result.status));
});

test('suspend classifies what it ended from the stored database pair, not from the mirror', async () => {
  const cases = [
    { options: { now: NOW, mirror: windowRecord(FUTURE) }, closeKind: 'ordinary', priorExpiresAt: FUTURE },
    { options: { now: NOW, mirror: windowRecord(PAST) }, closeKind: 'recovery', priorExpiresAt: null },
    { options: { now: NOW, mirror: closedMirror, database: { admission_mode: 'testers', admission_window_expires_at: null } },
      closeKind: 'recovery', priorExpiresAt: null },
  ];
  for (const { options, closeKind, priorExpiresAt } of cases) {
    const io = mockIo(options); const result = await suspend(io);
    assert.equal(result.close_kind, closeKind);
    assert.equal(result.prior_expires_at, priorExpiresAt);
    assert.equal(io.events.at(-1).close_kind, closeKind);
  }
  const already = mockIo({ now: NOW, mirror: closedMirror }); const alreadyResult = await suspend(already);
  assert.equal(alreadyResult.close_kind, 'already-closed');
  assert.deepEqual(lifecycleActionsRun(already), ['status', 'suspend', 'status']);
});

test('source and active-Beta mismatches prevent every suspend before any lifecycle task', async () => {
  for (const extra of [{ infraSha: '6'.repeat(40) }, { env: { ...env, GITHUB_REF: 'refs/heads/other' } },
    { env: { ...env, AWS_ACCOUNT_ID: '1' } },
    { env: { ...env, GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/integration.yml@refs/heads/main' } }]) {
    const io = mockIo(); await assert.rejects(suspend(io, extra)); assert.equal(io.calls.length, 0);
  }
  for (const options of [{ platformActive: 'false' }, { workloadActive: 'false' }, { platformActive: 'unknown' },
    { platformStatus: 'UPDATE_IN_PROGRESS' }, { workloadStatus: 'UPDATE_ROLLBACK_FAILED' }]) {
    const io = mockIo(options); await assert.rejects(suspend(io));
    assert.equal(lifecycleActionsRun(io).includes('suspend'), false, JSON.stringify(options));
    assert.equal(io.events.at(-1).phase, 'failed');
  }
});

test('failed suspend/readback never implicitly resumes or changes testers', async () => {
  const cases = [
    { suspendError: new Error('Pinned suspend failed') },
    { afterSuspend(world) { world.mirror = windowRecord(); } },
    { afterSuspend(world) { world.testers = []; } },
    { status(value) { return { ...value, database_policy_matches_ssm: false }; } },
    { status(value) { return { ...value, tester_count: 0 }; } },
    { status(value, index) { return index === 0 ? value : { ...value, admission_mode: 'testers', admission_window_expires_at: FUTURE }; } },
  ];
  for (const options of cases) {
    const io = mockIo(options); await assert.rejects(suspend(io));
    assert.equal(lifecycleActionsRun(io).includes('resume'), false, JSON.stringify(options));
    assert.equal(io.events.at(-1).phase, 'failed');
  }
});

test('resume records the requested bound, both admission phases and the status read-back', async () => {
  const io = mockIo({ operation: 'resume-admission', now: NOW, mirror: closedMirror });
  const result = await resume(io);
  assert.equal(result.window_minutes, 60);
  assert.equal(result.admission_window_expires_at, new Date(NOW + 60 * 60_000).toISOString());
  assert.equal(result.original.admission_mode, 'closed');
  assert.equal(result.state.admission_mode, 'testers');
  assert.deepEqual(lifecycleActionsRun(io), ['status', 'resume', 'status']);
  assert.equal(io.calls.filter(call => call[0] === 'oneShot').find(call => call[3] === 'resume')[4], '{"window_minutes":60}');
  assert.deepEqual(io.events.map(event => [event.phase, event.result]), [['original', 'observed'], ['resumed', 'observed'], ['verified', 'verified']]);
  assert.equal(io.events[1].window_minutes, 60);
  assert.equal(io.events.at(-1).lifecycle_status_sha256, contentHash(result.status));
  assert.ok(!io.calls.some(call => ['put-parameter', 'update-stack', 'update-service'].includes(call[2])));
});

test('a failed window suspends back to the recorded decision and names the close kind', async () => {
  const io = mockIo({ operation: 'resume-admission', now: NOW, mirror: closedMirror,
    resumeExpiry: new Date(NOW + 600 * 60_000).toISOString() });
  await assert.rejects(resume(io), /suspended back to the recorded decision/);
  assert.deepEqual(lifecycleActionsRun(io), ['status', 'resume', 'suspend']);
  assert.equal(io.events.at(-1).close_kind, 'failed-window');
});

test('a failure before the resume attempt records no recovery suspend', async () => {
  const io = mockIo({ operation: 'resume-admission', now: NOW, mirror: windowRecord(FUTURE) });
  await assert.rejects(resume(io));
  assert.equal(lifecycleActionsRun(io).includes('resume'), false);
  assert.equal(lifecycleActionsRun(io).includes('suspend'), false);
});
