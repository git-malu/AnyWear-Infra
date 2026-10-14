import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { workflowOperations, operationBoundary, sessionPolicy, assertAwsAllowed, assertOneShotAllowed, assertDeployAllowed } from './operation-boundaries.mjs';
import { validateOperationInputs, credentialEnvironment, createRuntimeIo } from './runtime-operation.mjs';
import { createTestInputs, stackManifestFixture } from './create-test-inputs.mjs';
import { canonicalJson, sha256 } from './json-contract.mjs';
import { observeBetaState } from './observe-beta-state.mjs';
import { finalizeOperationRecord } from './finalize-operation.mjs';
import { createOperationRecord } from './operation-record.mjs';
import { validateDeploymentRecord } from './deployment-contract.mjs';
import { runtimeCommandBytes } from './runtime-command.mjs';

const envFor = (workflow, operation) => ({ GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
  GITHUB_SHA: '5'.repeat(40), GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: `git-malu/AnyWear-Infra/${workflow}@refs/heads/main`, GITHUB_RUN_ID: '23', GITHUB_RUN_ATTEMPT: '1',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_DEPLOY: 'true',
  INFRA_OPERATION: operation, INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true', TESTER_EMAILS: '[]',
  SELECTION_FILE: 'selections/beta.json', SELECTION_SHA256: 'a'.repeat(64),
  INFRA_RUNTIME_ROLE_ARN: 'arn:aws:iam::650880818323:role/beta-infra-runtime-role',
  INFRA_DEPLOY_ROLE_ARN: 'arn:aws:iam::650880818323:role/beta-infra-deploy-role' });
const stateEnv = () => ({ ...envFor('.github/workflows/beta-observe.yml', 'state'), ENABLE_BETA_DEPLOY: 'false' });

