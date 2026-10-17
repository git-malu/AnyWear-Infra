import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { parseJson, sha256, HASH, SHA, DIGEST, canonicalJson, matches, integer } from './json-contract.mjs';
import { validateDeploymentRecord } from './deployment-contract.mjs';

const execute = promisify(execFile);
const INFRA = 'git-malu/AnyWear-Infra';
const E2E = 'git-malu/AnyWear-E2E';
const SERVICE = 'git-malu/AnyWear-Service';
const QUALIFICATION_WORKFLOW = '.github/workflows/beta-qualification.yml';
export const PRODUCTION_WORKFLOW = '.github/workflows/production.yml';

// Production is not onboarded. Its source blocker is `promote-production.mjs`; the
// preflight below stays source-reviewed but no longer reads a committed selection:
// the reviewed Service release identity is explicit (`SERVICE_RELEASE_ID`,
// `SERVICE_SOURCE_SHA`, `SERVICE_IMAGE_DIGEST`), exactly like the Beta release path.
export function validateProductionContext(env = process.env) {
  if (env.GITHUB_REPOSITORY !== INFRA
    || env.GITHUB_REPOSITORY_ID !== '1409047265' || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_WORKFLOW_REF !== `${INFRA}/${PRODUCTION_WORKFLOW}@refs/heads/main`) {
    throw new Error('Protected Production activation remains closed');
  }
  matches(env.GITHUB_SHA, SHA, 'Production source');
  matches(env.AWS_ACCOUNT_ID, /^[0-9]{12}$/, 'Production account');
  if (env.AWS_ACCOUNT_ID === '650880818323' || env.AWS_REGION !== 'ap-east-1') throw new Error('Production requires its separate reviewed account and ap-east-1 region');
  if (env.PROD_DEPLOY_ROLE_ARN !== `arn:aws:iam::${env.AWS_ACCOUNT_ID}:role/prod-infra-deploy-role`) {
    throw new Error('Dedicated Production role required; no shared-role fallback');
  }
  for (const field of ['QUALIFICATION_RUN_ID', 'QUALIFICATION_RUN_ATTEMPT', 'QUALIFICATION_ARTIFACT_ID', 'SERVICE_RELEASE_ID']) {
    matches(env[field], /^[1-9][0-9]*$/, field); integer(Number(env[field]), field);
  }
  matches(env.QUALIFICATION_RECORD_SHA256, HASH, 'qualification byte hash'); matches(env.QUALIFICATION_E2E_SHA, SHA, 'qualified E2E');
  matches(env.SERVICE_SOURCE_SHA, SHA, 'reviewed Service source');
  matches(env.SERVICE_IMAGE_DIGEST, DIGEST, 'reviewed Service image digest');
}

export function readReviewedRelease(env = process.env) {
  validateProductionContext(env);
  return { release_id: Number(env.SERVICE_RELEASE_ID), source_sha: env.SERVICE_SOURCE_SHA, image_digest: env.SERVICE_IMAGE_DIGEST };
}

export function assertTrustedQualificationMetadata(run, artifact, env = process.env, now = Date.now()) {
  if (run.id !== Number(env.QUALIFICATION_RUN_ID) || run.run_attempt !== Number(env.QUALIFICATION_RUN_ATTEMPT) || run.head_sha !== env.QUALIFICATION_E2E_SHA
    || run.repository?.full_name !== E2E || run.head_repository?.full_name !== E2E || run.head_branch !== 'main'
    || run.path !== QUALIFICATION_WORKFLOW || run.event !== 'workflow_dispatch' || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('Trusted completed-success E2E qualification required');
  }
  if (artifact.id !== Number(env.QUALIFICATION_ARTIFACT_ID) || artifact.expired !== false || artifact.name !== `beta-qualification-${run.id}-${run.run_attempt}`
    || artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== run.head_sha
    || !Number.isFinite(Date.parse(artifact.expires_at)) || Date.parse(artifact.expires_at) <= now) throw new Error('Exact qualification artifact unavailable');
  const start = Date.parse(run.run_started_at); const end = Date.parse(run.updated_at); const created = Date.parse(artifact.created_at);
  if (![start, end, created].every(Number.isFinite) || start > end || created < start || created > end) {
    throw new Error('Qualification artifact does not belong to the trusted attempt interval');
  }
}

export function assertStableRelease(stable, commit, mainComparison, release, env = process.env) {
  if (stable.id !== Number(env.STABLE_RELEASE_ID) || stable.draft !== false || stable.prerelease !== false || stable.immutable !== true
    || !/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(stable.tag_name ?? '')) {
    throw new Error('Production requires a sealed stable vMAJOR.MINOR.PATCH Service release');
  }
  if (commit?.type !== 'commit' || commit.sha !== release.source_sha) throw new Error('Stable release does not represent qualified image source');
  if (!['identical', 'ahead'].includes(mainComparison.status) || mainComparison.merge_base_commit?.sha !== release.source_sha) {
    throw new Error('Stable source is not in reviewed Service main history');
  }
}

// The qualification record binds the reviewed release identity; the deployment
// record it embeds is a v3 record and is validated as one.
export function assertQualifiedRelease(record, release, env = process.env) {
  readReviewedRelease(env);
  // Qualification v2 is a flat record with an integrity member, not a payload envelope.
  if (record.schema_version !== 2 || record.record_type !== 'anywear_beta_qualification' || record.payload !== undefined) {
    throw new Error('Production requires flat qualification v2');
  }
  if (record.revisions?.infra?.repository !== INFRA || record.revisions.infra.sha !== env.GITHUB_SHA
    || record.revisions?.service?.repository !== SERVICE || record.revisions.service.sha !== release.source_sha
    || record.revisions.service.image_digest !== release.image_digest || record.service_artifacts?.repository !== SERVICE
    || record.service_artifacts.release_id !== release.release_id) {
    throw new Error('Qualified Infra/release/image identity differs from promotion');
  }
  const deployed = record.deployment?.record;
  validateDeploymentRecord(deployed);
  if (deployed.producer?.sha !== env.GITHUB_SHA) throw new Error('Qualified deployment record describes another Infra source');
  return release.image_digest;
}

