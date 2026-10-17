import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { workflowOperations, operationBoundary, sessionPolicy, assertAwsAllowed, assertOneShotAllowed, assertDeployAllowed,
  operationEvidence, lifecycleActions, families, qualifiedWorkflowPaths, operationFamilies } from './operation-boundaries.mjs';
import { admissionWindowPayload } from './admission-window.mjs';
import { validateOperationInputs, credentialEnvironment, createRuntimeIo } from './runtime-operation.mjs';
import { createTestInputs, stackManifestFixture } from './create-test-inputs.mjs';
import { canonicalJson, sha256 } from './json-contract.mjs';
import { observeBetaState } from './observe-beta-state.mjs';
import { finalizeOperationRecord } from './finalize-operation.mjs';
import { createOperationRecord } from './operation-record.mjs';
import { validateDeploymentRecord } from './deployment-contract.mjs';
import { runtimeCommandBytes } from './runtime-command.mjs';

const runtimeEntry = '.github/workflows/runtime.yml';
const mutateEntry = '.github/workflows/mutate.yml';
const envFor = (workflow, operation) => ({ GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
  GITHUB_SHA: '5'.repeat(40), GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: `git-malu/AnyWear-Infra/${workflow}@refs/heads/main`, GITHUB_RUN_ID: '23', GITHUB_RUN_ATTEMPT: '1',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
  INFRA_OPERATION: operation, INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true', TESTER_EMAILS: '[]',
  WINDOW_MINUTES: '60',
  SELECTION_FILE: 'selections/beta.json', SELECTION_SHA256: 'a'.repeat(64),
  INFRA_RUNTIME_ROLE_ARN: 'arn:aws:iam::650880818323:role/beta-infra-runtime-role',
  INFRA_DEPLOY_ROLE_ARN: 'arn:aws:iam::650880818323:role/beta-infra-deploy-role' });
const stateEnv = () => ({ ...envFor(runtimeEntry, 'state'), ENABLE_BETA_MUTATION: 'false' });
const workflowFile = async file => yaml.load(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));

test('only two dispatch entries and one automatic entry exist, and each entry maps to its operations', async () => {
  const files = (await readdir(new URL('../.github/workflows', import.meta.url))).filter(file => file.endsWith('.yml')).sort();
  assert.deepEqual(files, ['check.yml', 'mutate.yml', 'production.yml', 'runtime.yml']);
  const entries = [];
  for (const file of files) {
    const workflow = await workflowFile(`.github/workflows/${file}`);
    if (workflow.on?.workflow_dispatch) entries.push(file);
    // `production.yml` remains a file with its tested blocker, but it is not an
    // entry: it must stay `workflow_call`-only.
    if (file === 'production.yml') {
      assert.deepEqual(Object.keys(workflow.on), ['workflow_call'], 'production.yml declares no dispatch surface');
    }
    if (file === 'check.yml') assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push'], 'check.yml stays automatic');
  }
  assert.deepEqual(entries, ['mutate.yml', 'runtime.yml'], 'exactly the two manual dispatch entries remain');
  for (const [file, operations] of Object.entries(workflowOperations)) {
    const workflow = await workflowFile(file);
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
    assert.deepEqual(workflow.concurrency, { group: 'anywear-infra-runtime', 'cancel-in-progress': false });
    const inputs = workflow.on.workflow_dispatch.inputs;
    assert.deepEqual(inputs.operation.options, operations);
    assert.equal(inputs.operation.required, true);
    for (const key of ['selection_file', 'selection_sha256', 'stack_sources_file', 'stack_sources_sha256']) assert.equal(inputs[key].required, true);
    assert.equal(inputs.selection_file.default, 'selections/beta-baseline.json');
  }
  // The absorbed files may never reappear as entries or as extra dispatch surfaces.
  for (const retired of ['beta-deploy', 'beta-observe', 'beta-schema', 'beta-admission', 'beta-cleanup-acceptance']) {
    assert.equal(files.includes(`${retired}.yml`), false, retired);
  }
  assert.deepEqual(Object.keys(workflowOperations).sort(), [mutateEntry, runtimeEntry].sort());
});

