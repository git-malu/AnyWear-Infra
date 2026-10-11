import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, lstat, realpath, open, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseJson, exact, canonicalJson, sha256, SHA, HASH } from './json-contract.mjs';
import { loadCommittedSelection, verifySelection, commandEnvironment } from './artifact-consumer.mjs';
import { readAdmissionState, assertClosedAdmission } from './admission-operation.mjs';
import { parseBootstrapOrigin, verifyBootstrapOrigin } from './cleanup-acceptance-origin.mjs';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixtureFamily = 'beta-anywear-cleanup-acceptance';
export const fixtureMarker = 'ANYWEAR_BETA_CLEANUP_ACCEPTANCE_RESULT=';
const command = ['node', 'dist/ops/beta-cleanup-acceptance-fixture.js'];
const cluster = 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear';
const taskPattern = /^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/[a-f0-9]{32}$/;
const definitionPattern = /^arn:aws:ecs:ap-east-1:650880818323:task-definition\/beta-anywear-cleanup-acceptance:[1-9][0-9]{0,9}$/;
const stackNames = ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta'];
const stackStates = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']);
const stackArn = name => `arn:aws:cloudformation:ap-east-1:650880818323:stack/${name}/*`;
const admissionArns = ['intake_open', 'tester_allowlist', 'admission_suspended']
  .map(name => `arn:aws:ssm:ap-east-1:650880818323:parameter/anywear/beta/${name}`);
const logArn = 'arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/beta/one-shot:log-stream:beta-anywear-cleanup-acceptance/OneShot/*';

export function parseFixtureRequest(json) {
  if (typeof json !== 'string' || Buffer.byteLength(json) > 2048) throw new Error('Bounded fixture request required');
  const request = exact(parseJson(json), ['run_scope', 'users'], 'fixture request');
  if (!/^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$/.test(request.run_scope ?? '')
    || !Array.isArray(request.users) || request.users.length !== 2) throw new Error('Exact fixture run scope and two captured users required');
  request.users.forEach((user, index) => {
    exact(user, ['slot', 'user_id', 'email'], 'captured fixture identity');
    if (user.slot !== index + 2 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(user.user_id ?? '')
      || user.email !== `e2e-beta-worker-${index + 2}-chromium@anywear.local`) throw new Error('Only captured fixture slots 2 and 3 are accepted');
  });
  const normalized = { run_scope: request.run_scope, users: request.users.map(({ slot, user_id, email }) => ({ slot, user_id, email })) };
  if (request.users[0].user_id === request.users[1].user_id || JSON.stringify(normalized) !== json) throw new Error('Canonical distinct captured fixture identities required');
  return request;
}

export function validateFixtureInputs(env = process.env) {
  if (env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Infra' || env.GITHUB_REPOSITORY_ID !== '1409047265'
    || env.GITHUB_REPOSITORY_OWNER !== 'git-malu' || env.GITHUB_REPOSITORY_OWNER_ID !== '11473072'
    || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || !SHA.test(env.GITHUB_SHA ?? '')
    || env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA
    || env.GITHUB_WORKFLOW_REF !== 'git-malu/AnyWear-Infra/.github/workflows/beta-cleanup-acceptance.yml@refs/heads/main'
    || env.ENABLE_BETA_CLEANUP_ACCEPTANCE !== 'true') throw new Error('Protected issue 86 fixture executor and dedicated activation gate required');
  if (env.AWS_ACCOUNT_ID !== '650880818323' || env.AWS_REGION !== 'ap-east-1'
    || env.INFRA_RUNTIME_ROLE_ARN !== 'arn:aws:iam::650880818323:role/beta-infra-runtime-role') throw new Error('Exact existing Infra principal/account/region required');
  if (!/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]{0,5}$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) throw new Error('Exact workflow run and attempt required');
  if (!['prepare', 'inspect', 'release-task', 'cleanup'].includes(env.FIXTURE_ACTION)) throw new Error('Unknown cleanup acceptance action');
  if (!definitionPattern.test(env.FIXTURE_TASK_DEFINITION_ARN ?? '') || !SHA.test(env.FIXTURE_SOURCE_SHA ?? '')) throw new Error('Full deployed fixture task revision and Infra producer required');
  if (!/^selections\/[a-z0-9][a-z0-9._-]{0,127}\.json$/.test(env.SELECTION_FILE ?? '') || !HASH.test(env.SELECTION_SHA256 ?? '')
    || !/^stack-sources\/[a-z0-9][a-z0-9._-]{0,127}\.json$/.test(env.STACK_SOURCES_FILE ?? '') || !HASH.test(env.STACK_SOURCES_SHA256 ?? '')) throw new Error('Committed immutable selection and stack sources required');
  parseBootstrapOrigin(env.BOOTSTRAP_ORIGIN);
  return parseFixtureRequest(env.FIXTURE_REQUEST);
}

