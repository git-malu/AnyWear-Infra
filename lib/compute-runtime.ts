import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elasticloadbalancingv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface ComputeRuntimeProps {
  stage: 'beta' | 'prod';
  vpc: ec2.IVpc;
  database: rds.DatabaseCluster;
  wardrobeBucket: s3.Bucket;
  repository: ecr.Repository;
  vtoQueue: sqs.Queue;
  vtoDeadLetterQueue: sqs.Queue;
  autoTaggingQueue: sqs.Queue;
  autoTaggingDeadLetterQueue: sqs.Queue;
  cognitoUserPoolId: string;
  cognitoClientId: string;
  qWeatherApiKeySecret: secretsmanager.ISecret;
  cluster: ecs.Cluster;
  apiSecurityGroup: ec2.SecurityGroup;
  workerSecurityGroup: ec2.SecurityGroup;
  loadBalancerSecurityGroup: ec2.SecurityGroup;
  operationsTopic?: sns.ITopic;
  betaActive?: boolean;
}

export class ComputeRuntime extends Construct {
  readonly cluster: ecs.Cluster;
  readonly imageDigest: cdk.CfnParameter;
  readonly serviceCommit: cdk.CfnParameter;
  readonly loadBalancer?: elasticloadbalancingv2.ApplicationLoadBalancer;
  readonly apiService?: ecs.FargateService;
  readonly workerService?: ecs.FargateService;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: ComputeRuntimeProps) {
    super(scope, id);

    const active = props.stage !== 'beta' || props.betaActive !== false;
    const maintenanceBucket = props.stage === 'beta' ? new s3.Bucket(this, 'MaintenanceOrigin', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    }) : undefined;
    const maintenanceResponse = props.stage === 'beta' ? new cloudfront.Function(this, 'MaintenanceResponse', {
      code: cloudfront.FunctionCode.fromInline('function handler(event) { return { statusCode: 503, statusDescription: "Service Unavailable", headers: { "content-type": { value: "application/json" }, "cache-control": { value: "no-store" }, "retry-after": { value: "300" } }, body: "{\\"error\\":\\"beta_stopped\\"}" }; }'),
    }) : undefined;

    const imageDigest = new cdk.CfnParameter(cdk.Stack.of(this), 'ServiceImageDigest', {
      type: 'String',
      description: 'Immutable ECR image digest qualified for this deployment',
      allowedPattern: '^sha256:[a-f0-9]{64}$',
      constraintDescription: 'Must be a sha256 OCI image digest',
    });
    const serviceCommit = new cdk.CfnParameter(cdk.Stack.of(this), 'ServiceCommitSha', {
      type: 'String',
      description: 'Exact AnyWear-Service commit represented by the image',
      allowedPattern: '^[a-f0-9]{40}$',
    });
    this.imageDigest = imageDigest;
    this.serviceCommit = serviceCommit;
    const providerSecretArn = new cdk.CfnParameter(cdk.Stack.of(this), 'VlmConfigArn', {
      type: 'String',
      description: 'Secrets Manager ARN containing DOUBAO_VLM_API_KEY',
    });
    const cloudFrontPrefixListId = new cdk.CfnParameter(cdk.Stack.of(this), 'CloudFrontPrefixListId', {
      type: 'String',
      description: 'Regional ID for com.amazonaws.global.cloudfront.origin-facing',
      allowedPattern: '^pl-[a-z0-9]+$',
    });
    const originHeaderSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'CloudFrontOriginHeaderSecret',
      `/anywear/${props.stage}/cloudfront_origin_header`,
    );
    const originHeaderValue = originHeaderSecret.secretValue.unsafeUnwrap();
    const qWeatherApiHost = ssm.StringParameter.valueForStringParameter(
      this,
      `/anywear/${props.stage}/qweather_api_host`,
    );
    this.cluster = props.cluster;
    let origin: cloudfront.IOrigin;
    let targetGroup: elasticloadbalancingv2.ApplicationTargetGroup | undefined;
    if (active) {
    new ec2.CfnSecurityGroupIngress(this, 'CloudFrontOriginIngress', {
      groupId: props.loadBalancerSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 80,
      toPort: 80,
      sourcePrefixListId: cloudFrontPrefixListId.valueAsString,
      description: 'CloudFront origin-facing network only',
    });

    this.loadBalancer = new elasticloadbalancingv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      loadBalancerName: `${props.stage}-anywear-api`,
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.loadBalancerSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    targetGroup = new elasticloadbalancingv2.ApplicationTargetGroup(this, 'ApiTargetGroup', {
      targetGroupName: `${props.stage}-anywear-api`,
      vpc: props.vpc,
      port: 3000,
      protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
      targetType: elasticloadbalancingv2.TargetType.IP,
      healthCheck: {
        path: '/readyz',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });
    const listener = this.loadBalancer.addListener('HttpListener', {
      port: 80,
      protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elasticloadbalancingv2.ListenerAction.fixedResponse(403, {
        contentType: 'application/json',
        messageBody: '{"error":"forbidden_origin"}',
      }),
    });
    listener.addAction('CloudFrontVerifiedOrigin', {
      priority: 1,
      conditions: [elasticloadbalancingv2.ListenerCondition.httpHeader(
        'X-AnyWear-Origin-Verify',
        [originHeaderValue],
      )],
      action: elasticloadbalancingv2.ListenerAction.forward([targetGroup]),
    });

    origin = new origins.LoadBalancerV2Origin(this.loadBalancer, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      readTimeout: cdk.Duration.seconds(60),
      keepaliveTimeout: cdk.Duration.seconds(60),
      customHeaders: { 'X-AnyWear-Origin-Verify': originHeaderValue },
    });
    } else {
      origin = origins.S3BucketOrigin.withOriginAccessControl(maintenanceBucket!);
    }
    this.distribution = new cloudfront.Distribution(this, 'ApiDistribution', {
      comment: `${props.stage} AnyWear API`,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        compress: false,
        ...(active ? {} : {
          functionAssociations: [{
            function: maintenanceResponse!,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          }],
        }),
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
    });

    const image = ecs.ContainerImage.fromRegistry(
      `${props.repository.repositoryUri}@${imageDigest.valueAsString}`,
    );
    const retention = props.stage === 'prod' ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS;
    const apiLogGroup = this.createLogGroup('ApiLogGroup', `/anywear/${props.stage}/api`, retention, props.stage);
    const workerLogGroup = this.createLogGroup('WorkerLogGroup', `/anywear/${props.stage}/worker`, retention, props.stage);

    if (props.stage === 'beta') {
      new cdk.CfnOutput(cdk.Stack.of(this), 'BetaActive', { value: String(active) });
    }
    if (!active) {
      new cdk.CfnOutput(cdk.Stack.of(this), 'ServiceRepositoryUri', { value: props.repository.repositoryUri });
      new cdk.CfnOutput(cdk.Stack.of(this), 'ApiDistributionDomainName', {
        value: this.distribution.distributionDomainName,
      });
      new cdk.CfnOutput(cdk.Stack.of(this), 'ApiBaseUrl', {
        value: `https://${this.distribution.distributionDomainName}`,
      });
      return;
    }

    const apiTaskRole = this.createTaskRole('ApiTaskRole', `${props.stage}-anywear-api-task`);
    const apiExecutionRole = this.createTaskRole('ApiExecutionRole', `${props.stage}-anywear-api-execution`);
    const workerTaskRole = this.createTaskRole('WorkerTaskRole', `${props.stage}-anywear-worker-task`);
    const workerExecutionRole = this.createTaskRole('WorkerExecutionRole', `${props.stage}-anywear-worker-execution`);

    for (const role of [apiExecutionRole, workerExecutionRole]) {
      props.repository.grantPull(role);
      role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'));
    }
    props.database.secret?.grantRead(apiTaskRole);
    props.database.secret?.grantRead(workerTaskRole);
    props.wardrobeBucket.grantReadWrite(apiTaskRole);
    props.wardrobeBucket.grantReadWrite(workerTaskRole);
    props.vtoQueue.grantSendMessages(workerTaskRole);
    props.vtoQueue.grantConsumeMessages(workerTaskRole);
    props.autoTaggingQueue.grantSendMessages(workerTaskRole);
    props.autoTaggingQueue.grantConsumeMessages(workerTaskRole);

    const commonEnvironment: Record<string, string> = {
      STAGE: props.stage,
      NODE_ENV: 'production',
      AWS_REGION: cdk.Stack.of(this).region,
      DB_SECRET_ARN: props.database.secret?.secretArn ?? '',
      DB_HOST: props.database.clusterEndpoint.hostname,
      DB_PORT: props.database.clusterEndpoint.port.toString(),
      DB_NAME: 'anywear',
      S3_BUCKET_NAME: props.wardrobeBucket.bucketName,
      TASK_TRANSPORT: 'sqs',
      SQS_VTO_QUEUE_URL: props.vtoQueue.queueUrl,
      SQS_AUTO_TAGGING_QUEUE_URL: props.autoTaggingQueue.queueUrl,
      SERVICE_COMMIT_SHA: serviceCommit.valueAsString,
      IMAGE_DIGEST: imageDigest.valueAsString,
    };

    const apiTaskDefinition = new ecs.FargateTaskDefinition(this, 'ApiTaskDefinition', {
      family: `${props.stage}-anywear-api`,
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole: apiTaskRole,
      executionRole: apiExecutionRole,
    });
    apiTaskDefinition.addContainer('ApiContainer', {
      image,
      command: ['node', 'dist/api.js'],
      environment: {
        ...commonEnvironment,
        PORT: '3000',
        COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
        COGNITO_CLIENT_ID: props.cognitoClientId,
        QWEATHER_API_HOST: qWeatherApiHost,
      },
      secrets: {
        QWEATHER_API_KEY: ecs.Secret.fromSecretsManager(props.qWeatherApiKeySecret),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: apiLogGroup, streamPrefix: 'api' }),
      portMappings: [{ containerPort: 3000, name: 'http', appProtocol: ecs.AppProtocol.http }],
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "fetch(\'http://127.0.0.1:3000/readyz\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    const workerTaskDefinition = new ecs.FargateTaskDefinition(this, 'WorkerTaskDefinition', {
      family: `${props.stage}-anywear-worker`,
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole: workerTaskRole,
      executionRole: workerExecutionRole,
    });
    workerTaskDefinition.addContainer('WorkerContainer', {
      image,
      command: ['node', 'dist/worker.js'],
      environment: { ...commonEnvironment, VLM_DEFAULT_PROVIDER: 'doubao' },
      secrets: {
        DOUBAO_VLM_API_KEY: ecs.Secret.fromSecretsManager(
          cdk.aws_secretsmanager.Secret.fromSecretCompleteArn(this, 'ProviderSecret', providerSecretArn.valueAsString),
          'DOUBAO_VLM_API_KEY',
        ),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: workerLogGroup, streamPrefix: 'worker' }),
    });

    this.apiService = new ecs.FargateService(this, 'ApiService', {
      serviceName: `${props.stage}-anywear-api`,
      cluster: this.cluster,
      taskDefinition: apiTaskDefinition,
      // Beta's single-user baseline keeps one API task; Production retains HA.
      desiredCount: props.stage === 'beta' ? 1 : 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
      assignPublicIp: false,
      securityGroups: [props.apiSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      enableExecuteCommand: false,
    });
    this.apiService.attachToApplicationTargetGroup(targetGroup!);

    this.workerService = new ecs.FargateService(this, 'WorkerService', {
      serviceName: `${props.stage}-anywear-worker`,
      cluster: this.cluster,
      taskDefinition: workerTaskDefinition,
      desiredCount: 1,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
      assignPublicIp: false,
      securityGroups: [props.workerSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      enableExecuteCommand: false,
    });

    const apiScaling = this.apiService.autoScaleTaskCount({
      minCapacity: props.stage === 'beta' ? 1 : 2,
      maxCapacity: props.stage === 'prod' ? 10 : 4,
    });
    apiScaling.scaleOnCpuUtilization('ApiCpuScaling', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(1),
    });

    const workerScaling = this.workerService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: props.stage === 'prod' ? 20 : 4,
    });
    workerScaling.scaleOnMetric('QueueDepthScaling', {
      metric: new cloudwatch.MathExpression({
        expression: 'vto + tagging',
        usingMetrics: {
          vto: props.vtoQueue.metricApproximateNumberOfMessagesVisible(),
          tagging: props.autoTaggingQueue.metricApproximateNumberOfMessagesVisible(),
        },
        period: cdk.Duration.minutes(1),
      }),
      adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      scalingSteps: [
        { upper: 0, change: -1 },
        { lower: 1, change: +1 },
        { lower: 10, change: +2 },
      ],
      cooldown: cdk.Duration.minutes(1),
    });

    this.createAlarms(props);

    new cdk.CfnOutput(cdk.Stack.of(this), 'ServiceRepositoryUri', { value: props.repository.repositoryUri });
    new cdk.CfnOutput(cdk.Stack.of(this), 'ApiServiceName', { value: this.apiService.serviceName });
    new cdk.CfnOutput(cdk.Stack.of(this), 'WorkerServiceName', { value: this.workerService.serviceName });
    new cdk.CfnOutput(cdk.Stack.of(this), 'ApiLoadBalancerDnsName', {
      value: this.loadBalancer!.loadBalancerDnsName,
      description: 'Origin only; direct access is restricted to CloudFront',
    });
    new cdk.CfnOutput(cdk.Stack.of(this), 'ApiDistributionDomainName', {
      value: this.distribution.distributionDomainName,
    });
    new cdk.CfnOutput(cdk.Stack.of(this), 'ApiBaseUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
    });
  }

  private createTaskRole(id: string, roleName: string): iam.Role {
    return new iam.Role(this, id, {
      roleName,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
  }

  private createLogGroup(
    id: string,
    logGroupName: string,
    retention: logs.RetentionDays,
    stage: string,
  ): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      logGroupName,
      retention,
      removalPolicy: stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
  }

  private createAlarms(props: ComputeRuntimeProps): void {
    const alarmProps = {
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    } as const;
    const addAction = (alarm: cloudwatch.Alarm) => {
      if (props.operationsTopic && props.stage === 'beta') {
        alarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.operationsTopic));
      }
    };
    const vtoDlqAlarm = new cloudwatch.Alarm(this, 'VtoDlqAlarm', {
      ...alarmProps,
      alarmName: `${props.stage}-anywear-vto-dlq-not-empty`,
      metric: props.vtoDeadLetterQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    addAction(vtoDlqAlarm);
    const autoTaggingDlqAlarm = new cloudwatch.Alarm(this, 'AutoTaggingDlqAlarm', {
      ...alarmProps,
      alarmName: `${props.stage}-anywear-auto-tagging-dlq-not-empty`,
      metric: props.autoTaggingDeadLetterQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    addAction(autoTaggingDlqAlarm);
    for (const [id, queue] of [['VtoAgeAlarm', props.vtoQueue], ['AutoTaggingAgeAlarm', props.autoTaggingQueue]] as const) {
      const alarm = new cloudwatch.Alarm(this, id, {
        ...alarmProps,
        alarmName: `${props.stage}-anywear-${id === 'VtoAgeAlarm' ? 'vto' : 'auto-tagging'}-oldest-message`,
        metric: queue.metricApproximateAgeOfOldestMessage(),
        threshold: 300,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
      });
      addAction(alarm);
    }
    const apiCpuAlarm = new cloudwatch.Alarm(this, 'ApiCpuAlarm', {
      ...alarmProps,
      alarmName: `${props.stage}-anywear-api-high-cpu`,
      metric: this.apiService!.metricCpuUtilization(),
      threshold: 85,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
    });
    addAction(apiCpuAlarm);
  }
}
