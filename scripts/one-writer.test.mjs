import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deployOperationStack, deleteOperationStack, readApiOrigin } from './runtime-operation.mjs';
import { describeStack, runtimeStack } from './one-writer.mjs';

const baseName = 'AnyWearPlatformStack-beta';
const egressName = 'AnyWearEgressStack-beta';
const workloadName = 'AnyWearWorkloadStack-beta';
const distributionLogicalId = JSON.parse(
  readFileSync(new URL('../lib/api-distribution.json', import.meta.url), 'utf8')).logicalId;
const liveOrigin = 'beta-anywear-api-0123456789.ap-east-1.elb.amazonaws.com';

// CloudFormation answers an absent stack with this exact ValidationError and the
// CLI exits non-zero; the runner prefixes the line with `aws: [ERROR]: `. The
// reader must treat only this sentence (with or without the runner prefix) as
// absence for this exact stack name.
function stackAbsenceError(stackName) {
  const stderr = `aws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stackName} does not exist`;
  return Object.assign(new Error(`Command failed: aws cloudformation describe-stacks --stack-name ${stackName}\n${stderr}`), { stderr });
}
function unprefixedAbsenceError(stackName) {
  const stderr = `An error occurred (ValidationError) when calling the DescribeStacks operation: Stack ${stackName} does not exist`;
  return Object.assign(new Error(stderr), { stderr });
}

// Minimal mock of the runtime io: CloudFormation stack reads plus deploy/destroy.
function operationMock({ runtimeStatus } = {}) {
  const calls = []; const deployments = []; const destroys = [];
  const stacks = new Map([[baseName, { StackName: baseName, StackStatus: 'UPDATE_COMPLETE' }],
    [egressName, { StackName: egressName, StackStatus: 'CREATE_COMPLETE',
      Outputs: [{ OutputKey: 'EgressNatEipAllocationId', OutputValue: 'eipalloc-0a5198fb91b876949' }] }]]);
  if (runtimeStatus !== undefined) stacks.set(runtimeStack, { StackName: runtimeStack, StackStatus: runtimeStatus });
  return { calls, deployments, destroys,
    async aws(args) {
      calls.push([...args]);
      assert.equal(args[0], 'cloudformation');
      assert.equal(args[1], 'describe-stacks');
      const name = args[args.indexOf('--stack-name') + 1];
      const stack = stacks.get(name);
      if (!stack) throw stackAbsenceError(name);
      return { Stacks: [stack] };
    },
    async deploy(stack) { calls.push(['deploy', stack]); deployments.push(stack); },
    async destroy(stack) { calls.push(['destroy', stack]); destroys.push(stack); } };
}

test('describeStack treats only the exact CloudFormation absence sentences as absence', async () => {
  for (const error of [stackAbsenceError(runtimeStack), unprefixedAbsenceError(runtimeStack)]) {
    assert.equal(await describeStack({ async aws() { throw error; } }, runtimeStack), undefined);
  }
  // Absence of another stack is not this stack's absence, prefixed or not.
  for (const error of [stackAbsenceError('OtherStack'), unprefixedAbsenceError('OtherStack')]) {
    await assert.rejects(describeStack({ async aws() { throw error; } }, runtimeStack), /OtherStack does not exist/);
  }
  // A mock that returns an empty list without the absence error fails closed.
  await assert.rejects(describeStack({ async aws() { return { Stacks: [] }; } }, runtimeStack),
    /without an absence error/);
  // Throttling, AccessDenied and network failures are never swallowed, including
  // when the runner prefixes the CLI's stderr.
  for (const failure of [
    Object.assign(new Error('An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded'),
      { stderr: 'aws: [ERROR]: An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded' }),
    Object.assign(new Error('An error occurred (AccessDenied) when calling the DescribeStacks operation: not authorized'),
      { stderr: 'aws: [ERROR]: An error occurred (AccessDenied) when calling the DescribeStacks operation: not authorized' }),
    Object.assign(new Error('An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id OtherStack does not exist'),
      { stderr: 'aws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id OtherStack does not exist' }),
    new Error('getaddrinfo ENOTFOUND cloudformation.ap-east-1.amazonaws.com'),
  ]) {
    await assert.rejects(describeStack({ async aws() { throw failure; } }, runtimeStack), /Throttling|AccessDenied|OtherStack|ENOTFOUND/);
  }
});

test('deploy-platform reads the Infra-owned Runtime stack terminal before any deploy', async () => {
  for (const runtimeStatus of ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']) {
    const io = operationMock({ runtimeStatus });
    assert.equal(await deployOperationStack(io, 'deploy-platform'), baseName);
    assert.deepEqual(io.deployments, [baseName]);
    assert.deepEqual(io.calls.map(call => call.slice(0, 2)), [['cloudformation', 'describe-stacks'], ['deploy', baseName]]);
    assert.ok(io.calls[0].includes(runtimeStack), 'the read targets the Infra-owned Runtime stack');
  }
});

