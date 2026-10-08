import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { PlatformStack } from './platform-stack';

// Trust is created in Foundation. Importing by physical name avoids introducing
// new Foundation/Platform exports or changing existing cross-stack references.
export function grantBetaDedicatedRoles(stack: cdk.Stack, props: {
  platform: PlatformStack;
  preSignUpLambda: lambda.Function;
  syncLambda: lambda.Function;
}): void {
  const p = props.platform;
  if (!p.cluster || !p.migrationTaskRole || !p.verificationTaskRole || !p.oneShotExecutionRole || !p.lifecycleTaskRole
    || !p.clientBucket || !p.clientDistribution || !p.cleanupTaskRole) throw new Error('Dedicated Beta roles require the existing Beta platform');
  const role = (id: string, name: string) => iam.Role.fromRoleName(stack, id, `beta-${name}-role`, {
    defaultPolicyName: 'DedicatedPolicy',
  });
  const deploy = role('InfraDeployRole', 'infra-deploy');
  const runtime = role('InfraRuntimeRole', 'infra-runtime');
  const data = role('ServiceDataRole', 'service-data');
  const client = role('ClientPublishRole', 'client-publish');
  const e2e = role('E2EQualificationRole', 'e2e-qualification');
  const regional = { StringEquals: { 'aws:RequestedRegion': stack.region } };
  const arn = (service: string, resource: string, resourceName: string, region = stack.region) => stack.formatArn({
    service, resource, resourceName, region,
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });
  const stackArns = ['AnyWearFoundationStack', 'AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta']
    .map((name) => arn('cloudformation', 'stack', `${name}/*`));
  const platformAndWorkload = stackArns.slice(1);
  const admissionNames = ['intake_open', 'tester_allowlist', 'admission_suspended'];
  const parameters = (names: string[]) => names.map((name) => arn('ssm', 'parameter', `anywear/beta/${name}`));
  const publicParameters = ['cognito_user_pool_id', 'cognito_client_id', 'aws_region', 's3_bucket_name', 'qweather_api_host'];
  const describeStacks = (principal: iam.IRole, resources = platformAndWorkload) => principal.addToPrincipalPolicy(
    new iam.PolicyStatement({ actions: ['cloudformation:DescribeStacks'], resources }),
  );
  const getParameters = (principal: iam.IRole, names: string[]) => principal.addToPrincipalPolicy(
    new iam.PolicyStatement({ actions: ['ssm:GetParameter', 'ssm:GetParameters'], resources: parameters(names) }),
  );
  const taskDefinition = (family: string) => arn('ecs', 'task-definition', `beta-anywear-${family}:*`);
  const services = ['api', 'worker'].map((name) => arn('ecs', 'service', `beta-anywear/beta-anywear-${name}`));
  const tasks = arn('ecs', 'task', 'beta-anywear/*');
  const clusterCondition = { ArnEquals: { 'ecs:cluster': p.cluster.clusterArn } };
  const describeRuntime = (principal: iam.IRole) => {
    principal.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['ecs:DescribeServices'], resources: services }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:DescribeTasks'], resources: [tasks], conditions: clusterCondition,
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:ListTasks'], resources: ['*'], conditions: clusterCondition,
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:DescribeTaskDefinition'],
      resources: ['*'], conditions: regional,
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecr:DescribeImages', 'ecr:BatchGetImage'], resources: [p.repository.repositoryArn],
    }));
  };
  const oneShots = (principal: iam.IRole, families: string[], passRoles: string[]) => {
    const definitions = families.map(taskDefinition);
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:RegisterTaskDefinition'], resources: definitions, conditions: regional,
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:TagResource'], resources: definitions,
      conditions: { StringEquals: { 'aws:RequestedRegion': stack.region, 'ecs:CreateAction': 'RegisterTaskDefinition' } },
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask'], resources: definitions, conditions: clusterCondition,
    }));
    // ECS deregistration has no supported resource scope. The reviewed helper
    // must verify exact task-family/run ownership before calling this action.
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:DeregisterTaskDefinition'], resources: ['*'], conditions: regional,
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'], resources: passRoles,
      conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['logs:GetLogEvents'],
      resources: families.map((family) => stack.formatArn({
        service: 'logs', resource: 'log-group', resourceName: `/anywear/beta/one-shot:log-stream:beta-anywear-${family}/OneShot/*`,
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      })),
    }));
  };

  // Artifact ECR grants live in Foundation, allowing artifact publication before
  // constructing the Platform app which requires sealed inputs.

  describeStacks(client);
  getParameters(client, ['cognito_user_pool_id', 'cognito_client_id']);
  client.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:ListBucket', 's3:GetBucketLocation'], resources: [p.clientBucket.bucketArn],
  }));
  client.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], resources: [p.clientBucket.arnForObjects('*')],
  }));
  client.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'], resources: [p.clientDistribution.distributionArn],
  }));

  // Application cleanup remains Service-owned and runs only its two reviewed
  // task families. Lifecycle configuration/start/stop belongs to Infra.
  describeStacks(data);
  describeRuntime(data);
  oneShots(data, ['verify', 'tester-cleanup'], [
    p.verificationTaskRole.roleArn, p.cleanupTaskRole.roleArn, p.oneShotExecutionRole.roleArn,
  ]);

  for (const principal of [deploy, runtime, e2e]) {
    describeStacks(principal, stackArns);
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:GetTemplate', 'cloudformation:ListStackResources'], resources: stackArns,
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate', 'cloudformation:ListStackResources'],
      resources: [arn('cloudformation', 'stack', 'AnyWearBillingStack-beta/*', process.env.BILLING_REGION || 'us-east-1')],
    }));
    getParameters(principal, [...publicParameters, ...admissionNames, 'infra_selection', 'infra_deployment']);
    describeRuntime(principal);
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['lambda:GetFunction', 'lambda:GetFunctionConfiguration'],
      resources: [props.preSignUpLambda.functionArn, props.syncLambda.functionArn],
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['sqs:GetQueueAttributes'], resources: [p.vtoQueue.queueArn, p.autoTaggingQueue.queueArn,
        p.vtoDeadLetterQueue.queueArn, p.autoTaggingDeadLetterQueue.queueArn],
    }));
  }
  deploy.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['ec2:DescribeManagedPrefixLists'], resources: ['*'], conditions: regional,
  }));
  // Workload synth resolves the existing CloudFront origin header; this is the
  // only runtime secret read required by the deployment consumer itself.
  deploy.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue'],
    resources: [`arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:/anywear/beta/cloudfront_origin_header-*`],
  }));
  runtime.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['ecr:PutImage', 'ecr:GetLifecyclePolicy', 'ecr:StartLifecyclePolicyPreview', 'ecr:GetLifecyclePolicyPreview'],
    resources: [p.repository.repositoryArn],
  }));
  runtime.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['ssm:PutParameter'], resources: parameters(['infra_selection', 'infra_deployment']),
  }));
  oneShots(runtime, ['migrate', 'verify', 'lifecycle', 'artifact-verify'], [
    p.migrationTaskRole.roleArn, p.verificationTaskRole.roleArn, p.lifecycleTaskRole.roleArn, p.oneShotExecutionRole.roleArn,
  ]);
  runtime.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['rds:DescribeDBClusters', 'rds:DescribeEvents', 'cloudwatch:GetMetricStatistics'],
    resources: ['*'], conditions: regional,
  }));
  oneShots(e2e, ['artifact-verify'], [
    p.verificationTaskRole.roleArn, p.oneShotExecutionRole.roleArn,
  ]);
  const ownedFunctionNames = ['beta-anywear-pre-sign-up', 'beta-anywear-post-confirmation-sync', 'AnyWearPlatformStack-beta-*'];
  runtime.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['logs:DescribeLogGroups'], resources: ['*'], conditions: regional }));
  runtime.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['lambda:GetFunction'],
    resources: ownedFunctionNames.map(name => `arn:aws:lambda:${stack.region}:${stack.account}:function:${name}`), conditions: regional }));
  runtime.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['logs:PutRetentionPolicy'],
    resources: ownedFunctionNames.map(name => `arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/lambda/${name}:*`), conditions: regional }));
  p.userPool.grant(e2e, 'cognito-idp:AdminConfirmSignUp', 'cognito-idp:AdminCreateUser', 'cognito-idp:AdminDeleteUser',
    'cognito-idp:GetUser', 'cognito-idp:AdminSetUserPassword', 'cognito-idp:AdminUpdateUserAttributes',
    'cognito-idp:AdminGetUser', 'cognito-idp:AdminInitiateAuth');
  e2e.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject'], resources: [p.wardrobeBucket.arnForObjects('*')],
  }));
  e2e.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['logs:FilterLogEvents'], resources: ['api', 'worker'].map((purpose) => stack.formatArn({
      service: 'logs', resource: 'log-group', resourceName: `/anywear/beta/${purpose}:*`,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    })),
  }));
  e2e.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['sqs:ReceiveMessage', 'sqs:ChangeMessageVisibility'], resources: [p.autoTaggingDeadLetterQueue.queueArn],
  }));
}
