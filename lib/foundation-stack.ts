import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  deploymentQueueNames,
  serviceDeployCfnRoleName,
  serviceDeployRoleName,
  serviceTrustSubject,
  workloadStackName,
} from '@git-malu/stage-contracts';
import { readIdentityPhase, type IdentityPhase } from './identity-phase';
import { readLegacyRoleSource, type LegacyRoleSource } from './legacy-role-source';

// The reviewed CDK context key for the Foundation service set. The default is
// exactly today's single AnyWear-Service service; an additional service is a
// reviewed context value, never an Infra source edit.
export const SERVICE_SET_CONTEXT = 'infraServices';

// One descriptor per service the stage base's release chain deploys. `service`
// is the workload slug (role names and workload-stack identity), `repository`
// and `repositoryId` are the immutable GitHub OIDC subject components, and
// `environment` is the GitHub environment the release job runs in.
export interface FoundationServiceDescriptor {
  readonly service: string;
  readonly repository: string;
  readonly repositoryId: number;
  readonly environment: string;
}

// Exactly today's single service. Foundation role names, the workload stack
// name and the OIDC subject for `service` are unchanged.
export const DEFAULT_FOUNDATION_SERVICE: FoundationServiceDescriptor = Object.freeze({
  service: 'service',
  repository: 'AnyWear-Service',
  repositoryId: 1158460323,
  environment: 'beta',
});

const SERVICE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPOSITORY_NAME = /^[A-Za-z0-9._-]+$/;
const ENVIRONMENT = /^[a-z][a-z0-9-]*$/;
const DESCRIPTOR_FIELDS = ['environment', 'repository', 'repositoryId', 'service'];

const sameDescriptor = (left: FoundationServiceDescriptor, right: FoundationServiceDescriptor) => (
  left.service === right.service && left.repository === right.repository
  && left.repositoryId === right.repositoryId && left.environment === right.environment
);

// Strict by construction: only the four reviewed keys are accepted and every
// value is validated. An unknown key is a rejection, never silently ignored.
function readServiceDescriptor(value: unknown): FoundationServiceDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${SERVICE_SET_CONTEXT} entries must be service descriptor objects`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== DESCRIPTOR_FIELDS.length || keys.some((key, index) => key !== DESCRIPTOR_FIELDS[index])) {
    throw new Error(`${SERVICE_SET_CONTEXT} descriptor must have exactly service, repository, repositoryId and environment`);
  }
  if (typeof record.service !== 'string' || !SERVICE_SLUG.test(record.service)) {
    throw new Error(`${SERVICE_SET_CONTEXT} service must be a lowercase service slug`);
  }
  if (typeof record.repository !== 'string' || !REPOSITORY_NAME.test(record.repository)) {
    throw new Error(`${SERVICE_SET_CONTEXT} repository must be a plain repository name`);
  }
  if (!Number.isSafeInteger(record.repositoryId) || (record.repositoryId as number) < 1) {
    throw new Error(`${SERVICE_SET_CONTEXT} repositoryId must be GitHub's immutable repository id`);
  }
  if (typeof record.environment !== 'string' || !ENVIRONMENT.test(record.environment)) {
    throw new Error(`${SERVICE_SET_CONTEXT} environment must be a lowercase GitHub environment`);
  }
  return Object.freeze({ service: record.service, repository: record.repository,
    repositoryId: record.repositoryId as number, environment: record.environment });
}

/**
 * Read the reviewed Foundation service set. Missing input means exactly today's
 * single `service` descriptor. The default descriptor must be present unchanged
 * (the existing roles' construct ids, names, trust and policies stay
 * byte-identical); additional descriptors are appended in the given order.
 */
