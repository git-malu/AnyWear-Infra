import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJson, sha256, exact, integer } from './json-contract.mjs';
import { validateSelection, assertSelectionManifest } from './artifact-consumer.mjs';
import { verifyAssetBytes } from './vendor/service-artifact-contract.mjs';

export function loadLocalArtifactInputs(directory) {
  const selector = validateSelection(parseJson(readFileSync(path.join(directory, 'selection.json'))));
  const bytes = readFileSync(path.join(directory, 'service-artifacts.json'));
  if (sha256(bytes) !== selector.release.manifest_sha256) throw new Error('Local manifest exact bytes differ');
  const manifest = parseJson(bytes); assertSelectionManifest(selector, manifest);
  const components = [...Object.values(manifest.components.lambdas), manifest.components.runtime_policy, manifest.components.schema];
  const assets = Object.fromEntries(components.map(component => [component.file, readFileSync(path.join(directory, component.file))]));
  const { policy } = verifyAssetBytes(manifest, assets);
  const keys = ['queueVisibilitySeconds', 'receiveVisibilitySeconds', 'dbLeaseMs', 'sqsHeartbeatMs', 'retryDelayBaseMs', 'retryDelayMaxMs',
    'outboxRetryDelayMs', 'outboxMaxAttempts', 'maxAttempts', 'maxReceives', 'terminalRedriveSeconds'];
  exact(policy, ['vto', 'auto-tagging'], 'runtime policy');
  for (const item of Object.values(policy)) {
    exact(item, keys, 'task runtime policy');
    for (const key of keys) integer(item[key], `runtime policy ${key}`);
    if (item.queueVisibilitySeconds > 43200 || item.maxReceives > 1000) throw new Error('Unsupported queue settings');
  }
  return { lambdas: { 'pre-sign-up': { path: path.join(directory, manifest.components.lambdas.pre_sign_up.file) },
    'post-confirmation': { path: path.join(directory, manifest.components.lambdas.post_confirmation.file) } }, runtimePolicy: policy };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(JSON.stringify(loadLocalArtifactInputs(path.resolve(process.argv[2]))));
