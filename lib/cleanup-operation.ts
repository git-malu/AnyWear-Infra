import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * Fixed Beta cleanup capability. The caller supplies only the validated
 * operation envelope and cleanup request; task definitions, image, roles,
 * network and commands are deployment-owned resources.
 */
export interface CleanupOperationProps {
  cluster: ecs.ICluster;
  vpc: ec2.IVpc;
  securityGroup: ec2.ISecurityGroup;
  subnets: ec2.ISubnet[];
  repository: ecr.IRepository;
  imageDigest: string;
  serviceCommit: string;
  apiBaseUrl: string;
  cleanupTaskRole: iam.IRole;
  verificationTaskRole: iam.IRole;
  executionRole: iam.IRole;
  logGroup: logs.ILogGroup;
  databaseSecretArn: string;
  databaseHost: string;
  databasePort: string;
  databaseName: string;
  bucketName: string;
  vtoQueueUrl: string;
  taggingQueueUrl: string;
  vtoDlqUrl: string;
  taggingDlqUrl: string;
}

export class CleanupOperation extends Construct {
  readonly stateMachine: sfn.StateMachine;
  readonly stateMachineVersion: cdk.aws_stepfunctions.CfnStateMachineVersion;
  readonly verificationTaskDefinition: ecs.FargateTaskDefinition;
  readonly cleanupTaskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: CleanupOperationProps) {
    super(scope, id);

    const commonEnvironment = {
      STAGE: 'beta', NODE_ENV: 'production', AWS_REGION: cdk.Stack.of(this).region,
      DB_SECRET_ARN: props.databaseSecretArn, DB_HOST: props.databaseHost,
      DB_PORT: props.databasePort, DB_NAME: props.databaseName,
      S3_BUCKET_NAME: props.bucketName, TASK_TRANSPORT: 'sqs',
      SQS_VTO_QUEUE_URL: props.vtoQueueUrl, SQS_AUTO_TAGGING_QUEUE_URL: props.taggingQueueUrl,
      SERVICE_COMMIT_SHA: props.serviceCommit, IMAGE_DIGEST: props.imageDigest,
    };
    const image = ecs.ContainerImage.fromRegistry(`${props.repository.repositoryUri}@${props.imageDigest}`);
    const taskDefinition = (id: string, family: string, role: iam.IRole, command: string[], environment: Record<string, string>) => {
      const definition = new ecs.FargateTaskDefinition(this, id, {
        family, cpu: 512, memoryLimitMiB: 1024, taskRole: role, executionRole: props.executionRole,
      });
      definition.addContainer('OneShot', {
        image, command, environment,
        logging: ecs.LogDrivers.awsLogs({ logGroup: props.logGroup, streamPrefix: family }),
      });
      return definition;
    };

    this.verificationTaskDefinition = taskDefinition(
      'VerificationTaskDefinition', 'beta-anywear-cleanup-verify', props.verificationTaskRole,
      ['node', 'dist/verify.js'], { ...commonEnvironment, VERIFY_API_URL: props.apiBaseUrl },
    );
    this.cleanupTaskDefinition = taskDefinition(
      'CleanupTaskDefinition', 'beta-anywear-cleanup', props.cleanupTaskRole,
      ['node', 'dist/ops/beta-tester-cleanup.js'], {
        ...commonEnvironment, SQS_VTO_DLQ_URL: props.vtoDlqUrl, SQS_AUTO_TAGGING_DLQ_URL: props.taggingDlqUrl,
      },
    );

    const stateMachineRole = new iam.Role(this, 'StateMachineRole', {
      roleName: 'beta-anywear-tester-cleanup-operation',
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
    });
    const target = { launchTarget: new tasks.EcsFargateLaunchTarget(), cluster: props.cluster,
      taskDefinition: this.verificationTaskDefinition, subnets: { subnets: props.subnets },
      securityGroups: [props.securityGroup], assignPublicIp: false,
      integrationPattern: sfn.IntegrationPattern.RUN_JOB };
    const verify = new tasks.EcsRunTask(this, 'Verify', { ...target, resultPath: '$.verification' });
    const cleanup = new tasks.EcsRunTask(this, 'Cleanup', {
      ...target, taskDefinition: this.cleanupTaskDefinition, resultPath: '$.cleanup',
      containerOverrides: [{ containerDefinition: this.cleanupTaskDefinition.defaultContainer!,
        command: sfn.JsonPath.array('node', 'dist/ops/beta-tester-cleanup.js', sfn.JsonPath.stringAt('$.cleanup_request')) as unknown as string[],
      }],
    });
    const invalid = new sfn.Fail(this, 'InvalidRequest', { error: 'InvalidCleanupOperation', cause: 'The fixed Beta cleanup envelope is incomplete' });
    const validate = new sfn.Choice(this, 'ValidateEnvelope')
      .when(sfn.Condition.and(
        sfn.Condition.numberEquals('$.schema_version', 1),
        sfn.Condition.isPresent('$.operation_id'),
        sfn.Condition.isPresent('$.run_scope'),
        sfn.Condition.isPresent('$.request_sha256'),
        sfn.Condition.isPresent('$.service_commit_sha'),
        sfn.Condition.isPresent('$.service_image_digest'),
        sfn.Condition.isPresent('$.cleanup_request'),
      ), verify)
      .otherwise(invalid);
    const result = new sfn.Pass(this, 'CleanupResult', {
      parameters: {
        schema_version: 1,
        operation_id: sfn.JsonPath.stringAt('$.operation_id'),
        request_sha256: sfn.JsonPath.stringAt('$.request_sha256'),
        run_scope: sfn.JsonPath.stringAt('$.run_scope'),
        transaction_committed: true,
        verification_task_arn: sfn.JsonPath.stringAt('$.verification.Tasks[0].TaskArn'),
        verification_task_status: 'SUCCEEDED',
        cleanup_task_arn: sfn.JsonPath.stringAt('$.cleanup.Tasks[0].TaskArn'),
        cleanup_task_status: 'SUCCEEDED',
      },
    });
    verify.next(cleanup).next(result);
    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: 'beta-anywear-tester-cleanup', stateMachineType: sfn.StateMachineType.STANDARD,
      role: stateMachineRole, definitionBody: sfn.DefinitionBody.fromChainable(validate),
      timeout: cdk.Duration.minutes(30),
      logs: { destination: props.logGroup, level: sfn.LogLevel.ERROR, includeExecutionData: false },
    });
    this.stateMachineVersion = new sfn.CfnStateMachineVersion(this, 'StateMachineVersion', {
      stateMachineArn: this.stateMachine.stateMachineArn,
      stateMachineRevisionId: this.stateMachine.stateMachineRevisionId,
      description: 'Immutable Beta tester cleanup operation capability',
    });
    this.stateMachineVersion.addDependency(this.stateMachine.node.defaultChild as cdk.CfnResource);

    const e2e = iam.Role.fromRoleName(this, 'E2EQualificationRole', 'beta-e2e-qualification-role');
    const executionArn = cdk.Stack.of(this).formatArn({ service: 'states', resource: 'execution',
      resourceName: 'beta-anywear-tester-cleanup:*', arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME });
    e2e.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['states:StartExecution'], resources: [this.stateMachineVersion.attrArn],
    }));
    e2e.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['states:DescribeExecution', 'states:GetExecutionHistory'], resources: [executionArn],
    }));
    e2e.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['states:ListExecutions'], resources: [this.stateMachine.stateMachineArn],
    }));
    new cdk.CfnOutput(this, 'CleanupStateMachineArn', { value: this.stateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'CleanupStateMachineVersionArn', { value: this.stateMachineVersion.attrArn });
  }
}