test('six manual entry schemas select only their family and preserve the protected shared queue', async () => {
  for (const [file, operations] of Object.entries(workflowOperations)) {
    const workflow = yaml.load(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
    assert.deepEqual(workflow.concurrency, { group: 'anywear-infra-runtime', 'cancel-in-progress': false });
    const inputs = workflow.on.workflow_dispatch.inputs;
    assert.deepEqual(inputs.operation?.options ?? [workflow.jobs.operation.env.INFRA_OPERATION], operations);
    for (const key of ['selection_file', 'selection_sha256', 'stack_sources_file', 'stack_sources_sha256']) assert.equal(inputs[key].required, true);
    const cdk = file.includes('lifecycle') || file.includes('deploy');
    assert.equal(Object.hasOwn(inputs, 'identity_phase'), cdk);
    assert.equal(Object.hasOwn(inputs, 'retention_protection'), cdk);
    assert.equal(Object.hasOwn(inputs, 'tester_emails'), file.includes('admission'));
    assert.equal(Object.hasOwn(inputs, 'beta_api_sizing_profile'), file.includes('beta-deploy'));
    assert.equal(Object.hasOwn(inputs, 'beta_sizing_telemetry'), file.includes('beta-deploy'));
    if (file.includes('beta-deploy')) {
      assert.deepEqual(inputs.beta_api_sizing_profile.options, ['preserve', 's1', 's2-api']);
      assert.deepEqual(inputs.beta_sizing_telemetry.options, ['preserve', 'enable', 'disable']);
      assert.equal(inputs.beta_api_sizing_profile.default, 'preserve');
      assert.equal(inputs.beta_sizing_telemetry.default, 'preserve');
      assert.equal(workflow.jobs.operation.steps[1].with.beta_api_sizing_profile, '${{ inputs.beta_api_sizing_profile }}');
      assert.equal(workflow.jobs.operation.steps[1].with.beta_sizing_telemetry, '${{ inputs.beta_sizing_telemetry }}');
    }
    const job = workflow.jobs.operation;
    assert.equal(job.environment, 'beta');
    assert.deepEqual(job.permissions, { contents: 'read', 'id-token': 'write' });
    assert.equal(job.if, file.includes('beta-observe') ? "github.ref == 'refs/heads/main'"
      : "github.ref == 'refs/heads/main' && vars.ENABLE_BETA_DEPLOY == 'true'");
    assert.equal(Object.hasOwn(job.env, 'INFRA_DEPLOY_ROLE_ARN'), cdk);
    assert.equal(job.steps[0].with.ref, '${{ github.sha }}');
    assert.equal(job.steps[0].with['persist-credentials'], false);
    assert.equal(job.steps[1].uses, './.github/actions/beta-operation');
  }
  const common = yaml.load(await readFile(new URL('../.github/actions/beta-operation/action.yml', import.meta.url), 'utf8'));
  const steps = common.runs.steps;
  for (const key of ['beta_api_sizing_profile', 'beta_sizing_telemetry']) assert.equal(common.inputs[key].default, 'preserve');
  for (const step of steps.filter(step => step.run?.includes('check-operation.mjs') || ['operation', 'observation'].includes(step.id))) {
    assert.equal(step.env.INFRA_BETA_API_SIZING_PROFILE, '${{ inputs.beta_api_sizing_profile }}');
    assert.equal(step.env.INFRA_BETA_SIZING_TELEMETRY, '${{ inputs.beta_sizing_telemetry }}');
  }
  assert.ok(steps.findIndex(step => step.run?.includes('check-operation.mjs')) < steps.findIndex(step => step.id === 'app'));
  assert.ok(steps.findIndex(step => step.run?.includes('release verify-asset')) < steps.findIndex(step => step.id === 'app'));
  assert.equal(steps.some(step => step.uses?.includes('configure-aws-credentials')), false);
  assert.equal(steps.find(step => step.id === 'observation').run, 'node scripts/observe-operation.mjs');
  for (const step of steps.filter(step => step.uses === 'actions/upload-artifact@v4')) assert.equal(step.with['retention-days'], 90);
});

test('preflight rejects explicit sizing/telemetry in other operations before OIDC or commands', async () => {
  for (const [file, operations] of Object.entries(workflowOperations)) for (const operation of operations) {
    if (operation === 'deploy-workload') continue;
    const env = envFor(file, operation);
    for (const change of [{ INFRA_BETA_API_SIZING_PROFILE: 's1' }, { INFRA_BETA_API_SIZING_PROFILE: 's2-api' },
      { INFRA_BETA_SIZING_TELEMETRY: 'enable' }, { INFRA_BETA_SIZING_TELEMETRY: 'disable' }]) {
      let calls = 0;
      await assert.rejects(credentialEnvironment('runtime', { ...env, ...change }, 'operation', {
        async requestToken() { calls++; }, async run() { calls++; },
      }), /restricted to deploy-workload/);
      assert.equal(calls, 0);
    }
  }
});

test('preflight rejects every cross-family operation before credentials and permits disabled-gate state reads', () => {
  const all = Object.values(workflowOperations).flat();
  for (const [file, operations] of Object.entries(workflowOperations)) {
    for (const operation of all) {
      const env = envFor(file, operation);
      if (operations.includes(operation)) {
        validateOperationInputs(env);
        if (operation === 'state') validateOperationInputs({ ...env, ENABLE_BETA_DEPLOY: 'false' });
        else assert.throws(() => validateOperationInputs({ ...env, ENABLE_BETA_DEPLOY: 'false' }));
      } else assert.throws(() => validateOperationInputs(env), /forbidden/);
    }
  }
  for (const patch of [{ GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'push' }, { AWS_REGION: 'us-east-1' },
    { GITHUB_REPOSITORY_ID: '1' }, { GITHUB_SHA: 'short' }, { TESTER_EMAILS: '["private@example.com"]' }]) {
    assert.throws(() => validateOperationInputs({ ...stateEnv(), ...patch }));
  }
});

test('all actual STS requests carry bounded session policies and cannot reuse inherited credentials', async () => {
  for (const [file, operations] of Object.entries(workflowOperations)) for (const operation of operations) {
    const env = envFor(file, operation);
    const policy = JSON.parse(sessionPolicy('runtime', env));
    assert.ok(JSON.stringify(policy).length <= 2048);
    const actions = policy.Statement.flatMap(row => [row.Action].flat());
    assert.equal(actions.includes('ecr:PutImage'), false);
    assert.equal(actions.includes('ssm:PutParameter'), false);
    if (operation === 'state') assert.equal(actions.some(action => /ecs:|iam:|secretsmanager:|sts:AssumeRole/.test(action)), false);
    else {
      const final = JSON.parse(sessionPolicy('runtime', env, 'qualification'));
      assert.ok(JSON.stringify(final).length <= 2048);
      const pass = final.Statement.find(row => row.Action === 'iam:PassRole');
      assert.deepEqual(pass.Resource, ['arn:aws:iam::650880818323:role/beta-anywear-verification-task',
        'arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution']);
      assert.deepEqual(final.Statement.find(row => Array.isArray(row.Action) && row.Action.includes('ecs:RunTask')).Resource,
        ['arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-artifact-verify:*']);
    }
    if (['start', 'stop', 'deploy-foundation', 'deploy-billing', 'deploy-platform', 'deploy-workload', 'restore-release'].includes(operation)) {
      assert.ok(sessionPolicy('deploy', env).length <= 2048);
    } else assert.throws(() => sessionPolicy('deploy', env), /forbidden/);
  }
  const env = { ...stateEnv(), ACTIONS_ID_TOKEN_REQUEST_URL: 'https://fixture.actions.githubusercontent.com/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture', AWS_ACCESS_KEY_ID: 'inherited', AWS_PROFILE: 'shared' };
  let requests = 0;
  const credentials = await credentialEnvironment('runtime', env, 'operation', {
    async requestToken() { requests++; return { ok: true, async json() { return { value: 'fixture-token' }; } }; },
    async run(command, args, options) {
      assert.equal(command, 'aws'); assert.ok(args.includes('--policy'));
      assert.equal(options.env.AWS_ACCESS_KEY_ID, undefined); assert.equal(options.env.AWS_PROFILE, undefined);
      assert.equal(options.env.AWS_SHARED_CREDENTIALS_FILE, '/dev/null');
      assert.deepEqual(JSON.parse(args[args.indexOf('--policy') + 1]), JSON.parse(sessionPolicy('runtime', env)));
      return { stdout: JSON.stringify({ AssumedRoleUser: { Arn: 'arn:aws:sts::650880818323:assumed-role/beta-infra-runtime-role/test' },
        Credentials: { AccessKeyId: 'restricted', SecretAccessKey: 'fixture', SessionToken: 'fixture' } }) };
    },
  });
  assert.equal(credentials.AWS_ACCESS_KEY_ID, 'restricted'); assert.equal(credentials.AWS_PROFILE, undefined);
  await assert.rejects(credentialEnvironment('deploy', env, 'operation', { async requestToken() { requests++; } }), /forbidden/);
  assert.equal(requests, 1);
  await assert.rejects(credentialEnvironment('runtime', env, 'operation', {
    async requestToken() { return { ok: true, async json() { return { value: 'secret-token-must-not-be-logged' }; } }; },
    async run() { throw new Error('secret-token-must-not-be-logged'); },
  }), error => error.message === 'Dedicated restricted STS assumption failed' && error.cause === undefined);
});

test('cleanup fence reads stay exact and belong only to Platform or Workload operation sessions', () => {
  const machine = 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup';
  const execution = 'arn:aws:states:ap-east-1:650880818323:execution:beta-anywear-tester-cleanup:fixed-execution';
  const calls = [['stepfunctions', 'list-executions', '--state-machine-arn', machine],
    ['stepfunctions', 'describe-execution', '--execution-arn', execution]];
  for (const [file, operations] of Object.entries(workflowOperations)) for (const operation of operations) {
    const env = envFor(file, operation);
    const required = ['start', 'stop', 'deploy-platform', 'deploy-workload', 'restore-release'].includes(operation);
    const policy = JSON.parse(sessionPolicy('runtime', env));
    assert.deepEqual(policy.Statement.filter(row => [row.Action].flat().some(action => action.startsWith('states:'))), required ? [
      { Effect: 'Allow', Action: 'states:ListExecutions', Resource: machine },
      { Effect: 'Allow', Action: 'states:DescribeExecution', Resource: execution.replace('fixed-execution', '*') },
    ] : []);
    for (const call of calls) {
      if (required) assertAwsAllowed(env, call);
      else assert.throws(() => assertAwsAllowed(env, call), /forbidden/);
      assert.throws(() => assertAwsAllowed(env, call, 'qualification'), /forbidden|cannot qualify/);
      assert.throws(() => assertAwsAllowed(env, [...call.slice(0, -1), call.at(-1).replace('beta-anywear', 'prod-anywear')]), /forbidden/);
    }
    for (const action of ['start-execution', 'stop-execution', 'update-state-machine']) {
      assert.throws(() => assertAwsAllowed(env, ['stepfunctions', action, '--state-machine-arn', machine]), /forbidden/);
    }
    if (operation !== 'state') assert.equal(JSON.parse(sessionPolicy('runtime', env, 'qualification')).Statement
      .flatMap(row => [row.Action].flat()).some(action => action.startsWith('states:')), false);
  }
});

test('operation guards block cross-family tasks, arbitrary writes and lifecycle opening', () => {
  for (const [file, operations] of Object.entries(workflowOperations)) for (const operation of operations) {
    const env = envFor(file, operation);
    for (const args of [['ssm', 'put-parameter'], ['ecr', 'put-image'], ['ecs', 'update-service'],
      ['cloudformation', 'delete-stack'], ['ssm', 'get-parameter', '--with-decryption']]) assert.throws(() => assertAwsAllowed(env, args));
    assert.throws(() => assertOneShotAllowed(env, 'lifecycle', 'open'));
    assert.throws(() => assertOneShotAllowed(env, 'tester-cleanup'));
    assert.throws(() => assertOneShotAllowed(env, 'cleanup-acceptance', 'prepare'));
    assert.throws(() => assertAwsAllowed(env, ['ecs', 'run-task', '--task-definition',
      'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-cleanup-acceptance:1']));
    assert.throws(() => assertDeployAllowed(env, 'AnyWearPlatformStack-prod'));
  }
  const admission = envFor('.github/workflows/beta-admission.yml', 'tester-add');
  admission.TESTER_EMAILS = '["a@example.com"]';
  assertOneShotAllowed(admission, 'lifecycle', 'configure-testers', '["a@example.com"]');
  assert.throws(() => assertOneShotAllowed(admission, 'migrate'));
  assert.throws(() => assertDeployAllowed(admission, 'AnyWearPlatformStack-beta'));
  const restore = envFor('.github/workflows/beta-deploy.yml', 'restore-release');
  assert.throws(() => assertOneShotAllowed(restore, 'migrate'));
  assert.throws(() => assertOneShotAllowed(restore, 'lifecycle', 'close'));
  assertDeployAllowed(restore, 'AnyWearWorkloadStack-beta');
  const registration = command => ['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify({
    family: 'beta-anywear-lifecycle', taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-lifecycle-task',
    executionRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution',
    containerDefinitions: [{ name: 'OneShot', command }] })];
  for (const action of ['open', 'drain', 'close', 'status']) assert.throws(() => assertAwsAllowed(admission,
    registration(['node', 'dist/ops/beta-lifecycle.js', action])));
  assertAwsAllowed(admission, registration(['node', 'dist/ops/beta-lifecycle.js', 'configure-testers', '["a@example.com"]']));
  const qualified = envFor('.github/workflows/runtime.yml', 'observe');
  const artifact = command => ['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify({
    family: 'beta-anywear-artifact-verify', taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-verification-task',
    executionRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution',
    containerDefinitions: [{ name: 'OneShot', command }] })];
  assertAwsAllowed(qualified, artifact(['node', '-e', runtimeCommandBytes().toString('utf8')]), 'qualification');
  assert.throws(() => assertAwsAllowed(qualified, artifact(['node', '-e', 'process.exit(0)']), 'qualification'));
  assert.throws(() => assertAwsAllowed(qualified, artifact(['node', '-e', runtimeCommandBytes().toString('utf8')]), 'operation'));
});

