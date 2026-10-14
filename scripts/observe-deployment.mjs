import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJson, contentHash, canonicalJson, exact, matches, SHA, sha256 } from './json-contract.mjs';
import { verifySelection, loadCommittedSelection } from './artifact-consumer.mjs';
import { runRuntimeVerification, assertVerificationExecutor } from './verify-runtime-task.mjs';
import { validateDeploymentRecord, validateSnapshot, assertObservedMatchesDeployment, stableLambdaConfiguration, account, region, INFRA_REPOSITORY } from './deployment-contract.mjs';
import { qualifiedWorkflowPaths } from './operation-boundaries.mjs';
import { observeBetaSizing } from './observe-beta-sizing.mjs';
import { validateStackManifest } from './operation-stacks.mjs';
export { validateDeploymentRecord, assertObservedMatchesDeployment } from './deployment-contract.mjs';
const execute = promisify(execFile);
const outputMap = stack => Object.fromEntries((stack.Outputs ?? []).map(item => [item.OutputKey, item.OutputValue]));

export function selectEcrImageManifest(imageResult, selectedDigest) {
  const images = imageResult?.images;
  if (imageResult?.failures?.length || !Array.isArray(images) || images.length === 0
    || images.some(image => image?.imageId?.imageDigest !== selectedDigest)) throw new Error('Exact selected OCI manifest unavailable');
  const manifests = images.map(image => image.imageManifest);
  if (manifests.some(manifest => typeof manifest !== 'string') || new Set(manifests).size !== 1) throw new Error('Exact selected OCI manifest unavailable');
  const imageManifest = manifests[0];
  if (`sha256:${sha256(imageManifest)}` !== selectedDigest) throw new Error('Actual OCI manifest bytes differ from sealed selected digest');
  return imageManifest;
}

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
export async function observeDeployment({ binding, stackSources, infraSha, io = liveObservationIo(), env = process.env, artifactIo }) {
  matches(infraSha, SHA, 'Observed Infra input');
  assertVerificationExecutor(infraSha, env);
  if (binding?.expectedInfraSha !== infraSha) throw new Error('Observation must bind the explicit reviewed Infra pin');
  validateStackManifest(stackSources, 'reviewed stack source bindings');
  const selected = await verifySelection(binding, await mkdtemp(path.join(os.tmpdir(), 'anywear-infra-observe-')), artifactIo);
  const selector = selected.selector;
  if (env.AWS_REGION !== region || env.AWS_ACCOUNT_ID !== account || (await io.aws(['sts', 'get-caller-identity'])).Account !== account) throw new Error('Unexpected authenticated observer account/region');
  const imageResult = await io.aws(['ecr', 'batch-get-image', '--repository-name', selector.image.repository_uri.split('/').slice(1).join('/'), '--image-ids', `imageDigest=${selector.image.digest}`]);
  const imageManifest = selectEcrImageManifest(imageResult, selector.image.digest);
  const imageManifestPath = path.join(selected.directory, 'selected-image-manifest.json');
  await writeFile(imageManifestPath, imageManifest);
  const stacks = []; const actualStacks = new Map();
  for (const source of stackSources) {
    exact(source, ['stack_name', 'region', 'source_repository', 'source_sha'], 'stack provenance input');
    const response = await io.aws(['cloudformation', 'describe-stacks', '--stack-name', source.stack_name], source.region);
    const actual = response.Stacks?.[0];
    if (response.Stacks?.length !== 1 || actual.StackName !== source.stack_name || !['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE'].includes(actual.StackStatus)) throw new Error('CloudFormation stack not terminal');
    const original = (await io.aws(['cloudformation', 'get-template', '--stack-name', actual.StackId, '--template-stage', 'Original'], source.region)).TemplateBody;
    if (!original) throw new Error('Original deployed template missing');
    const body = typeof original === 'string' ? parseJson(original) : original;
    stacks.push({ ...source, template_sha256: contentHash(body) }); actualStacks.set(source.stack_name, actual);
  }
  const platform = outputMap(actualStacks.get('AnyWearPlatformStack-beta')); const workload = outputMap(actualStacks.get('AnyWearWorkloadStack-beta'));
  if (platform.BetaActive !== 'true' || workload.BetaActive !== 'true') throw new Error('Only active Beta may issue runtime deployment evidence');
  const lambdas = {};
  for (const [key, functionName] of [['pre-sign-up', 'beta-anywear-pre-sign-up'], ['post-confirmation', 'beta-anywear-post-confirmation-sync']]) {
    const config = (await io.aws(['lambda', 'get-function', '--function-name', functionName])).Configuration;
    if (config?.FunctionArn !== `arn:aws:lambda:${region}:${account}:function:${functionName}` || config.LastUpdateStatus !== 'Successful') throw new Error('Actual Lambda identity/update state unproven');
    lambdas[key] = { code_sha256: config.CodeSha256, configuration_sha256: contentHash(stableLambdaConfiguration(config)) };
  }
  const queueConfig = {};
  for (const [key, output] of [['vto', 'VtoQueueUrl'], ['auto-tagging', 'AutoTaggingQueueUrl']]) {
    const attrs = (await io.aws(['sqs', 'get-queue-attributes', '--queue-url', platform[output], '--attribute-names', 'QueueArn', 'VisibilityTimeout', 'RedrivePolicy'])).Attributes;
    if (!attrs?.QueueArn?.startsWith(`arn:aws:sqs:${region}:${account}:beta-anywear-`)) throw new Error('Foreign queue observation');
    const redrive = parseJson(attrs.RedrivePolicy);
    queueConfig[key] = { queueVisibilitySeconds: Number(attrs.VisibilityTimeout), maxReceives: Number(redrive.maxReceiveCount) };
    const policy = selected.policy[key];
    if (canonicalJson(queueConfig[key]) !== canonicalJson({ queueVisibilitySeconds: policy.queueVisibilitySeconds, maxReceives: policy.maxReceives })) throw new Error('Observed queue settings differ from selected policy');
  }
  const services = await io.aws(['ecs', 'describe-services', '--cluster', platform.EcsClusterName, '--services', workload.ApiServiceName, workload.WorkerServiceName]);
  if (services.failures?.length || services.services?.length !== 2) throw new Error('ECS service observation incomplete');
  const ecs = {}; const definitions = {};
  for (const service of services.services) {
    const purpose = service.serviceName === workload.ApiServiceName ? 'api' : service.serviceName === workload.WorkerServiceName ? 'worker' : undefined;
    if (!purpose || ecs[purpose]) throw new Error('Foreign or duplicate ECS service');
    if (!service.desiredCount || service.runningCount !== service.desiredCount || service.pendingCount !== 0
      || service.deployments?.length !== 1 || service.deployments[0].rolloutState !== 'COMPLETED') throw new Error('ECS workload is not stable');
    const definition = (await io.aws(['ecs', 'describe-task-definition', '--task-definition', service.taskDefinition])).taskDefinition;
    const container = definition?.containerDefinitions?.find(c => c.name === (purpose === 'api' ? 'ApiContainer' : 'WorkerContainer'));
    const variables = Object.fromEntries((container?.environment ?? []).map(v => [v.name, v.value]));
    if (definition?.taskDefinitionArn !== service.taskDefinition
      || container?.image !== `${selector.image.repository_uri}@${selector.image.digest}` || variables.SERVICE_COMMIT_SHA !== selector.image.service_sha
      || variables.IMAGE_DIGEST !== selector.image.digest) throw new Error('Actual ECS task definition selection mismatch');
    const listed = await io.aws(['ecs', 'list-tasks', '--cluster', platform.EcsClusterName, '--service-name', service.serviceName, '--desired-status', 'RUNNING']);
    if (listed.taskArns?.length !== service.runningCount) throw new Error('Actual ECS task inventory incomplete');
    const tasks = await io.aws(['ecs', 'describe-tasks', '--cluster', platform.EcsClusterName, '--tasks', ...listed.taskArns]);
    if (tasks.failures?.length || tasks.tasks?.length !== listed.taskArns.length || tasks.tasks.some(task => task.lastStatus !== 'RUNNING'
      || task.taskDefinitionArn !== service.taskDefinition || task.containers.some(c => c.imageDigest !== selector.image.digest))) throw new Error('Running ECS digest differs from selected image');
    ecs[purpose] = { service_arn: service.serviceArn, task_definition_arn: service.taskDefinition, image_digest: selector.image.digest };
    definitions[purpose] = definition;
  }
  const sizing = observeBetaSizing(actualStacks.get('AnyWearWorkloadStack-beta'), definitions);
  const endpoints = { api: workload.ApiBaseUrl, client: `https://${platform.ClientDistributionDomainName}` };
  // Older outputs expose ClientBaseUrl; domain fallback is only that exact deployed interface.
  if (platform.ClientBaseUrl) endpoints.client = platform.ClientBaseUrl;
  if (!platform.ClientBaseUrl && !platform.ClientDistributionDomainName) {
    const distribution = await io.aws(['cloudfront', 'get-distribution', '--id', platform.ClientDistributionId]);
    endpoints.client = `https://${distribution.Distribution.DomainName}`;
  }
  const health = await io.http(`${endpoints.api}/health`); const client = await io.http(`${endpoints.client}/build-metadata.json?infra=${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`);
  if (health.status !== 'ok' || health.service_commit !== selector.image.service_sha || health.image_digest !== selector.image.digest || client.component !== 'AnyWear-Client') throw new Error('Public application identity mismatch');
  const runtime = await runRuntimeVerification({ io, outputs: platform, selector, manifest: selected.manifest, schema: selected.schema, infraSha, env });
  const snapshot = { stacks, observed: { service_sha: health.service_commit, image_digest: health.image_digest, ecs, lambdas,
    policy_content_sha256: runtime.policy_content_sha256, queue_config_sha256: contentHash(queueConfig), client_sha: client.source_commit, endpoints }, schema: runtime.schema };
  validateSnapshot(snapshot, { infraWorkflows: qualifiedWorkflowPaths });
  // End the observation with stack-version checks to detect a deployment crossing
  // the bounded task window; E2E independently repeats the full snapshot after suite.
  for (const [name, original] of actualStacks) {
    const after = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', original.StackId], stacks.find(s => s.stack_name === name).region)).Stacks?.[0];
    if (after?.StackId !== original.StackId || after.StackStatus !== original.StackStatus
      || (after.LastUpdatedTime ?? after.CreationTime) !== (original.LastUpdatedTime ?? original.CreationTime)) throw new Error('Stack changed during authenticated observation');
  }
  // Keep sizing evidence in the operation record; the v2 E2E snapshot stays exact.
  io.recordBetaSizingState?.(sizing);
  return snapshot;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = name => process.argv[process.argv.indexOf(name) + 1];
  if (!process.argv.includes('--output')) throw new Error('--output required');
  let expected; let selector; let stackSources; let infraSha;
  if (process.argv.includes('--expected')) {
    expected = validateDeploymentRecord(parseJson(await readFile(option('--expected'))));
    selector = { schema_version: 2, record_type: 'anywear_infra_selection', release: expected.selection.release, ...expected.selection.components };
    stackSources = expected.stacks.map(({ template_sha256, ...source }) => source); infraSha = expected.infra.sha;
  } else {
    stackSources = parseJson(await readFile(option('--stack-sources'))); infraSha = process.env.GITHUB_SHA;
  }
  if (!process.argv.includes('--trusted-infra-root') || !process.argv.includes('--infra-sha') || option('--infra-sha') !== infraSha) throw new Error('Explicit trusted Infra root and matching immutable SHA required');
  if (!process.argv.includes('--selection') || !process.argv.includes('--selection-sha256')) throw new Error('Explicit committed selection path/hash required');
  const binding = { trustedInfraRoot: path.resolve(option('--trusted-infra-root')), expectedInfraSha: option('--infra-sha'), selectionFile: option('--selection'), selectionSha256: option('--selection-sha256') };
  const committed = await loadCommittedSelection(binding);
  if (expected && (expected.selection.file !== binding.selectionFile || expected.selection.sha256 !== binding.selectionSha256 || canonicalJson(selector) !== canonicalJson(committed))) throw new Error('Expected deployment selects different committed bytes');
  selector = committed;
  const snapshot = await observeDeployment({ binding, stackSources, infraSha });
  if (expected) { assertObservedMatchesDeployment(expected, snapshot); await writeFile(option('--output'), `${JSON.stringify(snapshot, null, 2)}\n`); }
  else {
    const { image, lambdas, runtime_policy, schema, release } = selector;
    const record = { schema_version: 2, record_type: 'anywear_infra_deployment', infra: { repository: INFRA_REPOSITORY, sha: infraSha,
      workflow_path: '.github/workflows/runtime.yml', workflow_ref: process.env.GITHUB_WORKFLOW_REF, run_id: Number(process.env.GITHUB_RUN_ID), run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT) },
      selection: { file: binding.selectionFile, sha256: binding.selectionSha256, release, components: { image, lambdas, runtime_policy, schema } }, ...snapshot };
    validateDeploymentRecord(record); await writeFile(option('--output'), `${JSON.stringify(record, null, 2)}\n`);
  }
}