test('no tracked code or workflow reads a retired stage switch name', async () => {
  // This class regressed once: the workflows were renamed to the single stage
  // switch while a script default still read the retired deploy name, so a guard
  // failed after CloudFormation had already been updated. The names are composed
  // here so this guard does not match itself.
  const retired = [['ENABLE', 'BETA', 'DEPLOY'].join('_'), ['ENABLE', 'BETA', 'CLEANUP', 'ACCEPTANCE'].join('_')];
  const root = fileURLToPath(new URL('..', import.meta.url));
  const execute = promisify(execFile);
  const tracked = (await execute('git', ['-C', root, 'ls-files', '.github', 'scripts'])).stdout
    .split(/\r?\n/).filter(Boolean).filter(file => /\.(mjs|ts|yml)$/.test(file));
  assert.ok(tracked.length > 20, `tracked source set too small: ${tracked.length}`);
  const offenders = [];
  for (const file of tracked) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const name of retired) if (text.includes(name)) offenders.push(`${file}: ${name}`);
  }
  assert.deepEqual(offenders, [], 'tracked code and workflows may only use ENABLE_BETA_MUTATION');
});

test('the mutate chain keeps build separation: preflight, verify, deploy and record are distinct jobs', async () => {
  const workflow = await workflowFile(mutateEntry);
  const inputs = workflow.on.workflow_dispatch.inputs;
  // A dispatch surface is per workflow, so every absorbed input is now visible to
  // every operation of this entry; the per-operation scope is enforced in preflight.
  for (const key of ['identity_phase', 'retention_protection', 'window_minutes', 'tester_emails',
    'beta_api_sizing_profile', 'beta_sizing_telemetry']) assert.ok(inputs[key], key);
  assert.equal(inputs.window_minutes.type, 'number');
  assert.equal(inputs.window_minutes.default, 60);
  assert.match(inputs.window_minutes.description, /15-240/);
  assert.match(inputs.window_minutes.description, /resume-admission/);
  assert.equal(inputs.tester_emails.default, '[]');
  assert.deepEqual(inputs.beta_api_sizing_profile.options, ['preserve', 's1', 's2-api']);
  assert.deepEqual(inputs.beta_sizing_telemetry.options, ['preserve', 'enable', 'disable']);
  assert.equal(inputs.beta_api_sizing_profile.default, 'preserve');
  assert.equal(inputs.beta_sizing_telemetry.default, 'preserve');
  assert.deepEqual(inputs.identity_phase.options, ['retired', 'roles-added', 'legacy']);
  assert.equal(inputs.identity_phase.default, 'retired');
  assert.equal(inputs.retention_protection.default, true);
  assert.deepEqual(inputs.operation.options, workflowOperations[mutateEntry]);
  assert.deepEqual(Object.keys(workflow.jobs), ['preflight', 'verify', 'deploy', 'record']);
  const { preflight, verify, deploy, record } = workflow.jobs;
  // preflight: no environment, no id-token, no App token, no AWS.
  assert.equal(preflight.environment, undefined);
  assert.deepEqual(preflight.permissions, { contents: 'read' });
  assert.equal(preflight.if, "github.ref == 'refs/heads/main' && vars.ENABLE_BETA_MUTATION == 'true'");
  const preflightRuns = preflight.steps.filter(step => step.run).map(step => step.run).join('\n');
  assert.match(preflightRuns, /check-operation\.mjs/);
  assert.match(preflightRuns, /check-stack-sources\.mjs/);
  assert.match(preflightRuns, /release verify/);
  assert.equal(preflight.steps.some(step => step.uses?.includes('create-github-app-token')), false);
  assert.equal(preflight.steps.some(step => step.uses?.includes('configure-aws-credentials')), false);
  // verify: read-only App token, no environment, no OIDC.
  assert.equal(verify.needs, 'preflight');
  assert.equal(verify.environment, undefined);
  assert.deepEqual(verify.permissions, { contents: 'read' });
  assert.deepEqual(verify.steps.map(step => step.uses ?? step.run), ['actions/checkout@v4', './.github/actions/verify-operation']);
  // deploy: the only credential job, after verification.
  assert.equal(deploy.needs, 'verify');
  assert.equal(deploy.environment, 'beta');
  assert.deepEqual(deploy.permissions, { contents: 'read', 'id-token': 'write' });
  assert.equal(deploy.steps.some(step => step.uses === './.github/actions/deploy-operation'), true);
  // record: after the credential job and itself credential-free.
  assert.equal(record.needs, 'deploy');
  assert.equal(record.environment, undefined);
  assert.deepEqual(record.permissions, { contents: 'read' });
  assert.match(record.steps.find(step => step.run)?.run ?? '', /record-deployment\.mjs/);
  // Exactly one job declares environment and id-token: write.
  const credentialed = Object.entries(workflow.jobs).filter(([, job]) => job.environment !== undefined
    || job.permissions?.['id-token'] === 'write').map(([name]) => name);
  assert.deepEqual(credentialed, ['deploy']);
});

