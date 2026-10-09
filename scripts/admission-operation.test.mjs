import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readAdmissionState, assertClosedAdmission, parseLifecycleStatus, runCloseAdmission } from './admission-operation.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { contentHash } from './json-contract.mjs';

const { selector, manifest, schema } = await createTestInputs(await mkdtemp(path.join(os.tmpdir(), 'infra-admission-')));
const infraSha = '5'.repeat(40);
const env = { GITHUB_SHA: infraSha, GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra',
  GITHUB_RUN_ID: '23', GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1' };
const original = { admission_suspended: false, intake_open: false, tester_emails: ['first@example.com', 'second@example.com'] };
const stackOutputs = Object.fromEntries(['PrivateSubnetIds', 'OneShotSecurityGroupId', 'VerificationTaskRoleArn', 'OneShotExecutionRoleArn',
  'OneShotLogGroupName', 'DatabaseSecretArn', 'DatabaseHost', 'DatabasePort', 'DatabaseName', 'WardrobeBucketName'].map(key => [key, key]));
Object.assign(stackOutputs, { EcsClusterName: 'beta-anywear', BetaActive: 'true' });
const outputEntries = outputs => Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));

function mockIo(options = {}) {
  const calls = []; const events = [];
  const state = structuredClone(options.original ?? original);
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
  return { calls, events, state, async aws(args) {
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
  }, async oneShot(role, revision, action) {
    calls.push(['oneShot', role, revision, action]);
    assert.equal(role, 'lifecycle');
    assert.ok(['close', 'status'].includes(action), 'No reopen, drain, migration, or tester configuration is permitted');
    if (action === 'close') {
      state.admission_suspended = true;
      options.afterClose?.(state);
      if (options.closeError) throw options.closeError;
      return;
    }
    const status = { intake_open: state.intake_open, admission_suspended: state.admission_suspended,
      tester_count: state.tester_emails.length, database_policy_matches_ssm: true,
      tasks: 3, outbox: 2, outboxManualIntervention: 1, outboxOldestAgeMs: 10, outboxManualInterventionOldestAgeMs: null,
      outboxStatusCounts: { pending: 2 }, queues: { vto: { visible: 2, notVisible: 1, delayed: 0 }, tagging: { visible: 0, notVisible: 0, delayed: 0 } },
      dlqs: { vto: { visible: 1, notVisible: 0, delayed: 0 }, tagging: { visible: 0, notVisible: 0, delayed: 0 } } };
    const result = options.status ? options.status(status) : status;
    options.afterStatus?.(state);
    return result;
  }, recordAdmissionState(event) { events.push(structuredClone(event)); } };
}
const operation = (io, extra = {}) => runCloseAdmission({ io, selector, manifest, schema, infraSha, env, ...extra });
const lifecycleCalls = io => io.calls.filter(call => call[0] === 'oneShot');

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

test('close uses selected pinned lifecycle image after real policy/schema verification and accepts diagnostic backlog', async () => {
  const io = mockIo(); const result = await operation(io);
  assert.deepEqual(result.original, original);
  assert.deepEqual(result.state, { ...original, admission_suspended: true });
  assert.equal(result.runtime_verification.schema.compatibility_result, 'compatible');
  assert.equal(result.runtime_verification.schema.applied_schema_version, schema.current_version);
  assert.equal(result.status.outbox, 2);
  assert.deepEqual(lifecycleCalls(io).map(call => call[3]), ['close', 'status']);
  for (const call of lifecycleCalls(io)) {
    assert.equal(call[2].digest, selector.image.digest); assert.equal(call[2].commit, selector.image.service_sha);
    assert.equal(call[2].parameters.ServiceImageDigest, selector.image.digest);
  }
  assert.ok(io.calls.findIndex(call => call[2] === 'deregister-task-definition') < io.calls.findIndex(call => call[0] === 'oneShot'));
  assert.equal(io.calls.filter(call => call[2] === 'register-task-definition').length, 1);
  assert.ok(!io.calls.some(call => ['put-parameter', 'update-stack', 'update-service'].includes(call[2])));
  assert.deepEqual(io.events.map(event => [event.phase, event.result]), [['original', 'observed'], ['closed', 'observed'], ['closed', 'verified']]);
  assert.equal(io.events.at(-1).lifecycle_status_sha256, contentHash(result.status));
});

test('already closed admission remains closed with the same exact testers', async () => {
  const io = mockIo({ original: { ...original, admission_suspended: true } });
  const result = await operation(io);
  assert.deepEqual(result.state, result.original);
  assert.deepEqual(lifecycleCalls(io).map(call => call[3]), ['close', 'status']);
});

test('the four-tester restoration fixture stays intact despite an empty dispatch payload', async () => {
  const admission = { admission_suspended: true, intake_open: false, tester_emails: [
    'e2e-beta-worker-0-chromium@anywear.local', 'e2e-beta-worker-1-chromium@anywear.local', 'luma26c@gmail.com', 'windy005@126.com',
  ] };
  const io = mockIo({ original: admission });
  const result = await operation(io, { env: { ...env, TESTER_EMAILS: '[]' } });
  assert.deepEqual(result.original, admission); assert.deepEqual(result.state, admission);
  assert.equal(result.status.tester_count, 4);
  assert.ok(lifecycleCalls(io).every(call => call.length === 4));
});

