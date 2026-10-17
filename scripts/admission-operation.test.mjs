import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readAdmissionState, assertClosedAdmission, assertOpenedAdmission, parseLifecycleStatus,
  classifyCloseKind, compareAdmissionDecision, runSuspendAdmission, runResumeAdmission, assertMigrationAdmissionClosed
} from './admission-operation.mjs';
import { ADMISSION_MODE_MAX_AHEAD_MS, admissionClosureProof, effectiveAdmissionBound, isAdmissionClosed,
  isAdmissionProvablyClosed, parseAdmissionModeValue, resolveAdmissionDecision } from './admission-mode.mjs';
import { ADMISSION_WINDOW_CLOCK_SKEW_MS, admissionWindowPayload } from './admission-window.mjs';
import { assertOneShotAllowed } from './operation-boundaries.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { canonicalJson, contentHash } from './json-contract.mjs';

const { selector, manifest, schema } = await createTestInputs(await mkdtemp(path.join(os.tmpdir(), 'infra-admission-')));
const infraSha = '5'.repeat(40);
const env = { GITHUB_SHA: infraSha, GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra',
  GITHUB_RUN_ID: '23', GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', WINDOW_MINUTES: '60', TESTER_EMAILS: '[]' };
// A fixed clock keeps the recorded expiry arithmetic deterministic.
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const FUTURE = new Date(NOW + 60 * 60_000).toISOString();
const PAST = new Date(NOW - 60 * 60_000).toISOString();
// The two records an operator can find in `/anywear/beta/admission_mode`.
const closedRecord = { mode: 'closed' };
const windowRecord = (expires = FUTURE) => ({ mode: 'testers', expires_at: expires });
const originalTesters = ['first@example.com', 'second@example.com'];
const openMirror = windowRecord();
const closedMirror = closedRecord;
// The closed decision, as `readAdmissionState` reports it.
const closedState = (testers = originalTesters) => ({ admission_mode: 'closed', admission_window_expires_at: null,
  admission_mode_source: 'record', admission_mode_reason: null,
  admission_recorded_mode: 'closed', admission_recorded_expires_at: null, tester_emails: testers });
const stackOutputs = Object.fromEntries(['PrivateSubnetIds', 'OneShotSecurityGroupId', 'VerificationTaskRoleArn', 'OneShotExecutionRoleArn',
  'OneShotLogGroupName', 'DatabaseSecretArn', 'DatabaseHost', 'DatabasePort', 'DatabaseName', 'WardrobeBucketName'].map(key => [key, key]));
Object.assign(stackOutputs, { EcsClusterName: 'beta-anywear', BetaActive: 'true' });
const outputEntries = outputs => Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));

// The dispatch envelope the real one-shot guard reads: the admission entry
// point, the operation under test, the bounded window and no tester payload.
const guardEnv = (operation, windowMinutes) => ({ GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  INFRA_OPERATION: operation, WINDOW_MINUTES: String(windowMinutes), TESTER_EMAILS: '[]' });

// The one-shot mock is operation-scoped: a suspend may run `status` and `suspend`,
// and `resume` is permitted only for the resume operation and only with the exact
// bounded payload the driver builds from the dispatch input. The mock keeps the
// mirror and the stored database decision separate, and reports the status the
// way the Service does: the *effective* mode plus the raw stored pair.
function mockIo(options = {}) {
  const operation = options.operation ?? 'suspend-admission';
  const windowMinutes = options.windowMinutes ?? 60;
  const calls = []; const events = [];
  const world = {
    mirror: structuredClone(options.mirror ?? closedMirror),
    testers: structuredClone(options.testers ?? originalTesters),
    database: undefined,
  };
  world.database = structuredClone(options.database ?? (world.mirror.mode === 'testers'
    ? { admission_mode: 'testers', admission_window_expires_at: world.mirror.expires_at }
    : { admission_mode: 'closed', admission_window_expires_at: null }));
  const now = () => options.now ?? NOW;
  const actionSet = operation === 'resume-admission' ? ['resume', 'suspend', 'status'] : ['suspend', 'status'];
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
    assert.ok(actionSet.includes(action), `No drain, migration, or tester configuration is permitted for ${operation}: ${action}`);
    if (action === 'resume') {
      assert.equal(operation, 'resume-admission', 'Only resume-admission may resume admission');
      assert.equal(payload, admissionWindowPayload({ WINDOW_MINUTES: String(windowMinutes) }),
        'Resume must carry the exact bounded dispatch payload');
      if (options.resumeError) throw options.resumeError;
      const expires = options.resumeExpiry !== undefined ? options.resumeExpiry
        : new Date(now() + (options.resumeMinutes ?? windowMinutes) * 60_000).toISOString();
      world.mirror = expires === null ? { mode: 'testers' } : { mode: 'testers', expires_at: expires };
      world.database = { admission_mode: 'testers', admission_window_expires_at: expires };
      options.afterResume?.(world);
      return;
    }
    if (action === 'suspend') {
      if (options.suspendError) throw options.suspendError;
      world.mirror = closedRecord;
      world.database = { admission_mode: 'closed', admission_window_expires_at: null };
      options.afterSuspend?.(world);
      return;
    }
    const storedMode = world.database.admission_mode;
    const storedExpiry = world.database.admission_window_expires_at ?? null;
    const effective = resolveAdmissionDecision(storedMode, storedExpiry, now());
    // The status shape the delivered Service emits: the effective decision and its
    // effective bound, the raw stored mode, and whether the two differ.
    const status = { admission_mode: effective.admission_mode,
      ...(options.omitExpiry ? {} : { admission_window_expires_at: effectiveAdmissionBound(effective) }),
      admission_record: storedMode, database_record_differs: storedMode !== effective.admission_mode,
      tester_count: world.testers.length, database_policy_matches_ssm: true,
      tasks: 3, outbox: 2, outboxManualIntervention: 1, outboxOldestAgeMs: 10, outboxManualInterventionOldestAgeMs: null,
      outboxStatusCounts: { pending: 2 }, queues: { vto: { visible: 2, notVisible: 1, delayed: 0 }, tagging: { visible: 0, notVisible: 0, delayed: 0 } },
      dlqs: { vto: { visible: 1, notVisible: 0, delayed: 0 }, tagging: { visible: 0, notVisible: 0, delayed: 0 } } };
    const index = statusReads++;
    const result = options.status ? options.status(status, index) : status;
    options.afterStatus?.(world, index);
    return result;
  }, recordAdmissionState(event) { events.push(structuredClone(event)); } };
}
const suspend = (io, extra = {}) => runSuspendAdmission({ io, selector, manifest, schema, infraSha, env, ...extra });
const resume = (io, extra = {}) => runResumeAdmission({ io, selector, manifest, schema, infraSha, env, ...extra });
const lifecycleCalls = io => io.calls.filter(call => call[0] === 'oneShot');
const lifecycleActionsRun = io => lifecycleCalls(io).map(call => call[3]);

