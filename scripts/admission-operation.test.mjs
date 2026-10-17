import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readAdmissionState, assertClosedAdmission, assertOpenedAdmission, parseLifecycleStatus,
  classifyCloseKind, runCloseAdmission, runOpenAdmission } from './admission-operation.mjs';
import { ADMISSION_WINDOW_CLOCK_SKEW_MS, admissionWindowPayload } from './admission-window.mjs';
import { assertOneShotAllowed } from './operation-boundaries.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { contentHash } from './json-contract.mjs';

const { selector, manifest, schema } = await createTestInputs(await mkdtemp(path.join(os.tmpdir(), 'infra-admission-')));
const infraSha = '5'.repeat(40);
const env = { GITHUB_SHA: infraSha, GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra',
  GITHUB_RUN_ID: '23', GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/beta-admission.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', WINDOW_MINUTES: '60', TESTER_EMAILS: '[]' };
// The SSM mirror after a window was opened and never closed: suspension reads
// false, public intake stays closed and the tester list is the recorded one.
const original = { admission_suspended: false, intake_open: false, tester_emails: ['first@example.com', 'second@example.com'] };
// The recorded closed tuple: the same membership with suspension on.
const closedTuple = { ...original, admission_suspended: true };
// A fixed clock keeps the recorded expiry arithmetic deterministic.
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const FUTURE = new Date(NOW + 60 * 60_000).toISOString();
const PAST = new Date(NOW - 60 * 60_000).toISOString();
const stackOutputs = Object.fromEntries(['PrivateSubnetIds', 'OneShotSecurityGroupId', 'VerificationTaskRoleArn', 'OneShotExecutionRoleArn',
  'OneShotLogGroupName', 'DatabaseSecretArn', 'DatabaseHost', 'DatabasePort', 'DatabaseName', 'WardrobeBucketName'].map(key => [key, key]));
Object.assign(stackOutputs, { EcsClusterName: 'beta-anywear', BetaActive: 'true' });
const outputEntries = outputs => Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));

// The dispatch envelope the real one-shot guard reads: the admission entry
// point, the operation under test, the bounded window and no tester payload.
const guardEnv = (operation, windowMinutes) => ({ GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/beta-admission.yml@refs/heads/main',
  INFRA_OPERATION: operation, WINDOW_MINUTES: String(windowMinutes), TESTER_EMAILS: '[]' });