test('source, activity, stack, revision, intake, and candidate policy/schema mismatches prevent every close', async () => {
  for (const extra of [{ infraSha: '6'.repeat(40) }, { env: { ...env, GITHUB_REF: 'refs/heads/other' } }, { env: { ...env, AWS_ACCOUNT_ID: '1' } },
    { env: { ...env, GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/integration.yml@refs/heads/main' } }]) {
    const io = mockIo(); await assert.rejects(operation(io, extra)); assert.equal(io.calls.length, 0);
  }
  for (const options of [{ platformActive: 'false' }, { workloadActive: 'false' }, { platformActive: 'unknown' },
    { platformStatus: 'UPDATE_IN_PROGRESS' }, { workloadStatus: 'UPDATE_ROLLBACK_FAILED' },
    { commit: '6'.repeat(40) }, { digest: `sha256:${'6'.repeat(64)}` }, { original: { ...original, intake_open: true } },
    { evidence: { policy_content_sha256: '6'.repeat(64) } }, { evidence: { selected_journal_sha256: '6'.repeat(64) } },
    { evidence: { applied_schema_version: schema.minimum_version - 1 } },
    { evidence: { applied_migration_ids: [{ id: '6'.repeat(64), created_at: 1000 }] } }]) {
    const io = mockIo(options); await assert.rejects(operation(io));
    assert.equal(lifecycleCalls(io).length, 0, JSON.stringify(options));
    assert.equal(io.events.at(-1).phase, 'failed');
  }
});

test('injected verifier receives the already verified selection and rejects before any lifecycle close', async () => {
  const io = mockIo(); let invoked = false;
  await assert.rejects(operation(io, { async verifyRuntime(input) {
    invoked = true; assert.equal(input.selector, selector); assert.equal(input.manifest, manifest);
    assert.equal(input.schema, schema); assert.equal(input.infraSha, infraSha); assert.equal(input.outputs.BetaActive, 'true');
    throw new Error('Applied schema incompatible');
  } }));
  assert.equal(invoked, true); assert.equal(lifecycleCalls(io).length, 0);
});

test('failed close/readback/status preserves observed admission and never implicitly reopens or changes testers', async () => {
  const cases = [
    { closeError: new Error('Pinned close failed') },
    { afterClose(state) { state.admission_suspended = false; } },
    { afterClose(state) { state.tester_emails = []; } },
    { afterClose(state) { state.intake_open = true; } },
    { status() { return undefined; } },
    { status(value) { return { ...value, database_policy_matches_ssm: false }; } },
    { status(value) { return { ...value, tester_count: 0 }; } },
    { status(value) { return { ...value, admission_suspended: false }; } },
    { status(value) { return { ...value, intake_open: true }; } },
    { status(value) { return { ...value, database_policy_matches_ssm: 'true' }; } },
    { status(value) { return { ...value, outbox: -1 }; } },
    { status(value) { return { ...value, queues: { vto: {} } }; } },
    { afterStatus(state) { state.admission_suspended = false; } },
    { afterStatus(state) { state.tester_emails.push('new@example.com'); } },
  ];
  for (const options of cases) {
    const io = mockIo(options); await assert.rejects(operation(io), /closure failed/);
    assert.deepEqual(io.events.at(-1), { phase: 'failed', state: { ...io.state, tester_emails: [...io.state.tester_emails].sort() }, result: 'failed' });
    assert.ok(lifecycleCalls(io).every(call => ['close', 'status'].includes(call[3])));
    assert.ok(!io.calls.some(call => ['put-parameter', 'update-stack', 'update-service'].includes(call[2])));
  }
});

test('unavailable post-close boolean readback records every remaining actual state field', async () => {
  const io = mockIo({ read(key, state, name) {
    if (state.admission_suspended && key === 'intake_open') return {};
    return { Parameter: { Name: name, Value: key === 'tester_emails' ? JSON.stringify(state[key]) : String(state[key]) } };
  } });
  await assert.rejects(operation(io));
  assert.deepEqual(io.events.at(-1).state, { ...original, admission_suspended: true, intake_open: 'unavailable' });
  assert.deepEqual(lifecycleCalls(io).map(call => call[3]), ['close']);
});

test('status parser accepts named admission fields and validates optional diagnostics without a drain gate', () => {
  const status = { intake_open: false, admission_suspended: true, tester_count: 0, database_policy_matches_ssm: true };
  assert.equal(parseLifecycleStatus(status), status);
  for (const value of [null, [], {}, { ...status, tester_count: 0.5 }, { ...status, tester_count: 51 },
    { ...status, outboxOldestAgeMs: NaN }, { ...status, outboxStatusCounts: [] }, { ...status, dlqs: null }]) {
    assert.throws(() => parseLifecycleStatus(value));
  }
});