// A reader that answers exactly the two admission parameters, so the mode-value
// cases can be swept without a whole operation mock.
function readIo({ mode, testers }) {
  return { now: () => NOW, async aws(args) {
    const name = args.at(-1);
    if (name.endsWith('tester_allowlist')) return { Parameter: { Name: name, Value: testers } };
    return { Parameter: { Name: name, Value: mode } };
  } };
}

// The cross-repository conformance list. Any implementation of the mode value —
// Infra reader, Service gate, Service writer — must agree on every row, so this
// table is the reviewable statement of the contract rather than a local accident.
const CONFORMANCE = [
  // value, effective mode, fail-closed reason, provable, closure proof
  [canonicalJson({ mode: 'closed' }), 'closed', null, true, 'closed'],
  [canonicalJson(windowRecord()), 'testers', null, false, 'open'],
  [canonicalJson(windowRecord(PAST)), 'closed', 'expired', true, 'closed'],
  ['{"mode":"testers"}', 'closed', 'missing-expiry', false, 'unproven'],
  ['{"mode":"closed","expires_at":"2030-01-01T00:00:00.000Z"}', 'closed', 'closed-with-expiry', false, 'unproven'],
  ['{"mode":"open"}', 'closed', 'unknown-mode', false, 'unproven'],
  // Duplicate keys: Node's JSON.parse takes the last, so this must not be a record
  // at all. One implementation must not read it open while another reads closed.
  ['{"mode":"closed","mode":"testers","expires_at":"2030-01-01T00:00:00.000Z"}', 'closed', 'malformed', false, 'unproven'],
  ['{"mode":"closed","extra":1}', 'closed', 'extra-key', false, 'unproven'],
  // An explicit `null` bound is a contradiction, not an absent bound. The writer
  // emits `expires_at` only with a real instant, so the null spelling is refused
  // for its own reason and never reads as "closed, no bound".
  ['{"mode":"closed","expires_at":null}', 'closed', 'null-expiry', false, 'unproven'],
  ['{"mode":"testers","expires_at":null}', 'closed', 'null-expiry', false, 'unproven'],
  ['{"mode":true}', 'closed', 'wrong-type', false, 'unproven'],
  ['not-json', 'closed', 'malformed', false, 'unproven'],
  // The encoding is fixed: whitespace (and any other non-canonical spelling) is
  // refused, matching the Service reader's `JSON.stringify(JSON.parse(value))`
  // rule so the writer and every reader agree on one byte string per decision.
  [' {"mode":"closed"}', 'closed', 'non-canonical', false, 'unproven'],
  ['{"mode":"closed"} ', 'closed', 'non-canonical', false, 'unproven'],
  // This spaced row exercises whitespace only. It is not coverage of the unspaced
  // `{"mode":"closed","expires_at":null}`, which has its own row above and is
  // refused for a different reason.
  ['{"mode":"closed", "expires_at":null}', 'closed', 'non-canonical', false, 'unproven'],
  // Lenient date parsing would accept every one of these as a live bound.
  ['{"mode":"testers","expires_at":"2026-01-02"}', 'closed', 'malformed-expiry', false, 'unproven'],
  ['{"mode":"testers","expires_at":"2026-02-30T00:00:00.000Z"}', 'closed', 'malformed-expiry', false, 'unproven'],
  ['{"mode":"testers","expires_at":"2026/01/02 00:00:00"}', 'closed', 'malformed-expiry', false, 'unproven'],
  ['{"mode":"testers","expires_at":"2026-01-02T00:00:00.000"}', 'closed', 'malformed-expiry', false, 'unproven'],
  ['{"mode":"testers","expires_at":"2026-01-02T08:00:00.000+08:00"}', 'closed', 'malformed-expiry', false, 'unproven'],
  ['{"mode":"testers","expires_at":"2026-01-02T00:00:00Z"}', 'closed', 'malformed-expiry', false, 'unproven'],
  // The ceiling plus the named skew minute is live; one millisecond more is not.
  [JSON.stringify({ mode: 'testers', expires_at: new Date(NOW + ADMISSION_MODE_MAX_AHEAD_MS).toISOString() }),
    'testers', null, false, 'open'],
  [JSON.stringify({ mode: 'testers', expires_at: new Date(NOW + ADMISSION_MODE_MAX_AHEAD_MS + 1).toISOString() }),
    'closed', 'beyond-bound', false, 'unproven'],
];

