import test from 'node:test';
import assert from 'node:assert/strict';
import { assertClosedAdmission, parseLifecycleStatus,
  classifyCloseKind, compareAdmissionDecision, lifecycleStatusReportsExpiry, runCloseAdmission, runOpenAdmission
} from './admission-operation.mjs';
import { admissionClosureProof, isAdmissionClosed,
  isAdmissionProvablyClosed, parseAdmissionModeValue, resolveAdmissionDecision } from './admission-mode.mjs';
import { assertOneShotAllowed } from './operation-boundaries.mjs';
import { createRuntimeIo } from './runtime-operation.mjs';
import { canonicalJson, contentHash, sha256 } from './json-contract.mjs';
import { runtimeStack } from './one-writer.mjs';

// The release slice is deployed by AnyWear-Service; these drivers act on the
// revision the Workload stack reports. The fixture records that revision in the
// stack parameters, so no selection or manifest participates.
const digest = `sha256:${'4'.repeat(64)}`; const serviceSha = '1'.repeat(40);
const infraSha = '5'.repeat(40);
const env = { GITHUB_SHA: infraSha, GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra',
  GITHUB_RUN_ID: '23', GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', TESTER_EMAILS: '[]' };
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const closedRecord = { mode: 'closed' };
const openRecord = { mode: 'testers' };
// The removed legacy record: a second key that the strict reader must refuse.
const legacyRecord = { mode: 'testers', expires_at: '2099-01-01T00:00:00.000Z' };
const originalTesters = ['first@example.com', 'second@example.com'];
const closedState = (testers = originalTesters) => ({ admission_mode: 'closed', admission_mode_source: 'record',
  admission_mode_reason: null, admission_recorded_mode: 'closed', admission_recorded_keys: ['mode'], tester_emails: testers });
const openState = (testers = originalTesters) => ({ admission_mode: 'testers', admission_mode_source: 'record',
  admission_mode_reason: null, admission_recorded_mode: 'testers', admission_recorded_keys: ['mode'], tester_emails: testers });
const stackOutputs = Object.assign(Object.fromEntries(['PrivateSubnetIds', 'OneShotSecurityGroupId', 'VerificationTaskRoleArn',
  'OneShotExecutionRoleArn', 'OneShotLogGroupName', 'DatabaseSecretArn', 'DatabaseHost', 'DatabasePort', 'DatabaseName', 'WardrobeBucketName']
  .map(key => [key, key])), { EcsClusterName: 'beta-anywear' });
const outputEntries = outputs => Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));
const guardEnv = (operation) => ({ GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  INFRA_OPERATION: operation, TESTER_EMAILS: '[]' });

