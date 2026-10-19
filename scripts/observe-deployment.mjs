import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseJson, contentHash, matches, SHA } from './json-contract.mjs';
import { validateSnapshot, stableLambdaConfiguration, account, region, INFRA_REPOSITORY, stageContractSchemaHash,
  validateDeploymentRecord, assertObservedMatchesDeployment } from './deployment-contract.mjs';
import { readStageInputs } from './stage-contract-parameters.mjs';
import { configuredStacks } from './operation-stacks.mjs';
import { assertProtectedExecutor } from './operation-boundaries.mjs';
import { runtimeStack, assertRuntimeReady, describeStack } from './one-writer.mjs';

// The v3 CLI and AnyWear-E2E import these validators. They stay one contract
// implementation: the observer validates the expected record through the same
// module every other producer/consumer uses.
export { validateDeploymentRecord, assertObservedMatchesDeployment } from './deployment-contract.mjs';

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
//
// `requireRuntime` is true only for the `runtime` family (`observe`), which
// qualifies the running slice and therefore needs the Service-owned Runtime stack
// present. A `beta-deploy` observation (Foundation/Billing/Base/Egress/restore)
// runs before M6 or while Beta is stopped, so it must not read or require Runtime;
// the record body never included that stack.
export async function observeDeployment({ infraSha, io = liveObservationIo(), env = process.env, requireRuntime = true }) {
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
  if (requireRuntime) {
    // Issue #166: Beta runs when the Service-owned Runtime stack exists. The Base
    // activity output is gone; the Runtime read is not added to the recorded stack
    // set because that slice is produced and observed by AnyWear-Service.
    const runtime = await describeStack(io, runtimeStack, region);
    assertRuntimeReady(runtime, 'Authenticated deployment observation');
  }
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

// The v3 observer CLI for AnyWear-E2E. It takes no release selection: the
// expected record is the Infra deployment record that must equal the
// authenticated observation, and the explicit Infra SHA is the record producer
// it must agree with. `--trusted-infra-root` binds the helper that executed to
// that revision when E2E checked the source out separately.
const OBSERVER_OPTIONS = Object.freeze({ '--expected': true, '--output': true, '--infra-sha': true,
  '--trusted-infra-root': false });
const OBSERVER_USAGE = `Usage: node scripts/observe-deployment.mjs --expected <platform-record.json> --output <file> --infra-sha <sha> [--trusted-infra-root <path>]

Reads the live Beta stage base and writes the authenticated v3
anywear_infra_deployment body. The expected record is validated with
deployment-contract.mjs and must equal the new observation exactly.
`;

export function observerArguments(argv) {
  const options = {};
  if (argv.includes('--help')) return { help: true };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!Object.hasOwn(OBSERVER_OPTIONS, name)) throw new Error(`Unknown observer argument ${name}`);
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value) throw new Error(`Observer argument ${name} requires a value`);
    if (Object.hasOwn(options, name.slice(2))) throw new Error(`Duplicate observer argument ${name}`);
    options[name.slice(2)] = value;
  }
  for (const [name, required] of Object.entries(OBSERVER_OPTIONS)) {
    if (required && !Object.hasOwn(options, name.slice(2))) throw new Error(`Observer argument ${name} is required`);
  }
  return options;
}

async function assertTrustedInfraRoot(root, infraSha) {
  const directory = path.resolve(root);
  const head = (await execute('git', ['-C', directory, 'rev-parse', 'HEAD'], { timeout: 60_000 })).stdout.trim();
  if (head !== infraSha) throw new Error('Trusted Infra root is not the reviewed Infra revision');
  const relative = path.relative(directory, fileURLToPath(import.meta.url));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Observer does not execute from the trusted Infra root');
  }
  return directory;
}

export async function observeDeploymentCli({ argv = process.argv.slice(2), io = liveObservationIo(), env = process.env } = {}) {
  const options = observerArguments(argv);
  if (options.help) {
    process.stdout.write(OBSERVER_USAGE);
    return { help: true };
  }
  const expected = validateDeploymentRecord(parseJson(await readFile(options.expected)));
  if (expected.record_type !== 'anywear_infra_deployment') {
    throw new Error('Expected record is not an Infra deployment record');
  }
  matches(options['infra-sha'], SHA, 'explicit Infra SHA');
  if (expected.producer.sha !== options['infra-sha']) {
    throw new Error('Expected deployment was produced by a different Infra revision');
  }
  if (options['trusted-infra-root']) await assertTrustedInfraRoot(options['trusted-infra-root'], options['infra-sha']);
  const body = await observeDeployment({ infraSha: options['infra-sha'], io, env });
  assertObservedMatchesDeployment(expected, body);
  await writeFile(options.output, `${JSON.stringify(body, null, 2)}\n`);
  return body;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await observeDeploymentCli({ argv: process.argv.slice(2) });
}
