import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
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
      // Deletable with the Runtime stack: the fixed family name is re-registered
      // on the next start, and a retained inactive revision would only accumulate
      // or collide with the stop/start lifecycle. ECS task-definition
      // deregistration is covered by the separately authorized grant in PR #101.
      // `ExecutionRoleArn` is an `AWS::SSM::Parameter::Value<String>`: its
      // template default is the SSM parameter name, and CloudFormation resolves
      // the role ARN at deploy time. CDK's CloudFormation validator checks the
      // default against the IAM ARN pattern, so acknowledge exactly that rule
      // instead of weakening the parameter type or the validation.
      cdk.Validations.of(definition).acknowledge({
        id: 'CloudFormation-Validate::E3511',
        reason: 'ExecutionRoleArn is resolved from /anywear/<stage>/one_shot_execution_role_arn at deploy time; the template default is the SSM parameter name.',
      });
      return definition;
    };

    this.verificationTaskDefinition = taskDefinition(
      'VerificationTaskDefinition', 'beta-anywear-cleanup-verify', props.verificationTaskRole,
      ['node', 'dist/verify.js'], { ...commonEnvironment, VERIFY_API_URL: props.apiBaseUrl },
    );
    this.cleanupTaskDefinition = taskDefinition(
      'CleanupTaskDefinition', 'beta-anywear-cleanup', props.cleanupTaskRole,
      ['node', 'dist/ops/beta-cleanup-operation.js'], {
        ...commonEnvironment, SQS_VTO_DLQ_URL: props.vtoDlqUrl, SQS_AUTO_TAGGING_DLQ_URL: props.taggingDlqUrl,
      },
    );

    const stateMachineRole = new iam.Role(this, 'StateMachineRole', {
      roleName: 'beta-anywear-tester-cleanup-operation',
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
    });
    const stack = cdk.Stack.of(this);
    const taskArn = stack.formatArn({ service: 'ecs', resource: 'task',
      resourceName: 'beta-anywear/*', arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME });
    stateMachineRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask'],
      resources: [this.verificationTaskDefinition.taskDefinitionArn, this.cleanupTaskDefinition.taskDefinitionArn],
      conditions: { ArnEquals: { 'ecs:cluster': props.cluster.clusterArn } },
    }));
    stateMachineRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:StopTask', 'ecs:DescribeTasks'], resources: [taskArn],
      conditions: { ArnEquals: { 'ecs:cluster': props.cluster.clusterArn } },
    }));
    stateMachineRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [props.verificationTaskRole.roleArn, props.cleanupTaskRole.roleArn, props.executionRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
    }));
    stateMachineRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['events:PutTargets', 'events:PutRule', 'events:DescribeRule'],
      resources: [stack.formatArn({ service: 'events', resource: 'rule', resourceName: 'StepFunctionsGetEventsForECSTaskRule' })],
    }));
    // CDK EcsRunTask defaults to the latest family revision. Bind the complete
    // task-definition Ref so a published machine version also fixes its tasks.
    const runTask = (id: string, definition: ecs.FargateTaskDefinition, resultPath: string, command?: string) => new sfn.CustomState(this, id, {
      stateJson: {
        Type: 'Task', Resource: `arn:${stack.partition}:states:::ecs:runTask.sync`, ResultPath: resultPath,
        Parameters: {
          Cluster: props.cluster.clusterArn, TaskDefinition: definition.taskDefinitionArn, LaunchType: 'FARGATE',
          'ClientToken.$': `States.Hash(States.Format('{}:${id.toLowerCase()}', $$.Execution.Id), 'SHA-256')`,
          NetworkConfiguration: { AwsvpcConfiguration: {
            Subnets: props.subnets.map(subnet => subnet.subnetId), SecurityGroups: [props.securityGroup.securityGroupId], AssignPublicIp: 'DISABLED',
          } },
          ...(command ? { Overrides: { ContainerOverrides: [{ Name: 'OneShot', 'Command.$': command }] } } : {}),
        },
      },
    });
    const verify = runTask('Verify', this.verificationTaskDefinition, '$.verification');
    const cleanup = runTask('Cleanup', this.cleanupTaskDefinition, '$.cleanup',
      "States.Array('node', 'dist/ops/beta-cleanup-operation.js', $.request_binding.envelope)");
    const captureRequest = new sfn.Pass(this, 'CaptureRequest', {
      parameters: { 'envelope.$': 'States.JsonToString($)' }, resultPath: '$.request_binding',
    });
    const invalid = new sfn.Fail(this, 'InvalidRequest', { error: 'InvalidCleanupOperation', cause: 'The cleanup envelope must bind the deployed Service identity' });
    const validate = new sfn.Choice(this, 'ValidateEnvelope')
      .when(sfn.Condition.and(
        sfn.Condition.numberEquals('$.schema_version', 1),
        sfn.Condition.isString('$.operation_id'), sfn.Condition.not(sfn.Condition.stringEquals('$.operation_id', '')),
        sfn.Condition.isString('$.run_scope'), sfn.Condition.not(sfn.Condition.stringEquals('$.run_scope', '')),
        sfn.Condition.isString('$.request_sha256'), sfn.Condition.not(sfn.Condition.stringEquals('$.request_sha256', '')),
        sfn.Condition.isString('$.service_commit_sha'), sfn.Condition.stringEquals('$.service_commit_sha', props.serviceCommit),
        sfn.Condition.isString('$.service_image_digest'), sfn.Condition.stringEquals('$.service_image_digest', props.imageDigest),
        sfn.Condition.isString('$.cleanup_request'), sfn.Condition.not(sfn.Condition.stringEquals('$.cleanup_request', '')),
      ), captureRequest)
      .otherwise(invalid);
    const taskFailed = new sfn.Fail(this, 'TaskFailed', {
      error: 'CleanupTaskNotSuccessful', cause: 'A unique stopped OneShot task with exit code zero and the deployed image is required',
    });
    const successfulTask = (resultPath: string, definition: ecs.FargateTaskDefinition) => sfn.Condition.and(
      sfn.Condition.isString(`${resultPath}.TaskArn`),
      sfn.Condition.stringMatches(`${resultPath}.TaskArn`, taskArn),
      sfn.Condition.isPresent(`${resultPath}.ClusterArn`),
      sfn.Condition.stringEquals(`${resultPath}.ClusterArn`, props.cluster.clusterArn),
      sfn.Condition.isPresent(`${resultPath}.TaskDefinitionArn`),
      sfn.Condition.stringEquals(`${resultPath}.TaskDefinitionArn`, definition.taskDefinitionArn),
      sfn.Condition.isPresent(`${resultPath}.LastStatus`),
      sfn.Condition.stringEquals(`${resultPath}.LastStatus`, 'STOPPED'),
      sfn.Condition.isPresent(`${resultPath}.Containers[0].Name`),
      sfn.Condition.stringEquals(`${resultPath}.Containers[0].Name`, 'OneShot'),
      sfn.Condition.isPresent(`${resultPath}.Containers[0].LastStatus`),
      sfn.Condition.stringEquals(`${resultPath}.Containers[0].LastStatus`, 'STOPPED'),
      sfn.Condition.isPresent(`${resultPath}.Containers[0].ExitCode`),
      sfn.Condition.numberEquals(`${resultPath}.Containers[0].ExitCode`, 0),
      sfn.Condition.isPresent(`${resultPath}.Containers[0].ImageDigest`),
      sfn.Condition.stringEquals(`${resultPath}.Containers[0].ImageDigest`, props.imageDigest),
      sfn.Condition.not(sfn.Condition.isPresent(`${resultPath}.Containers[1]`)),
    );
    const verified = new sfn.Choice(this, 'VerificationSucceeded')
      .when(successfulTask('$.verification', this.verificationTaskDefinition), cleanup).otherwise(taskFailed);
    const result = new sfn.Pass(this, 'CleanupResult', {
      parameters: {
        schema_version: 1,
        operation_id: sfn.JsonPath.stringAt('$.operation_id'),
        request_sha256: sfn.JsonPath.stringAt('$.request_sha256'),
        run_scope: sfn.JsonPath.stringAt('$.run_scope'),
        record_type: 'anywear_beta_cleanup_tasks',
        service_commit_sha: props.serviceCommit, service_image_digest: props.imageDigest,
        cluster_arn: props.cluster.clusterArn, log_group_name: props.logGroup.logGroupName,
        verification_task_arn: sfn.JsonPath.stringAt('$.verification.TaskArn'),
        verification_task_definition_arn: sfn.JsonPath.stringAt('$.verification.TaskDefinitionArn'),
        verification_task_status: sfn.JsonPath.stringAt('$.verification.LastStatus'),
        verification_exit_code: sfn.JsonPath.numberAt('$.verification.Containers[0].ExitCode'),
        verification_log_stream_prefix: 'beta-anywear-cleanup-verify',
        cleanup_task_arn: sfn.JsonPath.stringAt('$.cleanup.TaskArn'),
        cleanup_task_definition_arn: sfn.JsonPath.stringAt('$.cleanup.TaskDefinitionArn'),
        cleanup_task_status: sfn.JsonPath.stringAt('$.cleanup.LastStatus'),
        cleanup_exit_code: sfn.JsonPath.numberAt('$.cleanup.Containers[0].ExitCode'),
        cleanup_log_stream_prefix: 'beta-anywear-cleanup',
      },
    });
    const cleaned = new sfn.Choice(this, 'CleanupSucceeded')
      .when(successfulTask('$.cleanup', this.cleanupTaskDefinition), result).otherwise(taskFailed);
    captureRequest.next(verify).next(verified);
    cleanup.next(cleaned);
    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: 'beta-anywear-tester-cleanup', stateMachineType: sfn.StateMachineType.STANDARD,
      role: stateMachineRole, definitionBody: sfn.DefinitionBody.fromChainable(validate),
      timeout: cdk.Duration.minutes(30),
      logs: { destination: props.logGroup, level: sfn.LogLevel.ERROR, includeExecutionData: false },
    });
    this.stateMachine.node.addDependency(stateMachineRole);
    // The cleanup capability belongs to the Runtime stack's lifetime. Stopping
    // Beta deletes the Runtime stack, and the fixed state-machine name
    // `beta-anywear-tester-cleanup` is recreated by the next start, so retaining
    // the state machine or its version would collide with `State machine
    // already exists`. CloudFormation's execution role already carries
    // states:DeleteStateMachine/DeleteStateMachineVersion on the exact ARN.
    this.stateMachineVersion = new sfn.CfnStateMachineVersion(this, 'StateMachineVersion', {
      stateMachineArn: this.stateMachine.stateMachineArn,
      stateMachineRevisionId: this.stateMachine.stateMachineRevisionId,
      description: 'Immutable Beta tester cleanup operation capability',
    });
    this.stateMachineVersion.addResourceDependency(this.stateMachine.node.defaultChild as cdk.CfnResource);

    const e2e = iam.Role.fromRoleName(this, 'E2EQualificationRole', 'beta-e2e-qualification-role');
    const executionArn = cdk.Stack.of(this).formatArn({ service: 'states', resource: 'execution',
      resourceName: 'beta-anywear-tester-cleanup:*', arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME });
    e2e.addToPrincipalPolicy(new iam.PolicyStatement({
      // Step Functions authorizes StartExecution against the unqualified
      // state-machine ARN even when the caller submits the reviewed version
      // ARN. Keep both exact ARNs; neither resource is wildcarded.
      actions: ['states:StartExecution'], resources: [this.stateMachine.stateMachineArn, this.stateMachineVersion.attrArn],
    }));
    e2e.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['states:DescribeExecution', 'states:GetExecutionHistory'], resources: [executionArn],
    }));
    e2e.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['states:ListExecutions'], resources: [this.stateMachine.stateMachineArn],
    }));
    e2e.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:DescribeTasks'], resources: [taskArn],
      conditions: { ArnEquals: { 'ecs:cluster': props.cluster.clusterArn } },
    }));
    e2e.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:DescribeTaskDefinition'],
      resources: [this.verificationTaskDefinition.taskDefinitionArn, this.cleanupTaskDefinition.taskDefinitionArn],
    }));
    e2e.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['logs:GetLogEvents'],
      resources: ['beta-anywear-cleanup-verify', 'beta-anywear-cleanup'].map(prefix =>
        stack.formatArn({ service: 'logs', resource: 'log-group',
          resourceName: `${props.logGroup.logGroupName}:log-stream:${prefix}/OneShot/*`,
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME })),
    }));
    const runtime = iam.Role.fromRoleName(this, 'InfraRuntimeRole', 'beta-infra-runtime-role');
    runtime.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['states:ListExecutions'], resources: [this.stateMachine.stateMachineArn],
    }));
    runtime.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['states:DescribeExecution'], resources: [executionArn],
    }));
    new cdk.CfnOutput(this, 'CleanupStateMachineArn', { value: this.stateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'CleanupStateMachineVersionArn', { value: this.stateMachineVersion.attrArn });
  }
}
