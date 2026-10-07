import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseJson, sha256, canonicalJson, HASH } from './json-contract.mjs';
import { verifySelection } from './artifact-consumer.mjs';
import { assertWriterWindow } from './writer-window.mjs';
import { runBetaLifecycle, workloadRevision } from '../.github/scripts/beta-lifecycle.mjs';
import { runRuntimeVerification } from './verify-runtime-task.mjs';
import { enforceBetaPlatformLogRetention } from '../.github/scripts/beta-platform-log-retention.mjs';
import { normalizeTesterEmails, runTesterAllowlist } from './tester-allowlist.mjs';
import { createOperationRecord, recordRecovery } from './operation-record.mjs';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutations = new Set(['register-task-definition', 'run-task', 'deregister-task-definition', 'put-parameter', 'put-retention-policy']);
export function validateOperationInputs(env = process.env) {
  if (!['deploy-foundation', 'deploy-billing', 'deploy-platform', 'deploy-workload', 'migrate', 'verify', 'start', 'stop', 'observe', 'tester-status', 'tester-add', 'tester-replace'].includes(env.INFRA_OPERATION)) throw new Error('Unknown Infra operation');
  const gate = assertWriterWindow({ token: env.WRITER_WINDOW_INPUT, operation: env.INFRA_OPERATION, env });
  if (env.GITHUB_REPOSITORY_ID !== '1409047265') throw new Error('Wrong immutable Infra repository');
  if (!['legacy', 'roles-added', 'retired'].includes(env.INFRA_IDENTITY_PHASE) || env.IDENTITY_PHASE_INPUT !== env.INFRA_IDENTITY_PHASE) throw new Error('Reviewed identity phase mismatch');
  if (!['true', 'false'].includes(env.INFRA_RETENTION_PROTECTION) || env.RETENTION_PROTECTION_INPUT !== env.INFRA_RETENTION_PROTECTION) throw new Error('Reviewed ECR retention protection mismatch');
  if (!HASH.test(env.SELECTION_SHA256 ?? '') || env.SELECTION_SHA256 !== env.INFRA_WINDOW_SELECTION_SHA256) throw new Error('Window authorizes another selection');
  if (!/^selections\/[a-z0-9][a-z0-9._-]{0,127}\.json$/.test(env.SELECTION_FILE ?? '')) throw new Error('Selection must be a reviewed repository file');
  if (env.INFRA_OPERATION.startsWith('tester-')) {
    const payload = normalizeTesterEmails(env.TESTER_EMAILS);
    if (sha256(payload) !== env.INFRA_WINDOW_TESTERS_SHA256 || (env.INFRA_OPERATION === 'tester-status' && payload !== '[]')) throw new Error('Window authorizes another tester input');
  }
  return gate;
}
export async function credentialEnvironment(kind, env = process.env) {
  const role = `arn:aws:iam::650880818323:role/beta-infra-${kind}-role`;
  const configured = env[kind === 'deploy' ? 'INFRA_DEPLOY_ROLE_ARN' : 'INFRA_RUNTIME_ROLE_ARN'];
  if (configured !== role) throw new Error('Dedicated Infra role is not configured');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || !env.ACTIONS_ID_TOKEN_REQUEST_URL) throw new Error('Protected GitHub OIDC executor required');
  const request = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (request.protocol !== 'https:' || !request.hostname.endsWith('.actions.githubusercontent.com')) throw new Error('Unexpected OIDC request endpoint');
  request.searchParams.set('audience', 'sts.amazonaws.com');
  const response = await fetch(request, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('OIDC token retrieval failed');
  const token = (await response.json()).value;
  if (typeof token !== 'string' || !token) throw new Error('OIDC token missing');
  const assumed = parseJson((await execute('aws', ['sts', 'assume-role-with-web-identity', '--role-arn', role,
    '--role-session-name', `infra-${kind}-${env.GITHUB_RUN_ID}`, '--web-identity-token', token, '--duration-seconds', '3600', '--output', 'json'],
    { timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout);
  if (!assumed.AssumedRoleUser?.Arn?.startsWith(`arn:aws:sts::650880818323:assumed-role/beta-infra-${kind}-role/`)) throw new Error('Dedicated assumed principal mismatch');
  const credentials = assumed.Credentials;
  return { ...env, AWS_ACCESS_KEY_ID: credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey, AWS_SESSION_TOKEN: credentials.SessionToken,
    AWS_REGION: 'ap-east-1', AWS_DEFAULT_REGION: 'ap-east-1' };
}
export async function createRuntimeIo(selector, directory, env = process.env, record) {
  const credentials = new Map();
  const check = () => validateOperationInputs(env);
  const roleEnv = async kind => {
    if (!credentials.has(kind)) credentials.set(kind, { value: await credentialEnvironment(kind, env), at: Date.now() });
    if (Date.now() - credentials.get(kind).at > 50 * 60_000) credentials.set(kind, { value: await credentialEnvironment(kind, env), at: Date.now() });
    return credentials.get(kind).value;
  };
  const io = {
    region: 'ap-east-1', now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    async aws(args) {
      if (mutations.has(args[1])) check();
      const awsEnv = await roleEnv('runtime');
      const explicitRegion = args.indexOf('--region');
      if (explicitRegion >= 0 && !['ap-east-1', 'us-east-1'].includes(args[explicitRegion + 1])) throw new Error('Unexpected operation region');
      const result = await execute('aws', [...args, ...(explicitRegion < 0 ? ['--region', 'ap-east-1'] : []), '--output', 'json'], { env: awsEnv, timeout: 600_000, maxBuffer: 10 * 1024 * 1024 });
      return result.stdout.trim() ? parseJson(result.stdout) : {};
    },
    async oneShot(role, revision, argument = '', payload) {
      check();
      if (revision.digest !== selector.image.digest || revision.commit !== selector.image.service_sha) throw new Error('Lifecycle selected image differs from deployed revision');
      const awsEnv = await roleEnv('runtime');
      let result;
      try { result = await execute('bash', ['.github/scripts/run-one-shot-task.sh', 'beta', role, revision.digest, revision.commit, argument, ...(payload === undefined ? [] : [payload])],
        { cwd: root, env: { ...awsEnv, BASH_ENV: path.join(root, '.github/scripts/writer-window-hook.sh'), INFRA_REPOSITORY_DIRECTORY: root }, timeout: 4_200_000, maxBuffer: 10 * 1024 * 1024 });
      } catch { throw new Error('One-shot execution failed; preserve task resources and inspect redacted run evidence'); }
      const tasks = [...new Set([...result.stdout.matchAll(/^Task ARN: (arn:aws:ecs:[^\s]+)$/gm)].map(match => match[1]))];
      const definitions = [...new Set([...result.stdout.matchAll(/^Task definition: (arn:aws:ecs:[^\s]+)$/gm)].map(match => match[1]))];
      if (tasks.length !== 1 || definitions.length !== 1) throw new Error('Unique one-shot identity missing');
      const task = (await io.aws(['ecs', 'describe-tasks', '--cluster', 'beta-anywear', '--tasks', tasks[0]])).tasks?.[0];
      const definition = (await io.aws(['ecs', 'describe-task-definition', '--task-definition', definitions[0]])).taskDefinition;
      const actualContainer = task?.containers?.find(item => item.name === 'OneShot');
      const container = definition?.containerDefinitions?.find(item => item.name === 'OneShot');
      if (task?.lastStatus !== 'STOPPED' || task.taskDefinitionArn !== definitions[0] || actualContainer?.exitCode !== 0
        || actualContainer.imageDigest !== selector.image.digest || container?.image !== `${selector.image.repository_uri}@${selector.image.digest}`) throw new Error('Actual one-shot image/result differs from selection');
      record?.events.push({ type: 'one-shot', role, action: argument, service_sha: selector.image.service_sha, image_digest: selector.image.digest,
        task_arn: tasks[0], task_definition_arn: definitions[0], command_sha256: sha256(canonicalJson(container.command)),
        ...(payload === undefined ? {} : { payload_sha256: sha256(payload) }), result: 'stopped-success' });
      process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    },
    async deploy(stack, active, revision) {
      check();
      const awsEnv = await roleEnv('deploy');
      const parameters = stack.includes('Workload') ? Object.entries(revision.parameters).filter(([key]) =>
        ['ServiceImageDigest', 'ServiceCommitSha', 'VlmConfigArn', 'CloudFrontPrefixListId'].includes(key)).flatMap(([key, value]) => ['--parameters', `${key}=${value}`]) : [];
      await execute('npx', ['cdk', 'deploy', stack, '--exclusively', '--require-approval', 'never', '-c', 'stage=beta', '-c', `betaActive=${active}`,
        '-c', `identityPhase=${env.INFRA_IDENTITY_PHASE}`, '-c', `retentionProtection=${env.INFRA_RETENTION_PROTECTION}`, '-c', `artifactDirectory=${directory}`, ...parameters],
        { cwd: root, env: awsEnv, timeout: 3_600_000, maxBuffer: 20 * 1024 * 1024 });
      if (stack === 'AnyWearPlatformStack-beta') await enforceBetaPlatformLogRetention(io);
      record?.events.push({ type: 'stack-deploy', stack_name: stack, beta_active: active, source_repository: env.GITHUB_REPOSITORY, source_sha: env.GITHUB_SHA, result: 'complete' });
    },
    recordRecovery(outcome) { if (record) recordRecovery(record, outcome); },
    async verifyHealth(url, revision) {
      const deadline = Date.now() + 600_000;
      while (Date.now() < deadline) {
        try { const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(15_000) }); const body = await response.json();
          if (response.ok && body.service_commit === revision.commit && body.image_digest === revision.digest && body.status === 'ok') return;
        } catch { /* Wait for the reviewed existing endpoint to become ready. */ }
        await io.sleep(10_000);
      }
      throw new Error('Public health failed to match selected image');
    },
  };
  return io;
}
export async function runOperation(env = process.env) {
  const gate = validateOperationInputs(env);
  const bytes = await readFile(path.join(root, env.SELECTION_FILE)); const selector = parseJson(bytes);
  if (sha256(bytes) !== env.SELECTION_SHA256 || bytes.toString('utf8') !== canonicalJson(selector)) throw new Error('Selection must match exact canonical reviewed bytes');
  const directory = path.join(root, '.service-artifacts/selected'); const verified = await verifySelection(selector, directory, undefined, { trustedInfraRoot: root, expectedInfraSha: env.GITHUB_SHA });
  const record = createOperationRecord({ env, selector, reviewedStackSources: parseJson(await readFile('deployment-evidence/stack-sources.json')) });
  const io = await createRuntimeIo(selector, directory, env, record);
  try {
  if ((await io.aws(['sts', 'get-caller-identity'])).Account !== '650880818323') throw new Error('Wrong runtime account');
  for (const row of record.reviewed_stack_sources) {
    const template = (await io.aws(['cloudformation', 'get-template', '--stack-name', row.stack_name, '--template-stage', 'Original', '--region', row.region])).TemplateBody;
    record.original_stack_templates.push({ stack_name: row.stack_name, region: row.region, template_sha256: sha256(canonicalJson(typeof template === 'string' ? parseJson(template) : template)) });
  }
  const prior = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearWorkloadStack-beta'])).Stacks?.[0];
  const priorRevision = workloadRevision(prior);
  record.original_runtime = { service_sha: priorRevision.commit, image_digest: priorRevision.digest };
  const repository = selector.image.repository_uri.split('/').slice(1).join('/');
  const images = await io.aws(['ecr', 'describe-images', '--repository-name', repository, '--image-ids', `imageDigest=${selector.image.digest}`]);
  if (images.imageDetails?.length !== 1 || images.imageDetails[0].imageDigest !== selector.image.digest) throw new Error('Selected ECR digest unavailable');
  const operation = env.INFRA_OPERATION;
  if (['start', 'stop'].includes(operation)) await runBetaLifecycle(operation, io);
  else if (operation.startsWith('tester-')) await runTesterAllowlist(operation.slice(7), env.TESTER_EMAILS, io, selector);
  else if (operation !== 'observe') {
    const workload = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearWorkloadStack-beta'])).Stacks?.[0];
    const revision = workloadRevision(workload);
    if (['migrate', 'verify'].includes(operation)) {
      const selectedRevision = { ...revision, digest: selector.image.digest, commit: selector.image.service_sha };
      await io.oneShot(operation, selectedRevision);
    } else {
      const names = { 'deploy-foundation': 'AnyWearFoundationStack', 'deploy-billing': 'AnyWearBillingStack-beta',
        'deploy-platform': 'AnyWearPlatformStack-beta', 'deploy-workload': 'AnyWearWorkloadStack-beta' };
      const platform = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearPlatformStack-beta'])).Stacks?.[0];
      const active = platform?.Outputs?.find(output => output.OutputKey === 'BetaActive')?.OutputValue;
      if (!['true', 'false'].includes(active)) throw new Error('Existing Beta runtime state unproven');
      if (operation === 'deploy-workload') {
        const outputs = Object.fromEntries(platform.Outputs.map(item => [item.OutputKey, item.OutputValue]));
        if (active === 'true') await runRuntimeVerification({ io, outputs, selector, manifest: verified.manifest, schema: verified.schema, infraSha: env.GITHUB_SHA, env });
        // Selecting an existing immutable previous release is compute rollback.
        // This operation never invokes migrate and never down-migrates the DB.
        revision.parameters.ServiceImageDigest = selector.image.digest; revision.parameters.ServiceCommitSha = selector.image.service_sha;
      } else if (revision.digest !== selector.image.digest || revision.commit !== selector.image.service_sha) throw new Error('Platform/identity changes must retain the observed running image');
      await io.deploy(names[operation], active === 'true', revision);
      if (operation === 'deploy-workload' && active === 'true') {
        await io.aws(['ecs', 'wait', 'services-stable', '--cluster', 'beta-anywear', '--services', 'beta-anywear-api', 'beta-anywear-worker']);
        const after = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearWorkloadStack-beta'])).Stacks[0];
        const url = after.Outputs.find(output => output.OutputKey === 'ApiBaseUrl')?.OutputValue;
        await io.verifyHealth(url, { digest: selector.image.digest, commit: selector.image.service_sha });
        await io.oneShot('verify', { digest: selector.image.digest, commit: selector.image.service_sha }, url);
      }
    }
  }
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `Infra operation ${operation}; source ${env.GITHUB_SHA}; selection ${env.SELECTION_SHA256}; window ${gate.record_url}.\n`);
  record.result = 'succeeded';
  } catch (error) { record.result = 'failed'; throw error; }
  finally { await writeFile('deployment-evidence/operation-record.json', canonicalJson(record)); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runOperation();
