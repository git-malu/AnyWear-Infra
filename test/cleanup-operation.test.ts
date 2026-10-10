import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { CleanupOperation } from '../lib/cleanup-operation';

const commit = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const clusterArn = 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear';

function fixture() {
  const stack = new cdk.Stack(new cdk.App(), 'CleanupProof', { env: { account: '650880818323', region: 'ap-east-1' } });
  const vpc = ec2.Vpc.fromVpcAttributes(stack, 'Vpc', { vpcId: 'vpc-fixture', availabilityZones: ['ap-east-1a'] });
  const role = (id: string) => iam.Role.fromRoleArn(stack, id, `arn:aws:iam::650880818323:role/${id}`);
  new CleanupOperation(stack, 'CleanupOperation', {
    cluster: ecs.Cluster.fromClusterAttributes(stack, 'Cluster', { clusterArn, clusterName: 'beta-anywear', vpc }),
    vpc, securityGroup: ec2.SecurityGroup.fromSecurityGroupId(stack, 'SecurityGroup', 'sg-fixture'),
    subnets: [ec2.Subnet.fromSubnetId(stack, 'Subnet', 'subnet-fixture')],
    repository: ecr.Repository.fromRepositoryName(stack, 'Repository', 'beta-anywear-service'),
    imageDigest: digest, serviceCommit: commit, apiBaseUrl: 'https://api.example.invalid',
    cleanupTaskRole: role('cleanup-task'), verificationTaskRole: role('verification-task'), executionRole: role('execution-task'),
    logGroup: logs.LogGroup.fromLogGroupName(stack, 'Logs', '/anywear/beta/one-shot'),
    databaseSecretArn: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:db-fixture',
    databaseHost: 'db.example.invalid', databasePort: '5432', databaseName: 'anywear', bucketName: 'beta-fixture',
    vtoQueueUrl: 'https://sqs.ap-east-1.amazonaws.com/650880818323/vto',
    taggingQueueUrl: 'https://sqs.ap-east-1.amazonaws.com/650880818323/tagging',
    vtoDlqUrl: 'https://sqs.ap-east-1.amazonaws.com/650880818323/vto-dlq',
    taggingDlqUrl: 'https://sqs.ap-east-1.amazonaws.com/650880818323/tagging-dlq',
  });
  const template = Template.fromStack(stack).toJSON();
  const definitions = Object.entries(template.Resources).filter(([, resource]: [string, any]) => resource.Type === 'AWS::ECS::TaskDefinition');
  const refs: Record<string, string> = { 'AWS::Partition': 'aws' };
  definitions.forEach(([id, resource]: [string, any], index) => {
    refs[id] = `arn:aws:ecs:ap-east-1:650880818323:task-definition/${resource.Properties.Family}:${index + 1}`;
  });
  const resolve = (value: any): any => {
    if (Array.isArray(value)) return value.map(resolve);
    if (!value || typeof value !== 'object') return value;
    if (value.Ref) return refs[value.Ref] ?? value.Ref;
    if (value['Fn::Join']) return value['Fn::Join'][1].map(resolve).join(value['Fn::Join'][0]);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
  };
  const machine = (Object.values(template.Resources) as any[]).find(resource => resource.Type === 'AWS::StepFunctions::StateMachine');
  return { template, definition: JSON.parse(resolve(machine.Properties.DefinitionString)), refs };
}

