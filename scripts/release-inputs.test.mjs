import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RELEASE_ASSETS,
  SERVICE_REPOSITORY,
  runVerifyInputs,
  validateReleaseInput,
} from './release-inputs.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { parseJson, sha256 } from './json-contract.mjs';

// Regression coverage for #158 round 4: `restore-release` deploys the same stage
// base as `deploy-platform`, so it takes the same reviewed Service release
// identity and must download and prove the same four sealed assets. The existing
// restore test mocks `io` and therefore cannot reach this gate.
const root = path.resolve(import.meta.dirname, '..');
const releaseTag = 'v1.2.3';
// `createTestInputs` builds a sealed-release-shaped directory from this source.
const serviceCommit = '1'.repeat(40);
const releaseOperations = ['deploy-platform', 'restore-release'];
const selectedDirectory = path.join(root, '.service-artifacts', 'selected');
const otherOperations = ['deploy-foundation', 'deploy-billing', 'migrate', 'admission-status', 'add-testers',
  'set-testers', 'open-admission', 'close-admission', 'observe', 'state', 'verify', 'deploy-workload'];

const releaseEnv = (operation) => ({ INFRA_OPERATION: operation, SERVICE_RELEASE_TAG: releaseTag,
  SERVICE_COMMIT: serviceCommit });

const directories = [];
async function temporary(prefix, child) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return child ? path.join(directory, child) : directory;
}
test.after(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
});

// The exact `gh` surface `downloadReleaseInputs` uses: one release view and one
// download into `--dir`. It writes the same bytes `createTestInputs` produced, so
// a passing run proves the download, the manifest binding and the final directory
// the deploy consumes.
function sealedRelease(fixture, { tamper } = {}) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push([command, [...args], options]);
    assert.equal(command, 'gh');
    assert.equal(options.env.GH_TOKEN, 'read-only-token');
    if (args[0] === 'release' && args[1] === 'view') {
      return { stdout: JSON.stringify({ databaseId: 407218593, tagName: releaseTag, isDraft: false,
        assets: RELEASE_ASSETS.map((name) => ({ name, state: 'uploaded', size: 1024 })) }) };
    }
    if (args[0] === 'release' && args[1] === 'download') {
      const directory = args[args.indexOf('--dir') + 1];
      await mkdir(directory, { recursive: true });
      for (const name of RELEASE_ASSETS) await copyFile(path.join(fixture, name), path.join(directory, name));
      if (tamper) await writeFile(path.join(directory, tamper), 'tampered bytes');
      return { stdout: '' };
    }
    throw new Error(`Unexpected gh invocation ${args.join(' ')}`);
  };
  return { calls, run };
}

test('restore-release and deploy-platform take the reviewed Service release identity', () => {
  for (const operation of releaseOperations) {
    // The restore branch is the regression: this call threw on the pre-fix source.
    assert.deepEqual(validateReleaseInput(releaseEnv(operation)), { releaseTag, serviceCommit });
    assert.deepEqual(validateReleaseInput(releaseEnv(operation), operation), { releaseTag, serviceCommit });
  }
  // The reviewed identity is explicit: a missing or malformed half fails closed.
  for (const operation of releaseOperations) {
    assert.throws(() => validateReleaseInput({ INFRA_OPERATION: operation, SERVICE_COMMIT: serviceCommit }),
      new RegExp(`${operation} requires the explicit Service release tag`));
    assert.throws(() => validateReleaseInput({ INFRA_OPERATION: operation, SERVICE_RELEASE_TAG: releaseTag }),
      /Invalid Service release source commit/);
    assert.throws(() => validateReleaseInput({ INFRA_OPERATION: operation, SERVICE_RELEASE_TAG: releaseTag,
      SERVICE_COMMIT: 'a'.repeat(39) }), /Invalid Service release source commit/);
    assert.throws(() => validateReleaseInput({ INFRA_OPERATION: operation, SERVICE_RELEASE_TAG: 'bad tag',
      SERVICE_COMMIT: serviceCommit }), /requires the explicit Service release tag/);
    // A restore dispatch with no release identity is a failure, not a null gate.
    assert.throws(() => validateReleaseInput({ INFRA_OPERATION: operation }), /requires the explicit Service release tag/);
  }
});

test('the reviewed fix exposes the one deploy directory and both release operations', async () => {
  const module = await import('./release-inputs.mjs');
  assert.deepEqual([...module.RELEASE_IDENTITY_OPERATIONS], releaseOperations);
  assert.equal(module.SELECTED_RELEASE_DIRECTORY, selectedDirectory);
});

test('every other operation still rejects a supplied release identity and takes none', () => {
  for (const operation of otherOperations) {
    assert.throws(() => validateReleaseInput(releaseEnv(operation)),
      /Only deploy-platform and restore-release take a Service release identity/, operation);
    assert.throws(() => validateReleaseInput({ INFRA_OPERATION: operation, SERVICE_RELEASE_TAG: releaseTag }),
      /Only deploy-platform and restore-release take a Service release identity/, operation);
    assert.equal(validateReleaseInput({ INFRA_OPERATION: operation }), null, operation);
  }
});

