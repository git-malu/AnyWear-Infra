import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { reads as sessionReads } from './operation-boundaries.mjs';

// One derived authorization surface for issue #165 (D1). The declared contract
// test, the pre-mutation canary and the CloudTrail reconciliation all read this
// module; none derives its own set. Source sites are derived from the code, the
// action and resource-form mappings are reviewed tables, and every count below
// is pinned by a test that fails when a site is added or removed without review.

export const INVENTORY_VERSION = 1;
export const ACCOUNT = '650880818323';
export const REGION = 'ap-east-1';
export const BILLING_REGION = 'us-east-1';
export const BASE_STACK = 'AnyWearPlatformStack-beta';

// The four credential positions a call site can execute under. Two of them have
// no `io.aws` site of their own today: the deploy session is exercised by the CDK
// CLI, and the credential-free observation path makes no AWS call. They stay in
// the model because a site added to either path must be attributed, not skipped.
export const CREDENTIAL_PATHS = Object.freeze({
  'deploy-session': 'Restricted beta-infra-deploy-role session; the CDK CLI performs its own reads after the session is assumed.',
  'runtime-session': 'Restricted beta-infra-runtime-role session created by createRuntimeIo and the one-shot shell hook.',
  'credential-free-observation': 'A job that holds no AWS credential; it validates records produced by a credentialed job.',
  'operator-cli': 'A direct AWS CLI caller using the operator or E2E credential (liveObservationIo / ecr-retention CLI).',
});

