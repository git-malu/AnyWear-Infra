import { parseJson, canonicalJson } from './json-contract.mjs';
import { changedStackNames } from './operation-stacks.mjs';
import { normalizeTesterEmails } from './tester-allowlist.mjs';
import { INFRA_REPOSITORY, account, region } from './deployment-contract.mjs';

// One dispatch surface per deployable unit. `runtime.yml` hosts the read-only
// `state` entry and the accepted `anywear_infra_deployment` producer `observe`;
// every mutation shares `mutate.yml`, including since #195 the release slice's
// `deploy-runtime` and `stop-runtime`.
export const workflowOperations = Object.freeze({
  '.github/workflows/runtime.yml': ['state', 'observe'],
  '.github/workflows/mutate.yml': ['deploy-foundation', 'deploy-billing', 'deploy-platform',
    'deploy-egress', 'delete-egress', 'deploy-runtime', 'stop-runtime', 'restore-release', 'migrate',
    'admission-status', 'add-testers', 'set-testers', 'open-admission', 'close-admission'],
});

// A record's family is derived from the operation, not from the file that hosts
// several operations. Workflow paths were the family identity while each operation
// had its own dispatch file; keeping the operation -> family mapping preserves
// cross-repository record families, keeps `observe` as the accepted
// deployment-record producer, and keeps `state` from ever being stamped as one.
export const operationFamilies = Object.freeze({
  state: 'beta-observe',
  observe: 'runtime',
  'deploy-foundation': 'beta-deploy',
  'deploy-billing': 'beta-deploy',
  'deploy-platform': 'beta-deploy',
  'deploy-egress': 'beta-deploy',
  'delete-egress': 'beta-deploy',
  'deploy-runtime': 'beta-deploy',
  'stop-runtime': 'beta-deploy',
  'restore-release': 'beta-deploy',
  migrate: 'beta-schema',
  'admission-status': 'beta-admission',
  'add-testers': 'beta-admission',
  'set-testers': 'beta-admission',
  'open-admission': 'beta-admission',
  'close-admission': 'beta-admission',
});

// Live entries that execute verification or deployment. Every other path is a
// dispatch surface only: `check.yml` is automatic and `production.yml` is
// `workflow_call`-only.
export const qualifiedWorkflowPaths = Object.freeze(['.github/workflows/runtime.yml', '.github/workflows/mutate.yml']);

// AnyWear-E2E executes exactly one reviewed workflow. `integration.yml` was
// retired with the E2E consolidation; adding another path here would admit a
// second, unreviewed E2E producer without a reviewed executor.
export const e2eExecutorPaths = Object.freeze(['.github/workflows/beta-qualification.yml']);

// The reviewed executor/source/account/region gate shared by the observation and
// the admission/recovery drivers. It reads only repository identity and dispatch
// metadata, so it runs before any AWS call.
export function assertProtectedExecutor(infraSha, env = process.env) {
  if (typeof infraSha !== 'string' || !/^[a-f0-9]{40}$/.test(infraSha)) throw new Error('Reviewed Infra source required');
  if (typeof env.GITHUB_SHA !== 'string' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA) || env.GITHUB_REF !== 'refs/heads/main'
    || env.AWS_ACCOUNT_ID !== account || env.AWS_REGION !== region) throw new Error('Protected executor/account/region/source required');
  const paths = env.GITHUB_REPOSITORY === INFRA_REPOSITORY ? qualifiedWorkflowPaths
    : env.GITHUB_REPOSITORY === 'git-malu/AnyWear-E2E' ? e2eExecutorPaths : [];
  if (!paths.some(file => env.GITHUB_WORKFLOW_REF === `${env.GITHUB_REPOSITORY}/${file}@refs/heads/main`)) {
    throw new Error('Protected executor workflow required');
  }
  // An Infra executor must execute the reviewed revision. AnyWear-E2E executes
  // from its own pinned checkout and states the observed Infra helper revision
  // explicitly, so its run SHA is the executor identity rather than the Infra SHA.
  if (env.GITHUB_REPOSITORY === INFRA_REPOSITORY && env.GITHUB_SHA !== infraSha) {
    throw new Error('Protected executor source required');
  }
  if (!Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) || !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT))) throw new Error('Executor run identity required');
  return { repository: env.GITHUB_REPOSITORY, sha: infraSha, workflow_path: env.GITHUB_WORKFLOW_REF.split('/').slice(2).join('/').split('@')[0],
    run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT) };
}

