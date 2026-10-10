import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { CleanupAcceptance } from '../lib/cleanup-acceptance';

describe('Separate protected cleanup acceptance capability', () => {
  const stack = new cdk.Stack(new cdk.App(), 'Fixture', { env: { account: '650880818323', region: 'ap-east-1' } });
  const vpc = ec2.Vpc.fromVpcAttributes(stack, 'Vpc', { vpcId: 'vpc-fixture', availabilityZones: ['ap-east-1a'] });
  const role = (id: string) => iam.Role.fromRoleArn(stack, id, `arn:aws:iam::650880818323:role/${id}`);
  new CleanupAcceptance(stack, 'CleanupAcceptance', {
    cluster: ecs.Cluster.fromClusterAttributes(stack, 'Cluster', { clusterArn: 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear', clusterName: 'beta-anywear', vpc }),
    vpc, securityGroup: ec2.SecurityGroup.fromSecurityGroupId(stack, 'SecurityGroup', 'sg-fixture'),
    subnets: [ec2.Subnet.fromSubnetId(stack, 'Subnet', 'subnet-fixture')],
    repository: ecr.Repository.fromRepositoryName(stack, 'Repository', 'beta-anywear-service'),
    imageDigest: `sha256:${'a'.repeat(64)}`, serviceCommit: 'b'.repeat(40), apiBaseUrl: 'https://api.example.invalid',
    cleanupTaskRole: role('cleanup-task'), verificationTaskRole: role('verification-task'), executionRole: role('execution-task'),
    logGroup: logs.LogGroup.fromLogGroupName(stack, 'Logs', '/anywear/beta/one-shot'),
    databaseSecretArn: 'secret-fixture', databaseHost: 'db.example.invalid', databasePort: '5432', databaseName: 'anywear', bucketName: 'beta-fixture',
    vtoQueueUrl: 'vto', taggingQueueUrl: 'tagging', vtoDlqUrl: 'vto-dlq', taggingDlqUrl: 'tagging-dlq',
  });
  const template = Template.fromStack(stack).toJSON();
  const [id, definition] = Object.entries(template.Resources).find(([, resource]: [string, any]) => resource.Type === 'AWS::ECS::TaskDefinition')! as [string, any];

  it('preprovisions only the fixed Service fixture and seals its issue/source/image environment', () => {
    expect(definition.Properties.Family).toBe('beta-anywear-cleanup-acceptance');
    expect(definition.Properties.TaskRoleArn).toBe('arn:aws:iam::650880818323:role/cleanup-task');
    expect(definition.Properties.ContainerDefinitions).toHaveLength(1);
    const container = definition.Properties.ContainerDefinitions[0];
    expect(container.Command).toEqual(['node', 'dist/ops/beta-cleanup-acceptance-fixture.js']);
    const environment = Object.fromEntries(container.Environment.map((row: any) => [row.Name, row.Value]));
    expect(environment).toMatchObject({ STAGE: 'beta', BETA_CLEANUP_ACCEPTANCE_ISSUE: '86', SERVICE_COMMIT_SHA: 'b'.repeat(40), IMAGE_DIGEST: `sha256:${'a'.repeat(64)}` });
    expect(environment).not.toHaveProperty('SQS_VTO_DLQ_URL');
    expect(environment).not.toHaveProperty('BETA_TESTER_ALLOWLIST_PARAMETER');
    expect(container.LogConfiguration.Options).toEqual({ 'awslogs-group': '/anywear/beta/one-shot', 'awslogs-region': 'ap-east-1', 'awslogs-stream-prefix': 'beta-anywear-cleanup-acceptance' });
    expect(definition.DeletionPolicy).toBe('Retain');
    expect(definition.UpdateReplacePolicy).toBe('Retain');
    expect(template.Outputs.CleanupAcceptanceTaskDefinitionArn).toEqual({ Value: { Ref: id } });
  });

  it('adds only exact task execution, two PassRole identities and fixed logs to the existing Infra role', () => {
    const resources = Object.values(template.Resources) as any[];
    expect(resources.some(resource => resource.Type === 'AWS::IAM::Role')).toBe(false);
    const policy = resources.find(resource => resource.Type === 'AWS::IAM::Policy'
      && JSON.stringify(resource.Properties.Roles) === JSON.stringify(['beta-infra-runtime-role']));
    expect(policy.Properties.Roles).toEqual(['beta-infra-runtime-role']);
    const statements = policy.Properties.PolicyDocument.Statement;
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatchObject({ Action: 'ecs:RunTask', Resource: { Ref: id }, Condition: { ArnEquals: { 'ecs:cluster': 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear' } } });
    expect(statements[1]).toMatchObject({ Action: 'iam:PassRole', Resource: ['arn:aws:iam::650880818323:role/cleanup-task', 'arn:aws:iam::650880818323:role/execution-task'], Condition: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } } });
    expect(JSON.stringify(statements[2])).toContain('/anywear/beta/one-shot:log-stream:beta-anywear-cleanup-acceptance/OneShot/*');
    expect(JSON.stringify(policy)).not.toMatch(/RegisterTaskDefinition|StopTask|DeregisterTaskDefinition|states:|ssm:|sqs:|beta-e2e/);
  });
});
