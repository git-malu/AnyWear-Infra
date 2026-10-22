import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseJson, sha256, canonicalJson, matches, DIGEST, SHA } from './json-contract.mjs';
import { workloadRevision } from './workload-revision.mjs';
import { enforceBetaPlatformLogRetention } from '../.github/scripts/beta-platform-log-retention.mjs';
import { normalizeTesterEmails, runTesterAllowlist } from './tester-allowlist.mjs';
import { createOperationRecord, recordRecovery, validateServiceRelease } from './operation-record.mjs';
import { changedStackNames } from './operation-stacks.mjs';
import { validateReleaseInput, SELECTED_RELEASE_DIRECTORY } from './release-inputs.mjs';
import { readLifecycleStatus } from './lifecycle-status.mjs';
import { runCloseAdmission, runOpenAdmission, assertMigrationAdmissionClosed } from './admission-operation.mjs';
import { runRestoreRelease } from './restore-release.mjs';
import { assertTerminalRuntime, assertRuntimeAbsent, assertRuntimeReady, describeStack, runtimeExists, runtimeStack, terminalStackStatuses } from './one-writer.mjs';
import { operationBoundary, sessionPolicy, assertAwsAllowed, assertOneShotAllowed, assertDeployAllowed, assertProtectedExecutor } from './operation-boundaries.mjs';
import { runAuthorizationPreflight } from './authorization-preflight.mjs';
import { observeBetaState } from './observe-beta-state.mjs';
import { account, region } from './deployment-contract.mjs';
import { assertRuntimePhase, deployRuntime, stopRuntime } from './runtime-deploy.mjs';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The tester operations are named for their effect, so routing them is an
// explicit table rather than a prefix rule: a renamed operation must be added here
// or it runs nothing, instead of silently matching or silently falling through.
export const testerOperationActions = Object.freeze({
  'admission-status': 'status', 'add-testers': 'add', 'set-testers': 'set',
});
const admissionRecoveryOperations = ['close-admission', 'open-admission', 'restore-release'];
// A dispatch surface is a workflow, not an operation. These inputs now exist on
// every operation of their entry, so their per-operation scope is enforced here
// (before credentials) instead of by the file that carries them.
const testerOperations = ['add-testers', 'set-testers'];
const contextVariableOperations = ['deploy-foundation', 'deploy-billing', 'deploy-platform', 'restore-release',
  'deploy-runtime', 'stop-runtime'];