export function operationBoundary(env) {
  const operation = env.INFRA_OPERATION;
  const workflow = Object.keys(workflowOperations).find(file => env.GITHUB_WORKFLOW_REF === `git-malu/AnyWear-Infra/${file}@refs/heads/main`);
  if (!workflow || !workflowOperations[workflow].includes(operation)) throw new Error('Operation is forbidden for this workflow family');
  return { workflow, family: operationFamilies[operation], readOnly: operation === 'state' };
}

export const reads = {
  'sts/get-caller-identity': 'sts:GetCallerIdentity',
  'cloudformation/describe-stacks': 'cloudformation:DescribeStacks',
  'cloudformation/get-template': 'cloudformation:GetTemplate',
  'cloudformation/list-stack-resources': 'cloudformation:ListStackResources',
  'ssm/get-parameter': 'ssm:GetParameter',
  'ssm/get-parameters': 'ssm:GetParameters',
  'ecs/describe-services': 'ecs:DescribeServices', 'ecs/describe-tasks': 'ecs:DescribeTasks',
  'ecs/describe-task-definition': 'ecs:DescribeTaskDefinition', 'ecs/list-tasks': 'ecs:ListTasks',
  'ecr/describe-images': 'ecr:DescribeImages', 'ecr/batch-get-image': 'ecr:BatchGetImage',
  'lambda/get-function': 'lambda:GetFunction', 'sqs/get-queue-attributes': 'sqs:GetQueueAttributes',
  'logs/get-log-events': 'logs:GetLogEvents', 'logs/describe-log-groups': 'logs:DescribeLogGroups',
  // Issue #195: the bake's live reads. The change-set read is deploy-session
  // only and is handled by `assertAwsAllowed`'s deploy branch, not this table.
  'cloudwatch/get-metric-statistics': 'cloudwatch:GetMetricStatistics',
  'cloudwatch/describe-alarms': 'cloudwatch:DescribeAlarms',
  'logs/filter-log-events': 'logs:FilterLogEvents',
  // The base role may deny this legacy fallback; this session never adds grants.
  'cloudfront/get-distribution': 'cloudfront:GetDistribution',
};
// Reads that only some operations perform. A read absent from this table is
// performed by every operation that uses the runtime session; a listed read is
// simulated and granted only for the operations named here. Issue #195: the
// 600-second bake runs only inside `deploy-runtime`, and two of its grants are
// installed by a Platform deploy, so requiring them from every runtime-session
// operation would leave no reviewed operation able to install them.
export const readOperations = Object.freeze({
  'cloudwatch/get-metric-statistics': Object.freeze(['deploy-runtime']),
  'cloudwatch/describe-alarms': Object.freeze(['deploy-runtime']),
  'logs/filter-log-events': Object.freeze(['deploy-runtime']),
});
// The reviewed read set the dispatched operation's runtime session performs. The
// simulation plan, the generated session policy and the AWS call allow-list all
// derive from this one function, so an operation cannot be granted a read it does
// not perform and cannot call a read another operation's session needs.
export function operationReads(env) {
  const operation = env?.INFRA_OPERATION;
  return Object.keys(reads).filter((pair) => !(pair in readOperations) || readOperations[pair].includes(operation));
}
export const stateReads = ['sts/get-caller-identity', 'cloudformation/describe-stacks', 'cloudformation/get-template', 'ssm/get-parameter'];
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
    'This run emits the accepted anywear_infra_deployment v3 record for the observed Foundation, Beta stage base and Billing. The release slice is deployed and recorded by the deploy-runtime operation.'),
  state: evidenceEntry([], 'not-applicable',
    'Read-only: the operation record carries anywear_infra_state and claims no mutation.'),
  'deploy-foundation': evidenceEntry([], '.github/workflows/runtime.yml',
    'The accepted record carries the configured stack Original template hash; this does not qualify IAM semantics.'),
  'deploy-billing': evidenceEntry([], '.github/workflows/runtime.yml',
    'The accepted record carries the billing stack Original template hash observed in us-east-1.'),
  'deploy-platform': evidenceEntry([], '.github/workflows/runtime.yml',
    'The accepted record carries the Base Original template hash and the consumed stage-contract parameter versions and value hashes.'),
  // Issue #166: the Egress stack is disposable and exists only while Beta runs.
  'deploy-egress': evidenceEntry([], '.github/workflows/runtime.yml',
    'The accepted record carries the Egress stack Original template hash after the disposable network edge is created.'),
  'delete-egress': evidenceEntry([], '.github/workflows/runtime.yml',
    'The accepted record carries the observed stack state and proves the Runtime stack was absent before the Egress delete; no deployment record is produced.'),
  // Issue #195: the operation writes the v6 `anywear_service_deployment` record
  // itself (the passed 600-second gate and the admitted schema-boundary
  // comparison), so its own mutation run qualifies it. Issue #194: the pre-mutation
  // schema-boundary gate runs one read-only `schema-journal` task from the
  // existing `verify` family, under the existing verification-task role.
  'deploy-runtime': evidenceEntry(['verify'], 'self',
    'The deploy job writes the v6 anywear_service_deployment record: the six deploy parameters, the 39 stage-contract inputs, the normalised deployed template hash, the passed 600-second gate, the v6 observed tuple and the schema_boundary comparison admitted by one read-only schema-journal verify task before any mutation.'),
  'stop-runtime': evidenceEntry([], '.github/workflows/runtime.yml',
    'The operation record carries the observed stack state and proves only AnyWearRuntimeStack-beta was destroyed; no deployment record is produced.'),
  'restore-release': evidenceEntry([], '.github/workflows/runtime.yml',
    'Restoring the Base stack leaves the Runtime stack observable by the following fixed observation; the Runtime slice is restored by the deploy-runtime operation.'),
  migrate: evidenceEntry(['migrate'], '.github/workflows/runtime.yml',
    'The operation record carries the migrate task identity and its stopped-success result on the deployed Service image.'),
  'admission-status': evidenceEntry(['lifecycle'], 'not-applicable',
    'Status only: it reads the admission mode, the record key set and the tester list, and mutates nothing.'),
  'add-testers': evidenceEntry(['lifecycle'], 'not-applicable',
    'The accepted record does not observe admission state; the operation record admission read-back evidences it. The tester write changes no admission state and cannot open admission: its recorded mode and key set are the ones observed before the write. Open admission separately with `open-admission`.'),
  'set-testers': evidenceEntry(['lifecycle'], 'not-applicable',
    'The accepted record does not observe admission state; the operation record admission read-back evidences it. The tester write changes no admission state and cannot open admission: its recorded mode and key set are the ones observed before the write. Open admission separately with `open-admission`.'),
  'close-admission': evidenceEntry(['lifecycle'], 'not-applicable',
    'The accepted record does not observe admission state; the operation record lifecycle status and admission read-back evidence it. It closes admission through the pinned lifecycle `suspend` and records whether it ended an open admission (`ordinary`) or one already closed (`already-closed`).'),
  'open-admission': evidenceEntry(['lifecycle'], 'not-applicable',
    'The accepted record does not observe admission state; the operation record carries `admission-open-proof`: the mode, its source, the tester count and hash, the no-bound evidence (the SSM record key set and the absence of the database status window field) and SSM/DB agreement. There is no automatic closure: an interrupted open leaves admission open until an explicit `close-admission` and an `admission-status` read-back.'),
});
const oneShotRoles = operation => operationEvidence[operation].roles;
// The task role each one-shot family registers under. `verify` keeps the existing
// verification-task role (#194): the schema-journal read adds no role, task
// family, log group or IAM statement.
const ONE_SHOT_TASK_ROLES = Object.freeze({
  migrate: 'migration', lifecycle: 'lifecycle', verify: 'verification',
});
const oneShotTaskRole = family => ONE_SHOT_TASK_ROLES[family];
// The only non-URL verify action: one read-only journal read.
const VERIFY_SCHEMA_JOURNAL_COMMAND = Object.freeze(['node', 'dist/verify.js', 'schema-journal']);
// `resume` appears for exactly one operation. `open-admission` also lists
// `suspend`, and that entry is recovery-only: the driver may issue it solely on
// its failed-open path, to close what a failure would otherwise leave open. No
// operator input can request it, and it is the same pinned suspend task
// `close-admission` runs. Only `set-testers` carries a payload: `resume` takes
// none, because there is no bound to write. Any other entry listing `resume`, or
// listing any other payload-bearing action, would be a new admission direction
// that this table is the place to review.
export const lifecycleActions = operation => ({ 'admission-status': ['status'], 'add-testers': ['set-testers', 'status'],
  'set-testers': ['set-testers', 'status'], 'close-admission': ['suspend', 'status'],
  'open-admission': ['resume', 'status', 'suspend'] }[operation] ?? []);
