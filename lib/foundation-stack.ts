import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  deploymentQueueNames,
  runtimeStackName,
  serviceDeployCfnRoleName,
  serviceDeployRoleName,
  serviceTrustSubject,
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

// The Runtime stack an additional service's release chain deploys. The default
// `service` keeps the existing `AnyWearRuntimeStack-beta` identity (0.3.0); an
// added service scopes the shared identity with its slug.
export function serviceRuntimeStackName(service: string): string {
  if (service === DEFAULT_FOUNDATION_SERVICE.service) return runtimeStackName('beta');
  if (!SERVICE_SLUG.test(service)) throw new Error('Invalid service name');
  return `AnyWearRuntimeStack-${service}-beta`;
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
    const runtime = createRole('BetaInfraRuntimeRole', 'infra-runtime', infraSubject);
    const artifacts = createRole('BetaServiceArtifactRole', 'service-artifact',
      'repo:git-malu@11473072/AnyWear-Service@1158460323:environment:service-artifacts');
    createRole('BetaServiceDataRole', 'service-data', betaSubject('AnyWear-Service', 1158460323));
    createRole('BetaClientPublishRole', 'client-publish', betaSubject('AnyWear-Client', 1176104200));
    createRole('BetaE2EQualificationRole', 'e2e-qualification', betaSubject('AnyWear-E2E', 1317091305));
    // Issue #166 M4: a Base deploy resolves its API origin by reading the
    // Service-owned Runtime stack (an absent stack is a `ValidationError` that
    // still requires authorization) and, before the MOVE, the legacy Workload
    // stack. Those reads run under this runtime role, whose live read policy is
    // the Base stack's `DedicatedPolicy` and does not yet cover the renamed
    // Runtime stack at M4 (the new Base policy is applied by the same update that
    // needs the pre-read). Foundation therefore owns the read grants and step 8
    // deploys them before M4. The Runtime ARN is permanent. The Workload ARN is
    // transitional: after M3/M4 deletes Workload and the Base literal-origin
    // fallback is the only source, a later reviewed Foundation deploy removes
    // the Workload ARN. Neither grant adds a write, a managed policy or another
    // stack family.
    const stageStackArn = (stackName: string) => this.formatArn({
      service: 'cloudformation', resource: 'stack', resourceName: `${stackName}/*`,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
    runtime.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'],
      resources: [stageStackArn('AnyWearRuntimeStack-beta'), stageStackArn('AnyWearWorkloadStack-beta')],
    }));
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
    // set for that service's runtime stack and pass one execution role; that
    // execution role is trusted by CloudFormation alone and operates only the
    // runtime stack's resource families. Neither role carries a managed policy,
    // `iam:*`, `*` or any VPC/Aurora/Cognito/SQS configuration/ECR
    // configuration/Foundation grant.
    // Issue #166: the Service-owned slice is `AnyWearRuntimeStack-beta`; both
    // roles are scoped to that stack. The versioned `@git-malu/stage-contracts`
    // package owns the per-service role naming and the immutable OIDC subject.
    // The reviewed `infraServices` CDK context set defaults to exactly today's
    // single `service`: its construct ids, names, trust and policies are
    // unchanged apart from the stack identity. An additional service gets unique
    // construct ids and a policy set scoped to its own runtime stack.
    const addServiceDeployRoles = (descriptor: FoundationServiceDescriptor,
      ids: { deploy: string; cfn: string }) => {
      // An additional service shares the Beta cluster and stage base but owns the
      // same resource families under its own `beta-anywear-<service>` names. The
      // default descriptor reproduces today's `beta-anywear-*` literals exactly.
      const unique = (name: string) => descriptor.service === DEFAULT_FOUNDATION_SERVICE.service
        ? name : `${descriptor.service}-${name}`;
      const runtimeStack = serviceRuntimeStackName(descriptor.service);
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
      // A colon-resource ARN such as `arn:aws:cloudwatch:<region>:<account>:alarm:<name>`.
      // CloudWatch alarm ARNs are `alarm:<AlarmName>`, never `alarm/<AlarmName>`; the
      // slash form matches no resource and turns every read into AccessDenied.
      const colonArn = (service: string, resource: string, resourceName: string, region = this.region,
        account = this.account) => this.formatArn({
        service, resource, resourceName, region, account, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      });
      const stackArn = (stackName: string) => slashArn('cloudformation', 'stack', `${stackName}/*`);
      const cloudformationStack = stackArn(runtimeStack);
      // Change sets carry their own ARN; executing one still requires the target
      // stack ARN, which is limited to this service's runtime stack.
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

      // The Workload template registers four task-definition families: the two
      // compute families plus the CleanupOperation one-shot families, which carry
      // the Service image and are therefore updated by every image-changing
      // deploy.
      const taskDefinitions = [...['api', 'worker'].map((purpose) => (
        slashArn('ecs', 'task-definition', `beta-anywear-${unique(purpose)}:*`))),
      ...['cleanup', 'cleanup-verify'].map((purpose) => (
        slashArn('ecs', 'task-definition', `beta-anywear-${purpose}:*`)))];
      const workloadServices = ['api', 'worker'].map((purpose) => (
        slashArn('ecs', 'service', `beta-anywear/beta-anywear-${unique(purpose)}`)));
      const taskRoles = ['api', 'worker'].flatMap((purpose) => ['task', 'execution'].map((kind) => (
        slashArn('iam', 'role', `beta-anywear-${unique(purpose)}-${kind}`, '', this.account))));
      // The one-shot cleanup/verification task definitions also pass three
      // Workload-owned task roles to ECS. They are not CloudFormation-managed
      // here (the Workload template owns them), so only `iam:PassRole` names them.
      const cleanupTaskRoles = ['beta-anywear-tester-cleanup-task', 'beta-anywear-verification-task',
        'beta-anywear-one-shot-execution'].map((roleName) => (
        slashArn('iam', 'role', roleName, '', this.account)));
      // AnyWear-Service's Workload template creates this role for its
      // CleanupOperation StateMachine. It is Workload-owned but is not one of the
      // four compute task/execution roles: it has no managed policy and is never
      // an ECS `PassRole` target, so only the role-management statement lists it.
      const cleanupOperationRole = slashArn('iam', 'role', 'beta-anywear-tester-cleanup-operation', '', this.account);
      // The Workload template also attaches/updates inline policies on two
      // Foundation-managed roles it does not create. CloudFormation only needs
      // the inline-policy actions on these exact roles; create/delete/read of the
      // roles themselves stays outside this execution role.
      const externalInlinePolicyRoles = ['beta-e2e-qualification-role', 'beta-infra-runtime-role'].map((roleName) => (
        slashArn('iam', 'role', roleName, '', this.account)));
      // The same Workload template also creates the CleanupOperation state
      // machine. The account holds exactly one state machine
      // (`beta-anywear-tester-cleanup`), so this unqualified ARN identifies it
      // unambiguously.
      const cleanupStateMachine = this.formatArn({
        service: 'states', resource: 'stateMachine', resourceName: 'beta-anywear-tester-cleanup',
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      });
      const taskExecutionPolicy = slashArn('iam', 'policy', 'service-role/AmazonECSTaskExecutionRolePolicy', '', 'aws');
      const scalableTargets = slashArn('application-autoscaling', 'scalable-target', '*');
      const scalingPolicies = slashArn('application-autoscaling', 'scaling-policy', '*');
      const loadBalancer = slashArn('elasticloadbalancing', 'loadbalancer', `app/beta-anywear-${unique('api')}/*`);
      const targetGroup = slashArn('elasticloadbalancing', 'targetgroup', `beta-anywear-${unique('api')}/*`);
      const listener = slashArn('elasticloadbalancing', 'listener', `app/beta-anywear-${unique('api')}/*`);
      const listenerRule = slashArn('elasticloadbalancing', 'listener-rule', `app/beta-anywear-${unique('api')}/*`);
      const distribution = slashArn('cloudfront', 'distribution', '*', '', this.account);
      const cloudFrontFunction = slashArn('cloudfront', 'function', '*', '', this.account);
      const alarms = colonArn('cloudwatch', 'alarm', `beta-anywear-${unique('*')}`);
      const logGroup = (name: string) => this.formatArn({
        service: 'logs', resource: 'log-group', resourceName: name, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      });
      // CloudFormation generates the maintenance bucket's physical name from the
      // runtime stack, so the grant is confined to this stack's generated names.
      const maintenanceBucket = this.formatArn({
        service: 's3', region: '', account: '', resource: `${runtimeStack.toLowerCase()}-*`,
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
      // FilterLogEvents is documented as a log-group-level action (plain
      // log-group ARN), but the pre-existing E2E role's exercised grant uses the
      // stream-suffixed form. Grant both worker-log-group forms rather than bet
      // the deployment on which resource form the API authorizes on; nothing
      // outside the worker log group is included.
      serviceDeploy.addToPolicy(new iam.PolicyStatement({
        actions: ['logs:FilterLogEvents'],
        resources: [logGroup('/anywear/beta/worker'), logGroup('/anywear/beta/worker:*')],
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
      // The #162 worker outbox metric filter is an `AWS::Logs::MetricFilter` the
      // Workload template creates. CloudFormation's Logs handler needs the full
      // create/update/read/delete action set on that log group; no filter exists
      // on the api log group, so its grant is not repeated here.
      serviceCfn.addToPolicy(new iam.PolicyStatement({
        actions: ['logs:PutMetricFilter', 'logs:DescribeMetricFilters', 'logs:DeleteMetricFilter'],
        resources: [logGroup(`/anywear/beta/${unique('worker')}`)],
      }));
      // CloudFormation resolves the Workload stack's `AWS::Logs::LogGroup` `Arn`
      // values with this execution role while it re-renders the four policies that
      // reference them (`ComputeRuntime/{Api,Worker}ExecutionRole/DefaultPolicy`
      // and the two task-role policies), so the role needs the log-group read
      // action. IAM evaluates `logs:DescribeLogGroups` in its list form: CloudTrail
      // shows the evaluated resource
      // `arn:aws:logs:ap-east-1:650880818323:log-group::log-stream:`, which no
      // named log-group ARN can match. The single grant is therefore
      // `Resource: "*"`, constrained by its one action; the lifecycle/retention
      // statement above keeps its own named ARNs. The explicit `Sid` keeps the
      // policy minimizer from folding this wildcard read into the ELBv2
      // `Describe*` statement above, so the grant stays one single-action
      // statement the inventory test can constrain.
      serviceCfn.addToPolicy(new iam.PolicyStatement({
        sid: 'DescribeWorkloadLogGroups',
        actions: ['logs:DescribeLogGroups'],
        resources: ['*'],
      }));
      // Issue #158 round 13 / #162 D8: CloudFormation manages the Workload
      // template's CleanupOperation state machine and its StateMachineVersion.
      // Step Functions authorizes update/delete/version operations on the
      // state machine's unqualified ARN, not on a version-suffixed ARN (that
      // form is not a resource type; the qualifier is a condition key only for
      // the actions the version/alias authorization guide lists).
      serviceCfn.addToPolicy(new iam.PolicyStatement({
        actions: ['states:DescribeStateMachine', 'states:ListStateMachineVersions',
          'states:UpdateStateMachine', 'states:DeleteStateMachine',
          'states:PublishStateMachineVersion', 'states:DeleteStateMachineVersion'],
        resources: [cleanupStateMachine],
      }));
      // CreateStateMachine has no resource type in the Step Functions service
      // authorization table, so it cannot be scoped to the state-machine ARN.
      // Keep it a single service-level action; CloudFormation calls it only when
      // a replacement creates a new state machine.
      serviceCfn.addToPolicy(new iam.PolicyStatement({
        actions: ['states:CreateStateMachine'], resources: ['*'],
      }));
      // Step Functions requires the caller to pass the state machine's execution
      // role on create/update. The role is the Workload-owned CleanupOperation
      // role; no compute task role is a states target.
      serviceCfn.addToPolicy(new iam.PolicyStatement({
        actions: ['iam:PassRole'], resources: [cleanupOperationRole],
        conditions: { StringEquals: { 'iam:PassedToService': 'states.amazonaws.com' } },
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
      // Issue #158 round 12: CloudFormation reads the Workload template's
      // CleanupOperation StateMachine role with `iam:GetRole`, so this existing
      // role-management statement now covers five roles. No action is added and
      // the attach/detach and pass-role statements below stay on the four compute
      // task/execution roles.
      serviceCfn.addToPolicy(new iam.PolicyStatement({
        actions: ['iam:CreateRole', 'iam:DeleteRole', 'iam:GetRole', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy',
          'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies'],
        resources: [...taskRoles, cleanupOperationRole],
      }));
      // The Workload template's E2E qualification and Infra runtime policies are
      // attached to Foundation-managed roles. The state-machine version changes
      // rewrite those inline policies, so the execution role needs exactly the
      // three inline-policy actions on those two concrete roles.
      serviceCfn.addToPolicy(new iam.PolicyStatement({
        actions: ['iam:PutRolePolicy', 'iam:GetRolePolicy', 'iam:DeleteRolePolicy'],
        resources: externalInlinePolicyRoles,
      }));
      serviceCfn.addToPolicy(new iam.PolicyStatement({
        actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'], resources: taskRoles,
        conditions: { ArnEquals: { 'iam:PolicyARN': taskExecutionPolicy } },
      }));
      serviceCfn.addToPolicy(new iam.PolicyStatement({
        actions: ['iam:PassRole'], resources: [...taskRoles, ...cleanupTaskRoles],
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
      // Issue #166 Stage A: the API distribution's `OriginCustomHeaders` carries a
      // `{{resolve:secretsmanager:/anywear/beta/cloudfront_origin_header}}`
      // dynamic reference. CloudFormation re-resolves it on every update of that
      // resource under this execution role; the role had no Secrets Manager
      // action, so the first pre-move distribution update rolled back. The read is
      // confined to that one secret ARN suffix and is required only for the
      // one-time pre-move. A later reviewed Foundation deploy removes this
      // statement after the MOVE deletes the Workload stack.
      serviceCfn.addToPolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [colonArn('secretsmanager', 'secret', '/anywear/beta/cloudfront_origin_header-*')],
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