// The one-shot mock is operation-scoped and runs the real reviewed guard. It keeps
// the mirror and the stored database decision separate and reports the status the
// way the Service does: the effective mode plus the raw stored mode.
function mockIo(options = {}) {
  const operation = options.operation ?? 'close-admission';
  const calls = []; const events = []; const proofs = [];
  const world = { mirror: structuredClone(options.mirror ?? closedRecord), testers: structuredClone(options.testers ?? originalTesters) };
  world.database = structuredClone(options.database ?? { admission_mode: world.mirror.mode, admission_record: world.mirror.mode });
  const now = () => options.now ?? NOW;
  const actionSet = operation === 'open-admission' ? ['resume', 'suspend', 'status'] : ['suspend', 'status'];
  let statusReads = 0;
  const platform = { StackName: 'AnyWearPlatformStack-beta', StackStatus: options.platformStatus ?? 'UPDATE_COMPLETE', Outputs: outputEntries(stackOutputs) };
  const runtime = options.runtimeStatus === null ? undefined
    : { StackName: runtimeStack, StackStatus: options.runtimeStatus ?? 'UPDATE_COMPLETE',
      Parameters: Object.entries({ ServiceImageDigest: options.digest ?? digest, ServiceCommitSha: options.commit ?? serviceSha,
        VlmConfigArn: 'arn:aws:ssm:ap-east-1:650880818323:parameter/beta-vlm', CloudFrontPrefixListId: 'pl-1234' })
        .map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })) };
  const stacks = new Map([['AnyWearPlatformStack-beta', platform], [runtimeStack, runtime]]);
  return { calls, events, proofs, world, operation, now, async aws(args) {
    calls.push(['aws', ...args]);
    if (args[0] === 'cloudformation') {
      const stack = stacks.get(args.at(-1));
      return { Stacks: stack ? [stack] : [] };
    }
    if (args[0] === 'ssm') {
      assert.equal(args[1], 'get-parameter');
      const name = args.at(-1);
      if (name.endsWith('tester_allowlist')) return { Parameter: { Name: name, Value: canonicalJson(world.testers) } };
      assert.equal(name, '/anywear/beta/admission_mode');
      return { Parameter: { Name: name, Value: options.mirrorValue ?? canonicalJson(world.mirror) } };
    }
    throw new Error(`Unexpected AWS call ${args[0]} ${args[1]}`);
  }, async oneShot(role, revision, action, payload) {
    calls.push(['oneShot', role, revision, action, ...(payload === undefined ? [] : [payload])]);
    assert.equal(role, 'lifecycle');
    assert.equal(revision.digest, digest); assert.equal(revision.commit, serviceSha);
    assertOneShotAllowed(guardEnv(operation), role, action, payload);
    assert.ok(actionSet.includes(action), `No drain, migration or tester configuration is permitted for ${operation}: ${action}`);
    if (action === 'resume') {
      assert.equal(operation, 'open-admission', 'Only open-admission may resume admission');
      assert.equal(payload, undefined, 'lifecycle resume takes no payload');
      if (options.resumeError) throw options.resumeError;
      world.mirror = openRecord;
      world.database = { admission_mode: 'testers', admission_record: 'testers' };
      return;
    }
    if (action === 'suspend') {
      if (options.suspendError) throw options.suspendError;
      world.mirror = closedRecord; world.database = { admission_mode: 'closed', admission_record: 'closed' };
      options.afterSuspend?.(world);
      return;
    }
    const status = { admission_mode: world.database.admission_mode, admission_record: world.database.admission_record,
      database_record_differs: world.database.admission_mode !== world.database.admission_record,
      tester_count: world.testers.length, database_policy_matches_ssm: true, tasks: 3, outbox: 2,
      ...(options.statusField === undefined ? {} : options.statusField) };
    const index = statusReads++;
    return options.status ? options.status(status, index) : status;
  }, recordAdmissionState(event) { events.push(structuredClone(event)); },
  recordAdmissionOpenProof(proof) { proofs.push(structuredClone(proof)); } };
}
const close = (io, extra = {}) => runCloseAdmission({ io, infraSha, env, ...extra });
const open = (io, extra = {}) => runOpenAdmission({ io, infraSha, env, ...extra });
const lifecycleActionsRun = io => io.calls.filter(call => call[0] === 'oneShot').map(call => call[3]);