test('deploy-platform proceeds while the Runtime stack is absent (stopped or pre-migration)', async () => {
  const io = operationMock();
  assert.equal(await deployOperationStack(io, 'deploy-platform'), baseName);
  assert.deepEqual(io.deployments, [baseName]);
});

test('deploy-platform fails closed before any deploy when the Runtime stack is non-terminal', async () => {
  for (const runtimeStatus of ['UPDATE_IN_PROGRESS', 'CREATE_IN_PROGRESS', 'UPDATE_ROLLBACK_FAILED']) {
    const io = operationMock({ runtimeStatus });
    await assert.rejects(deployOperationStack(io, 'deploy-platform'),
      new RegExp(`deploy-platform requires a terminal ${runtimeStack}; observed ${runtimeStatus}`));
    assert.deepEqual(io.deployments, [], `no deploy for ${runtimeStatus}`);
  }
});

test('only Base and Egress deploys read the Runtime stack', async () => {
  for (const [operation, stack] of [['deploy-foundation', 'AnyWearFoundationStack'],
    ['deploy-billing', 'AnyWearBillingStack-beta']]) {
    const io = operationMock({ runtimeStatus: 'UPDATE_IN_PROGRESS' });
    assert.equal(await deployOperationStack(io, operation), stack);
    assert.deepEqual(io.deployments, [stack]);
    assert.ok(!io.calls.some(call => call[0] === 'cloudformation'), `${operation} needs no Runtime read`);
  }
});

test('deploy-egress proceeds from an absent Runtime and otherwise reads it terminal', async () => {
  for (const runtimeStatus of [undefined, 'UPDATE_COMPLETE']) {
    const io = operationMock({ runtimeStatus });
    assert.equal(await deployOperationStack(io, 'deploy-egress'), egressName);
    assert.deepEqual(io.deployments, [egressName]);
  }
  const io = operationMock({ runtimeStatus: 'UPDATE_IN_PROGRESS' });
  await assert.rejects(deployOperationStack(io, 'deploy-egress'), /terminal AnyWearRuntimeStack-beta/);
  assert.deepEqual(io.deployments, []);
});

test('delete-egress refuses unless the Runtime stack is absent and destroys when it is absent', async () => {
  const running = operationMock({ runtimeStatus: 'UPDATE_COMPLETE' });
  await assert.rejects(deleteOperationStack(running, 'delete-egress'),
    /requires AnyWearRuntimeStack-beta to be absent; stop the Runtime stack first/);
  assert.deepEqual(running.destroys, []);

  const stopped = operationMock();
  assert.equal(await deleteOperationStack(stopped, 'delete-egress'), egressName);
  assert.deepEqual(stopped.destroys, [egressName]);
  assert.deepEqual(stopped.deployments, []);
});

test('delete-egress propagates a non-absence Runtime read failure', async () => {
  const io = operationMock();
  io.aws = async () => { throw Object.assign(new Error('An error occurred (AccessDenied) when calling the DescribeStacks operation'),
    { stderr: 'An error occurred (AccessDenied) when calling the DescribeStacks operation: not authorized' }); };
  await assert.rejects(deleteOperationStack(io, 'delete-egress'), /AccessDenied/);
  assert.deepEqual(io.destroys, []);
});

test('only delete-egress may destroy a stack', async () => {
  const io = operationMock();
  await assert.rejects(deleteOperationStack(io, 'deploy-platform'), /has no stack to delete/);
  await assert.rejects(deleteOperationStack(io, 'delete-platform'), /has no stack to delete/);
  assert.deepEqual(io.destroys, []);
});

test('M4 resolves the API origin from the adopted Base distribution when Runtime and Workload are absent', async () => {
  for (const stringBody of [false, true]) {
    const calls = [];
    const template = { Resources: {
      [distributionLogicalId]: { Type: 'AWS::CloudFront::Distribution', Properties: {
        DistributionConfig: { Origins: [{ DomainName: liveOrigin }] } } },
    } };
    const io = {
      async aws(args, region) {
        calls.push([...args, ...(region ? ['--region', region] : [])]);
        const name = args[args.indexOf('--stack-name') + 1];
        if (args[1] === 'describe-stacks') {
          if (name === runtimeStack || name === workloadName) throw stackAbsenceError(name);
          if (name === baseName) return { Stacks: [{ StackName: baseName, StackStatus: 'UPDATE_COMPLETE' }] };
          throw new Error(`Unexpected stack ${name}`);
        }
        if (args[1] === 'get-template') {
          return { TemplateBody: stringBody ? JSON.stringify(template) : template };
        }
        throw new Error(`Unexpected AWS call ${args.join(' ')}`);
      },
    };
    assert.equal(await readApiOrigin(io), liveOrigin, String(stringBody));
    assert.ok(calls.some(call => call[1] === 'get-template' && call.includes(baseName)));
  }
});

