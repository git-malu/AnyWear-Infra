import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

export interface RuntimePolicyEntry {
  queueVisibilitySeconds: number;
  maxReceives: number;
  [key: string]: number;
}
export interface RuntimePolicy {
  vto: RuntimePolicyEntry;
  'auto-tagging': RuntimePolicyEntry;
}
export interface ArtifactInputs {
  lambdas: { 'pre-sign-up': { path: string }; 'post-confirmation': { path: string } };
  runtimePolicy: RuntimePolicy;
}
// CDK consumes the same strict Node contract used by the deployment gate. No
// application checkout, source bundling, peer revision fallback or network read.
export function loadArtifactInputs(directory: string): ArtifactInputs {
  return JSON.parse(execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/local-artifact-inputs.mjs'), path.resolve(directory)],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 30_000 })) as ArtifactInputs;
}