// The one-shot mock is operation-scoped: a close may run `status` and `close`,
// and `open` is permitted only for the open operation and only with the exact
// bounded payload the driver builds from the dispatch input.
function mockIo(options = {}) {
  const operation = options.operation ?? 'close-admission';
  const windowMinutes = options.windowMinutes ?? 60;
  const calls = []; const events = [];
  const state = structuredClone(options.original ?? original);
  // The window expiry is carried by the database row, not by the SSM mirror.
  let window = options.expiresAt ?? null;
  const now = () => options.now ?? NOW;
  const actionSet = operation === 'open-admission' ? ['open', 'close', 'status'] : ['close', 'status'];
  let statusReads = 0;
  const platform = { StackStatus: options.platformStatus ?? 'UPDATE_COMPLETE', Outputs: outputEntries({ ...stackOutputs, BetaActive: options.platformActive ?? 'true' }) };
  const workload = { StackStatus: options.workloadStatus ?? 'UPDATE_COMPLETE', Outputs: outputEntries({ BetaActive: options.workloadActive ?? 'true' }),
    Parameters: Object.entries({ ServiceImageDigest: options.digest ?? selector.image.digest, ServiceCommitSha: options.commit ?? selector.image.service_sha,
      VlmConfigArn: 'arn:aws:ssm:ap-east-1:650880818323:parameter/beta-vlm', CloudFrontPrefixListId: 'pl-1234' })
      .map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })) };
  let definition;
  const taskArn = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'a'.repeat(32)}`;
  const taskDefinitionArn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-artifact-verify:1';
  const migrations = schema.migrations.map(row => ({ id: row.sha256, created_at: row.created_at }));
  const evidence = { schema_version: 1, record_type: 'anywear_read_only_runtime', service_sha: selector.image.service_sha,
    image_digest: selector.image.digest, policy_file_sha256: manifest.components.runtime_policy.sha256,
    policy_content_sha256: manifest.components.runtime_policy.content_sha256, selected_journal_sha256: manifest.components.schema.journal_sha256,
    selected_migration_ids: migrations, applied_migration_ids: migrations, applied_schema_version: schema.current_version,
    observed_applied_journal_sha256: contentHash(migrations), ...options.evidence };
  return { calls, events, state, operation, now, async aws(args) {
    calls.push(['aws', ...args]);
    if (args[0] === 'cloudformation') return { Stacks: [args.at(-1).includes('Platform') ? platform : workload] };
    if (args[0] === 'ssm') {
      assert.equal(args[1], 'get-parameter');
      const name = args.at(-1); const key = name.endsWith('tester_allowlist') ? 'tester_emails' : name.split('/').at(-1);
      if (options.read) return options.read(key, state, name);
      return { Parameter: { Name: name, Value: key === 'tester_emails' ? JSON.stringify(state[key]) : String(state[key]) } };
    }
    switch (args[1]) {
      case 'register-task-definition': definition = JSON.parse(args[args.indexOf('--cli-input-json') + 1]); return { taskDefinition: { taskDefinitionArn } };
      case 'run-task': return { tasks: [{ taskArn }] };
      case 'wait': return {};
      case 'describe-tasks': return { tasks: [{ taskArn, taskDefinitionArn, lastStatus: 'STOPPED', containers: [{ name: 'OneShot', exitCode: 0, imageDigest: selector.image.digest }] }] };
      case 'describe-task-definition': return { taskDefinition: definition };
      case 'get-log-events': return { events: [{ message: `ANYWEAR_RUNTIME_EVIDENCE:${JSON.stringify(evidence)}` }] };
      case 'deregister-task-definition': return {};
      default: throw new Error(`Unexpected AWS call ${args[0]} ${args[1]}`);
    }
  }, async oneShot(role, revision, action, payload) {
    calls.push(['oneShot', role, revision, action, ...(payload === undefined ? [] : [payload])]);
    assert.equal(role, 'lifecycle');
    // The real reviewed guard runs here, so this mock cannot admit an action the
    // runtime would refuse. The action set below is the mock's own expectation on
    // top of it, not a substitute for it.
    assertOneShotAllowed(guardEnv(operation, windowMinutes), role, action, payload);
    assert.ok(actionSet.includes(action), `No reopen, drain, migration, or tester configuration is permitted for ${operation}: ${action}`);
    if (action === 'open') {
      assert.equal(operation, 'open-admission', 'Only open-admission may open admission');
      assert.equal(payload, admissionWindowPayload({ WINDOW_MINUTES: String(windowMinutes) }),
        'Open must carry the exact bounded dispatch payload');
      if (options.openError) throw options.openError;
      state.admission_suspended = false;
      window = options.openExpiry !== undefined ? options.openExpiry
        : new Date(now() + (options.openMinutes ?? windowMinutes) * 60_000).toISOString();
      options.afterOpen?.(state);
      return;
    }
    if (action === 'close') {
      if (options.closeError) throw options.closeError;
      state.admission_suspended = true;
      window = null;
      options.afterClose?.(state);
      return;
    }
    const status = { intake_open: state.intake_open, admission_suspended: state.admission_suspended,
      tester_count: state.tester_emails.length, database_policy_matches_ssm: true,
      ...(options.omitExpiry ? {} : { admission_window_expires_at: window }),
      tasks: 3, outbox: 2, outboxManualIntervention: 1, outboxOldestAgeMs: 10, outboxManualInterventionOldestAgeMs: null,
      outboxStatusCounts: { pending: 2 }, queues: { vto: { visible: 2, notVisible: 1, delayed: 0 }, tagging: { visible: 0, notVisible: 0, delayed: 0 } },
      dlqs: { vto: { visible: 1, notVisible: 0, delayed: 0 }, tagging: { visible: 0, notVisible: 0, delayed: 0 } } };
    const index = statusReads++;
    const result = options.status ? options.status(status, index) : status;
    options.afterStatus?.(state, index);
    return result;
  }, recordAdmissionState(event) { events.push(structuredClone(event)); } };
}
const close = (io, extra = {}) => runCloseAdmission({ io, selector, manifest, schema, infraSha, env, ...extra });
const open = (io, extra = {}) => runOpenAdmission({ io, selector, manifest, schema, infraSha, env, ...extra });
const lifecycleCalls = io => io.calls.filter(call => call[0] === 'oneShot');
const lifecycleActionsRun = io => lifecycleCalls(io).map(call => call[3]);

test('strict SSM read normalizes testers and distinguishes true/false from missing or malformed values', async () => {
  const io = mockIo({ original: { ...original, tester_emails: [' Second@Example.com ', 'first@example.com', 'SECOND@example.com'] } });
  assert.deepEqual(await readAdmissionState(io), original);
  for (const invalid of [undefined, '', 'False', '0', ' true ']) {
    const bad = mockIo({ read(key, state, name) {
      return { Parameter: { Name: name, Value: key === 'intake_open' ? invalid : key === 'tester_emails' ? JSON.stringify(state[key]) : String(state[key]) } };
    } });
    await assert.rejects(readAdmissionState(bad), error => {
      assert.equal(error.observedAdmissionState.intake_open, 'unavailable');
      assert.equal(error.observedAdmissionState.admission_suspended, false);
      assert.deepEqual(error.observedAdmissionState.tester_emails, original.tester_emails);
      return true;
    });
  }
  for (const invalid of ['not-json', '{}', '["*@example.com"]']) {
    await assert.rejects(readAdmissionState(mockIo({ read(key, state, name) { return { Parameter: { Name: name,
      Value: key === 'tester_emails' ? invalid : String(state[key]) } }; } })));
  }
  await assert.rejects(readAdmissionState(mockIo({ read() { return { Parameter: { Name: '/unrelated', Value: 'false' } }; } })));
});

test('closed assertion requires suspension, closed intake, and the original normalized tester list', () => {
  assertClosedAdmission({ ...original, admission_suspended: true }, original);
  for (const state of [{ ...original }, { ...original, admission_suspended: true, intake_open: true },
    { ...original, admission_suspended: true, tester_emails: [] }, { ...original, admission_suspended: true, tester_emails: undefined }]) {
    assert.throws(() => assertClosedAdmission(state, original));
  }
});

test('opened assertion requires lifted suspension, closed public intake and the original normalized tester list', () => {
  assertOpenedAdmission(original, closedTuple);
  for (const state of [closedTuple, { ...original, intake_open: true }, { ...original, tester_emails: [] },
    { ...original, admission_suspended: 'false' }, { ...original, intake_open: 'false' }]) {
    assert.throws(() => assertOpenedAdmission(state, closedTuple));
  }
  // A window never changes who is admitted: the tester lane stays the tester lane.
  assert.throws(() => assertOpenedAdmission({ ...original, tester_emails: [...original.tester_emails, 'third@example.com'] }, closedTuple));
});

test('close uses selected pinned lifecycle image after real policy/schema verification and accepts diagnostic backlog', async () => {
  const io = mockIo({ now: NOW, expiresAt: FUTURE }); const result = await close(io);
  assert.deepEqual(result.original, original);
  assert.deepEqual(result.state, { ...original, admission_suspended: true });
  assert.equal(result.runtime_verification.schema.compatibility_result, 'compatible');
  assert.equal(result.runtime_verification.schema.applied_schema_version, schema.current_version);
  assert.equal(result.status.outbox, 2);
  // A live window was open, so this close ended it as the ordinary one.
  assert.equal(result.close_kind, 'ordinary');
  assert.equal(result.prior_expires_at, FUTURE);
  assert.deepEqual(lifecycleActionsRun(io), ['status', 'close', 'status']);
  for (const call of lifecycleCalls(io)) {
    assert.equal(call[2].digest, selector.image.digest); assert.equal(call[2].commit, selector.image.service_sha);
    assert.equal(call[2].parameters.ServiceImageDigest, selector.image.digest);
  }
  const closeIndex = io.calls.findIndex(call => call[0] === 'oneShot' && call[3] === 'close');
  assert.ok(io.calls.findIndex(call => call[2] === 'deregister-task-definition') < closeIndex);
  assert.equal(io.calls.filter(call => call[2] === 'register-task-definition').length, 1);
  assert.ok(!io.calls.some(call => ['put-parameter', 'update-stack', 'update-service'].includes(call[2])));
  assert.deepEqual(io.events.map(event => [event.phase, event.result]), [['original', 'observed'], ['closed', 'observed'], ['closed', 'verified']]);
  // Every phase the close writes after classifying carries the classification.
  for (const event of io.events.filter(event => event.phase !== 'original')) {
    assert.equal(event.close_kind, 'ordinary'); assert.equal(event.prior_expires_at, FUTURE);
  }
  assert.equal(io.events.at(-1).lifecycle_status_sha256, contentHash(result.status));
});

test('close classifies what it ended from the database status, not from the stale SSM mirror', async () => {
  const cases = [
    // A live window: the close ended it.
    { options: { now: NOW, expiresAt: FUTURE }, closeKind: 'ordinary', priorExpiresAt: FUTURE },
    // The bound had already ended an expired window; this close restored the tuple.
    { options: { now: NOW, expiresAt: PAST }, closeKind: 'recovery', priorExpiresAt: PAST },
    // An older Service carried no window at all.
    { options: { now: NOW }, closeKind: 'recovery', priorExpiresAt: null },
    // An unparseable expiry cannot be proven live, so the bound ended it.
    { options: { now: NOW, expiresAt: 'not-an-instant' }, closeKind: 'recovery', priorExpiresAt: 'not-an-instant' },
    // Suspension was already on: the close changed nothing.
    { options: { now: NOW, original: closedTuple }, closeKind: 'already-closed', priorExpiresAt: null },
    // A future expiry alongside suspension true is inconsistent: not a window.
    { options: { now: NOW, original: closedTuple, expiresAt: FUTURE }, closeKind: 'already-closed', priorExpiresAt: FUTURE },
  ];
  for (const { options, closeKind, priorExpiresAt } of cases) {
    const io = mockIo(options); const result = await close(io);
    assert.equal(result.close_kind, closeKind, JSON.stringify(options));
    assert.equal(result.prior_expires_at, priorExpiresAt, JSON.stringify(options));
    assert.deepEqual(result.state, { ...(options.original ?? original), admission_suspended: true });
    for (const event of io.events.filter(event => event.phase !== 'original')) {
      assert.equal(event.close_kind, closeKind); assert.equal(event.prior_expires_at, priorExpiresAt);
    }
  }
  // The classifier itself is a pure function of the database status read.
  assert.equal(classifyCloseKind({ admission_suspended: true, admission_window_expires_at: FUTURE }, NOW), 'already-closed');
  assert.equal(classifyCloseKind({ admission_suspended: false, admission_window_expires_at: FUTURE }, NOW), 'ordinary');
  for (const value of [PAST, null, undefined, 'malformed', 0, {}]) {
    assert.equal(classifyCloseKind({ admission_suspended: false, admission_window_expires_at: value }, NOW), 'recovery');
  }
});

test('already closed admission remains closed with the same exact testers', async () => {
  const io = mockIo({ original: closedTuple });
  const result = await close(io);
  assert.deepEqual(result.state, result.original);
  assert.equal(result.close_kind, 'already-closed');
  assert.deepEqual(lifecycleActionsRun(io), ['status', 'close', 'status']);
});

test('the four-tester restoration fixture stays intact despite an empty dispatch payload', async () => {
  const admission = { admission_suspended: true, intake_open: false, tester_emails: [
    'e2e-beta-worker-0-chromium@anywear.local', 'e2e-beta-worker-1-chromium@anywear.local', 'luma26c@gmail.com', 'windy005@126.com',
  ] };
  const io = mockIo({ original: admission });
  const result = await close(io, { env: { ...env, TESTER_EMAILS: '[]' } });
  assert.deepEqual(result.original, admission); assert.deepEqual(result.state, admission);
  assert.equal(result.status.tester_count, 4);
  assert.ok(lifecycleCalls(io).every(call => call.length === 4));
});

test('source, activity, stack, revision, intake, and candidate policy/schema mismatches prevent every close', async () => {
  for (const extra of [{ infraSha: '6'.repeat(40) }, { env: { ...env, GITHUB_REF: 'refs/heads/other' } }, { env: { ...env, AWS_ACCOUNT_ID: '1' } },
    { env: { ...env, GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/integration.yml@refs/heads/main' } }]) {
    const io = mockIo(); await assert.rejects(close(io, extra)); assert.equal(io.calls.length, 0);
  }
  for (const options of [{ platformActive: 'false' }, { workloadActive: 'false' }, { platformActive: 'unknown' },
    { platformStatus: 'UPDATE_IN_PROGRESS' }, { workloadStatus: 'UPDATE_ROLLBACK_FAILED' },
    { commit: '6'.repeat(40) }, { digest: `sha256:${'6'.repeat(64)}` }, { original: { ...original, intake_open: true } },
    { evidence: { policy_content_sha256: '6'.repeat(64) } }, { evidence: { selected_journal_sha256: '6'.repeat(64) } },
    { evidence: { applied_schema_version: schema.minimum_version - 1 } },
    { evidence: { applied_migration_ids: [{ id: '6'.repeat(64), created_at: 1000 }] } }]) {
    const io = mockIo(options); await assert.rejects(close(io));
    assert.equal(lifecycleActionsRun(io).includes('close'), false, JSON.stringify(options));
    assert.equal(io.events.at(-1).phase, 'failed');
  }
});

test('injected verifier receives the already verified selection and rejects before any lifecycle close', async () => {
  const io = mockIo(); let invoked = false;
  await assert.rejects(close(io, { async verifyRuntime(input) {
    invoked = true; assert.equal(input.selector, selector); assert.equal(input.manifest, manifest);
    assert.equal(input.schema, schema); assert.equal(input.infraSha, infraSha); assert.equal(input.outputs.BetaActive, 'true');
    throw new Error('Applied schema incompatible');
  } }));
  assert.equal(invoked, true);
  // The pre-close database read is read-only; no close ran after the failed verification.
  assert.deepEqual(lifecycleActionsRun(io), ['status']);
});

test('failed close/readback/status preserves observed admission and never implicitly reopens or changes testers', async () => {
  const cases = [
    { closeError: new Error('Pinned close failed') },
    { afterClose(state) { state.admission_suspended = false; } },
    { afterClose(state) { state.tester_emails = []; } },
    { afterClose(state) { state.intake_open = true; } },
    { status() { return undefined; }, noClose: true },
    { status(value) { return { ...value, database_policy_matches_ssm: false }; } },
    { status(value) { return { ...value, tester_count: 0 }; } },
    { status(value) { return { ...value, admission_suspended: false }; } },
    { status(value) { return { ...value, intake_open: true }; } },
    { status(value) { return { ...value, database_policy_matches_ssm: 'true' }; }, noClose: true },
    { status(value) { return { ...value, outbox: -1 }; }, noClose: true },
    { status(value) { return { ...value, queues: { vto: {} } }; }, noClose: true },
    { afterStatus(state) { state.admission_suspended = false; } },
    { afterStatus(state) { state.tester_emails.push('new@example.com'); } },
  ];
  for (const options of cases) {
    const io = mockIo(options); await assert.rejects(close(io), /closure failed/);
    const failure = io.events.at(-1);
    assert.equal(failure.phase, 'failed'); assert.equal(failure.result, 'failed');
    assert.deepEqual(failure.state, { ...io.state, tester_emails: [...io.state.tester_emails].sort() });
    // Only a close attempt carries the classification; earlier failures record none.
    assert.equal(failure.close_kind, options.noClose ? undefined : 'recovery', JSON.stringify(options));
    assert.equal(failure.prior_expires_at, options.noClose ? undefined : null, JSON.stringify(options));
    assert.ok(lifecycleActionsRun(io).every(action => ['close', 'status'].includes(action)));
    assert.ok(!io.calls.some(call => ['put-parameter', 'update-stack', 'update-service'].includes(call[2])));
  }
});

test('unavailable post-close boolean readback records every remaining actual state field', async () => {
  const io = mockIo({ read(key, state, name) {
    if (state.admission_suspended && key === 'intake_open') return {};
    return { Parameter: { Name: name, Value: key === 'tester_emails' ? JSON.stringify(state[key]) : String(state[key]) } };
  } });
  await assert.rejects(close(io));
  assert.deepEqual(io.events.at(-1).state, { ...original, admission_suspended: true, intake_open: 'unavailable' });
  assert.equal(io.events.at(-1).close_kind, 'recovery');
  assert.deepEqual(lifecycleActionsRun(io), ['status', 'close']);
});

test('open records the requested bound, both admission phases and the status read-back proving the recorded expiry', async () => {
  const io = mockIo({ operation: 'open-admission', now: NOW, original: closedTuple });
  const result = await open(io);
  assert.equal(result.window_minutes, 60);
  assert.equal(result.admission_window_expires_at, new Date(NOW + 60 * 60_000).toISOString());
  assert.deepEqual(result.original, closedTuple);
  assert.deepEqual(result.state, original);
  assert.equal(result.runtime_verification.schema.compatibility_result, 'compatible');
  assert.deepEqual(lifecycleActionsRun(io), ['status', 'open', 'status']);
  // The bounded payload is the one the shared builder produces, byte-identical.
  assert.equal(lifecycleCalls(io).find(call => call[3] === 'open')[4], '{"window_minutes":60}');
  assert.deepEqual(io.events.map(event => [event.phase, event.result]),
    [['original', 'observed'], ['opened', 'observed'], ['verified', 'verified']]);
  assert.equal(io.events[1].window_minutes, 60);
  assert.equal(io.events[1].admission_window_expires_at, result.admission_window_expires_at);
  assert.equal(io.events.at(-1).lifecycle_status_sha256, contentHash(result.status));
  assert.ok(!io.calls.some(call => ['put-parameter', 'update-stack', 'update-service'].includes(call[2])));
});

test('open honours the dispatch bound instead of a fixed default', async () => {
  for (const minutes of [15, 60, 240]) {
    const io = mockIo({ operation: 'open-admission', now: NOW, original: closedTuple, windowMinutes: minutes });
    const result = await open(io, { env: { ...env, WINDOW_MINUTES: String(minutes) } });
    assert.equal(result.window_minutes, minutes);
    assert.equal(result.admission_window_expires_at, new Date(NOW + minutes * 60_000).toISOString());
    assert.equal(lifecycleCalls(io).find(call => call[3] === 'open')[4], admissionWindowPayload({ WINDOW_MINUTES: String(minutes) }));
  }
});

test('open refuses before opening when the Service cannot carry the bound or the state is not provably closed', async () => {
  const cases = [
    // An older Service cannot enforce a bound: the field's absence is the fence.
    { omitExpiry: true },
    // Suspension reads false in the database: not the recorded closed tuple.
    { original },
    // A live window is still open.
    { original: closedTuple, expiresAt: FUTURE },
    // A non-null unparseable expiry cannot prove closure.
    { original: closedTuple, expiresAt: 'not-an-instant' },
    // Public intake must already be closed.
    { original: { ...closedTuple, intake_open: true } },
    // The database and the SSM mirror must agree.
    { original: closedTuple, status(value) { return { ...value, database_policy_matches_ssm: false }; } },
  ];
  for (const options of cases) {
    const io = mockIo({ now: NOW, operation: 'open-admission', ...options });
    await assert.rejects(open(io), /admission window failed before it was requested/);
    assert.deepEqual(lifecycleActionsRun(io), ['status'], JSON.stringify(options));
    const failure = io.events.at(-1);
    assert.equal(failure.phase, 'failed'); assert.equal(failure.result, 'failed');
    assert.equal(failure.close_kind, undefined, 'No close is attempted when nothing was opened');
  }
  // Inactive, unstable or unselected Beta never reaches a lifecycle task at all.
  for (const options of [{ platformActive: 'false' }, { workloadStatus: 'UPDATE_IN_PROGRESS' }, { commit: '6'.repeat(40) },
    { digest: `sha256:${'6'.repeat(64)}` }]) {
    const io = mockIo({ now: NOW, operation: 'open-admission', original: closedTuple, ...options });
    await assert.rejects(open(io), /admission window failed before it was requested/);
    assert.equal(lifecycleCalls(io).length, 0, JSON.stringify(options));
    assert.equal(io.events.at(-1).phase, 'failed');
  }
  // An out-of-range or missing dispatch bound is refused before any AWS activity.
  for (const minutes of ['14', '241', '60.5', '', undefined]) {
    const io = mockIo({ operation: 'open-admission', now: NOW, original: closedTuple });
    await assert.rejects(open(io, { env: { ...env, WINDOW_MINUTES: minutes } }), /integer from 15 to 240/);
    assert.equal(io.calls.length, 0);
  }
});

test('a window that fails after opening still closes and records close_kind failed-window', async () => {
  const cases = [
    // The recorded expiry claims a longer window than the dispatch requested.
    { openMinutes: 62, ran: ['status', 'open', 'status', 'close'] },
    // The recorded expiry is already in the past.
    { openExpiry: PAST, ran: ['status', 'open', 'status', 'close'] },
    // A malformed expiry proves nothing.
    { openExpiry: 'not-an-instant', ran: ['status', 'open', 'status', 'close'] },
    // No expiry at all is not a bounded window.
    { openExpiry: null, ran: ['status', 'open', 'status', 'close'] },
    // The opened tuple itself is wrong: suspension stayed on.
    { afterOpen(state) { state.admission_suspended = true; }, ran: ['status', 'open', 'close'] },
    // The post-open status read-back itself fails.
    { status(value, index) { return index === 0 ? value : undefined; }, ran: ['status', 'open', 'status', 'close'] },
    // The post-open status reports a mismatched database policy.
    { status(value, index) { return index === 0 ? value : { ...value, database_policy_matches_ssm: false }; }, ran: ['status', 'open', 'status', 'close'] },
  ];
  for (const { ran, ...options } of cases) {
    const io = mockIo({ operation: 'open-admission', now: NOW, original: closedTuple, ...options });
    await assert.rejects(open(io), /admission window failed and was closed back to the recorded tuple/);
    assert.deepEqual(lifecycleActionsRun(io), ran, JSON.stringify(options));
    // The recovery close restored the recorded tuple; the record names it.
    const closed = io.events.find(event => event.phase === 'closed');
    assert.deepEqual(closed.state, closedTuple);
    assert.equal(closed.close_kind, 'failed-window');
    const failure = io.events.at(-1);
    assert.equal(failure.phase, 'failed'); assert.equal(failure.result, 'failed');
    assert.equal(failure.close_kind, 'failed-window');
    assert.equal(failure.state.admission_suspended, true);
    assert.equal(failure.state.intake_open, false);
  }
  // A failed window never leaves suspension lifted: the last SSM tuple is closed.
  const io = mockIo({ operation: 'open-admission', now: NOW, original: closedTuple, openMinutes: 240 });
  await assert.rejects(open(io));
  assert.deepEqual(await readAdmissionState(io), closedTuple);
});

test('the real one-shot guard admits the recovery close so a failed window can restore the tuple', async () => {
  // The mock now runs the reviewed guard for every one-shot, so this fails if the
  // recovery close stops being allowed for open-admission: the failure path would
  // leave suspension lifted instead of restoring the recorded tuple.
  const io = mockIo({ operation: 'open-admission', now: NOW, original: closedTuple, openMinutes: 62 });
  await assert.rejects(open(io), error => error.cause?.message === 'Observed admission window expiry is outside the requested bound');
  // The recovery close was actually issued after the failed read-back.
  assert.deepEqual(lifecycleActionsRun(io), ['status', 'open', 'status', 'close']);
  const closed = io.events.find(event => event.phase === 'closed');
  // The closed tuple was re-asserted against the tuple recorded before the window.
  assert.deepEqual(closed.state, closedTuple);
  assert.equal(closed.close_kind, 'failed-window');
  const failure = io.events.at(-1);
  assert.equal(failure.phase, 'failed'); assert.equal(failure.result, 'failed');
  assert.equal(failure.close_kind, 'failed-window');
  assert.deepEqual(await readAdmissionState(io), closedTuple);
  // The guard itself, not only the driver, is what permits it.
  assertOneShotAllowed(guardEnv('open-admission', 60), 'lifecycle', 'close');
  assert.throws(() => assertOneShotAllowed(guardEnv('close-admission', 60), 'lifecycle', 'open', '{"window_minutes":60}'), /forbidden/);
});

test('a recovery close that cannot restore the tuple aggregates the original error and names the unsafe state', async () => {
  const cases = [
    // The window also reopened public intake, which the close does not revert.
    { openMinutes: 120, afterOpen(state) { state.intake_open = true; },
      first: 'Beta admission is not proven open with intake closed', ran: ['status', 'open', 'close'],
      observed: 'admission_suspended=true, intake_open=true, tester_count=2' },
    // The window also changed the tester list, which the close does not revert.
    { openMinutes: 120, afterOpen(state) { state.tester_emails.push('third@example.com'); },
      first: 'Beta tester list changed during the admission window', ran: ['status', 'open', 'close'],
      observed: 'admission_suspended=true, intake_open=false, tester_count=3' },
    // The recovery close itself fails while admission is still lifted.
    { openMinutes: 120, closeError: new Error('close unavailable'),
      first: 'Observed admission window expiry is outside the requested bound', ran: ['status', 'open', 'status', 'close'],
      observed: 'admission_suspended=false, intake_open=false, tester_count=2' },
  ];
  for (const { first, observed, ran, ...options } of cases) {
    const io = mockIo({ operation: 'open-admission', now: NOW, original: closedTuple, ...options });
    await assert.rejects(open(io), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[0].message, first);
      assert.equal(error.cause, error.errors[0]);
      assert.match(error.message, new RegExp(`may be open: ${observed}`));
      return true;
    });
    assert.deepEqual(lifecycleActionsRun(io), ran);
    assert.equal(io.events.at(-1).close_kind, 'failed-window');
  }
});

test('the post-open read-back allows exactly the named clock-skew minute and no more', async () => {
  const bound = 60 * 60_000;
  const cases = [
    // Exactly at the requested bound plus the allowance: accepted.
    { openExpiry: new Date(NOW + bound + ADMISSION_WINDOW_CLOCK_SKEW_MS).toISOString(), accepted: true },
    // One millisecond past the allowance: refused.
    { openExpiry: new Date(NOW + bound + ADMISSION_WINDOW_CLOCK_SKEW_MS + 1).toISOString(), accepted: false },
    // Exactly the bound: accepted.
    { openExpiry: new Date(NOW + bound).toISOString(), accepted: true },
    // Expiry equal to now is not a future window: refused.
    { openExpiry: new Date(NOW).toISOString(), accepted: false },
    // Already past: refused.
    { openExpiry: new Date(NOW - 1).toISOString(), accepted: false },
  ];
  for (const { openExpiry, accepted } of cases) {
    const io = mockIo({ operation: 'open-admission', now: NOW, original: closedTuple, openExpiry });
    if (accepted) {
      const result = await open(io);
      assert.equal(result.admission_window_expires_at, openExpiry);
      assert.deepEqual(lifecycleActionsRun(io), ['status', 'open', 'status']);
    } else {
      // The recovery close restored the tuple, so the cause carries the bound failure.
      await assert.rejects(open(io), error => error.cause?.message === 'Observed admission window expiry is outside the requested bound', openExpiry);
      assert.deepEqual(lifecycleActionsRun(io), ['status', 'open', 'status', 'close']);
    }
  }
  // The allowance never widens the dispatch bound itself: 241 minutes is refused.
  const io = mockIo({ operation: 'open-admission', now: NOW, original: closedTuple, windowMinutes: 241 });
  await assert.rejects(open(io, { env: { ...env, WINDOW_MINUTES: '241' } }), /integer from 15 to 240/);
  assert.equal(io.calls.length, 0);
});

test('a failure before the open attempt records no recovery close', async () => {
  const io = mockIo({ operation: 'open-admission', now: NOW, original: closedTuple, omitExpiry: true });
  await assert.rejects(open(io), /failed before it was requested/);
  assert.deepEqual(lifecycleActionsRun(io), ['status']);
  assert.deepEqual(io.events.map(event => [event.phase, event.result]), [['failed', 'failed']]);
});

test('status parser accepts named admission fields and validates optional diagnostics without a drain gate', () => {
  const status = { intake_open: false, admission_suspended: true, tester_count: 0, database_policy_matches_ssm: true };
  assert.equal(parseLifecycleStatus(status), status);
  // The window bound is interpreted by the admission driver, not by the status
  // parser, so an older Service without the field stays readable here.
  assert.equal(parseLifecycleStatus({ ...status, admission_window_expires_at: null }).admission_window_expires_at, null);
  assert.equal(parseLifecycleStatus({ ...status, admission_window_expires_at: 'malformed' }).admission_window_expires_at, 'malformed');
  for (const value of [null, [], {}, { ...status, tester_count: 0.5 }, { ...status, tester_count: 51 },
    { ...status, outboxOldestAgeMs: NaN }, { ...status, outboxStatusCounts: [] }, { ...status, dlqs: null }]) {
    assert.throws(() => parseLifecycleStatus(value));
  }
});
