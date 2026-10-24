import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import {
  STAGE_CONTRACT_PARAMETERS,
  STAGE_CONTRACT_READ_PARAMETERS,
  STAGE_CONTRACT_STAGE,
  stageParameters,
} from './contracts.mjs';
import type { PlatformStack } from './platform-stack';

// The Base stack publishes the stage base as plain SSM parameters under
// `/anywear/<stage>/`; the Runtime stack that `deploy-runtime` deploys is the
// reader. Values come from the existing Base resources/attributes; nothing here
// reads SSM.
export const STAGE_CONTRACT_CONSUMER = 'AnyWear-Infra AnyWearRuntimeStack-beta';

// Two stage-base values have no Platform attribute. They were recorded on
// 2026-10-18 from the then-live `AnyWearWorkloadStack-beta` parameters with
// `aws cloudformation describe-stacks --stack-name AnyWearWorkloadStack-beta` in
// account 650880818323 / region ap-east-1. That stack was retired and deleted by
// #166's Base/Runtime split, so no live Workload stack remains to read those
// parameter values from. Both values are identifiers, not secret values: the
// published ARN names the secret, it does not contain key material. A change to
// them is a reviewed source diff.
// `deploy-runtime` passes them to the Runtime template as its two plain parameters.
const REVIEWED_BETA_STAGE_BASE = Object.freeze({
  vlmConfigArn: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:/anywear/beta/doubao_vlm_config-FEH2DQ',
  cloudFrontPrefixListId: 'pl-14b2577d',
});

export interface StageContractInputs {
  vlmConfigArn: string;
  cloudFrontPrefixListId: string;
}

export interface StageContractProps {
  platform: PlatformStack;
  inputs?: StageContractInputs;
}

const VLM_CONFIG_ARN = /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/;
const CLOUDFRONT_PREFIX_LIST_ID = /^pl-[a-z0-9]+$/;

// Only the reviewed Beta stage may fall back to the recorded constants. Any
// other stage must pass explicit values so a beta identifier can never be
// republished under another stage.
export function stageContractInputs(stage: string, provided?: StageContractInputs): StageContractInputs {
  if (!['dev', 'beta', 'prod'].includes(stage)) throw new Error(`Unknown stage contract stage: ${stage}`);
  if (stage === 'beta') return provided ?? REVIEWED_BETA_STAGE_BASE;
  if (!provided) throw new Error(`The ${stage} stage contract requires explicit vlmConfigArn and cloudFrontPrefixListId inputs`);
  return provided;
}

export class StageContract extends Construct {
  readonly parameters: ssm.IParameter[] = [];