test('the mode value conformance table: one accepted form, every other row fail-closed and unprovable', () => {
  for (const [value, mode, reason, provable, proof] of CONFORMANCE) {
    const resolution = parseAdmissionModeValue(value, NOW);
    assert.equal(resolution.admission_mode, mode, value);
    assert.equal(resolution.admission_mode_reason, reason, value);
    assert.equal(isAdmissionProvablyClosed(resolution), provable, value);
    assert.equal(admissionClosureProof(resolution), proof, value);
  }
  assert.equal(isAdmissionClosed(parseAdmissionModeValue(canonicalJson({ mode: 'closed' }), NOW)), true);
});

test('the forward-migration fence refuses anything that is not proven closed, including one throttled read', async () => {
  for (const [value, , , , proof] of CONFORMANCE) {
    const events = [];
    const io = { now: () => NOW, async aws(args) { return { Parameter: { Name: args.at(-1), Value: value } }; },
      recordAdmissionState(event) { events.push(event); } };
    if (proof === 'closed') await assertMigrationAdmissionClosed(io);
    else await assert.rejects(assertMigrationAdmissionClosed(io), /does not prove closed admission/);
    assert.equal(events.at(-1).phase, 'migration-fence');
    assert.equal(events.at(-1).proof, proof);
  }
  // A missing record is unproven, not closed, and an unreadable read is not consent.
  for (const value of [undefined, null]) {
    const io = { now: () => NOW, async aws(args) { return { Parameter: { Name: args.at(-1), Value: value } }; } };
    await assert.rejects(assertMigrationAdmissionClosed(io), /does not prove closed admission/);
  }
  const throttled = { now: () => NOW, async aws() { throw new Error('Throttling'); }, recordAdmissionState() {} };
  await assert.rejects(assertMigrationAdmissionClosed(throttled), /unreadable mirror/);
  // The fence offers the same answer to the operation that names itself.
  await assert.rejects(assertMigrationAdmissionClosed(throttled, 'the standalone migrate fence'), /the standalone migrate fence/);
});

test('strict SSM read normalizes testers, keeps the recorded record, and never turns an unreadable field into closed', async () => {
  assert.deepEqual(await readAdmissionState(readIo({ mode: canonicalJson(closedRecord),
    testers: '[" Second@Example.com ", "first@example.com", "SECOND@example.com"]' })), closedState(['first@example.com', 'second@example.com']));
  const windowState = await readAdmissionState(readIo({ mode: canonicalJson(windowRecord()), testers: '[]' }));
  assert.deepEqual(windowState, { admission_mode: 'testers', admission_window_expires_at: FUTURE, admission_mode_source: 'record',
    admission_mode_reason: null, admission_recorded_mode: 'testers', admission_recorded_expires_at: FUTURE, tester_emails: [] });
  // A malformed record is not a failed read: the Service's rule resolves it closed
  // and the record keeps the raw value and the reason. It is still not proof a
  // mutation may act on.
  const malformed = await readAdmissionState(readIo({ mode: 'not-json', testers: '[]' }));
  assert.equal(malformed.admission_mode, 'closed');
  assert.equal(malformed.admission_mode_source, 'fail-closed');
  assert.equal(malformed.admission_mode_reason, 'malformed');
  assert.equal(malformed.admission_recorded_mode, 'unparsed');
  for (const testers of [undefined, '', 'not-json', '{}', '["*@example.com"]']) {
    await assert.rejects(readAdmissionState(readIo({ mode: canonicalJson(closedRecord), testers })), error => {
      assert.equal(error.observedAdmissionState.admission_mode, 'closed');
      assert.equal(error.observedAdmissionState.tester_emails, 'unavailable');
      return true;
    });
  }
  await assert.rejects(readAdmissionState({ async aws() { return { Parameter: { Name: '/unrelated', Value: 'false' } }; } }));
  // An unreadable mode parameter is unavailable, never closed: "unavailable is not
  // false" is what keeps evidence honest about what was actually observed.
  await assert.rejects(readAdmissionState({ async aws(args) {
    if (args.at(-1).endsWith('tester_allowlist')) return { Parameter: { Name: args.at(-1), Value: '["first@example.com"]' } };
    throw new Error('SSM unavailable');
  } }), error => {
    assert.equal(error.observedAdmissionState.admission_mode, 'unavailable');
    assert.deepEqual(error.observedAdmissionState.tester_emails, ['first@example.com']);
    return true;
  });
});

test('closed assertion requires provable closure and the original normalized tester list', () => {
  assertClosedAdmission(closedState(), closedState());
  for (const state of [
    { ...closedState(), admission_mode: 'testers', admission_window_expires_at: FUTURE },
    { ...closedState(), admission_mode_source: 'fail-closed', admission_mode_reason: 'malformed' },
    { ...closedState(), admission_mode_source: 'fail-closed', admission_mode_reason: 'missing' },
    closedState([]),
    { ...closedState(), tester_emails: undefined },
  ]) {
    assert.throws(() => assertClosedAdmission(state, closedState()));
  }
  // The bound ended the window on its own, so the record proves closure.
  assertClosedAdmission({ ...closedState(), admission_mode_reason: 'expired', admission_window_expires_at: PAST,
    admission_recorded_mode: 'testers', admission_recorded_expires_at: PAST }, closedState());
});

