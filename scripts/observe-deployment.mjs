import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseJson, contentHash, exact, matches, SHA } from './json-contract.mjs';
import { validateSnapshot, stableLambdaConfiguration, account, region, INFRA_REPOSITORY, stageContractSchemaHash } from './deployment-contract.mjs';
import { readStageInputs } from './stage-contract-parameters.mjs';
import { configuredStacks } from './operation-stacks.mjs';
import { assertProtectedExecutor } from './operation-boundaries.mjs';

const execute = promisify(execFile);
const outputMap = stack => Object.fromEntries((stack.Outputs ?? []).map(item => [item.OutputKey, item.OutputValue]));

export function liveObservationIo() {
  return {
    async aws(args, awsRegion = region) {
      const result = await execute('aws', [...args, '--region', awsRegion, '--output', 'json'], { timeout: 600_000, maxBuffer: 10 * 1024 * 1024 });
      return result.stdout.trim() ? parseJson(result.stdout) : {};
    },
    async http(url) {
      const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('Deployed application identity unavailable');
      return parseJson(Buffer.from(await response.arrayBuffer()));
    },
  };
}

// The authenticated observation behind a v3 deployment record. It covers exactly
// the stacks Infra still produces (Foundation, the Beta stage base, Billing) and
// the stage-base resources Infra owns: the two Service-built Lambdas, the two task
// queues and the Client distribution. The release slice — task definitions, ECS
// services, API distribution, alarms — is owned and observed by AnyWear-Service's
// release chain; it is deliberately not read here, so this record cannot claim an
// observation it no longer produces.
export async function observeDeployment({ infraSha, io = liveObservationIo(), env = process.env }) {
  matches(infraSha, SHA, 'Observed Infra input');
  assertProtectedExecutor(infraSha, env);
  if (env.AWS_REGION !== region || env.AWS_ACCOUNT_ID !== account || (await io.aws(['sts', 'get-caller-identity'])).Account !== account) {
    throw new Error('Unexpected authenticated observer account/region');
  }
  const stacks = []; const actualStacks = new Map();
  for (const configured of configuredStacks) {
    const response = await io.aws(['cloudformation', 'describe-stacks', '--stack-name', configured.stack_name], configured.region);
    const actual = response.Stacks?.[0];
    if (response.Stacks?.length !== 1 || actual.StackName !== configured.stack_name
      || !['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE'].includes(actual.StackStatus)) throw new Error('CloudFormation stack not terminal');
    const original = (await io.aws(['cloudformation', 'get-template', '--stack-name', actual.StackId, '--template-stage', 'Original'], configured.region)).TemplateBody;
    if (!original) throw new Error('Original deployed template missing');
    const body = typeof original === 'string' ? parseJson(original) : original;
    stacks.push({ name: configured.stack_name, region: configured.region, producer_repository: INFRA_REPOSITORY,
      producer_sha: infraSha, template_sha256: contentHash(body) });
    actualStacks.set(configured.stack_name, actual);
  }
  const platform = outputMap(actualStacks.get('AnyWearPlatformStack-beta'));
  if (platform.BetaActive !== 'true') throw new Error('Only active Beta may issue runtime deployment evidence');
  const lambdas = {};
  for (const [key, functionName] of [['pre-sign-up', 'beta-anywear-pre-sign-up'], ['post-confirmation', 'beta-anywear-post-confirmation-sync']]) {
    const config = (await io.aws(['lambda', 'get-function', '--function-name', functionName])).Configuration;
    if (config?.FunctionArn !== `arn:aws:lambda:${region}:${account}:function:${functionName}` || config.LastUpdateStatus !== 'Successful') {
      throw new Error('Actual Lambda identity/update state unproven');
    }
    lambdas[key] = { code_sha256: config.CodeSha256, configuration_sha256: contentHash(stableLambdaConfiguration(config)) };
  }
  const queueConfig = {};
  for (const [key, output] of [['vto', 'VtoQueueUrl'], ['auto-tagging', 'AutoTaggingQueueUrl']]) {
    const attrs = (await io.aws(['sqs', 'get-queue-attributes', '--queue-url', platform[output], '--attribute-names', 'QueueArn', 'VisibilityTimeout', 'RedrivePolicy'])).Attributes;
    if (!attrs?.QueueArn?.startsWith(`arn:aws:sqs:${region}:${account}:beta-anywear-`)) throw new Error('Foreign queue observation');
    const redrive = parseJson(attrs.RedrivePolicy);
    queueConfig[key] = { queueVisibilitySeconds: Number(attrs.VisibilityTimeout), maxReceives: Number(redrive.maxReceiveCount) };
  }
  const endpoints = {};
  // Older outputs expose ClientBaseUrl; domain fallback is only that exact deployed interface.
  if (platform.ClientBaseUrl) endpoints.client = platform.ClientBaseUrl;
  else if (platform.ClientDistributionDomainName) endpoints.client = `https://${platform.ClientDistributionDomainName}`;
  else {
    const distribution = await io.aws(['cloudfront', 'get-distribution', '--id', platform.ClientDistributionId]);
    endpoints.client = `https://${distribution.Distribution.DomainName}`;
  }
  const client = await io.http(`${endpoints.client}/build-metadata.json?infra=${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`);
  if (client.component !== 'AnyWear-Client') throw new Error('Public Client identity mismatch');
  const inputs = await readStageInputs(io);
  const body = { stacks, inputs, observed: { lambdas, queue_config_sha256: contentHash(queueConfig), client_sha: client.source_commit, endpoints },
    schema: { content_sha256: stageContractSchemaHash(inputs) } };
  validateSnapshot({ stacks: body.stacks, observed: body.observed, schema: body.schema });
  // End the observation with stack-version checks to detect a deployment crossing
  // the bounded task window; E2E independently repeats the full snapshot after suite.
  for (const [name, original] of actualStacks) {
    const observed = stacks.find(stack => stack.name === name);
    const after = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', original.StackId], observed.region)).Stacks?.[0];
    if (after?.StackId !== original.StackId || after.StackStatus !== original.StackStatus
      || (after.LastUpdatedTime ?? after.CreationTime) !== (original.LastUpdatedTime ?? original.CreationTime)) {
      throw new Error('Stack changed during authenticated observation');
    }
  }
  return body;
}
