import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, realpath, readdir } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
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

test('credential-free Linux CLI state regression', {
  skip: process.env.REQUIRE_LINUX_CLI_REGRESSION !== 'true', timeout: 120_000,
}, async () => {
  const executable = process.env.CLI_EXECUTABLE;
  const resultFile = process.env.CLI_REGRESSION_RESULT;
  assert.ok(path.isAbsolute(executable ?? '') && path.isAbsolute(resultFile ?? ''), 'Explicit external tool/result paths required');
  const sourceRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  const outsideSource = target => {
    const relative = path.relative(sourceRoot, target);
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  };
  assert.ok(outsideSource(await realpath(executable)) && outsideSource(await realpath(path.dirname(resultFile))),
    'CLI executable and report must remain outside source');
  const commands = [['--version'], ['release', 'verify', '--format', 'json', '--help'], ['release', 'verify-asset', '--format', 'json', '--help']];
  const report = { schema_version: 1, record_type: 'anywear_offline_cli_state_regression', cli_version: '2.101.0',
    network_isolated: false, credentials_supplied: false, native_reads_performed: false, passed: false, trials: [] };
  const clean = value => !value.porcelain_dirty && !value.replacement_refs && !value.hidden_index;
  try {
    assert.equal(process.platform, 'linux', 'Required regression must run on Linux');
    // Source CI starts this test in a fresh network namespace. Neither telemetry
    // nor an unexpected CLI command can reach a network or credential service.
    const interfaces = (await readFile('/proc/net/dev', 'utf8')).split('\n').slice(2).filter(line => line.includes(':'))
      .map(line => line.split(':')[0].trim());
    assert.deepEqual(interfaces, ['lo'], 'CLI regression requires a network-isolated namespace');
    report.network_isolated = true;
    for (const profile of ['original', 'telemetry-disabled', 'state-confined']) {
      const current = await checkout(); const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'anywear-offline-config-'));
      const commandEnv = commandEnvironment(process.env, configDirectory);
      // This restores W's exact sanitized environment, not an approximately
      // filtered user environment. The implementation adds only this fixed key.
      if (profile !== 'telemetry-disabled') delete commandEnv.GH_TELEMETRY;
      if (profile === 'state-confined') commandEnv.XDG_STATE_HOME = path.join(configDirectory, 'state');
      for (const key of ['HOME', 'USERPROFILE', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'NODE_OPTIONS', 'GH_DEBUG']) {
        assert.equal(commandEnv[key], undefined, 'Offline child environment excludes credentials and user state');
      }
      const git = async args => (await execute('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', current.root, ...args],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: commandEnvironment(process.env, '') })).stdout;
      const snapshot = async () => {
        const porcelain = await git(['status', '--porcelain=v1', '--untracked-files=all']);
        return { porcelain_dirty: Boolean(porcelain.trim()), replacement_refs: Boolean((await git(['for-each-ref', '--format=%(refname)', 'refs/replace'])).trim()),
          hidden_index: (await git(['ls-files', '-v', '-z'])).split('\0').filter(Boolean).some(line => !line.startsWith('H ')),
          only_telemetry_device_file: porcelain.trim() === '?? .local/state/gh/device-id' };
      };
      await loadCommittedSelection(current.binding);
      const trial = { profile, before: await snapshot(), commands: [] }; report.trials.push(trial);
      for (const args of commands) {
        let stdout; let exitCode;
        try {
          stdout = (await execute(executable, args, { cwd: current.root, encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024, env: commandEnv })).stdout;
          exitCode = 0;
        } catch (error) { exitCode = Number.isInteger(error.code) ? error.code : 'process-failed'; }
        // Persist fixed predicates and outcomes only, never stderr/environment
        // or arbitrary checkout contents. CLI version must be the failed one.
        const result = { command: args.join(' '), exit_code: exitCode, after: await snapshot() };
        if (args[0] === '--version') result.pinned_version_matches = /^gh version 2\.101\.0 /.test(stdout ?? '');
        trial.commands.push(result);
      }
      if (profile === 'state-confined') trial.external_device_file = await readFile(path.join(configDirectory, 'state', 'gh', 'device-id'))
        .then(bytes => bytes.length > 0, () => false);
      if (profile === 'telemetry-disabled') trial.external_config_empty = (await readdir(configDirectory)).length === 0;
      trial.guard_rejected = await loadCommittedSelection(current.binding).then(() => false, error => {
        assert.match(error.message, /clean/); return true;
      });
    }
    // Observe every profile before asserting the hypothesis, so a failed
    // reproduction still preserves the original and fixed predicate results.
    for (const trial of report.trials) {
      assert.ok(clean(trial.before), 'Every trial must start from a strict clean checkout');
      assert.ok(trial.commands.every(result => result.exit_code === 0), 'Offline probes must exit successfully');
      assert.equal(trial.commands[0].pinned_version_matches, true, 'Pinned failed-reader CLI required');
      if (trial.profile === 'original') {
        assert.ok(trial.commands.every(result => result.after.only_telemetry_device_file && !result.after.replacement_refs && !result.after.hidden_index),
          'Original environment must reproduce only the untracked telemetry device file');
        assert.equal(trial.guard_rejected, true, 'Original contamination must trip the strict checkout guard');
      } else {
        assert.ok(trial.commands.every(result => clean(result.after)), 'Isolated CLI must preserve every strict checkout predicate');
        assert.equal(trial.guard_rejected, false);
        if (trial.profile === 'state-confined') assert.equal(trial.external_device_file, true, 'State confinement must demonstrate the same write outside source');
        else assert.equal(trial.external_config_empty, true, 'Telemetry opt-out requires no user state or configuration');
      }
    }
    report.passed = true;
  } finally { await writeFile(resultFile, canonicalJson(report)); }
});

test('source drift at a remote boundary aborts before any subsequent remote read', async () => {
  const current = await checkout(); let reads = 0;
  await assert.rejects(verifySelection(current.binding, path.join(inputs, 'drift-download'), { async api() {
    reads++; await writeFile(path.join(current.root, 'source.txt'), 'drift');
    const components = [{ asset_id: selector.release.manifest_asset_id, file: 'service-artifacts.json' }, ...Object.values(selector.lambdas), selector.runtime_policy, selector.schema];
    return { id: selector.release.id, immutable: true, draft: false, assets: await Promise.all(components.map(async item => {
      const bytes = await readFile(path.join(inputs, item.file)); return { id: item.asset_id, name: item.file, state: 'uploaded', size: bytes.length, digest: `sha256:${sha256(bytes)}` };
    })) };
  } }), /clean/);
  assert.equal(reads, 1);
  await assert.rejects(loadCommittedSelection(current.binding), /clean/);
});
