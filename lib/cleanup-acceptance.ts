import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import type { CleanupOperationProps } from './cleanup-operation';

// This fixture is a protected operator capability, separate from normal E2E
// cleanup and the ordinary Infra workflow families.
export class CleanupAcceptance extends Construct {
  readonly taskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: CleanupOperationProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const family = 'beta-anywear-cleanup-acceptance';
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family, cpu: 512, memoryLimitMiB: 1024,
      taskRole: props.cleanupTaskRole, executionRole: props.executionRole,
    });
    this.taskDefinition.addContainer('OneShot', {
      image: ecs.ContainerImage.fromRegistry(`${props.repository.repositoryUri}@${props.imageDigest}`),
      command: ['node', 'dist/ops/beta-cleanup-acceptance-fixture.js'],
      environment: {
        STAGE: 'beta', NODE_ENV: 'production', AWS_REGION: stack.region,
        BETA_CLEANUP_ACCEPTANCE_ISSUE: '86', SERVICE_COMMIT_SHA: props.serviceCommit, IMAGE_DIGEST: props.imageDigest,
        DB_SECRET_ARN: props.databaseSecretArn, DB_HOST: props.databaseHost,
        DB_PORT: props.databasePort, DB_NAME: props.databaseName,
        S3_BUCKET_NAME: props.bucketName, TASK_TRANSPORT: 'sqs',
        SQS_VTO_QUEUE_URL: props.vtoQueueUrl, SQS_AUTO_TAGGING_QUEUE_URL: props.taggingQueueUrl,
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: props.logGroup, streamPrefix: family }),
    });
    this.taskDefinition.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    const runtime = iam.Role.fromRoleName(this, 'InfraRuntimeRole', 'beta-infra-runtime-role', { defaultPolicyName: 'DefaultPolicy' });
    runtime.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask'], resources: [this.taskDefinition.taskDefinitionArn],
      conditions: { ArnEquals: { 'ecs:cluster': props.cluster.clusterArn } },
    }));
    runtime.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'], resources: [props.cleanupTaskRole.roleArn, props.executionRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
    }));
    runtime.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['logs:GetLogEvents'], resources: [stack.formatArn({ service: 'logs', resource: 'log-group',
        resourceName: `${props.logGroup.logGroupName}:log-stream:${family}/OneShot/*`,
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME })],
    }));
    new cdk.CfnOutput(stack, 'CleanupAcceptanceTaskDefinitionArn', { value: this.taskDefinition.taskDefinitionArn });
  }
}