export async function fixturePreflight(env = process.env, trustedRoot = root) {
  validateFixtureInputs(env);
  const binding = { trustedInfraRoot: trustedRoot, expectedInfraSha: env.GITHUB_SHA,
    selectionFile: env.SELECTION_FILE, selectionSha256: env.SELECTION_SHA256 };
  const selector = await loadCommittedSelection(binding);
  const file = path.join(trustedRoot, env.STACK_SOURCES_FILE);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path.dirname(file)) !== path.dirname(file) || stat.size > 16384) throw new Error('Regular bounded stack source blob required');
  const git = async args => (await execute('git', ['--no-replace-objects', '-C', trustedRoot, ...args], {
    encoding: 'buffer', timeout: 30_000, maxBuffer: 65536, env: commandEnvironment(env, ''),
  })).stdout;
  const tree = (await git(['ls-tree', '-z', env.GITHUB_SHA, '--', env.STACK_SOURCES_FILE])).toString('utf8');
  if (!/^100644 blob [a-f0-9]{40}\t[^\0]+\0$/.test(tree)) throw new Error('Tracked reviewed stack sources required');
  const bytes = await readFile(file);
  if (!bytes.equals(await git(['cat-file', 'blob', `${env.GITHUB_SHA}:${env.STACK_SOURCES_FILE}`])) || sha256(bytes) !== env.STACK_SOURCES_SHA256) throw new Error('Stack source bytes differ from reviewed input');
  const sources = parseJson(bytes);
  const names = [...stackNames, 'AnyWearFoundationStack', 'AnyWearBillingStack-beta'];
  if (!Array.isArray(sources) || sources.length !== 4 || new Set(sources.map(row => row.stack_name)).size !== 4) throw new Error('Four unique explicit stack producers required');
  for (const row of sources) {
    exact(row, ['stack_name', 'region', 'source_repository', 'source_sha'], 'fixture stack producer');
    if (!names.includes(row.stack_name) || row.region !== (row.stack_name.includes('Billing') ? 'us-east-1' : 'ap-east-1')
      || !['git-malu/AnyWear-Infra', 'git-malu/AnyWear-Service'].includes(row.source_repository) || !SHA.test(row.source_sha ?? '')) throw new Error('Explicit unchanged stack producer required; no executor placeholder');
  }
  const workload = sources.find(row => row.stack_name === stackNames[1]);
  if (workload.source_repository !== 'git-malu/AnyWear-Infra' || workload.source_sha !== env.FIXTURE_SOURCE_SHA) throw new Error('Fixture must bind the reviewed actual Workload producer');
  await loadCommittedSelection(binding);
  return { selector, sources, binding };
}

