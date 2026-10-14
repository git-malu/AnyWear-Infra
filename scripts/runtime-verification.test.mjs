import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeCommandBytes, runRuntimeVerification } from './verify-runtime-task.mjs';
import { createTestInputs, stackManifestFixture } from './create-test-inputs.mjs';
import { canonicalJson, contentHash, parseJson } from './json-contract.mjs';
import { createRuntimeIo } from './runtime-operation.mjs';
import { createOperationRecord } from './operation-record.mjs';

const { selector, manifest, schema } = await createTestInputs(await mkdtemp(path.join(os.tmpdir(), 'infra-verify-')));
const sha = '5'.repeat(40);
const env = { GITHUB_SHA: sha, GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_RUN_ID: '23', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1' };
const outputs = Object.fromEntries(['PrivateSubnetIds', 'OneShotSecurityGroupId', 'VerificationTaskRoleArn', 'OneShotExecutionRoleArn',
  'OneShotLogGroupName', 'DatabaseSecretArn', 'DatabaseHost', 'DatabasePort', 'DatabaseName', 'WardrobeBucketName'].map(key => [key, key]));
Object.assign(outputs, { EcsClusterName: 'beta-anywear', BetaActive: 'true' });

function mockIo(mode) {
  let definition; const calls = [];
  const taskArn = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'a'.repeat(32)}`;
  const taskDefinitionArn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-artifact-verify:1';
  const migrations = schema.migrations.map(row => ({ id: row.sha256, created_at: row.created_at }));
  const evidence = { schema_version: 1, record_type: 'anywear_read_only_runtime', service_sha: selector.image.service_sha,
    image_digest: selector.image.digest, policy_file_sha256: manifest.components.runtime_policy.sha256,
    policy_content_sha256: manifest.components.runtime_policy.content_sha256, selected_journal_sha256: schema.journal ? contentHash(schema.journal) : selector.schema.journal_sha256,
    selected_migration_ids: migrations, applied_migration_ids: migrations, applied_schema_version: schema.current_version, observed_applied_journal_sha256: contentHash(migrations) };
  return { calls, async aws(args) {
    calls.push(args);
    switch (args[1]) {
      case 'register-task-definition': definition = JSON.parse(args[args.indexOf('--cli-input-json') + 1]); return { taskDefinition: { taskDefinitionArn } };
      case 'run-task': return { tasks: [{ taskArn }] };
      case 'wait': return {};
      case 'describe-tasks': return { tasks: [{ taskArn, taskDefinitionArn, lastStatus: mode === 'running' ? 'RUNNING' : 'STOPPED',
        containers: [{ name: 'OneShot', exitCode: mode === 'exit' ? 1 : 0, imageDigest: mode === 'image' ? `sha256:${'9'.repeat(64)}` : selector.image.digest }] }] };
      case 'describe-task-definition': {
        const actual = structuredClone(definition);
        if (mode === 'code') actual.containerDefinitions[0].command = ['node', '-e', 'different'];
        if (mode === 'role') actual.taskRoleArn = 'incorrect';
        return { taskDefinition: actual };
      }
      case 'get-log-events': return { events: Array.from({ length: mode === 'duplicate' ? 2 : 1 }, () => ({ message: `ANYWEAR_RUNTIME_EVIDENCE:${JSON.stringify(evidence)}` })) };
      case 'deregister-task-definition': return {};
      default: throw new Error('Unexpected AWS test call');
    }
  } };
}

test('runtime command enforces a total OS deadline even when image file IO blocks synchronously', { timeout: 40_000 }, async () => {
  const code = (await runtimeCommandBytes()).toString();
  const compiled = new vm.Script(code);
  let failure; const stopped = new Error('VM process exited'); const start = Date.now();
  assert.throws(() => compiled.runInNewContext({ require(name) {
    assert.equal(name, 'node:child_process');
    return { spawnSync(command, args, options) {
      // Block the actual embedded image process before its event-loop timer can
      // run. The unchanged outer command must kill that OS child within 30s.
      args[1] = `const blockingFs=require('node:fs');blockingFs.readFileSync=()=>{while(true){}};\n${args[1]}`;
      return spawnSync(command, args, options);
    } };
  }, process: { execPath: process.execPath, stdout: { write() { assert.fail('Blocked child cannot yield evidence'); } }, exit(status) { failure = status; throw stopped; } }, console: { error() {} } }), error => error === stopped);
  assert.equal(failure, 1);
  assert.ok(Date.now() - start >= 29_000 && Date.now() - start < 38_000);
});

test('verification binds actual stopped image/code/roles, schema and executor, and rejects drift', async () => {
  const io = mockIo();
  const result = await runRuntimeVerification({ io, outputs, selector, manifest, schema, infraSha: sha, env });
  assert.equal(result.schema.compatibility_result, 'compatible');
  assert.equal(result.schema.verification.source_sha, sha);
  assert.equal(result.schema.verification.executor.run_id, 23);
  assert.ok(io.calls.some(call => call[1] === 'deregister-task-definition'));
  for (const mode of ['image', 'exit', 'code', 'role', 'duplicate', 'running']) {
    const drift = mockIo(mode);
    await assert.rejects(runRuntimeVerification({ io: drift, outputs, selector, manifest, schema, infraSha: sha, env }));
    if (mode === 'running') assert.ok(!drift.calls.some(call => call[1] === 'deregister-task-definition'));
  }
});

test('final qualification appends authenticated task events to the actual parsed operation file on success and failure', async () => {
  const execute = promisify(execFile);
  const root = await mkdtemp(path.join(os.tmpdir(), 'infra-parsed-qualification-'));
  const git = async args => (await execute('git', ['-C', root, ...args])).stdout.trim();
  await git(['init', '--quiet']); await git(['config', 'core.autocrlf', 'false']);
  await git(['config', 'user.name', 'Qualification fixture']); await git(['config', 'user.email', 'fixture@invalid.local']);
  await git(['remote', 'add', 'origin', 'https://github.com/git-malu/AnyWear-Infra.git']);
  await mkdir(path.join(root, 'selections')); await mkdir(path.join(root, 'deployment-evidence'));
  await writeFile(path.join(root, '.gitignore'), 'deployment-evidence/\n');
  await writeFile(path.join(root, 'selections/beta.json'), canonicalJson(selector));
  await git(['add', '.']); await git(['commit', '--quiet', '-m', 'Reviewed selection']);
  const source = await git(['rev-parse', 'HEAD']);
  const runtimeEnv = { ...env, GITHUB_SHA: source, GITHUB_REPOSITORY_ID: '1409047265', GITHUB_EVENT_NAME: 'workflow_dispatch',
    ENABLE_BETA_DEPLOY: 'true', INFRA_OPERATION: 'observe', INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true',
    SELECTION_FILE: 'selections/beta.json', SELECTION_SHA256: contentHash(selector) };
  const interfaces = { ...outputs, VerificationTaskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-verification-task',
    OneShotExecutionRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution' };
  const file = path.join(root, 'deployment-evidence/operation-record.json');
  for (const mode of [undefined, 'exit']) {
    const original = createOperationRecord({ env: runtimeEnv, selector, stackManifest: stackManifestFixture() });
    original.result = 'succeeded';
    original.events.push({ type: 'final-beta-activity', platform_active: 'true', workload_active: 'true' });
    await writeFile(file, canonicalJson(original));
    const operation = parseJson(await readFile(file));
    assert.equal(Object.getOwnPropertyDescriptor(operation, 'events').writable, false);
    const mocked = mockIo(mode); const purposes = [];
    const io = await createRuntimeIo(selector, '/verified/assets', runtimeEnv, operation, { trustedInfraRoot: root, purpose: 'qualification',
      async assume(kind, passed, purpose) { assert.equal(kind, 'runtime'); purposes.push(purpose); return passed; },
      async run(command, args) { assert.equal(command, 'aws'); return { stdout: JSON.stringify(await mocked.aws(args)) }; },
    });
    try {
      const verification = runRuntimeVerification({ io, outputs: interfaces, selector, manifest, schema, infraSha: source, env: runtimeEnv });
      if (mode) await assert.rejects(verification, /Actual stopped verification image\/result mismatch/);
      else assert.equal((await verification).schema.compatibility_result, 'compatible');
    } finally {
      await writeFile(file, canonicalJson(operation));
    }
    assert.deepEqual(purposes, ['qualification']);
    const persisted = parseJson(await readFile(file));
    assert.deepEqual(persisted.events, [...original.events,
      { type: 'runtime-task-definition', task_definition_arn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-artifact-verify:1' },
      { type: 'runtime-task-started', task_arns: [`arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'a'.repeat(32)}`], result: 'observed' },
    ]);
    assert.equal(persisted.result, 'succeeded');
    assert.deepEqual(persisted.selection, original.selection);
    assert.ok(mocked.calls.some(call => call[1] === 'deregister-task-definition'));
    await execute(process.execPath, [fileURLToPath(new URL('./finalize-operation.mjs', import.meta.url))], { cwd: root,
      env: { ...process.env, OPERATION_OUTCOME: 'success', OBSERVATION_OUTCOME: mode ? 'failure' : 'success' } });
    const finalized = parseJson(await readFile(file));
    assert.equal(finalized.result, mode ? 'failed' : 'succeeded');
    assert.equal(finalized.final_observation, mode ? 'failure' : 'success');
    assert.deepEqual(finalized.events, persisted.events);
  }
});