test('the mode value and lifecycle status readers stay fail-closed and self-describing', () => {
  const closedDecision = resolveAdmissionDecision('closed');
  assert.equal(closedDecision.admission_mode, 'closed');
  assert.equal(isAdmissionClosed(closedDecision), true);
  assert.equal(isAdmissionProvablyClosed(closedDecision), true);
  assert.equal(isAdmissionClosed(resolveAdmissionDecision('testers')), false);
  assert.equal(isAdmissionProvablyClosed(resolveAdmissionDecision('testers')), false);
  assert.equal(admissionClosureProof(resolveAdmissionDecision('testers')), 'open');
  assert.equal(admissionClosureProof(parseAdmissionModeValue(undefined)), 'unproven');

  const openRecordDecision = parseAdmissionModeValue('{"mode":"testers"}');
  assert.equal(openRecordDecision.admission_mode, 'testers');
  assert.equal(openRecordDecision.admission_mode_source, 'record');
  assert.deepEqual(openRecordDecision.admission_recorded_keys, ['mode']);
  // The removed two-key record is not a record at all: it reads closed, fails
  // closed, keeps the reason and reports the keys it actually saw.
  const legacy = parseAdmissionModeValue('{"mode":"testers","expires_at":"2099-01-01T00:00:00.000Z"}');
  assert.equal(legacy.admission_mode, 'closed');
  assert.equal(legacy.admission_mode_source, 'fail-closed');
  assert.equal(legacy.admission_mode_reason, 'extra-key');
  assert.deepEqual(legacy.admission_recorded_keys, ['expires_at', 'mode']);
  assert.equal(isAdmissionProvablyClosed(legacy), false);
  assert.equal(admissionClosureProof(legacy), 'unproven');
  // A closed record with an extra key contradicts itself and proves nothing.
  assert.equal(parseAdmissionModeValue('{"mode":"closed","expires_at":null}').admission_mode_reason, 'extra-key');
  assert.equal(parseAdmissionModeValue('{"mode":true}').admission_mode_reason, 'wrong-type');
  assert.equal(parseAdmissionModeValue('{"mode":"open"}').admission_mode_reason, 'unknown-mode');
  assert.equal(parseAdmissionModeValue('{"mode":"closed","mode":"testers"}').admission_mode_reason, 'malformed');
  assert.equal(parseAdmissionModeValue(' {"mode":"closed"}').admission_mode_reason, 'non-canonical');
  assert.equal(parseAdmissionModeValue('{"mode":"closed"').admission_mode_reason, 'malformed');
  assert.equal(parseAdmissionModeValue(undefined).admission_mode_reason, 'missing');

  // `status` during a rollout may still carry the removed field; it is tolerated
  // and reported, never required.
  const withField = parseLifecycleStatus({ admission_mode: 'closed', admission_record: 'closed', database_record_differs: false,
    database_policy_matches_ssm: true, tester_count: 2, admission_window_expires_at: null });
  assert.equal(withField.tester_count, 2);
  assert.equal(lifecycleStatusReportsExpiry(withField), true);
  const withoutField = parseLifecycleStatus({ admission_mode: 'closed', admission_record: 'closed', database_record_differs: false,
    database_policy_matches_ssm: true, tester_count: 2 });
  assert.equal(lifecycleStatusReportsExpiry(withoutField), false);
  assert.throws(() => parseLifecycleStatus({ admission_mode: 'closed', admission_record: 'closed', database_record_differs: false,
    database_policy_matches_ssm: true, tester_count: 2, admission_window_expires_at: 5 }), /Invalid lifecycle admission_window_expires_at/);
  assert.throws(() => parseLifecycleStatus({ admission_mode: 'closed', admission_record: 'closed', database_record_differs: false,
    database_policy_matches_ssm: true, tester_count: -1 }), /Invalid lifecycle tester count/);
  assert.equal(classifyCloseKind({ admission_mode: 'testers', admission_record: 'testers' }), 'ordinary');
  assert.equal(classifyCloseKind({ admission_mode: 'closed', admission_record: 'closed' }), 'already-closed');
  const comparison = compareAdmissionDecision({ admission_mode: 'closed', admission_record: 'closed',
    database_record_differs: false, tester_count: 2, database_policy_matches_ssm: true }, closedState(), NOW);
  assert.equal(comparison.effective_matches, true);
  assert.equal(comparison.database.tester_count, 2);
  assert.equal(Object.hasOwn(comparison.database, 'admission_window_expires_at'), false);
});

test('close ends an open admission on the revision the release slice reports', async () => {
  const io = mockIo({ now: NOW, mirror: openRecord }); const result = await close(io);
  assert.deepEqual(result.original, openState());
  assert.deepEqual(result.state, closedState());
  assert.equal(result.status.outbox, 2);
  assert.equal(result.close_kind, 'ordinary');
  assert.deepEqual(lifecycleActionsRun(io), ['status', 'suspend', 'status']);
  assert.ok(!io.calls.some(call => ['put-parameter', 'update-stack', 'update-service'].includes(call[2])));
  assert.deepEqual(io.events.map(event => [event.phase, event.result]), [['original', 'observed'], ['closed', 'observed'], ['closed', 'verified']]);
  for (const event of io.events) assert.equal(Object.hasOwn(event, 'prior_expires_at'), false);
  for (const event of io.events.filter(event => event.phase !== 'original')) assert.equal(event.close_kind, 'ordinary');
  assert.equal(io.events.at(-1).lifecycle_status_sha256, contentHash(result.status));
});

