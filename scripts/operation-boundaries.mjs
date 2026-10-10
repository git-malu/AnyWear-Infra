import { parseJson } from './json-contract.mjs';
import { changedStackNames } from './operation-stacks.mjs';
import { runtimeCommandBytes } from './runtime-command.mjs';
import { normalizeTesterEmails } from './tester-allowlist.mjs';

export const workflowOperations = Object.freeze({
  '.github/workflows/runtime.yml': ['observe'],
  '.github/workflows/beta-observe.yml': ['state'],
  '.github/workflows/beta-lifecycle.yml': ['start', 'stop'],
  '.github/workflows/beta-deploy.yml': ['deploy-foundation', 'deploy-billing', 'deploy-platform', 'deploy-workload', 'restore-release'],
  '.github/workflows/beta-schema.yml': ['migrate', 'verify'],
  '.github/workflows/beta-admission.yml': ['tester-status', 'tester-add', 'tester-replace', 'close-admission'],
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
const taskRoles = operation => ({
  start: ['migrate', 'verify', 'lifecycle'], stop: ['lifecycle'],
  'deploy-workload': ['verify'], 'restore-release': ['verify'],
  migrate: ['migrate'], verify: ['verify'],
  'tester-status': ['verify', 'lifecycle'], 'tester-add': ['verify', 'lifecycle'], 'tester-replace': ['verify', 'lifecycle'],
  'close-admission': ['lifecycle'],
}[operation] ?? []);
const lifecycleActions = operation => ({ start: ['close'], stop: ['close', 'drain'],
  'tester-status': ['status'], 'tester-add': ['configure-testers'], 'tester-replace': ['configure-testers'],
  'close-admission': ['close', 'status'] }[operation] ?? []);
export function assertOneShotAllowed(env, role, action = '', payload) {
  operationBoundary(env);
  if (!taskRoles(env.INFRA_OPERATION).includes(role)
    || role === 'lifecycle' && !lifecycleActions(env.INFRA_OPERATION).includes(action)
    || role !== 'lifecycle' && payload !== undefined
    || role === 'lifecycle' && action !== 'configure-testers' && payload !== undefined) throw new Error('One-shot role/action is forbidden for this operation');
  if (role === 'lifecycle' && action === 'configure-testers') {
    if (payload !== normalizeTesterEmails(payload)) throw new Error('Tester helper requires canonical normalized payload');
    if (env.INFRA_OPERATION === 'tester-replace' && payload !== normalizeTesterEmails(env.TESTER_EMAILS)) throw new Error('Tester replacement differs from explicit dispatch input');
    if (parseJson(normalizeTesterEmails(env.TESTER_EMAILS)).some(email => !parseJson(payload).includes(email))) throw new Error('Tester addition omits explicit dispatch input');
  }
}
export function assertDeployAllowed(env, stack) {
  operationBoundary(env);
  if (!changedStackNames(env.INFRA_OPERATION).includes(stack)) throw new Error('Stack deployment is forbidden for this operation');
}
function families(env, purpose) {
  const boundary = operationBoundary(env);
  if (purpose === 'qualification') {
    if (boundary.readOnly) throw new Error('Read-only observation cannot qualify with tasks');
    return ['artifact-verify'];
  }
  if (purpose !== 'operation') throw new Error('Unknown credential purpose');
  const verifier = ['deploy-workload', 'restore-release', 'close-admission'].includes(env.INFRA_OPERATION) ? ['artifact-verify'] : [];
  return boundary.readOnly ? [] : [...new Set([...taskRoles(env.INFRA_OPERATION), ...verifier])];
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
