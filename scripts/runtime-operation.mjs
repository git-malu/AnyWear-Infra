import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseJson, sha256, canonicalJson, HASH, SHA } from './json-contract.mjs';
import { verifySelection, loadCommittedSelection } from './artifact-consumer.mjs';
import { runBetaLifecycle, workloadRevision } from '../.github/scripts/beta-lifecycle.mjs';
import { runRuntimeVerification } from './verify-runtime-task.mjs';
import { enforceBetaPlatformLogRetention } from '../.github/scripts/beta-platform-log-retention.mjs';
import { normalizeTesterEmails, runTesterAllowlist } from './tester-allowlist.mjs';
import { createOperationRecord, recordRecovery } from './operation-record.mjs';
import { readLifecycleStatus } from './lifecycle-status.mjs';
import { runCloseAdmission } from './admission-operation.mjs';
import { runRestoreRelease } from './restore-release.mjs';
import { assertCleanupCapabilityQuiescent } from './cleanup-capability-fence.mjs';
import { operationBoundary, sessionPolicy, assertAwsAllowed, assertOneShotAllowed, assertDeployAllowed } from './operation-boundaries.mjs';
import { observeBetaState } from './observe-beta-state.mjs';
import { validateBetaSizingInput, retainedBetaSizingProfile, selectBetaSizingProfile } from './beta-sizing-profile.mjs';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function validateOperationInputs(env = process.env) {
  const boundary = operationBoundary(env);
  validateBetaSizingInput(env);
  if (env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Infra' || env.GITHUB_REPOSITORY_ID !== '1409047265'
    || env.GITHUB_REF !== 'refs/heads/main' || !SHA.test(env.GITHUB_SHA ?? '') || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || !boundary.readOnly && env.ENABLE_BETA_DEPLOY !== 'true') throw new Error('Protected Infra main executor and activation required');
  if (env.AWS_ACCOUNT_ID !== '650880818323' || env.AWS_REGION !== 'ap-east-1') throw new Error('Unexpected account/region');
  if (!['legacy', 'roles-added', 'retired'].includes(env.INFRA_IDENTITY_PHASE)) throw new Error('Explicit identity phase required');
  if (!['true', 'false'].includes(env.INFRA_RETENTION_PROTECTION)) throw new Error('Explicit retention protection required');
  if (!HASH.test(env.SELECTION_SHA256 ?? '')) throw new Error('Explicit selection hash required');
  if (!/^selections\/[a-z0-9][a-z0-9._-]{0,127}\.json$/.test(env.SELECTION_FILE ?? '')) throw new Error('Selection must be a reviewed repository file');
  if (['close-admission', 'restore-release'].includes(env.INFRA_OPERATION)) {
    if (env.INFRA_IDENTITY_PHASE !== 'retired' || env.INFRA_RETENTION_PROTECTION !== 'true') throw new Error('Admission and release recovery require retired identity and protected retention');
    if (normalizeTesterEmails(env.TESTER_EMAILS) !== '[]') throw new Error('Admission and release recovery accept no tester mutation payload');
  }
  if (env.INFRA_OPERATION.startsWith('tester-')) {
    const payload = normalizeTesterEmails(env.TESTER_EMAILS);
    if (env.INFRA_OPERATION === 'tester-status' && payload !== '[]') throw new Error('Tester status accepts no mutation payload');
  }
  if (!boundary.workflow.endsWith('beta-admission.yml') && env.TESTER_EMAILS !== undefined && env.TESTER_EMAILS !== '[]') throw new Error('Tester payload belongs only to admission');
  for (const key of ['RUNTIME_DRILL_RUN_SCOPE', 'RUNTIME_DRILL_CHECKPOINT_PROTOCOL', 'LIFECYCLE_EVIDENCE_RUN_SCOPE', 'LIFECYCLE_EVIDENCE_ASYNC']) {
    if (env[key]) throw new Error('Experimental task scopes are not ordinary Beta workflow inputs');
  }
  return { source_sha: env.GITHUB_SHA, operation: env.INFRA_OPERATION, selection_file: env.SELECTION_FILE, selection_sha256: env.SELECTION_SHA256 };
}
export function selectionBinding(env = process.env, trustedInfraRoot = root) {
  return { trustedInfraRoot, expectedInfraSha: env.GITHUB_SHA, selectionFile: env.SELECTION_FILE, selectionSha256: env.SELECTION_SHA256 };
}
export function betaDeploymentActivity(platform, workload) {
  const state = stack => stack?.Outputs?.find(output => output.OutputKey === 'BetaActive')?.OutputValue;
  const platformActive = state(platform); const workloadActive = state(workload);
  if (!['true', 'false'].includes(platformActive) || !['true', 'false'].includes(workloadActive)) throw new Error('Both Beta activity states must be observed');
  if (platformActive !== workloadActive) throw new Error(`Mixed Beta activity: Platform=${platformActive}, Workload=${workloadActive}`);
  return platformActive === 'true';
}
export function cdkDeploymentArguments(stack, active, revision, directory, env) {
  if (typeof active !== 'boolean') throw new Error('Explicit observed Beta activity required');
  const preservedParameters = stack.includes('Workload') ? { ...revision.parameters,
    BetaApiSizingProfile: selectBetaSizingProfile(revision.parameters, env, active) } : {};
  const parameters = stack.includes('Workload') ? Object.entries(preservedParameters).filter(([key]) =>
    ['ServiceImageDigest', 'ServiceCommitSha', 'VlmConfigArn', 'CloudFrontPrefixListId', 'BetaApiSizingProfile'].includes(key)).flatMap(([key, value]) =>
    ['--parameters', `${stack}:${key}=${value}`]) : [];
  return ['cdk', 'deploy', stack, '--exclusively', '--require-approval', 'never',
    // Native rollback must not reactivate stopped/partially stopped resources.
    // An unsuccessful inactive deployment remains for explicit reviewed recovery.
    ...(!active ? ['--no-rollback'] : []), '-c', 'stage=beta', '-c', `betaActive=${active}`,
    '-c', 'legacyRoleOwnership=external', '-c', `identityPhase=${env.INFRA_IDENTITY_PHASE}`,
    '-c', `retentionProtection=${env.INFRA_RETENTION_PROTECTION}`, '-c', `artifactDirectory=${directory}`, ...parameters];
}
const workloadParameterKeys = ['ServiceImageDigest', 'ServiceCommitSha', 'VlmConfigArn', 'CloudFrontPrefixListId', 'BetaApiSizingProfile'];
const terminalStackStatuses = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']);
function assertWorkloadParameterReadback(stack, revision) {
  if (!terminalStackStatuses.has(stack?.StackStatus)) throw new Error(`Workload stack is not terminal after deploy: ${stack?.StackStatus ?? 'unavailable'}`);
  const observed = workloadRevision(stack);
  for (const key of workloadParameterKeys) {
    if (observed.parameters[key] !== revision.parameters[key]) {
      throw new Error(`Workload parameter readback mismatch for ${key}`);
    }
  }
  return observed;
}
export function cleanAwsEnvironment(env) {
  const result = { ...env };
  for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN',
    'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) delete result[key];
  return { ...result, AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true' };
}
export async function credentialEnvironment(kind, env = process.env, purpose = 'operation', { requestToken = fetch, run = execute } = {}) {
  validateOperationInputs(env);
  const policy = sessionPolicy(kind, env, purpose);
  const role = `arn:aws:iam::650880818323:role/beta-infra-${kind}-role`;
  const configured = env[kind === 'deploy' ? 'INFRA_DEPLOY_ROLE_ARN' : 'INFRA_RUNTIME_ROLE_ARN'];
  if (configured !== role) throw new Error('Dedicated Infra role is not configured');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || !env.ACTIONS_ID_TOKEN_REQUEST_URL) throw new Error('Protected GitHub OIDC executor required');
  const request = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (request.protocol !== 'https:' || !request.hostname.endsWith('.actions.githubusercontent.com')) throw new Error('Unexpected OIDC request endpoint');
  request.searchParams.set('audience', 'sts.amazonaws.com');
  const response = await requestToken(request, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('OIDC token retrieval failed');
  const token = (await response.json()).value;
  if (typeof token !== 'string' || !token) throw new Error('OIDC token missing');
  let assumed;
  try {
    assumed = parseJson((await run('aws', ['sts', 'assume-role-with-web-identity', '--role-arn', role,
      '--role-session-name', `infra-${kind}-${env.GITHUB_RUN_ID}`, '--web-identity-token', token, '--policy', policy, '--duration-seconds', '3600', '--output', 'json'],
      { env: cleanAwsEnvironment(env), timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout);
  } catch {
    // execFile errors include token-bearing arguments; keep them out of logs.
    throw new Error('Dedicated restricted STS assumption failed');
  }
  if (!assumed.AssumedRoleUser?.Arn?.startsWith(`arn:aws:sts::650880818323:assumed-role/beta-infra-${kind}-role/`)) throw new Error('Dedicated assumed principal mismatch');
  const credentials = assumed.Credentials;
  return { ...cleanAwsEnvironment(env), AWS_ACCESS_KEY_ID: credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey, AWS_SESSION_TOKEN: credentials.SessionToken,
    AWS_REGION: 'ap-east-1', AWS_DEFAULT_REGION: 'ap-east-1' };
}
export async function createRuntimeIo(selector, directory, env = process.env, record, { trustedInfraRoot = root, run = execute, assume = credentialEnvironment, purpose = 'operation' } = {}) {
  const credentials = new Map();
  const check = async () => { validateOperationInputs(env); await loadCommittedSelection(selectionBinding(env, trustedInfraRoot)); };
  const roleEnv = async kind => {
    await check();
    sessionPolicy(kind, env, purpose);
    const key = `${kind}:${purpose}`;
    if (!credentials.has(key) || Date.now() - credentials.get(key).at > 50 * 60_000) {
      credentials.set(key, { promise: assume(kind, env, purpose), at: Date.now() });
    }
    const entry = credentials.get(key);
    try { return await entry.promise; }
    catch (error) { if (credentials.get(key) === entry) credentials.delete(key); throw error; }
  };
  const io = {
    region: 'ap-east-1', now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    async aws(args, awsRegion) {
      assertAwsAllowed(env, args, purpose);
      if (args[0] === 'ecs' && args[1] === 'register-task-definition') {
        const definition = parseJson(args[args.indexOf('--cli-input-json') + 1]);
        if (definition.containerDefinitions?.length !== 1
          || definition.containerDefinitions[0].image !== `${selector.image.repository_uri}@${selector.image.digest}`) throw new Error('Task registration must retain the selected immutable image');
      }
      if (awsRegion) args = [...args, '--region', awsRegion];
      const explicitRegion = args.indexOf('--region');
      if (explicitRegion >= 0 && !['ap-east-1', 'us-east-1'].includes(args[explicitRegion + 1])) throw new Error('Unexpected operation region');
      const awsEnv = await roleEnv('runtime');
      const result = await run('aws', [...args, ...(explicitRegion < 0 ? ['--region', 'ap-east-1'] : []), '--output', 'json'], { env: awsEnv, timeout: 600_000, maxBuffer: 10 * 1024 * 1024 });
      const observed = result.stdout.trim() ? parseJson(result.stdout) : {};
      if (args[0] === 'ecs' && args[1] === 'register-task-definition') {
        record?.events.push({ type: 'runtime-task-definition', task_definition_arn: observed.taskDefinition?.taskDefinitionArn ?? 'unavailable' });
      }
      if (args[0] === 'ecs' && args[1] === 'run-task') {
        record?.events.push({ type: 'runtime-task-started', task_arns: (observed.tasks ?? []).map(task => task.taskArn),
          result: observed.failures?.length ? 'failed' : 'observed' });
      }
      return observed;
    },
    async oneShot(role, revision, argument = '', payload) {
      if (purpose !== 'operation') throw new Error('Qualification cannot invoke operation helpers');
      assertOneShotAllowed(env, role, argument, payload);
      await check();
      if (revision.digest !== selector.image.digest || revision.commit !== selector.image.service_sha) throw new Error('Lifecycle selected image differs from deployed revision');
      const awsEnv = await roleEnv('runtime');
      let result;
      try { result = await run('bash', ['.github/scripts/run-one-shot-task.sh', 'beta', role, revision.digest, revision.commit, argument, ...(payload === undefined ? [] : [payload])],
        { cwd: root, env: { ...awsEnv, BASH_ENV: path.join(root, '.github/scripts/operation-hook.sh'), INFRA_REPOSITORY_DIRECTORY: root }, timeout: 4_200_000, maxBuffer: 10 * 1024 * 1024 });
      } catch (error) {
        record?.events.push({ type: 'one-shot-failed', role, action: argument,
          task_arns: [...new Set([...String(error.stdout ?? '').matchAll(/^Task ARN: (arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/[a-f0-9]{32})$/gm)].map(match => match[1]))],
          task_definition_arns: [...new Set([...String(error.stdout ?? '').matchAll(/^Task definition: (arn:aws:ecs:ap-east-1:650880818323:task-definition\/beta-anywear-[a-z0-9-]+:[1-9][0-9]*)$/gm)].map(match => match[1]))], result: 'failed' });
        throw new Error('One-shot execution failed; preserve task resources and inspect redacted run evidence');
      }
      const tasks = [...new Set([...result.stdout.matchAll(/^Task ARN: (arn:aws:ecs:[^\s]+)$/gm)].map(match => match[1]))];
      const definitions = [...new Set([...result.stdout.matchAll(/^Task definition: (arn:aws:ecs:[^\s]+)$/gm)].map(match => match[1]))];
      if (tasks.length !== 1 || definitions.length !== 1) throw new Error('Unique one-shot identity missing');
      record?.events.push({ type: 'one-shot-identity', role, action: argument, task_arn: tasks[0], task_definition_arn: definitions[0] });
      const task = (await io.aws(['ecs', 'describe-tasks', '--cluster', 'beta-anywear', '--tasks', tasks[0]])).tasks?.[0];
      const definition = (await io.aws(['ecs', 'describe-task-definition', '--task-definition', definitions[0]])).taskDefinition;
      const actualContainer = task?.containers?.find(item => item.name === 'OneShot');
      const container = definition?.containerDefinitions?.find(item => item.name === 'OneShot');
      if (task?.lastStatus !== 'STOPPED' || task.taskDefinitionArn !== definitions[0] || actualContainer?.exitCode !== 0
        || actualContainer.imageDigest !== selector.image.digest || container?.image !== `${selector.image.repository_uri}@${selector.image.digest}`) throw new Error('Actual one-shot image/result differs from selection');
      if (role === 'lifecycle' && canonicalJson(container.command) !== canonicalJson(['node', 'dist/ops/beta-lifecycle.js', argument,
        ...(payload === undefined ? [] : [payload])])) throw new Error('Actual lifecycle command differs from the selected action');
      record?.events.push({ type: 'one-shot', role, action: argument, service_sha: selector.image.service_sha, image_digest: selector.image.digest,
        task_arn: tasks[0], task_definition_arn: definitions[0], command_sha256: sha256(canonicalJson(container.command)),
        ...(payload === undefined ? {} : { payload_sha256: sha256(payload) }), result: 'stopped-success' });
      process.stdout.write(result.stdout); process.stderr.write(result.stderr);
      if (role === 'lifecycle' && argument === 'status') {
        const status = await readLifecycleStatus(io, task, definition);
        record?.events.push({ type: 'lifecycle-status', task_arn: tasks[0], task_definition_arn: definitions[0],
          status_sha256: sha256(canonicalJson(status)), intake_open: status.intake_open,
          admission_suspended: status.admission_suspended, tester_count: status.tester_count,
          database_policy_matches_ssm: status.database_policy_matches_ssm });
        return status;
      }
    },
    async deploy(stack, active, revision) {
      if (purpose !== 'operation') throw new Error('Qualification cannot deploy');
      assertDeployAllowed(env, stack);
      await check();
      const selected = stack === 'AnyWearWorkloadStack-beta' ? {
        ...revision, parameters: { ...revision.parameters,
          BetaApiSizingProfile: selectBetaSizingProfile(revision.parameters, env, active) },
      } : revision;
      if (stack === 'AnyWearWorkloadStack-beta' && validateBetaSizingInput(env) !== 'preserve'
        && (selected.digest !== selector.image.digest || selected.commit !== selector.image.service_sha)) {
        throw new Error('Sizing changes must retain the selected Service image');
      }
      if (['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta'].includes(stack)) {
        const workload = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearWorkloadStack-beta'])).Stacks?.[0];
        const fence = await assertCleanupCapabilityQuiescent(io, workload);
        record?.events.push({ type: 'cleanup-capability-cessation', ...fence });
      }
      const awsEnv = await roleEnv('deploy');
      await run('npx', cdkDeploymentArguments(stack, active, selected, directory, env),
        { cwd: root, env: awsEnv, timeout: 3_600_000, maxBuffer: 20 * 1024 * 1024 });
      if (stack === 'AnyWearPlatformStack-beta') await enforceBetaPlatformLogRetention(io);
      if (stack === 'AnyWearWorkloadStack-beta') {
        const after = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', stack])).Stacks?.[0];
        const observed = assertWorkloadParameterReadback(after, selected);
        record?.events.push({ type: 'workload-parameter-readback', stack_name: stack,
          stack_status: after.StackStatus, service_sha: observed.commit, image_digest: observed.digest,
          beta_api_sizing_profile: observed.parameters.BetaApiSizingProfile });
      }
      record?.events.push({ type: 'stack-deploy', stack_name: stack, beta_active: active, source_repository: env.GITHUB_REPOSITORY, source_sha: env.GITHUB_SHA, result: 'complete' });
    },
    recordRecovery(outcome) { if (record) recordRecovery(record, outcome); },
    recordLifecycleState(observed) { record?.events.push({ type: 'observed-lifecycle-state', ...observed }); },
    recordAdmissionState({ state, ...event }) {
      const { tester_emails, ...values } = state ?? {};
      record?.events.push({ type: 'admission-state', ...event, state: { ...values,
        tester_count: Array.isArray(tester_emails) ? tester_emails.length : 'unavailable',
        tester_emails_sha256: Array.isArray(tester_emails) ? sha256(canonicalJson(tester_emails)) : 'unavailable' } });
    },
    recordRestoreStage(event) { record?.events.push({ type: 'restore-stage', ...event }); },
    recordRestoreState(observed) { record?.events.push({ type: 'restore-state', ...observed }); },
    async http(url) {
      const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('Deployed application identity unavailable');
      return parseJson(Buffer.from(await response.arrayBuffer()));
    },
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
  validateOperationInputs(env);
  const binding = selectionBinding(env); const selector = await loadCommittedSelection(binding);
  const directory = path.join(root, '.service-artifacts/selected');
  const record = createOperationRecord({ env, selector, reviewedStackSources: parseJson(await readFile('deployment-evidence/stack-sources.json')) });
  try {
  const verified = await verifySelection(binding, directory);
  const io = await createRuntimeIo(selector, directory, env, record);
  if ((await io.aws(['sts', 'get-caller-identity'])).Account !== '650880818323') throw new Error('Wrong runtime account');
  for (const row of record.reviewed_stack_sources) {
    const template = (await io.aws(['cloudformation', 'get-template', '--stack-name', row.stack_name, '--template-stage', 'Original', '--region', row.region])).TemplateBody;
    record.original_stack_templates.push({ stack_name: row.stack_name, region: row.region, template_sha256: sha256(canonicalJson(typeof template === 'string' ? parseJson(template) : template)) });
  }
  if (env.INFRA_OPERATION === 'state') {
    try { record.state_observation = await observeBetaState(io); }
    catch (error) { record.state_observation = error.observedState; throw error; }
    finally {
      record.events.push({ type: 'final-beta-activity', ...Object.fromEntries((record.state_observation?.stacks ?? []).flatMap(stack => {
        const key = stack.stack_name.includes('Platform') ? 'platform' : 'workload';
        return [[`${key}_active`, stack.beta_active], [`${key}_status`, stack.status]];
      })) });
    }
    record.final_observation = 'not-applicable';
    record.result = 'succeeded';
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, 'requires_qualification=false\n');
    return;
  }
  const prior = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearWorkloadStack-beta'])).Stacks?.[0];
  const priorRevision = workloadRevision(prior);
  if (['start', 'stop', 'deploy-workload', 'restore-release'].includes(env.INFRA_OPERATION)) {
    retainedBetaSizingProfile(priorRevision.parameters);
  }
  record.original_runtime = { service_sha: priorRevision.commit, image_digest: priorRevision.digest };
  const repository = selector.image.repository_uri.split('/').slice(1).join('/');
  const images = await io.aws(['ecr', 'describe-images', '--repository-name', repository, '--image-ids', `imageDigest=${selector.image.digest}`]);
  if (images.imageDetails?.length !== 1 || images.imageDetails[0].imageDigest !== selector.image.digest) throw new Error('Selected ECR digest unavailable');
  const operation = env.INFRA_OPERATION;
  if (operation === 'start') {
    const selectedRevision = { ...priorRevision, digest: selector.image.digest, commit: selector.image.service_sha,
      parameters: { ...priorRevision.parameters, ServiceImageDigest: selector.image.digest, ServiceCommitSha: selector.image.service_sha } };
    await runBetaLifecycle(operation, io, { selectedRevision });
  } else if (operation === 'stop') await runBetaLifecycle(operation, io);
  else if (operation === 'close-admission') await runCloseAdmission({ io, selector, manifest: verified.manifest, schema: verified.schema, infraSha: env.GITHUB_SHA, env });
  else if (operation === 'restore-release') await runRestoreRelease({ io, selector, manifest: verified.manifest, schema: verified.schema, infraSha: env.GITHUB_SHA, env });
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
      const active = betaDeploymentActivity(platform, workload);
      record.events.push({ type: 'observed-beta-activity', platform_active: active, workload_active: active });
      if (operation === 'deploy-workload') {
        selectBetaSizingProfile(revision.parameters, env, active);
        if (validateBetaSizingInput(env) !== 'preserve'
          && (revision.digest !== selector.image.digest || revision.commit !== selector.image.service_sha)) {
          throw new Error('Sizing changes must retain the observed Service image');
        }
        const outputs = Object.fromEntries(platform.Outputs.map(item => [item.OutputKey, item.OutputValue]));
        if (active) await runRuntimeVerification({ io, outputs, selector, manifest: verified.manifest, schema: verified.schema, infraSha: env.GITHUB_SHA, env });
        // Selecting an existing immutable previous release is compute rollback.
        // This operation never invokes migrate and never down-migrates the DB.
        revision.parameters.ServiceImageDigest = selector.image.digest; revision.parameters.ServiceCommitSha = selector.image.service_sha;
      } else if (revision.digest !== selector.image.digest || revision.commit !== selector.image.service_sha) throw new Error('Platform/identity changes must retain the observed running image');
      await io.deploy(names[operation], active, revision);
      if (operation === 'deploy-workload' && active) {
        await io.aws(['ecs', 'wait', 'services-stable', '--cluster', 'beta-anywear', '--services', 'beta-anywear-api', 'beta-anywear-worker']);
        const after = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearWorkloadStack-beta'])).Stacks[0];
        const url = after.Outputs.find(output => output.OutputKey === 'ApiBaseUrl')?.OutputValue;
        await io.verifyHealth(url, { digest: selector.image.digest, commit: selector.image.service_sha });
        await io.oneShot('verify', { digest: selector.image.digest, commit: selector.image.service_sha }, url);
      }
    }
  }
  const finalStacks = {};
  for (const [key, name] of [['platform', 'AnyWearPlatformStack-beta'], ['workload', 'AnyWearWorkloadStack-beta']]) {
    finalStacks[key] = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', name])).Stacks?.[0];
  }
  record.events.push({ type: 'final-beta-activity', ...Object.fromEntries(Object.entries(finalStacks).flatMap(([key, stack]) => [
    [`${key}_active`, stack?.Outputs?.find(output => output.OutputKey === 'BetaActive')?.OutputValue ?? 'unavailable'],
    [`${key}_status`, stack?.StackStatus ?? 'unavailable'],
  ])) });
  const finalActive = betaDeploymentActivity(finalStacks.platform, finalStacks.workload);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `beta_active=${finalActive}\nrequires_qualification=${finalActive}\n`);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `Infra operation ${operation}; source ${env.GITHUB_SHA}; committed selection ${env.SELECTION_FILE}@${env.SELECTION_SHA256}.\n`);
  record.result = 'succeeded';
  } catch (error) { record.result = 'failed'; throw error; }
  finally { await writeFile('deployment-evidence/operation-record.json', canonicalJson(record)); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runOperation();
