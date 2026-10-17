import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseJson, sha256, canonicalJson, HASH, SHA } from './json-contract.mjs';
import { verifySelection, loadCommittedSelection } from './artifact-consumer.mjs';
import { runRuntimeVerification } from './verify-runtime-task.mjs';
import { workloadRevision } from './workload-revision.mjs';
import { enforceBetaPlatformLogRetention } from '../.github/scripts/beta-platform-log-retention.mjs';
import { normalizeTesterEmails, runTesterAllowlist } from './tester-allowlist.mjs';
import { parseWindowMinutes } from './admission-window.mjs';
import { createOperationRecord, recordRecovery } from './operation-record.mjs';
import { changedStackNames } from './operation-stacks.mjs';
import { readLifecycleStatus } from './lifecycle-status.mjs';
import { runSuspendAdmission, runResumeAdmission, assertMigrationAdmissionClosed } from './admission-operation.mjs';
import { runRestoreRelease } from './restore-release.mjs';
import { assertCleanupCapabilityQuiescent } from './cleanup-capability-fence.mjs';
import { operationBoundary, sessionPolicy, assertAwsAllowed, assertOneShotAllowed, assertDeployAllowed } from './operation-boundaries.mjs';
import { observeBetaState } from './observe-beta-state.mjs';
import { validateBetaSizingInput, validateBetaTelemetryInput, retainedBetaSizingProfile, retainedBetaSizingTelemetry,
  betaSizingChangeRequested, selectBetaSizingParameters } from './beta-sizing-profile.mjs';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The tester operations are named for their effect, so routing them is an