test('the runtime entry keeps state unswitched and observe switched, with one credential job each', async () => {
  const workflow = await workflowFile(runtimeEntry);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(inputs.operation.options, ['state', 'observe']);
  assert.equal(inputs.operation.required, true);
  for (const absent of ['identity_phase', 'retention_protection', 'window_minutes', 'tester_emails',
    'beta_api_sizing_profile', 'beta_sizing_telemetry']) assert.equal(inputs[absent], undefined, absent);
  assert.deepEqual(Object.keys(workflow.jobs), ['preflight', 'state', 'observe', 'record']);
  const { preflight, state, observe, record } = workflow.jobs;
  assert.equal(preflight.environment, undefined);
  assert.deepEqual(preflight.permissions, { contents: 'read' });
  assert.equal(preflight.if, "github.ref == 'refs/heads/main'");
  // `state` must work with the stage switch closed; `observe` (a task-running
  // deployment-record producer) must not.
  assert.equal(state.if, "github.ref == 'refs/heads/main' && inputs.operation == 'state'");
  assert.equal(state.environment, 'beta');
  assert.deepEqual(state.permissions, { contents: 'read', 'id-token': 'write' });
  assert.equal(/ENABLE_BETA_MUTATION/.test(JSON.stringify(state)), false, 'state runs with the switch closed');
  assert.match(observe.if, /vars\.ENABLE_BETA_MUTATION == 'true'/);
  assert.match(observe.if, /inputs\.operation == 'observe'/);
  assert.equal(observe.environment, 'beta');
  assert.deepEqual(observe.permissions, { contents: 'read', 'id-token': 'write' });
  assert.equal(record.environment, undefined);
  assert.deepEqual(record.permissions, { contents: 'read' });
  const credentialed = Object.entries(workflow.jobs).filter(([, job]) => job.environment !== undefined
    || job.permissions?.['id-token'] === 'write').map(([name]) => name);
  assert.deepEqual(credentialed, ['state', 'observe']);
  // The path is pinned cross-repository as the only accepted deployment-record
  // producer; it never moves to another file.
  assert.deepEqual(workflowOperations[runtimeEntry], ['state', 'observe']);
});

