import { parseJson } from './json-contract.mjs';
import { admissionWindowPayload } from './admission-window.mjs';
import { changedStackNames } from './operation-stacks.mjs';
import { runtimeCommandBytes } from './runtime-command.mjs';
import { normalizeTesterEmails } from './tester-allowlist.mjs';

export const workflowOperations = Object.freeze({
  '.github/workflows/runtime.yml': ['observe'],
  '.github/workflows/beta-observe.yml': ['state'],
  '.github/workflows/beta-lifecycle.yml': ['start', 'stop'],
  '.github/workflows/beta-deploy.yml': ['deploy-foundation', 'deploy-billing', 'deploy-platform', 'deploy-workload', 'restore-release'],
  '.github/workflows/beta-schema.yml': ['migrate', 'verify'],
  '.github/workflows/beta-admission.yml': ['tester-status', 'tester-add', 'tester-replace', 'close-admission', 'open-admission'],
});
export const qualifiedWorkflowPaths = Object.keys(workflowOperations).filter(file => !file.endsWith('beta-observe.yml'));
export function operationBoundary(env) {
  const workflow = Object.keys(workflowOperations).find(file => env.GITHUB_WORKFLOW_REF === `git-malu/AnyWear-Infra/${file}@refs/heads/main`);
  if (!workflow || !workflowOperations[workflow].includes(env.INFRA_OPERATION)) throw new Error('Operation is forbidden for this workflow family');
  return { workflow, family: workflow.split('/').at(-1).replace('.yml', ''), readOnly: env.INFRA_OPERATION === 'state' };
}

