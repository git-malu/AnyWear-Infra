import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  serviceDeployCfnRoleName,
  serviceDeployRoleName,
  serviceTrustSubject,
} from '@git-malu/stage-contracts';
import { readIdentityPhase, type IdentityPhase } from './identity-phase';
import { readLegacyRoleSource, type LegacyRoleSource } from './legacy-role-source';

export interface FoundationStackProps extends cdk.StackProps {
  identityPhase?: IdentityPhase;
  legacyRoleSource: LegacyRoleSource;
}

export class FoundationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);
    const identityPhase = readIdentityPhase(props?.identityPhase);
    const legacyRoleSource = readLegacyRoleSource(props.legacyRoleSource);
    if (legacyRoleSource === 'external' && (this.account !== '650880818323' || this.region !== 'ap-east-1')) {
      throw new Error('External legacy roles require the reviewed account 650880818323 in ap-east-1');
    }

    // Setup GitHub OIDC Trust Provider
    // This is a singleton resource per AWS Account
    const githubProvider = new iam.OpenIdConnectProvider(this, 'GitHubProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    new cdk.CfnOutput(this, 'GitHubOIDCProviderArn', {
      value: githubProvider.openIdConnectProviderArn,
      description: 'The ARN of the GitHub OIDC Provider',
    });

    // GitHub's immutable OIDC subject remains stable if a repository is
    // renamed, so trust only the owner/repository ID form.
    const serviceSubject = (stage: 'dev' | 'beta' | 'prod') =>
      `repo:git-malu@11473072/AnyWear-Service@1158460323:environment:${stage}`;
    const e2eSubject = (stage: 'dev' | 'beta') =>
      `repo:git-malu@11473072/AnyWear-E2E@1317091305:environment:${stage}`;
    const clientSubject = 'repo:git-malu@11473072/AnyWear-Client@1176104200:environment:beta';

    // The deployed Foundation owns only its OIDC provider/helpers. Existing
    // Dev/Beta pipeline identities stay outside it; no adoption or Prod creation.
    if (legacyRoleSource === 'cdk') for (const stage of ['dev', 'beta', 'prod'] as const) {
      const subjects = stage === 'beta' && identityPhase === 'retired' ? [
        // Preserve the role identity with an unmatchable retired subject. No
        // repository is trusted, including the new Infra repository.
        'anywear:retired:beta-github-actions-pipeline-role',
      ] : [
        serviceSubject(stage),
        ...(stage === 'prod' ? [] : [e2eSubject(stage)]),
        ...(stage === 'beta' ? [clientSubject] : []),
      ];
      const role = new iam.Role(this, `${stage}GitHubActionsRole`, {
        roleName: `${stage}-github-actions-pipeline-role`,
        assumedBy: new iam.WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': subjects,
          },
        }),
      });
      if (stage === 'beta' && identityPhase === 'retired') continue;
      // Beta billing controls are deployed in the account's billing home
      // region, while the application platform remains in ap-east-1.
      const cdkRoleRegions = stage === 'beta'
        ? [this.region, process.env.BILLING_REGION || 'us-east-1']
        : [this.region];
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: cdkRoleRegions.map((region) => (
          `arn:aws:iam::${this.account}:role/cdk-*-role-${this.account}-${region}`
        )),
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/anywear/${stage}/*`],
      }));
      const secretResources = [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/anywear/${stage}/cloudfront_origin_header-*`,
      ];
      if (stage === 'dev') {
        secretResources.push(
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/anywear/dev/qweather_api_key-*`,
        );
      }
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: secretResources,
      }));
    }

    if (identityPhase === 'legacy') return;
    const betaSubject = (repository: string, id: number) =>
      `repo:git-malu@11473072/${repository}@${id}:environment:beta`;
    const createRole = (constructId: string, name: string, subject: string) => new iam.Role(this, constructId, {
      roleName: `beta-${name}-role`,
      assumedBy: new iam.WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': subject,
        },
      }),
    });
    const infraSubject = betaSubject('AnyWear-Infra', 1409047265);
    const deploy = createRole('BetaInfraDeployRole', 'infra-deploy', infraSubject);
    createRole('BetaInfraRuntimeRole', 'infra-runtime', infraSubject);
    const artifacts = createRole('BetaServiceArtifactRole', 'service-artifact',
      'repo:git-malu@11473072/AnyWear-Service@1158460323:environment:service-artifacts');
    createRole('BetaServiceDataRole', 'service-data', betaSubject('AnyWear-Service', 1158460323));
    createRole('BetaClientPublishRole', 'client-publish', betaSubject('AnyWear-Client', 1176104200));
    createRole('BetaE2EQualificationRole', 'e2e-qualification', betaSubject('AnyWear-E2E', 1317091305));
    // Existing CDK bootstrap roles still own their reviewed deployment policies.
    // Direct callers cannot assume image-publishing or CFN execution roles.
    deploy.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [...new Set([this.region, process.env.BILLING_REGION || 'us-east-1'])]
        .flatMap((region) => ['deploy', 'file-publishing', 'lookup'].map((purpose) => (
          `arn:aws:iam::${this.account}:role/cdk-hnb659fds-${purpose}-role-${this.account}-${region}`
        ))),
    }));
    artifacts.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'], resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': this.region } },
    }));
    artifacts.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage',
        'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload', 'ecr:PutImage',
        'ecr:DescribeImages', 'ecr:DescribeImageScanFindings', 'ecr:ListImages', 'ecr:GetLifecyclePolicy'],
      resources: [`arn:aws:ecr:${this.region}:${this.account}:repository/beta-anywear-service`],
    }));

    // Issue #158 step A: the Service repository deploys its own release slice
    // with two reviewed identities. The OIDC role can only drive a
    // CloudFormation change set for AnyWearWorkloadStack-beta and pass one
    // execution role; that execution role is trusted by CloudFormation alone
    // and operates only the Workload stack's resource families. Neither role
    // carries a managed policy, `iam:*`, `*` or any VPC/Aurora/Cognito/SQS
    // configuration/ECR configuration/Foundation grant.
    // The versioned `@git-malu/stage-contracts` package owns the per-service role
    // naming and the immutable OIDC subject. The construct IDs and the resulting
    // template stay unchanged.
    const serviceDeploy = new iam.Role(this, 'BetaServiceDeployRole', {
      roleName: serviceDeployRoleName('service'),
      assumedBy: new iam.WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': serviceTrustSubject({
            repository: 'AnyWear-Service', repositoryId: 1158460323, environment: 'beta',
          }),
        },
      }),
    });
    const serviceCfn = new iam.Role(this, 'BetaServiceDeployCfnRole', {
      roleName: serviceDeployCfnRoleName('service'),
      assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
    });
    const slashArn = (service: string, resource: string, resourceName: string, region = this.region,
      account = this.account) => this.formatArn({
      service, resource, resourceName, region, account, arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
    const stackArn = (stackName: string) => slashArn('cloudformation', 'stack', `${stackName}/*`);
    const cloudformationStack = stackArn('AnyWearWorkloadStack-beta');
    // Change sets carry their own ARN; executing one still requires the target
    // stack ARN, which is limited to the Workload stack.
    const changeSetArn = slashArn('cloudformation', 'changeSet', '*');
    const platformStack = stackArn('AnyWearPlatformStack-beta');
    // Issue #158 round 3: the Service owner's synthesizer makes the CDK CLI use
    // the deploy job's own credentials. The CLI has no `--no-role` option (it
    // rejects `--role`), and `--role-arn beta-service-deploy-cfn-role` stays the
    // CloudFormation execution role. The CLI path therefore reads the bootstrap
    // version itself and publishes the synthesized template asset, `<hash>.json`
    // at the root of the dedicated CDK assets bucket. The pinned aws-cdk CLI's
    // file-asset publish path lists the object key and checks bucket ownership
    // (`ListBucket`, `GetBucketLocation`) before uploading, and a denial fails the
    // publish, so those bucket-level reads are part of the same narrow path (see
    // test/infra.test.ts).
    const bootstrapVersion = slashArn('ssm', 'parameter', 'cdk-bootstrap/hnb659fds/version');
    const cdkAssetsBucket = this.formatArn({
      service: 's3', region: '', account: '', resource: `cdk-hnb659fds-assets-${this.account}-${this.region}`,
    });
    serviceDeploy.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:*'], resources: [cloudformationStack],
    }));
    serviceDeploy.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:CreateChangeSet', 'cloudformation:DescribeChangeSet', 'cloudformation:DeleteChangeSet'],
      resources: [changeSetArn],
    }));
    serviceDeploy.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'], resources: [platformStack],
    }));
    serviceDeploy.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'], resources: [serviceCfn.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } },
    }));
    serviceDeploy.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
      resources: [slashArn('ssm', 'parameter', 'anywear/beta/*')],
    }));
    serviceDeploy.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:DescribeImages'],
      resources: [slashArn('ecr', 'repository', 'beta-anywear-service')],
    }));
    // The CLI's own-credentials path: only the bootstrap version parameter and
    // the dedicated assets bucket, and only the reads/writes the template publish
    // and the CloudFormation template read need. No bootstrap role assumption, no
    // bucket configuration and no other bucket.
    serviceDeploy.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'], resources: [bootstrapVersion],
    }));
    serviceDeploy.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject'], resources: [`${cdkAssetsBucket}/*`],
    }));
    // The publish path lists the root object key before uploading, and both the
    // ownership check behind it (`GetBucketLocation`) and that listing operate on
    // the bucket itself.
    serviceDeploy.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket', 's3:GetBucketLocation'], resources: [cdkAssetsBucket],
    }));

    const taskDefinitions = ['api', 'worker'].map((service) => (
      slashArn('ecs', 'task-definition', `beta-anywear-${service}:*`)));
    const services = ['api', 'worker'].map((service) => (
      slashArn('ecs', 'service', `beta-anywear/beta-anywear-${service}`)));
    const taskRoles = ['api', 'worker'].flatMap((service) => ['task', 'execution'].map((purpose) => (
      slashArn('iam', 'role', `beta-anywear-${service}-${purpose}`, '', this.account))));
    const taskExecutionPolicy = slashArn('iam', 'policy', 'service-role/AmazonECSTaskExecutionRolePolicy', '', 'aws');
    const scalableTargets = slashArn('application-autoscaling', 'scalable-target', '*');
    const scalingPolicies = slashArn('application-autoscaling', 'scaling-policy', '*');
    const loadBalancer = slashArn('elasticloadbalancing', 'loadbalancer', 'app/beta-anywear-api/*');
    const targetGroup = slashArn('elasticloadbalancing', 'targetgroup', 'beta-anywear-api/*');
    const listener = slashArn('elasticloadbalancing', 'listener', 'app/beta-anywear-api/*');
    const listenerRule = slashArn('elasticloadbalancing', 'listener-rule', 'app/beta-anywear-api/*');
    const distribution = slashArn('cloudfront', 'distribution', '*', '', this.account);
    const cloudFrontFunction = slashArn('cloudfront', 'function', '*', '', this.account);
    const alarms = slashArn('cloudwatch', 'alarm', 'beta-anywear-*');
    const logGroup = (name: string) => this.formatArn({
      service: 'logs', resource: 'log-group', resourceName: name, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    // CloudFormation generates the maintenance bucket's physical name from the
    // Workload stack, so the grant is confined to this stack's generated names.
    const maintenanceBucket = this.formatArn({
      service: 's3', region: '', account: '', resource: 'anywearworkloadstack-beta-*',
    });
    const loadBalancerSecurityGroups = slashArn('ec2', 'security-group', '*');
    // The load-balancer security group is a Platform resource whose id is only
    // known at deploy time. CloudFormation's system tags identify it exactly.
    const loadBalancerSecurityGroupTags = {
      StringEquals: {
        'ec2:ResourceTag/aws:cloudformation:stack-name': 'AnyWearPlatformStack-beta',
        'ec2:ResourceTag/aws:cloudformation:logical-id': 'LoadBalancerSecurityGroup3036A0FC',
      },
    };
    const betaParameters = slashArn('ssm', 'parameter', 'anywear/beta/*');

    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:RegisterTaskDefinition', 'ecs:DeregisterTaskDefinition', 'ecs:DescribeTaskDefinition'],
      resources: taskDefinitions,
    }));
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:CreateService', 'ecs:UpdateService', 'ecs:DeleteService', 'ecs:DescribeServices'],
      resources: services,
    }));
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['application-autoscaling:RegisterScalableTarget', 'application-autoscaling:DeregisterScalableTarget',
        'application-autoscaling:DescribeScalableTargets'],
      resources: [scalableTargets],
    }));
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['application-autoscaling:PutScalingPolicy', 'application-autoscaling:DeleteScalingPolicy',
        'application-autoscaling:DescribeScalingPolicies'],
      resources: [scalableTargets, scalingPolicies],
    }));
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['elasticloadbalancing:CreateLoadBalancer', 'elasticloadbalancing:DeleteLoadBalancer',
        'elasticloadbalancing:ModifyLoadBalancerAttributes', 'elasticloadbalancing:SetSecurityGroups',
        'elasticloadbalancing:SetSubnets'],
      resources: [loadBalancer],
    }));
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['elasticloadbalancing:CreateTargetGroup', 'elasticloadbalancing:DeleteTargetGroup',
        'elasticloadbalancing:ModifyTargetGroup', 'elasticloadbalancing:ModifyTargetGroupAttributes'],
      resources: [targetGroup],
    }));
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['elasticloadbalancing:CreateListener', 'elasticloadbalancing:DeleteListener',
        'elasticloadbalancing:ModifyListener'],
      resources: [listener],
    }));
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['elasticloadbalancing:CreateRule', 'elasticloadbalancing:DeleteRule', 'elasticloadbalancing:ModifyRule'],
      resources: [listenerRule],
    }));
    // ELBv2 read actions have no resource-level scope in IAM.
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['elasticloadbalancing:DescribeLoadBalancers', 'elasticloadbalancing:DescribeLoadBalancerAttributes',
        'elasticloadbalancing:DescribeTargetGroups', 'elasticloadbalancing:DescribeTargetGroupAttributes',
        'elasticloadbalancing:DescribeListeners', 'elasticloadbalancing:DescribeRules'],
      resources: ['*'],
    }));
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudfront:CreateDistribution', 'cloudfront:UpdateDistribution', 'cloudfront:DeleteDistribution',
        'cloudfront:GetDistribution', 'cloudfront:GetDistributionConfig'],
      resources: [distribution],
    }));
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudfront:CreateFunction', 'cloudfront:UpdateFunction', 'cloudfront:DeleteFunction',
        'cloudfront:DescribeFunction', 'cloudfront:GetFunction', 'cloudfront:PublishFunction'],
      resources: [cloudFrontFunction],
    }));
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms', 'cloudwatch:DescribeAlarms'],
      resources: [alarms],
    }));
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:PutRetentionPolicy', 'logs:DeleteRetentionPolicy'],
      resources: [logGroup('/anywear/beta/api'), logGroup('/anywear/beta/worker')],
    }));
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:CreateBucket', 's3:DeleteBucket', 's3:GetBucketPolicy', 's3:GetBucketPublicAccessBlock',
        's3:PutBucketPolicy', 's3:DeleteBucketPolicy', 's3:PutBucketPublicAccessBlock',
        's3:DeleteBucketPublicAccessBlock'],
      resources: [maintenanceBucket],
    }));
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress'],
      resources: [loadBalancerSecurityGroups], conditions: loadBalancerSecurityGroupTags,
    }));
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:CreateRole', 'iam:DeleteRole', 'iam:GetRole', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy',
        'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies'],
      resources: taskRoles,
    }));
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'], resources: taskRoles,
      conditions: { ArnEquals: { 'iam:PolicyARN': taskExecutionPolicy } },
    }));
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'], resources: taskRoles,
      conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
    }));
    // The Workload template resolves `Fn::GetStackOutput` against Platform with
    // the CloudFormation execution role, so that role needs the same read-only
    // producer-stack grant as the deploy job.
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'], resources: [platformStack],
    }));
    // The Workload template resolves two Systems Manager parameter types with
    // the CloudFormation execution role: its qweather_api_host input and the
    // CDK bootstrap version rule.
    serviceCfn.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'], resources: [betaParameters, bootstrapVersion],
    }));
  }
}