test('M4 rejects a non-domain Base distribution origin and still prefers a running Runtime output', async () => {
  const baseStack = { StackName: baseName, StackStatus: 'UPDATE_COMPLETE' };
  const invalid = { async aws(args) {
    const name = args[args.indexOf('--stack-name') + 1];
    if (args[1] === 'describe-stacks') {
      if (name === runtimeStack || name === workloadName) throw stackAbsenceError(name);
      return { Stacks: [baseStack] };
    }
    return { TemplateBody: { Resources: { [distributionLogicalId]: { Type: 'AWS::CloudFront::Distribution',
      Properties: { DistributionConfig: { Origins: [{ DomainName: 'not a domain' }] } } } } } };
  } };
  await assert.rejects(readApiOrigin(invalid), /requires the live API load-balancer DNS name/);

  const runtimeOrigin = 'beta-anywear-api-new-0123456789.ap-east-1.elb.amazonaws.com';
  const runtimeIo = { async aws(args) {
    const name = args[args.indexOf('--stack-name') + 1];
    if (args[1] === 'describe-stacks' && name === runtimeStack) {
      return { Stacks: [{ StackName: runtimeStack, StackStatus: 'UPDATE_COMPLETE',
        Outputs: [{ OutputKey: 'ApiLoadBalancerDnsName', OutputValue: runtimeOrigin }] }] };
    }
    throw new Error(`Unexpected ${args.join(' ')}`);
  } };
  assert.equal(await readApiOrigin(runtimeIo), runtimeOrigin);
});

test('an existing Runtime stack without a domain output hard-errors instead of falling through', async () => {
  for (const outputs of [[], [{ OutputKey: 'ApiLoadBalancerDnsName', OutputValue: 'not a domain' }]]) {
    const calls = [];
    const io = { async aws(args) {
      calls.push([...args]);
      const name = args[args.indexOf('--stack-name') + 1];
      if (args[1] === 'describe-stacks' && name === runtimeStack) {
        return { Stacks: [{ StackName: runtimeStack, StackStatus: 'UPDATE_COMPLETE', Outputs: outputs }] };
      }
      throw new Error(`Unexpected ${args.join(' ')}`);
    } };
    await assert.rejects(readApiOrigin(io), /Runtime stack exists but its ApiLoadBalancerDnsName output is missing or not a DNS name/);
    // No Base/Workload fallback is attempted when the Runtime read itself is bad.
    assert.ok(!calls.some(call => call[1] === 'get-template'), JSON.stringify(outputs));
    assert.ok(!calls.some(call => call.includes(workloadName)), JSON.stringify(outputs));
  }
});

test('the Base literal origin is preferred over the legacy Workload output after the MOVE', async () => {
  const workloadOriginPreMove = 'beta-anywear-api-old-0123456789.ap-east-1.elb.amazonaws.com';
  const calls = [];
  const io = { async aws(args) {
    calls.push([...args]);
    const name = args[args.indexOf('--stack-name') + 1];
    if (args[1] === 'describe-stacks') {
      if (name === runtimeStack) throw stackAbsenceError(name);
      if (name === baseName) return { Stacks: [{ StackName: baseName, StackStatus: 'UPDATE_COMPLETE' }] };
      if (name === workloadName) {
        return { Stacks: [{ StackName: workloadName, StackStatus: 'UPDATE_COMPLETE',
          Outputs: [{ OutputKey: 'ApiLoadBalancerDnsName', OutputValue: workloadOriginPreMove }] }] };
      }
      throw new Error(`Unexpected stack ${name}`);
    }
    if (args[1] === 'get-template') {
      return { TemplateBody: { Resources: { [distributionLogicalId]: { Type: 'AWS::CloudFront::Distribution',
        Properties: { DistributionConfig: { Origins: [{ DomainName: liveOrigin }] } } } } } };
    }
    throw new Error(`Unexpected AWS call ${args.join(' ')}`);
  } };
  assert.equal(await readApiOrigin(io), liveOrigin);
  // The Workload read is not needed once Base carries the adopted literal.
  assert.ok(!calls.some(call => call.includes(workloadName)));
});

test('before the MOVE the legacy Workload output is the fallback when Base has no distribution', async () => {
  const workloadOriginPreMove = 'beta-anywear-api-old-0123456789.ap-east-1.elb.amazonaws.com';
  const io = { async aws(args) {
    const name = args[args.indexOf('--stack-name') + 1];
    if (args[1] === 'describe-stacks') {
      if (name === runtimeStack || name === workloadName) {
        if (name === workloadName) {
          return { Stacks: [{ StackName: workloadName, StackStatus: 'UPDATE_COMPLETE',
            Outputs: [{ OutputKey: 'ApiLoadBalancerDnsName', OutputValue: workloadOriginPreMove }] }] };
        }
        throw stackAbsenceError(name);
      }
      return { Stacks: [{ StackName: baseName, StackStatus: 'UPDATE_COMPLETE' }] };
    }
    if (args[1] === 'get-template') {
      // Live Base before the MOVE has no adopted distribution.
      return { TemplateBody: { Resources: {} } };
    }
    throw new Error(`Unexpected AWS call ${args.join(' ')}`);
  } };
  assert.equal(await readApiOrigin(io), workloadOriginPreMove);
});
