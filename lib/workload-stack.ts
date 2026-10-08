import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ComputeRuntime } from './compute-runtime';
import type { PlatformStack } from './platform-stack';

export interface WorkloadStackProps extends cdk.StackProps {
  stage: 'beta' | 'prod';
  platform: PlatformStack;
  betaActive?: boolean;
}

export class WorkloadStack extends cdk.Stack {
  readonly compute: ComputeRuntime;

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
  }
}
