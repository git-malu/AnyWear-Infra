import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, sha256 } from './json-contract.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { loadCommittedSelection, verifySelection, commandEnvironment, liveArtifactIo } from './artifact-consumer.mjs';

const execute = promisify(execFile);
const inputs = await mkdtemp(path.join(os.tmpdir(), 'anywear-selection-inputs-'));
const { selector } = await createTestInputs(inputs);
async function checkout(value = selector, format = canonicalJson) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'anywear-selection-source-'));
  const git = async args => (await execute('git', ['-C', root, ...args], { timeout: 30_000 })).stdout.trim();
  await git(['init', '--quiet']); await git(['config', 'user.name', 'Selection fixture']); await git(['config', 'user.email', 'fixture@invalid.local']);
  await git(['config', 'core.autocrlf', 'false']); await git(['remote', 'add', 'origin', 'https://github.com/git-malu/AnyWear-Infra.git']);
  await mkdir(path.join(root, 'selections')); const bytes = Buffer.from(format(value));
  await writeFile(path.join(root, 'selections/beta.json'), bytes); await writeFile(path.join(root, 'source.txt'), 'reviewed source');
  await git(['add', '--', 'selections/beta.json', 'source.txt']); await git(['commit', '--quiet', '-m', 'Reviewed fixture']);
  return { root, git, binding: { trustedInfraRoot: root, expectedInfraSha: await git(['rev-parse', 'HEAD']), selectionFile: 'selections/beta.json', selectionSha256: sha256(bytes) } };
}
test('loader binds actual regular committed canonical selection and explicit root/pin/path/hash', async () => {
  const current = await checkout(); assert.deepEqual(await loadCommittedSelection(current.binding), selector);
  for (const patch of [{ trustedInfraRoot: undefined }, { expectedInfraSha: undefined }, { expectedInfraSha: '9'.repeat(40) },
    { selectionFile: path.join(current.root, 'selections/beta.json') }, { selectionFile: '../beta.json' }, { selectionFile: 'selections/missing.json' }, { selectionSha256: '9'.repeat(64) }]) {
    await assert.rejects(loadCommittedSelection({ ...current.binding, ...patch }));
  }
  await current.git(['remote', 'set-url', 'origin', 'https://github.com/other/Infra.git']);
  await assert.rejects(loadCommittedSelection(current.binding), /origin/);
});
test('historical v1 and noncanonical selections are rejected without reinterpretation', async () => {
  const historical = await checkout({ ...selector, schema_version: 1, publication_acceptance: { file: 'publications/history.json', sha256: '9'.repeat(64) } });
  await assert.rejects(loadCommittedSelection(historical.binding), /historical v1/);
  const whitespace = await checkout(selector, value => canonicalJson(value) + '\n');
  await assert.rejects(loadCommittedSelection(whitespace.binding), /canonical/);
});
test('untracked, modified, skip-worktree and assume-unchanged source fail before any remote read', async () => {
  for (const alter of [async current => writeFile(path.join(current.root, 'extra.txt'), 'unreviewed'),
    async current => writeFile(path.join(current.root, 'source.txt'), 'changed'),
    async current => current.git(['update-index', '--skip-worktree', '--', 'source.txt']),
    async current => current.git(['update-index', '--assume-unchanged', '--', 'source.txt'])]) {
    const current = await checkout(); await alter(current); let reads = 0;
    await assert.rejects(verifySelection(current.binding, path.join(inputs, 'unused'), { api() { reads++; } }), /clean/);
    assert.equal(reads, 0);
  }
});
test('replacement refs cannot substitute another reviewed selection tree', async () => {
  const current = await checkout(); await writeFile(path.join(current.root, 'source.txt'), 'replacement');
  await current.git(['add', '--', 'source.txt']); await current.git(['commit', '--quiet', '-m', 'Replacement']);
  await current.git(['replace', current.binding.expectedInfraSha, await current.git(['rev-parse', 'HEAD'])]);
  await current.git(['--no-replace-objects', 'reset', '--hard', current.binding.expectedInfraSha]);
  await assert.rejects(loadCommittedSelection(current.binding), /clean/);
});
test('selection is a regular tracked blob rather than a symlink-mode entry', async () => {
  const current = await checkout(); const blob = await current.git(['hash-object', path.join(current.root, 'selections/beta.json')]);
  await current.git(['update-index', '--cacheinfo', `120000,${blob},selections/beta.json`]);
  await current.git(['commit', '--quiet', '-m', 'Symlink tree']); current.binding.expectedInfraSha = await current.git(['rev-parse', 'HEAD']);
  await assert.rejects(loadCommittedSelection(current.binding));
});
test('sanitized CLI environment fixes telemetry and accepts only the explicit Service token', async () => {
  const env = commandEnvironment({ PATH: 'system', GH_TOKEN: 'ambient', GITHUB_TOKEN: 'alternate', HOME: '/user', USERPROFILE: '/user',
    GH_TELEMETRY: 'enabled', XDG_STATE_HOME: '/user/state', GH_DEBUG: 'api', NODE_OPTIONS: 'attack', GIT_CONFIG_COUNT: '1' }, '/external', 'scoped-test-token');
  assert.equal(env.GH_TOKEN, 'scoped-test-token'); assert.equal(env.GH_TELEMETRY, 'disabled');
  for (const key of ['GITHUB_TOKEN', 'HOME', 'USERPROFILE', 'XDG_STATE_HOME', 'GH_DEBUG', 'NODE_OPTIONS', 'GIT_CONFIG_COUNT']) assert.equal(env[key], undefined);
  assert.equal(commandEnvironment({ GH_TOKEN: 'ambient' }, '/external').GH_TOKEN, undefined);
  await assert.rejects(liveArtifactIo({ token: '' }), /explicit/i);
  const config = await mkdtemp(path.join(os.tmpdir(), 'anywear-selection-cli-')); let calls = 0;
  const io = await liveArtifactIo({ token: 'scoped-test-token', configDirectory: config, env: { GH_TOKEN: 'ambient', GH_DEBUG: 'api' },
    run: async (command, args, options) => { calls++; assert.equal(command, 'gh'); assert.deepEqual(args, ['api', 'repos/git-malu/AnyWear-Service']);
      assert.equal(options.env.GH_TOKEN, 'scoped-test-token'); assert.equal(options.env.GH_TELEMETRY, 'disabled'); assert.equal(options.env.GH_DEBUG, undefined); return { stdout: '{}' }; } });
  await io.api('repos/git-malu/AnyWear-Service'); assert.equal(calls, 1);
});