export function validateOperationInputs(env = process.env) {
  const boundary = operationBoundary(env);
  const operation = env.INFRA_OPERATION;
  if (env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Infra' || env.GITHUB_REPOSITORY_ID !== '1409047265'
    || env.GITHUB_REF !== 'refs/heads/main' || !SHA.test(env.GITHUB_SHA ?? '') || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || !boundary.readOnly && env.ENABLE_BETA_MUTATION !== 'true') throw new Error('Protected Infra main executor and activation required');
  if (env.AWS_ACCOUNT_ID !== account || env.AWS_REGION !== region) throw new Error('Unexpected account/region');
  if (!['legacy', 'roles-added', 'retired'].includes(env.INFRA_IDENTITY_PHASE)) throw new Error('Explicit identity phase required');
  if (!['true', 'false'].includes(env.INFRA_RETENTION_PROTECTION)) throw new Error('Explicit retention protection required');
  // Only a Platform deploy, a Runtime deploy and a release recovery consume
  // Service-built identity; every other operation must not carry a release
  // identity at all.
  const release = validateReleaseInput(env, operation);
  // The Runtime operations act only on the recorded live identity phase.
  if (operation === 'deploy-runtime' || operation === 'stop-runtime') assertRuntimePhase(operation, env);
  // Only a deployment or a release recovery may vary these workflow-level
  // inputs; every other operation runs the retired, protected context.
  if (!contextVariableOperations.includes(operation)
    && (env.INFRA_IDENTITY_PHASE !== 'retired' || env.INFRA_RETENTION_PROTECTION !== 'true')) {
    throw new Error('Only deployment and release recovery may vary identity phase and retention protection');
  }
  if (admissionRecoveryOperations.includes(operation)) {
    if (normalizeTesterEmails(env.TESTER_EMAILS) !== '[]') throw new Error('Admission and release recovery accept no tester mutation payload');
  }
  if (Object.hasOwn(testerOperationActions, operation)) {
    const payload = normalizeTesterEmails(env.TESTER_EMAILS);
    if (operation === 'admission-status' && payload !== '[]') throw new Error('Admission status accepts no mutation payload');
  }
  if (!testerOperations.includes(operation) && normalizeTesterEmails(env.TESTER_EMAILS ?? '[]') !== '[]') {
    throw new Error('Tester payload belongs only to the tester operations');
  }
  // The retained Egress EIP allocation is a deploy-egress start input only. An
  // empty workflow_dispatch value is absence; any non-empty value must match the
  // reviewed allocation form before credentials.
  const natEipAllocationId = env.NAT_EIP_ALLOCATION_ID;
  if (natEipAllocationId !== undefined && natEipAllocationId !== '') {
    if (operation !== 'deploy-egress') throw new Error('NAT_EIP_ALLOCATION_ID belongs only to deploy-egress');
    if (!/^eipalloc-[0-9a-f]+$/.test(natEipAllocationId)) {
      throw new Error('NAT_EIP_ALLOCATION_ID must be an Elastic IP allocation id (eipalloc-...)');
    }
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
  return { source_sha: env.GITHUB_SHA, operation, service_release: release,
    ...(operation === 'deploy-egress' && natEipAllocationId ? { nat_eip_allocation_id: natEipAllocationId } : {}) };
}
const baseStack = 'AnyWearPlatformStack-beta';
const egressStack = 'AnyWearEgressStack-beta';
// The ECR repository Service's release chain pushes to. Tag immutability makes
// `service-artifacts-<commit>` a one-image lookup, so a release operation can
// record the deployed image digest from ECR instead of a release manifest.
export const SERVICE_IMAGE_REPOSITORY = 'beta-anywear-service';
export function serviceImageTag(serviceCommit) {
  return `service-artifacts-${serviceCommit}`;
}
// Resolve the release image digest for one Service commit before the deploy. A
// missing or ambiguous tag fails closed before CloudFormation is touched.
export async function resolveServiceImageDigest(io, serviceCommit) {
  const tag = serviceImageTag(serviceCommit);
  const { imageDetails } = await io.aws(['ecr', 'describe-images', '--repository-name', SERVICE_IMAGE_REPOSITORY,
    '--image-ids', `imageTag=${tag}`]);
  if (!Array.isArray(imageDetails) || imageDetails.length !== 1) {
    throw new Error(`The immutable ECR tag ${tag} does not resolve to exactly one image`);
  }
  const [image] = imageDetails;
  if (!Array.isArray(image.imageTags) || !image.imageTags.includes(tag)) {
    throw new Error(`The immutable ECR tag ${tag} does not name the resolved image`);
  }
  return matches(image.imageDigest, DIGEST, `ECR tag ${tag} image digest`);
}
// The legacy Service stack that still exists until the one-time split migration
// deletes it. Its `ApiLoadBalancerDnsName` output is the only origin source
// before the Runtime stack exists; it is a read-only transition path.
const legacyWorkloadStack = 'AnyWearWorkloadStack-beta';
const API_DISTRIBUTION = Object.freeze(JSON.parse(
  readFileSync(new URL('../lib/api-distribution.json', import.meta.url), 'utf8')));
const API_ORIGIN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const isOrigin = value => typeof value === 'string' && API_ORIGIN.test(value);
const stackRead = (io, name, region) => describeStack(io, name, region);
const outputOf = (stack, key) => (stack?.Outputs ?? []).find(output => output.OutputKey === key)?.OutputValue;
// During the migration's M4 Base update both the Workload ALB and the Runtime
// stack are absent. The MOVE already adopted the distribution with its literal
// origin, so read that value back from Base's Original template.
async function baseDistributionOrigin(io) {
  if (!(await stackRead(io, baseStack))) return undefined;
  const body = (await io.aws(['cloudformation', 'get-template', '--stack-name', baseStack,
    '--template-stage', 'Original'])).TemplateBody;
  const template = typeof body === 'string' ? parseJson(body) : body;
  const origin = template?.Resources?.[API_DISTRIBUTION.logicalId]
    ?.Properties?.DistributionConfig?.Origins?.[0]?.DomainName;
  return isOrigin(origin) ? origin : undefined;
}
// A Base deploy needs the live API ALB DNS name as a literal distribution origin.
// Order: a running Runtime stack's output, then the literal already adopted by
// the Base distribution (M4, when Runtime and Workload are both absent), then
// the legacy Workload output before the MOVE. The Base read is before Workload so
// that the stopped state never needs the transitional Workload read after M4.
export async function readApiOrigin(io) {
  const runtime = await stackRead(io, runtimeStack);
  if (runtimeExists(runtime)) {
    const runtimeOrigin = outputOf(runtime, 'ApiLoadBalancerDnsName');
    if (!isOrigin(runtimeOrigin)) {
      throw new Error('The Runtime stack exists but its ApiLoadBalancerDnsName output is missing or not a DNS name');
    }
    return runtimeOrigin;
  }
  const baseOrigin = await baseDistributionOrigin(io);
  if (baseOrigin) return baseOrigin;
  const workload = await stackRead(io, legacyWorkloadStack);
  const workloadOrigin = outputOf(workload, 'ApiLoadBalancerDnsName');
  if (isOrigin(workloadOrigin)) return workloadOrigin;
  throw new Error('A Base deploy requires the live API load-balancer DNS name from the Runtime stack, the literal origin in the adopted Base distribution, or the legacy Workload stack before the MOVE');
}
// The stage base and the Runtime slice have different producers: Infra deploys
// the Base stack and AnyWear-Service deploys the Runtime stack. A Base or Egress
// mutation must read the Runtime stack terminal before CloudFormation is touched,
// so the two writers never cross a deployment. A missing Runtime is simply the
// stopped state; `restore-release` still requires it to exist (start first).
export async function deployOperationStack(io, operation) {
  const [stack] = changedStackNames(operation);
  if (!stack) throw new Error(`Operation ${operation} has no stack to deploy`);
  if (stack === baseStack || stack === egressStack) {
    const runtime = await stackRead(io, runtimeStack);
    if (runtimeExists(runtime)) assertTerminalRuntime(runtime, operation);
  }
  await io.deploy(stack);
  return stack;
}
// The stop sequence is Runtime (AnyWear-Service) then Egress. This operation is
// the second step only: it refuses while the Runtime stack still exists.
export async function deleteOperationStack(io, operation, record) {
  const [stack] = changedStackNames(operation);
  if (operation !== 'delete-egress' || stack !== egressStack) {
    throw new Error(`Operation ${operation} has no stack to delete`);
  }
  assertRuntimeAbsent(await stackRead(io, runtimeStack), operation);
  if (record) {
    // The retained EIP is the allocation the next start must reuse. Read it
    // before the destroy removes the stack and its output.
    const egress = await stackRead(io, egressStack);
    const allocationId = outputOf(egress, 'EgressNatEipAllocationId');
    if (typeof allocationId !== 'string' || !allocationId) {
      throw new Error('delete-egress requires the EgressNatEipAllocationId output before deleting the stack');
    }
    record.events.push({ type: 'egress-nat-eip', action: 'delete', stack_name: egressStack, allocation_id: allocationId });
  }
  await io.destroy(stack);
  return stack;
}
// `deployScope` restricts synthesis to the stack this operation deploys: only an
// application-scope deploy (the Base stack) loads Service-built Lambda assets and
// the literal API origin; the Egress stack is a separate scope with no artifacts.
function deployScopeFor(stack) {
  if (stack === baseStack) return 'application';
  if (stack === 'AnyWearBillingStack-beta') return 'billing';
  if (stack === egressStack) return 'egress';
  if (stack === runtimeStack) return 'runtime';
  return 'foundation';
}
export function cdkDeploymentArguments(stack, directory, env, { apiOriginDomainName, natEipAllocationId } = {}) {
  const deployScope = deployScopeFor(stack);
  if (deployScope === 'application' && !apiOriginDomainName) throw new Error('The Base deploy requires the API origin domain name');
  return ['cdk', 'deploy', stack, '--exclusively', '--require-approval', 'never',
    '-c', `deployScope=${deployScope}`, '-c', 'stage=beta', '-c', 'legacyRoleSource=external', '-c', `identityPhase=${env.INFRA_IDENTITY_PHASE}`,
    '-c', `ecrImageRetention=${env.INFRA_RETENTION_PROTECTION}`,
    ...(deployScope === 'application' ? ['-c', `artifactDirectory=${directory}`, '-c', `apiOriginDomainName=${apiOriginDomainName}`] : []),
    ...(deployScope === 'egress' && natEipAllocationId ? ['-c', `natEipAllocationId=${natEipAllocationId}`] : [])];
}
// The Egress destroy uses the same restricted deploy session and reviewed
// context; `--force` is safe because the stack holds no retained resources.
export function cdkDestroyArguments(stack, env) {
  return ['cdk', 'destroy', stack, '--force', '--exclusively',
    '-c', `deployScope=${deployScopeFor(stack)}`, '-c', 'stage=beta', '-c', 'legacyRoleSource=external',
    '-c', `identityPhase=${env.INFRA_IDENTITY_PHASE}`, '-c', `ecrImageRetention=${env.INFRA_RETENTION_PROTECTION}`];
}
export function cleanAwsEnvironment(env) {
  const result = { ...env };
  for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN',
    'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) delete result[key];
  return { ...result, AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true' };
}
export async function credentialEnvironment(kind, env = process.env, purpose = 'operation',
  { requestToken = fetch, run = execute, sessionMarker } = {}) {
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
  // D2: the preflight requests its own session name (`infra-<kind>-preflight-<run>`),
  // so the CloudTrail reconciliation can exclude the sensor's own calls.
  const sessionName = `infra-${kind}${sessionMarker ? `-${sessionMarker}` : ''}-${env.GITHUB_RUN_ID}`;
  let assumed;
  try {
    assumed = parseJson((await run('aws', ['sts', 'assume-role-with-web-identity', '--role-arn', role,
      '--role-session-name', sessionName, '--web-identity-token', token, '--policy', policy, '--duration-seconds', '3600', '--output', 'json'],
      { env: cleanAwsEnvironment(env), timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout);
  } catch {
    // execFile errors include token-bearing arguments; keep them out of logs.
    throw new Error('Dedicated restricted STS assumption failed');
  }
  if (!assumed.AssumedRoleUser?.Arn?.startsWith(`arn:aws:sts::650880818323:assumed-role/beta-infra-${kind}-role/${sessionName}`)) throw new Error('Dedicated assumed principal mismatch');
  const credentials = assumed.Credentials;
  return { ...cleanAwsEnvironment(env), AWS_ACCESS_KEY_ID: credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey, AWS_SESSION_TOKEN: credentials.SessionToken,
    AWS_REGION: 'ap-east-1', AWS_DEFAULT_REGION: 'ap-east-1' };
}
export async function createRuntimeIo(env = process.env, record, { run = execute, assume = credentialEnvironment, purpose = 'operation', directory = SELECTED_RELEASE_DIRECTORY } = {}) {
  const credentials = new Map();
  const roleEnv = async kind => {
    validateOperationInputs(env);
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
    // Issue #195: the Runtime change-set driver runs under the restricted deploy
    // session, never the read-only runtime session. Every call is checked against
    // the deploy-session allow-list before it reaches AWS.
    async awsAs(session, args) {
      if (session !== 'deploy') throw new Error(`Unsupported explicit operation session ${session}`);
      if (purpose !== 'operation') throw new Error('Qualification cannot use the deploy session');
      assertAwsAllowed(env, args, purpose, 'deploy');
      const awsEnv = await roleEnv('deploy');
      const result = await run('aws', [...args, '--region', 'ap-east-1', '--output', 'json'],
        { env: awsEnv, timeout: 600_000, maxBuffer: 10 * 1024 * 1024 });
      return result.stdout.trim() ? parseJson(result.stdout) : {};
    },
    // The CDK CLI creates this run's change set under the bootstrap deploy role.
    // `--no-execute` means it records the delta and stops; the operation describes
    // it, judges it and then executes or deletes it through `awsAs`.
    async deployRuntimeChangeSet({ args }) {
      if (purpose !== 'operation') throw new Error('Qualification cannot deploy');
      if (env.INFRA_OPERATION !== 'deploy-runtime') throw new Error('Only deploy-runtime may create a Runtime change set');
      assertDeployAllowed(env, runtimeStack);
      const awsEnv = await roleEnv('deploy');
      await runAuthorizationPreflight({ sessions: ['deploy', 'runtime'], env, purpose, assume, run });
      await run('npx', args, { cwd: root, env: awsEnv, timeout: 3_600_000, maxBuffer: 20 * 1024 * 1024 });
      record?.events.push({ type: 'runtime-cdk-change-set', stack_name: runtimeStack, result: 'created' });
    },
    // A synchronous runner for the bake's AWS reads. It resolves the runtime
    // session once and checks every call against the same reviewed allow-list;
    // the bake's evaluation is deterministic and its transport is the CLI.
    async runtimeAwsRunner() {
      if (purpose !== 'operation') throw new Error('Qualification cannot run the deployment bake');
      const awsEnv = await roleEnv('runtime');
      return (args) => {
        assertAwsAllowed(env, args, purpose, 'runtime');
        return execFileSync('aws', [...args, '--region', 'ap-east-1', '--output', 'json'],
          { env: awsEnv, timeout: 120_000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' });
      };
    },
    async oneShot(role, revision, argument = '', payload) {
      if (purpose !== 'operation') throw new Error('Qualification cannot invoke operation helpers');
      assertOneShotAllowed(env, role, argument, payload);
      // Pre-mutation preflight (#165): a migration or admission one-shot changes
      // data, so the policy simulation runs first. A deny stops the operation
      // before the task is registered or started.
      await runAuthorizationPreflight({ sessions: ['runtime'], env, purpose, assume, run });
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
        || actualContainer.imageDigest !== revision.digest) throw new Error('Actual one-shot image/result differs from the deployed revision');
      if (role === 'lifecycle' && canonicalJson(container.command) !== canonicalJson(['node', 'dist/ops/beta-lifecycle.js', argument,
        ...(payload === undefined ? [] : [payload])])) throw new Error('Actual lifecycle command differs from the requested action');
      record?.events.push({ type: 'one-shot', role, action: argument, service_sha: revision.commit, image_digest: revision.digest,
        task_arn: tasks[0], task_definition_arn: definitions[0], command_sha256: sha256(canonicalJson(container.command)),
        ...(payload === undefined ? {} : { payload_sha256: sha256(payload) }), result: 'stopped-success' });
      process.stdout.write(result.stdout); process.stderr.write(result.stderr);
      if (role === 'lifecycle' && argument === 'status') {
        const status = await readLifecycleStatus(io, task, definition);
        record?.events.push({ type: 'lifecycle-status', task_arn: tasks[0], task_definition_arn: definitions[0],
          status_sha256: sha256(canonicalJson(status)), admission_mode: status.admission_mode,
          admission_record: status.admission_record, tester_count: status.tester_count,
          database_policy_matches_ssm: status.database_policy_matches_ssm });
        return status;
      }
    },
    // Issue #194: a non-throwing variant of `oneShot` for the pre-mutation
    // schema-journal probe. It performs the same authorization, launch, unique
    // task/definition identity, STOPPED, image-digest and command-identity checks,
    // but *returns* the container exit code so the schema gate can decide the
    // refusal (a non-zero read is a `reader-failed`, not a launcher crash). A
    // launch or identity failure still throws, as it invalidates the evidence.
    async oneShotProbe(role, revision, argument = '') {
      if (purpose !== 'operation') throw new Error('Qualification cannot invoke operation helpers');
      assertOneShotAllowed(env, role, argument);
      // Same pre-mutation preflight as `oneShot`: the runtime session's effective
      // authorization is simulated before the task is registered or started.
      await runAuthorizationPreflight({ sessions: ['runtime'], env, purpose, assume, run });
      const awsEnv = await roleEnv('runtime');
      let result;
      try {
        result = await run('bash', ['.github/scripts/run-one-shot-task.sh', 'beta', role, revision.digest, revision.commit, argument],
          { cwd: root, env: { ...awsEnv, BASH_ENV: path.join(root, '.github/scripts/operation-hook.sh'), INFRA_REPOSITORY_DIRECTORY: root }, timeout: 4_200_000, maxBuffer: 10 * 1024 * 1024 });
      } catch (error) {
        // The task script exits non-zero after it prints the stopped task identity,
        // so the runner can still read and judge the actual container result.
        result = { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
      }
      const tasks = [...new Set([...String(result.stdout ?? '').matchAll(/^Task ARN: (arn:aws:ecs:[^\s]+)$/gm)].map(match => match[1]))];
      const definitions = [...new Set([...String(result.stdout ?? '').matchAll(/^Task definition: (arn:aws:ecs:[^\s]+)$/gm)].map(match => match[1]))];
      if (tasks.length !== 1 || definitions.length !== 1) {
        record?.events.push({ type: 'one-shot-probe', role, action: argument, service_sha: revision.commit,
          image_digest: revision.digest, result: 'launch-failed' });
        throw new Error('One-shot probe identity missing; inspect redacted run evidence');
      }
      record?.events.push({ type: 'one-shot-identity', role, action: argument, task_arn: tasks[0], task_definition_arn: definitions[0] });
      const task = (await io.aws(['ecs', 'describe-tasks', '--cluster', 'beta-anywear', '--tasks', tasks[0]])).tasks?.[0];
      const definition = (await io.aws(['ecs', 'describe-task-definition', '--task-definition', definitions[0]])).taskDefinition;
      const actualContainer = task?.containers?.find(item => item.name === 'OneShot');
      const container = definition?.containerDefinitions?.find(item => item.name === 'OneShot');
      if (task?.lastStatus !== 'STOPPED' || task.taskDefinitionArn !== definitions[0]
        || actualContainer?.imageDigest !== revision.digest) {
        throw new Error('Actual one-shot image/result differs from the deployed revision');
      }
      if (role === 'verify'
        && canonicalJson(container?.command) !== canonicalJson(['node', 'dist/verify.js', argument])) {
        throw new Error('Actual verify command differs from the requested action');
      }
      const exitCode = Number.isSafeInteger(actualContainer.exitCode) ? actualContainer.exitCode : 'unavailable';
      record?.events.push({ type: 'one-shot-probe', role, action: argument, service_sha: revision.commit,
        image_digest: revision.digest, task_arn: tasks[0], task_definition_arn: definitions[0],
        command_sha256: sha256(canonicalJson(container?.command)), exit_code: exitCode,
        result: exitCode === 0 ? 'stopped-success' : 'stopped-failure' });
      process.stdout.write(String(result.stdout ?? ''));
      if (result.stderr) process.stderr.write(String(result.stderr));
      return { exitCode, task, definition };
    },
    async deploy(stack) {
      if (purpose !== 'operation') throw new Error('Qualification cannot deploy');
      assertDeployAllowed(env, stack);
      const apiOriginDomainName = stack === baseStack ? await readApiOrigin(io) : undefined;
      const natEipAllocationId = stack === egressStack ? env.NAT_EIP_ALLOCATION_ID : undefined;
      const awsEnv = await roleEnv('deploy');
      // Pre-mutation preflight (#165): after the restricted session is
      // available and before CDK changes anything, simulate the deploy and
      // runtime roles' effective authorization for the operation's reads. A
      // deny or a simulation failure stops the deploy with zero changes.
      await runAuthorizationPreflight({ sessions: ['deploy', 'runtime'], env, purpose, assume, run });
      await run('npx', cdkDeploymentArguments(stack, directory, env, { apiOriginDomainName, natEipAllocationId }),
        { cwd: root, env: awsEnv, timeout: 3_600_000, maxBuffer: 20 * 1024 * 1024 });
      // Record the completed mutation immediately: a later retention failure must
      // still leave `partial`/`requires-explicit-recovery` evidence, not `failed`
      // as if the deploy had not happened.
      record?.events.push({ type: 'stack-deploy', stack_name: stack, source_repository: env.GITHUB_REPOSITORY, source_sha: env.GITHUB_SHA, result: 'complete' });
      if (stack === baseStack) {
        await enforceBetaPlatformLogRetention(io, { ref: env.GITHUB_REF, enabled: env.ENABLE_BETA_MUTATION });
        record?.events.push({ type: 'beta-platform-log-retention', stack_name: stack, result: 'complete' });
      }
    },
    // The stop paths. `delete-egress` is the second stop step and destroys only
    // the Egress stack; since #195 `stop-runtime` deletes only the release slice.
    async destroy(stack) {
      if (purpose !== 'operation') throw new Error('Qualification cannot destroy');
      assertDeployAllowed(env, stack);
      if (env.INFRA_OPERATION === 'delete-egress') {
        if (stack !== egressStack) throw new Error('Only delete-egress may destroy the Egress stack');
      } else if (env.INFRA_OPERATION === 'stop-runtime') {
        if (stack !== runtimeStack) throw new Error('Only stop-runtime may destroy the Runtime stack');
      } else throw new Error('This operation may not destroy a stack');
      // Pre-mutation preflight (#165): simulate the deploy and runtime roles'
      // authorization before the stack is deleted.
      await runAuthorizationPreflight({ sessions: ['deploy', 'runtime'], env, purpose, assume, run });
      const awsEnv = await roleEnv('deploy');
      await run('npx', cdkDestroyArguments(stack, env),
        { cwd: root, env: awsEnv, timeout: 3_600_000, maxBuffer: 20 * 1024 * 1024 });
      record?.events.push({ type: 'stack-destroy', stack_name: stack, source_repository: env.GITHUB_REPOSITORY, source_sha: env.GITHUB_SHA, result: 'complete' });
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
    // The post-open proof is recorded exactly as the admission driver built and
    // asserted it: one event that says open, no bound, both surfaces agree.
    recordAdmissionOpenProof(proof) { record?.events.push(proof); },
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
      throw new Error('Public health failed to match the deployed image');
    },
  };
  return io;
}
export async function runOperation(env = process.env) {
  const inputs = validateOperationInputs(env);
  const record = createOperationRecord({ env, release: inputs.service_release });
  try {
  const io = await createRuntimeIo(env, record);
  if ((await io.aws(['sts', 'get-caller-identity'])).Account !== account) throw new Error('Wrong runtime account');
  for (const row of record.stack_manifest) {
    const template = (await io.aws(['cloudformation', 'get-template', '--stack-name', row.stack_name, '--template-stage', 'Original', '--region', row.region])).TemplateBody;
    record.original_stack_templates.push({ stack_name: row.stack_name, region: row.region, template_sha256: sha256(canonicalJson(typeof template === 'string' ? parseJson(template) : template)) });
  }
  // A release operation records the image digest its Service commit was
  // published under. Resolve it from the immutable ECR tag under the operation's
  // own session before the deploy; a missing or ambiguous tag fails with no
  // mutation. Every other operation keeps `service_release = null`.
  if (inputs.service_release) {
    record.service_release = validateServiceRelease({ ...inputs.service_release,
      imageDigest: await resolveServiceImageDigest(io, inputs.service_release.serviceCommit) });
  }
  if (env.INFRA_OPERATION === 'state') {
    try { record.state_observation = await observeBetaState(io); }
    catch (error) { record.state_observation = error.observedState; throw error; }
    finally {
      record.events.push({ type: 'final-stack-state', ...Object.fromEntries((record.state_observation?.stacks ?? []).flatMap(stack => {
        const key = stack.stack_name.includes('Platform') ? 'base' : 'runtime';
        return [[`${key}_status`, stack.status], [`${key}_exists`, key === 'runtime' ? stack.runtime_exists : true]];
      })) });
    }
    record.final_observation = 'not-applicable';
    record.result = 'succeeded';
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, 'requires_qualification=false\n');
    return;
  }
  const operation = env.INFRA_OPERATION;
  if (operation === 'close-admission') await runCloseAdmission({ io, infraSha: env.GITHUB_SHA, env });
  else if (operation === 'open-admission') await runOpenAdmission({ io, infraSha: env.GITHUB_SHA, env });
  else if (operation === 'restore-release') await runRestoreRelease({ io, infraSha: env.GITHUB_SHA, env });
  else if (Object.hasOwn(testerOperationActions, operation)) await runTesterAllowlist(testerOperationActions[operation], env.TESTER_EMAILS, io);
  else if (operation === 'migrate') {
    // A forward migration runs only against an admission mirror that proves
    // closed admission. Nothing closes on its own any more, so a stale `testers`
    // record must be closed explicitly with `close-admission` before this fence
    // admits; an unprovable record is refused until that happens. The migration
    // runs on the revision the release slice reports, never on a locally selected
    // image: Infra no longer chooses a Service release.
    await assertMigrationAdmissionClosed(io);
    const runtime = await stackRead(io, runtimeStack);
    assertRuntimeReady(runtime, 'migrate');
    const revision = workloadRevision(runtime);
    record.observed_service_revision = { service_sha: revision.commit, image_digest: revision.digest };
    await io.oneShot('migrate', revision);
  } else if (operation === 'deploy-runtime') {
    // Issue #195: one operation deploys a Service release, resolves the image
    // digest, records the change set, bakes the six signals and writes the v5
    // record. It produces its own accepted record, so no `observe` job follows.
    await deployRuntime({ io, env, record, release: record.service_release });
  } else if (operation === 'stop-runtime') {
    await stopRuntime({ io, env, record });
  } else if (operation === 'delete-egress') {
    await deleteOperationStack(io, operation, record);
  } else if (operation !== 'observe') {
    // The Base and account-wide stacks take no release input; only the Base stack
    // consumes Service-built Lambda assets, and its deploy proves those bytes
    // through the reviewed release identity before credentials. A Base deploy
    // additionally reads the Service-owned Runtime stack terminal first (one
    // writer) and takes its live API origin.
    await deployOperationStack(io, operation);
  }
  const base = await stackRead(io, baseStack);
  const runtime = await stackRead(io, runtimeStack);
  record.events.push({ type: 'final-stack-state', base_status: base?.StackStatus ?? 'unavailable',
    runtime_status: runtime?.StackStatus ?? 'unavailable', runtime_exists: runtimeExists(runtime) });
  if (!terminalStackStatuses.has(base?.StackStatus)) throw new Error(`The Base stack is not terminal after ${operation}`);
  // `deploy-runtime` writes the accepted v5 record itself; every other mutating
  // operation still needs the separate read-only observation job.
  const requiresQualification = operation === 'deploy-runtime' ? 'false' : 'true';
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `runtime_exists=${runtimeExists(runtime)}\nrequires_qualification=${requiresQualification}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    const release = inputs.service_release ? ` Service release ${inputs.service_release.releaseTag}@${inputs.service_release.serviceCommit}.` : '';
    await appendFile(env.GITHUB_STEP_SUMMARY, `Infra operation ${operation}; source ${env.GITHUB_SHA}.${release}\n`);
  }
  record.result = 'succeeded';
  } catch (error) { record.result = 'failed'; throw error; }
  finally { await writeFile('deployment-evidence/operation-record.json', canonicalJson(record)); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runOperation();