// explicit table rather than a prefix rule: a renamed operation must be added here
// or it runs nothing, instead of silently matching or silently falling through.
export const testerOperationActions = Object.freeze({
  'admission-status': 'status', 'add-testers': 'add', 'set-testers': 'set',
});
const admissionRecoveryOperations = ['suspend-admission', 'resume-admission', 'restore-release'];
// A dispatch surface is a workflow, not an operation. These inputs now exist on
// every operation of their entry, so their per-operation scope is enforced here
// (before credentials) instead of by the file that carries them.
const testerOperations = ['add-testers', 'set-testers'];
const contextVariableOperations = ['deploy-foundation', 'deploy-billing', 'deploy-platform', 'deploy-workload', 'restore-release'];
export function validateOperationInputs(env = process.env) {
  const boundary = operationBoundary(env);
  const operation = env.INFRA_OPERATION;
  validateBetaSizingInput(env);
  validateBetaTelemetryInput(env);
  if (env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Infra' || env.GITHUB_REPOSITORY_ID !== '1409047265'
    || env.GITHUB_REF !== 'refs/heads/main' || !SHA.test(env.GITHUB_SHA ?? '') || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || !boundary.readOnly && env.ENABLE_BETA_MUTATION !== 'true') throw new Error('Protected Infra main executor and activation required');
  if (env.AWS_ACCOUNT_ID !== '650880818323' || env.AWS_REGION !== 'ap-east-1') throw new Error('Unexpected account/region');
  if (!['legacy', 'roles-added', 'retired'].includes(env.INFRA_IDENTITY_PHASE)) throw new Error('Explicit identity phase required');
  if (!['true', 'false'].includes(env.INFRA_RETENTION_PROTECTION)) throw new Error('Explicit retention protection required');
  if (!HASH.test(env.SELECTION_SHA256 ?? '')) throw new Error('Explicit selection hash required');
  if (!/^selections\/[a-z0-9][a-z0-9._-]{0,127}\.json$/.test(env.SELECTION_FILE ?? '')) throw new Error('Selection must be a reviewed repository file');
  // Only a deployment or a release recovery may vary these workflow-level
  // inputs; every other operation runs the retired, protected context.
  if (!contextVariableOperations.includes(operation)
    && (env.INFRA_IDENTITY_PHASE !== 'retired' || env.INFRA_RETENTION_PROTECTION !== 'true')) {
    throw new Error('Only deployment and release recovery may vary identity phase and retention protection');
  }
  if (admissionRecoveryOperations.includes(operation)) {
    if (normalizeTesterEmails(env.TESTER_EMAILS) !== '[]') throw new Error('Admission and release recovery accept no tester mutation payload');
  }
  // An admission window is only bounded if the bound is a required input. The
  // shared parser is the same one that builds and checks the payload bytes. The
  // window contract is unchanged: only `resume-admission` reads the bound.
  if (operation === 'resume-admission') parseWindowMinutes(env.WINDOW_MINUTES);
  if (Object.hasOwn(testerOperationActions, operation)) {
    const payload = normalizeTesterEmails(env.TESTER_EMAILS);
    if (operation === 'admission-status' && payload !== '[]') throw new Error('Admission status accepts no mutation payload');
  }
  if (!testerOperations.includes(operation) && normalizeTesterEmails(env.TESTER_EMAILS ?? '[]') !== '[]') {
    throw new Error('Tester payload belongs only to the tester operations');
  }
  // Cross-repository boundary, not a local preference: these names remain live
  // outside Infra. Service's own .github/scripts/run-one-shot-task.sh:19,29,34 and
  // .github/scripts/runtime-checkpoint.test.mjs:97-98,148,161 read the evidence and
  // checkpoint scopes, and AnyWear-E2E sets them through
  // scripts/runtime-one-shot-runner.mjs:95,100, scripts/beta-runtime-adapter.mjs:16,98
  // and scripts/fixtures/runtime-checkpoint-helper.sh:3-4. Keep rejecting them here.
  for (const key of ['RUNTIME_DRILL_RUN_SCOPE', 'RUNTIME_DRILL_CHECKPOINT_PROTOCOL', 'LIFECYCLE_EVIDENCE_RUN_SCOPE', 'LIFECYCLE_EVIDENCE_ASYNC']) {
    if (env[key]) throw new Error('Experimental task scopes are not ordinary Beta workflow inputs');
  }
  return { source_sha: env.GITHUB_SHA, operation: env.INFRA_OPERATION, selection_file: env.SELECTION_FILE, selection_sha256: env.SELECTION_SHA256 };
}
export function selectionBinding(env = process.env, trustedInfraRoot = root) {
  return { trustedInfraRoot, expectedInfraSha: env.GITHUB_SHA, selectionFile: env.SELECTION_FILE, selectionSha256: env.SELECTION_SHA256 };
}
// Beta is resident: every protected operation that reaches a completed deploy must
// observe both stacks active. A stack stopped out of band is an invariant violation
// that fails closed here; no protected operation can produce that state.
export function assertResidentBeta(platform, workload) {
  const state = stack => stack?.Outputs?.find(output => output.OutputKey === 'BetaActive')?.OutputValue;
  for (const [name, stack] of [['Platform', platform], ['Workload', workload]]) {
    const active = state(stack);
    if (!['true', 'false'].includes(active)) throw new Error(`Both Beta activity states must be observed: ${name}=${active ?? 'unavailable'}`);
    if (active !== 'true') throw new Error(`Resident Beta requires active ${name}; observed ${active}`);
  }
}
// Every protected deploy reconciles the resident active environment. The CDK
// default is the active path (environmentRunning=true), so no operation selects the
// dormant stopped template and no observed activity changes the arguments.
export function cdkDeploymentArguments(stack, revision, directory, env) {
  const preservedParameters = stack.includes('Workload') ? selectBetaSizingParameters(revision.parameters, env) : {};
  const parameters = stack.includes('Workload') ? Object.entries(preservedParameters).filter(([key]) =>
    workloadParameterKeys.includes(key)).flatMap(([key, value]) =>
    ['--parameters', `${stack}:${key}=${value}`]) : [];
  return ['cdk', 'deploy', stack, '--exclusively', '--require-approval', 'never',
    '-c', 'stage=beta', '-c', 'legacyRoleSource=external', '-c', `identityPhase=${env.INFRA_IDENTITY_PHASE}`,
    '-c', `ecrImageRetention=${env.INFRA_RETENTION_PROTECTION}`, '-c', `artifactDirectory=${directory}`, ...parameters];
}
const workloadParameterKeys = ['ServiceImageDigest', 'ServiceCommitSha', 'VlmConfigArn', 'CloudFrontPrefixListId',
  'BetaApiSizingProfile', 'BetaSizingTelemetry'];
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
          status_sha256: sha256(canonicalJson(status)), admission_mode: status.admission_mode,
          admission_window_expires_at: status.admission_window_expires_at, tester_count: status.tester_count,
          database_policy_matches_ssm: status.database_policy_matches_ssm });
        return status;
      }
    },
    async deploy(stack, revision) {
      if (purpose !== 'operation') throw new Error('Qualification cannot deploy');
      assertDeployAllowed(env, stack);
      await check();
      const selected = stack === 'AnyWearWorkloadStack-beta' ? {
        ...revision, parameters: selectBetaSizingParameters(revision.parameters, env),
      } : revision;
      if (stack === 'AnyWearWorkloadStack-beta' && betaSizingChangeRequested(env)
        && (selected.digest !== selector.image.digest || selected.commit !== selector.image.service_sha)) {
        throw new Error('Sizing changes must retain the selected Service image');
      }
      if (['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta'].includes(stack)) {
        const workload = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearWorkloadStack-beta'])).Stacks?.[0];
        const fence = await assertCleanupCapabilityQuiescent(io, workload);
        record?.events.push({ type: 'cleanup-capability-cessation', ...fence });
      }
      const awsEnv = await roleEnv('deploy');
      await run('npx', cdkDeploymentArguments(stack, selected, directory, env),
        { cwd: root, env: awsEnv, timeout: 3_600_000, maxBuffer: 20 * 1024 * 1024 });
      if (stack === 'AnyWearPlatformStack-beta') await enforceBetaPlatformLogRetention(io);
      if (stack === 'AnyWearWorkloadStack-beta') {
        const after = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', stack])).Stacks?.[0];
        const observed = assertWorkloadParameterReadback(after, selected);
        record?.events.push({ type: 'workload-parameter-readback', stack_name: stack,
          stack_status: after.StackStatus, service_sha: observed.commit, image_digest: observed.digest,
          beta_api_sizing_profile: observed.parameters.BetaApiSizingProfile,
          beta_sizing_telemetry: observed.parameters.BetaSizingTelemetry });
      }
      record?.events.push({ type: 'stack-deploy', stack_name: stack, beta_active: true, source_repository: env.GITHUB_REPOSITORY, source_sha: env.GITHUB_SHA, result: 'complete' });
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
    recordBetaSizingState(observed) { record?.events.push({ type: 'beta-sizing-state', ...observed }); },
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
  const record = createOperationRecord({ env, selector, stackManifest: parseJson(await readFile('deployment-evidence/stack-sources.json')) });
  try {
  const verified = await verifySelection(binding, directory);
  const io = await createRuntimeIo(selector, directory, env, record);
  if ((await io.aws(['sts', 'get-caller-identity'])).Account !== '650880818323') throw new Error('Wrong runtime account');
  for (const row of record.stack_manifest) {
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
  if (['deploy-workload', 'restore-release'].includes(env.INFRA_OPERATION)) {
    retainedBetaSizingProfile(priorRevision.parameters);
    retainedBetaSizingTelemetry(priorRevision.parameters);
  }
  record.original_runtime = { service_sha: priorRevision.commit, image_digest: priorRevision.digest };
  const repository = selector.image.repository_uri.split('/').slice(1).join('/');
  const images = await io.aws(['ecr', 'describe-images', '--repository-name', repository, '--image-ids', `imageDigest=${selector.image.digest}`]);
  if (images.imageDetails?.length !== 1 || images.imageDetails[0].imageDigest !== selector.image.digest) throw new Error('Selected ECR digest unavailable');
  const operation = env.INFRA_OPERATION;
  if (operation === 'suspend-admission') await runSuspendAdmission({ io, selector, manifest: verified.manifest, schema: verified.schema, infraSha: env.GITHUB_SHA, env });
  else if (operation === 'resume-admission') await runResumeAdmission({ io, selector, manifest: verified.manifest, schema: verified.schema, infraSha: env.GITHUB_SHA, env });
  else if (operation === 'restore-release') await runRestoreRelease({ io, selector, manifest: verified.manifest, schema: verified.schema, infraSha: env.GITHUB_SHA, env });
  else if (Object.hasOwn(testerOperationActions, operation)) await runTesterAllowlist(testerOperationActions[operation], env.TESTER_EMAILS, io, selector);
  else if (operation !== 'observe') {
    const workload = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearWorkloadStack-beta'])).Stacks?.[0];
    const revision = workloadRevision(workload);
    if (['migrate', 'verify'].includes(operation)) {
      // A forward migration runs only against an admission mirror that proves
      // closed admission. The bound closes an abandoned window on that surface, so
      // this admits the ordinary after-expiry case and refuses an unprovable
      // record until `suspend-admission` restores it.
      if (operation === 'migrate') await assertMigrationAdmissionClosed(io);
      const selectedRevision = { ...revision, digest: selector.image.digest, commit: selector.image.service_sha };
      await io.oneShot(operation, selectedRevision);
    } else {
      const [deployStack] = changedStackNames(operation);
      if (operation === 'deploy-workload') {
        selectBetaSizingParameters(revision.parameters, env);
        if (betaSizingChangeRequested(env)
          && (revision.digest !== selector.image.digest || revision.commit !== selector.image.service_sha)) {
          throw new Error('Sizing changes must retain the observed Service image');
        }
        // The candidate is verified against the current Platform before the
        // selected image is rolled out. Beta is resident, so this always runs.
        const platform = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearPlatformStack-beta'])).Stacks?.[0];
        const outputs = Object.fromEntries((platform?.Outputs ?? []).map(item => [item.OutputKey, item.OutputValue]));
        await runRuntimeVerification({ io, outputs, selector, manifest: verified.manifest, schema: verified.schema, infraSha: env.GITHUB_SHA, env });
        // Selecting an existing immutable previous release is compute rollback.
        // This operation never invokes migrate and never down-migrates the DB.
        revision.parameters.ServiceImageDigest = selector.image.digest; revision.parameters.ServiceCommitSha = selector.image.service_sha;
      } else if (revision.digest !== selector.image.digest || revision.commit !== selector.image.service_sha) throw new Error('Platform/identity changes must retain the observed running image');
      await io.deploy(deployStack, revision);
      if (operation === 'deploy-workload') {
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
  assertResidentBeta(finalStacks.platform, finalStacks.workload);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, 'beta_active=true\nrequires_qualification=true\n');
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `Infra operation ${operation}; source ${env.GITHUB_SHA}; committed selection ${env.SELECTION_FILE}@${env.SELECTION_SHA256}.\n`);
  record.result = 'succeeded';
  } catch (error) { record.result = 'failed'; throw error; }
  finally { await writeFile('deployment-evidence/operation-record.json', canonicalJson(record)); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runOperation();