test('opened assertion requires the tester mode with the recorded membership unchanged', () => {
  const opened = { admission_mode: 'testers', admission_window_expires_at: FUTURE, admission_mode_source: 'record',
    admission_mode_reason: null, admission_recorded_mode: 'testers', admission_recorded_expires_at: FUTURE,
    tester_emails: originalTesters };
  assertOpenedAdmission(opened, closedState());
  for (const state of [closedState(), { ...opened, tester_emails: [] }, { ...opened, tester_emails: undefined }]) {
    assert.throws(() => assertOpenedAdmission(state, closedState()));
  }
  // A window never changes who is admitted: the tester lane stays the tester lane.
  assert.throws(() => assertOpenedAdmission({ ...opened, tester_emails: [...originalTesters, 'third@example.com'] }, closedState()));
});

test('the effective decision and the raw stored record stay separate across an abandoned window', () => {
  // After an unattended expiry the database still stores `testers` while the
  // effective decision and every gate say `closed`. The comparison reports the
  // effective match, the Service's own raw-vs-effective flag and our raw-vs-mirror
  // flag, so a status line cannot say "testers are admitted" about a closed
  // environment and a disagreeing raw record is visible instead of reconciled.
  const abandonedMirror = { admission_mode: 'closed', admission_window_expires_at: null, admission_mode_source: 'fail-closed',
    admission_mode_reason: 'expired', admission_recorded_mode: 'testers', admission_recorded_expires_at: PAST,
    tester_emails: originalTesters };
  const abandonedStatus = { admission_mode: 'closed', admission_window_expires_at: null, admission_record: 'testers',
    database_record_differs: true, tester_count: 2, database_policy_matches_ssm: true };
  const comparison = compareAdmissionDecision(abandonedStatus, abandonedMirror, NOW);
  assert.equal(comparison.effective_matches, true);
  assert.equal(comparison.database_record_differs, true);
  assert.equal(comparison.mirror_record_differs, false);
  assert.equal(comparison.database.admission_mode, 'closed');
  assert.equal(comparison.database.admission_record, 'testers');
  // A raw record that disagrees with the mirror is called out as well.
  const drifted = compareAdmissionDecision({ ...abandonedStatus, admission_record: 'closed',
    database_record_differs: false }, abandonedMirror, NOW);
  assert.equal(drifted.effective_matches, true);
  assert.equal(drifted.mirror_record_differs, true);
  // A live window never matches a closed mirror, whatever the raw word says.
  assert.equal(compareAdmissionDecision({ ...abandonedStatus, admission_mode: 'testers',
    admission_window_expires_at: FUTURE, admission_record: 'testers', database_record_differs: false },
  abandonedMirror, NOW).effective_matches, false);
  // Classification uses the raw word, so an abandoned window is a recovery
  // suspend even though the effective decision already reads closed.
  assert.equal(classifyCloseKind(abandonedStatus), 'recovery');
  assert.equal(classifyCloseKind({ ...abandonedStatus, admission_record: 'closed', database_record_differs: false }), 'already-closed');
  assert.equal(classifyCloseKind({ admission_mode: 'testers', admission_window_expires_at: FUTURE,
    admission_record: 'testers', database_record_differs: false }), 'ordinary');
  // The effective bound of a closed decision is null, never the recorded instant.
  assert.equal(effectiveAdmissionBound(abandonedMirror), null);
});

test('suspend uses the selected pinned lifecycle image after real policy/schema verification and accepts diagnostic backlog', async () => {
  const io = mockIo({ now: NOW, mirror: openMirror }); const result = await suspend(io);
  assert.deepEqual(result.original, { admission_mode: 'testers', admission_window_expires_at: FUTURE, admission_mode_source: 'record',
    admission_mode_reason: null, admission_recorded_mode: 'testers', admission_recorded_expires_at: FUTURE, tester_emails: originalTesters });
  assert.deepEqual(result.state, closedState());
  assert.equal(result.runtime_verification.schema.compatibility_result, 'compatible');
  assert.equal(result.runtime_verification.schema.applied_schema_version, schema.current_version);
  assert.equal(result.status.outbox, 2);
  // A live window was open, so this suspend ended it as the ordinary one.
  assert.equal(result.close_kind, 'ordinary');
  assert.equal(result.prior_expires_at, FUTURE);
  assert.deepEqual(lifecycleActionsRun(io), ['status', 'suspend', 'status']);
  for (const call of lifecycleCalls(io)) {
    assert.equal(call[2].digest, selector.image.digest); assert.equal(call[2].commit, selector.image.service_sha);
    assert.equal(call[2].parameters.ServiceImageDigest, selector.image.digest);
  }
  const suspendIndex = io.calls.findIndex(call => call[0] === 'oneShot' && call[3] === 'suspend');
  assert.ok(io.calls.findIndex(call => call[2] === 'deregister-task-definition') < suspendIndex);
  assert.equal(io.calls.filter(call => call[2] === 'register-task-definition').length, 1);
  assert.ok(!io.calls.some(call => ['put-parameter', 'update-stack', 'update-service'].includes(call[2])));
  assert.deepEqual(io.events.map(event => [event.phase, event.result]), [['original', 'observed'], ['suspended', 'observed'], ['suspended', 'verified']]);
  // Every phase the suspend writes after classifying carries the classification.
  for (const event of io.events.filter(event => event.phase !== 'original')) {
    assert.equal(event.close_kind, 'ordinary'); assert.equal(event.prior_expires_at, FUTURE);
  }
  assert.equal(io.events.at(-1).lifecycle_status_sha256, contentHash(result.status));
});

