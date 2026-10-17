import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { AsyncRuntime } from './async-runtime';
import type { ArtifactInputs } from './artifact-inputs';
import { readIdentityPhase, type IdentityPhase } from './identity-phase';
import { grantBetaDedicatedRoles } from './beta-role-grants';

export const DEFAULT_QWEATHER_API_HOST = 'jt4d94d58q.re.qweatherapi.com';

export interface PlatformStackProps extends cdk.StackProps {
  stage: string;
  artifactInputs: ArtifactInputs;
  identityPhase?: IdentityPhase;
  ecrImageRetention?: boolean;
  environmentRunning?: boolean;
  qWeatherApiHost?: string;
}

export class PlatformStack extends cdk.Stack {
  readonly stageName: string;
  readonly repository: ecr.Repository;
  readonly vtoQueue: sqs.Queue;
  readonly vtoDeadLetterQueue: sqs.Queue;
  readonly autoTaggingQueue: sqs.Queue;
  readonly autoTaggingDeadLetterQueue: sqs.Queue;
  readonly wardrobeBucket: s3.Bucket;
  readonly clientBucket?: s3.Bucket;
  readonly clientDistribution?: cloudfront.Distribution;
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly qWeatherApiKeySecret: secretsmanager.ISecret;
  readonly vpc?: ec2.Vpc;
  readonly database?: rds.DatabaseCluster;
  readonly cluster?: ecs.Cluster;
  readonly apiSecurityGroup?: ec2.SecurityGroup;
  readonly workerSecurityGroup?: ec2.SecurityGroup;
  readonly oneShotSecurityGroup?: ec2.SecurityGroup;
  readonly loadBalancerSecurityGroup?: ec2.SecurityGroup;
  readonly migrationTaskRole?: iam.Role;
  readonly verificationTaskRole?: iam.Role;
  readonly oneShotExecutionRole?: iam.Role;
  readonly oneShotLogGroup?: logs.LogGroup;
  readonly operationsTopic?: sns.Topic;
  readonly lifecycleTaskRole?: iam.Role;
  readonly cleanupTaskRole?: iam.Role;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    const { stage } = props;
    this.stageName = stage;
    const isDev = stage === 'dev';
    const isNonProd = stage === 'dev' || stage === 'beta';
    const isProd = stage === 'prod';
    const environmentRunning = stage !== 'beta' || props.environmentRunning !== false;
    const identityPhase = readIdentityPhase(props.identityPhase);
    const asyncRuntime = new AsyncRuntime(this, 'AsyncRuntime', {
      stage, production: isProd, runtimePolicy: props.artifactInputs.runtimePolicy,
      ecrImageRetention: props.ecrImageRetention,
    });
    this.repository = asyncRuntime.repository;
    this.vtoQueue = asyncRuntime.vtoQueue;
    this.vtoDeadLetterQueue = asyncRuntime.vtoDeadLetterQueue;
    this.autoTaggingQueue = asyncRuntime.autoTaggingQueue;
    this.autoTaggingDeadLetterQueue = asyncRuntime.autoTaggingDeadLetterQueue;

    if (stage === 'beta') {
      this.operationsTopic = new sns.Topic(this, 'OperationsTopic', {
        topicName: 'beta-anywear-operations',
        displayName: 'AnyWear Beta operations',
      });
      for (const email of ['windy005@126.com', 'luma26c@gmail.com'] as const) {
        this.operationsTopic.addSubscription(new snsSubscriptions.EmailSubscription(email));
      }
    }

