import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntimeIo } from './runtime-operation.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { canonicalJson, contentHash, sha256 } from './json-contract.mjs';
import { changedStackNames } from './operation-stacks.mjs';
import { workflowOperations } from './operation-boundaries.mjs';

test('source provenance binds every stack mutated by deployment and lifecycle operations', () => {
  assert.deepEqual(changedStackNames('deploy-foundation'), ['AnyWearFoundationStack']);
  assert.deepEqual(changedStackNames('deploy-billing'), ['AnyWearBillingStack-beta']);
  assert.deepEqual(changedStackNames('deploy-platform'), ['AnyWearPlatformStack-beta']);
  assert.deepEqual(changedStackNames('deploy-workload'), ['AnyWearWorkloadStack-beta']);
  for (const operation of ['start', 'stop']) assert.deepEqual(changedStackNames(operation), ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta']);
  assert.deepEqual(changedStackNames('observe'), []);
  assert.deepEqual(changedStackNames('close-admission'), []);
  assert.deepEqual(changedStackNames('restore-release'), ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta']);
});

async function runtimeDeployFixture() {
  const execute = promisify(execFile);
  const root = await mkdtemp(path.join(os.tmpdir(), 'infra-readback-'));
  const { selector } = await createTestInputs(await mkdtemp(path.join(os.tmpdir(), 'infra-readback-artifacts-')));
  const git = async args => (await execute('git', ['-C', root, ...args])).stdout.trim();
  await git(['init', '--quiet']); await git(['config', 'core.autocrlf', 'false']);
  await git(['config', 'user.name', 'Readback fixture']); await git(['config', 'user.email', 'fixture@invalid.local']);
  await git(['remote', 'add', 'origin', 'https://github.com/git-malu/AnyWear-Infra.git']);
  await mkdir(path.join(root, 'selections')); await writeFile(path.join(root, 'selections/beta.json'), canonicalJson(selector));
  await git(['add', '.']); await git(['commit', '--quiet', '-m', 'Reviewed selection']);
  const env = { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265', GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: await git(['rev-parse', 'HEAD']), GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/beta-deploy.yml@refs/heads/main',
    AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_DEPLOY: 'true', INFRA_OPERATION: 'deploy-workload',
    INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true', SELECTION_FILE: 'selections/beta.json', SELECTION_SHA256: contentHash(selector) };
  const revision = { digest: selector.image.digest, commit: selector.image.service_sha,
    parameters: { ServiceImageDigest: selector.image.digest, ServiceCommitSha: selector.image.service_sha,
      VlmConfigArn: 'arn:secret', CloudFrontPrefixListId: 'pl-test' } };
  const stack = (digest = revision.digest, commit = revision.commit) => ({ StackStatus: 'UPDATE_COMPLETE', Outputs: [], Parameters: [
    { ParameterKey: 'ServiceImageDigest', ParameterValue: digest }, { ParameterKey: 'ServiceCommitSha', ParameterValue: commit },
    { ParameterKey: 'VlmConfigArn', ParameterValue: revision.parameters.VlmConfigArn },
    { ParameterKey: 'CloudFrontPrefixListId', ParameterValue: revision.parameters.CloudFrontPrefixListId },
    { ParameterKey: 'BetaApiSizingProfile', ParameterValue: revision.parameters.BetaApiSizingProfile ?? 's1' },
  ] });
  return { root, selector, env, revision, stack };
}

test('workload deploy records exact parameter readback before success', async () => {
  const { root, selector, env, revision, stack } = await runtimeDeployFixture();
  const record = { events: [] }; const commands = [];
  const io = await createRuntimeIo(selector, '/verified/assets', env, record, { trustedInfraRoot: root,
    async assume() { return { ...env }; },
    async run(command, args) {
      commands.push([command, args]);
      if (command === 'npx') return { stdout: '', stderr: '' };
      if (command === 'aws') return { stdout: JSON.stringify(args[1] === 'list-tasks' ? { taskArns: [] }
        : args[1] === 'get-template' ? { TemplateBody: { Resources: {} } } : { Stacks: [stack()] }), stderr: '' };
      throw new Error(`Unexpected command ${command}`);
    },
  });
  await io.deploy('AnyWearWorkloadStack-beta', true, revision);
  assert.ok(commands.some(([command]) => command === 'npx'));
  assert.equal(record.events[0].type, 'cleanup-capability-cessation');
  assert.equal(record.events[0].manager_result_reconciliation_required, true);
  assert.deepEqual(record.events.slice(1), [
    { type: 'workload-parameter-readback', stack_name: 'AnyWearWorkloadStack-beta', stack_status: 'UPDATE_COMPLETE',
      service_sha: revision.commit, image_digest: revision.digest, beta_api_sizing_profile: 's1' },
    { type: 'stack-deploy', stack_name: 'AnyWearWorkloadStack-beta', beta_active: true,
      source_repository: env.GITHUB_REPOSITORY, source_sha: env.GITHUB_SHA, result: 'complete' },
  ]);
});

test('workload deploy fails closed when CloudFormation parameter readback mismatches', async () => {
  const { root, selector, env, revision, stack } = await runtimeDeployFixture();
  const record = { events: [] };
  const io = await createRuntimeIo(selector, '/verified/assets', env, record, { trustedInfraRoot: root,
    async assume() { return { ...env }; },
    async run(command, args) {
      if (command === 'npx') return { stdout: '', stderr: '' };
      if (command === 'aws') return { stdout: JSON.stringify(args[1] === 'list-tasks' ? { taskArns: [] }
        : args[1] === 'get-template' ? { TemplateBody: { Resources: {} } } : { Stacks: [stack(`sha256:${'f'.repeat(64)}`, 'e'.repeat(40))] }), stderr: '' };
      throw new Error(`Unexpected command ${command}`);
    },
  });
  await assert.rejects(io.deploy('AnyWearWorkloadStack-beta', false, revision), /Workload parameter readback mismatch for ServiceImageDigest/);
  assert.deepEqual(record.events.map(event => event.type), ['cleanup-capability-cessation']);
});

test('Platform and Workload replacements never invoke CDK when a cleanup execution is active', async () => {
  const { root, selector, env, revision, stack } = await runtimeDeployFixture();
  const machine = 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup';
  let deploys = 0;
  const io = await createRuntimeIo(selector, '/verified/assets', env, undefined, { trustedInfraRoot: root,
    async assume(kind) { assert.equal(kind, 'runtime'); return { ...env }; },
    async run(command, args) {
      if (command === 'npx') { deploys++; throw new Error('Unexpected deployment'); }
      if (args[1] === 'describe-stacks') return { stdout: JSON.stringify({ Stacks: [{ ...stack(), Outputs: [
        { OutputKey: 'CleanupOperationCleanupStateMachineArn3993CAF0', OutputValue: machine },
      ] }] }) };
      assert.equal(args[1], 'list-executions');
      return { stdout: JSON.stringify({ executions: [{ stateMachineArn: machine,
        executionArn: machine.replace(':stateMachine:', ':execution:') + ':cleanup-active', status: 'RUNNING' }] }) };
    },
  });
  for (const name of ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta']) {
    env.INFRA_OPERATION = name.includes('Platform') ? 'deploy-platform' : 'deploy-workload';
    await assert.rejects(io.deploy(name, true, revision), /cleanup resource inventory/);
  }
  assert.equal(deploys, 0);
});

test('sizing selection and current-main S1 rollback retain image and verify actual profile readback', async () => {
  const { root, selector, env, revision, stack } = await runtimeDeployFixture();
  revision.parameters.BetaApiSizingProfile = 's2-api';
  env.INFRA_BETA_API_SIZING_PROFILE = 's1';
  const record = { events: [] }; const commands = [];
  const io = await createRuntimeIo(selector, '/verified/assets', env, record, { trustedInfraRoot: root,
    async assume() { return { ...env }; },
    async run(command, args) {
      commands.push([command, args]);
      if (command === 'npx') return { stdout: '', stderr: '' };
      const actual = stack();
      actual.Parameters.find(parameter => parameter.ParameterKey === 'BetaApiSizingProfile').ParameterValue = 's1';
      return { stdout: JSON.stringify({ Stacks: [actual] }), stderr: '' };
    },
  });
  await io.deploy('AnyWearWorkloadStack-beta', true, revision);
  const arguments_ = commands.find(([command]) => command === 'npx')[1];
  assert.ok(arguments_.includes('AnyWearWorkloadStack-beta:BetaApiSizingProfile=s1'));
  assert.ok(arguments_.includes(`AnyWearWorkloadStack-beta:ServiceImageDigest=${selector.image.digest}`));
  assert.ok(arguments_.includes(`AnyWearWorkloadStack-beta:ServiceCommitSha=${selector.image.service_sha}`));
  assert.equal(record.events[0].beta_api_sizing_profile, 's1');
  assert.equal(revision.parameters.BetaApiSizingProfile, 's2-api', 'Do not overwrite the observed input');
});

test('sizing changes reject stopped Beta, unknown profiles and image changes before deploy credentials', async () => {
  const { root, selector, env, revision } = await runtimeDeployFixture();
  env.INFRA_BETA_API_SIZING_PROFILE = 's2-api';
  let calls = 0;
  const io = await createRuntimeIo(selector, '/verified/assets', env, undefined, { trustedInfraRoot: root,
    async assume() { calls++; throw new Error('Unexpected credentials'); },
    async run() { calls++; throw new Error('Unexpected mutation'); },
  });
  await assert.rejects(io.deploy('AnyWearWorkloadStack-beta', false, revision), /already-active/);
  await assert.rejects(io.deploy('AnyWearWorkloadStack-beta', undefined, revision), /observed Beta activity/);
  await assert.rejects(io.deploy('AnyWearWorkloadStack-beta', true, {
    ...revision, parameters: { ...revision.parameters, BetaApiSizingProfile: 'other' },
  }), /Unknown retained/);
  await assert.rejects(io.deploy('AnyWearWorkloadStack-beta', true, { ...revision, digest: `sha256:${'f'.repeat(64)}` }), /retain the selected Service/);
  assert.equal(calls, 0);
});

test('sizing rollback fails on profile readback mismatch', async () => {
  const { root, selector, env, revision, stack } = await runtimeDeployFixture();
  env.INFRA_BETA_API_SIZING_PROFILE = 's2-api';
  const io = await createRuntimeIo(selector, '/verified/assets', env, undefined, { trustedInfraRoot: root,
    async assume() { return { ...env }; },
    async run(command) {
      return command === 'npx' ? { stdout: '', stderr: '' }
        : { stdout: JSON.stringify({ Stacks: [stack()] }), stderr: '' };
    },
  });
  await assert.rejects(io.deploy('AnyWearWorkloadStack-beta', true, revision), /readback mismatch for BetaApiSizingProfile/);
});

test('runtime status ignores shell JSON and binds actual stopped task definition and CloudWatch status', async () => {
  const { root, selector, env, revision } = await runtimeDeployFixture();
  Object.assign(env, { INFRA_OPERATION: 'close-admission', TESTER_EMAILS: '[]',
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/beta-admission.yml@refs/heads/main' });
  const taskArn = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'c'.repeat(32)}`;
  const taskDefinitionArn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-lifecycle:9';
  const actualStatus = { intake_open: false, admission_suspended: true, tester_count: 4, database_policy_matches_ssm: false };
  const record = { events: [] };
  const io = await createRuntimeIo(selector, '/verified/assets', env, record, { trustedInfraRoot: root,
    async assume(kind) { assert.equal(kind, 'runtime'); return { ...env }; },
    async run(command, args) {
      if (command === 'bash') return { stdout: `Task ARN: ${taskArn}\nTask definition: ${taskDefinitionArn}\n${JSON.stringify({ ...actualStatus, database_policy_matches_ssm: true })}\n`, stderr: '' };
      assert.equal(command, 'aws');
      if (args[1] === 'describe-tasks') return { stdout: JSON.stringify({ tasks: [{ taskArn, taskDefinitionArn,
        clusterArn: 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear', lastStatus: 'STOPPED',
        containers: [{ name: 'OneShot', exitCode: 0, imageDigest: selector.image.digest }] }] }) };
      if (args[1] === 'describe-task-definition') return { stdout: JSON.stringify({ taskDefinition: {
        family: 'beta-anywear-lifecycle', taskDefinitionArn, containerDefinitions: [{ name: 'OneShot',
          image: `${selector.image.repository_uri}@${selector.image.digest}`, command: ['node', 'dist/ops/beta-lifecycle.js', 'status'],
          logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/anywear/beta/one-shot',
            'awslogs-region': 'ap-east-1', 'awslogs-stream-prefix': 'beta-anywear-lifecycle' } } }] } }) };
      assert.equal(args[1], 'get-log-events');
      assert.equal(args[args.indexOf('--log-stream-name') + 1], `beta-anywear-lifecycle/OneShot/${'c'.repeat(32)}`);
      return { stdout: JSON.stringify({ events: args.includes('--next-token') ? [] : [{ message: JSON.stringify(actualStatus) }], nextForwardToken: 'end' }) };
    } });
  io.sleep = async () => {};
  assert.deepEqual(await io.oneShot('lifecycle', revision, 'status'), actualStatus);
  assert.equal(record.events.at(-1).database_policy_matches_ssm, false);
  assert.equal(record.events.at(-1).status_sha256, sha256(canonicalJson(actualStatus)));
});

test('parallel admission reads share one dedicated credential request and failed tasks retain exact identities', async () => {
  const { root, selector, env, revision } = await runtimeDeployFixture();
  Object.assign(env, { INFRA_OPERATION: 'close-admission', TESTER_EMAILS: '[]',
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/beta-admission.yml@refs/heads/main' });
  const record = { events: [] }; let assumptions = 0; let awsCalls = 0;
  const taskArn = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'d'.repeat(32)}`;
  const taskDefinitionArn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-lifecycle:10';
  const io = await createRuntimeIo(selector, '/verified/assets', env, record, { trustedInfraRoot: root,
    async assume() { assumptions++; await new Promise(resolve => setTimeout(resolve, 10)); return { ...env }; },
    async run(command) {
      if (command === 'aws') { awsCalls++; return { stdout: '{}' }; }
      assert.equal(command, 'bash');
      const error = new Error('Task failed'); error.stdout = `Task ARN: ${taskArn}\nTask definition: ${taskDefinitionArn}\n`;
      throw error;
    } });
  await Promise.all(['admission_suspended', 'intake_open', 'tester_allowlist'].map(name => io.aws(['ssm', 'get-parameter', '--name', `/anywear/beta/${name}`])));
  assert.equal(assumptions, 1); assert.equal(awsCalls, 3);
  await assert.rejects(io.oneShot('lifecycle', revision, 'close'), /One-shot execution failed/);
  assert.deepEqual(record.events.at(-1), { type: 'one-shot-failed', role: 'lifecycle', action: 'close',
    task_arns: [taskArn], task_definition_arns: [taskDefinitionArn], result: 'failed' });
});

test('restart map resolves touched executor rows and preserves historical producers through the actual source guard', async () => {
  const execute = promisify(execFile);
  const root = await mkdtemp(path.join(os.tmpdir(), 'infra-restart-map-'));
  const { selector } = await createTestInputs(await mkdtemp(path.join(os.tmpdir(), 'infra-restart-map-artifacts-')));
  const mapBytes = await readFile(new URL('../stack-sources/beta-restart.json', import.meta.url));
  assert.equal(mapBytes.length, 598);
  assert.equal(sha256(mapBytes), 'e12b1a543b96c6688b5260df33a17813e0b9b742f025bb73f59df431732001be');
  // The CLI derives its trusted root from its own committed source location.
  // Copy that source into a clean temp repository, never relax the real guard.
  await cp(new URL('.', import.meta.url), path.join(root, 'scripts'), { recursive: true });
  await cp(new URL('../.github/scripts/', import.meta.url), path.join(root, '.github/scripts'), { recursive: true });
  await mkdir(path.join(root, 'selections')); await mkdir(path.join(root, 'stack-sources')); await mkdir(path.join(root, 'deployment-evidence'));
  await writeFile(path.join(root, '.gitignore'), 'deployment-evidence/\n');
  await writeFile(path.join(root, 'selections/beta.json'), canonicalJson(selector));
  const mapFile = path.join(root, 'stack-sources/beta-restart.json'); await writeFile(mapFile, mapBytes);
  const git = async args => (await execute('git', ['-C', root, ...args])).stdout.trim();
  await git(['init', '--quiet']); await git(['config', 'core.autocrlf', 'false']);
  await git(['config', 'user.name', 'Source-map fixture']); await git(['config', 'user.email', 'fixture@invalid.local']);
  await git(['remote', 'add', 'origin', 'https://github.com/git-malu/AnyWear-Infra.git']);
  await git(['add', '.']); await git(['commit', '--quiet', '-m', 'Reviewed restart map']);
  const runGuard = async (operation, hash = sha256(mapBytes)) => execute(process.execPath, ['scripts/check-stack-sources.mjs'], {
    cwd: root, timeout: 30_000, env: { ...process.env, GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
      GITHUB_REF: 'refs/heads/main', GITHUB_SHA: await git(['rev-parse', 'HEAD']), GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_WORKFLOW_REF: `git-malu/AnyWear-Infra/${Object.keys(workflowOperations).find(file => workflowOperations[file].includes(operation))}@refs/heads/main`,
      AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_DEPLOY: 'true', INFRA_OPERATION: operation,
      INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true', SELECTION_FILE: 'selections/beta.json', SELECTION_SHA256: contentHash(selector),
      TESTER_EMAILS: '[]',
      STACK_SOURCES_FILE: 'stack-sources/beta-restart.json', STACK_SOURCES_SHA256: hash },
  });
  for (const operation of ['start', 'stop', 'observe']) {
    await runGuard(operation);
    const rows = JSON.parse(await readFile(path.join(root, 'deployment-evidence/stack-sources.json'), 'utf8'));
    const executorSha = await git(['rev-parse', 'HEAD']);
    assert.deepEqual(rows, JSON.parse(mapBytes).map(row => ({ ...row, source_sha: row.source_sha === '@executor' ? executorSha : row.source_sha })));
    assert.equal(rows[0].source_repository, 'git-malu/AnyWear-Infra');
    assert.equal(rows[0].source_sha, '88679b61630bc2344258cafb0d35b4d0b02e3a0d');
    assert.equal(rows[3].source_repository, 'git-malu/AnyWear-Service');
    assert.equal(rows[3].source_sha, '58444ebe15a0ea08ca8f0c8aa91d0ba8a7bfb759');
  }
  await runGuard('restore-release');
  await assert.rejects(runGuard('close-admission'), /Unchanged runtime\/recovery stack must retain/);
  const runtimeOnly = await readFile(new URL('../stack-sources/beta-runtime-only.json', import.meta.url));
  const producerRows = JSON.parse(runtimeOnly);
  // #95 S1 restore-release 37970047230/1, deployment artifact 11635817118.
  const deployedProducers = [
    { stack_name: 'AnyWearFoundationStack', region: 'ap-east-1', source_repository: 'git-malu/AnyWear-Infra',
      source_sha: '88679b61630bc2344258cafb0d35b4d0b02e3a0d' },
    { stack_name: 'AnyWearPlatformStack-beta', region: 'ap-east-1', source_repository: 'git-malu/AnyWear-Infra',
      source_sha: 'ada13617da0280ca9a7da0798577db286e714edc' },
    { stack_name: 'AnyWearWorkloadStack-beta', region: 'ap-east-1', source_repository: 'git-malu/AnyWear-Infra',
      source_sha: 'ada13617da0280ca9a7da0798577db286e714edc' },
    { stack_name: 'AnyWearBillingStack-beta', region: 'us-east-1', source_repository: 'git-malu/AnyWear-Service',
      source_sha: '58444ebe15a0ea08ca8f0c8aa91d0ba8a7bfb759' },
  ];
  assert.deepEqual(producerRows, deployedProducers);
  await writeFile(mapFile, runtimeOnly); await git(['add', 'stack-sources/beta-restart.json']);
  await git(['commit', '--quiet', '-m', 'Reviewed runtime-only producer map']);
  assert.notEqual(await git(['rev-parse', 'HEAD']), deployedProducers[1].source_sha);
  for (const operation of ['observe', 'migrate', 'verify', 'tester-status', 'tester-add', 'tester-replace', 'close-admission']) {
    await runGuard(operation, sha256(runtimeOnly));
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'deployment-evidence/stack-sources.json'), 'utf8')), deployedProducers);
  }
  await assert.rejects(runGuard('restore-release', sha256(runtimeOnly)), /Changed stack must bind/);
  await writeFile(mapFile, mapBytes); await git(['add', 'stack-sources/beta-restart.json']);
  await git(['commit', '--quiet', '-m', 'Restore reviewed restart map fixture']);
  await assert.rejects(runGuard('start', '9'.repeat(64)), /Stack source bytes differ/);
  for (const [mutate, error] of [
    [rows => rows[1].source_sha = '7'.repeat(40), /Changed stack must bind/],
    [rows => { rows[1].source_repository = 'git-malu/AnyWear-Service'; rows[1].source_sha = '7'.repeat(40); }, /Changed stack must bind/],
    [rows => rows[2].source_repository = 'git-malu/AnyWear-Service', /Invalid stack producer source/],
    [rows => rows[3].region = 'ap-east-1', /Unexpected stack provenance/],
    [rows => rows[3].stack_name = rows[0].stack_name, /Four unique stack sources/],
    [rows => rows[3].source_repository = 'git-malu/Other', /Unexpected stack provenance/],
    [rows => rows[0].extra = true, /fields/],
  ]) {
    const rows = JSON.parse(mapBytes); mutate(rows); const bytes = Buffer.from(JSON.stringify(rows));
    await writeFile(mapFile, bytes); await git(['add', 'stack-sources/beta-restart.json']); await git(['commit', '--quiet', '-m', 'Reviewed invalid map fixture']);
    await assert.rejects(runGuard('start', sha256(bytes)), error);
  }
});