test('suspend classifies what it ended from the stored database pair, not from the mirror', async () => {
  const cases = [
    // A live window: the suspend ended it.
    { options: { now: NOW, mirror: windowRecord(FUTURE) }, closeKind: 'ordinary', priorExpiresAt: FUTURE },
    // The bound had already ended an expired window; this suspend restored the record.
    { options: { now: NOW, mirror: windowRecord(PAST) }, closeKind: 'recovery', priorExpiresAt: null },
    // An older Service carried no window at all: still a tester mode, no bound.
    { options: { now: NOW, mirror: closedMirror, database: { admission_mode: 'testers', admission_window_expires_at: null } },
      closeKind: 'recovery', priorExpiresAt: null },
    // An unparseable expiry cannot be proven live, so the bound ended it.
    { options: { now: NOW, mirror: closedMirror, database: { admission_mode: 'testers', admission_window_expires_at: 'not-an-instant' } },
      closeKind: 'recovery', priorExpiresAt: null },
    // The row already stored `closed`: the suspend changed nothing.
    { options: { now: NOW, mirror: closedMirror }, closeKind: 'already-closed', priorExpiresAt: null },
    // An inconsistent closed-with-bound row still reads closed: not a window.
    { options: { now: NOW, mirror: closedMirror, database: { admission_mode: 'closed', admission_window_expires_at: FUTURE } },
      closeKind: 'already-closed', priorExpiresAt: null },
  ];
  for (const { options, closeKind, priorExpiresAt } of cases) {
    const io = mockIo(options); const result = await suspend(io);
    assert.equal(result.close_kind, closeKind, JSON.stringify(options));
    assert.equal(result.prior_expires_at, priorExpiresAt, JSON.stringify(options));
    assert.equal(result.state.admission_mode, 'closed');
    for (const event of io.events.filter(event => event.phase !== 'original')) {
      assert.equal(event.close_kind, closeKind); assert.equal(event.prior_expires_at, priorExpiresAt);
    }
  }
  // The classifier itself is a pure function of the database status read.
  assert.equal(classifyCloseKind({ admission_mode: 'closed', admission_record: 'closed' }), 'already-closed');
  assert.equal(classifyCloseKind({ admission_mode: 'testers', admission_record: 'testers' }), 'ordinary');
  for (const record of ['testers', 'closed', undefined]) {
    assert.equal(classifyCloseKind({ admission_mode: 'closed', admission_record: record }), record === 'testers' ? 'recovery' : 'already-closed');
  }
});

test('already closed admission remains closed with the same exact testers', async () => {
  const io = mockIo({ mirror: closedMirror });
  const result = await suspend(io);
  assert.deepEqual(result.state, result.original);
  assert.deepEqual(result.original, closedState());
  assert.equal(result.close_kind, 'already-closed');
  assert.deepEqual(lifecycleActionsRun(io), ['status', 'suspend', 'status']);
});

test('the four-tester restoration fixture stays intact despite an empty dispatch payload', async () => {
  const testers = ['e2e-beta-worker-0-chromium@anywear.local', 'e2e-beta-worker-1-chromium@anywear.local', 'luma26c@gmail.com', 'windy005@126.com'];
  const io = mockIo({ mirror: closedMirror, testers });
  const result = await suspend(io, { env: { ...env, TESTER_EMAILS: '[]' } });
  assert.deepEqual(result.state.tester_emails, testers);
  assert.equal(result.status.tester_count, 4);
  assert.ok(lifecycleCalls(io).every(call => call.length === 4));
});