test('restore-release downloads and proves the four sealed assets into the deploy directory', async () => {
  const fixture = await temporary('infra-release-fixture-');
  await createTestInputs(fixture);
  const selected = await temporary('infra-release-selected-', path.join('.service-artifacts', 'selected'));
  const { calls, run } = sealedRelease(fixture);
  const record = await runVerifyInputs({ env: releaseEnv('restore-release'), run, token: 'read-only-token',
    directory: selected });

  // The gate now returns the release instead of null, so the deploy job binds a
  // release this operation actually downloaded.
  assert.equal(record.record_type, 'anywear_infra_release_inputs');
  assert.equal(record.repository, SERVICE_REPOSITORY);
  assert.deepEqual(record.release, { id: 407218593, tag: releaseTag, source_sha: serviceCommit,
    image_digest: `sha256:${'4'.repeat(64)}` });
  assert.deepEqual(Object.keys(record.assets).sort(), [...RELEASE_ASSETS].sort());

  // The four sealed assets and the binding record are in the directory the CDK
  // deploy consumes, and each hash is the downloaded byte hash.
  for (const name of RELEASE_ASSETS) {
    const bytes = await readFile(path.join(selected, name));
    assert.equal(sha256(bytes), record.assets[name], name);
  }
  const binding = parseJson(await readFile(path.join(selected, 'release-inputs.json')));
  assert.deepEqual(binding, record);
  // The download lands in the directory `createRuntimeIo`/`cdkDeploymentArguments`
  // pass to the stage-base deploy (`.service-artifacts/selected`).
  assert.equal(path.basename(selected), 'selected');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][1].slice(calls[1][1].indexOf('--dir'), calls[1][1].indexOf('--dir') + 2),
    ['--dir', selected]);
});

test('deploy-platform still downloads the same sealed assets', async () => {
  const fixture = await temporary('infra-release-fixture-');
  await createTestInputs(fixture);
  const selected = await temporary('infra-release-selected-', path.join('.service-artifacts', 'selected'));
  const { run } = sealedRelease(fixture);
  const record = await runVerifyInputs({ env: releaseEnv('deploy-platform'), run, token: 'read-only-token',
    directory: selected });
  assert.deepEqual(record.release, { id: 407218593, tag: releaseTag, source_sha: serviceCommit,
    image_digest: `sha256:${'4'.repeat(64)}` });
  for (const name of RELEASE_ASSETS) {
    assert.ok((await readFile(path.join(selected, name))).length > 0, name);
  }
});

test('reads the numeric release databaseId, not the GraphQL node id', async () => {
  const fixture = await temporary('infra-release-fixture-');
  await createTestInputs(fixture);
  const selected = await temporary('infra-release-selected-', path.join('.service-artifacts', 'selected'));
  const { calls, run } = sealedRelease(fixture);
  const record = await runVerifyInputs({ env: releaseEnv('deploy-platform'), run, token: 'read-only-token',
    directory: selected });
  // The record contract requires a numeric ID, which `gh` exposes as databaseId.
  const viewCall = calls[0][1];
  assert.deepEqual(viewCall.slice(viewCall.indexOf('--json'), viewCall.indexOf('--json') + 2),
    ['--json', 'databaseId,tagName,isDraft,assets']);
  assert.equal(record.release.id, 407218593);
  assert.equal(Number.isSafeInteger(record.release.id), true);

  // A release view that only carries the GraphQL node ID (`RE_...`) fails closed
  // before any download: it cannot state the numeric release identity.
  let downloaded = false;
  const nodeIdOnly = async (command, args) => {
    assert.equal(command, 'gh');
    if (args[0] === 'release' && args[1] === 'view') {
      return { stdout: JSON.stringify({ id: 'RE_kwDORQyzo84Y1D8V', tagName: releaseTag, isDraft: false,
        assets: RELEASE_ASSETS.map((name) => ({ name, state: 'uploaded', size: 1024 })) }) };
    }
    downloaded = true;
    throw new Error('the release must not download without a numeric ID');
  };
  await assert.rejects(runVerifyInputs({ env: releaseEnv('deploy-platform'), run: nodeIdOnly,
    token: 'read-only-token', directory: selected }), /Invalid sealed Service release fields/);
  assert.equal(downloaded, false);
});

test('restore-release fails closed on a missing identity, a missing token or tampered bytes', async () => {
  const fixture = await temporary('infra-release-fixture-');
  await createTestInputs(fixture);
  const selected = await temporary('infra-release-selected-', path.join('.service-artifacts', 'selected'));
  let invoked = false;
  const forbidden = async () => { invoked = true; throw new Error('must not read a release without an identity'); };
  await assert.rejects(runVerifyInputs({ env: { INFRA_OPERATION: 'restore-release' }, run: forbidden,
    token: 'read-only-token', directory: selected }), /requires the explicit Service release tag/);
  await assert.rejects(runVerifyInputs({ env: { INFRA_OPERATION: 'restore-release', SERVICE_RELEASE_TAG: releaseTag },
    run: forbidden, token: 'read-only-token', directory: selected }), /Invalid Service release source commit/);
  assert.equal(invoked, false);

  const { run } = sealedRelease(fixture);
  await assert.rejects(runVerifyInputs({ env: releaseEnv('restore-release'), run, directory: selected }),
    /A read-only Service token is required/);
  // A modified download cannot reach the deploy directory under an accepted record.
  const tampered = sealedRelease(fixture, { tamper: 'pre-sign-up.zip' });
  await assert.rejects(runVerifyInputs({ env: releaseEnv('restore-release'), run: tampered.run,
    token: 'read-only-token', directory: selected }), /Release component pre-sign-up.zip differs from the sealed manifest/);
});
