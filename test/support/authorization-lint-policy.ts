// Reviewed suppression policy for the IaC authorization lint (#165).
// Every accepted wildcard action or wildcard resource ARN names the principals,
// the exact action set, the resource forms and the reason. A statement that does
// not match an entry fails test/authorization-lint.test.ts, and an entry that no
// longer matches a statement fails too, so neither can go stale.
export interface Suppression {
  template: string;
  principals: string[];
  actions: string[];
  resources: string[];
  conditionRequired: boolean;
  reason: string;
}

export const SUPPRESSIONS: Suppression[] = [
{ template: "platform", principals: ["beta-infra-runtime-role"],
    actions: ["cloudformation:DescribeStacks","cloudformation:GetTemplate","cloudformation:ListStackResources"],
    resources: ["arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearEgressStack-beta/*"],
    conditionRequired: false,
    reason: "The runtime role reads the disposable Egress stack's terminal state to enforce the stop ordering (Runtime absent before the Egress delete) and the one-writer rule; the generated stack UUID is the only wildcard position." },
{ template: "foundation", principals: ["beta-infra-runtime-role"],
    actions: ["cloudformation:DescribeStacks","cloudformation:GetTemplate"],
    resources: ["arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearRuntimeStack-beta/*","arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearWorkloadStack-beta/*"],
    conditionRequired: false,
    reason: "CloudFormation reads and writes target the repository-owned stack ARNs; the generated stack UUID is the only wildcard position." },
{ template: "platform", principals: ["beta-infra-deploy-role","beta-infra-runtime-role"],
    actions: ["cloudformation:DescribeStacks","cloudformation:GetTemplate","cloudformation:ListStackResources"],
    resources: ["arn:aws:cloudformation:us-east-1:650880818323:stack/AnyWearBillingStack-beta/*"],
    conditionRequired: false,
    reason: "CloudFormation reads and writes target the repository-owned stack ARNs; the generated stack UUID is the only wildcard position." },
{ template: "platform", principals: ["beta-infra-deploy-role","beta-infra-runtime-role"],
    actions: ["cloudformation:DescribeStacks"],
    resources: ["arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearFoundationStack/*","arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearPlatformStack-beta/*","arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearRuntimeStack-beta/*"],
    conditionRequired: false,
    reason: "CloudFormation reads and writes target the repository-owned stack ARNs; the generated stack UUID is the only wildcard position." },
{ template: "platform", principals: ["beta-infra-deploy-role","beta-infra-runtime-role"],
    actions: ["cloudformation:GetTemplate","cloudformation:ListStackResources"],
    resources: ["arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearFoundationStack/*","arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearPlatformStack-beta/*","arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearRuntimeStack-beta/*"],
    conditionRequired: false,
    reason: "CloudFormation reads and writes target the repository-owned stack ARNs; the generated stack UUID is the only wildcard position." },
{ template: "platform", principals: ["beta-infra-deploy-role","beta-infra-runtime-role"],
    actions: ["ecs:DescribeTaskDefinition"],
    resources: ["*"],
    conditionRequired: true,
    reason: "ECS DescribeTaskDefinition has no resource type; the grant is region-conditioned." },
{ template: "platform", principals: ["beta-infra-deploy-role","beta-infra-runtime-role"],
    actions: ["ecs:DescribeTasks"],
    resources: ["arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/*"],
    conditionRequired: false,
    reason: "Tasks in the dedicated Beta cluster." },
{ template: "platform", principals: ["beta-infra-deploy-role","beta-infra-runtime-role"],
    actions: ["ecs:ListTasks"],
    resources: ["*"],
    conditionRequired: true,
    reason: "ECS ListTasks has no resource type; the grant is cluster-conditioned." },
{ template: "platform", principals: ["beta-infra-deploy-role"],
    actions: ["ec2:DescribeManagedPrefixLists"],
    resources: ["*"],
    conditionRequired: true,
    reason: "EC2 prefix-list reads have no resource scope; the grant is region-conditioned." },
{ template: "platform", principals: ["beta-infra-deploy-role"],
    actions: ["secretsmanager:GetSecretValue"],
    resources: ["arn:aws:secretsmanager:ap-east-1:650880818323:secret:/anywear/beta/cloudfront_origin_header-*"],
    conditionRequired: false,
    reason: "Reviewed wildcard resource form for this principal." },
{ template: "platform", principals: ["beta-infra-runtime-role"],
    actions: ["cloudwatch:GetMetricStatistics","rds:DescribeDBClusters","rds:DescribeEvents"],
    resources: ["*"],
    conditionRequired: true,
    reason: "RDS and CloudWatch reads have no resource scope; the grant is region-conditioned." },
{ template: "platform", principals: ["beta-infra-runtime-role"],
    actions: ["ecs:DeregisterTaskDefinition"],
    resources: ["*"],
    conditionRequired: true,
    reason: "ECS evaluates deregistration against `*`; the statement is the single reviewed rollback/deletion action." },
{ template: "platform", principals: ["beta-infra-runtime-role"],
    actions: ["ecs:RegisterTaskDefinition"],
    resources: ["arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-artifact-verify:*","arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-lifecycle:*","arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-migrate:*","arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-verify:*"],
    conditionRequired: false,
    reason: "Task-definition revisions of the reviewed Beta families." },
{ template: "platform", principals: ["beta-infra-runtime-role"],
    actions: ["ecs:RunTask"],
    resources: ["arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-artifact-verify:*","arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-lifecycle:*","arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-migrate:*","arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-verify:*"],
    conditionRequired: false,
    reason: "Task-definition revisions of the reviewed Beta families." },
{ template: "platform", principals: ["beta-infra-runtime-role"],
    actions: ["ecs:TagResource"],
    resources: ["arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-artifact-verify:*","arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-lifecycle:*","arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-migrate:*","arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-verify:*"],
    conditionRequired: false,
    reason: "Task-definition revisions of the reviewed Beta families." },
{ template: "platform", principals: ["beta-infra-runtime-role"],
    actions: ["lambda:GetFunction"],
    resources: ["arn:aws:lambda:ap-east-1:650880818323:function:AnyWearPlatformStack-beta-*","arn:aws:lambda:ap-east-1:650880818323:function:beta-anywear-post-confirmation-sync","arn:aws:lambda:ap-east-1:650880818323:function:beta-anywear-pre-sign-up"],
    conditionRequired: false,
    reason: "The two application functions and the Base stack's generated helper functions." },
{ template: "platform", principals: ["beta-infra-runtime-role"],
    actions: ["logs:DescribeLogGroups"],
    resources: ["*"],
    conditionRequired: true,
    reason: "IAM evaluates DescribeLogGroups in its list form with an empty log-group name; no named log-group ARN can match." },
{ template: "platform", principals: ["beta-infra-runtime-role"],
    actions: ["logs:GetLogEvents"],
    resources: ["arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/beta/one-shot:log-stream:beta-anywear-artifact-verify/OneShot/*","arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/beta/one-shot:log-stream:beta-anywear-lifecycle/OneShot/*","arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/beta/one-shot:log-stream:beta-anywear-migrate/OneShot/*","arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/beta/one-shot:log-stream:beta-anywear-verify/OneShot/*"],
    conditionRequired: false,
    reason: "Reviewed Beta log groups and one-shot streams." },
{ template: "platform", principals: ["beta-infra-runtime-role"],
    actions: ["logs:PutRetentionPolicy"],
    resources: ["arn:aws:logs:ap-east-1:650880818323:log-group:/aws/lambda/AnyWearPlatformStack-beta-*:*","arn:aws:logs:ap-east-1:650880818323:log-group:/aws/lambda/beta-anywear-post-confirmation-sync:*","arn:aws:logs:ap-east-1:650880818323:log-group:/aws/lambda/beta-anywear-pre-sign-up:*"],
    conditionRequired: false,
    reason: "Reviewed Beta log groups and one-shot streams." },
{ template: "platform", principals: ["beta-infra-runtime-role"],
    actions: ["ssm:GetParameter","ssm:GetParameters"],
    resources: ["arn:aws:ssm:ap-east-1:650880818323:parameter/anywear/beta/*"],
    conditionRequired: false,
    reason: "The Beta stage-contract prefix; every parameter under it is published by the reviewed Base deploy." },
{ template: "platform", principals: ["beta-infra-deploy-role","beta-infra-runtime-role"],
    actions: ["iam:SimulateCustomPolicy","iam:SimulatePrincipalPolicy"],
    resources: ["*"],
    conditionRequired: false,
    reason: "The simulator actions have no resource-level scope. SimulatePrincipalPolicy can enumerate any principal's effective permissions in the account; the grant is these two actions alone, used only by the preflight." },
  { template: "platform", principals: ["beta-infra-deploy-role"],
    actions: ["cloudformation:DescribeChangeSet","cloudformation:DeleteChangeSet","cloudformation:ExecuteChangeSet"],
    resources: ["arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearRuntimeStack-beta/*","arn:aws:cloudformation:ap-east-1:650880818323:changeSet/*"],
    conditionRequired: false,
    reason: "Issue #195 deploy-runtime: the restricted deploy session describes, executes or deletes exactly the change set the CDK bootstrap role created for the Runtime stack. The change-set collection is the reviewed wildcard; no create action and no other stack." },
  { template: "platform", principals: ["beta-infra-runtime-role"],
    actions: ["cloudwatch:DescribeAlarms"],
    resources: ["arn:aws:cloudwatch:ap-east-1:650880818323:alarm:beta-anywear-*"],
    conditionRequired: false,
    reason: "Issue #195: the 600-second bake records the deployed bake and queue alarm states under the reviewed beta-anywear-* prefix; the alarm names are the only wildcard position and no alarm is written." },
  { template: "platform", principals: ["beta-infra-runtime-role"],
    actions: ["logs:FilterLogEvents"],
    resources: ["arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/beta/worker","arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/beta/worker:*"],
    conditionRequired: false,
    reason: "Issue #195: the bake reads the worker outbox metric lines under the read-only runtime session. Both the log-group and stream-suffixed forms are the reviewed grant; nothing outside /anywear/beta/worker is included." },
];


// A managed-policy attachment on one of the linted roles is a finding unless it
// is reviewed here. CDK splits an oversized role policy into an overflow managed
// policy; that artifact is reviewed and its statements are scanned like the inline
// documents.
export const MANAGED_POLICY_REVIEW: Array<{ role: string; policy: string; reason: string }> = [
  // No reviewed overflow managed policy remains after #195 retired the Service
  // deployment roles; any attachment on a linted role is a finding.
];

// Exceptions that are not repository-defined constructs: the CDK bootstrap
// execution role exists in the account, holds AdministratorAccess and no
// permissions boundary, and cannot be linted from this app.
export const STATED_EXCEPTIONS: Array<{ name: string; reason: string }> = [
  { name: 'cdk-hnb659fds-cfn-exec-role', reason: 'The CDK bootstrap CloudFormation execution role holds AdministratorAccess and no permissions boundary. No repository defines it, so the lint cannot inspect it; it is recorded here and in scripts/authorization-non-coverage.json.' },
];
