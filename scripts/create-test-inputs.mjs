import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { sha256, contentHash, canonicalJson } from './json-contract.mjs';
import { SOURCE_BUILD_OPTIONS } from './vendor/service-artifact-contract.mjs';
import { configuredStacks } from './operation-stacks.mjs';

export async function createTestInputs(directory) {
  await mkdir(directory, { recursive: true });
  const zip = await readFile(new URL('../test/fixtures/placeholder.zip', import.meta.url));
  const policyBytes = await readFile(new URL('../test/fixtures/runtime-policy.json', import.meta.url));
  const serviceSha = '1'.repeat(40); const journal = { version: '7', dialect: 'postgresql', entries: [{ idx: 0, version: '7', when: 1000, tag: '0000_fixture', breakpoints: true }] };
  const schema = { schema_version: 1, record_type: 'anywear_service_schema', current_version: 16, minimum_version: 16, minimum_migration_count: 1, journal,
    migrations: [{ id: '0000_fixture', idx: 0, created_at: 1000, sha256: '2'.repeat(64) }] };
  const schemaBytes = Buffer.from(JSON.stringify(schema));
  const lambda = file => ({ service_sha: serviceSha, file, sha256: sha256(zip), code_sha256: Buffer.from(sha256(zip), 'hex').toString('base64'),
    handler: 'index.handler', runtime: 'nodejs24.x', source_lock_sha256: '3'.repeat(64), bundler_version: 'esbuild@0.28.0', build_options: SOURCE_BUILD_OPTIONS });
  const manifest = { schema_version: 1, record_type: 'anywear_service_artifacts', kind: 'source-build', producer: {
    repository: 'git-malu/AnyWear-Service', workflow_sha: serviceSha, workflow_ref: 'git-malu/AnyWear-Service/.github/workflows/service-artifacts.yml@refs/heads/main', run_id: 1, run_attempt: 1 },
    components: { image: { service_sha: serviceSha, repository_uri: '650880818323.dkr.ecr.ap-east-1.amazonaws.com/beta-anywear-service', digest: `sha256:${'4'.repeat(64)}` },
      lambdas: { pre_sign_up: lambda('pre-sign-up.zip'), post_confirmation: lambda('post-confirmation.zip') },
      runtime_policy: { service_sha: serviceSha, file: 'runtime-policy.json', sha256: sha256(policyBytes), content_sha256: contentHash(JSON.parse(policyBytes)) },
      schema: { service_sha: serviceSha, file: 'service-schema.json', sha256: sha256(schemaBytes), journal_sha256: contentHash(journal), current_version: 16, minimum_version: 16 } } };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const selector = { schema_version: 2, record_type: 'anywear_infra_selection', release: {
    repository: 'git-malu/AnyWear-Service', id: 1, manifest_asset_id: 1, manifest_sha256: sha256(manifestBytes) },
    image: manifest.components.image, lambdas: { pre_sign_up: { ...manifest.components.lambdas.pre_sign_up, asset_id: 2 }, post_confirmation: { ...manifest.components.lambdas.post_confirmation, asset_id: 3 } },
    runtime_policy: { ...manifest.components.runtime_policy, asset_id: 4 }, schema: { ...manifest.components.schema, asset_id: 5 } };
  for (const [file, bytes] of Object.entries({ 'pre-sign-up.zip': zip, 'post-confirmation.zip': zip, 'runtime-policy.json': policyBytes,
    'service-schema.json': schemaBytes, 'service-artifacts.json': manifestBytes, 'selection.json': canonicalJson(selector) })) await writeFile(path.join(directory, file), bytes);
  return { selector, manifest, schema };
}
// Complete all-stack manifest fixture independent of any changed-stack subset.
export function stackManifestFixture(sources = {}) {
  return configuredStacks.map(stack => ({ ...stack,
    source_repository: sources[stack.stack_name]?.source_repository ?? 'git-malu/AnyWear-Service',
    source_sha: sources[stack.stack_name]?.source_sha ?? '1'.repeat(40) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await createTestInputs(path.resolve(process.argv[2] ?? '.service-artifacts/test'));