test('the split composites keep verification before any AWS execution step', async () => {
  const verify = yaml.load(await readFile(new URL('../.github/actions/verify-operation/action.yml', import.meta.url), 'utf8'));
  const deploy = yaml.load(await readFile(new URL('../.github/actions/deploy-operation/action.yml', import.meta.url), 'utf8'));
  assert.equal(verify.runs.using, 'composite');
  assert.equal(deploy.runs.using, 'composite');
  for (const key of ['beta_api_sizing_profile', 'beta_sizing_telemetry']) {
    assert.equal(verify.inputs[key].default, 'preserve');
    assert.equal(deploy.inputs[key].default, 'preserve');
  }
  const verifySteps = verify.runs.steps;
  for (const step of verifySteps.filter(step => step.run?.includes('check-operation.mjs'))) {
    assert.equal(step.env.INFRA_BETA_API_SIZING_PROFILE, '${{ inputs.beta_api_sizing_profile }}');
    assert.equal(step.env.INFRA_BETA_SIZING_TELEMETRY, '${{ inputs.beta_sizing_telemetry }}');
  }
  assert.ok(verifySteps.findIndex(step => step.run?.includes('check-operation.mjs')) < verifySteps.findIndex(step => step.id === 'app'));
  assert.ok(verifySteps.findIndex(step => step.run?.includes('release verify-asset')) < verifySteps.findIndex(step => step.id === 'app'));
  assert.ok(verifySteps.findIndex(step => step.id === 'app') < verifySteps.findIndex(step => step.run?.includes('verify-operation-inputs.mjs')));
  assert.equal(verifySteps.some(step => step.uses?.includes('configure-aws-credentials')), false);
  assert.equal(verifySteps.some(step => /runtime-operation|observe-operation/.test(step.run ?? '')), false);
  const deploySteps = deploy.runs.steps;
  for (const step of deploySteps.filter(step => ['operation', 'observation'].includes(step.id))) {
    assert.equal(step.env.INFRA_BETA_API_SIZING_PROFILE, '${{ inputs.beta_api_sizing_profile }}');
    assert.equal(step.env.INFRA_BETA_SIZING_TELEMETRY, '${{ inputs.beta_sizing_telemetry }}');
  }
  assert.equal(deploySteps.some(step => step.uses?.includes('configure-aws-credentials')), false);
  assert.ok(deploySteps.findIndex(step => step.run?.includes('check-verified-inputs.mjs')) < deploySteps.findIndex(step => step.id === 'app'));
  assert.ok(deploySteps.findIndex(step => step.id === 'app') < deploySteps.findIndex(step => step.run?.includes('runtime-operation.mjs')));
  assert.equal(deploySteps.find(step => step.id === 'operation').run, 'node scripts/runtime-operation.mjs');
  assert.equal(deploySteps.find(step => step.id === 'observation').run, 'node scripts/observe-operation.mjs');
  assert.equal(deploySteps.find(step => step.run?.includes('finalize-operation.mjs')) !== undefined, true);
  for (const step of deploySteps.filter(step => step.uses === 'actions/upload-artifact@v4')) assert.equal(step.with['retention-days'], 90);
  for (const step of verifySteps.filter(step => step.uses === 'actions/upload-artifact@v4')) assert.equal(step.with['retention-days'], 90);
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
        if (operation === 'state') validateOperationInputs({ ...env, ENABLE_BETA_MUTATION: 'false' });
        else assert.throws(() => validateOperationInputs({ ...env, ENABLE_BETA_MUTATION: 'false' }));
      } else assert.throws(() => validateOperationInputs(env), /forbidden/);
    }
  }
  for (const patch of [{ GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'push' }, { AWS_REGION: 'us-east-1' },
    { GITHUB_REPOSITORY_ID: '1' }, { GITHUB_SHA: 'short' }, { TESTER_EMAILS: '["private@example.com"]' }]) {
    assert.throws(() => validateOperationInputs({ ...stateEnv(), ...patch }));
  }
  // Identity phase and retention protection are workflow-level inputs on the
  // single mutate surface; only a deployment or a release recovery may vary them.
  for (const operation of workflowOperations[mutateEntry]) {
    const env = envFor(mutateEntry, operation);
    const varies = ['deploy-foundation', 'deploy-billing', 'deploy-platform', 'deploy-workload', 'restore-release'].includes(operation);
    if (varies) validateOperationInputs({ ...env, INFRA_IDENTITY_PHASE: 'roles-added', INFRA_RETENTION_PROTECTION: 'false' });
    else for (const change of [{ INFRA_IDENTITY_PHASE: 'roles-added' }, { INFRA_RETENTION_PROTECTION: 'false' }]) {
      assert.throws(() => validateOperationInputs({ ...env, ...change }), /vary identity phase and retention protection/, operation);
    }
  }
  // Tester payloads are accepted by exactly the tester operations.
  for (const operation of workflowOperations[mutateEntry]) {
    const env = envFor(mutateEntry, operation);
    if (['add-testers', 'set-testers'].includes(operation)) validateOperationInputs({ ...env, TESTER_EMAILS: '["a@example.com"]' });
    else assert.throws(() => validateOperationInputs({ ...env, TESTER_EMAILS: '["a@example.com"]' }),
      /Tester payload belongs only|tester mutation payload|Admission status accepts no mutation payload/, operation);
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
    if (['deploy-foundation', 'deploy-billing', 'deploy-platform', 'deploy-workload', 'restore-release'].includes(operation)) {
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
    const required = ['deploy-platform', 'deploy-workload', 'restore-release'].includes(operation);
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

test('one-shot resume is refused for every operation except the one bounded admission operation that owns it', () => {
  // `resume` is the one admission direction exactly one entry/operation pair
  // owns. Every other pair still refuses it, with or without a payload, and the
  // owning pair accepts only the exact bytes its driver builds.
  const owners = [];
  for (const [file, operations] of Object.entries(workflowOperations)) for (const operation of operations) {
    const env = envFor(file, operation);
    if (file === mutateEntry && operation === 'resume-admission') {
      owners.push(`${file} ${operation}`);
      assertOneShotAllowed(env, 'lifecycle', 'resume', admissionWindowPayload(env));
      // Without the payload, with any other payload, and with every shape that is
      // not exactly the canonical bounded object.
      for (const payload of [undefined, '', '{}', 'null', '[]', '{"window_minutes":14}', '{"window_minutes":241}',
        '{"window_minutes":"60"}', '{"window_minutes":60.5}', '{"window_minutes":60,"expires":null}',
        '{"window_minutes":60,"window_minutes":60}', admissionWindowPayload({ ...env, WINDOW_MINUTES: '59' })]) {
        assert.throws(() => assertOneShotAllowed(env, 'lifecycle', 'resume', payload), /forbidden|payload|window/i, `payload ${String(payload)}`);
      }
      // The dispatch input, not the payload, carries the bound: a missing or
      // out-of-range input refuses even the payload the driver would send.
      for (const minutes of ['14', '241', '60.5', 'sixty', '', undefined]) {
        assert.throws(() => assertOneShotAllowed({ ...env, WINDOW_MINUTES: minutes }, 'lifecycle', 'resume',
          admissionWindowPayload(env)), /forbidden|payload|window/i, `window_minutes ${String(minutes)}`);
      }
      continue;
    }
    assert.throws(() => assertOneShotAllowed(env, 'lifecycle', 'resume'), /forbidden/, `${file} ${operation}`);
    assert.throws(() => assertOneShotAllowed(env, 'lifecycle', 'resume', admissionWindowPayload(env)), /forbidden/, `${file} ${operation}`);
  }
  assert.deepEqual(owners, [`${mutateEntry} resume-admission`]);
});

test('the resume-admission allow-list entry is explicit in all three tables that would otherwise forbid it', () => {
  // Removing any one of these entries must fail this suite: a test that keeps
  // passing by forbidding the capability is the defect this issue removes.
  assert.deepEqual(workflowOperations[mutateEntry],
    ['deploy-foundation', 'deploy-billing', 'deploy-platform', 'deploy-workload', 'restore-release', 'migrate',
      'admission-status', 'add-testers', 'set-testers', 'suspend-admission', 'resume-admission']);
  assert.deepEqual(lifecycleActions('resume-admission'), ['resume', 'status', 'suspend']);
  assert.deepEqual(operationEvidence['resume-admission'].roles, ['lifecycle', 'artifact-verify']);
  assert.equal(operationEvidence['resume-admission'].qualified_by, 'not-applicable');
  assert.match(operationEvidence['resume-admission'].evidence, /window bound/);
  assert.match(operationEvidence['resume-admission'].evidence, /expiry/);
  assert.match(operationEvidence['resume-admission'].evidence, /recovery-only suspend/);
  assert.match(operationEvidence['resume-admission'].evidence, /no operator path can request it/);
  // No other operation gains the direction, and no operation gains an implicit resume.
  const resumers = [...new Set(Object.values(workflowOperations).flat())].filter(operation => lifecycleActions(operation).includes('resume'));
  assert.deepEqual(resumers, ['resume-admission']);
  for (const operation of ['admission-status', 'add-testers', 'set-testers', 'suspend-admission']) {
    assert.equal(lifecycleActions(operation).includes('resume'), false, operation);
  }
});

test('the recovery-only suspend is reachable for resume-admission and nowhere it did not already belong', () => {
  const admissionOpening = envFor(mutateEntry, 'resume-admission');
  // `resume-admission` may run the pinned suspend task, but only so a failed window
  // can restore the decision the failure would otherwise leave open.
  assertOneShotAllowed(admissionOpening, 'lifecycle', 'suspend');
  assertOneShotAllowed(admissionOpening, 'lifecycle', 'status');
  assertOneShotAllowed(admissionOpening, 'lifecycle', 'resume', admissionWindowPayload(admissionOpening));
  // Adding `suspend` here opened it for exactly the operations that already had it.
  const owners = ['suspend-admission', 'resume-admission'];
  for (const [file, operations] of Object.entries(workflowOperations)) for (const operation of operations) {
    assert.equal(lifecycleActions(operation).includes('suspend'), owners.includes(operation), `${file} ${operation}`);
  }
  const suspenders = [...new Set(Object.values(workflowOperations).flat())].filter(operation => lifecycleActions(operation).includes('suspend'));
  assert.deepEqual(suspenders.sort(), ['resume-admission', 'suspend-admission']);
  // The tester operations never gain a suspend: their only mutation stays
  // set-testers, and the guard refuses a lifecycle suspend for each of them.
  for (const operation of ['admission-status', 'add-testers', 'set-testers']) {
    const env = envFor(mutateEntry, operation);
    assert.equal(lifecycleActions(operation).includes('suspend'), false, operation);
    assert.throws(() => assertOneShotAllowed(env, 'lifecycle', 'suspend'), /forbidden/, operation);
  }
  // A non-admission pair still refuses the suspend.
  for (const [file, operation] of [[runtimeEntry, 'observe'], [mutateEntry, 'restore-release'],
    [runtimeEntry, 'state'], [mutateEntry, 'migrate'], [mutateEntry, 'deploy-workload']]) {
    assert.throws(() => assertOneShotAllowed(envFor(file, operation), 'lifecycle', 'suspend'), /forbidden/, `${file} ${operation}`);
  }
});

test('lifecycle actions that carry no payload refuse one for every operation that may run them', () => {
  // `suspend` and `status` are pinned by behaviour, not by shape: adding any of
  // them to the payload table would otherwise leave the suite green. `drain` is
  // no longer reachable from any Infra operation.
  for (const [file, operations] of Object.entries(workflowOperations)) for (const operation of operations) {
    const env = envFor(file, operation);
    assert.equal(lifecycleActions(operation).includes('drain'), false, `${file} ${operation}`);
    for (const action of ['suspend', 'status']) {
      if (!lifecycleActions(operation).includes(action)) continue;
      for (const payload of ['{}', '[]', 'null', '', '{"window_minutes":60}', '["a@example.com"]']) {
        assert.throws(() => assertOneShotAllowed(env, 'lifecycle', action, payload), /forbidden/,
          `${file} ${operation} ${action} ${JSON.stringify(payload)}`);
      }
      // The payload-free form of the same action stays allowed.
      assertOneShotAllowed(env, 'lifecycle', action);
    }
  }
});

test('a hand-made lifecycle task definition cannot smuggle resume or a payload past the registration guard', () => {
  const registration = command => ['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify({
    family: 'beta-anywear-lifecycle', taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-lifecycle-task',
    executionRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution',
    containerDefinitions: [{ name: 'OneShot', command }] })];
  const tester = envFor(mutateEntry, 'add-testers');
  tester.TESTER_EMAILS = '["a@example.com"]';
  // `resume` is not in this operation's allow-list, with or without its exact bytes.
  assert.throws(() => assertAwsAllowed(tester,
    registration(['node', 'dist/ops/beta-lifecycle.js', 'resume'])), /forbidden/);
  assert.throws(() => assertAwsAllowed(tester,
    registration(['node', 'dist/ops/beta-lifecycle.js', 'resume', admissionWindowPayload(tester)])), /forbidden/);
  // A payload on a payload-free action is refused whatever the operation.
  const suspending = envFor(mutateEntry, 'suspend-admission');
  for (const action of ['suspend', 'status']) {
    assert.throws(() => assertAwsAllowed(suspending,
      registration(['node', 'dist/ops/beta-lifecycle.js', action, '{}'])), /forbidden/, action);
  }
  // The owning pair accepts exactly its own bytes and refuses a different window.
  const resuming = envFor(mutateEntry, 'resume-admission');
  assertAwsAllowed(resuming, registration(['node', 'dist/ops/beta-lifecycle.js', 'resume', admissionWindowPayload(resuming)]));
  assert.throws(() => assertAwsAllowed(resuming,
    registration(['node', 'dist/ops/beta-lifecycle.js', 'resume', '{"window_minutes":59}'])), /forbidden|payload/i);
  assert.throws(() => assertAwsAllowed(resuming,
    registration(['node', 'dist/ops/beta-lifecycle.js', 'resume'])), /forbidden|payload/i);
});

