import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import type { RuntimePolicy } from './artifact-inputs';

export interface AsyncRuntimeProps {
  stage: string;
  production: boolean;
  runtimePolicy: RuntimePolicy;
  ecrImageRetention?: boolean;
}

export class AsyncRuntime extends Construct {
  readonly repository: ecr.Repository;
  readonly vtoQueue: sqs.Queue;
  readonly vtoDeadLetterQueue: sqs.Queue;
  readonly autoTaggingQueue: sqs.Queue;
  readonly autoTaggingDeadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: AsyncRuntimeProps) {
    super(scope, id);

    const removalPolicy = props.production ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    this.repository = new ecr.Repository(this, 'ServiceRepository', {
      repositoryName: `${props.stage}-anywear-service`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.AES_256,
      removalPolicy,
      emptyOnDelete: !props.production,
      // Explicitly activated only after reviewing the retention diff and
      // tagging every current/rollback digest. The operational guard caps
      // protected digests at 256, leaving at least 744 images of headroom.
      lifecycleRules: props.ecrImageRetention ? [
        { rulePriority: 1, tagStatus: ecr.TagStatus.TAGGED,
          tagPrefixList: ['protected-service-'], maxImageCount: 1000 },
        { rulePriority: 2, maxImageCount: props.production ? 100 : 30 },
      ] : [{ maxImageCount: props.production ? 100 : 30 }],
    });

    this.vtoDeadLetterQueue = this.createDeadLetterQueue('VtoDeadLetterQueue', `${props.stage}-anywear-vto-dlq`);
    this.autoTaggingDeadLetterQueue = this.createDeadLetterQueue(
      'AutoTaggingDeadLetterQueue',
      `${props.stage}-anywear-auto-tagging-dlq`,
    );
    this.vtoQueue = this.createTaskQueue(
      'VtoQueue',
      `${props.stage}-anywear-vto`,
      props.runtimePolicy.vto,
      this.vtoDeadLetterQueue,
    );
    this.autoTaggingQueue = this.createTaskQueue(
      'AutoTaggingQueue',
      `${props.stage}-anywear-auto-tagging`,
      props.runtimePolicy['auto-tagging'],
      this.autoTaggingDeadLetterQueue,
    );
  }

  private createDeadLetterQueue(id: string, queueName: string): sqs.Queue {
    return new sqs.Queue(this, id, {
      queueName,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
  }

  private createTaskQueue(
    id: string,
    queueName: string,
    policy: { queueVisibilitySeconds: number; maxReceives: number },
    deadLetterQueue: sqs.Queue,
  ): sqs.Queue {
    return new sqs.Queue(this, id, {
      queueName,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      visibilityTimeout: cdk.Duration.seconds(policy.queueVisibilitySeconds),
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: policy.maxReceives },
    });
  }
}
