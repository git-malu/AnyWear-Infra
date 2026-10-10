import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ComputeRuntime } from './compute-runtime';
import type { PlatformStack } from './platform-stack';
import { CleanupOperation } from './cleanup-operation';
import { CleanupAcceptance } from './cleanup-acceptance';

export interface WorkloadStackProps extends cdk.StackProps {
  stage: 'beta' | 'prod';
  platform: PlatformStack;
  betaActive?: boolean;
}

export class WorkloadStack extends cdk.Stack {
  readonly compute: ComputeRuntime;
  readonly cleanupOperation?: CleanupOperation;
  readonly cleanupAcceptance?: CleanupAcceptance;

  constructor(scope: Construct, id: string, props: WorkloadStackProps) {
    super(scope, id, props);

    const platform = props.platform;
    if (
      !platform.vpc ||
      !platform.database ||
      !platform.cluster ||
      !platform.apiSecurityGroup ||
      !platform.workerSecurityGroup ||
      !platform.loadBalancerSecurityGroup
    ) {
      throw new Error(`WorkloadStack requires a deployed cloud platform for stage ${props.stage}`);
    }

    this.compute = new ComputeRuntime(this, 'ComputeRuntime', {
      stage: props.stage,
      betaActive: props.betaActive,
      vpc: platform.vpc,
      database: platform.database,
      wardrobeBucket: platform.wardrobeBucket,
      repository: platform.repository,
      vtoQueue: platform.vtoQueue,
      vtoDeadLetterQueue: platform.vtoDeadLetterQueue,
      autoTaggingQueue: platform.autoTaggingQueue,
      autoTaggingDeadLetterQueue: platform.autoTaggingDeadLetterQueue,
      cluster: platform.cluster,
      apiSecurityGroup: platform.apiSecurityGroup,
      workerSecurityGroup: platform.workerSecurityGroup,
      loadBalancerSecurityGroup: platform.loadBalancerSecurityGroup,
      operationsTopic: platform.operationsTopic,
      cognitoUserPoolId: platform.userPool.userPoolId,
      cognitoClientId: platform.userPoolClient.userPoolClientId,
      qWeatherApiKeySecret: platform.qWeatherApiKeySecret,
    });
    if (props.stage === 'beta' && platform.cleanupTaskRole
      && platform.verificationTaskRole && platform.oneShotExecutionRole && platform.oneShotLogGroup
      && platform.database?.secret && platform.vpc && platform.oneShotSecurityGroup) {
      const subnets = props.betaActive === false ? platform.vpc.isolatedSubnets : platform.vpc.privateSubnets;
      const cleanupProps = {
        cluster: platform.cluster,
        vpc: platform.vpc,
        securityGroup: platform.oneShotSecurityGroup,
        subnets,
        repository: platform.repository,
        imageDigest: this.compute.imageDigest.valueAsString,
        serviceCommit: this.compute.serviceCommit.valueAsString,
        apiBaseUrl: `https://${this.compute.distribution.distributionDomainName}`,
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
      this.cleanupAcceptance = new CleanupAcceptance(this, 'CleanupAcceptance', cleanupProps);
    }
  }
}