// Separate STS sessions keep immutable preflight reads and the single task
// mutation within the 2048-byte session-policy limit without retaining runtime writes.
export function fixtureSessionPolicy(kind, env, roles) {
  if (!definitionPattern.test(env.FIXTURE_TASK_DEFINITION_ARN ?? '')) throw new Error('Exact fixture revision required');
  const statement = (Action, Resource, Condition) => ({ Effect: 'Allow', Action, Resource, ...(Condition ? { Condition } : {}) });
  const clusterCondition = { ArnEquals: { 'ecs:cluster': cluster } };
  const regionalCondition = { StringEquals: { 'aws:RequestedRegion': 'ap-east-1' } };
  const statements = kind === 'read' ? [
    statement(['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'], stackNames.map(stackArn)),
    statement('ssm:GetParameters', admissionArns),
    // ECS DescribeTaskDefinition does not support resource-level permissions;
    // retain the regional boundary while using the required wildcard resource.
    statement('ecs:DescribeTaskDefinition', '*', regionalCondition),
    statement('ecs:ListTasks', '*', clusterCondition),
    statement('ecs:DescribeTasks', 'arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/*', clusterCondition),
    statement('logs:GetLogEvents', logArn),
  ] : kind === 'run' ? [
    statement('ecs:RunTask', env.FIXTURE_TASK_DEFINITION_ARN, clusterCondition),
    statement('iam:PassRole', roles, { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } }),
  ] : undefined;
  if (!statements || kind === 'run' && (!Array.isArray(roles) || roles.length !== 2
    || roles[0] !== 'arn:aws:iam::650880818323:role/beta-anywear-tester-cleanup-task'
    || roles[1] !== 'arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution')) throw new Error('Only fixed fixture task roles may be passed');
  const policy = JSON.stringify({ Version: '2012-10-17', Statement: statements });
  if (Buffer.byteLength(policy) > 2048) throw new Error('Fixture session policy exceeds STS size bound');
  return policy;
}