test('source, activity, stack, revision and candidate policy/schema mismatches prevent every suspend', async () => {
  for (const extra of [{ infraSha: '6'.repeat(40) }, { env: { ...env, GITHUB_REF: 'refs/heads/other' } }, { env: { ...env, AWS_ACCOUNT_ID: '1' } },
    { env: { ...env, GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/integration.yml@refs/heads/main' } }]) {
    const io = mockIo(); await assert.rejects(suspend(io, extra)); assert.equal(io.calls.length, 0);
  }
  for (const options of [{ platformActive: 'false' }, { workloadActive: 'false' }, { platformActive: 'unknown' },
    { platformStatus: 'UPDATE_IN_PROGRESS' }, { workloadStatus: 'UPDATE_ROLLBACK_FAILED' },
    { commit: '6'.repeat(40) }, { digest: `sha256:${'6'.repeat(64)}` },
    { evidence: { policy_content_sha256: '6'.repeat(64) } }, { evidence: { selected_journal_sha256: '6'.repeat(64) } },
    { evidence: { applied_schema_version: schema.minimum_version - 1 } },
    { evidence: { applied_migration_ids: [{ id: '6'.repeat(64), created_at: 1000 }] } }]) {
    const io = mockIo(options); await assert.rejects(suspend(io));
    assert.equal(lifecycleActionsRun(io).includes('suspend'), false, JSON.stringify(options));
    assert.equal(io.events.at(-1).phase, 'failed');
  }
});

test('injected verifier receives the already verified selection and rejects before any lifecycle suspend', async () => {
  const io = mockIo(); let invoked = false;
  await assert.rejects(suspend(io, { async verifyRuntime(input) {
    invoked = true; assert.equal(input.selector, selector); assert.equal(input.manifest, manifest);
    assert.equal(input.schema, schema); assert.equal(input.infraSha, infraSha); assert.equal(input.outputs.BetaActive, 'true');
    throw new Error('Applied schema incompatible');
  } }));
  assert.equal(invoked, true);
  // The pre-suspend database read is read-only; no suspend ran after the failed verification.
  assert.deepEqual(lifecycleActionsRun(io), ['status']);
});

test('failed suspend/readback/status preserves observed admission and never implicitly resumes or changes testers', async () => {
  const cases = [
    { suspendError: new Error('Pinned suspend failed') },
    { afterSuspend(world) { world.mirror = windowRecord(); } },
    { afterSuspend(world) { world.testers = []; } },
    { status() { return undefined; }, noSuspend: true },
    { status(value) { return { ...value, database_policy_matches_ssm: false }; } },
    { status(value) { return { ...value, tester_count: 0 }; } },
    { status(value, index) { return index === 0 ? value : { ...value, admission_mode: 'testers', admission_window_expires_at: FUTURE }; } },
    { status(value) { return { ...value, database_policy_matches_ssm: 'true' }; }, noSuspend: true },
    { status(value) { return { ...value, outbox: -1 }; }, noSuspend: true },
    { status(value) { return { ...value, queues: { vto: {} } }; }, noSuspend: true },
    { afterStatus(world) { world.mirror = windowRecord(); } },
    { afterStatus(world) { world.testers.push('new@example.com'); } },
  ];
  for (const options of cases) {
    const io = mockIo({ mirror: closedMirror, ...options }); await assert.rejects(suspend(io), /suspension failed/);
    const failure = io.events.at(-1);
    assert.equal(failure.phase, 'failed'); assert.equal(failure.result, 'failed');
    assert.equal(failure.state.admission_mode, io.world.mirror.mode === 'testers' ? 'testers' : 'closed');
    assert.deepEqual(failure.state.tester_emails, [...io.world.testers].sort());
    // Only an attempted suspend carries the classification; earlier failures record none.
    assert.equal(failure.close_kind, options.noSuspend ? undefined : 'already-closed', JSON.stringify(options));
    assert.equal(failure.prior_expires_at, options.noSuspend ? undefined : null, JSON.stringify(options));
    assert.ok(lifecycleActionsRun(io).every(action => ['suspend', 'status'].includes(action)));
    assert.ok(!io.calls.some(call => ['put-parameter', 'update-stack', 'update-service'].includes(call[2])));
  }
});

test('unavailable post-suspend mode readback records every remaining actual state field', async () => {
  const io = mockIo({ mirror: closedMirror });
  const aws = io.aws.bind(io);
  let suspendAttempted = false;
  io.oneShot = ((oneShot) => async (...args) => { const result = await oneShot(...args); if (args[2] === 'suspend') suspendAttempted = true; return result; })(io.oneShot);
  io.aws = async args => {
    if (suspendAttempted && args[0] === 'ssm' && args.at(-1) === '/anywear/beta/admission_mode') throw new Error('SSM unavailable');
    return aws(args);
  };
  await assert.rejects(suspend(io));
  const state = io.events.at(-1).state;
  assert.equal(state.admission_mode, 'unavailable');
  assert.deepEqual(state.tester_emails, originalTesters);
  assert.equal(io.events.at(-1).close_kind, 'already-closed');
  assert.deepEqual(lifecycleActionsRun(io), ['status', 'suspend']);
});

test('resume records the requested bound, both admission phases and the status read-back proving the recorded expiry', async () => {
  const io = mockIo({ operation: 'resume-admission', now: NOW, mirror: closedMirror });
  const result = await resume(io);
  assert.equal(result.window_minutes, 60);
  assert.equal(result.admission_window_expires_at, new Date(NOW + 60 * 60_000).toISOString());
  assert.equal(result.original.admission_mode, 'closed');
  assert.equal(result.state.admission_mode, 'testers');
  assert.equal(result.runtime_verification.schema.compatibility_result, 'compatible');
  assert.deepEqual(lifecycleActionsRun(io), ['status', 'resume', 'status']);
  // The bounded payload is the one the shared builder produces, byte-identical.
  assert.equal(lifecycleCalls(io).find(call => call[3] === 'resume')[4], '{"window_minutes":60}');
  assert.deepEqual(io.events.map(event => [event.phase, event.result]),
    [['original', 'observed'], ['resumed', 'observed'], ['verified', 'verified']]);
  assert.equal(io.events[1].window_minutes, 60);
  assert.equal(io.events[1].admission_window_expires_at, result.admission_window_expires_at);
  assert.equal(io.events[1].state.admission_window_expires_at, result.admission_window_expires_at);
  assert.equal(io.events.at(-1).lifecycle_status_sha256, contentHash(result.status));
  assert.ok(!io.calls.some(call => ['put-parameter', 'update-stack', 'update-service'].includes(call[2])));
});

test('resume honours the dispatch bound instead of a fixed default', async () => {
  for (const minutes of [15, 60, 240]) {
    const io = mockIo({ operation: 'resume-admission', now: NOW, mirror: closedMirror, windowMinutes: minutes });
    const result = await resume(io, { env: { ...env, WINDOW_MINUTES: String(minutes) } });
    assert.equal(result.window_minutes, minutes);
    assert.equal(result.admission_window_expires_at, new Date(NOW + minutes * 60_000).toISOString());
    assert.equal(lifecycleCalls(io).find(call => call[3] === 'resume')[4], admissionWindowPayload({ WINDOW_MINUTES: String(minutes) }));
  }
});

test('resume refuses before requesting a window when the Service cannot carry the bound or the record is not provably closed', async () => {
  const cases = [
    // An older Service cannot enforce a bound: the field's absence is the fence.
    { omitExpiry: true },
    // The effective database decision is still the tester mode: not the closed one.
    { database: { admission_mode: 'testers', admission_window_expires_at: FUTURE } },
    // The database and the SSM mirror must agree.
    { status(value) { return { ...value, database_policy_matches_ssm: false }; } },
    // The mirror does not prove closure: a value that cannot prove it is repaired
    // by suspend-admission, not bypassed by a window.
    { mirror: { mode: 'testers' }, database: { admission_mode: 'closed', admission_window_expires_at: null } },
    { mirror: { mode: 'closed', expires_at: FUTURE }, database: { admission_mode: 'closed', admission_window_expires_at: null } },
    { mirror: { mode: 'open' }, database: { admission_mode: 'closed', admission_window_expires_at: null } },
    // An unknown extra key means the value is not a record this reader understands.
    { mirror: { mode: 'closed', mode2: 'testers' }, database: { admission_mode: 'closed', admission_window_expires_at: null } },
  ];
  for (const options of cases) {
    const io = mockIo({ now: NOW, operation: 'resume-admission', mirror: closedMirror, ...options });
    await assert.rejects(resume(io), /admission window failed before it was requested/);
    assert.deepEqual(lifecycleActionsRun(io), ['status'], JSON.stringify(options));
    const failure = io.events.at(-1);
    assert.equal(failure.phase, 'failed'); assert.equal(failure.result, 'failed');
    assert.equal(failure.close_kind, undefined, 'No suspend is attempted when nothing was resumed');
  }
  // Inactive, unstable or unselected Beta never reaches a lifecycle task at all.
  for (const options of [{ platformActive: 'false' }, { workloadStatus: 'UPDATE_IN_PROGRESS' }, { commit: '6'.repeat(40) },
    { digest: `sha256:${'6'.repeat(64)}` }]) {
    const io = mockIo({ now: NOW, operation: 'resume-admission', mirror: closedMirror, ...options });
    await assert.rejects(resume(io), /admission window failed before it was requested/);
    assert.equal(lifecycleCalls(io).length, 0, JSON.stringify(options));
    assert.equal(io.events.at(-1).phase, 'failed');
  }
  // An out-of-range or missing dispatch bound is refused before any AWS activity.
  for (const minutes of ['14', '241', '60.5', '', undefined]) {
    const io = mockIo({ operation: 'resume-admission', now: NOW, mirror: closedMirror });
    await assert.rejects(resume(io, { env: { ...env, WINDOW_MINUTES: minutes } }), /integer from 15 to 240/);
    assert.equal(io.calls.length, 0);
  }
});

test('a window that fails after resuming still suspends and records close_kind failed-window', async () => {
  const cases = [
    // The recorded expiry claims a longer window than the dispatch requested.
    { resumeMinutes: 62, ran: ['status', 'resume', 'status', 'suspend'] },
    // The recorded expiry is already in the past.
    { resumeExpiry: PAST, ran: ['status', 'resume', 'suspend'] },
    // A malformed expiry proves nothing.
    { resumeExpiry: 'not-an-instant', ran: ['status', 'resume', 'suspend'] },
    // No expiry at all is not a bounded window.
    { resumeExpiry: null, ran: ['status', 'resume', 'suspend'] },
    // The resumed record itself is wrong: the mode stayed closed.
    { afterResume(world) { world.mirror = closedRecord; }, ran: ['status', 'resume', 'suspend'] },
    // The post-resume status read-back itself fails.
    { status(value, index) { return index === 0 ? value : undefined; }, ran: ['status', 'resume', 'status', 'suspend'] },
    // The post-resume status reports a mismatched database policy.
    { status(value, index) { return index === 0 ? value : { ...value, database_policy_matches_ssm: false }; }, ran: ['status', 'resume', 'status', 'suspend'] },
  ];
  for (const { ran, ...options } of cases) {
    const io = mockIo({ operation: 'resume-admission', now: NOW, mirror: closedMirror, ...options });
    await assert.rejects(resume(io), /admission window failed and was suspended back to the recorded decision/);
    assert.deepEqual(lifecycleActionsRun(io), ran, JSON.stringify(options));
    // The recovery suspend restored the recorded decision; the record names it.
    const suspended = io.events.find(event => event.phase === 'suspended');
    assert.equal(suspended.state.admission_mode, 'closed');
    assert.deepEqual(suspended.state.tester_emails, originalTesters);
    assert.equal(suspended.close_kind, 'failed-window');
    const failure = io.events.at(-1);
    assert.equal(failure.phase, 'failed'); assert.equal(failure.result, 'failed');
    assert.equal(failure.close_kind, 'failed-window');
    assert.equal(failure.state.admission_mode, 'closed');
  }
  // A failed window never leaves suspension lifted: the last mirror read is closed.
  const io = mockIo({ operation: 'resume-admission', now: NOW, mirror: closedMirror, resumeMinutes: 240 });
  await assert.rejects(resume(io));
  assert.equal((await readAdmissionState(io)).admission_mode, 'closed');
});

test('the real one-shot guard admits the recovery suspend so a failed window can restore the decision', async () => {
  // The mock runs the reviewed guard for every one-shot, so this fails if the
  // recovery suspend stops being allowed for resume-admission: the failure path
  // would leave suspension lifted instead of restoring the recorded decision.
  const io = mockIo({ operation: 'resume-admission', now: NOW, mirror: closedMirror, resumeMinutes: 62 });
  await assert.rejects(resume(io), error => error.cause?.message === 'Observed admission window expiry is outside the requested bound');
  assert.deepEqual(lifecycleActionsRun(io), ['status', 'resume', 'status', 'suspend']);
  const suspended = io.events.find(event => event.phase === 'suspended');
  assert.equal(suspended.state.admission_mode, 'closed');
  assert.equal(suspended.close_kind, 'failed-window');
  assert.equal(io.events.at(-1).close_kind, 'failed-window');
  assert.equal((await readAdmissionState(io)).admission_mode, 'closed');
  // The guard itself, not only the driver, is what permits it.
  assertOneShotAllowed(guardEnv('resume-admission', 60), 'lifecycle', 'suspend');
  assert.throws(() => assertOneShotAllowed(guardEnv('suspend-admission', 60), 'lifecycle', 'resume', '{"window_minutes":60}'), /forbidden/);
});

test('a recovery suspend that cannot restore the decision aggregates the original error and names the unsafe state', async () => {
  const cases = [
    // The window also changed the tester list, which the suspend does not revert.
    { resumeMinutes: 120, afterResume(world) { world.testers.push('third@example.com'); },
      first: 'Beta tester list changed during the admission window', ran: ['status', 'resume', 'suspend'],
      observed: 'may be open: admission_mode=closed, admission_window_expires_at=none, recorded_mode=closed, tester_count=3' },
    // The recovery suspend itself fails while admission is still lifted.
    { resumeMinutes: 120, suspendError: new Error('suspend unavailable'),
      first: 'Observed admission window expiry is outside the requested bound', ran: ['status', 'resume', 'status', 'suspend'],
      observed: 'may be open: admission_mode=testers, admission_window_expires_at=' },
  ];
  for (const { first, observed, ran, ...options } of cases) {
    const io = mockIo({ operation: 'resume-admission', now: NOW, mirror: closedMirror, ...options });
    await assert.rejects(resume(io), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[0].message, first);
      assert.equal(error.cause, error.errors[0]);
      assert.ok(error.message.includes(observed), error.message);
      return true;
    });
    assert.deepEqual(lifecycleActionsRun(io), ran);
    assert.equal(io.events.at(-1).close_kind, 'failed-window');
  }
});

test('the post-resume read-back allows exactly the named clock-skew minute and no more', async () => {
  const bound = 60 * 60_000;
  const accepted = [
    // Exactly at the requested bound plus the allowance.
    bound + ADMISSION_WINDOW_CLOCK_SKEW_MS,
    // Exactly the bound.
    bound,
  ];
  for (const ahead of accepted) {
    const resumeExpiry = new Date(NOW + ahead).toISOString();
    const io = mockIo({ operation: 'resume-admission', now: NOW, mirror: closedMirror, resumeExpiry });
    const result = await resume(io);
    assert.equal(result.admission_window_expires_at, resumeExpiry);
    assert.deepEqual(lifecycleActionsRun(io), ['status', 'resume', 'status']);
  }
  const refused = [
    // One millisecond past the allowance: the status read-back refuses it.
    { ahead: bound + ADMISSION_WINDOW_CLOCK_SKEW_MS + 1, cause: /outside the requested bound/,
      ran: ['status', 'resume', 'status', 'suspend'] },
    // Expiry equal to now is not a future window: the mirror itself reads closed.
    { ahead: 0, cause: /not proven open/, ran: ['status', 'resume', 'suspend'] },
    // Already past: the mirror itself reads closed.
    { ahead: -1, cause: /not proven open/, ran: ['status', 'resume', 'suspend'] },
  ];
  for (const { ahead, cause, ran } of refused) {
    const resumeExpiry = new Date(NOW + ahead).toISOString();
    const io = mockIo({ operation: 'resume-admission', now: NOW, mirror: closedMirror, resumeExpiry });
    // The recovery suspend restored the decision, so the cause carries the failure.
    await assert.rejects(resume(io), error => cause.test(error.cause?.message ?? ''), resumeExpiry);
    assert.deepEqual(lifecycleActionsRun(io), ran);
  }
  // The allowance never widens the dispatch bound itself: 241 minutes is refused.
  const io = mockIo({ operation: 'resume-admission', now: NOW, mirror: closedMirror, windowMinutes: 241 });
  await assert.rejects(resume(io, { env: { ...env, WINDOW_MINUTES: '241' } }), /integer from 15 to 240/);
  assert.equal(io.calls.length, 0);
});

test('a failure before the resume attempt records no recovery suspend', async () => {
  const io = mockIo({ operation: 'resume-admission', now: NOW, mirror: closedMirror, omitExpiry: true });
  await assert.rejects(resume(io), /failed before it was requested/);
  assert.deepEqual(lifecycleActionsRun(io), ['status']);
  assert.deepEqual(io.events.map(event => [event.phase, event.result]), [['failed', 'failed']]);
});

test('status parser accepts the effective decision, the raw stored record and optional diagnostics without a drain gate', () => {
  const status = { admission_mode: 'closed', admission_record: 'closed', database_record_differs: false,
    tester_count: 0, database_policy_matches_ssm: true };
  assert.equal(parseLifecycleStatus(status), status);
  // The window bound is interpreted by the admission driver, not by the status
  // parser, so an older Service without the field stays readable here.
  assert.equal(parseLifecycleStatus({ ...status, admission_window_expires_at: null }).admission_window_expires_at, null);
  assert.equal(parseLifecycleStatus({ ...status, admission_window_expires_at: FUTURE }).admission_window_expires_at, FUTURE);
  // The raw stored record is reported separately from the effective decision.
  assert.equal(parseLifecycleStatus({ ...status, admission_record: 'testers', database_record_differs: true }).admission_record, 'testers');
  for (const value of [null, [], {}, { ...status, admission_mode: 'open' }, { ...status, admission_mode: true },
    { ...status, admission_record: 'open' }, { ...status, admission_record: undefined },
    { ...status, database_record_differs: 'false' }, { ...status, database_policy_matches_ssm: undefined },
    { ...status, tester_count: 0.5 }, { ...status, tester_count: 51 }, { ...status, admission_window_expires_at: 5 },
    { ...status, outboxOldestAgeMs: NaN }, { ...status, outboxStatusCounts: [] }, { ...status, dlqs: null }]) {
    assert.throws(() => parseLifecycleStatus(value));
  }
});