test('operation guards block cross-family tasks, arbitrary writes and lifecycle opening', () => {
  for (const [file, operations] of Object.entries(workflowOperations)) for (const operation of operations) {
    const env = envFor(file, operation);
    for (const args of [['ssm', 'put-parameter'], ['ecr', 'put-image'], ['ecs', 'update-service'],
      ['cloudformation', 'delete-stack'], ['ssm', 'get-parameter', '--with-decryption']]) assert.throws(() => assertAwsAllowed(env, args));
    assert.throws(() => assertOneShotAllowed(env, 'tester-cleanup'));
    assert.throws(() => assertOneShotAllowed(env, 'cleanup-acceptance', 'prepare'));
    assert.throws(() => assertAwsAllowed(env, ['ecs', 'run-task', '--task-definition',
      'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-cleanup-acceptance:1']));
    assert.throws(() => assertDeployAllowed(env, 'AnyWearPlatformStack-prod'));
  }
  const admission = envFor(mutateEntry, 'add-testers');
  admission.TESTER_EMAILS = '["a@example.com"]';
  assertOneShotAllowed(admission, 'lifecycle', 'set-testers', '["a@example.com"]');
  assertOneShotAllowed(admission, 'lifecycle', 'status');
  assert.throws(() => assertOneShotAllowed(admission, 'migrate'));
  assert.throws(() => assertDeployAllowed(admission, 'AnyWearPlatformStack-beta'));
  const restore = envFor(mutateEntry, 'restore-release');
  assert.throws(() => assertOneShotAllowed(restore, 'migrate'));
  assert.throws(() => assertOneShotAllowed(restore, 'lifecycle', 'suspend'));
  assertDeployAllowed(restore, 'AnyWearWorkloadStack-beta');
  const registration = command => ['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify({
    family: 'beta-anywear-lifecycle', taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-lifecycle-task',
    executionRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution',
    containerDefinitions: [{ name: 'OneShot', command }] })];
  // The tester operation may not reach the admission directions, but its own
  // set-testers action and its read-only status must stay registrable.
  for (const action of ['resume', 'drain', 'suspend']) assert.throws(() => assertAwsAllowed(admission,
    registration(['node', 'dist/ops/beta-lifecycle.js', action])));
  assertAwsAllowed(admission, registration(['node', 'dist/ops/beta-lifecycle.js', 'status']));
  assertAwsAllowed(admission, registration(['node', 'dist/ops/beta-lifecycle.js', 'set-testers', '["a@example.com"]']));
  const qualified = envFor(runtimeEntry, 'observe');
  const artifact = command => ['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify({
    family: 'beta-anywear-artifact-verify', taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-verification-task',
    executionRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution',
    containerDefinitions: [{ name: 'OneShot', command }] })];
  assertAwsAllowed(qualified, artifact(['node', '-e', runtimeCommandBytes().toString('utf8')]), 'qualification');
  assert.throws(() => assertAwsAllowed(qualified, artifact(['node', '-e', 'process.exit(0)']), 'qualification'));
  assert.throws(() => assertAwsAllowed(qualified, artifact(['node', '-e', runtimeCommandBytes().toString('utf8')]), 'operation'));
});

