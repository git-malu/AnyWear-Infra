import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseJson, sha256, canonicalJson, exact, matches, integer, SHA } from './json-contract.mjs';
import { loadLocalArtifactInputs } from './local-artifact-inputs.mjs';

// The reviewed Service release identity that replaces the committed `selection`:
// the tag names one sealed release; the commit names the Service source that
// built its image and Lambda assets. Both are explicit dispatch inputs, so the
// deployed Lambda bytes are reviewed before any credential is requested.
const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
export const SERVICE_REPOSITORY = 'git-malu/AnyWear-Service';
// The sealed release carries the Service-built Lambda bundles, the runtime policy
// the stage base reads and the release manifest that binds their hashes.
export const RELEASE_ASSETS = Object.freeze(['service-artifacts.json', 'pre-sign-up.zip', 'post-confirmation.zip', 'runtime-policy.json']);
// The one directory the CDK stage-base deploy consumes. The verify job downloads
// the sealed release into it and the deploy job re-hashes the travelled artifact
// before any credential, so both sides name the same bytes.
export const SELECTED_RELEASE_DIRECTORY = path.join(root, '.service-artifacts', 'selected');
// Both operations deploy the stage base, which consumes the Service-built Lambda
// bundles and runtime policy. A release identity supplied to any other operation
// is rejected instead of silently ignored.
export const RELEASE_IDENTITY_OPERATIONS = Object.freeze(['deploy-platform', 'restore-release']);
const GH_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// One reviewed input per stage-base deploy path. `deploy-platform` and
// `restore-release` both take Service-built Lambda assets; every other operation
// takes none and rejects a supplied release identity.
export function validateReleaseInput(env = process.env, operation = env.INFRA_OPERATION) {
  const releaseTag = env.SERVICE_RELEASE_TAG ?? '';
  const serviceCommit = env.SERVICE_COMMIT ?? '';
  if (!RELEASE_IDENTITY_OPERATIONS.includes(operation)) {
    if (releaseTag || serviceCommit) throw new Error('Only deploy-platform and restore-release take a Service release identity');
    return null;
  }
  if (!GH_TAG.test(releaseTag)) throw new Error(`${operation} requires the explicit Service release tag`);
  matches(serviceCommit, SHA, 'Service release source commit');
  return { releaseTag, serviceCommit };
}

export function releaseInputsRecord({ release, assets }) {
  return { schema_version: 1, record_type: 'anywear_infra_release_inputs', repository: SERVICE_REPOSITORY,
    release: { id: release.id, tag: release.tag, source_sha: release.sourceSha, image_digest: release.imageDigest }, assets };
}

function assertComponent(entry, file, hashes) {
  if (entry?.file !== file || entry?.sha256 !== hashes[file]) throw new Error(`Release component ${file} differs from the sealed manifest`);
  return entry;
}

// Download only the four sealed assets, then prove each byte against the release
// manifest. There is no selection schema, no native attestation and no vendored
// Service parser on this path: the manifest is the Service release's own record of
// what it built, and its `image.service_sha` binds it to the reviewed commit.
export async function downloadReleaseInputs({ releaseTag, serviceCommit, directory = SELECTED_RELEASE_DIRECTORY,
  token, run = execute }) {
  if (typeof token !== 'string' || !token) throw new Error('A read-only Service token is required to read the sealed release');
  await mkdir(directory, { recursive: true });
  const env = { ...process.env, GH_TOKEN: token, GH_TELEMETRY: 'disabled' };
  const view = parseJson((await run('gh', ['release', 'view', releaseTag, '--repo', SERVICE_REPOSITORY,
    '--json', 'id,tagName,isDraft,assets'], { env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout);
  exact(view, ['id', 'tagName', 'isDraft', 'assets'], 'sealed Service release');
  integer(view.id, 'release ID');
  if (view.isDraft !== false || view.tagName !== releaseTag) throw new Error('Reviewed Service release is not the sealed published release');
  const published = new Map((view.assets ?? []).map(asset => [asset.name, asset]));
  for (const name of RELEASE_ASSETS) {
    const asset = published.get(name);
    if (!asset || asset.state !== 'uploaded' || !(asset.size > 0)) throw new Error(`Sealed Service release lacks ${name}`);
  }
  await run('gh', ['release', 'download', releaseTag, '--repo', SERVICE_REPOSITORY, '--dir', directory, '--clobber',
    ...RELEASE_ASSETS.flatMap(name => ['--pattern', name])], { env, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
  const bytes = name => readFile(path.join(directory, name));
  const hashes = {};
  for (const name of RELEASE_ASSETS) hashes[name] = sha256(await bytes(name));
  const manifest = parseJson(await bytes('service-artifacts.json'));
  if (manifest?.schema_version !== 1 || manifest?.record_type !== 'anywear_service_artifacts'
    || manifest?.producer?.repository !== SERVICE_REPOSITORY
    || typeof manifest?.producer?.workflow_ref !== 'string' || !manifest.producer.workflow_ref.startsWith(`${SERVICE_REPOSITORY}/.github/workflows/`)) {
    throw new Error('Downloaded release manifest is not a Service artifact record');
  }
  const image = manifest.components?.image;
  if (image?.service_sha !== serviceCommit) throw new Error('Sealed release does not represent the reviewed Service commit');
  matches(image.digest, /^sha256:[a-f0-9]{64}$/, 'release image digest');
  assertComponent(manifest.components?.lambdas?.pre_sign_up, 'pre-sign-up.zip', hashes);
  assertComponent(manifest.components?.lambdas?.post_confirmation, 'post-confirmation.zip', hashes);
  const policy = assertComponent(manifest.components?.runtime_policy, 'runtime-policy.json', hashes);
  for (const component of [manifest.components.lambdas.pre_sign_up, manifest.components.lambdas.post_confirmation, policy]) {
    if (component.service_sha !== serviceCommit) throw new Error('Release component was built from another Service source');
  }
  // The same strict loader CDK uses, so the downloaded bytes are proven parseable
  // before the deploy job binds and deploys them.
  loadLocalArtifactInputs(directory);
  const record = releaseInputsRecord({ assets: hashes,
    release: { id: view.id, tag: releaseTag, sourceSha: serviceCommit, imageDigest: image.digest } });
  await writeFile(path.join(directory, 'release-inputs.json'), canonicalJson(record));
  return record;
}

export async function runVerifyInputs({ env = process.env, run = execute, token = env.GH_TOKEN,
  directory = SELECTED_RELEASE_DIRECTORY } = {}) {
  const release = validateReleaseInput(env);
  if (!release) return null;
  return downloadReleaseInputs({ ...release, token, run, directory });
}