    this.vpc = isDev ? undefined : new ec2.Vpc(this, 'AnyWearVpc', {
      maxAzs: 2,
      natGateways: environmentRunning ? 1 : 0,
      ...(stage === 'beta' ? {
        subnetConfiguration: [
          { name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
          {
            name: 'Private',
            subnetType: environmentRunning ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PRIVATE_ISOLATED,
          },
          // Keep a dedicated isolated tier in both active and stopped states so
          // the VPC topology remains stable while paid compute is scaled down.
          { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        ],
      } : {}),
    });

    const preSignUpLambda = isNonProd
      ? new lambdaNodejs.NodejsFunction(this, 'PreSignUpLambda', {
          functionName: `${stage}-anywear-pre-sign-up`,
          runtime: lambda.Runtime.NODEJS_24_X,
          code: lambda.Code.fromAsset(props.artifactInputs.lambdas['pre-sign-up'].path),
          handler: 'index.handler',
          environment: { STAGE: stage },
        })
      : undefined;
    if (preSignUpLambda && stage === 'beta') {
      this.setLambdaLogRetention(preSignUpLambda, logs.RetentionDays.TWO_WEEKS);
    }

    const syncLambda = new lambdaNodejs.NodejsFunction(this, 'PostConfirmationSyncLambda', {
      functionName: `${stage}-anywear-post-confirmation-sync`,
      runtime: lambda.Runtime.NODEJS_24_X,
      code: lambda.Code.fromAsset(props.artifactInputs.lambdas['post-confirmation'].path),
      handler: 'index.handler',
      vpc: this.vpc,
      vpcSubnets: this.vpc
        ? { subnetType: environmentRunning ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PRIVATE_ISOLATED }
        : undefined,
      environment: { STAGE: stage },
      timeout: cdk.Duration.seconds(30),
    });
    if (stage === 'beta') {
      this.setLambdaLogRetention(syncLambda, logs.RetentionDays.TWO_WEEKS);
    }
    const betaAdmissionParameters: ssm.StringParameter[] = [];
    if (stage === 'beta') {
      // CloudFormation creates fail-closed defaults. Lifecycle operations own
      // runtime values, so deploys never include the current tester list. The
      // admission decision is one JSON record that carries its own bound, so a
      // reader enforces the expiry instead of remembering it, and an abandoned
      // window closes itself on this surface with no writer and no deployment.
      for (const [id, name, value] of [
        ['AdmissionMode', 'admission_mode', '{"mode":"closed"}'],
        ['TesterAllowlist', 'tester_allowlist', '[]'],
      ] as const) {
        betaAdmissionParameters.push(new ssm.StringParameter(this, id, {
          parameterName: `/anywear/beta/${name}`,
          stringValue: value,
        }));
      }
      for (const trigger of [preSignUpLambda!, syncLambda]) {
        trigger.addToRolePolicy(new iam.PolicyStatement({
          actions: ['ssm:GetParameter', 'ssm:GetParameters'],
          resources: betaAdmissionParameters.map((parameter) => parameter.parameterArn),
        }));
      }
    }

    this.userPool = new cognito.UserPool(this, 'AnyWearUserPool', {
      userPoolName: `${stage}-anywear-user-pool`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      customAttributes: {
        e2e_bootstrap: new cognito.StringAttribute({ mutable: false }),
      },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      lambdaTriggers: {
        ...(preSignUpLambda ? { preSignUp: preSignUpLambda } : {}),
        postConfirmation: syncLambda,
      },
    });
    this.userPoolClient = new cognito.UserPoolClient(this, 'AnyWearUserPoolClient', {
      userPool: this.userPool,
      generateSecret: false,
      readAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({ email: true, emailVerified: true })
        .withCustomAttributes('e2e_bootstrap'),
      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ email: true }),
      authFlows: { userSrp: true, ...(stage === 'beta' ? { adminUserPassword: true } : {}) },
    });

    new ssm.StringParameter(this, 'UserPoolIdParam', {
      parameterName: `/anywear/${stage}/cognito_user_pool_id`,
      stringValue: this.userPool.userPoolId,
    });
    new ssm.StringParameter(this, 'UserPoolClientIdParam', {
      parameterName: `/anywear/${stage}/cognito_client_id`,
      stringValue: this.userPoolClient.userPoolClientId,
    });

    this.wardrobeBucket = new s3.Bucket(this, 'AnyWearWardrobeBucket', {
      bucketName: `${stage}-anywear-wardrobe-bucket-${this.account}-${this.region}`,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      lifecycleRules: [{
        id: 'ExpireUnpromotedTaskAttempts',
        prefix: 'task-attempts/',
        expiration: cdk.Duration.days(7),
      }],
      cors: [{
        allowedMethods: [
          s3.HttpMethods.GET,
          s3.HttpMethods.PUT,
          s3.HttpMethods.POST,
          s3.HttpMethods.DELETE,
          s3.HttpMethods.HEAD,
        ],
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
        exposedHeaders: ['ETag'],
      }],
    });