test('close classifies what it ended from the stored database mode', async () => {
  for (const { database, closeKind } of [
    { database: { admission_mode: 'testers', admission_record: 'testers' }, closeKind: 'ordinary' },
    { database: { admission_mode: 'closed', admission_record: 'testers' }, closeKind: 'already-closed' },
    { database: { admission_mode: 'closed', admission_record: 'closed' }, closeKind: 'already-closed' },
  ]) {
    const io = mockIo({ now: NOW, database }); const result = await close(io);
    assert.equal(result.close_kind, closeKind, JSON.stringify(database));
    assert.equal(io.events.at(-1).close_kind, closeKind);
  }
  const already = mockIo({ now: NOW, mirror: closedRecord }); const alreadyResult = await close(already);
  assert.equal(alreadyResult.close_kind, 'already-closed');
  assert.deepEqual(lifecycleActionsRun(already), ['status', 'suspend', 'status']);
});

test('source and active-Beta mismatches prevent every close before any lifecycle task', async () => {
  for (const extra of [{ infraSha: '6'.repeat(40) }, { env: { ...env, GITHUB_REF: 'refs/heads/other' } },
    { env: { ...env, AWS_ACCOUNT_ID: '1' } },
    { env: { ...env, GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/retired-executor.yml@refs/heads/main' } }]) {
    const io = mockIo(); await assert.rejects(close(io, extra)); assert.equal(io.calls.length, 0);
  }
  for (const options of [{ runtimeStatus: 'UPDATE_IN_PROGRESS' }, { runtimeStatus: 'UPDATE_ROLLBACK_FAILED' },
    { runtimeStatus: null }, { platformStatus: 'UPDATE_IN_PROGRESS' }]) {
    const io = mockIo(options); await assert.rejects(close(io));
    assert.equal(lifecycleActionsRun(io).includes('suspend'), false, JSON.stringify(options));
    assert.equal(io.events.at(-1).phase, 'failed');
  }
});

test('failed close/readback never implicitly resumes or changes testers', async () => {
  const cases = [
    { suspendError: new Error('Pinned suspend failed') },
    { afterSuspend(world) { world.mirror = openRecord; } },
    { afterSuspend(world) { world.testers = []; } },
    { status(value) { return { ...value, database_policy_matches_ssm: false }; } },
    { status(value) { return { ...value, tester_count: 0 }; } },
    { status(value, index) { return index === 0 ? value : { ...value, admission_mode: 'testers' }; } },
  ];
  for (const options of cases) {
    const io = mockIo(options); await assert.rejects(close(io));
    assert.equal(lifecycleActionsRun(io).includes('resume'), false, JSON.stringify(options));
    assert.equal(io.events.at(-1).phase, 'failed');
  }
});

test('open records the post-open proof: open, no bound, surfaces agree', async () => {
  const io = mockIo({ operation: 'open-admission', now: NOW, mirror: closedRecord });
  const result = await open(io);
  assert.deepEqual(result.original, closedState());
  assert.deepEqual(result.state, openState());
  assert.deepEqual(lifecycleActionsRun(io), ['status', 'resume', 'status']);
  // `resume` carries no payload: there is no bound to write.
  assert.equal(io.calls.filter(call => call[0] === 'oneShot').find(call => call[3] === 'resume').length, 4);
  assert.deepEqual(io.events.map(event => [event.phase, event.result]), [['original', 'observed'], ['opened', 'observed'], ['verified', 'verified']]);

  assert.equal(io.proofs.length, 1);
  const proof = io.proofs[0];
  assert.deepEqual(proof, {
    type: 'admission-open-proof',
    schema_version: 1,
    observed_at: new Date(NOW).toISOString(),
    mode: 'testers',
    mode_source: 'record',
    no_bound: true,
    tester_count: 2,
    tester_emails_sha256: sha256(canonicalJson(originalTesters)),
    surfaces_agree: true,
    ssm: { parameter: '/anywear/beta/admission_mode', recorded_mode: 'testers', record_keys: ['mode'], expires_at_present: false },
    database: { lifecycle_status_mode: 'testers', lifecycle_status_record: 'testers', lifecycle_status_reports_expires_at: false,
      database_policy_matches_ssm: true, tester_count: 2, lifecycle_status_sha256: contentHash(result.status) },
  });
  assert.equal(proof.no_bound, (proof.ssm.record_keys.length === 1 && proof.ssm.record_keys[0] === 'mode')
    && proof.database.lifecycle_status_reports_expires_at === false);
  assert.ok(!io.calls.some(call => ['put-parameter', 'update-stack', 'update-service'].includes(call[2])));
});

test('open refuses a legacy two-key mirror before resuming and records no proof', async () => {
  for (const mirrorValue of [canonicalJson(legacyRecord), '{"mode":"closed","expires_at":null}', 'closed']) {
    const io = mockIo({ operation: 'open-admission', now: NOW, mirrorValue });
    await assert.rejects(open(io), error => {
      assert.match(error.cause?.message ?? error.message, /does not prove closed admission/, mirrorValue);
      return true;
    });
    assert.deepEqual(lifecycleActionsRun(io), ['status']);
    assert.equal(io.proofs.length, 0, mirrorValue);
  }
});

test('open refuses a status that still reports the removed window field', async () => {
  const io = mockIo({ operation: 'open-admission', now: NOW, mirror: closedRecord,
    statusField: { admission_window_expires_at: null } });
  await assert.rejects(open(io), error => {
    assert.match(error.message, /closed back to the recorded decision/);
    assert.match(error.cause.message, /still reports the removed admission window field/);
    return true;
  });
  // The failed-open recovery closes it again and records the close kind.
  assert.deepEqual(lifecycleActionsRun(io), ['status', 'resume', 'status', 'suspend']);
  assert.equal(io.events.at(-1).close_kind, 'failed-open');
  assert.equal(io.proofs.length, 0);
});

test('a failed open closes back to the recorded decision and names the close kind', async () => {
  const io = mockIo({ operation: 'open-admission', now: NOW, mirror: closedRecord,
    status(value, index) { return index === 0 ? value : { ...value, tester_count: 1 }; } });
  await assert.rejects(open(io), /closed back to the recorded decision/);
  assert.deepEqual(lifecycleActionsRun(io), ['status', 'resume', 'status', 'suspend']);
  assert.equal(io.events.at(-1).close_kind, 'failed-open');
  assert.equal(io.proofs.length, 0);
});

test('the runtime io records the post-open proof verbatim and keeps the key set in state events', async () => {
  const record = { events: [] };
  const io = await createRuntimeIo({}, record, { assume: async () => ({}), run: async () => ({ stdout: '{}', stderr: '' }) });
  const proof = { type: 'admission-open-proof', schema_version: 1, mode: 'testers', mode_source: 'record',
    no_bound: true, surfaces_agree: true };
  io.recordAdmissionOpenProof(proof);
  assert.deepEqual(record.events, [proof]);
  io.recordAdmissionState({ phase: 'opened', result: 'observed',
    state: { admission_mode: 'testers', admission_mode_source: 'record', admission_mode_reason: null,
      admission_recorded_mode: 'testers', admission_recorded_keys: ['mode'], tester_emails: originalTesters } });
  assert.deepEqual(record.events[1].state.admission_recorded_keys, ['mode']);
  assert.equal(record.events[1].state.tester_count, 2);
  assert.equal(Object.hasOwn(record.events[1].state, 'admission_window_expires_at'), false);
});

test('a failure before the resume attempt records no recovery close', async () => {
  const io = mockIo({ operation: 'open-admission', now: NOW, mirror: openRecord });
  await assert.rejects(open(io));
  assert.equal(lifecycleActionsRun(io).includes('resume'), false);
  assert.equal(lifecycleActionsRun(io).includes('suspend'), false);
  assert.equal(io.proofs.length, 0);
});