test('every operation records its credential families and how its mutation is qualified', () => {
  assert.deepEqual(Object.keys(operationEvidence).sort(), [...new Set(Object.values(workflowOperations).flat())].sort());
  for (const [file, fileOperations] of Object.entries(workflowOperations)) for (const operation of fileOperations) {
    const entry = operationEvidence[operation]; const env = envFor(file, operation);
    // One table drives both the session families and the evidence statement.
    assert.deepEqual(families(env, 'operation'), [...entry.roles], operation);
    assert.ok(['self', 'not-applicable', ...qualifiedWorkflowPaths].includes(entry.qualified_by), `${operation} ${entry.qualified_by}`);
    assert.equal(typeof entry.evidence, 'string', operation);
    assert.ok(entry.evidence.trim().length > 0, operation);
    const registration = ['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify({
      family: 'beta-anywear-artifact-verify', taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-verification-task',
      executionRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution',
      containerDefinitions: [{ name: 'OneShot', command: ['node', '-e', runtimeCommandBytes().toString('utf8')] }] })];
    // The artifact-verification family is registrable in an operation session only
    // where the table declares it, and is never a one-shot helper role.
    if (entry.roles.includes('artifact-verify')) assertAwsAllowed(env, registration, 'operation');
    else assert.throws(() => assertAwsAllowed(env, registration, 'operation'), /forbidden/, operation);
    assert.throws(() => assertOneShotAllowed(env, 'artifact-verify'), /forbidden/, operation);
  }
  const verifying = Object.entries(operationEvidence).filter(([, entry]) => entry.roles.includes('artifact-verify')).map(([operation]) => operation);
  assert.deepEqual(verifying, ['deploy-workload', 'restore-release', 'suspend-admission', 'resume-admission']);
  assert.deepEqual(operationEvidence['deploy-platform'].roles, []);
  assert.equal(operationEvidence['deploy-platform'].qualified_by, '.github/workflows/runtime.yml');
  assert.deepEqual(operationEvidence.observe.roles, []);
  assert.equal(operationEvidence.observe.qualified_by, 'self');
  assert.equal(operationEvidence.state.qualified_by, 'not-applicable');
  assert.equal(operationEvidence.migrate.qualified_by, '.github/workflows/runtime.yml');
  // The standalone `verify` operation is retired from the menu and the table; the
  // `verify` task family survives as an internal step of the operations that run it.
  assert.equal(Object.hasOwn(operationEvidence, 'verify'), false);
  assert.equal(Object.values(workflowOperations).flat().includes('verify'), false);
  assert.equal(operationEvidence['resume-admission'].qualified_by, 'not-applicable');
});