    if (stage === 'beta') {
      this.clientBucket = new s3.Bucket(this, 'AnyWearClientBucket', {
        bucketName: `beta-anywear-client-${this.account}-${this.region}`,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        autoDeleteObjects: true,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      this.clientDistribution = new cloudfront.Distribution(this, 'AnyWearClientDistribution', {
        comment: 'beta AnyWear Client',
        defaultBehavior: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.clientBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        errorResponses: [
          { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
          { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
        ],
        enableIpv6: true,
      });
    }

    new ssm.StringParameter(this, 'WardrobeBucketNameParam', {
      parameterName: `/anywear/${stage}/s3_bucket_name`,
      stringValue: this.wardrobeBucket.bucketName,
    });
    new ssm.StringParameter(this, 'AwsRegionParam', {
      parameterName: `/anywear/${stage}/aws_region`,
      stringValue: this.region,
    });
    this.qWeatherApiKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'QWeatherApiKeySecret',
      `/anywear/${stage}/qweather_api_key`,
    );
    const qWeatherApiHost = props.qWeatherApiHost || DEFAULT_QWEATHER_API_HOST;
    new ssm.StringParameter(this, 'QWeatherApiHostParam', {
      parameterName: `/anywear/${stage}/qweather_api_host`,
      stringValue: qWeatherApiHost,
    });

    const pipelineRole = iam.Role.fromRoleName(
      this,
      'GitHubActionsPipelineRole',
      `${stage}-github-actions-pipeline-role`,
      { mutable: stage !== 'beta' || identityPhase !== 'retired' },
    );
    this.wardrobeBucket.grantReadWrite(pipelineRole);
    if (this.clientBucket && this.clientDistribution) {
      this.clientBucket.grantReadWrite(pipelineRole);
      pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [this.clientDistribution.distributionArn],
      }));
    }
    this.repository.grantPullPush(pipelineRole);
    pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks', 'ec2:DescribeManagedPrefixLists', 'ecr:DescribeImages'],
      resources: ['*'],
    }));

    if (isNonProd) {
      this.userPool.grant(
        pipelineRole,
        'cognito-idp:AdminConfirmSignUp',
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminDeleteUser',
        'cognito-idp:GetUser',
        'cognito-idp:AdminSetUserPassword',
      );
    }
    if (stage === 'beta') {
      this.userPool.grant(
        pipelineRole,
        'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminInitiateAuth',
      );
    }

    if (this.vpc) {
      if (stage === 'beta') {
        this.vpc.addGatewayEndpoint('S3GatewayEndpoint', {
          service: ec2.GatewayVpcEndpointAwsService.S3,
          subnets: [{ subnetType: environmentRunning ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PRIVATE_ISOLATED }],
        });
      }
      this.database = new rds.DatabaseCluster(this, 'AnyWearDatabase', {
        engine: rds.DatabaseClusterEngine.auroraPostgres({
          version: rds.AuroraPostgresEngineVersion.VER_17_7,
        }),
        writer: rds.ClusterInstance.serverlessV2('writer'),
        serverlessV2MinCapacity: stage === 'beta' ? 0 : 0.5,
        serverlessV2MaxCapacity: 2,
        serverlessV2AutoPauseDuration: stage === 'beta' ? cdk.Duration.minutes(5) : undefined,
        storageEncrypted: true,
        vpc: this.vpc,
        vpcSubnets: {
          subnetType: environmentRunning ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PRIVATE_ISOLATED,
        },
        defaultDatabaseName: 'anywear',
        backup: {
          retention: cdk.Duration.days(isProd ? 35 : 7),
          preferredWindow: '16:00-16:30',
        },
        removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        // Aurora has no instance-level deletion protection; the cluster carries
        // it, and the production writer instance's DeletionPolicy follows the
        // cluster removal policy.
        deletionProtection: true,
      });
      cdk.Validations.of(this.database).acknowledge({
        id: 'CloudFormation-Validate::W9008',
        reason: 'Aurora DB instances inherit StorageEncrypted from the encrypted DB cluster.',
      });

      const clusterName = `${stage}-anywear`;
      this.cluster = new ecs.Cluster(this, 'Cluster', {
        clusterName,
        vpc: this.vpc,
        containerInsightsV2: ecs.ContainerInsights.ENABLED,
      });
      if (stage === 'beta') {
        // Apply retention to the AWS-managed group without adopting or replacing it.
        new logs.LogRetention(this, 'ContainerInsightsLogRetention', {
          logGroupName: `/aws/ecs/containerinsights/${clusterName}/performance`,
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
      }
      this.apiSecurityGroup = new ec2.SecurityGroup(this, 'ApiSecurityGroup', {
        vpc: this.vpc,
        allowAllOutbound: true,
        description: 'Ingress is allowed only from the AnyWear ALB',
      });
      this.workerSecurityGroup = new ec2.SecurityGroup(this, 'WorkerSecurityGroup', {
        vpc: this.vpc,
        allowAllOutbound: true,
        description: 'AnyWear private worker egress and database access',
      });
      this.oneShotSecurityGroup = new ec2.SecurityGroup(this, 'OneShotSecurityGroup', {
        vpc: this.vpc,
        allowAllOutbound: true,
        description: 'Migration and deployment verification task egress',
      });
      this.loadBalancerSecurityGroup = new ec2.SecurityGroup(this, 'LoadBalancerSecurityGroup', {
        vpc: this.vpc,
        allowAllOutbound: true,
        description: 'CloudFront origin-facing ingress only',
      });
      this.apiSecurityGroup.addIngressRule(this.loadBalancerSecurityGroup, ec2.Port.tcp(3000), 'ALB to API');
      this.database.connections.allowFrom(this.apiSecurityGroup, ec2.Port.tcp(5432), 'API to PostgreSQL');
      this.database.connections.allowFrom(this.workerSecurityGroup, ec2.Port.tcp(5432), 'Worker to PostgreSQL');
      this.database.connections.allowFrom(this.oneShotSecurityGroup, ec2.Port.tcp(5432), 'One-shot tasks to PostgreSQL');
      this.database.connections.allowFrom(syncLambda, ec2.Port.tcp(5432));
      this.database.secret?.grantRead(syncLambda);
      syncLambda.addEnvironment('DB_SECRET_ARN', this.database.secret?.secretArn || '');
      syncLambda.addEnvironment('DB_HOST', this.database.clusterEndpoint.hostname);
      syncLambda.addEnvironment('DB_PORT', this.database.clusterEndpoint.port.toString());
      syncLambda.addEnvironment('DB_NAME', 'anywear');

      this.migrationTaskRole = new iam.Role(this, 'MigrationTaskRole', {
        roleName: `${stage}-anywear-migration-task`,
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      });
      this.verificationTaskRole = new iam.Role(this, 'VerificationTaskRole', {
        roleName: `${stage}-anywear-verification-task`,
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      });
      this.oneShotExecutionRole = new iam.Role(this, 'OneShotExecutionRole', {
        roleName: `${stage}-anywear-one-shot-execution`,
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      });
      this.oneShotExecutionRole.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      );
      this.repository.grantPull(this.oneShotExecutionRole);
      this.database.secret?.grantRead(this.migrationTaskRole);
      this.database.secret?.grantRead(this.verificationTaskRole);
      if (stage === 'beta') {
        this.lifecycleTaskRole = new iam.Role(this, 'LifecycleTaskRole', {
          roleName: 'beta-anywear-lifecycle-task',
          assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });
        this.database.secret?.grantRead(this.lifecycleTaskRole);
        if (identityPhase !== 'legacy') {
          this.cleanupTaskRole = new iam.Role(this, 'CleanupTaskRole', {
            roleName: 'beta-anywear-tester-cleanup-task', assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
          });
          this.database.secret?.grantRead(this.cleanupTaskRole);
          this.cleanupTaskRole.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility'],
            resources: [this.vtoDeadLetterQueue.queueArn, this.autoTaggingDeadLetterQueue.queueArn],
          }));
          new cdk.CfnOutput(this, 'CleanupTaskRoleArn', { value: this.cleanupTaskRole.roleArn });
        }
        this.lifecycleTaskRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:PutParameter'],
          resources: betaAdmissionParameters.map((parameter) => parameter.parameterArn),
        }));
        this.lifecycleTaskRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['sqs:GetQueueAttributes'],
          resources: [
            this.vtoQueue.queueArn, this.autoTaggingQueue.queueArn,
            this.vtoDeadLetterQueue.queueArn, this.autoTaggingDeadLetterQueue.queueArn,
          ],
        }));
        this.lifecycleTaskRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility'],
          resources: [this.vtoDeadLetterQueue.queueArn, this.autoTaggingDeadLetterQueue.queueArn],
        }));
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['ecs:ListTasks'],
          resources: ['*'],
          conditions: { ArnEquals: { 'ecs:cluster': this.cluster.clusterArn } },
        }));
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [this.lifecycleTaskRole.roleArn],
          conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
        }));
        const regionCondition = { StringEquals: { 'aws:RequestedRegion': this.region } };
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['cloudformation:ListStackResources'],
          resources: [this.stackId],
          conditions: regionCondition,
        }));
        const ownedFunctionNames = ['beta-anywear-pre-sign-up', 'beta-anywear-post-confirmation-sync', 'AnyWearPlatformStack-beta-*'];
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['logs:PutRetentionPolicy'],
          resources: ownedFunctionNames.map((name) => `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${name}:*`),
          conditions: regionCondition,
        }));
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['lambda:GetFunction'],
          resources: ownedFunctionNames.map((name) => `arn:aws:lambda:${this.region}:${this.account}:function:${name}`),
          conditions: regionCondition,
        }));
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['logs:DescribeLogGroups'],
          resources: ['*'],
          conditions: regionCondition,
        }));
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['rds:DescribeDBClusters', 'rds:DescribeEvents', 'cloudwatch:GetMetricStatistics'],
          resources: ['*'],
          conditions: regionCondition,
        }));
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['ecs:ListTaskDefinitions', 'ecs:DescribeTaskDefinition'],
          resources: ['*'],
          conditions: regionCondition,
        }));
        new cdk.CfnOutput(this, 'LifecycleTaskRoleArn', { value: this.lifecycleTaskRole.roleArn });
        new cdk.CfnOutput(this, 'BetaActive', { value: String(environmentRunning) });
      }
      this.oneShotLogGroup = new logs.LogGroup(this, 'OneShotLogGroup', {
        logGroupName: `/anywear/${stage}/one-shot`,
        retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS,
        removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      });

      pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: stage === 'beta' ? ['ecs:RunTask', 'ecs:DescribeTasks', 'ecs:DescribeServices'] : [
          'ecs:RegisterTaskDefinition',
          'ecs:DeregisterTaskDefinition',
          'ecs:RunTask',
          'ecs:DescribeTasks',
          'ecs:DescribeServices',
        ],
        resources: ['*'],
      }));
      pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [
          this.migrationTaskRole.roleArn,
          this.verificationTaskRole.roleArn,
          this.oneShotExecutionRole.roleArn,
        ],
        ...(stage === 'beta' ? { conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } } } : {}),
      }));
      if (stage === 'beta') {
        const taskDefinitionArn = (family: string) => this.formatArn({
          service: 'ecs', resource: 'task-definition', resourceName: `${family}:*`,
          arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
        });
        const oneShotFamilies = ['migrate', 'verify', 'lifecycle', 'tester-cleanup', 'task-audit'];
        const oneShotDefinitions = oneShotFamilies.map((purpose) => taskDefinitionArn(`beta-anywear-${purpose}`));
        const evidenceFamilies = ['migrate', 'verify', 'lifecycle', 'lifecycle-fixture'];
        const costDefinitions = [taskDefinitionArn('beta-anywear-lifecycle-fixture'),
          ...evidenceFamilies.map((purpose) => taskDefinitionArn(`beta-anywear-${purpose}-evidence-*`))];
        const nonpaidDefinition = taskDefinitionArn('beta-anywear-nonpaid-*');
        const regionCondition = { StringEquals: { 'aws:RequestedRegion': this.region } };
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['ecs:RegisterTaskDefinition'], resources: oneShotDefinitions,
          conditions: regionCondition,
        }));
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['ecs:RegisterTaskDefinition'], resources: [nonpaidDefinition],
          conditions: { ...regionCondition, StringLike: { 'aws:RequestTag/anywear-runtime-run-scope': '?*' } },
        }));
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['ecs:RegisterTaskDefinition'], resources: costDefinitions,
          conditions: { ...regionCondition, StringLike: { 'aws:RequestTag/anywear-lifecycle-evidence-run-scope': '?*' } },
        }));
        // These exact grants need a managed policy to fit the role's aggregate inline quota.
        if (identityPhase !== 'retired') new iam.ManagedPolicy(this, 'BetaPipelineTaskEvidencePolicy', {
          roles: [pipelineRole],
          statements: [
            new iam.PolicyStatement({
              actions: ['ecs:TagResource'], resources: [...oneShotDefinitions, nonpaidDefinition, ...costDefinitions],
              conditions: { StringEquals: { ...regionCondition.StringEquals, 'ecs:CreateAction': 'RegisterTaskDefinition' } },
            }),
            new iam.PolicyStatement({
              actions: ['ecs:ListTagsForResource'], resources: [
                ...oneShotDefinitions, nonpaidDefinition, ...costDefinitions,
                taskDefinitionArn('beta-anywear-worker'), taskDefinitionArn('beta-anywear-api'),
              ],
            }),
            new iam.PolicyStatement({
              actions: ['logs:GetLogEvents'], resources: [...oneShotFamilies, 'lifecycle-fixture',
                ...evidenceFamilies.map((purpose) => `${purpose}-evidence-*`)].map((purpose) => this.formatArn({
                service: 'logs', resource: 'log-group', resourceName: `/anywear/beta/one-shot:log-stream:beta-anywear-${purpose}/OneShot/*`,
                arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
              })), conditions: regionCondition,
            }),
          ],
        });
        // ECS does not support resource or tag scoping for these actions.
        // Deregistration was already granted; the runtime adapter must prove exact ownership.
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['ecs:DeregisterTaskDefinition',
            'application-autoscaling:DescribeScalableTargets', 'application-autoscaling:DescribeScalingPolicies',
            'application-autoscaling:DescribeScheduledActions'],
          resources: ['*'], conditions: regionCondition,
        }));
        const serviceArn = (name: string) => this.formatArn({
          service: 'ecs', resource: 'service', resourceName: `beta-anywear/beta-anywear-${name}`,
          arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
        });
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['ecs:UpdateService'], resources: [serviceArn('api')],
          conditions: { ArnEquals: { 'ecs:cluster': this.cluster.clusterArn },
            ArnLikeIfExists: { 'ecs:task-definition': taskDefinitionArn('beta-anywear-api') } },
        }));
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['ecs:UpdateService'], resources: [serviceArn('worker')],
          conditions: { ArnEquals: { 'ecs:cluster': this.cluster.clusterArn },
            ArnLike: { 'ecs:task-definition': [taskDefinitionArn('beta-anywear-worker'), nonpaidDefinition] } },
        }));
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['ecs:StopTask'], resources: [this.formatArn({
            service: 'ecs', resource: 'task', resourceName: 'beta-anywear/*', arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          })], conditions: { ArnEquals: { 'ecs:cluster': this.cluster.clusterArn } },
        }));
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['iam:PassRole'], resources: ['task', 'execution'].map((purpose) => this.formatArn({
            service: 'iam', region: '', resource: 'role', resourceName: `beta-anywear-worker-${purpose}`,
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          })), conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
        }));
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['logs:FilterLogEvents'], resources: ['api', 'worker'].map((purpose) => this.formatArn({
            service: 'logs', resource: 'log-group', resourceName: `/anywear/beta/${purpose}:*`,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          })),
        }));
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['sqs:GetQueueAttributes'], resources: [this.vtoQueue.queueArn, this.autoTaggingQueue.queueArn,
            this.vtoDeadLetterQueue.queueArn, this.autoTaggingDeadLetterQueue.queueArn],
        }));
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['sqs:ReceiveMessage', 'sqs:ChangeMessageVisibility'], resources: [this.autoTaggingDeadLetterQueue.queueArn],
        }));
        pipelineRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['ssm:GetParameter'], resources: betaAdmissionParameters.map((parameter) => parameter.parameterArn),
        }));
      }
    }

    if (stage === 'beta' && identityPhase !== 'legacy') {
      grantBetaDedicatedRoles(this, { platform: this, preSignUpLambda: preSignUpLambda!, syncLambda });
    }

    if (stage === 'beta') {
      this.createCustomResourceLogGroups(logs.RetentionDays.TWO_WEEKS);
    }

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'WardrobeBucketName', { value: this.wardrobeBucket.bucketName });
    if (this.clientBucket && this.clientDistribution) {
      new cdk.CfnOutput(this, 'ClientBucketName', { value: this.clientBucket.bucketName });
      new cdk.CfnOutput(this, 'ClientDistributionId', { value: this.clientDistribution.distributionId });
      new cdk.CfnOutput(this, 'ClientDistributionDomainName', { value: this.clientDistribution.distributionDomainName });
      new cdk.CfnOutput(this, 'ClientBaseUrl', { value: `https://${this.clientDistribution.distributionDomainName}` });
    }
    new cdk.CfnOutput(this, 'ServiceRepositoryUri', { value: this.repository.repositoryUri });
    new cdk.CfnOutput(this, 'ServiceRepositoryName', { value: this.repository.repositoryName });
    new cdk.CfnOutput(this, 'VtoQueueUrl', { value: this.vtoQueue.queueUrl });
    new cdk.CfnOutput(this, 'AutoTaggingQueueUrl', { value: this.autoTaggingQueue.queueUrl });
    if (stage === 'beta') {
      new cdk.CfnOutput(this, 'VtoDlqUrl', { value: this.vtoDeadLetterQueue.queueUrl });
      new cdk.CfnOutput(this, 'AutoTaggingDlqUrl', { value: this.autoTaggingDeadLetterQueue.queueUrl });
    }
    if (this.database && this.cluster && this.oneShotSecurityGroup && this.migrationTaskRole && this.verificationTaskRole && this.oneShotExecutionRole && this.oneShotLogGroup) {
      new cdk.CfnOutput(this, 'DatabaseEndpoint', { value: this.database.clusterEndpoint.socketAddress });
      new cdk.CfnOutput(this, 'DatabaseHost', { value: this.database.clusterEndpoint.hostname });
      new cdk.CfnOutput(this, 'DatabasePort', { value: this.database.clusterEndpoint.port.toString() });
      new cdk.CfnOutput(this, 'DatabaseName', { value: 'anywear' });
      new cdk.CfnOutput(this, 'DatabaseSecretArn', { value: this.database.secret?.secretArn ?? '' });
      new cdk.CfnOutput(this, 'EcsClusterName', { value: this.cluster.clusterName });
      new cdk.CfnOutput(this, 'OneShotSecurityGroupId', { value: this.oneShotSecurityGroup.securityGroupId });
      new cdk.CfnOutput(this, 'MigrationTaskRoleArn', { value: this.migrationTaskRole.roleArn });
      new cdk.CfnOutput(this, 'VerificationTaskRoleArn', { value: this.verificationTaskRole.roleArn });
      new cdk.CfnOutput(this, 'OneShotExecutionRoleArn', { value: this.oneShotExecutionRole.roleArn });
      new cdk.CfnOutput(this, 'OneShotLogGroupName', { value: this.oneShotLogGroup.logGroupName });
      new cdk.CfnOutput(this, 'PrivateSubnetIds', {
        value: cdk.Fn.join(',', [
          ...(environmentRunning ? this.vpc!.privateSubnets : this.vpc!.isolatedSubnets),
        ].map((subnet) => subnet.subnetId)),
      });
    }
  }

  private setLambdaLogRetention(functionResource: lambda.Function, retention: logs.RetentionDays): void {
    const logGroup = functionResource.node.tryFindChild('LogGroup');
    if (!logGroup) {
      new logs.LogGroup(functionResource, 'LogGroup', {
        logGroupName: `/aws/lambda/${functionResource.functionName}`,
        retention,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      return;
    }
    if (!(logGroup.node.defaultChild instanceof logs.CfnLogGroup)) {
      throw new Error(`Expected CDK-managed log group for ${functionResource.node.path}`);
    }
    logGroup.node.defaultChild.retentionInDays = retention;
  }

  private createCustomResourceLogGroups(retention: logs.RetentionDays): void {
    for (const provider of this.node.children.filter((child) => child.node.id.includes('CustomResourceProvider'))) {
      const handler = provider.node.tryFindChild('Handler');
      if (!(handler instanceof cdk.CfnResource)) {
        continue;
      }
      new logs.LogRetention(this, `${provider.node.id}LogRetention`, {
        logGroupName: cdk.Fn.join('', ['/aws/lambda/', handler.ref]),
        retention,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }
  }
}