// Issue #194: the `verify` family's only non-URL action is the read-only
// `schema-journal` read. It takes no payload; any other action is refused.
export const verifyActions = operation => ({ 'deploy-runtime': ['schema-journal'] }[operation] ?? []);
const payloadActions = ['set-testers'];
export function assertOneShotAllowed(env, role, action = '', payload) {
  operationBoundary(env);
  if (role === 'lifecycle' && action === 'resume' && payload !== undefined) throw new Error('Lifecycle resume takes no payload');
  if (!oneShotRoles(env.INFRA_OPERATION).includes(role)
    || role === 'lifecycle' && !lifecycleActions(env.INFRA_OPERATION).includes(action)
    || role === 'verify' && (!verifyActions(env.INFRA_OPERATION).includes(action) || payload !== undefined)
    || role !== 'lifecycle' && payload !== undefined
    || role === 'lifecycle' && !payloadActions.includes(action) && payload !== undefined) throw new Error('One-shot role/action is forbidden for this operation');
  if (role === 'lifecycle' && action === 'set-testers') {
    if (payload !== normalizeTesterEmails(payload)) throw new Error('Tester helper requires canonical normalized payload');
    if (env.INFRA_OPERATION === 'set-testers' && payload !== normalizeTesterEmails(env.TESTER_EMAILS)) throw new Error('Tester replacement differs from explicit dispatch input');
    if (parseJson(normalizeTesterEmails(env.TESTER_EMAILS)).some(email => !parseJson(payload).includes(email))) throw new Error('Tester addition omits explicit dispatch input');
  }
}
export function assertDeployAllowed(env, stack) {
  operationBoundary(env);
  if (!changedStackNames(env.INFRA_OPERATION).includes(stack)) throw new Error('Stack deployment is forbidden for this operation');
}
export function families(env, purpose) {
  const boundary = operationBoundary(env);
  if (purpose === 'qualification') {
    if (boundary.readOnly) throw new Error('Read-only observation cannot qualify with tasks');
    // Observation no longer runs a verification task: the immutable-release
    // check that produced it moved into the deployment operations that prove the
    // sealed release before any credential.
    return [];
  }
  if (purpose !== 'operation') throw new Error('Unknown credential purpose');
  return boundary.readOnly ? [] : [...operationEvidence[env.INFRA_OPERATION].roles];
}
export function assertAwsAllowed(env, args, purpose = 'operation', session = 'runtime') {
  const boundary = operationBoundary(env);
  const key = `${args[0]}/${args[1]}`;
  const argument = flag => args[args.indexOf(flag) + 1];
  if (args.includes('--with-decryption')) throw new Error('Runtime parameter decryption is forbidden');
  // The deploy session is a change-set driver only: it describes, executes or
  // deletes this run's Runtime change set and nothing else. CDK creates the
  // change set through the bootstrap deploy role, so no create action is needed
  // or granted here.
  if (session === 'deploy') {
    if (purpose === 'operation' && args[0] === 'cloudformation'
      && ['describe-change-set', 'execute-change-set', 'delete-change-set'].includes(args[1])
      && ['deploy-runtime', 'stop-runtime'].includes(env.INFRA_OPERATION)
      && argument('--stack-name') === 'AnyWearRuntimeStack-beta'
      && /^anywear-runtime-[0-9]+$/.test(argument('--change-set-name') ?? '')) return;
    throw new Error(`AWS action ${key} is forbidden for the deploy session`);
  }
  if (reads[key] && operationReads(env).includes(key) && (!boundary.readOnly || stateReads.includes(key))) return;
  if (args[0] === 'ecs' && args[1] === 'wait') {
    const allowed = args[2] === 'tasks-stopped' || !boundary.readOnly && args[2] === 'services-stable';
    if (!boundary.readOnly && allowed) return;
  }
  const allowedFamilies = families(env, purpose);
  if (args[0] === 'ecs' && args[1] === 'register-task-definition') {
    const definition = parseJson(argument('--cli-input-json'));
    const family = allowedFamilies.find(allowed => definition.family === `beta-anywear-${allowed}`);
    const role = oneShotTaskRole(family);
    const container = definition.containerDefinitions?.find(row => row.name === 'OneShot');
    const command = container?.command;
    if (family && definition.taskRoleArn === `arn:aws:iam::650880818323:role/beta-anywear-${role}-task`
      && definition.executionRoleArn === 'arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution'
      && command?.[0] === 'node') {
      if (family === 'lifecycle' && command[1] === 'dist/ops/beta-lifecycle.js' && [3, 4].includes(command.length)) {
        assertOneShotAllowed(env, 'lifecycle', command[2], command[3]); return;
      }
      if (family === 'migrate' && command[1] === 'dist/migrate.js' && command.length === 2) return;
      // Issue #194: the verify family's only accepted registration is the exact
      // schema-journal read, with no payload and no other command.
      if (family === 'verify' && canonicalJson(command) === canonicalJson(VERIFY_SCHEMA_JOURNAL_COMMAND)) {
        assertOneShotAllowed(env, 'verify', 'schema-journal'); return;
      }
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

const arn = (service, suffix, awsRegion = 'ap-east-1') => `arn:aws:${service}:${awsRegion}:650880818323:${suffix}`;
// Issue #165: the authorization preflight calls the IAM policy simulator from
// inside the restricted session; the simulator actions have no resource-level
// scope, so the generated session policy carries them on `*`.
const simulate = ['iam:SimulatePrincipalPolicy', 'iam:SimulateCustomPolicy'];
export function sessionPolicy(kind, env, purpose = 'operation') {
  const boundary = operationBoundary(env);
  const statement = (Action, Resource = '*', Condition) => ({ Effect: 'Allow', Action, Resource, ...(Condition ? { Condition } : {}) });
  let statements;
  if (kind === 'deploy') {
    if (purpose !== 'operation' || !changedStackNames(env.INFRA_OPERATION).length) throw new Error('Deploy credentials are forbidden for this operation');
    const regions = env.INFRA_OPERATION === 'deploy-billing' ? ['us-east-1'] : ['ap-east-1'];
    statements = [statement(['sts:GetCallerIdentity', 'cloudformation:DescribeStacks', 'ssm:GetParameter',
      'ec2:DescribeManagedPrefixLists', ...simulate]),
      statement('sts:AssumeRole', regions.flatMap(roleRegion => ['deploy', 'file-publishing', 'lookup'].map(role =>
        `arn:aws:iam::650880818323:role/cdk-hnb659fds-${role}-role-650880818323-${roleRegion}`))),
      statement('secretsmanager:GetSecretValue', arn('secretsmanager', 'secret:/anywear/beta/cloudfront_origin_header-*'))];
    // Issue #195: the deploy-runtime session describes the change set it created
    // and executes or deletes it. The statement is scoped to the Runtime stack
    // and its change-set collection; no create action is needed because the CDK
    // CLI creates the change set through the bootstrap deploy role.
    if (env.INFRA_OPERATION === 'deploy-runtime') {
      statements.push(statement(['cloudformation:DescribeChangeSet', 'cloudformation:ExecuteChangeSet',
        'cloudformation:DeleteChangeSet'],
      [arn('cloudformation', 'stack/AnyWearRuntimeStack-beta/*'), arn('cloudformation', 'changeSet/*')]));
    }
  } else if (kind === 'runtime') {
    const allowedFamilies = families(env, purpose);
    statements = [statement((boundary.readOnly ? stateReads : operationReads(env)).map(read => reads[read])
      .concat(boundary.readOnly ? [] : simulate))];
    if (allowedFamilies.length) {
      const definitions = allowedFamilies.map(family => arn('ecs', `task-definition/beta-anywear-${family}:*`));
      statements.push(statement(['ecs:RegisterTaskDefinition', 'ecs:RunTask'], definitions),
        statement('ecs:DeregisterTaskDefinition'),
        statement('iam:PassRole', [...new Set(allowedFamilies.map(oneShotTaskRole))]
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