test('actual runtime deploy sends CDK-supported no-rollback for stopped stacks and keeps active behavior', async () => {
  const execute = promisify(execFile);
  const root = await mkdtemp(path.join(os.tmpdir(), 'infra-stop-command-'));
  const { selector } = await createTestInputs(await mkdtemp(path.join(os.tmpdir(), 'infra-stop-artifacts-')));
  const git = async args => (await execute('git', ['-C', root, ...args])).stdout.trim();
  await git(['init', '--quiet']); await git(['config', 'core.autocrlf', 'false']);
  await git(['config', 'user.name', 'Command fixture']); await git(['config', 'user.email', 'fixture@invalid.local']);
  await git(['remote', 'add', 'origin', 'https://github.com/git-malu/AnyWear-Infra.git']);
  await mkdir(path.join(root, 'selections')); await writeFile(path.join(root, 'selections/beta.json'), canonicalJson(selector));
  await git(['add', '.']); await git(['commit', '--quiet', '-m', 'Reviewed selection']);
  const env = { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265', GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: await git(['rev-parse', 'HEAD']), GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/beta-lifecycle.yml@refs/heads/main',
    AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_DEPLOY: 'true', INFRA_OPERATION: 'stop',
    INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true', SELECTION_FILE: 'selections/beta.json', SELECTION_SHA256: contentHash(selector) };
  const revision = { parameters: { ServiceImageDigest: selector.image.digest, ServiceCommitSha: selector.image.service_sha,
    VlmConfigArn: 'arn:secret', CloudFrontPrefixListId: 'pl-test' } };
  const commands = []; let credentials = 0; const boundary = new Error('No deployment executed');
  const io = await createRuntimeIo(selector, '/verified/assets', env, undefined, { trustedInfraRoot: root,
    async assume(kind) { credentials++; assert.ok(['runtime', 'deploy'].includes(kind)); return { ...env }; },
    async run(command, args) {
      if (command === 'aws') return { stdout: JSON.stringify(args[1] === 'list-tasks' ? { taskArns: [] }
        : args[1] === 'get-template' ? { TemplateBody: { Resources: {} } }
          : { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', Outputs: [] }] }), stderr: '' };
      assert.equal(command, 'npx'); commands.push(args); throw boundary;
    },
  });
  for (const name of ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta']) {
    await assert.rejects(io.deploy(name, false, revision), error => error === boundary);
    const args = commands.at(-1);
    assert.ok(args.includes('--no-rollback')); assert.ok(args.includes('betaActive=false'));
    assert.ok(args.includes('legacyRoleOwnership=external')); assert.ok(args.includes('artifactDirectory=/verified/assets'));
    if (name.includes('Workload')) {
      const parameterArgs = args.flatMap((value, index) => value === '--parameters' ? [args[index + 1]] : []);
      assert.deepEqual(parameterArgs, [
        `AnyWearWorkloadStack-beta:ServiceImageDigest=${selector.image.digest}`,
        `AnyWearWorkloadStack-beta:ServiceCommitSha=${selector.image.service_sha}`,
        'AnyWearWorkloadStack-beta:VlmConfigArn=arn:secret',
        'AnyWearWorkloadStack-beta:CloudFrontPrefixListId=pl-test',
        'AnyWearWorkloadStack-beta:BetaApiSizingProfile=s1',
      ]);
      assert.equal(parameterArgs.some(value => value.startsWith('ServiceImageDigest=')), false);
    } else assert.equal(args.includes('--parameters'), false);
  }
  await assert.rejects(io.deploy('AnyWearWorkloadStack-beta', true, revision), error => error === boundary);
  assert.equal(commands.at(-1).includes('--no-rollback'), false); assert.ok(commands.at(-1).includes('betaActive=true'));
  assert.equal(credentials, 2);
  // Use the pinned bundled CLI, whose internal unbundled parser is not a public API.
  const help = await execute(process.execPath, ['node_modules/aws-cdk/bin/cdk', ...commands[0].slice(1), '--help'], { timeout: 15_000 });
  assert.match(help.stdout, /--no-rollback/); assert.match(help.stdout, /Rollback stack to stable state/);
});
