import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ComputeRuntime } from './compute-runtime';
import type { PlatformInputs } from './platform-inputs';
import { CleanupOperation } from './cleanup-operation';

export interface RuntimeStackProps extends cdk.StackProps {
  stage: 'beta' | 'prod';
  /**
   * The Base inputs are built after `super()` so every imported construct is
   * scoped inside this stack (and therefore resolves this stack's region).
   */
  platform: (stack: RuntimeStack) => PlatformInputs;
}

/** The CDK bootstrap qualifier the account's stage stacks were bootstrapped with. */
export const BOOTSTRAP_QUALIFIER = 'hnb659fds';

/**
 * The release slice's standard synthesizer.
 *
 * Since #195 the Runtime stack is deployed by AnyWear-Infra's `deploy-runtime`
 * operation under the existing `beta-infra-deploy-role`, which already assumes
 * the CDK bootstrap deploy/lookup roles. The qualifier is pinned so the template
 * bytes and the bootstrap version parameter are identical to the recorded
 * baseline; only the assuming principal differs from the retired Service path.
 */
export function standardSynthesizer(): cdk.DefaultStackSynthesizer {
  return new cdk.DefaultStackSynthesizer({ qualifier: BOOTSTRAP_QUALIFIER });
}

/**
 * The Runtime stack. It holds the paid compute and ingress the
 * stop operation deletes: the ALB, ECS services/task definitions, log groups and
 * the fixed Beta cleanup operation. Everything persistent - VPC, Aurora, S3,
 * Cognito, ECR, queues and both CloudFront distributions - belongs to the Infra
 * Base stack, so deleting this stack stops the environment without losing data,
 * identity or domains.
 */
export class RuntimeStack extends cdk.Stack {
  readonly compute: ComputeRuntime;
  readonly cleanupOperation?: CleanupOperation;

  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, { ...props, synthesizer: props.synthesizer ?? standardSynthesizer() });

    const platform = props.platform(this);
    if (
      !platform.vpc ||
      !platform.database ||
      !platform.cluster ||
      !platform.apiSecurityGroup ||
      !platform.workerSecurityGroup ||
      !platform.loadBalancerSecurityGroup
    ) {
      throw new Error(`RuntimeStack requires a deployed Base stack for stage ${props.stage}`);
    }

    // Keep the selected profile in the stack even when paid compute is stopped.
    const betaApiProfile = props.stage === 'beta' ? new cdk.CfnParameter(this, 'BetaApiSizingProfile', {
      type: 'String', default: 's1', allowedValues: ['s1', 's2-api'],
      description: 'Retained Beta API sizing profile; s2-api is an unqualified Issue #95 candidate',
    }) : undefined;
    const betaApiS2Condition = betaApiProfile ? new cdk.CfnCondition(this, 'BetaApiS2', {
      expression: cdk.Fn.conditionEquals(betaApiProfile.valueAsString, 's2-api'),
    }) : undefined;
    const betaSizingTelemetry = props.stage === 'beta' ? new cdk.CfnParameter(this, 'BetaSizingTelemetry', {
      type: 'String', default: 'false', allowedValues: ['false', 'true'],
      description: 'Retained Beta API and Worker sizing telemetry; disabled by default',
    }) : undefined;
    this.compute = new ComputeRuntime(this, 'ComputeRuntime', {
      stage: props.stage,
      betaApiS2Condition,
      betaSizingTelemetry: betaSizingTelemetry?.valueAsString,
      vpc: platform.vpc,
      database: platform.database,
      wardrobeBucket: platform.wardrobeBucket,
      repository: platform.repository,
      repositoryUri: platform.repositoryUri,
      vtoQueue: platform.vtoQueue,
      vtoDeadLetterQueue: platform.vtoDeadLetterQueue,
      autoTaggingQueue: platform.autoTaggingQueue,
      autoTaggingDeadLetterQueue: platform.autoTaggingDeadLetterQueue,
      cluster: platform.cluster,
      apiSecurityGroup: platform.apiSecurityGroup,
      workerSecurityGroup: platform.workerSecurityGroup,
      loadBalancerSecurityGroup: platform.loadBalancerSecurityGroup,
      operationsTopic: platform.operationsTopic,
      cognitoUserPoolId: platform.cognitoUserPoolId,
      cognitoClientId: platform.cognitoClientId,
      qWeatherApiKeySecret: platform.qWeatherApiKeySecret,
    });
    if (props.stage === 'beta' && platform.cleanupTaskRole
      && platform.verificationTaskRole && platform.oneShotExecutionRole && platform.oneShotLogGroup
      && platform.database?.secret && platform.vpc && platform.oneShotSecurityGroup) {
      // The Base VPC's private tier is the one private tier while the Egress
      // stack supplies its NAT route, so the cleanup tasks run there.
      const subnets = platform.cleanupSubnets;
      const cleanupProps = {
        cluster: platform.cluster,
        vpc: platform.vpc,
        securityGroup: platform.oneShotSecurityGroup,
        subnets,
        repository: platform.repository,
        imageDigest: this.compute.imageDigest.valueAsString,
        serviceCommit: this.compute.serviceCommit.valueAsString,
        apiBaseUrl: platform.apiBaseUrl,
        cleanupTaskRole: platform.cleanupTaskRole,
        verificationTaskRole: platform.verificationTaskRole,
        executionRole: platform.oneShotExecutionRole,
        logGroup: platform.oneShotLogGroup,
        databaseSecretArn: platform.database.secret.secretArn,
        databaseHost: platform.database.clusterEndpoint.hostname,
        databasePort: platform.database.clusterEndpoint.port.toString(),
        databaseName: 'anywear',
        bucketName: platform.wardrobeBucket.bucketName,
        vtoQueueUrl: platform.vtoQueue.queueUrl,
        taggingQueueUrl: platform.autoTaggingQueue.queueUrl,
        vtoDlqUrl: platform.vtoDeadLetterQueue.queueUrl,
        taggingDlqUrl: platform.autoTaggingDeadLetterQueue.queueUrl,
      };
      this.cleanupOperation = new CleanupOperation(this, 'CleanupOperation', cleanupProps);
    }
  }
}
