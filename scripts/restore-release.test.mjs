import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runRestoreRelease } from './restore-release.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { canonicalJson, sha256 } from './json-contract.mjs';

const { selector, manifest, schema } = await createTestInputs(await mkdtemp(path.join(os.tmpdir(), 'infra-restore-')));
const infraSha = '5'.repeat(40);
const env = { GITHUB_SHA: infraSha, GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra',
  GITHUB_RUN_ID: '23', GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/beta-deploy.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true', TESTER_EMAILS: '[]' };
const platformName = 'AnyWearPlatformStack-beta'; const workloadName = 'AnyWearWorkloadStack-beta';
const fourTesters = ['beta-worker-0@example.com', 'beta-worker-1@example.com', 'first@example.com', 'second@example.com'];
const outputs = Object.fromEntries(['PrivateSubnetIds', 'OneShotSecurityGroupId', 'VerificationTaskRoleArn', 'OneShotExecutionRoleArn',
  'OneShotLogGroupName', 'DatabaseSecretArn', 'DatabaseHost', 'DatabasePort', 'DatabaseName', 'WardrobeBucketName'].map(key => [key, key]));
Object.assign(outputs, { EcsClusterName: 'beta-anywear', BetaActive: 'true' });
const entries = (values, nameKey, valueKey) => Object.entries(values).map(([name, value]) => ({ [nameKey]: name, [valueKey]: value }));
const stackOutputs = values => entries(values, 'OutputKey', 'OutputValue');

function fixture(options = {}) {
  const calls = []; const actions = []; const stages = []; const states = []; const recovery = [];
  const admission = { admission_suspended: 'true', intake_open: 'false', tester_allowlist: canonicalJson(options.testers ?? fourTesters), ...options.admission };
  const preserved = { VlmConfigArn: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:retained-vlm', CloudFrontPrefixListId: 'pl-retained',
    ...(options.preParameters ? {} : { BetaApiSizingProfile: 's2-api', BetaSizingTelemetry: 'true' }) };
  const originalParameters = { ServiceImageDigest: `sha256:${'a'.repeat(64)}`, ServiceCommitSha: 'b'.repeat(40), ...preserved };
  const platform = { StackStatus: 'UPDATE_COMPLETE', Outputs: stackOutputs(outputs) };
  const workload = { StackStatus: 'UPDATE_COMPLETE', Parameters: entries(originalParameters, 'ParameterKey', 'ParameterValue'),
    Outputs: stackOutputs({ BetaActive: 'true', ApiBaseUrl: 'https://retained.example.com', ApiServiceName: 'beta-anywear-api' }) };
  let waits = 0;
  const io = { calls, actions, stages, states, recovery, admission, platform, workload, preserved, originalParameters,
    async aws(args) {
      calls.push(structuredClone(args));
      if (args[0] === 'cloudformation' && args[1] === 'describe-stacks') {
        const name = args[args.indexOf('--stack-name') + 1];
        assert.ok([platformName, workloadName].includes(name));
        return { Stacks: [structuredClone(name === platformName ? platform : workload)] };
      }
      if (args[0] === 'ssm' && args[1] === 'get-parameter') {
        const name = args[args.indexOf('--name') + 1];
        const key = name.split('/').at(-1); assert.ok(Object.hasOwn(admission, key));
        return { Parameter: { Name: name, Value: admission[key] } };
      }
      if (args[0] === 'ecs' && args[1] === 'wait' && args[2] === 'services-stable') {
        assert.deepEqual(args, ['ecs', 'wait', 'services-stable', '--cluster', 'beta-anywear', '--services', 'beta-anywear-api', 'beta-anywear-worker']);
        actions.push('services-stable');
        if (++waits === options.failWait) throw new Error('Services failed to stabilize');
        return {};
      }
      assert.fail(`Unexpected AWS action: ${args.slice(0, 3).join(' ')}`);
    },
    async deploy(name, active, revision) {
      actions.push(name === workloadName ? 'deploy-workload' : 'deploy-platform');
      assert.ok([platformName, workloadName].includes(name)); assert.equal(active, true);
      assert.equal(revision.digest, selector.image.digest); assert.equal(revision.commit, selector.image.service_sha);
      assert.deepEqual(revision.parameters, { ...originalParameters, ServiceImageDigest: selector.image.digest, ServiceCommitSha: selector.image.service_sha });
      if (options.failDeploy === name) throw new Error('Deployment failed');
      if (name === workloadName) {
        workload.Parameters = entries(revision.parameters, 'ParameterKey', 'ParameterValue');
        if (options.materializeDefaults) workload.Parameters.push(
          { ParameterKey: 'BetaApiSizingProfile', ParameterValue: 's1' }, { ParameterKey: 'BetaSizingTelemetry', ParameterValue: 'false' });
        if (options.parameterDrift) workload.Parameters.find(row => row.ParameterKey === options.parameterDrift).ParameterValue = 'unreviewed';
        if (options.activityDrift) workload.Outputs.find(row => row.OutputKey === 'BetaActive').OutputValue = 'false';
        if (options.workloadInterfaceDrift) workload.Outputs.find(row => row.OutputKey === 'ApiBaseUrl').OutputValue = 'https://changed.example.com';
      }
      if (name === platformName && options.platformInterfaceDrift) platform.Outputs.push({ OutputKey: 'Unexpected', OutputValue: 'drift' });
      if (name === options.admissionDriftAfterDeploy) admission.intake_open = 'true';
    },
    async verifyHealth(url, revision) {
      actions.push('health'); assert.equal(url, 'https://retained.example.com');
      assert.equal(revision.digest, selector.image.digest); assert.equal(revision.commit, selector.image.service_sha);
      if (options.failHealth) throw new Error('Health mismatch');
    },
    async oneShot(role, revision, url) {
      actions.push(`one-shot:${role}`); assert.equal(role, 'verify'); assert.equal(url, 'https://retained.example.com');
      assert.equal(revision.digest, selector.image.digest); assert.equal(revision.commit, selector.image.service_sha);
      if (options.failVerify) throw new Error('Selected verification failed');
      if (options.finalAdmissionDrift) admission.tester_allowlist = '[]';
    },
    recordRestoreStage(value) { stages.push(structuredClone(value)); options.onStage?.(value, io); },
    recordRestoreState(value) { states.push(structuredClone(value)); },
    recordRecovery(value) { recovery.push(value); },
  };
  const verifyRuntime = async input => {
    actions.push('candidate-verification');
    assert.deepEqual(input.outputs, outputs); assert.equal(input.selector, selector);
    assert.equal(input.manifest, manifest); assert.equal(input.schema, schema); assert.equal(input.infraSha, infraSha);
    if (options.failCandidate) throw new Error('Candidate policy/schema mismatch');
    return { schema: { compatibility_result: 'compatible' }, policy_content_sha256: manifest.components.runtime_policy.content_sha256 };
  };
  return { io, input: { io, selector, manifest, schema, infraSha, env: { ...env }, verifyRuntime } };
}

test('restore verifies a different candidate first, selects both stacks in order and preserves four original testers and interfaces', async () => {
  const { io, input } = fixture(); const result = await runRestoreRelease(input);
  assert.deepEqual(io.actions, ['candidate-verification', 'deploy-workload', 'services-stable', 'deploy-platform', 'services-stable', 'health', 'one-shot:verify']);
  assert.deepEqual(io.stages.filter(row => row.result === 'succeeded').map(row => row.stage), [
    'preconditions', 'candidate-verification', 'workload-deploy', 'workload-stable-readback', 'platform-deploy', 'selected-runtime-qualification', 'final-readback',
  ]);
  assert.deepEqual(io.originalParameters, { ServiceImageDigest: `sha256:${'a'.repeat(64)}`, ServiceCommitSha: 'b'.repeat(40), ...io.preserved });
  assert.deepEqual(result.selected_revision.parameters, { ...io.originalParameters, ServiceImageDigest: selector.image.digest, ServiceCommitSha: selector.image.service_sha });
  assert.deepEqual(result.admission, { admission_suspended: true, intake_open: false, tester_count: 4,
    tester_allowlist_sha256: sha256(canonicalJson(fourTesters)) });
  assert.deepEqual(io.states, []); assert.deepEqual(io.recovery, []);
  assert.equal(io.admission.tester_allowlist, canonicalJson(fourTesters));
  assert.ok(!JSON.stringify(result).includes('first@example.com'));
});

test('invalid source, executor, phase or retention fails before authenticated reads or candidate tasks', async () => {
  for (const change of [{ GITHUB_SHA: '6'.repeat(40) }, { GITHUB_REF: 'refs/heads/other' }, { GITHUB_REPOSITORY: 'git-malu/AnyWear-Service' },
    { GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main' },
    { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/other.yml@refs/heads/main' }, { AWS_ACCOUNT_ID: '000000000000' },
    { INFRA_IDENTITY_PHASE: 'roles-added' }, { INFRA_RETENTION_PROTECTION: 'false' }]) {
    const { io, input } = fixture(); input.env = { ...input.env, ...change };
    await assert.rejects(runRestoreRelease(input)); assert.deepEqual(io.calls, []); assert.deepEqual(io.actions, []);
  }
});

test('restore normalizes pre-parameter S1/off source after defaults materialize during deployment', async () => {
  const { io, input } = fixture({ preParameters: true, materializeDefaults: true });
  await runRestoreRelease(input);
  assert.deepEqual(io.workload.Parameters.filter(row => row.ParameterKey.startsWith('Beta')), [
    { ParameterKey: 'BetaApiSizingProfile', ParameterValue: 's1' }, { ParameterKey: 'BetaSizingTelemetry', ParameterValue: 'false' },
  ]);
  assert.equal(io.stages.at(-1).stage, 'final-readback');
  assert.equal(io.stages.at(-1).result, 'succeeded');
});

test('restore final readback rejects a valid but changed sizing profile or telemetry setting', async () => {
  for (const [key, value] of [['BetaApiSizingProfile', 's1'], ['BetaSizingTelemetry', 'false']]) {
    const { io, input } = fixture({ onStage(stage, currentIo) {
      if (stage.stage === 'selected-runtime-qualification' && stage.result === 'succeeded') {
        currentIo.workload.Parameters.find(row => row.ParameterKey === key).ParameterValue = value;
      }
    } });
    await assert.rejects(runRestoreRelease(input), error => {
      assert.match(error.message, /failed at final-readback/);
      assert.match(error.cause.message, /retained Beta sizing parameter readback mismatch/);
      return true;
    });
    assert.deepEqual(io.recovery, ['requires-explicit-recovery']);
  }
});

test('inactive, mixed, unstable or open admission performs no candidate task or deploy and preserves failure readback', async () => {
  const cases = [
    io => { for (const stack of [io.platform, io.workload]) stack.Outputs.find(row => row.OutputKey === 'BetaActive').OutputValue = 'false'; },
    io => { io.workload.Outputs.find(row => row.OutputKey === 'BetaActive').OutputValue = 'false'; },
    io => { io.platform.StackStatus = 'UPDATE_IN_PROGRESS'; },
    io => { io.workload.StackStatus = 'UPDATE_ROLLBACK_COMPLETE'; },
    io => { io.admission.admission_suspended = 'false'; },
    io => { io.admission.intake_open = 'true'; },
    io => { io.admission.tester_allowlist = 'malformed'; },
  ];
  for (const mutate of cases) {
    const { io, input } = fixture(); mutate(io); await assert.rejects(runRestoreRelease(input), /explicit recovery required/);
    assert.deepEqual(io.actions, []); assert.equal(io.states[0].failure_stage, 'preconditions');
    assert.deepEqual(io.recovery, ['requires-explicit-recovery']); assert.equal(io.states[0].image_digest, io.originalParameters.ServiceImageDigest);
    assert.ok(!JSON.stringify(io.states).includes('first@example.com'));
  }
});

test('candidate verification failure prevents either CFN deploy and every admission/lifecycle mutation', async () => {
  const { io, input } = fixture({ failCandidate: true });
  await assert.rejects(runRestoreRelease(input), /failed at candidate-verification/);
  assert.deepEqual(io.actions, ['candidate-verification']); assert.equal(io.states[0].admission_suspended, true);
  assert.equal(io.states[0].intake_open, false); assert.equal(io.states[0].tester_count, 4);
});

test('each deploy, stability, health and verification failure stops without automatic sibling deploy or revert', async () => {
  for (const [options, stage, expectedDeploys] of [
    [{ failDeploy: workloadName }, 'workload-deploy', ['deploy-workload']],
    [{ failWait: 1 }, 'workload-stable-readback', ['deploy-workload']],
    [{ failDeploy: platformName }, 'platform-deploy', ['deploy-workload', 'deploy-platform']],
    [{ failWait: 2 }, 'selected-runtime-qualification', ['deploy-workload', 'deploy-platform']],
    [{ failHealth: true }, 'selected-runtime-qualification', ['deploy-workload', 'deploy-platform']],
    [{ failVerify: true }, 'selected-runtime-qualification', ['deploy-workload', 'deploy-platform']],
  ]) {
    const { io, input } = fixture(options); await assert.rejects(runRestoreRelease(input), /explicit recovery required/);
    assert.deepEqual(io.actions.filter(action => action.startsWith('deploy-')), expectedDeploys);
    assert.equal(io.states[0].failure_stage, stage); assert.deepEqual(io.recovery, ['requires-explicit-recovery']);
    assert.equal(io.stages.at(-1).result, 'failed');
    assert.ok(!io.actions.includes('one-shot:verify') || options.failVerify);
  }
});

test('parameter, activity, output and admission drift abort at the next boundary with actual readback', async () => {
  for (const [options, stage] of [
    [{ parameterDrift: 'VlmConfigArn' }, 'workload-stable-readback'],
    [{ parameterDrift: 'ServiceImageDigest' }, 'workload-stable-readback'],
    [{ parameterDrift: 'BetaApiSizingProfile' }, 'workload-stable-readback'],
    [{ parameterDrift: 'BetaSizingTelemetry' }, 'workload-stable-readback'],
    [{ activityDrift: true }, 'workload-stable-readback'],
    [{ workloadInterfaceDrift: true }, 'workload-stable-readback'],
    [{ platformInterfaceDrift: true }, 'selected-runtime-qualification'],
    [{ admissionDriftAfterDeploy: workloadName }, 'workload-deploy'],
    [{ finalAdmissionDrift: true }, 'selected-runtime-qualification'],
    [{ onStage(value, io) { if (value.stage === 'candidate-verification' && value.result === 'succeeded') io.admission.tester_allowlist = '[]'; } }, 'workload-deploy'],
  ]) {
    const { io, input } = fixture(options); await assert.rejects(runRestoreRelease(input), /explicit recovery required/);
    assert.equal(io.states[0].failure_stage, stage); assert.deepEqual(io.recovery, ['requires-explicit-recovery']);
    assert.equal(io.actions.filter(action => action === 'deploy-workload').length, stage === 'workload-deploy' && options.onStage ? 0 : 1);
    if (stage === 'workload-stable-readback' || stage === 'workload-deploy') assert.ok(!io.actions.includes('deploy-platform'));
    if (options.finalAdmissionDrift) assert.equal(io.states[0].tester_count, 0);
  }
});

test('failed readback remains bounded and redacted even when one SSM value and evidence hooks fail', async () => {
  const { io, input } = fixture({ failCandidate: true });
  input.verifyRuntime = async () => { io.admission.admission_suspended = 'unavailable-secret-text'; throw new Error('Precheck failed'); };
  io.recordRestoreStage = value => { if (value.result === 'failed') throw new Error('Evidence hook failed'); };
  await assert.rejects(runRestoreRelease(input), /failed at candidate-verification/);
  assert.equal(io.states[0].admission_suspended, 'unavailable'); assert.equal(io.states[0].intake_open, false);
  assert.equal(io.states[0].tester_count, 4); assert.ok(!JSON.stringify(io.states).includes('secret-text'));
  assert.deepEqual(io.recovery, ['requires-explicit-recovery']); assert.deepEqual(io.actions, []);
});

test('real candidate verifier rejects changed raw policy bytes despite matching canonical policy and schema, before any CFN deploy', async () => {
  const { io, input } = fixture(); delete input.verifyRuntime;
  const fallback = io.aws.bind(io); let definition;
  const taskArn = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'c'.repeat(32)}`;
  const taskDefinitionArn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-artifact-verify:1';
  const migrations = schema.migrations.map(row => ({ id: row.sha256, created_at: row.created_at }));
  const evidence = { record_type: 'anywear_read_only_runtime', schema_version: 1, service_sha: selector.image.service_sha, image_digest: selector.image.digest,
    policy_file_sha256: 'e'.repeat(64), policy_content_sha256: manifest.components.runtime_policy.content_sha256,
    selected_journal_sha256: manifest.components.schema.journal_sha256, selected_migration_ids: migrations,
    applied_schema_version: schema.current_version, applied_migration_ids: migrations, observed_applied_journal_sha256: sha256(canonicalJson(migrations)) };
  io.aws = async args => {
    if (['cloudformation', 'ssm'].includes(args[0])) return fallback(args);
    io.calls.push(args);
    switch (args[1]) {
      case 'register-task-definition': definition = JSON.parse(args[args.indexOf('--cli-input-json') + 1]); return { taskDefinition: { taskDefinitionArn } };
      case 'run-task': return { tasks: [{ taskArn }] };
      case 'wait': return {};
      case 'describe-tasks': return { tasks: [{ taskArn, taskDefinitionArn, lastStatus: 'STOPPED', containers: [{ name: 'OneShot', exitCode: 0, imageDigest: selector.image.digest }] }] };
      case 'describe-task-definition': return { taskDefinition: definition };
      case 'get-log-events': return { events: [{ message: `ANYWEAR_RUNTIME_EVIDENCE:${JSON.stringify(evidence)}` }] };
      case 'deregister-task-definition': return {};
      default: assert.fail(`Unexpected candidate AWS action: ${args.slice(0, 3).join(' ')}`);
    }
  };
  await assert.rejects(runRestoreRelease(input), error => {
    assert.match(error.message, /failed at candidate-verification/);
    assert.match(error.cause.message, /Immutable image policy\/journal identity mismatch/); return true;
  });
  assert.deepEqual(io.actions, []); assert.ok(io.calls.some(call => call[1] === 'run-task'));
  assert.ok(io.calls.some(call => call[1] === 'deregister-task-definition'));
  assert.ok(!io.calls.some(call => call[0] === 'ssm' && call[1] !== 'get-parameter'));
});
