import { readFile, writeFile } from 'node:fs/promises';
import { parseJson, sha256, HASH, exact, matches, SHA } from './json-contract.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';
validateOperationInputs();
if (!/^stack-sources\/[a-z0-9][a-z0-9._-]{0,127}\.json$/.test(process.env.STACK_SOURCES_FILE ?? '') || !HASH.test(process.env.STACK_SOURCES_SHA256 ?? '')) throw new Error('Reviewed stack sources path/hash required');
const bytes = await readFile(process.env.STACK_SOURCES_FILE);
if (sha256(bytes) !== process.env.STACK_SOURCES_SHA256) throw new Error('Stack sources bytes differ from manager window');
const rows = parseJson(bytes);
if (!Array.isArray(rows) || rows.length !== 4 || new Set(rows.map(row => row.stack_name)).size !== 4) throw new Error('Four unique stack sources required');
for (const row of rows) {
  exact(row, ['stack_name', 'region', 'source_repository', 'source_sha'], 'stack producer');
  // Resolve only this reviewed executor placeholder, avoiding a commit's
  // impossible self-reference. Immutable final records always contain full SHA.
  if (row.source_sha === '@executor' && row.source_repository === 'git-malu/AnyWear-Infra') row.source_sha = process.env.GITHUB_SHA;
  matches(row.source_sha, SHA, 'stack producer source');
  if (!['AnyWearFoundationStack', 'AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta', 'AnyWearBillingStack-beta'].includes(row.stack_name)
    || row.region !== (row.stack_name.includes('Billing') ? 'us-east-1' : 'ap-east-1')
    || !['git-malu/AnyWear-Service', 'git-malu/AnyWear-Infra'].includes(row.source_repository)) throw new Error('Unexpected stack provenance');
}
const touched = { 'deploy-foundation': ['AnyWearFoundationStack'], 'deploy-billing': ['AnyWearBillingStack-beta'],
  'deploy-platform': ['AnyWearPlatformStack-beta'], 'deploy-workload': ['AnyWearWorkloadStack-beta'],
  start: ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta'] }[process.env.INFRA_OPERATION] ?? [];
for (const name of touched) {
  const row = rows.find(row => row.stack_name === name);
  if (row?.source_repository !== 'git-malu/AnyWear-Infra' || row.source_sha !== process.env.GITHUB_SHA) throw new Error('Changed stack must bind this exact Infra executor source');
}
await writeFile('deployment-evidence/stack-sources.json', JSON.stringify(rows));