// Evaluate the emitted ASL Choice rules against task responses, including
// absent fields. Unsupported rules fail the test instead of granting success.
function matches(rule: any, input: any): boolean {
  if (rule.And) return rule.And.every((item: any) => matches(item, input));
  if (rule.Not) return !matches(rule.Not, input);
  const value = rule.Variable.slice(2).replace(/\[(\d+)\]/g, '.$1').split('.')
    .reduce((current: any, key: string) => current?.[key], input);
  if ('IsPresent' in rule) return (value !== undefined) === rule.IsPresent;
  if ('IsString' in rule) return (typeof value === 'string') === rule.IsString;
  if ('StringEquals' in rule) return typeof value === 'string' && value === rule.StringEquals;
  if ('NumericEquals' in rule) return typeof value === 'number' && value === rule.NumericEquals;
  if ('StringMatches' in rule) {
    const pattern = rule.StringMatches.split('*').map((part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return typeof value === 'string' && new RegExp(`^${pattern}$`).test(value);
  }
  throw new Error(`Unsupported Choice rule: ${JSON.stringify(rule)}`);
}

describe('Fixed cleanup execution proof', () => {
  const { template, definition, refs } = fixture();
  const states = definition.States;
  const response = (name: string) => ({
    TaskArn: `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'c'.repeat(32)}`,
    ClusterArn: clusterArn, TaskDefinitionArn: states[name].Parameters.TaskDefinition, LastStatus: 'STOPPED',
    Containers: [{ Name: 'OneShot', LastStatus: 'STOPPED', ExitCode: 0, ImageDigest: digest }],
  });

  it('seals full task revisions and the original request inside the machine version', () => {
    expect(states.Verify.Parameters.TaskDefinition).toBe(Object.values(refs).find(value => value.includes('cleanup-verify:')));
    expect(states.Cleanup.Parameters.TaskDefinition).toBe(Object.values(refs).find(value => value.includes('cleanup:')));
    expect(states.Verify.Parameters['ClientToken.$']).toBe("States.Hash(States.Format('{}:verify', $$.Execution.Id), 'SHA-256')");
    expect(states.Cleanup.Parameters['ClientToken.$']).toBe("States.Hash(States.Format('{}:cleanup', $$.Execution.Id), 'SHA-256')");
    expect(states.Verify).not.toHaveProperty('Retry');
    expect(states.Cleanup).not.toHaveProperty('Retry');
    expect(states.CaptureRequest.Parameters).toEqual({ 'envelope.$': 'States.JsonToString($)' });
    expect(states.Cleanup.Parameters.Overrides.ContainerOverrides).toEqual([{ Name: 'OneShot',
      'Command.$': "States.Array('node', 'dist/ops/beta-cleanup-operation.js', $.request_binding.envelope)" }]);
    expect(states.CleanupResult.Parameters).not.toHaveProperty('transaction_committed');
    expect(states.CleanupResult.Parameters['cleanup_task_arn.$']).toBe('$.cleanup.TaskArn');
    expect(states.CleanupResult.Parameters['cleanup_task_status.$']).toBe('$.cleanup.LastStatus');
    expect(states.CleanupResult.Parameters['cleanup_exit_code.$']).toBe('$.cleanup.Containers[0].ExitCode');
  });

  it.each(['verification', 'cleanup'])('rejects failed, missing and ambiguous %s task results', (key) => {
    const name = key === 'verification' ? 'Verify' : 'Cleanup';
    const choice = states[key === 'verification' ? 'VerificationSucceeded' : 'CleanupSucceeded'];
    expect(matches(choice.Choices[0], { [key]: response(name) })).toBe(true);
    const badResults = [
      { ...response(name), LastStatus: 'RUNNING' },
      { ...response(name), TaskDefinitionArn: `${states[name].Parameters.TaskDefinition}0` },
      { ...response(name), ClusterArn: clusterArn.replace('beta-anywear', 'other') },
      { ...response(name), Containers: [{ Name: 'OneShot', ExitCode: 1, ImageDigest: digest }] },
      { ...response(name), Containers: [{ Name: 'OneShot', ImageDigest: digest }] },
      { ...response(name), Containers: [{ Name: 'Other', ExitCode: 0, ImageDigest: digest }] },
      { ...response(name), Containers: [{ Name: 'OneShot', ExitCode: 0, ImageDigest: `sha256:${'d'.repeat(64)}` }] },
      { ...response(name), Containers: [{ ...response(name).Containers[0], LastStatus: 'RUNNING' }] },
      { ...response(name), Containers: [...response(name).Containers, ...response(name).Containers] },
      {},
    ];
    for (const task of badResults) expect(matches(choice.Choices[0], { [key]: task })).toBe(false);
    expect(choice.Default).toBe('TaskFailed');
    expect(states.TaskFailed.Type).toBe('Fail');
  });

  it('rejects wrong identities and malformed metadata before either task runs', () => {
    const envelope = { schema_version: 1, operation_id: 'beta-tester-cleanup:123', run_scope: '123',
      request_sha256: 'd'.repeat(64), service_commit_sha: commit, service_image_digest: digest, cleanup_request: '{}' };
    const gate = states.ValidateEnvelope;
    expect(matches(gate.Choices[0], envelope)).toBe(true);
    expect(gate.Choices[0].Next).toBe('CaptureRequest');
    for (const bad of [{ ...envelope, service_commit_sha: 'e'.repeat(40) }, { ...envelope, service_image_digest: 'other' },
      { ...envelope, cleanup_request: {} }, { ...envelope, request_sha256: null }, { ...envelope, run_scope: '' }]) {
      expect(matches(gate.Choices[0], bad)).toBe(false);
    }
    expect(gate.Default).toBe('InvalidRequest');
  });

  it('grants only version execution and bounded task and log reads to the E2E consumer', () => {
    const policy = (Object.values(template.Resources) as any[]).find(resource => resource.Type === 'AWS::IAM::Policy'
      && resource.Properties.Roles.includes('beta-e2e-qualification-role'));
    const grants = policy.Properties.PolicyDocument.Statement;
    const describe = grants.find((grant: any) => [grant.Action].flat().includes('states:DescribeExecution'));
    expect(JSON.stringify(describe.Resource)).toContain(':execution:beta-anywear-tester-cleanup:*');
    expect(JSON.stringify(describe.Resource)).not.toContain(':execution/');
    const logRead = grants.find((grant: any) => [grant.Action].flat().includes('logs:GetLogEvents'));
    expect(logRead.Resource).toHaveLength(2);
    expect(JSON.stringify(logRead.Resource)).toContain('/anywear/beta/one-shot:log-stream:beta-anywear-cleanup/OneShot/*');
    expect(JSON.stringify(grants)).not.toMatch(/ecs:(RunTask|RegisterTaskDefinition|StopTask)|ssm:|sqs:|iam:PassRole/);
  });

  it('retains immutable versions, task revisions and the named machine history', () => {
    const resources = (Object.values(template.Resources) as any[]).filter(resource =>
      ['AWS::ECS::TaskDefinition', 'AWS::StepFunctions::StateMachine', 'AWS::StepFunctions::StateMachineVersion'].includes(resource.Type));
    expect(resources).toHaveLength(4);
    for (const resource of resources) {
      expect(resource.DeletionPolicy).toBe('Retain');
      expect(resource.UpdateReplacePolicy).toBe('Retain');
    }
    const machine = resources.find(resource => resource.Type === 'AWS::StepFunctions::StateMachine');
    expect(JSON.stringify(machine.DependsOn)).toContain('StateMachineRoleDefaultPolicy');
  });
});