test('state executor observes stopped or active Beta with no tasks, deploys, schema assertions or raw tester emails', async () => {
  const execute = promisify(execFile);
  const root = await mkdtemp(path.join(os.tmpdir(), 'infra-state-'));
  const { selector } = await createTestInputs(await mkdtemp(path.join(os.tmpdir(), 'infra-state-assets-')));
  const git = async args => (await execute('git', ['-C', root, ...args])).stdout.trim();
  await git(['init', '--quiet']); await git(['config', 'core.autocrlf', 'false']);
  await git(['config', 'user.name', 'State fixture']); await git(['config', 'user.email', 'fixture@invalid.local']);
  await git(['remote', 'add', 'origin', 'https://github.com/git-malu/AnyWear-Infra.git']);
  await mkdir(path.join(root, 'selections')); await writeFile(path.join(root, 'selections/beta.json'), canonicalJson(selector));
  await git(['add', '.']); await git(['commit', '--quiet', '-m', 'Reviewed selection']);
  const env = { ...stateEnv(), GITHUB_SHA: await git(['rev-parse', 'HEAD']), SELECTION_SHA256: sha256(canonicalJson(selector)) };
  const record = createOperationRecord({ env, selector, stackManifest: stackManifestFixture() });
  let calls = 0; let assumptions = 0; let active = 'false';
  const io = await createRuntimeIo(selector, '/verified', env, record, { trustedInfraRoot: root,
    async assume(kind, passed, purpose) { assumptions++; assert.equal(kind, 'runtime'); assert.equal(purpose, 'operation'); return passed; },
    async run(command, args) {
      calls++; assert.equal(command, 'aws');
      if (args[0] === 'cloudformation') return { stdout: JSON.stringify({ Stacks: [{ StackName: args[args.indexOf('--stack-name') + 1],
        StackStatus: 'UPDATE_COMPLETE', Outputs: [{ OutputKey: 'BetaActive', OutputValue: active }] }] }) };
      assert.equal(args[0], 'ssm'); assert.equal(args[1], 'get-parameter');
      const name = args[args.indexOf('--name') + 1];
      return { stdout: JSON.stringify({ Parameter: { Name: name, Value: name.endsWith('tester_allowlist') ? '["private@example.com"]'
        : name.endsWith('admission_suspended') ? 'true' : 'false' } }) };
    },
  });
  for (active of ['false', 'true']) {
    const state = await observeBetaState(io);
    assert.equal(state.stacks[0].beta_active, active);
    assert.equal(state.qualification, 'not-applicable');
    assert.equal(JSON.stringify(state).includes('private@example.com'), false);
    assert.equal(Object.hasOwn(state, 'schema'), false);
    record.state_observation = state;
    const events = [{ type: 'final-beta-activity', platform_active: active, workload_active: active }];
    assert.equal(finalizeOperationRecord({ ...record, events, result: 'succeeded' }, 'success', 'skipped').result, 'succeeded');
  }
  const prior = calls;
  await assert.rejects(io.deploy('AnyWearWorkloadStack-beta', true, {}), /forbidden/);
  await assert.rejects(io.oneShot('verify', {}), /forbidden/);
  await assert.rejects(io.aws(['ecs', 'run-task']), /forbidden/);
  await assert.rejects(io.aws(['ssm', 'get-parameter', '--region', 'eu-west-1']), /Unexpected operation region/);
  assert.equal(calls, prior); assert.equal(assumptions, 1);
  assert.equal(record.executor.workflow_path, '.github/workflows/beta-observe.yml');
  assert.equal(operationBoundary(env).readOnly, true);
  assert.throws(() => validateDeploymentRecord({ ...record, record_type: 'anywear_infra_family_observation' }));
});

test('state failure preserves known stack/admission values with sanitized unavailable fields', async () => {
  const io = { async aws(args) {
    if (args[0] === 'cloudformation') return { Stacks: [{ StackName: args[args.indexOf('--stack-name') + 1], StackStatus: 'UPDATE_FAILED',
      Outputs: [{ OutputKey: 'BetaActive', OutputValue: 'false' }] }] };
    const name = args[args.indexOf('--name') + 1];
    return { Parameter: { Name: name, Value: name.endsWith('tester_allowlist') ? '["private@example.com"]'
      : name.endsWith('admission_suspended') ? 'true' : 'malformed' } };
  } };
  await assert.rejects(observeBetaState(io), error => {
    assert.equal(error.observedState.stacks.length, 2);
    assert.equal(error.observedState.admission.admission_suspended, true);
    assert.equal(error.observedState.admission.intake_open, 'unavailable');
    assert.equal(error.observedState.admission.tester_count, 1);
    assert.equal(JSON.stringify(error.observedState).includes('private@example.com'), false);
    return true;
  });
});
