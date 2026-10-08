import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntimeIo } from './runtime-operation.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { canonicalJson, contentHash } from './json-contract.mjs';
import { changedStackNames } from './operation-stacks.mjs';

test('source provenance binds every stack mutated by deployment and lifecycle operations', () => {
  assert.deepEqual(changedStackNames('deploy-foundation'), ['AnyWearFoundationStack']);
  assert.deepEqual(changedStackNames('deploy-billing'), ['AnyWearBillingStack-beta']);
  assert.deepEqual(changedStackNames('deploy-platform'), ['AnyWearPlatformStack-beta']);
  assert.deepEqual(changedStackNames('deploy-workload'), ['AnyWearWorkloadStack-beta']);
  for (const operation of ['start', 'stop']) assert.deepEqual(changedStackNames(operation), ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta']);
  assert.deepEqual(changedStackNames('observe'), []);
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
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main',
    AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_DEPLOY: 'true', INFRA_OPERATION: 'stop',
    INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true', SELECTION_FILE: 'selections/beta.json', SELECTION_SHA256: contentHash(selector) };
  const revision = { parameters: { ServiceImageDigest: selector.image.digest, ServiceCommitSha: selector.image.service_sha,
    VlmConfigArn: 'arn:secret', CloudFrontPrefixListId: 'pl-test' } };
  const commands = []; let credentials = 0; const boundary = new Error('No deployment executed');
  const io = await createRuntimeIo(selector, '/verified/assets', env, undefined, { trustedInfraRoot: root,
    async assume(kind) { credentials++; assert.equal(kind, 'deploy'); return { ...env }; },
    async run(command, args) { assert.equal(command, 'npx'); commands.push(args); throw boundary; },
  });
  for (const name of ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta']) {
    await assert.rejects(io.deploy(name, false, revision), error => error === boundary);
    const args = commands.at(-1);
    assert.ok(args.includes('--no-rollback')); assert.ok(args.includes('betaActive=false'));
    assert.ok(args.includes('legacyRoleOwnership=external')); assert.ok(args.includes('artifactDirectory=/verified/assets'));
    if (name.includes('Workload')) assert.ok(args.includes(`ServiceImageDigest=${selector.image.digest}`));
  }
  await assert.rejects(io.deploy('AnyWearWorkloadStack-beta', true, revision), error => error === boundary);
  assert.equal(commands.at(-1).includes('--no-rollback'), false); assert.ok(commands.at(-1).includes('betaActive=true'));
  assert.equal(credentials, 1);
  // Use the pinned bundled CLI, whose internal unbundled parser is not a public API.
  const help = await execute(process.execPath, ['node_modules/aws-cdk/bin/cdk', ...commands[0].slice(1), '--help'], { timeout: 15_000 });
  assert.match(help.stdout, /--no-rollback/); assert.match(help.stdout, /Rollback stack to stable state/);
});