  constructor(scope: Construct, id: string, props: StageContractProps) {
    super(scope, id);
    const platform = props.platform;
    const stage = platform.stageName;
    if (stage !== STAGE_CONTRACT_STAGE) {
      throw new Error(`The stage contract is published for the ${STAGE_CONTRACT_STAGE} stage only in this change`);
    }
    const inputs = stageContractInputs(stage, props.inputs);
    if (!VLM_CONFIG_ARN.test(inputs.vlmConfigArn)) {
      throw new Error('Stage contract requires an explicit Secrets Manager ARN for vlm_config_arn');
    }
    if (!CLOUDFRONT_PREFIX_LIST_ID.test(inputs.cloudFrontPrefixListId)) {
      throw new Error('Stage contract requires an explicit CloudFront origin-facing prefix list id');
    }
    // The eight unconditional additions are created by `platform-stack.ts` in
    // every Beta identity phase. `cleanupTaskRole` is the one phase-dependent
    // value: the role exists only while `identityPhase !== 'legacy'`, so its
    // parameter is published with it instead of publishing an ARN that names a
    // role the same template does not create.
    const { vpc, database, cluster, apiSecurityGroup, workerSecurityGroup, loadBalancerSecurityGroup, operationsTopic,
      oneShotSecurityGroup, verificationTaskRole, oneShotExecutionRole, oneShotLogGroup, cleanupTaskRole,
      apiDistribution } = platform;
    if (!vpc || !database?.secret || !cluster || !apiSecurityGroup || !workerSecurityGroup
      || !loadBalancerSecurityGroup || !operationsTopic || !oneShotSecurityGroup
      || !verificationTaskRole || !oneShotExecutionRole || !oneShotLogGroup || !apiDistribution) {
      throw new Error('The Beta stage contract requires the existing Base VPC, database, cluster, security groups, topic, one-shot task resources and API distribution');
    }
    const path = `/anywear/${stage}/`;
    const describe = (detail: string) => `${STAGE_CONTRACT_CONSUMER} stage contract: ${detail}`;
    const constructId = (parameterName: string) => `${parameterName.split('_')
      .map((part) => part[0].toUpperCase() + part.slice(1)).join('')}Param`;
    // Issue #166: the Base stack's Private tier is `PRIVATE_ISOLATED` (the Egress
    // stack adds its NAT routes while the environment runs) and the Isolated tier
    // is a separate group. Select by group name so `private_subnet_ids` publishes
    // exactly the workload tier and `isolated_subnet_ids` exactly the no-egress
    // tier, in every variant, with no stopped-state fallback.
    const privateSubnets = vpc.selectSubnets({ subnetGroupName: 'Private' }).subnets;
    const isolatedSubnets = vpc.selectSubnets({ subnetGroupName: 'Isolated' }).subnets;
    const publishedKinds = new Map<string, 'String' | 'List'>();
    const string = (parameterName: string, value: string, detail: string) => {
      const publishedName = `${path}${parameterName}`;
      publishedKinds.set(publishedName, 'String');
      this.parameters.push(new ssm.StringParameter(this, constructId(parameterName), {
        parameterName: publishedName, stringValue: value, description: describe(detail),
      }));
    };
    const stringList = (parameterName: string, value: string[], detail: string) => {
      const publishedName = `${path}${parameterName}`;
      publishedKinds.set(publishedName, 'List');
      this.parameters.push(new ssm.StringListParameter(this, constructId(parameterName), {
        parameterName: publishedName, stringListValue: value, description: describe(detail),
      }));
    };

    string('vpc_id', vpc.vpcId, 'shared Beta VPC id');
    stringList('public_subnet_ids', vpc.publicSubnets.map((subnet) => subnet.subnetId),
      'shared Beta public subnet ids');
    stringList('private_subnet_ids', privateSubnets.map((subnet) => subnet.subnetId),
      'shared Beta private subnet ids for workload tasks');
    // Issue #166: the API distribution is persistent Base state, so its public
    // endpoint is part of the unconditional stage contract. The domain is the
    // adopted distribution's own `DomainName`; no ALB resource is referenced.
    string('api_base_url', `https://${apiDistribution.attrDomainName}`,
      'public API CloudFront distribution base URL');
    string('ecs_cluster_name', cluster.clusterName, 'shared Beta ECS cluster name');
    string('database_secret_arn', database.secret.secretArn, 'Aurora credential secret ARN');
    string('database_host', database.clusterEndpoint.hostname, 'Aurora writer endpoint hostname');
    string('database_port', database.clusterEndpoint.port.toString(), 'Aurora writer endpoint port');
    string('api_security_group_id', apiSecurityGroup.securityGroupId, 'API task security group id');
    string('worker_security_group_id', workerSecurityGroup.securityGroupId, 'worker task security group id');
    string('load_balancer_security_group_id', loadBalancerSecurityGroup.securityGroupId,
      'shared load-balancer security group id; the consumer adds only its own ingress rule');
    string('service_repository_uri', platform.repository.repositoryUri, 'service ECR repository URI');
    string('service_repository_name', platform.repository.repositoryName, 'service ECR repository name');
    string('service_repository_arn', platform.repository.repositoryArn, 'service ECR repository ARN');
    string('vto_queue_url', platform.vtoQueue.queueUrl, 'VTO task queue URL');
    string('vto_queue_arn', platform.vtoQueue.queueArn, 'VTO task queue ARN');
    string('vto_queue_name', platform.vtoQueue.queueName, 'VTO task queue name');
    string('auto_tagging_queue_url', platform.autoTaggingQueue.queueUrl, 'auto-tagging task queue URL');
    string('auto_tagging_queue_arn', platform.autoTaggingQueue.queueArn, 'auto-tagging task queue ARN');
    string('auto_tagging_queue_name', platform.autoTaggingQueue.queueName, 'auto-tagging task queue name');
    string('vto_dlq_name', platform.vtoDeadLetterQueue.queueName, 'VTO dead-letter queue name');
    string('auto_tagging_dlq_name', platform.autoTaggingDeadLetterQueue.queueName, 'auto-tagging dead-letter queue name');
    string('s3_bucket_arn', platform.wardrobeBucket.bucketArn, 'wardrobe bucket ARN');
    string('operations_topic_arn', operationsTopic.topicArn, 'Beta operations SNS topic ARN');
    string('cloudfront_prefix_list_id', inputs.cloudFrontPrefixListId,
      'AWS-managed CloudFront origin-facing prefix list id for the shared load-balancer ingress');
    string('vlm_config_arn', inputs.vlmConfigArn, 'Secrets Manager ARN holding DOUBAO_VLM_API_KEY');
    // Issue #158 approved extension: the remaining stage-base values the Runtime
    // cleanup fixture and one-shot tasks read. They replace weak
    // `Fn::GetStackOutput` reads, so after Service's conversion the Base and
    // Runtime deploy order no longer matters.
    string('verification_task_role_arn', verificationTaskRole.roleArn,
      'one-shot verification task role ARN');
    string('one_shot_execution_role_arn', oneShotExecutionRole.roleArn,
      'one-shot task execution role ARN');
    string('one_shot_log_group_name', oneShotLogGroup.logGroupName,
      'one-shot task log group name');
    string('one_shot_log_group_arn', oneShotLogGroup.logGroupArn,
      'one-shot task log group ARN');
    string('one_shot_security_group_id', oneShotSecurityGroup.securityGroupId,
      'one-shot task security group id');
    string('ecs_cluster_arn', cluster.clusterArn,
      'shared Beta ECS cluster ARN for workload services and one-shot tasks');
    string('vto_dlq_url', platform.vtoDeadLetterQueue.queueUrl,
      'VTO dead-letter queue URL for the workload cleanup task');
    string('auto_tagging_dlq_url', platform.autoTaggingDeadLetterQueue.queueUrl,
      'auto-tagging dead-letter queue URL for the workload cleanup task');
    // Issue #166: the dedicated Isolated tier is built unconditionally and never
    // routed, so this list is never empty in any variant: it is exactly the
    // `Isolated` subnet group. The workload tier is published separately as
    // `private_subnet_ids`; there is no stopped-state fallback.
    stringList('isolated_subnet_ids', isolatedSubnets.map((subnet) => subnet.subnetId),
      'shared Beta isolated subnet ids for workload tasks with no egress');
    if (cleanupTaskRole) {
      string('cleanup_task_role_arn', cleanupTaskRole.roleArn,
        'dedicated cleanup task role ARN, published only while the identity phase creates it');
    }
    // `lib/contracts.mjs` is the single source of the published surface. Drift
    // here is a stage-contract change that must update the contract (and its
    // declared surface), never a local edit.
    const expectedNames = cleanupTaskRole ? STAGE_CONTRACT_READ_PARAMETERS : STAGE_CONTRACT_PARAMETERS;
    const publishedNames = [...publishedKinds.keys()].sort();
    const unexpectedName = publishedNames.find((name, index) => name !== expectedNames[index]);
    if (publishedNames.length !== expectedNames.length || unexpectedName !== undefined) {
      throw new Error(`Stage contract parameters differ from lib/contracts.mjs: expected ${expectedNames.length}, got ${publishedNames.length}`
        + (unexpectedName ? ` (first difference ${unexpectedName})` : ''));
    }
    const expectedKinds = new Map(stageParameters().map(definition => [definition.parameter, definition.kind]));
    for (const [publishedName, kind] of publishedKinds) {
      if (expectedKinds.get(publishedName) !== kind) {
        throw new Error(`Stage contract parameter ${publishedName} differs from the reviewed ${expectedKinds.get(publishedName) ?? 'absent'} value kind`);
      }
    }
  }
}
