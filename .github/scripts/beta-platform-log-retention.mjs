import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const account = '650880818323';
const region = 'ap-east-1';
const stackName = 'AnyWearPlatformStack-beta';
const functionNames = ['beta-anywear-pre-sign-up', 'beta-anywear-post-confirmation-sync'];
const pause = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

async function pages(io, args, field, tokenField) {
  const rows = [];
  const seen = new Set();
  let token;
  for (let page = 0; page < 16; page += 1) {
    const value = await io.aws([...args, '--no-paginate', ...(token ? ['--next-token', token] : [])]);
    if (!Array.isArray(value[field])) throw new Error('Incomplete exact Beta inventory page');
    rows.push(...value[field]);
    if (rows.length > 256) throw new Error('Exact Beta inventory exceeded its bound');
    token = value[tokenField];
    if (token === undefined || token === null) return rows;
    if (typeof token !== 'string' || !token || token.length > 4096 || seen.has(token)) {
      throw new Error('Invalid or repeated Beta inventory pagination token');
    }
    seen.add(token);
  }
  throw new Error('Exact Beta inventory pagination did not complete');
}

async function ownedStack(io, expectedId) {
  const result = await io.aws(['cloudformation', 'describe-stacks', '--stack-name', expectedId ?? stackName]);
  const stack = result.Stacks?.[0];
  if (result.Stacks?.length !== 1 || stack.StackName !== stackName
    || !new RegExp(`^arn:aws:cloudformation:${region}:${account}:stack/${stackName}/[a-f0-9-]+$`).test(stack.StackId ?? '')
    || (expectedId && stack.StackId !== expectedId)
    || !['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE'].includes(stack.StackStatus)) {
    throw new Error('Current exact Beta stack identity or terminal state is unproven');
  }
  const version = stack.LastUpdatedTime ?? stack.CreationTime;
  if (!Number.isFinite(Date.parse(version))) throw new Error('Exact Beta stack version is missing');
  return { id: stack.StackId, version };
}

async function exactGroup(io, name, expectedRetention) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const groups = await pages(io, ['logs', 'describe-log-groups', '--log-group-name-prefix', name, '--limit', '50'], 'logGroups', 'nextToken');
    const exact = groups.filter((group) => group.logGroupName === name);
    if (exact.length > 1) throw new Error('Exact Beta log group is ambiguous');
    if (exact.length === 1) {
      const group = exact[0];
      const arn = `arn:aws:logs:${region}:${account}:log-group:${name}`;
      const returnedArns = [group.arn, group.logGroupArn].filter((value) => value !== undefined);
      if (returnedArns.length === 0 || returnedArns.some((value) => ![arn, `${arn}:*`].includes(value))) {
        throw new Error('Exact Beta log group ARN is foreign or missing');
      }
      if (expectedRetention === undefined || group.retentionInDays === expectedRetention) return group;
    }
    if (attempt < 2) await io.sleep(1000);
  }
  throw new Error('Exact Beta log group is missing or retention readback is incomplete');
}

export async function enforceBetaPlatformLogRetention(io, {
  ref = process.env.GITHUB_REF, enabled = process.env.ENABLE_BETA_DEPLOY,
} = {}) {
  if (ref !== 'refs/heads/main' || enabled !== 'true' || io.region !== region) {
    throw new Error('Log retention requires main and the protected Beta regional gate');
  }
  if ((await io.aws(['sts', 'get-caller-identity'])).Account !== account) throw new Error('Unexpected Beta log retention account');
  const stack = await ownedStack(io);
  const resources = await pages(io, ['cloudformation', 'list-stack-resources', '--stack-name', stack.id], 'StackResourceSummaries', 'NextToken');
  const functions = resources.filter((resource) => resource.ResourceType === 'AWS::Lambda::Function');
  if (functions.length < 3 || functions.length > 32) throw new Error('Exact Beta Lambda inventory is empty or exceeds its bound');
  const names = new Set();
  const targets = [];
  for (const resource of functions) {
    const name = resource.PhysicalResourceId;
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name ?? '')
      || (!functionNames.includes(name) && !name.startsWith(`${stackName}-`))
      || !/^[A-Za-z0-9]+$/.test(resource.LogicalResourceId ?? '')
      || !['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE'].includes(resource.ResourceStatus)
      || names.has(name)) throw new Error('Beta Lambda ownership is foreign, duplicate, or incomplete');
    names.add(name);
    const actual = (await io.aws(['lambda', 'get-function', '--function-name', name])).Configuration;
    const logGroupName = `/aws/lambda/${name}`;
    if (actual?.FunctionName !== name || actual.FunctionArn !== `arn:aws:lambda:${region}:${account}:function:${name}`
      || (actual.LoggingConfig?.LogGroup !== undefined && actual.LoggingConfig.LogGroup !== logGroupName)) {
      throw new Error('Actual Beta Lambda ARN or log destination does not match the owned resource');
    }
    await exactGroup(io, logGroupName);
    targets.push({ logical_id: resource.LogicalResourceId, function_name: name, log_group_name: logGroupName });
  }
  if (functionNames.some((name) => !names.has(name)) || !functions.some((resource) => resource.LogicalResourceId.startsWith('LogRetention'))) {
    throw new Error('Required Beta application or retention helper inventory is missing');
  }
  if ((await ownedStack(io, stack.id)).version !== stack.version) throw new Error('Beta stack changed during retention preflight');
  for (const target of targets) {
    await io.aws(['logs', 'put-retention-policy', '--log-group-name', target.log_group_name, '--retention-in-days', '14']);
    await exactGroup(io, target.log_group_name, 14);
  }
  if ((await ownedStack(io, stack.id)).version !== stack.version) throw new Error('Beta stack changed before retention verification completed');
  return { event: 'beta_platform_lambda_log_retention_verified', account, region, stack_id: stack.id,
    retention_in_days: 14, groups: targets };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const execute = promisify(execFile);
  enforceBetaPlatformLogRetention({ region: process.env.AWS_REGION, sleep: pause,
    async aws(args) {
      const { stdout } = await execute('aws', [...args, '--region', region, '--output', 'json'], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
      return stdout.trim() ? JSON.parse(stdout) : {};
    },
  }).then((value) => console.log(JSON.stringify(value))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