export function readFoundationServices(value: unknown = undefined): readonly FoundationServiceDescriptor[] {
  if (value === undefined || value === null) return Object.freeze([DEFAULT_FOUNDATION_SERVICE]);
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { throw new Error(`${SERVICE_SET_CONTEXT} must be a JSON array of service descriptors`); }
  }
  if (!Array.isArray(parsed)) throw new Error(`${SERVICE_SET_CONTEXT} must be a JSON array of service descriptors`);
  const descriptors = parsed.map((entry) => readServiceDescriptor(entry));
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.service)) throw new Error(`Duplicate ${SERVICE_SET_CONTEXT} service ${descriptor.service}`);
    seen.add(descriptor.service);
  }
  const primary = descriptors.find((descriptor) => descriptor.service === DEFAULT_FOUNDATION_SERVICE.service);
  if (!primary) throw new Error(`${SERVICE_SET_CONTEXT} must include the reviewed default service`);
  if (!sameDescriptor(primary, DEFAULT_FOUNDATION_SERVICE)) {
    throw new Error(`${SERVICE_SET_CONTEXT} must keep the reviewed default service descriptor unchanged`);
  }
  return Object.freeze([DEFAULT_FOUNDATION_SERVICE,
    ...descriptors.filter((descriptor) => !sameDescriptor(descriptor, primary))]);
}

// The workload stack an additional service's release chain deploys. The default
// `service` keeps the existing `AnyWearWorkloadStack-beta`; an added service
// scopes the shared identity with its slug.
export function serviceWorkloadStackName(service: string): string {
  if (service === DEFAULT_FOUNDATION_SERVICE.service) return workloadStackName('beta');
  if (!SERVICE_SLUG.test(service)) throw new Error('Invalid service name');
  return `AnyWearWorkloadStack-${service}-beta`;
}

export interface FoundationStackProps extends cdk.StackProps {
  identityPhase?: IdentityPhase;
  legacyRoleSource: LegacyRoleSource;
  /** Reviewed `infraServices` CDK context set; omitted means the single service. */
  services?: readonly FoundationServiceDescriptor[];
}