export async function fixtureCredentials(kind, policy, env = process.env, { run = execute, fetchImpl = fetch } = {}) {
  validateFixtureInputs(env);
  if (!['read', 'run'].includes(kind) || typeof policy !== 'string' || Buffer.byteLength(policy) > 2048) throw new Error('Bounded explicit fixture session required');
  const supplied = parseJson(policy);
  const roles = kind === 'run' ? supplied.Statement?.[1]?.Resource : undefined;
  if (policy !== fixtureSessionPolicy(kind, env, roles)) throw new Error('Exact dedicated fixture session policy required');
  const endpoint = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.actions.githubusercontent.com') || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('Protected OIDC endpoint required');
  endpoint.searchParams.set('audience', 'sts.amazonaws.com');
  let token;
  try {
    const response = await fetchImpl(endpoint, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
    token = response.ok ? (await response.json()).value : undefined;
  } catch {
    throw new Error('Fixture OIDC request failed');
  }
  if (typeof token !== 'string' || !token) throw new Error('Fixture OIDC token unavailable');
  const child = commandEnvironment(env, '');
  child.AWS_EC2_METADATA_DISABLED = 'true'; child.AWS_PAGER = '';
  let assumed;
  try {
    assumed = parseJson((await run('aws', ['sts', 'assume-role-with-web-identity', '--role-arn', env.INFRA_RUNTIME_ROLE_ARN,
      '--role-session-name', `cleanup86-${kind}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`, '--web-identity-token', token,
      '--duration-seconds', '3600', '--policy', policy, '--region', 'ap-east-1', '--output', 'json'],
    { env: child, timeout: 60_000, maxBuffer: 65536 })).stdout);
  } catch {
    // execFile errors include argv; never propagate the web identity token.
    throw new Error('Fixture credential exchange failed');
  }
  if (!assumed.AssumedRoleUser?.Arn?.startsWith('arn:aws:sts::650880818323:assumed-role/beta-infra-runtime-role/')) throw new Error('Unexpected fixture assumed identity');
  const credentials = assumed.Credentials;
  if (![credentials?.AccessKeyId, credentials?.SecretAccessKey, credentials?.SessionToken].every(value => typeof value === 'string' && value)) throw new Error('Complete fixture credentials required');
  return { ...child, AWS_ACCESS_KEY_ID: credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: credentials.SessionToken, AWS_REGION: 'ap-east-1', AWS_DEFAULT_REGION: 'ap-east-1' };
}

function uniqueMap(rows, key, value, label) {
  if (!Array.isArray(rows) || new Set(rows.map(row => row?.[key])).size !== rows.length
    || rows.some(row => typeof row?.[key] !== 'string' || typeof row[value] !== 'string')) throw new Error(`Incomplete or duplicate ${label}`);
  return Object.fromEntries(rows.map(row => [row[key], row[value]]));
}

export function assertFixtureDefinition(definition, outputs, selector, env) {
  if (definition?.taskDefinitionArn !== env.FIXTURE_TASK_DEFINITION_ARN || definition.family !== fixtureFamily || definition.status !== 'ACTIVE'
    || definition.networkMode !== 'awsvpc' || definition.cpu !== '512' || definition.memory !== '1024'
    || canonicalJson(definition.requiresCompatibilities) !== canonicalJson(['FARGATE'])
    || definition.taskRoleArn !== outputs.CleanupTaskRoleArn || definition.executionRoleArn !== outputs.OneShotExecutionRoleArn
    || definition.containerDefinitions?.length !== 1) throw new Error('Fixed preprovisioned fixture definition mismatch');
  const container = definition.containerDefinitions[0];
  const environment = uniqueMap(container.environment, 'name', 'value', 'fixture environment');
  const expected = { STAGE: 'beta', NODE_ENV: 'production', AWS_REGION: 'ap-east-1', BETA_CLEANUP_ACCEPTANCE_ISSUE: '86',
    SERVICE_COMMIT_SHA: selector.image.service_sha, IMAGE_DIGEST: selector.image.digest,
    DB_SECRET_ARN: outputs.DatabaseSecretArn, DB_HOST: outputs.DatabaseHost, DB_PORT: outputs.DatabasePort, DB_NAME: outputs.DatabaseName,
    S3_BUCKET_NAME: outputs.WardrobeBucketName, TASK_TRANSPORT: 'sqs', SQS_VTO_QUEUE_URL: outputs.VtoQueueUrl, SQS_AUTO_TAGGING_QUEUE_URL: outputs.AutoTaggingQueueUrl };
  const logConfiguration = container.logConfiguration;
  const secretOptions = logConfiguration?.secretOptions;
  if (secretOptions !== undefined && (!Array.isArray(secretOptions) || secretOptions.length !== 0)) throw new Error('Fixture command/image/environment/log configuration mismatch');
  const normalizedLogConfiguration = { ...logConfiguration };
  if (secretOptions !== undefined) delete normalizedLogConfiguration.secretOptions;
  if (Object.values(expected).some(value => typeof value !== 'string' || !value) || container.name !== 'OneShot' || container.essential !== true
    || container.image !== `${selector.image.repository_uri}@${selector.image.digest}` || canonicalJson(container.command) !== canonicalJson(command)
    || canonicalJson(environment) !== canonicalJson(expected) || (container.entryPoint !== undefined && (!Array.isArray(container.entryPoint) || container.entryPoint.length !== 0)) || container.secrets?.length
    || container.mountPoints?.length || definition.volumes?.length || definition.pidMode !== undefined || definition.ipcMode !== undefined
    || canonicalJson(normalizedLogConfiguration) !== canonicalJson({ logDriver: 'awslogs', options: {
      'awslogs-group': '/anywear/beta/one-shot', 'awslogs-region': 'ap-east-1', 'awslogs-stream-prefix': fixtureFamily } })) throw new Error('Fixture command/image/environment/log configuration mismatch');
  return definition;
}

export async function readFixtureState(io, selector, env, stateMachineVersionArn) {
  if (!/^arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:[1-9][0-9]*$/.test(stateMachineVersionArn ?? '')) throw new Error('Authenticated frozen cleanup version required');
  const stacks = [];
  for (const name of stackNames) {
    const result = await io.aws(['cloudformation', 'describe-stacks', '--stack-name', name]);
    const stack = result.Stacks?.[0];
    if (result.Stacks?.length !== 1 || stack.StackName !== name || !stackStates.has(stack.StackStatus)
      || !stack.StackId?.startsWith(`arn:aws:cloudformation:ap-east-1:650880818323:stack/${name}/`)
      || typeof (stack.LastUpdatedTime ?? stack.CreationTime) !== 'string') throw new Error('Stable authenticated Beta stacks required');
    const outputs = uniqueMap(stack.Outputs, 'OutputKey', 'OutputValue', 'Beta stack outputs');
    if (outputs.BetaActive !== 'true') throw new Error('Fixture cannot run against stopped or unknown Beta');
    stacks.push({ stack, outputs });
  }
  const platform = stacks[0].outputs; const workload = stacks[1].outputs;
  const parameters = uniqueMap(stacks[1].stack.Parameters, 'ParameterKey', 'ParameterValue', 'Workload parameters');
  if (platform.EcsClusterName !== 'beta-anywear' || platform.OneShotLogGroupName !== '/anywear/beta/one-shot'
    || workload.CleanupAcceptanceTaskDefinitionArn !== env.FIXTURE_TASK_DEFINITION_ARN
    || workload.CleanupOperationCleanupStateMachineVersionArn18053210 !== stateMachineVersionArn
    || parameters.ServiceCommitSha !== selector.image.service_sha || parameters.ServiceImageDigest !== selector.image.digest) throw new Error('Fixture definition and deployed selected Service binding mismatch');
  const definition = assertFixtureDefinition((await io.aws(['ecs', 'describe-task-definition', '--task-definition', env.FIXTURE_TASK_DEFINITION_ARN])).taskDefinition, platform, selector, env);
  const admission = await readAdmissionState({ aws: async args => {
    // The existing parser reads parameters individually; the session permits
    // only GetParameters and keeps each exact parameter identity intact.
    const result = await io.aws(['ssm', 'get-parameters', '--names', args[3]]);
    if (result.Parameters?.length !== 1 || result.InvalidParameters?.length) throw new Error('Exact admission parameter unavailable');
    return { Parameter: result.Parameters[0] };
  } });
  assertClosedAdmission(admission, admission);
  const original = (await io.aws(['cloudformation', 'get-template', '--stack-name', stackNames[1], '--template-stage', 'Original'])).TemplateBody;
  const template = typeof original === 'string' ? parseJson(original) : original;
  const fixtureResources = Object.entries(template?.Resources ?? {}).filter(([, resource]) => resource?.Type === 'AWS::ECS::TaskDefinition' && resource.Properties?.Family === fixtureFamily);
  const logicalId = template?.Outputs?.CleanupAcceptanceTaskDefinitionArn?.Value?.Ref;
  if (fixtureResources.length !== 1 || fixtureResources[0][0] !== logicalId) throw new Error('Fixture task is not proven as the current Workload resource');
  return { platform, definition, admission, stack_versions: stacks.map(({ stack }) => ({ stack_id: stack.StackId,
    status: stack.StackStatus, updated: stack.LastUpdatedTime ?? stack.CreationTime })), template_sha256: sha256(canonicalJson(template)) };
}

export function assertStoppedFixture(task, env, selector, request) {
  const overrides = { containerOverrides: [{ name: 'OneShot', command: [...command, env.FIXTURE_ACTION, env.FIXTURE_REQUEST] }] };
  const observed = structuredClone(task?.overrides);
  // Only identical ECS CPU/memory defaults are normalized. Environment, role
  // and command overrides remain forbidden.
  for (const [key, value] of [['cpu', '512'], ['memory', '1024']]) {
    if (observed?.[key] === value) delete observed[key];
  }
  // ECS describe-tasks includes an empty inference accelerator override list
  // even when RunTask supplied no accelerator overrides. Non-empty values
  // remain forbidden because they alter the reviewed fixture execution.
  const inferenceAcceleratorOverrides = observed?.inferenceAcceleratorOverrides;
  if (inferenceAcceleratorOverrides !== undefined
    && (!Array.isArray(inferenceAcceleratorOverrides) || inferenceAcceleratorOverrides.length !== 0)) {
    throw new Error('Non-empty inference accelerator overrides are forbidden');
  }
  if (inferenceAcceleratorOverrides !== undefined) delete observed.inferenceAcceleratorOverrides;
  const container = task?.containers?.[0];
  if (!taskPattern.test(task?.taskArn ?? '') || task.clusterArn !== cluster || task.taskDefinitionArn !== env.FIXTURE_TASK_DEFINITION_ARN
    || task.lastStatus !== 'STOPPED' || task.containers?.length !== 1 || container.name !== 'OneShot' || container.lastStatus !== 'STOPPED'
    || container.exitCode !== 0 || container.imageDigest !== selector.image.digest || canonicalJson(observed) !== canonicalJson(overrides)
    || request.run_scope !== parseFixtureRequest(env.FIXTURE_REQUEST).run_scope) throw new Error('Exact stopped fixture task/result/overrides required');
  return task;
}

export async function readFixtureResult(io, task, selector, env) {
  const request = parseFixtureRequest(env.FIXTURE_REQUEST);
  assertStoppedFixture(task, env, selector, request);
  const args = ['logs', 'get-log-events', '--log-group-name', '/anywear/beta/one-shot',
    '--log-stream-name', `${fixtureFamily}/OneShot/${task.taskArn.split('/').at(-1)}`, '--start-from-head', '--limit', '1000'];
  let previous;
  for (let attempt = 0; attempt < 5; attempt++) {
    let token; const tokens = new Set(); const messages = [];
    for (let page = 0; page < 16; page++) {
      const response = await io.aws([...args, ...(token ? ['--next-token', token] : [])]);
      if (!Array.isArray(response.events) || response.events.length > 1000 || response.events.some(event => typeof event?.message !== 'string' || event.message.length > 262144)) throw new Error('Malformed fixture log page');
      messages.push(...response.events.map(event => event.message));
      if (messages.length > 4096) throw new Error('Fixture log inventory exceeds bound');
      const next = response.nextForwardToken;
      if (typeof next !== 'string' || !next || next.length > 4096) throw new Error('Fixture log pagination unproven');
      if (next === token) break;
      if (tokens.has(next) || page === 15) throw new Error('Fixture log pagination incomplete');
      tokens.add(next); token = next;
    }
    const records = messages.filter(message => message.includes(fixtureMarker));
    if (records.length > 1 || records.some(message => !message.startsWith(fixtureMarker))) throw new Error('Ambiguous fixture result marker');
    if (records.length === 1) {
      const result = parseJson(records[0].slice(fixtureMarker.length));
      if (result.schema_version !== 1 || result.record_type !== 'anywear_beta_cleanup_acceptance_result'
        || result.action !== env.FIXTURE_ACTION || result.run_scope !== request.run_scope || result.request_sha256 !== sha256(env.FIXTURE_REQUEST)
        || result.service_commit_sha !== selector.image.service_sha || result.service_image_digest !== selector.image.digest
        || result.transaction_committed !== true || result.queue_calls !== 0 || result.provider_calls !== 0 || result.lifecycle_changes !== 0) throw new Error('Fixture committed result binding mismatch');
      for (const rows of [result.before, result.after]) {
        if (!Array.isArray(rows) || rows.length !== 2 || rows.some((row, index) => row.slot !== request.users[index].slot
          || row.user_id !== request.users[index].user_id || row.email !== request.users[index].email || row.role !== (index === 0 ? 'primary' : 'sentinel'))) throw new Error('Fixture result identity mismatch');
      }
      const current = canonicalJson(result);
      if (previous === current) return result;
      if (previous !== undefined) throw new Error('Fixture result changed between complete log scans');
      previous = current;
    } else previous = undefined;
    if (attempt < 4) await io.sleep(2000);
  }
  throw new Error('Unique complete fixture commit proof unavailable');
}

async function assertNoActiveFixture(io) {
  const observed = [];
  for (const desired of ['RUNNING', 'STOPPED']) {
    const result = await io.aws(['ecs', 'list-tasks', '--cluster', 'beta-anywear', '--family', fixtureFamily,
      '--desired-status', desired, '--max-results', '100', '--no-paginate']);
    if (!Array.isArray(result.taskArns) || result.taskArns.length > 100 || result.nextToken !== undefined
      || result.taskArns.some(arn => !taskPattern.test(arn))) throw new Error('Complete bounded fixture task inventory required');
    observed.push(...result.taskArns);
  }
  const arns = [...new Set(observed)].sort();
  if (arns.length > 100) throw new Error('Fixture task inventory exceeds bounded description batch');
  if (arns.length) {
    const result = await io.aws(['ecs', 'describe-tasks', '--cluster', 'beta-anywear', '--tasks', ...arns]);
    if (result.failures?.length || result.tasks?.length !== arns.length || new Set(result.tasks.map(task => task.taskArn)).size !== arns.length
      || result.tasks.some(task => !arns.includes(task.taskArn) || task.clusterArn !== cluster || !definitionPattern.test(task.taskDefinitionArn ?? '')
        || task.lastStatus !== 'STOPPED')) throw new Error('Active or unresolved fixture tasks block new invocation');
  }
  return arns;
}

export async function executeFixture({ io, runTask, selector, env, stateMachineVersionArn, guard = async () => {}, record = {}, checkpoint = async () => {} }) {
  validateFixtureInputs(env);
  const before = await readFixtureState(io, selector, env, stateMachineVersionArn);
  record.original = before;
  const firstInventory = await assertNoActiveFixture(io);
  await io.sleep(1000);
  if (canonicalJson(firstInventory) !== canonicalJson(await assertNoActiveFixture(io))) throw new Error('Fixture task inventory changed between complete scans');
  await guard();
  if (canonicalJson(before) !== canonicalJson(await readFixtureState(io, selector, env, stateMachineVersionArn))) throw new Error('Fixture configuration changed before task launch');
  const subnets = before.platform.PrivateSubnetIds?.split(',');
  if (!Array.isArray(subnets) || subnets.length < 1 || subnets.length > 6 || new Set(subnets).size !== subnets.length
    || subnets.some(subnet => !/^subnet-[a-f0-9]{8,17}$/.test(subnet)) || !/^sg-[a-f0-9]{8,17}$/.test(before.platform.OneShotSecurityGroupId ?? '')) throw new Error('Fixed private fixture network required');
  const input = { cluster, taskDefinition: env.FIXTURE_TASK_DEFINITION_ARN, count: 1, launchType: 'FARGATE',
    clientToken: sha256(`${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}:${env.FIXTURE_ACTION}:${env.FIXTURE_REQUEST}:${env.FIXTURE_TASK_DEFINITION_ARN}`),
    networkConfiguration: { awsvpcConfiguration: { subnets, securityGroups: [before.platform.OneShotSecurityGroupId], assignPublicIp: 'DISABLED' } },
    overrides: { containerOverrides: [{ name: 'OneShot', command: [...command, env.FIXTURE_ACTION, env.FIXTURE_REQUEST] }] } };
  const launched = await runTask(input, [before.definition.taskRoleArn, before.definition.executionRoleArn], async () => {
    record.launch_attempted = true; record.launch_input_sha256 = sha256(canonicalJson(input));
    await checkpoint(record);
  });
  const tasks = Array.isArray(launched?.tasks) ? launched.tasks : [];
  record.launch_response = { task_arns: tasks.slice(0, 100).map(task => task?.taskArn).filter(arn => taskPattern.test(arn ?? '')),
    task_count: Array.isArray(launched?.tasks) ? tasks.length : null,
    failure_count: Array.isArray(launched?.failures) ? launched.failures.length : launched?.failures === undefined ? 0 : null,
    unidentified_task_count: tasks.filter(task => !taskPattern.test(task?.taskArn ?? '')).length,
    identities_truncated: tasks.length > 100 };
  if (tasks.length === 1 && taskPattern.test(tasks[0]?.taskArn ?? '')) record.task_arn = tasks[0].taskArn;
  await checkpoint(record);
  if (record.launch_attempted !== true || record.launch_response.failure_count !== 0 || tasks.length !== 1 || !record.task_arn) throw new Error('Unique fixture launch identity unavailable; do not retry uncertain mutation');
  const taskArn = launched.tasks[0].taskArn;
  const deadline = io.now() + 15 * 60_000;
  let task;
  while (io.now() < deadline) {
    const result = await io.aws(['ecs', 'describe-tasks', '--cluster', 'beta-anywear', '--tasks', taskArn]);
    if (result.failures?.length || result.tasks?.length !== 1 || result.tasks[0]?.taskArn !== taskArn
      || result.tasks[0].clusterArn !== cluster || result.tasks[0].taskDefinitionArn !== env.FIXTURE_TASK_DEFINITION_ARN) throw new Error('Fixture task identity/readback unproven');
    task = result.tasks[0];
    if (task.lastStatus === 'STOPPED') break;
    if (!['PROVISIONING', 'PENDING', 'ACTIVATING', 'RUNNING', 'DEACTIVATING', 'STOPPING', 'DEPROVISIONING'].includes(task.lastStatus)) throw new Error('Unknown fixture task status');
    await io.sleep(5000);
  }
  assertStoppedFixture(task, env, selector, parseFixtureRequest(env.FIXTURE_REQUEST));
  const overrides = structuredClone(task.overrides);
  for (const [key, value] of [['cpu', '512'], ['memory', '1024']]) if (overrides[key] === value) delete overrides[key];
  record.task_observation = { task_arn: task.taskArn, cluster_arn: task.clusterArn, task_definition_arn: task.taskDefinitionArn,
    status: task.lastStatus, container: { name: task.containers[0].name, status: task.containers[0].lastStatus,
      exit_code: task.containers[0].exitCode, image_digest: task.containers[0].imageDigest }, overrides };
  await checkpoint(record);
  record.service_result = await readFixtureResult(io, task, selector, env);
  await guard();
  const after = await readFixtureState(io, selector, env, stateMachineVersionArn);
  record.final = after;
  if (canonicalJson(before) !== canonicalJson(after)) throw new Error('Fixture changed deployed tuple, stacks or admission');
  return record;
}

export function fixtureOperationRecord(env = process.env) {
  const request = validateFixtureInputs(env);
  return { schema_version: 1, record_type: 'anywear_beta_cleanup_acceptance_operation', result: 'failed',
    executor: { repository: env.GITHUB_REPOSITORY, source_sha: env.GITHUB_SHA, workflow_ref: env.GITHUB_WORKFLOW_REF,
      run_id: env.GITHUB_RUN_ID, run_attempt: env.GITHUB_RUN_ATTEMPT },
    fixture_source_sha: env.FIXTURE_SOURCE_SHA, task_definition_arn: env.FIXTURE_TASK_DEFINITION_ARN,
    stack_sources: { file: env.STACK_SOURCES_FILE, sha256: env.STACK_SOURCES_SHA256 },
    action: env.FIXTURE_ACTION, run_scope: request.run_scope, request_sha256: sha256(env.FIXTURE_REQUEST) };
}

export async function persistFixtureRecord(record, file) {
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error('Fixture evidence exceeds its bounded artifact size');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
}

export async function runFixture(env = process.env) {
  const request = validateFixtureInputs(env);
  const record = fixtureOperationRecord(env);
  await mkdir(path.join(root, 'deployment-evidence'), { recursive: true });
  const checkpoint = value => persistFixtureRecord(value, path.join(root, 'deployment-evidence/cleanup-acceptance-operation.json'));
  try {
    const { selector, binding, sources } = await fixturePreflight(env);
    record.selection = { file: env.SELECTION_FILE, sha256: env.SELECTION_SHA256, service_sha: selector.image.service_sha, image_digest: selector.image.digest };
    record.reviewed_stack_sources = sources;
    // Immutable producer publication/provenance is verified before any OIDC request.
    await verifySelection(binding, path.join(root, '.service-artifacts/cleanup-acceptance'));
    const bootstrap = await verifyBootstrapOrigin(env, selector, request);
    record.bootstrap = bootstrap;
    const readEnv = await fixtureCredentials('read', fixtureSessionPolicy('read', env), env);
    const aws = async (args, child = readEnv) => parseJson((await execute('aws', [...args, '--region', 'ap-east-1', '--output', 'json'],
      { env: child, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })).stdout);
    const identity = await aws(['sts', 'get-caller-identity']);
    if (identity.Account !== '650880818323' || !identity.Arn?.startsWith('arn:aws:sts::650880818323:assumed-role/beta-infra-runtime-role/')) throw new Error('Wrong authenticated fixture principal');
    await executeFixture({ selector, env, record, checkpoint, stateMachineVersionArn: bootstrap.manifest.frozen_tuple.state_machine_version_arn,
      guard: async () => { await fixturePreflight(env); await verifyBootstrapOrigin(env, selector, request); },
      io: { aws, now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) },
      runTask: async (input, roles, beforeLaunch) => {
        const runPolicy = fixtureSessionPolicy('run', env, roles);
        const runEnv = await fixtureCredentials('run', runPolicy, env);
        await fixturePreflight(env);
        await verifyBootstrapOrigin(env, selector, request);
        await beforeLaunch();
        return aws(['ecs', 'run-task', '--cli-input-json', JSON.stringify(input)], runEnv);
      } });
    record.result = 'committed-result-and-preserved-state-verified';
  } finally {
    await checkpoint(record);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--preflight') await fixturePreflight();
  else if (!args.length) await runFixture();
  else throw new Error('Only dedicated cleanup acceptance execution or preflight is supported');
}
