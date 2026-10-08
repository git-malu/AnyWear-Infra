import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runtimeCommandBytes, runRuntimeVerification } from './verify-runtime-task.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { contentHash } from './json-contract.mjs';

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