export class FoundationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);
    const identityPhase = readIdentityPhase(props?.identityPhase);
    const legacyRoleSource = readLegacyRoleSource(props.legacyRoleSource);
    if (legacyRoleSource === 'external' && (this.account !== '650880818323' || this.region !== 'ap-east-1')) {
      throw new Error('External legacy roles require the reviewed account 650880818323 in ap-east-1');
    }
    // Reject an unreviewed service set before creating any resource.
    const serviceSet = readFoundationServices(props.services);

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

    // Issue #158 step A: each reviewed service deploys its own release slice
    // with two identities. The OIDC role can only drive a CloudFormation change
    // set for that service's workload stack and pass one execution role; that
    // execution role is trusted by CloudFormation alone and operates only the
    // workload stack's resource families. Neither role carries a managed policy,
    // `iam:*`, `*` or any VPC/Aurora/Cognito/SQS configuration/ECR
    // configuration/Foundation grant.
    // The versioned `@git-malu/stage-contracts` package owns the per-service role
    // naming and the immutable OIDC subject. The reviewed `infraServices` CDK
    // context set defaults to exactly today's single `service`: its construct
    // ids, names, trust and policies are unchanged. An additional service gets
    // unique construct ids and a policy set scoped to its own workload stack.
    const addServiceDeployRoles = (descriptor: FoundationServiceDescriptor,
      ids: { deploy: string; cfn: string }) => {
      // An additional service shares the Beta cluster and stage base but owns the
      // same resource families under its own `beta-anywear-<service>` names. The
      // default descriptor reproduces today's `beta-anywear-*` literals exactly.
      const unique = (name: string) => descriptor.service === DEFAULT_FOUNDATION_SERVICE.service
        ? name : `${descriptor.service}-${name}`;
      const workloadStack = serviceWorkloadStackName(descriptor.service);
      const serviceDeploy = new iam.Role(this, ids.deploy, {
        roleName: serviceDeployRoleName(descriptor.service),
        assumedBy: new iam.WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': serviceTrustSubject(descriptor),
          },
        }),
      });
      const serviceCfn = new iam.Role(this, ids.cfn, {
        roleName: serviceDeployCfnRoleName(descriptor.service),
        assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
      });
      const slashArn = (service: string, resource: string, resourceName: string, region = this.region,
        account = this.account) => this.formatArn({
        service, resource, resourceName, region, account, arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
      });
      const stackArn = (stackName: string) => slashArn('cloudformation', 'stack', `${stackName}/*`);
      const cloudformationStack = stackArn(workloadStack);
      // Change sets carry their own ARN; executing one still requires the target
      // stack ARN, which is limited to this service's workload stack.
      const changeSetArn = slashArn('cloudformation', 'changeSet', '*');
      const platformStack = stackArn('AnyWearPlatformStack-beta');
      // Issue #158 round 3: the Service owner's synthesizer makes the CDK CLI use
      // the deploy job's own credentials. The CLI has no `--no-role` option (it
      // rejects `--role`), and `--role-arn beta-<service>-deploy-cfn-role` stays
      // the CloudFormation execution role. The CLI path therefore reads the
      // bootstrap version itself and publishes the synthesized template asset,
      // `<hash>.json` at the root of the dedicated CDK assets bucket. The pinned
      // aws-cdk CLI's file-asset publish path lists the object key and checks
      // bucket ownership (`ListBucket`, `GetBucketLocation`) before uploading, and
      // a denial fails the publish, so those bucket-level reads are part of the
      // same narrow path (see test/infra.test.ts).
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
        resources: [slashArn('ecr', 'repository', `beta-anywear-${descriptor.service}`)],
      }));
      // The CLI's own-credentials path: only the bootstrap version parameter and
      // the dedicated assets bucket, and only the reads/writes the template
      // publish and the CloudFormation template read need. No bootstrap role
      // assumption, no bucket configuration and no other bucket.
      serviceDeploy.addToPolicy(new iam.PolicyStatement({
        actions: ['ssm:GetParameter'], resources: [bootstrapVersion],
      }));
      serviceDeploy.addToPolicy(new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:GetObject'], resources: [`${cdkAssetsBucket}/*`],
      }));
      // The publish path lists the root object key before uploading, and both the
      // ownership check behind it (`GetBucketLocation`) and that listing operate
      // on the bucket itself.
      serviceDeploy.addToPolicy(new iam.PolicyStatement({
        actions: ['s3:ListBucket', 's3:GetBucketLocation'], resources: [cdkAssetsBucket],
      }));

      const taskDefinitions = ['api', 'worker'].map((purpose) => (
        slashArn('ecs', 'task-definition', `beta-anywear-${unique(purpose)}:*`)));
      const workloadServices = ['api', 'worker'].map((purpose) => (
        slashArn('ecs', 'service', `beta-anywear/beta-anywear-${unique(purpose)}`)));
      const taskRoles = ['api', 'worker'].flatMap((purpose) => ['task', 'execution'].map((kind) => (
        slashArn('iam', 'role', `beta-anywear-${unique(purpose)}-${kind}`, '', this.account))));
      const taskExecutionPolicy = slashArn('iam', 'policy', 'service-role/AmazonECSTaskExecutionRolePolicy', '', 'aws');
      const scalableTargets = slashArn('application-autoscaling', 'scalable-target', '*');
      const scalingPolicies = slashArn('application-autoscaling', 'scaling-policy', '*');
      const loadBalancer = slashArn('elasticloadbalancing', 'loadbalancer', `app/beta-anywear-${unique('api')}/*`);
      const targetGroup = slashArn('elasticloadbalancing', 'targetgroup', `beta-anywear-${unique('api')}/*`);
      const listener = slashArn('elasticloadbalancing', 'listener', `app/beta-anywear-${unique('api')}/*`);
      const listenerRule = slashArn('elasticloadbalancing', 'listener-rule', `app/beta-anywear-${unique('api')}/*`);
      const distribution = slashArn('cloudfront', 'distribution', '*', '', this.account);
      const cloudFrontFunction = slashArn('cloudfront', 'function', '*', '', this.account);
      const alarms = slashArn('cloudwatch', 'alarm', `beta-anywear-${unique('*')}`);
      const logGroup = (name: string) => this.formatArn({
        service: 'logs', resource: 'log-group', resourceName: name, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      });
      // CloudFormation generates the maintenance bucket's physical name from the
      // workload stack, so the grant is confined to this stack's generated names.
      const maintenanceBucket = this.formatArn({
        service: 's3', region: '', account: '', resource: `${workloadStack.toLowerCase()}-*`,
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

      // Issue #162: the deploy job's own bake reads the six named signals live
      // after the stack is stable and before it writes the deployment record.
      // The bake runs in the deploy job's OIDC session, so these read-only
      // grants belong to the Service deploy role, not the CloudFormation
      // execution role: the CloudWatch metric reads, the nine deployed bake and
      // SQS alarm entities, this service's two ECS services, the four
      // stage-base queues and the worker log group. No SQS send/receive grant is
      // added: the controlled-fault drill uses a one-off operator credential.
      serviceDeploy.addToPolicy(new iam.PolicyStatement({
        actions: ['cloudwatch:GetMetricStatistics'],
        resources: ['*'], conditions: { StringEquals: { 'aws:RequestedRegion': this.region } },
      }));
      serviceDeploy.addToPolicy(new iam.PolicyStatement({
        actions: ['cloudwatch:DescribeAlarms'], resources: [alarms],
      }));
      serviceDeploy.addToPolicy(new iam.PolicyStatement({
        actions: ['ecs:DescribeServices'], resources: workloadServices,
      }));
      serviceDeploy.addToPolicy(new iam.PolicyStatement({
        actions: ['sqs:GetQueueAttributes'],
        resources: Object.values(deploymentQueueNames('beta'))
          .map((queueName) => this.formatArn({ service: 'sqs', resource: queueName })),
      }));
      serviceDeploy.addToPolicy(new iam.PolicyStatement({
        actions: ['logs:FilterLogEvents'], resources: [logGroup('/anywear/beta/worker:*')],
      }));

      serviceCfn.addToPolicy(new iam.PolicyStatement({
        actions: ['ecs:RegisterTaskDefinition', 'ecs:DeregisterTaskDefinition', 'ecs:DescribeTaskDefinition'],
        resources: taskDefinitions,
      }));
      serviceCfn.addToPolicy(new iam.PolicyStatement({
        actions: ['ecs:CreateService', 'ecs:UpdateService', 'ecs:DeleteService', 'ecs:DescribeServices'],
        resources: workloadServices,
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
        resources: [logGroup(`/anywear/beta/${unique('api')}`), logGroup(`/anywear/beta/${unique('worker')}`)],
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
      // This read-only producer-stack grant existed for the pre-#158-step-D weak
      // `Fn::GetStackOutput` reads the Workload template made against the Platform
      // stack with the CloudFormation execution role. AnyWear-Service's step D has
      // delivered (AnyWear-Service PR #91: zero `Fn::GetStackOutput` in 9/9
      // variant x phase templates), so the Workload template contains no weak
      // reads now and this grant is redundant. It is retained only because this
      // round keeps the default Foundation template byte-identical; retire it in a
      // separate reviewed Foundation change. It cannot drive, update or delete the
      // Platform stack: the only `cloudformation:*` grant is the service's own
      // workload stack.
      serviceCfn.addToPolicy(new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks'], resources: [platformStack],
      }));
      // The workload template resolves two Systems Manager parameter types with
      // the CloudFormation execution role: its qweather_api_host input and the
      // CDK bootstrap version rule.
      serviceCfn.addToPolicy(new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters'], resources: [betaParameters, bootstrapVersion],
      }));
    };
    addServiceDeployRoles(DEFAULT_FOUNDATION_SERVICE,
      { deploy: 'BetaServiceDeployRole', cfn: 'BetaServiceDeployCfnRole' });
    for (const descriptor of serviceSet) {
      if (descriptor.service === DEFAULT_FOUNDATION_SERVICE.service) continue;
      addServiceDeployRoles(descriptor, {
        deploy: `ServiceDeployRole-${descriptor.service}`,
        cfn: `ServiceDeployCfnRole-${descriptor.service}`,
      });
    }
  }
}