// The `io.aws` call sites are derived from source; the only dynamic sites are the
// two forwarders enumerated here. A dynamic site in a file without a resolver
// fails closed instead of being skipped.
const DYNAMIC_FORWARDERS = Object.freeze([
  Object.freeze({
    file: '.github/scripts/beta-platform-log-retention.mjs',
    function: 'pages',
    reason: 'Pagination wrapper: every call site supplies the literal operation as its second argument.',
    resolve: (source) => [...source.matchAll(/pages\(io,\s*\[\s*'([a-z0-9-]+)'\s*,\s*'([a-z0-9-]+)'/g)]
      .map((match) => `${match[1]}/${match[2]}`),
  }),
  Object.freeze({
    file: 'scripts/lifecycle-status.mjs',
    function: 'readLifecycleStatus pagination loop',
    reason: 'The operation is built once into a local `args` array and only the pagination token varies.',
    resolve: (source) => {
      const match = /const args = \[\s*'([a-z0-9-]+)'\s*,\s*'([a-z0-9-]+)'/.exec(source);
      return match ? [`${match[1]}/${match[2]}`] : [];
    },
  }),
]);

// File -> credential path. Every file that contains an `io.aws` site must be
// listed; a new file fails closed. `observe-deployment.mjs` runs both inside the
// workflow's runtime session and as the operator/E2E CLI over liveObservationIo;
// its reviewed executor path is the runtime session, and the CLI is recorded for
// the reconciliation's credential scope.
const CREDENTIAL_PATH_BY_FILE = Object.freeze({
  'scripts/admission-mode.mjs': 'runtime-session',
  'scripts/admission-state.mjs': 'runtime-session',
  'scripts/ecr-retention.mjs': 'operator-cli',
  'scripts/lifecycle-status.mjs': 'runtime-session',
  'scripts/observe-deployment.mjs': 'runtime-session',
  'scripts/one-writer.mjs': 'runtime-session',
  'scripts/restore-release.mjs': 'runtime-session',
  'scripts/runtime-operation.mjs': 'runtime-session',
  'scripts/stage-contract-parameters.mjs': 'runtime-session',
  'scripts/tester-allowlist.mjs': 'runtime-session',
  '.github/scripts/beta-platform-log-retention.mjs': 'runtime-session',
});

const OPERATOR_CLI_ALSO = Object.freeze({
  'scripts/observe-deployment.mjs': 'Also executed by scripts/observe-deployment.mjs --expected ... (liveObservationIo) under the operator/E2E credential.',
});

// The pinned derived counts at the #166 post-migration base (9382e40). Restating
// them here is the reviewable statement; the test re-derives and compares.
export const PINNED_SURFACE = Object.freeze({
  io_aws_sites: 31,
  script_sites: 26,
  github_script_sites: 5,
  literal_pairs: 16,
  forwarded_pairs: 3,
  distinct_io_aws_pairs: 19,
  shell_sites: 5,
  total_call_sites: 36,
  total_distinct_pairs: 21,
});

// Reviewed mapping from the CLI operation to the IAM actions the API actually
// authorizes. This is not one-to-one: a CLI command can require several actions,
// and a wait is not an action at all. An unknown operation fails closed.
export const IAM_ACTIONS = Object.freeze({
  'sts/get-caller-identity': ['sts:GetCallerIdentity'],
  'cloudformation/describe-stacks': ['cloudformation:DescribeStacks'],
  'cloudformation/get-template': ['cloudformation:GetTemplate'],
  'cloudformation/list-stack-resources': ['cloudformation:ListStackResources'],
  'ssm/get-parameter': ['ssm:GetParameter'],
  'ssm/get-parameters': ['ssm:GetParameters'],
  'ecs/describe-services': ['ecs:DescribeServices'],
  'ecs/describe-tasks': ['ecs:DescribeTasks'],
  'ecs/describe-task-definition': ['ecs:DescribeTaskDefinition'],
  'ecs/list-tasks': ['ecs:ListTasks'],
  // `ecs wait` is not an IAM action: each waiter polls the matching describe call.
  'ecs/wait': ['ecs:DescribeTasks', 'ecs:DescribeServices'],
  'ecs/register-task-definition': ['ecs:RegisterTaskDefinition', 'ecs:TagResource', 'iam:PassRole'],
  'ecs/run-task': ['ecs:RunTask', 'iam:PassRole'],
  'ecr/describe-images': ['ecr:DescribeImages'],
  // Reviewed though currently unused by an Infra call site: batch-get-image also
  // authorizes the two layer actions. Kept so a future call site does not invent
  // a mapping without review.
  'ecr/batch-get-image': ['ecr:BatchGetImage', 'ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer'],
  'ecr/get-lifecycle-policy': ['ecr:GetLifecyclePolicy'],
  'ecr/start-lifecycle-policy-preview': ['ecr:StartLifecyclePolicyPreview'],
  'ecr/get-lifecycle-policy-preview': ['ecr:GetLifecyclePolicyPreview'],
  'logs/get-log-events': ['logs:GetLogEvents'],
  'logs/describe-log-groups': ['logs:DescribeLogGroups'],
  'logs/put-retention-policy': ['logs:PutRetentionPolicy'],
  // The observed layer's own CloudTrail read. It runs under the restricted
  // runtime session (D2 marker excluded from the reconciled event set).
  'cloudtrail/lookup-events': ['cloudtrail:LookupEvents'],
  'lambda/get-function': ['lambda:GetFunction'],
  'sqs/get-queue-attributes': ['sqs:GetQueueAttributes'],
  'cloudfront/get-distribution': ['cloudfront:GetDistribution'],
});
// Reviewed operations that no Infra call site derives: the session-policy-only
// reads (ecs DescribeServices/ListTasks, ecr batch-get-image) and the observed
// layer's own CloudTrail read. Their mappings are still reviewed, and the
// asserted principals still prove they are granted.
export const NON_DERIVED_REVIEWED_OPERATIONS = Object.freeze(['ecr/batch-get-image', 'ecs/describe-services',
  'ecs/list-tasks', 'cloudtrail/lookup-events']);
// Mappings that no asserted principal requires today. Kept reviewed so a future
// call site cannot invent a mapping without review.
export const UNUSED_REVIEWED_OPERATIONS = Object.freeze(['ecr/batch-get-image']);

const arn = (service, resource, region = REGION) => `arn:aws:${service}:${region}:${ACCOUNT}:${resource}`;
const iamArn = (resource) => `arn:aws:iam::${ACCOUNT}:${resource}`;
const stackArn = (name, region = REGION) => arn('cloudformation', `stack/${name}/*`, region);
const lambdaLogGroup = (name) => arn('logs', `log-group:/aws/lambda/${name}:*`);

export const STACK_ARNS = Object.freeze([
  stackArn('AnyWearFoundationStack'),
  stackArn('AnyWearPlatformStack-beta'),
  stackArn('AnyWearBillingStack-beta', BILLING_REGION),
  stackArn('AnyWearRuntimeStack-beta'),
  stackArn('AnyWearWorkloadStack-beta'),
]);
const ONE_SHOT_FAMILIES = Object.freeze(['migrate', 'verify', 'lifecycle', 'artifact-verify']);
const ONE_SHOT_DEFINITIONS = Object.freeze(ONE_SHOT_FAMILIES
  .map((family) => arn('ecs', `task-definition/beta-anywear-${family}:*`)));
const ONE_SHOT_ROLES = Object.freeze([
  iamArn('role/beta-anywear-migration-task'),
  iamArn('role/beta-anywear-verification-task'),
  iamArn('role/beta-anywear-lifecycle-task'),
  iamArn('role/beta-anywear-one-shot-execution'),
]);
const ECS_SERVICES = Object.freeze(['beta-anywear-api', 'beta-anywear-worker']
  .map((name) => arn('ecs', `service/beta-anywear/${name}`)));
const BASE_QUEUES = Object.freeze(['beta-anywear-vto', 'beta-anywear-vto-dlq',
  'beta-anywear-auto-tagging', 'beta-anywear-auto-tagging-dlq'].map((name) => arn('sqs', name)));
const BETA_FUNCTIONS = Object.freeze(['beta-anywear-pre-sign-up', 'beta-anywear-post-confirmation-sync']
  .map((name) => `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}`));

// The ARN form each action is evaluated on, calibrated from the CloudTrail
// `resources[].ARN` records rather than from memory. Two forms are deliberately
// literal rather than wildcard:
// - logs:DescribeLogGroups is evaluated in its list form with an empty log-group
//   name, so a named log-group grant can never match it; only `*` matches.
// - cloudformation stack reads carry the generated stack UUID, represented by
//   the trailing `*` the grant must cover.
export const RESOURCE_FORMS = Object.freeze({
  'sts:GetCallerIdentity': Object.freeze([]),
  'cloudformation:DescribeStacks': STACK_ARNS,
  // The template is read for the configured manifest stacks (Foundation, Base,
  // Billing) and for the Base distribution origin; not for the transitional
  // Workload stack, which is read with DescribeStacks only.
  'cloudformation:GetTemplate': Object.freeze([STACK_ARNS[0], STACK_ARNS[1], STACK_ARNS[2]]),
  // Only the log-retention preflight lists a stack's resources, and only for the
  // Base stack (beta-platform-log-retention.mjs).
  'cloudformation:ListStackResources': Object.freeze([STACK_ARNS[1]]),
  'ssm:GetParameter': Object.freeze([arn('ssm', 'parameter/anywear/beta/*')]),
  'ssm:GetParameters': Object.freeze([arn('ssm', 'parameter/anywear/beta/*')]),
  'ecs:DescribeServices': ECS_SERVICES,
  'ecs:DescribeTasks': Object.freeze([arn('ecs', 'task/beta-anywear/*')]),
  'ecs:ListTasks': Object.freeze(['*']),
  'ecs:DescribeTaskDefinition': Object.freeze(['*']),
  'ecs:RegisterTaskDefinition': ONE_SHOT_DEFINITIONS,
  'ecs:TagResource': ONE_SHOT_DEFINITIONS,
  'ecs:RunTask': ONE_SHOT_DEFINITIONS,
  'iam:PassRole': ONE_SHOT_ROLES,
  'logs:GetLogEvents': Object.freeze([
    arn('logs', 'log-group:/anywear/beta/one-shot:log-stream:beta-anywear-lifecycle/OneShot/*'),
  ]),
  // The API-evaluated list form: empty log-group name, empty log-stream name.
  'logs:DescribeLogGroups': Object.freeze([arn('logs', 'log-group::log-stream:')]),
  'logs:PutRetentionPolicy': Object.freeze(['beta-anywear-pre-sign-up', 'beta-anywear-post-confirmation-sync',
    'AnyWearPlatformStack-beta-*'].map(lambdaLogGroup)),
  'cloudtrail:LookupEvents': Object.freeze(['*']),
  'lambda:GetFunction': BETA_FUNCTIONS,
  'sqs:GetQueueAttributes': BASE_QUEUES,
  'ecr:GetLifecyclePolicy': Object.freeze([arn('ecr', 'repository/beta-anywear-service')]),
  'ecr:StartLifecyclePolicyPreview': Object.freeze([arn('ecr', 'repository/beta-anywear-service')]),
  'ecr:GetLifecyclePolicyPreview': Object.freeze([arn('ecr', 'repository/beta-anywear-service')]),
  'ecr:DescribeImages': Object.freeze([arn('ecr', 'repository/beta-anywear-service')]),
});

// The runtime role's required action set is derived from the operation-to-action
// table, minus the reviewed-but-unused mapping and the one conditional legacy
// fallback (cloudfront:GetDistribution), whose base-role denial is documented and
// is not a canary probe.
export const CONDITIONAL_READ_ACTIONS = Object.freeze(['cloudfront:GetDistribution']);
export const RUNTIME_REQUIRED_ACTIONS = Object.freeze([...new Set(Object.entries(IAM_ACTIONS)
  .filter(([pair]) => !UNUSED_REVIEWED_OPERATIONS.includes(pair))
  .flatMap(([, actions]) => actions))]
  .filter((action) => !CONDITIONAL_READ_ACTIONS.includes(action)));

// Reviewed wildcard grants. Each entry is one action evaluated against `*`, with
// the reason the API cannot scope it. A `*` grant whose action is absent here
// fails the contract test, so a new wildcard cannot be added silently.
export const REVIEWED_WILDCARDS = Object.freeze({
  'beta-service-deploy-role': Object.freeze([
    Object.freeze({ action: 'cloudwatch:GetMetricStatistics', reason: 'CloudWatch metrics have no resource scope; the grant is region-conditioned in the template.' }),
  ]),
  'beta-service-deploy-cfn-role': Object.freeze([
    Object.freeze({ action: 'logs:DescribeLogGroups', reason: 'IAM evaluates the list form against log-group::log-stream:, which no named log-group ARN can match (foundation-stack.ts DescribeWorkloadLogGroups).' }),
    Object.freeze({ action: 'ecs:DeregisterTaskDefinition', reason: 'ECS evaluates deregistration against *; the rollback/deletion path needs it (foundation-stack.ts DeregisterTaskDefinitionAnyResource).' }),
    Object.freeze({ action: 'states:CreateStateMachine', reason: 'Step Functions has no resource type for CreateStateMachine in its service authorization table.' }),
    Object.freeze({ action: 'elasticloadbalancing:DescribeLoadBalancers', reason: 'ELBv2 read actions have no resource-level scope in IAM.' }),
    Object.freeze({ action: 'elasticloadbalancing:DescribeLoadBalancerAttributes', reason: 'ELBv2 read actions have no resource-level scope in IAM.' }),
    Object.freeze({ action: 'elasticloadbalancing:DescribeTargetGroups', reason: 'ELBv2 read actions have no resource-level scope in IAM.' }),
    Object.freeze({ action: 'elasticloadbalancing:DescribeTargetGroupAttributes', reason: 'ELBv2 read actions have no resource-level scope in IAM.' }),
    Object.freeze({ action: 'elasticloadbalancing:DescribeListeners', reason: 'ELBv2 read actions have no resource-level scope in IAM.' }),
    Object.freeze({ action: 'elasticloadbalancing:DescribeRules', reason: 'ELBv2 read actions have no resource-level scope in IAM.' }),
  ]),
  'beta-infra-runtime-role': Object.freeze([
    Object.freeze({ action: 'ecs:ListTasks', reason: 'ECS ListTasks has no resource type; the base grant is cluster-conditioned (beta-role-grants.ts describeRuntime).' }),
    Object.freeze({ action: 'ecs:DescribeTaskDefinition', reason: 'ECS DescribeTaskDefinition has no resource type; the base grant is region-conditioned (beta-role-grants.ts describeRuntime).' }),
    Object.freeze({ action: 'ecs:DeregisterTaskDefinition', reason: 'ECS evaluates deregistration against * (beta-role-grants.ts oneShots).' }),
    Object.freeze({ action: 'logs:DescribeLogGroups', reason: 'The list form evaluates against log-group::log-stream:, which no named log-group ARN can match (beta-role-grants.ts).' }),
    Object.freeze({ action: 'cloudwatch:GetMetricStatistics', reason: 'CloudWatch metrics have no resource scope; the grant is region-conditioned.' }),
    Object.freeze({ action: 'rds:DescribeDBClusters', reason: 'RDS read actions have no resource-level scope; the grant is region-conditioned.' }),
    Object.freeze({ action: 'rds:DescribeEvents', reason: 'RDS read actions have no resource-level scope; the grant is region-conditioned.' }),
    Object.freeze({ action: 'cloudtrail:LookupEvents', reason: 'CloudTrail LookupEvents has no resource-level scope; it is the observed layer reading the account event history.' }),
  ]),
});

// Reviewed resource families per principal: every granted resource must be one of
// these forms (or a reviewed `*` wildcard above). A broader grant than a family
// fails the containment check.
export const REVIEWED_RESOURCE_FAMILIES = Object.freeze({
  'beta-service-deploy-role': Object.freeze([
    stackArn('AnyWearRuntimeStack-beta'),
    arn('cloudformation', 'changeSet/*'),
    stackArn('AnyWearPlatformStack-beta'),
    iamArn('role/beta-service-deploy-cfn-role'),
    arn('ssm', 'parameter/anywear/beta/*'),
    arn('ssm', 'parameter/cdk-bootstrap/hnb659fds/version'),
    arn('ecr', 'repository/beta-anywear-service'),
    'arn:aws:s3:::cdk-hnb659fds-assets-650880818323-ap-east-1/*',
    'arn:aws:s3:::cdk-hnb659fds-assets-650880818323-ap-east-1',
    arn('cloudwatch', 'alarm:beta-anywear-*'),
    ...ECS_SERVICES,
    arn('sqs', 'beta-anywear-*'),
    arn('logs', 'log-group:/anywear/beta/worker'),
    arn('logs', 'log-group:/anywear/beta/worker:*'),
  ]),
  'beta-service-deploy-cfn-role': Object.freeze([
    ...['api', 'worker', 'cleanup', 'cleanup-verify'].map((family) => arn('ecs', `task-definition/beta-anywear-${family}:*`)),
    ...ECS_SERVICES,
    arn('application-autoscaling', 'scalable-target/*'),
    arn('application-autoscaling', 'scaling-policy/*'),
    stackArn('AnyWearPlatformStack-beta'),
    arn('elasticloadbalancing', 'loadbalancer/app/beta-anywear-api/*'),
    arn('elasticloadbalancing', 'targetgroup/beta-anywear-api/*'),
    arn('elasticloadbalancing', 'listener/app/beta-anywear-api/*'),
    arn('elasticloadbalancing', 'listener-rule/app/beta-anywear-api/*'),
    'arn:aws:cloudfront::650880818323:distribution/*',
    'arn:aws:cloudfront::650880818323:function/*',
    arn('cloudwatch', 'alarm:beta-anywear-*'),
    arn('cloudwatch', 'alarm:AnyWearRuntimeStack-beta-*'),
    arn('logs', 'log-group:/anywear/beta/api'),
    arn('logs', 'log-group:/anywear/beta/worker'),
    arn('states', 'stateMachine:beta-anywear-tester-cleanup'),
    iamArn('role/beta-anywear-api-task'),
    iamArn('role/beta-anywear-api-execution'),
    iamArn('role/beta-anywear-worker-task'),
    iamArn('role/beta-anywear-worker-execution'),
    iamArn('role/beta-anywear-tester-cleanup-operation'),
    iamArn('role/beta-anywear-tester-cleanup-task'),
    iamArn('role/beta-anywear-verification-task'),
    iamArn('role/beta-anywear-one-shot-execution'),
    iamArn('role/beta-e2e-qualification-role'),
    iamArn('role/beta-infra-runtime-role'),
    'arn:aws:s3:::anywearruntimestack-beta-*',
    arn('ec2', 'security-group/*'),
    arn('ssm', 'parameter/anywear/beta/*'),
    arn('ssm', 'parameter/cdk-bootstrap/hnb659fds/version'),
    arn('secretsmanager', 'secret:/anywear/beta/cloudfront_origin_header-*'),
  ]),
  'beta-infra-runtime-role': Object.freeze([
    ...STACK_ARNS,
    arn('ssm', 'parameter/anywear/beta/*'),
    ...ECS_SERVICES,
    arn('ecs', 'task/beta-anywear/*'),
    ...ONE_SHOT_DEFINITIONS,
    ...ONE_SHOT_ROLES,
    arn('ecr', 'repository/beta-anywear-service'),
    ...BETA_FUNCTIONS,
    `arn:aws:lambda:${REGION}:${ACCOUNT}:function:AnyWearPlatformStack-beta-*`,
    ...BASE_QUEUES,
    arn('logs', 'log-group:/anywear/beta/one-shot:log-stream:beta-anywear-*/OneShot/*'),
    ...['beta-anywear-pre-sign-up', 'beta-anywear-post-confirmation-sync', 'AnyWearPlatformStack-beta-*'].map(lambdaLogGroup),
  ]),
});

// Reviewed granted-action sets per principal (direction two of the contract). A
// grant outside its principal's set fails even when direction one still passes.
export const REVIEWED_GRANTED_ACTIONS = Object.freeze({
  'beta-service-deploy-role': Object.freeze(['cloudformation:*', 'cloudformation:CreateChangeSet',
    'cloudformation:DeleteChangeSet', 'cloudformation:DescribeChangeSet', 'cloudformation:DescribeStacks',
    'cloudwatch:DescribeAlarms', 'cloudwatch:GetMetricStatistics', 'ecr:DescribeImages', 'ecs:DescribeServices',
    'iam:PassRole', 'logs:FilterLogEvents', 's3:GetBucketLocation', 's3:GetObject', 's3:ListBucket',
    's3:PutObject', 'sqs:GetQueueAttributes', 'ssm:GetParameter', 'ssm:GetParameters',
    'ssm:GetParametersByPath']),
  'beta-service-deploy-cfn-role': Object.freeze([
    'application-autoscaling:DeleteScalingPolicy', 'application-autoscaling:DeregisterScalableTarget',
    'application-autoscaling:DescribeScalableTargets', 'application-autoscaling:DescribeScalingPolicies',
    'application-autoscaling:PutScalingPolicy', 'application-autoscaling:RegisterScalableTarget',
    'cloudformation:DescribeStacks', 'cloudfront:CreateDistribution', 'cloudfront:CreateFunction',
    'cloudfront:DeleteDistribution', 'cloudfront:DeleteFunction', 'cloudfront:DescribeFunction',
    'cloudfront:GetDistribution', 'cloudfront:GetDistributionConfig', 'cloudfront:GetFunction',
    'cloudfront:PublishFunction', 'cloudfront:UpdateDistribution', 'cloudfront:UpdateFunction',
    'cloudwatch:DeleteAlarms', 'cloudwatch:DescribeAlarms', 'cloudwatch:PutMetricAlarm',
    'ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress', 'ecs:CreateService',
    'ecs:DeleteService', 'ecs:DeregisterTaskDefinition', 'ecs:DescribeServices', 'ecs:DescribeTaskDefinition',
    'ecs:RegisterTaskDefinition', 'ecs:UpdateService', 'elasticloadbalancing:CreateListener',
    'elasticloadbalancing:CreateLoadBalancer', 'elasticloadbalancing:CreateRule',
    'elasticloadbalancing:CreateTargetGroup', 'elasticloadbalancing:DeleteListener',
    'elasticloadbalancing:DeleteLoadBalancer', 'elasticloadbalancing:DeleteRule',
    'elasticloadbalancing:DeleteTargetGroup', 'elasticloadbalancing:DescribeListeners',
    'elasticloadbalancing:DescribeLoadBalancerAttributes', 'elasticloadbalancing:DescribeLoadBalancers',
    'elasticloadbalancing:DescribeRules', 'elasticloadbalancing:DescribeTargetGroupAttributes',
    'elasticloadbalancing:DescribeTargetGroups', 'elasticloadbalancing:ModifyListener',
    'elasticloadbalancing:ModifyLoadBalancerAttributes', 'elasticloadbalancing:ModifyRule',
    'elasticloadbalancing:ModifyTargetGroup', 'elasticloadbalancing:ModifyTargetGroupAttributes',
    'elasticloadbalancing:SetSecurityGroups', 'elasticloadbalancing:SetSubnets', 'iam:AttachRolePolicy',
    'iam:CreateRole', 'iam:DeleteRole', 'iam:DeleteRolePolicy', 'iam:DetachRolePolicy', 'iam:GetRole',
    'iam:GetRolePolicy', 'iam:ListAttachedRolePolicies', 'iam:ListRolePolicies', 'iam:PassRole',
    'iam:PutRolePolicy', 'logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:DeleteMetricFilter',
    'logs:DeleteRetentionPolicy', 'logs:DescribeLogGroups', 'logs:DescribeMetricFilters',
    'logs:PutMetricFilter', 'logs:PutRetentionPolicy', 's3:CreateBucket', 's3:DeleteBucket',
    's3:DeleteBucketPolicy', 's3:DeleteBucketPublicAccessBlock', 's3:GetBucketPolicy',
    's3:GetBucketPublicAccessBlock', 's3:PutBucketPolicy', 's3:PutBucketPublicAccessBlock',
    'secretsmanager:GetSecretValue', 'ssm:GetParameter', 'ssm:GetParameters',
    'states:CreateStateMachine', 'states:DeleteStateMachine', 'states:DeleteStateMachineVersion',
    'states:DescribeStateMachine', 'states:ListStateMachineVersions', 'states:PublishStateMachineVersion',
    'states:TagResource', 'states:UntagResource', 'states:UpdateStateMachine']),
  'beta-infra-runtime-role': Object.freeze([
    'cloudformation:DescribeStacks', 'cloudformation:GetTemplate', 'cloudformation:ListStackResources',
    'cloudwatch:GetMetricStatistics', 'ecr:BatchGetImage', 'ecr:DescribeImages', 'ecr:GetLifecyclePolicy',
    'ecr:GetLifecyclePolicyPreview', 'ecr:PutImage', 'ecr:StartLifecyclePolicyPreview',
    'cloudtrail:LookupEvents',
    'ecs:DeregisterTaskDefinition', 'ecs:DescribeServices', 'ecs:DescribeTaskDefinition', 'ecs:DescribeTasks',
    'ecs:ListTasks', 'ecs:RegisterTaskDefinition', 'ecs:RunTask', 'ecs:TagResource', 'iam:PassRole',
    'lambda:GetFunction', 'lambda:GetFunctionConfiguration', 'logs:DescribeLogGroups', 'logs:GetLogEvents',
    'logs:PutRetentionPolicy', 'rds:DescribeDBClusters', 'rds:DescribeEvents', 'sqs:GetQueueAttributes',
    'ssm:GetParameter', 'ssm:GetParameters']),
});

// The deploy session policy is generated by sessionPolicy(), not a template.
// These are the reviewed read actions it must contain; the contract test reads
// the generated document.
export const DEPLOY_SESSION_READS = Object.freeze(['sts:GetCallerIdentity',
  'cloudformation:DescribeStacks', 'ssm:GetParameter', 'ec2:DescribeManagedPrefixLists']);

// The canary's own invocations are excluded from the CloudTrail reconciliation
// by a stable STS session-name marker (D2). The role session name becomes
// `infra-<kind>-canary-<run id>`, so every event it produces is filterable.
export const CANARY_MARKER = 'canary';

// Reviewed probe arguments. A probe must be read-only, must target the same
// resource form the operation uses, and must tolerate resource absence. Probes
// that cannot meet all three are skipped with a recorded reason.
export const CANARY_PROBES = Object.freeze({
  'sts/get-caller-identity': Object.freeze([]),
  'cloudformation/describe-stacks': Object.freeze(['--stack-name', BASE_STACK]),
  'cloudformation/get-template': Object.freeze(['--stack-name', BASE_STACK, '--template-stage', 'Original']),
  'cloudformation/list-stack-resources': Object.freeze(['--stack-name', BASE_STACK]),
  'ssm/get-parameter': Object.freeze(['--name', '/anywear/beta/admission_mode']),
  'ssm/get-parameters': Object.freeze(['--names', '/anywear/beta/admission_mode', '/anywear/beta/infra_deployment']),
  'ecs/describe-services': Object.freeze(['--cluster', 'beta-anywear', '--services', 'beta-anywear-api']),
  'ecs/describe-tasks': Object.freeze(['--cluster', 'beta-anywear', '--tasks',
    'arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/00000000000000000000000000000000']),
  'ecs/describe-task-definition': Object.freeze(['--task-definition', 'beta-anywear-lifecycle']),
  'ecs/list-tasks': Object.freeze(['--cluster', 'beta-anywear']),
  'logs/get-log-events': Object.freeze(['--log-group-name', '/anywear/beta/one-shot',
    '--log-stream-name', 'beta-anywear-lifecycle/OneShot/canary-probe']),
  'logs/describe-log-groups': Object.freeze(['--log-group-name-prefix', '/anywear/beta/']),
  'lambda/get-function': Object.freeze(['--function-name', 'beta-anywear-pre-sign-up']),
  'sqs/get-queue-attributes': Object.freeze(['--queue-url',
    'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-vto',
    '--attribute-names', 'QueueArn']),
});

// Operations derived from the call sites that must not be probed, each with the
// reason. A new non-probed operation must be recorded here.
export const CANARY_SKIPS = Object.freeze({
  'ecs/wait': 'A waiter is not an action; its polling reads are probed through ecs/describe-tasks and ecs/describe-services.',
  'ecs/register-task-definition': 'A mutation, not a read; the canary runs before mutation and must not register a task definition.',
  'ecs/run-task': 'A mutation, not a read; the canary runs before mutation and must not start a task.',
  'ecr/batch-get-image': 'A reviewed mapping with no Infra call site; there is no operation to probe.',
  'ecr/describe-images': 'An operator-CLI read (scripts/ecr-retention.mjs) whose only call site is outside the deployed session; the deployed runtime role grants it, but the canary does not probe CLI-only pairs.',
  'ecr/get-lifecycle-policy': 'An operator-CLI read (scripts/ecr-retention.mjs); the restricted runtime session policy does not grant it and the canary must not widen the session.',
  'ecr/get-lifecycle-policy-preview': 'An operator-CLI read (scripts/ecr-retention.mjs); the restricted runtime session policy does not grant it and the canary must not widen the session.',
  'ecr/start-lifecycle-policy-preview': 'A mutation, not a read; the canary runs before mutation and must not start it.',
  'logs/put-retention-policy': 'A mutation, not a read; it is the deployment step the canary protects.',
  'cloudfront/get-distribution': 'A conditional legacy fallback whose base grant the runtime role may deny by design (operation-boundaries.mjs reads table); the session never adds grants.',
  'cloudtrail/lookup-events': 'The observed layer reading CloudTrail for the run window; it is not part of the operation\'s read surface and its own invocations are not reconciled.',
});

// The action set the restricted runtime session actually grants (the session
// policy is generated from this table). A probe outside it would be denied by the
// session even when the base role allows it, so it is never probed.
const RUNTIME_SESSION_ACTIONS = Object.freeze(new Set(Object.values(sessionReads)));

// The deploy session's own read surface, exercised through the CDK CLI after the
// session is assumed. Rendered from sessionPolicy("deploy").
export const DEPLOY_SESSION_PROBES = Object.freeze([
  Object.freeze({ pair: 'sts/get-caller-identity', args: Object.freeze(['sts', 'get-caller-identity']),
    actions: Object.freeze(['sts:GetCallerIdentity']) }),
  Object.freeze({ pair: 'cloudformation/describe-stacks',
    args: Object.freeze(['cloudformation', 'describe-stacks', '--stack-name', BASE_STACK]),
    actions: Object.freeze(['cloudformation:DescribeStacks']) }),
  Object.freeze({ pair: 'ssm/get-parameter',
    args: Object.freeze(['ssm', 'get-parameter', '--name', '/anywear/beta/admission_mode']),
    actions: Object.freeze(['ssm:GetParameter']) }),
  Object.freeze({ pair: 'ec2/describe-managed-prefix-lists',
    args: Object.freeze(['ec2', 'describe-managed-prefix-lists']),
    actions: Object.freeze(['ec2:DescribeManagedPrefixLists']) }),
]);

// D3: declared-but-unused is report-only. Narrowing needs a minimum observation
// window and a recorded retention reason; neither value is inferred at runtime.
export const OBSERVED_SURFACE = Object.freeze({
  schema_version: 1,
  record_type: 'anywear_permissions_observed',
  minimum_window_minutes: 60,
  default_window_minutes: 180,
  canary_marker: CANARY_MARKER,
  retention_reason: 'A declared read can be unused because a code branch, a stack state (stopped Beta) or an operation family did not execute in one run. The artifact is retained at least as long as the deployment evidence (90 days) and a narrowing needs a window covering at least one deploy and one observe run, so a single run cannot delete a grant it merely did not exercise.',
  artifact_path: 'deployment-evidence/permissions-observed.json',
  // The four credential positions whose invocations are reconciled.
  reconciled_roles: Object.freeze(['beta-infra-deploy-role', 'beta-infra-runtime-role',
    'beta-service-deploy-role', 'beta-service-deploy-cfn-role']),
  max_window_days: 90,
  event_page_limit: 50,
});

// D4: what the declared check does not cover. The list ships as a repository
// file and is pinned by a test; it is the check's stated limit, not a note. It is
// read through a function so the same module loads under the ESM scripts and the
// CommonJS test transform.
export function nonCoverageList(root = process.cwd()) {
  return JSON.parse(readFileSync(path.join(root, 'scripts', 'authorization-non-coverage.json'), 'utf8')).entries;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const globRegExp = (pattern) => new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);

// A grant pattern covers a required ARN when the grant's glob matches the ARN.
export function policyCovers(grantedPattern, requiredArn) {
  return globRegExp(grantedPattern).test(requiredArn);
}

// A granted pattern stays inside a reviewed family: substituting a concrete token
// for each of the grant's wildcards must still match the family. A broader grant
// than the family (a wildcard in a position the family pins) fails.
export function patternWithin(grantedPattern, families) {
  if (grantedPattern === '*') return false;
  const concrete = grantedPattern.replace(/\*/g, (_, index) => `placeholder${index}`);
  return families.some((family) => globRegExp(family).test(concrete));
}

export function actionCovered(statementActions, action) {
  return statementActions.some((granted) => granted === action
    || granted === '*'
    || (granted.endsWith(':*') && action.startsWith(`${granted.slice(0, -1)}`)));
}

export function operationActions(pair) {
  const actions = IAM_ACTIONS[pair];
  if (!actions) throw new Error(`Unknown AWS operation ${pair}; add a reviewed mapping`);
  return actions;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function listFiles(root, directory) {
  const absolute = path.join(root, directory);
  return readdirSync(absolute).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .map((name) => `${directory}/${name}`);
}

// Derive every non-test `io.aws([...])` call site and the literal shell calls
// that reach the same gate. Counts are not parameters: the caller pins them.
export function deriveAuthorizationSurface(root) {
  // The scanner is not a caller: it documents the call shape it looks for.
  const files = [...listFiles(root, 'scripts'), ...listFiles(root, '.github/scripts')]
    .filter((file) => file !== 'scripts/authorization-inventory.mjs').sort();
  const sites = [];
  const dynamicSites = [];
  for (const file of files) {
    const source = readFileSync(path.join(root, file), 'utf8');
    const pattern = /io\.aws\(\s*\[\s*(?:'([a-z0-9-]+)'\s*,\s*'([a-z0-9-]+)'|(\.\.\.))/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const credentialPath = CREDENTIAL_PATH_BY_FILE[file];
      if (!credentialPath) throw new Error(`Unattributed AWS call site in ${file}; add a credential path`);
      if (match[3] === '...') {
        const forwarder = DYNAMIC_FORWARDERS.find((entry) => entry.file === file);
        if (!forwarder) throw new Error(`Dynamic AWS call site in ${file} has no enumerated forwarder`);
        const pairs = forwarder.resolve(source);
        if (pairs.length === 0) throw new Error(`Forwarder ${forwarder.function} in ${file} resolves no operation`);
        dynamicSites.push({ file, line: lineOf(source, match.index), function: forwarder.function,
          reason: forwarder.reason, pairs });
        sites.push({ file, line: lineOf(source, match.index), pair: null, credentialPath, forwarder: forwarder.function });
      } else {
        sites.push({ file, line: lineOf(source, match.index), pair: `${match[1]}/${match[2]}`, credentialPath });
      }
    }
  }
  const literalPairSet = new Set(sites.filter((site) => site.pair).map((site) => site.pair));
  const forwardedPairSet = new Set(dynamicSites.flatMap((site) => site.pairs));
  const ioPairs = new Set([...literalPairSet, ...forwardedPairSet]);
  for (const pair of ioPairs) operationActions(pair);

  const shellFile = '.github/scripts/run-one-shot-task.sh';
  const shellSource = readFileSync(path.join(root, shellFile), 'utf8');
  const shell = [];
  const shellPattern = /(?:^|\$\()\s*aws\s+([a-z0-9-]+)\s+([a-z0-9-]+)/gm;
  let shellMatch;
  while ((shellMatch = shellPattern.exec(shellSource)) !== null) {
    const pair = `${shellMatch[1]}/${shellMatch[2]}`;
    operationActions(pair);
    shell.push({ file: shellFile, line: lineOf(shellSource, shellMatch.index), pair, credentialPath: 'runtime-session' });
  }
  if (shell.length === 0) throw new Error('The one-shot shell entry exposes no literal aws call');

  const hook = readFileSync(path.join(root, '.github/scripts/operation-hook.sh'), 'utf8');
  if (!/aws\(\)\s*\{\s*node\s+"\$\{INFRA_REPOSITORY_DIRECTORY:\?\}\/scripts\/aws-operation\.mjs"/.test(hook)) {
    throw new Error('The shell aws function no longer routes through scripts/aws-operation.mjs');
  }
  const spawnSites = files.filter((file) => /spawnSync\('aws'|spawn\('aws'/.test(readFileSync(path.join(root, file), 'utf8')))
    .filter((file) => file !== 'scripts/aws-operation.mjs');
  if (spawnSites.length) throw new Error(`Unexpected direct aws spawn in ${spawnSites.join(', ')}`);

  const pairPaths = new Map();
  const addPath = (pair, credentialPath) => {
    if (!pairPaths.has(pair)) pairPaths.set(pair, new Set());
    pairPaths.get(pair).add(credentialPath);
  };
  for (const site of sites) if (site.pair) addPath(site.pair, site.credentialPath);
  for (const dynamic of dynamicSites) for (const pair of dynamic.pairs) {
    addPath(pair, CREDENTIAL_PATH_BY_FILE[dynamic.file]);
  }
  for (const site of shell) addPath(site.pair, site.credentialPath);

  const distinctPairs = [...pairPaths.keys()].sort();
  return {
    schema_version: INVENTORY_VERSION,
    account: ACCOUNT,
    region: REGION,
    io_aws_sites: sites.length,
    script_sites: sites.filter((site) => site.file.startsWith('scripts/')).length,
    github_script_sites: sites.filter((site) => site.file.startsWith('.github/scripts/')).length,
    literal_pairs: literalPairSet.size,
    forwarded_pairs: forwardedPairSet.size,
    distinct_io_aws_pairs: ioPairs.size,
    shell_sites: shell.length,
    total_call_sites: sites.length + shell.length,
    total_distinct_pairs: distinctPairs.length,
    sites,
    dynamic_sites: dynamicSites,
    shell,
    pairs: distinctPairs.map((pair) => ({ pair, credential_paths: [...pairPaths.get(pair)].sort(), actions: operationActions(pair) })),
    credential_paths: Object.fromEntries(Object.keys(CREDENTIAL_PATHS).map((name) => [name,
      sites.filter((site) => site.credentialPath === name).map((site) => `${site.file}:${site.line}`)])),
  };
}

// The declared action universe: every action any layer is allowed to see. An
// observed action outside it is undeclared and fails the reconciliation.
export function declaredActions() {
  const actions = new Set();
  for (const list of Object.values(REVIEWED_GRANTED_ACTIONS)) for (const action of list) actions.add(action);
  for (const list of Object.values(REVIEWED_WILDCARDS)) for (const entry of list) actions.add(entry.action);
  for (const action of DEPLOY_SESSION_READS) actions.add(action);
  for (const actionsForOperation of Object.values(IAM_ACTIONS)) for (const action of actionsForOperation) actions.add(action);
  return [...actions].sort();
}

// The runtime probe plan is filtered by the credential path that executes the
// call and by the restricted session's own grant. A pair whose only call site is
// the operator CLI is not executed by the deployed session; a pair whose actions
// the session policy does not carry would be denied by the session even when the
// base role allows it. Neither is probed, and each skip records why.
export function canaryPlan(kind, surface) {
  if (kind === 'deploy') {
    return { kind, session_marker: CANARY_MARKER, probes: DEPLOY_SESSION_PROBES.map((probe) => ({ ...probe })), skipped: [] };
  }
  if (kind !== 'runtime') throw new Error(`Unknown canary session ${kind}`);
  const operatorCliOnly = (pair) => {
    const entry = surface?.pairs?.find((candidate) => candidate.pair === pair);
    return Boolean(entry) && entry.credential_paths.length === 1 && entry.credential_paths[0] === 'operator-cli';
  };
  const probes = [];
  const skipped = [];
  for (const pair of Object.keys(IAM_ACTIONS)) {
    const actions = IAM_ACTIONS[pair];
    if (!(pair in CANARY_PROBES) || operatorCliOnly(pair)
      || !actions.every((action) => RUNTIME_SESSION_ACTIONS.has(action))) {
      skipped.push({ pair, reason: CANARY_SKIPS[pair] ?? 'Not a restricted-session read; the canary must not widen the session.' });
      continue;
    }
    probes.push({ pair, args: CANARY_PROBES[pair], actions });
  }
  return { kind, session_marker: CANARY_MARKER, probes, skipped };
}

export function classifyAwsFailure(stderr = '') {
  const text = String(stderr);
  if (/AccessDenied|not authorized|UnauthorizedOperation|AuthorizationError|AccessDeniedException|is not authorized to perform/i.test(text)) {
    return 'authorization-denied';
  }
  if (/does not exist|not exist|not found|NoSuchEntity|ResourceNotFound|NotFoundException|NonExistent|ValidationError|ClientException|InvalidParameter/i.test(text)) {
    return 'resource-absent';
  }
  return 'unknown';
}