const reads = {
  'sts/get-caller-identity': 'sts:GetCallerIdentity',
  'cloudformation/describe-stacks': 'cloudformation:DescribeStacks',
  'cloudformation/get-template': 'cloudformation:GetTemplate',
  'cloudformation/list-stack-resources': 'cloudformation:ListStackResources',
  'ssm/get-parameter': 'ssm:GetParameter',
  'ecs/describe-services': 'ecs:DescribeServices', 'ecs/describe-tasks': 'ecs:DescribeTasks',
  'ecs/describe-task-definition': 'ecs:DescribeTaskDefinition', 'ecs/list-tasks': 'ecs:ListTasks',
  'ecr/describe-images': 'ecr:DescribeImages', 'ecr/batch-get-image': 'ecr:BatchGetImage',
  'lambda/get-function': 'lambda:GetFunction', 'sqs/get-queue-attributes': 'sqs:GetQueueAttributes',
  'logs/get-log-events': 'logs:GetLogEvents', 'logs/describe-log-groups': 'logs:DescribeLogGroups',
  // The base role may deny this legacy fallback; this session never adds grants.
  'cloudfront/get-distribution': 'cloudfront:GetDistribution',
};
const stateReads = ['sts/get-caller-identity', 'cloudformation/describe-stacks', 'cloudformation/get-template', 'ssm/get-parameter'];
const cleanupMachineArn = 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup';
const cleanupExecutionArn = 'arn:aws:states:ap-east-1:650880818323:execution:beta-anywear-tester-cleanup:';
const cleanupFenceRequired = (env, purpose) => purpose === 'operation'
  && changedStackNames(env.INFRA_OPERATION).some(stack => ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta'].includes(stack));
// One frozen evidence record per operation. `roles` is exactly what
// `families(env, 'operation')` materializes for the operation's own session;
// `qualified_by` names the run that qualifies the operation's mutation for E2E
// ('self' when the operation's own artifact is accepted, 'not-applicable' when it
// claims no qualifying mutation), and `evidence` states what evidences it. Every
// operation in `workflowOperations` appears here, so an operation without a
// verification dependency is a recorded decision instead of a missing lookup.
const evidenceEntry = (roles, qualified_by, evidence) => Object.freeze({ roles: Object.freeze(roles), qualified_by, evidence });
export const operationEvidence = Object.freeze({
  observe: evidenceEntry([], 'self',
    'This run emits the accepted anywear_infra_deployment v2 record for the observed active Beta.'),
  state: evidenceEntry([], 'not-applicable',
    'Read-only: the operation record carries anywear_infra_state and claims no mutation.'),
  start: evidenceEntry(['migrate', 'verify', 'lifecycle'], '.github/workflows/runtime.yml',
    'Starting leaves both stacks active, so the following fixed observation records the started tuple.'),
  stop: evidenceEntry(['lifecycle'], 'not-applicable',
    'Stopped activity cannot be observed by an active-runtime record; the operation record final activity and admission readback evidence the stop, and the next start plus qualified observation supplies active evidence.'),
  'deploy-foundation': evidenceEntry([], '.github/workflows/runtime.yml',
    'The accepted record carries the configured stack Original template hash; this does not qualify IAM semantics.'),
  'deploy-billing': evidenceEntry([], '.github/workflows/runtime.yml',
    'The accepted record carries the billing stack Original template hash observed in us-east-1.'),
  'deploy-platform': evidenceEntry([], '.github/workflows/runtime.yml',
    'A Platform change has no accepted evidence step of its own; only the following fixed observation records the reconciled stack.'),
  'deploy-workload': evidenceEntry(['verify', 'artifact-verify'], '.github/workflows/runtime.yml',
    'The accepted record observes the selected running image, ECS task identities and applied schema.'),
  'restore-release': evidenceEntry(['verify', 'artifact-verify'], '.github/workflows/runtime.yml',
    'Restoring both stacks active leaves the recovered tuple observable by the following fixed observation.'),
  migrate: evidenceEntry(['migrate'], '.github/workflows/runtime.yml',
    'The accepted record observes the applied schema through its own artifact-verification task.'),
  verify: evidenceEntry(['verify'], 'not-applicable',
    'Verification, not mutation: it asserts the observed runtime and writes nothing.'),
  'tester-status': evidenceEntry(['verify', 'lifecycle'], 'not-applicable',
    'Status only: it reads admission state and mutates nothing.'),
  'tester-add': evidenceEntry(['verify', 'lifecycle'], 'not-applicable',
    'The accepted record does not observe admission state; the operation record admission readback evidences it, including the window its configure-testers side effect opens, labeled as derived from the Service default because this operation may not run open or status.'),
  'tester-replace': evidenceEntry(['verify', 'lifecycle'], 'not-applicable',
    'The accepted record does not observe admission state; the operation record admission readback evidences it, including the window its configure-testers side effect opens, labeled as derived from the Service default because this operation may not run open or status.'),
  'close-admission': evidenceEntry(['lifecycle', 'artifact-verify'], 'not-applicable',
    'The accepted record does not observe admission state; the operation record lifecycle status and admission readback evidence it.'),
  'open-admission': evidenceEntry(['lifecycle', 'artifact-verify'], 'not-applicable',
    'The accepted record does not observe admission state; the operation record carries the requested window bound, both admission phases and the lifecycle status read-back proving the recorded expiry. Its only extra lifecycle action is the recovery-only close a failed window issues to restore the recorded tuple; no operator path can request it.'),
});
// `artifact-verify` is the verification task family registered by
// `runRuntimeVerification`, never a one-shot helper role, so the one-shot guard
// keeps its current allow-set.
const oneShotRoles = operation => operationEvidence[operation].roles.filter(role => role !== 'artifact-verify');
// `open` appears for exactly one operation. `open-admission` also lists `close`,
// and that entry is recovery-only: the driver may issue it solely on its
// failed-window path, to restore the tuple a failure would otherwise leave open.
// No operator input can request it, and it is the same pinned close task
// `close-admission` runs. Every other entry listing `open`, or listing a
// payload-bearing action other than `configure-testers` and `open`, would be a
// new admission direction that this table is the place to review.
export const lifecycleActions = operation => ({ start: ['close'], stop: ['close', 'drain'],
  'tester-status': ['status'], 'tester-add': ['configure-testers'], 'tester-replace': ['configure-testers'],
  'close-admission': ['close', 'status'], 'open-admission': ['open', 'status', 'close'] }[operation] ?? []);
const payloadActions = ['configure-testers', 'open'];
// Only `open-admission` may send a lifecycle `open` payload, and it must be the
// exact byte string the driver builds from the reviewed dispatch input. The
// builder is shared with the driver, so a payload and its check cannot drift.
function assertAdmissionWindowPayload(env, payload) {
  if (env.INFRA_OPERATION !== 'open-admission') throw new Error('Lifecycle open is reserved to open-admission');
  if (payload === undefined) throw new Error('Lifecycle open requires the bounded window payload');
  let expected;
  try { expected = admissionWindowPayload(env); }
  catch (error) { throw new Error('Lifecycle open requires an in-range window_minutes dispatch input', { cause: error }); }
  if (payload !== expected) throw new Error('Lifecycle open payload differs from the dispatch input');
}
export function assertOneShotAllowed(env, role, action = '', payload) {
  operationBoundary(env);
  if (!oneShotRoles(env.INFRA_OPERATION).includes(role)
    || role === 'lifecycle' && !lifecycleActions(env.INFRA_OPERATION).includes(action)
    || role !== 'lifecycle' && payload !== undefined
    || role === 'lifecycle' && !payloadActions.includes(action) && payload !== undefined) throw new Error('One-shot role/action is forbidden for this operation');
  if (role === 'lifecycle' && action === 'configure-testers') {
    if (payload !== normalizeTesterEmails(payload)) throw new Error('Tester helper requires canonical normalized payload');
    if (env.INFRA_OPERATION === 'tester-replace' && payload !== normalizeTesterEmails(env.TESTER_EMAILS)) throw new Error('Tester replacement differs from explicit dispatch input');
    if (parseJson(normalizeTesterEmails(env.TESTER_EMAILS)).some(email => !parseJson(payload).includes(email))) throw new Error('Tester addition omits explicit dispatch input');
  }
  if (role === 'lifecycle' && action === 'open') assertAdmissionWindowPayload(env, payload);
}
export function assertDeployAllowed(env, stack) {
  operationBoundary(env);
  if (!changedStackNames(env.INFRA_OPERATION).includes(stack)) throw new Error('Stack deployment is forbidden for this operation');
}
export function families(env, purpose) {
  const boundary = operationBoundary(env);
  if (purpose === 'qualification') {
    if (boundary.readOnly) throw new Error('Read-only observation cannot qualify with tasks');
    return ['artifact-verify'];
  }
  if (purpose !== 'operation') throw new Error('Unknown credential purpose');
  return boundary.readOnly ? [] : [...operationEvidence[env.INFRA_OPERATION].roles];
}
export function assertAwsAllowed(env, args, purpose = 'operation') {
  const boundary = operationBoundary(env);
  const key = `${args[0]}/${args[1]}`;
  const argument = flag => args[args.indexOf(flag) + 1];
  if (args.includes('--with-decryption')) throw new Error('Runtime parameter decryption is forbidden');
  if (cleanupFenceRequired(env, purpose)
    && (key === 'stepfunctions/list-executions' && argument('--state-machine-arn') === cleanupMachineArn
      || key === 'stepfunctions/describe-execution'
      && new RegExp(`^${cleanupExecutionArn}[A-Za-z0-9_-]{1,80}$`).test(argument('--execution-arn') ?? ''))) return;
  if (reads[key] && (!boundary.readOnly || stateReads.includes(key))) return;
  if (args[0] === 'ecs' && args[1] === 'wait') {
    const allowed = args[2] === 'tasks-stopped' || !boundary.readOnly && args[2] === 'services-stable';
    if (!boundary.readOnly && allowed) return;
  }
  const allowedFamilies = families(env, purpose);
  if (args[0] === 'ecs' && args[1] === 'register-task-definition') {
    const definition = parseJson(argument('--cli-input-json'));
    const family = allowedFamilies.find(family => definition.family === `beta-anywear-${family}`);
    const role = family === 'migrate' ? 'migration' : family === 'lifecycle' ? 'lifecycle' : 'verification';
    const container = definition.containerDefinitions?.find(row => row.name === 'OneShot');
    const command = container?.command;
    if (family && definition.taskRoleArn === `arn:aws:iam::650880818323:role/beta-anywear-${role}-task`
      && definition.executionRoleArn === 'arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution'
      && command?.[0] === 'node') {
      if (family === 'artifact-verify' && command[1] === '-e' && command.length === 3
        && command[2] === runtimeCommandBytes().toString('utf8')) return;
      if (family === 'lifecycle' && command[1] === 'dist/ops/beta-lifecycle.js' && [3, 4].includes(command.length)) {
        assertOneShotAllowed(env, 'lifecycle', command[2], command[3]); return;
      }
      if (['migrate', 'verify'].includes(family) && command[1] === `dist/${family}.js` && command.length === 2) return;
    }
  }
  if (args[0] === 'ecs' && ['run-task', 'deregister-task-definition'].includes(args[1])) {
    const definition = argument('--task-definition');
    if (allowedFamilies.some(family => new RegExp(`^arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-${family}:[1-9][0-9]*$`).test(definition ?? ''))) return;
  }
  if (key === 'logs/put-retention-policy' && purpose === 'operation'
    && changedStackNames(env.INFRA_OPERATION).includes('AnyWearPlatformStack-beta')) return;
  throw new Error(`AWS action ${key} is forbidden for this operation`);
}

const arn = (service, suffix, region = 'ap-east-1') => `arn:aws:${service}:${region}:650880818323:${suffix}`;
export function sessionPolicy(kind, env, purpose = 'operation') {
  const boundary = operationBoundary(env);
  const statement = (Action, Resource = '*', Condition) => ({ Effect: 'Allow', Action, Resource, ...(Condition ? { Condition } : {}) });
  let statements;
  if (kind === 'deploy') {
    if (purpose !== 'operation' || !changedStackNames(env.INFRA_OPERATION).length) throw new Error('Deploy credentials are forbidden for this operation');
    const regions = env.INFRA_OPERATION === 'deploy-billing' ? ['us-east-1'] : ['ap-east-1'];
    statements = [statement(['sts:GetCallerIdentity', 'cloudformation:DescribeStacks', 'ssm:GetParameter', 'ec2:DescribeManagedPrefixLists']),
      statement('sts:AssumeRole', regions.flatMap(region => ['deploy', 'file-publishing', 'lookup'].map(role =>
        `arn:aws:iam::650880818323:role/cdk-hnb659fds-${role}-role-650880818323-${region}`))),
      statement('secretsmanager:GetSecretValue', arn('secretsmanager', 'secret:/anywear/beta/cloudfront_origin_header-*'))];
  } else if (kind === 'runtime') {
    const allowedFamilies = families(env, purpose);
    statements = [statement((boundary.readOnly ? stateReads : Object.keys(reads)).map(key => reads[key]))];
    if (cleanupFenceRequired(env, purpose)) {
      statements.push(statement('states:ListExecutions', cleanupMachineArn),
        statement('states:DescribeExecution', `${cleanupExecutionArn}*`));
    }
    if (allowedFamilies.length) {
      const definitions = allowedFamilies.map(family => arn('ecs', `task-definition/beta-anywear-${family}:*`));
      statements.push(statement(['ecs:RegisterTaskDefinition', 'ecs:RunTask'], definitions),
        statement('ecs:DeregisterTaskDefinition'),
        statement('iam:PassRole', [...new Set(allowedFamilies.map(family => family === 'migrate' ? 'migration' : family === 'lifecycle' ? 'lifecycle' : 'verification'))]
          .map(role => `arn:aws:iam::650880818323:role/beta-anywear-${role}-task`)
          .concat('arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution'),
        { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } }));
    }
    if (purpose === 'operation' && changedStackNames(env.INFRA_OPERATION).includes('AnyWearPlatformStack-beta')) {
      statements.push(statement('logs:PutRetentionPolicy', ['beta-anywear-pre-sign-up', 'beta-anywear-post-confirmation-sync', 'AnyWearPlatformStack-beta-*']
        .map(name => arn('logs', `log-group:/aws/lambda/${name}:*`))));
    }
  } else throw new Error('Unknown dedicated role');
  const policy = JSON.stringify({ Version: '2012-10-17', Statement: statements });
  if (policy.length > 2048) throw new Error('STS session policy exceeds the inline policy limit');
  return policy;
}