test('record families derive from the operation so runtime.yml state can never be a deployment record', () => {
  assert.deepEqual(operationFamilies, {
    state: 'beta-observe', observe: 'runtime',
    'deploy-foundation': 'beta-deploy', 'deploy-billing': 'beta-deploy', 'deploy-platform': 'beta-deploy',
    'deploy-workload': 'beta-deploy', 'restore-release': 'beta-deploy',
    migrate: 'beta-schema', 'admission-status': 'beta-admission', 'add-testers': 'beta-admission',
    'set-testers': 'beta-admission', 'suspend-admission': 'beta-admission', 'resume-admission': 'beta-admission',
  });
  for (const [file, operations] of Object.entries(workflowOperations)) for (const operation of operations) {
    const boundary = operationBoundary(envFor(file, operation));
    assert.equal(boundary.workflow, file);
    assert.equal(boundary.family, operationFamilies[operation]);
    assert.equal(boundary.readOnly, operation === 'state');
    // The same path hosts `state` and `observe`, so only the operation can tell
    // the read-only state family from the deployment-record producer.
    if (operation === 'state') assert.notEqual(boundary.family, 'runtime');
    if (operation === 'observe') assert.equal(boundary.family, 'runtime');
  }
  assert.deepEqual(qualifiedWorkflowPaths, [runtimeEntry, mutateEntry]);
  // #159's restore-release fix pins `mutate.yml`; no retired path is a verification
  // executor any more.
  assert.equal(qualifiedWorkflowPaths.some(file => file.endsWith('beta-deploy.yml')), false);
  const state = operationBoundary(stateEnv());
  assert.equal(state.family, 'beta-observe');
  assert.equal(state.readOnly, true);
  assert.deepEqual(families(stateEnv(), 'operation'), []);
  assert.throws(() => families(stateEnv(), 'qualification'), /Read-only observation cannot qualify with tasks/);
});