export async function resolveProductionInputs(env = process.env, io = {}) {
  const release = readReviewedRelease(env);
  const artifactIo = io.api && io.verifyStableRelease ? undefined : await liveArtifactIo();
  const get = io.api ?? artifactIo.api;
  const run = await get(`repos/${E2E}/actions/runs/${env.QUALIFICATION_RUN_ID}/attempts/${env.QUALIFICATION_RUN_ATTEMPT}`);
  const artifact = await get(`repos/${E2E}/actions/artifacts/${env.QUALIFICATION_ARTIFACT_ID}`);
  assertTrustedQualificationMetadata(run, artifact, env);
  const stable = await get(`repos/${SERVICE}/releases/${env.SERVICE_RELEASE_ID}`);
  // Check tag syntax before incorporating it in a GitHub API path.
  if (!/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(stable.tag_name ?? '')) throw new Error('Stable semantic release tag required');
  let commit = (await get(`repos/${SERVICE}/git/ref/tags/${stable.tag_name}`)).object;
  if (commit?.type === 'tag') commit = (await get(`repos/${SERVICE}/git/tags/${commit.sha}`)).object;
  const comparison = await get(`repos/${SERVICE}/compare/${release.source_sha}...main`);
  assertStableRelease(stable, commit, comparison, release, env);
  // The download uses a separate child directory so artifact contents cannot overwrite API metadata.
  await (io.mkdir ?? mkdir)('.qualification/trusted', { recursive: true });
  const put = io.writeFile ?? writeFile;
  await put('.qualification/trusted/run.json', canonicalJson(run)); await put('.qualification/trusted/artifact.json', canonicalJson(artifact));
  await put('.qualification/trusted/stable-release.json', canonicalJson(stable));
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `e2e_sha=${run.head_sha}\n`);
  return { release, run, artifact, stable };
}

export async function verifyProductionRecord({ recordBytes, run, artifact, verifier, env = process.env, now = Date.now() }) {
  validateProductionContext(env);
  const release = readReviewedRelease(env); const record = parseJson(recordBytes);
  assertTrustedQualificationMetadata(run, artifact, env, now);
  if (sha256(recordBytes) !== env.QUALIFICATION_RECORD_SHA256) throw new Error('Pinned qualification exact-byte checksum mismatch');
  assertQualifiedRelease(record, release, env);
  if (typeof verifier !== 'function') throw new Error('Pinned E2E v2 qualification verifier unavailable');
  const accepted = await verifier(record, { trustedRun: run, trustedArtifact: artifact, recordBytes, now, expected: {
    run_id: Number(env.QUALIFICATION_RUN_ID), run_attempt: Number(env.QUALIFICATION_RUN_ATTEMPT), artifact_id: Number(env.QUALIFICATION_ARTIFACT_ID),
    record_sha256: env.QUALIFICATION_RECORD_SHA256, e2e_sha: env.QUALIFICATION_E2E_SHA } });
  if (accepted !== true) throw new Error('Pinned E2E qualification verifier did not affirm acceptance');
  return { release, record };
}

export async function verifyProductionQualification(env = process.env) {
  const release = readReviewedRelease(env);
  const verifierRoot = path.resolve('.qualification-verifier');
  const checkout = (await execute('git', ['-C', verifierRoot, 'rev-parse', 'HEAD'], { timeout: 30_000 })).stdout.trim();
  const origin = (await execute('git', ['-C', verifierRoot, 'remote', 'get-url', 'origin'], { timeout: 30_000 })).stdout.trim();
  if (checkout !== env.QUALIFICATION_E2E_SHA || origin !== `https://github.com/${E2E}` && origin !== `https://github.com/${E2E}.git`) {
    throw new Error('Qualification verifier checkout differs from authenticated E2E source');
  }
  const helper = await import(pathToFileURL(path.join(verifierRoot, 'scripts/qualification-record.mjs')));
  const { release: verified } = await verifyProductionRecord({ env,
    recordBytes: await readFile('.qualification/download/qualification-record.json'),
    run: parseJson(await readFile('.qualification/trusted/run.json')), artifact: parseJson(await readFile('.qualification/trusted/artifact.json')),
    verifier: helper.verifyQualificationForPromotion });
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `image_digest=${verified.image_digest}\nservice_sha=${verified.source_sha}\n`);
  return { release, imageDigest: release.image_digest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'resolve') await resolveProductionInputs();
  else if (process.argv[2] === 'verify') await verifyProductionQualification();
  else throw new Error('Production preflight requires resolve or verify');
}

export async function liveArtifactIo() {
  // Both callers run in a job that already holds the read-only Service/E2E App
  // token. This path reads the reviewed release identity; it never re-verifies
  // another repository's native release or seals an artifact.
  const env = { ...process.env, GH_TELEMETRY: 'disabled' };
  return {
    async api(pathname) {
      return parseJson((await execute('gh', ['api', pathname], { env, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 })).stdout);
    },
    async attestation() { throw new Error('Native release attestation is not part of the reviewed release identity'); },
  };
}
