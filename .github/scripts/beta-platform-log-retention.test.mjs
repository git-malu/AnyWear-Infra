import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enforceBetaPlatformLogRetention } from './beta-platform-log-retention.mjs';

const account = '650880818323';
const region = 'ap-east-1';
const stackId = `arn:aws:cloudformation:${region}:${account}:stack/AnyWearPlatformStack-beta/abc123`;
const functionNames = ['beta-anywear-pre-sign-up', 'beta-anywear-post-confirmation-sync',
  'AnyWearPlatformStack-beta-CustomS3AutoDeleteObjects', 'AnyWearPlatformStack-beta-CustomVpcRestrictDefaultSG',
  'AnyWearPlatformStack-beta-LogRetentionaae0aa3c5b4d-OAtI4sIVYXol'];

function fakeIo({ drift = '', paginate = false, arnWithSuffix = true, actualDrift = '', accountValue = account,
  regionValue = region, resourcePagination = '', retentionMismatch = false, stackVersionDrift = false } = {}) {
  const retention = new Map(functionNames.map((name) => [`/aws/lambda/${name}`,
    retentionMismatch || drift === 'one-day' ? 1 : 14]));
  let pages = 0;
  let stackReads = 0;
  const calls = [];
  const resources = functionNames.map((PhysicalResourceId, index) => ({ LogicalResourceId: index === 4 ? 'LogRetentionaae0aa3b' : `Lambda${index}`,
    PhysicalResourceId, ResourceType: 'AWS::Lambda::Function', ResourceStatus: 'UPDATE_COMPLETE' }));
  return { region: regionValue, calls, async sleep() {}, async aws(args) {
    calls.push(args);
    if (args[0] === 'sts') return { Account: accountValue };
    if (args[0] === 'cloudformation' && args[1] === 'describe-stacks') {
      if (drift === 'foreign-stack') return { Stacks: [{ StackName: 'other', StackId: stackId, StackStatus: 'UPDATE_COMPLETE' }] };
      stackReads += 1;
      return { Stacks: [{ StackName: 'AnyWearPlatformStack-beta', StackId: stackId, StackStatus: 'UPDATE_COMPLETE',
        LastUpdatedTime: stackVersionDrift && stackReads > 1 ? '2026-10-05T00:00:01Z' : '2026-10-05T00:00:00Z' }] };
    }
    if (args[0] === 'cloudformation' && args[1] === 'list-stack-resources') {
      if (drift === 'missing') return { StackResourceSummaries: resources.slice(0, 4) };
      if (resourcePagination === 'repeated') return { StackResourceSummaries: resources, NextToken: 'repeat' };
      if (resourcePagination === 'exhausted') return { StackResourceSummaries: resources, NextToken: `next-${pages++}` };
      if (paginate && pages++ === 0) return { StackResourceSummaries: resources.slice(0, 3), NextToken: 'next' };
      return { StackResourceSummaries: paginate ? resources.slice(3) : resources };
    }
    if (args[0] === 'lambda') {
      const name = args.at(-1);
      return { Configuration: { FunctionName: name,
        FunctionArn: actualDrift === 'foreign-arn' ? `arn:aws:lambda:us-east-1:1:function:${name}`
          : `arn:aws:lambda:${region}:${account}:function:${name}`,
        ...(actualDrift === 'foreign-log-group' ? { LoggingConfig: { LogGroup: '/aws/lambda/foreign' } } : {}) } };
    }
    if (args[0] === 'logs' && args[1] === 'describe-log-groups') {
      const name = args[args.indexOf('--log-group-name-prefix') + 1];
      if (drift === 'missing-group') return { logGroups: [] };
      if (drift === 'foreign-group') return { logGroups: [{ logGroupName: name, arn: 'arn:aws:logs:us-east-1:1:log-group:foreign:*' }] };
      const arn = `arn:aws:logs:${region}:${account}:log-group:${name}`;
      return { logGroups: [{ logGroupName: name, arn: arnWithSuffix ? `${arn}:*` : arn, logGroupArn: arnWithSuffix ? undefined : `${arn}:*`, retentionInDays: retention.get(name) }] };
    }
    if (args[0] === 'logs' && args[1] === 'put-retention-policy') {
      if (!retentionMismatch) retention.set(args[args.indexOf('--log-group-name') + 1], 14);
      return {};
    }
    assert.fail(`Unexpected AWS call: ${args.join(' ')}`);
  } };
}

test('updates only exact current Beta stack-owned Lambda groups and verifies readback', async () => {
  const io = fakeIo({ drift: 'one-day', paginate: true, arnWithSuffix: false });
  const result = await enforceBetaPlatformLogRetention(io, { ref: 'refs/heads/main', enabled: 'true' });
  assert.equal(result.retention_in_days, 14);
  assert.deepEqual(result.groups.map((group) => group.function_name), functionNames);
  assert.equal(io.calls.filter((args) => args[0] === 'logs' && args[1] === 'put-retention-policy').length, 5);
});

test('fails closed for foreign or incomplete stack-owned log inventory', async () => {
  for (const drift of ['foreign-stack', 'foreign-group', 'missing']) {
    await assert.rejects(enforceBetaPlatformLogRetention(fakeIo({ drift }), { ref: 'refs/heads/main', enabled: 'true' }), /foreign|missing|inventory|identity/);
  }
});

test('requires the protected Beta dispatch gate before any AWS mutation', async () => {
  for (const options of [{ ref: 'refs/heads/review', enabled: 'true' }, { ref: 'refs/heads/main', enabled: 'false' }]) {
    const io = fakeIo();
    await assert.rejects(enforceBetaPlatformLogRetention(io, options), /main|gate/);
    assert.equal(io.calls.length, 0);
  }
});

test('fails closed for foreign Lambda identity, wrong account or region, and missing groups', async () => {
  for (const options of [
    { actualDrift: 'foreign-arn' },
    { actualDrift: 'foreign-log-group' },
    { accountValue: '1' },
    { regionValue: 'us-east-1' },
    { drift: 'missing-group' },
  ]) {
    const io = fakeIo(options);
    await assert.rejects(enforceBetaPlatformLogRetention(io, { ref: 'refs/heads/main', enabled: 'true' }), /foreign|Unexpected|Actual|missing|incomplete|regional/);
    assert.equal(io.calls.filter((args) => args[0] === 'logs' && args[1] === 'put-retention-policy').length, 0);
  }
});

test('fails closed for post-write retention mismatch, pagination loops, and stack drift before writes', async () => {
  for (const options of [
    { retentionMismatch: true },
    { resourcePagination: 'repeated' },
    { resourcePagination: 'exhausted' },
    { stackVersionDrift: true },
  ]) {
    const io = fakeIo(options);
    await assert.rejects(enforceBetaPlatformLogRetention(io, { ref: 'refs/heads/main', enabled: 'true' }), /retention|pagination|token|stack changed|complete/);
    assert.equal(io.calls.filter((args) => args[0] === 'logs' && args[1] === 'put-retention-policy').length,
      options.retentionMismatch ? 1 : 0);
  }
});

test('standalone legacy log-retention adapter fails before cloud access even with an enabled gate', async () => {
  const execute = promisify(execFile);
  await assert.rejects(execute(process.execPath, ['.github/scripts/beta-platform-log-retention.mjs'], {
    env: { ...process.env, GITHUB_REF: 'refs/heads/main', ENABLE_BETA_DEPLOY: 'true', AWS_REGION: 'ap-east-1' }, timeout: 10_000,
  }), error => error.code === 1 && /Use scripts\/runtime-operation.mjs with the committed selection/.test(error.stderr));
});
