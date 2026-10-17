import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { sha256, contentHash } from './json-contract.mjs';
import { configuredStacks } from './operation-stacks.mjs';

// Local fixture for the two source matrices and the pre-credential deployment
// check. It reproduces the shape of a sealed Service release directory that the
// stage base consumes: the two Lambda bundles, their runtime policy and the
// release manifest that binds the downloaded bytes. No selection, no schema asset
// and no committed Service artifact participates.
export const SOURCE_BUILD_OPTIONS = Object.freeze({
  bundle: true, platform: 'node', target: 'node24', format: 'cjs', minify: true,
  sourcemap: 'external', packages: 'bundle', external: [],
});
export const LAMBDA_FILES = Object.freeze({ pre_sign_up: 'pre-sign-up.zip', post_confirmation: 'post-confirmation.zip' });

export async function createTestInputs(directory) {
  await mkdir(directory, { recursive: true });
  const zip = await readFile(new URL('../test/fixtures/placeholder.zip', import.meta.url));
  const policyBytes = await readFile(new URL('../test/fixtures/runtime-policy.json', import.meta.url));
  const serviceSha = '1'.repeat(40);
  const lambda = file => ({ service_sha: serviceSha, file, sha256: sha256(zip),
    code_sha256: Buffer.from(sha256(zip), 'hex').toString('base64'), handler: 'index.handler', runtime: 'nodejs24.x',
    source_lock_sha256: '3'.repeat(64), bundler_version: 'esbuild@0.28.0', build_options: SOURCE_BUILD_OPTIONS });
  const manifest = { schema_version: 1, record_type: 'anywear_service_artifacts', kind: 'source-build', producer: {
    repository: 'git-malu/AnyWear-Service', workflow_sha: serviceSha,
    workflow_ref: 'git-malu/AnyWear-Service/.github/workflows/service-artifacts.yml@refs/heads/main', run_id: 1, run_attempt: 1 },
    components: { image: { service_sha: serviceSha, repository_uri: '650880818323.dkr.ecr.ap-east-1.amazonaws.com/beta-anywear-service', digest: `sha256:${'4'.repeat(64)}` },
      lambdas: { pre_sign_up: lambda(LAMBDA_FILES.pre_sign_up), post_confirmation: lambda(LAMBDA_FILES.post_confirmation) },
      runtime_policy: { service_sha: serviceSha, file: 'runtime-policy.json', sha256: sha256(policyBytes), content_sha256: contentHash(JSON.parse(policyBytes)) } } };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  for (const [file, bytes] of Object.entries({ [LAMBDA_FILES.pre_sign_up]: zip, [LAMBDA_FILES.post_confirmation]: zip,
    'runtime-policy.json': policyBytes, 'service-artifacts.json': manifestBytes })) await writeFile(path.join(directory, file), bytes);
  return { manifest };
}
// Complete all-stack manifest fixture independent of any changed-stack subset.
// Infra produces every stack it still owns; the release slice's producer left.
export function stackManifestFixture(sources = {}) {
  return configuredStacks.map(stack => ({ ...stack,
    source_repository: sources[stack.stack_name]?.source_repository ?? 'git-malu/AnyWear-Infra',
    source_sha: sources[stack.stack_name]?.source_sha ?? '1'.repeat(40) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await createTestInputs(path.resolve(process.argv[2] ?? '.service-artifacts/test'));