test('operation record executor and family follow the operation, not the hosting file', () => {
  for (const [file, operations] of Object.entries(workflowOperations)) for (const operation of operations) {
    const env = envFor(file, operation);
    const record = createOperationRecord({ env, selector: { release: {}, image: {}, lambdas: {}, runtime_policy: {}, schema: {} },
      stackManifest: stackManifestFixture() });
    assert.equal(record.operation, operation);
    assert.equal(record.family, operationFamilies[operation]);
    assert.equal(record.executor.workflow_path, file);
    assert.equal(record.record_type, 'anywear_infra_operation');
  }
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
        : '{"mode":"closed"}' } }) };
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
  await assert.rejects(io.deploy('AnyWearWorkloadStack-beta', {}), /forbidden/);
  await assert.rejects(io.oneShot('verify', {}), /forbidden/);
  await assert.rejects(io.aws(['ecs', 'run-task']), /forbidden/);
  await assert.rejects(io.aws(['ssm', 'get-parameter', '--region', 'eu-west-1']), /Unexpected operation region/);
  assert.equal(calls, prior); assert.equal(assumptions, 1);
  assert.equal(record.executor.workflow_path, runtimeEntry);
  assert.equal(operationBoundary(env).readOnly, true);
  assert.throws(() => validateDeploymentRecord({ ...record, record_type: 'anywear_infra_family_observation' }));
});

test('state failure preserves known stack/admission values with sanitized unavailable fields', async () => {
  const io = { async aws(args) {
    if (args[0] === 'cloudformation') return { Stacks: [{ StackName: args[args.indexOf('--stack-name') + 1], StackStatus: 'UPDATE_FAILED',
      Outputs: [{ OutputKey: 'BetaActive', OutputValue: 'false' }] }] };
    const name = args[args.indexOf('--name') + 1];
    if (name.endsWith('tester_allowlist')) return { Parameter: { Name: name, Value: '["private@example.com"]' } };
    throw new Error('SSM admission mode unavailable');
  } };
  await assert.rejects(observeBetaState(io), error => {
    assert.equal(error.observedState.stacks.length, 2);
    assert.equal(error.observedState.admission.admission_mode, 'unavailable');
    assert.equal(error.observedState.admission.admission_window_expires_at, 'unavailable');
    assert.equal(error.observedState.admission.tester_count, 1);
    assert.equal(JSON.stringify(error.observedState).includes('private@example.com'), false);
    return true;
  });
});
