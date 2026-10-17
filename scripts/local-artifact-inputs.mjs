import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJson, sha256, contentHash, exact, integer } from './json-contract.mjs';

// The stage base deploys two Service-built Lambda bundles and the task runtime
// policy. They are read from a Service sealed release directory, never rebuilt or
// committed here. This loader is the only consumer of that directory: it proves
// the downloaded bytes are the ones the release manifest names, then returns the
// same `ArtifactInputs` shape CDK has always consumed.
const POLICY_KEYS = ['queueVisibilitySeconds', 'receiveVisibilitySeconds', 'dbLeaseMs', 'sqsHeartbeatMs', 'retryDelayBaseMs',
  'retryDelayMaxMs', 'outboxRetryDelayMs', 'outboxMaxAttempts', 'maxAttempts', 'maxReceives', 'terminalRedriveSeconds'];
const LAMBDA_KEYS = ['service_sha', 'file', 'sha256', 'code_sha256', 'handler', 'runtime', 'source_lock_sha256', 'bundler_version', 'build_options'];
const SAFE_FILE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function loadLocalArtifactInputs(directory) {
  const manifestBytes = readFileSync(path.join(directory, 'service-artifacts.json'));
  const manifest = parseJson(manifestBytes);
  exact(manifest, ['schema_version', 'record_type', 'kind', 'producer', 'components'], 'release manifest');
  if (manifest.schema_version !== 1 || manifest.record_type !== 'anywear_service_artifacts') throw new Error('Unknown Service release manifest');
  if (!['source-build', 'deployed-baseline-import'].includes(manifest.kind)) throw new Error('Unknown Service artifact kind');
  exact(manifest.producer, ['repository', 'workflow_sha', 'workflow_ref', 'run_id', 'run_attempt'], 'release producer');
  if (manifest.producer.repository !== 'git-malu/AnyWear-Service') throw new Error('Unexpected release producer');
  const { lambdas, runtime_policy: runtimePolicy, image } = manifest.components ?? {};
  if (!image || typeof image !== 'object') throw new Error('Release manifest lacks the image identity');
  exact(lambdas, ['pre_sign_up', 'post_confirmation'], 'release Lambda components');
  exact(runtimePolicy, ['service_sha', 'file', 'sha256', 'content_sha256'], 'release runtime policy component');
  const bytes = name => {
    if (!SAFE_FILE.test(name ?? '')) throw new Error('Release component file must be a plain artifact name');
    return readFileSync(path.join(directory, name));
  };
  const lambda = (component, label) => {
    exact(component, LAMBDA_KEYS, label);
    const bundle = bytes(component.file);
    const digest = sha256(bundle);
    if (digest !== component.sha256) throw new Error(`${label} bytes differ from the sealed release manifest`);
    if (Buffer.from(digest, 'hex').toString('base64') !== component.code_sha256) throw new Error(`${label} file hash differs from its CodeSha256`);
    if (typeof component.handler !== 'string' || !/^[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+$/.test(component.handler)
      || !/^nodejs[0-9]+\.x$/.test(component.runtime ?? '')) throw new Error(`Unsupported ${label} handler/runtime`);
    return { path: path.join(directory, component.file) };
  };
  const policyBytes = bytes(runtimePolicy.file);
  if (sha256(policyBytes) !== runtimePolicy.sha256) throw new Error('Runtime policy bytes differ from the sealed release manifest');
  const policy = parseJson(policyBytes);
  if (contentHash(policy) !== runtimePolicy.content_sha256) throw new Error('Runtime policy content differs from the sealed release manifest');
  exact(policy, ['vto', 'auto-tagging'], 'runtime policy');
  for (const item of Object.values(policy)) {
    exact(item, POLICY_KEYS, 'task runtime policy');
    for (const key of POLICY_KEYS) integer(item[key], `runtime policy ${key}`);
    if (item.queueVisibilitySeconds > 43200 || item.maxReceives > 1000) throw new Error('Unsupported queue settings');
  }
  return { lambdas: { 'pre-sign-up': lambda(lambdas.pre_sign_up, 'pre-sign-up Lambda'),
    'post-confirmation': lambda(lambdas.post_confirmation, 'post-confirmation Lambda') }, runtimePolicy: policy };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(JSON.stringify(loadLocalArtifactInputs(path.resolve(process.argv[2]))));
