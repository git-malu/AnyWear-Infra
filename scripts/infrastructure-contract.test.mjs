import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseJson, canonicalJson, contentHash, sha256 } from './json-contract.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { validateSelection, verifySelection } from './artifact-consumer.mjs';
import { assertNativeReleaseAttestation } from './vendor/service-release-attestation.mjs';
import { validateDeploymentRecord, validateSnapshot, assertObservedMatchesDeployment, stableLambdaConfiguration } from './deployment-contract.mjs';
import { qualifiedWorkflowPaths, workflowOperations, operationBoundary, families } from './operation-boundaries.mjs';
import { isDeploymentFamily, observationRecordType, deploymentRecordType, familyObservationRecordType } from './observation-record.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateOperationInputs, betaDeploymentActivity } from './runtime-operation.mjs';
import { verifyRetentionPolicy, verifyProtectedImages, verifyLifecyclePreview } from './ecr-retention.mjs';
import { observeDeployment } from './observe-deployment.mjs';

const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), 'anywear-infra-contract-'));
const { selector, manifest, schema } = await createTestInputs(fixtureDirectory);
// The observer independently hashes actual registry manifest bytes, so use a real manifest
// digest throughout the same signed release/selection fixture.
const imageManifest = canonicalJson({ schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
  config: { mediaType: 'application/vnd.docker.container.image.v1+json', size: 2, digest: `sha256:${sha256('{}')}` }, layers: [] });
selector.image.digest = `sha256:${sha256(imageManifest)}`;
const manifestBytes = Buffer.from(canonicalJson(manifest));
selector.release.manifest_sha256 = sha256(manifestBytes);
await writeFile(path.join(fixtureDirectory, 'service-artifacts.json'), manifestBytes);
await writeFile(path.join(fixtureDirectory, 'selection.json'), canonicalJson(selector));
const sha = '5'.repeat(40);
const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'anywear-infra-trusted-contract-'));
const execute = promisify(execFile);
const git = async args => (await execute('git', ['-C', sourceRoot, ...args])).stdout.trim();
await git(['init', '--quiet']); await git(['config', 'core.autocrlf', 'false']);
await git(['config', 'user.name', 'Contract fixture']); await git(['config', 'user.email', 'fixture@invalid.local']);
await git(['remote', 'add', 'origin', 'https://github.com/git-malu/AnyWear-Infra.git']);
await mkdir(path.join(sourceRoot, 'selections')); await writeFile(path.join(sourceRoot, 'selections/beta.json'), canonicalJson(selector));
await git(['add', '.']); await git(['commit', '--quiet', '-m', 'Reviewed selection']);
const binding = { trustedInfraRoot: sourceRoot, expectedInfraSha: await git(['rev-parse', 'HEAD']), selectionFile: 'selections/beta.json', selectionSha256: contentHash(selector) };
const env = { AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', GITHUB_SHA: sha, GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265', ENABLE_BETA_DEPLOY: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main',
  INFRA_OPERATION: 'observe', INFRA_IDENTITY_PHASE: 'legacy', INFRA_RETENTION_PROTECTION: 'false',
  SELECTION_FILE: binding.selectionFile, SELECTION_SHA256: binding.selectionSha256 };
const fixtureRecord = () => {
  const migrations = [{ id: '2'.repeat(64), created_at: 1000 }];
  return { schema_version: 2, record_type: 'anywear_infra_deployment', infra: { repository: 'git-malu/AnyWear-Infra', sha,
    workflow_path: '.github/workflows/runtime.yml', workflow_ref: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main', run_id: 23, run_attempt: 1 },
    selection: { file: binding.selectionFile, sha256: contentHash(selector), release: selector.release, components: manifest.components },
    stacks: ['AnyWearFoundationStack', 'AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta', 'AnyWearBillingStack-beta'].map(stack_name => ({ stack_name,
      region: stack_name.includes('Billing') ? 'us-east-1' : 'ap-east-1', source_repository: 'git-malu/AnyWear-Service', source_sha: '1'.repeat(40), template_sha256: 'a'.repeat(64) })),
    observed: { service_sha: selector.image.service_sha, image_digest: selector.image.digest,
      ecs: Object.fromEntries(['api', 'worker'].map(purpose => [purpose, {
        service_arn: `arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-${purpose}`,
        task_definition_arn: `arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-${purpose}:1`, image_digest: selector.image.digest }])),
      lambdas: { 'pre-sign-up': { code_sha256: selector.lambdas.pre_sign_up.code_sha256, configuration_sha256: 'b'.repeat(64) },
        'post-confirmation': { code_sha256: selector.lambdas.post_confirmation.code_sha256, configuration_sha256: 'b'.repeat(64) } },
      policy_content_sha256: selector.runtime_policy.content_sha256, queue_config_sha256: 'c'.repeat(64), client_sha: '6'.repeat(40),
      endpoints: { api: 'https://d1pfqujqt29n11.cloudfront.net', client: 'https://d2rztl7o0y7rf8.cloudfront.net' } },
    schema: { selected_journal_sha256: selector.schema.journal_sha256, observed_applied_journal_sha256: contentHash(migrations),
      selected_migration_ids: migrations, applied_migration_ids: migrations, selected_current_version: 16, minimum_schema_version: 16, minimum_migration_count: 1, applied_schema_version: 16,
      compatibility_result: 'compatible', verification: { command_sha256: 'd'.repeat(64), source_repository: 'git-malu/AnyWear-Infra', source_sha: sha,
        image_digest: selector.image.digest, service_sha: selector.image.service_sha,
        executor: { repository: 'git-malu/AnyWear-Infra', sha, workflow_path: '.github/workflows/runtime.yml', run_id: 23, run_attempt: 1 },
        task_arn: `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'a'.repeat(32)}`,
        task_definition_arn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-artifact-verify:1' } } };
};
// Selected component asset IDs live in the selector, outside immutable manifest.
const recordWithIds = () => { const record = fixtureRecord(); record.selection.components = { image: selector.image, lambdas: selector.lambdas,
  runtime_policy: selector.runtime_policy, schema: selector.schema }; return record; };

test('RFC8785 ordering, duplicate escaped keys, invalid UTF8/surrogates fail closed', () => {
  assert.equal(canonicalJson({ z: 1e30, a: -0 }), '{"a":0,"z":1e+30}');
  for (const text of ['{"a":1,"\\u0061":2}', '{"a":{"z":1,"z":2}}', '1e999', '"\\ud800"', '{}true']) assert.throws(() => parseJson(text));
  assert.throws(() => parseJson(Buffer.from([0xff])));
});
test('selection rejects unknown nested fields, traversal and duplicate assets', () => {
  validateSelection(selector);
  for (const mutate of [s => s.lambdas.pre_sign_up.file = '../code.zip', s => s.schema.asset_id = s.runtime_policy.asset_id,
    s => s.image.unknown = true, s => s.release.manifest_sha256 = 'x', s => s.schema.sha256 = undefined]) {
    const value = structuredClone(selector); mutate(value); assert.throws(() => validateSelection(value));
  }
});
function nativeFixture(predicateType = 'https://in-toto.io/attestation/release/v0.1') {
  const tag = `service-artifacts-${selector.image.service_sha}`; const purl = `pkg:github/git-malu/AnyWear-Service@${tag}`;
  const hashes = { 'service-artifacts.json': selector.release.manifest_sha256, ...Object.fromEntries([...Object.values(selector.lambdas), selector.runtime_policy, selector.schema].map(item => [item.file, item.sha256])) };
  const identity = { ownerId: '11473072', repositoryId: '1158460323', repository: 'git-malu/AnyWear-Service', purl, tag };
  const predicate = predicateType.endsWith('/v0.2') ? { ...identity, databaseId: '1', packageId: '1158460323' } : { ...identity, releaseId: '1' };
  const statement = { _type: 'https://in-toto.io/Statement/v1', predicateType, predicate,
    subject: [{ uri: purl, digest: { sha1: selector.image.service_sha } }, ...Object.entries(hashes).map(([name, hash]) => ({ name, digest: { sha256: hash } }))] };
  return { verificationResult: { statement, signature: { certificate: { subjectAlternativeName: 'https://dotcom.releases.github.com' } } },
    attestation: { bundle: { dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64'), signatures: [{ sig: 'test-only' }] } } } };
}

function selectedArtifactIo(native, conclusion = 'success') {
  const ids = new Map([[1, 'service-artifacts.json'], [2, 'pre-sign-up.zip'], [3, 'post-confirmation.zip'], [4, 'runtime-policy.json'], [5, 'service-schema.json']]);
  const nativeChecks = [];
  return { nativeChecks, async api(endpoint) {
    if (endpoint.includes('/releases/')) return { id: 1, immutable: true, draft: false, tag_name: `service-artifacts-${selector.image.service_sha}`,
      target_commitish: selector.image.service_sha,
      assets: await Promise.all([...ids].map(async ([id, name]) => { const bytes = await readFile(path.join(fixtureDirectory, name)); return { id, name, state: 'uploaded', size: bytes.length, digest: `sha256:${sha256(bytes)}` }; })) };
    if (endpoint.includes('/git/ref/')) return { object: { type: 'commit', sha: selector.image.service_sha } };
    return { id: 1, run_attempt: 1, head_sha: manifest.producer.workflow_sha, head_branch: 'main', path: '.github/workflows/service-artifacts.yml',
      repository: { full_name: 'git-malu/AnyWear-Service', id: 1158460323, owner: { id: 11473072, login: 'git-malu' } }, head_repository: { full_name: 'git-malu/AnyWear-Service', id: 1158460323, owner: { id: 11473072, login: 'git-malu' } },
      event: 'workflow_dispatch', status: 'completed', conclusion };
  }, async asset(repo, id) { return readFile(path.join(fixtureDirectory, ids.get(id))); },
  async attestation(tag, file) { nativeChecks.push(file ? path.basename(file) : 'release'); return native; } };
}

const workloadOriginal = parseJson(await readFile(new URL('../test/baselines/beta-active/AnyWearWorkloadStack-beta.template.json', import.meta.url)));
const actualContainerNames = Object.values(workloadOriginal.Resources)
  .filter(resource => resource.Type === 'AWS::ECS::TaskDefinition').flatMap(resource => resource.Properties.ContainerDefinitions.map(container => container.Name));
function observationIo(drift, ecrResult) {
  const calls = []; let verificationDefinition;
  const stackSources = fixtureRecord().stacks.map(({ template_sha256, ...source }) => source);
  const platformOutputs = { BetaActive: 'true', EcsClusterName: 'beta-anywear', PrivateSubnetIds: 'subnet-a,subnet-b',
    OneShotSecurityGroupId: 'sg-a', VerificationTaskRoleArn: 'arn:aws:iam::650880818323:role/beta-verification-task-role',
    OneShotExecutionRoleArn: 'arn:aws:iam::650880818323:role/beta-one-shot-execution-role', OneShotLogGroupName: '/anywear/beta/one-shot',
    DatabaseSecretArn: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:beta-database', DatabaseHost: 'beta-db.internal',
    DatabasePort: '5432', DatabaseName: 'anywear', WardrobeBucketName: 'beta-anywear-wardrobe',
    VtoQueueUrl: 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-vto',
    AutoTaggingQueueUrl: 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-auto-tagging',
    ClientBaseUrl: 'https://d2rztl7o0y7rf8.cloudfront.net' };
  const workloadOutputs = { BetaActive: 'true', ApiServiceName: 'beta-anywear-api', WorkerServiceName: 'beta-anywear-worker',
    ApiBaseUrl: 'https://d1pfqujqt29n11.cloudfront.net' };
  const stacks = stackSources.map(source => ({ StackName: source.stack_name, StackStatus: 'UPDATE_COMPLETE',
    StackId: `arn:aws:cloudformation:${source.region}:650880818323:stack/${source.stack_name}/fixture`, LastUpdatedTime: '2026-10-08T00:00:00Z',
    Outputs: Object.entries(source.stack_name.includes('Platform') ? platformOutputs : source.stack_name.includes('Workload') ? workloadOutputs : {})
      .map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }));
  const taskDefinitionArn = purpose => `arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-${purpose}:1`;
  const taskArn = purpose => `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${(purpose === 'api' ? 'b' : 'c').repeat(32)}`;
  const verificationArn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-artifact-verify:1';
  const verificationTask = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'a'.repeat(32)}`;
  const migrations = schema.migrations.map(m => ({ id: m.sha256, created_at: m.created_at }));
  const evidence = { record_type: 'anywear_read_only_runtime', schema_version: 1, service_sha: selector.image.service_sha,
    image_digest: selector.image.digest, policy_file_sha256: selector.runtime_policy.sha256, policy_content_sha256: selector.runtime_policy.content_sha256,
    selected_journal_sha256: selector.schema.journal_sha256, selected_migration_ids: migrations, applied_schema_version: schema.current_version,
    applied_migration_ids: migrations, observed_applied_journal_sha256: contentHash(migrations) };
  const sizingEvents = [];
  return { stackSources, calls, sizingEvents, recordBetaSizingState(event) { sizingEvents.push(event); }, async aws(args, awsRegion = 'ap-east-1') {
    calls.push(args); const argument = flag => args[args.indexOf(flag) + 1];
    switch (`${args[0]}/${args[1]}`) {
      case 'sts/get-caller-identity': return { Account: '650880818323' };
      case 'ecr/batch-get-image': return ecrResult ?? { images: [{ imageId: { imageDigest: selector.image.digest }, imageManifest }] };
      case 'cloudformation/describe-stacks': {
        const stack = stacks.find(s => s.StackName === argument('--stack-name') || s.StackId === argument('--stack-name'));
        assert.equal(awsRegion, stack.StackName.includes('Billing') ? 'us-east-1' : 'ap-east-1');
        return { Stacks: [stack] };
      }
      case 'cloudformation/get-template': return { TemplateBody: argument('--stack-name').includes('Workload') ? workloadOriginal : { Resources: {} } };
      case 'lambda/get-function': {
        const name = argument('--function-name'); const selected = name.endsWith('pre-sign-up') ? selector.lambdas.pre_sign_up : selector.lambdas.post_confirmation;
        return { Configuration: { FunctionArn: `arn:aws:lambda:ap-east-1:650880818323:function:${name}`, FunctionName: name,
          LastUpdateStatus: 'Successful', CodeSha256: selected.code_sha256, Runtime: selected.runtime, Handler: selected.handler,
          Role: 'arn:aws:iam::650880818323:role/beta-lambda-role', MemorySize: 128, Timeout: 30, Architectures: ['x86_64'] } };
      }
      case 'sqs/get-queue-attributes': {
        const name = argument('--queue-url').split('/').at(-1); const policy = parseJson(await readFile(path.join(fixtureDirectory, 'runtime-policy.json')))[name.endsWith('vto') ? 'vto' : 'auto-tagging'];
        return { Attributes: { QueueArn: `arn:aws:sqs:ap-east-1:650880818323:${name}`, VisibilityTimeout: String(policy.queueVisibilitySeconds),
          RedrivePolicy: JSON.stringify({ maxReceiveCount: policy.maxReceives }) } };
      }
      case 'ecs/describe-services': return { services: ['api', 'worker'].map(purpose => ({ serviceName: `beta-anywear-${purpose}`,
        serviceArn: `arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-${purpose}`, taskDefinition: taskDefinitionArn(purpose),
        desiredCount: 1, runningCount: 1, pendingCount: 0, deployments: [{ rolloutState: 'COMPLETED' }] })) };
      case 'ecs/describe-task-definition': {
        if (argument('--task-definition') === verificationArn) return { taskDefinition: verificationDefinition };
        const purpose = argument('--task-definition') === taskDefinitionArn('api') ? 'api' : 'worker';
        const name = actualContainerNames.find(value => value === (purpose === 'api' ? 'ApiContainer' : 'WorkerContainer'));
        const container = { name, image: `${selector.image.repository_uri}@${selector.image.digest}`, environment: [
          { name: 'SERVICE_COMMIT_SHA', value: selector.image.service_sha }, { name: 'IMAGE_DIGEST', value: selector.image.digest }] };
        const definition = { taskDefinitionArn: taskDefinitionArn(purpose), cpu: purpose === 'api' ? '512' : '1024',
          memory: purpose === 'api' ? '1024' : '2048', containerDefinitions: [container] };
        if (drift?.purpose === purpose) {
          if (drift.mode === 'wrong-purpose') container.name = purpose === 'api' ? 'WorkerContainer' : 'ApiContainer';
          if (drift.mode === 'legacy-name') container.name = purpose === 'api' ? 'Api' : 'Worker';
          if (drift.mode === 'missing') definition.containerDefinitions = [];
          if (drift.mode === 'source') container.environment[0].value = '9'.repeat(40);
          if (drift.mode === 'digest') container.image = `${selector.image.repository_uri}@sha256:${'9'.repeat(64)}`;
          if (drift.mode === 'environment-digest') container.environment[1].value = `sha256:${'9'.repeat(64)}`;
        }
        return { taskDefinition: definition };
      }
      case 'ecs/list-tasks': return { taskArns: [taskArn(argument('--service-name') === 'beta-anywear-api' ? 'api' : 'worker')] };
      case 'ecs/describe-tasks': {
        if (argument('--tasks') === verificationTask) return { tasks: [{ taskArn: verificationTask, taskDefinitionArn: verificationArn, lastStatus: 'STOPPED',
          containers: [{ name: 'OneShot', exitCode: 0, imageDigest: selector.image.digest }] }] };
        const purpose = argument('--tasks') === taskArn('api') ? 'api' : 'worker';
        return { tasks: [{ lastStatus: 'RUNNING', taskDefinitionArn: taskDefinitionArn(purpose), containers: [{ imageDigest: selector.image.digest }] }] };
      }
      case 'ecs/register-task-definition': verificationDefinition = parseJson(argument('--cli-input-json')); return { taskDefinition: { taskDefinitionArn: verificationArn } };
      case 'ecs/run-task': return { tasks: [{ taskArn: verificationTask }] };
      case 'ecs/wait': case 'ecs/deregister-task-definition': return {};
      case 'logs/get-log-events': return { events: [{ message: `ANYWEAR_RUNTIME_EVIDENCE:${JSON.stringify(evidence)}` }] };
      default: assert.fail(`Unexpected observation request ${args[0]}/${args[1]}`);
    }
  }, async http(url) {
    if (url === `${workloadOutputs.ApiBaseUrl}/health`) return { status: 'ok', service_commit: selector.image.service_sha, image_digest: selector.image.digest };
    assert.match(url, /^https:\/\/d2rztl7o0y7rf8\.cloudfront\.net\/build-metadata\.json\?infra=/);
    return { component: 'AnyWear-Client', source_commit: '6'.repeat(40) };
  } };
}
const observationEnv = (repository = 'git-malu/AnyWear-Infra', workflow = '.github/workflows/runtime.yml') => ({ ...env,
  GITHUB_SHA: repository === 'git-malu/AnyWear-Infra' ? binding.expectedInfraSha : '8'.repeat(40), GITHUB_REPOSITORY: repository,
  GITHUB_WORKFLOW_REF: `${repository}/${workflow}@refs/heads/main`, GITHUB_RUN_ID: '23', GITHUB_RUN_ATTEMPT: '1' });
for (const [repository, workflow] of [['git-malu/AnyWear-Infra', '.github/workflows/runtime.yml'],
  ['git-malu/AnyWear-E2E', '.github/workflows/beta-qualification.yml'], ['git-malu/AnyWear-E2E', '.github/workflows/integration.yml']]) {
  test(`${repository}/${workflow} observes actual workload names through signed inputs and the bounded verifier`, async () => {
    assert.deepEqual(actualContainerNames, ['ApiContainer', 'WorkerContainer']);
    const io = observationIo(); const executor = observationEnv(repository, workflow);
    const snapshot = await observeDeployment({ binding, stackSources: io.stackSources, infraSha: binding.expectedInfraSha, io, env: executor,
      artifactIo: selectedArtifactIo(nativeFixture('https://in-toto.io/attestation/release/v0.2')) });
    assert.equal(snapshot.observed.image_digest, selector.image.digest);
    assert.equal(snapshot.schema.verification.source_sha, binding.expectedInfraSha);
    assert.equal(snapshot.schema.verification.executor.repository, repository);
    assert.equal(snapshot.schema.verification.executor.workflow_path, workflow);
    assert.equal(snapshot.schema.verification.executor.sha, executor.GITHUB_SHA);
    assert.equal(snapshot.schema.compatibility_result, 'compatible');
    assert.equal(io.sizingEvents.length, 1);
    assert.equal(io.sizingEvents[0].beta_api_sizing_profile, 's1');
    assert.equal(io.sizingEvents[0].beta_sizing_telemetry, 'false');
    assert.equal(io.sizingEvents[0].ecs.worker.cpu, '1024');
    assert.equal(Object.hasOwn(snapshot.observed, 'beta_sizing'), false);
    assert.equal(io.calls.filter(args => args[0] === 'cloudformation' && args[1] === 'describe-stacks').length, 8);
    assert.ok(io.calls.some(args => args[1] === 'deregister-task-definition'));
  });
}
test('observer accepts duplicate ECR tags when every entry selects one exact Docker v2 manifest', async () => {
  const ecrResult = { images: [
    { imageId: { imageDigest: selector.image.digest, imageTag: 'release-a' }, imageManifest },
    { imageId: { imageDigest: selector.image.digest, imageTag: 'release-b' }, imageManifest },
  ] };
  const io = observationIo(undefined, ecrResult);
  const snapshot = await observeDeployment({ binding, stackSources: io.stackSources, infraSha: binding.expectedInfraSha, io, env: observationEnv(),
    artifactIo: selectedArtifactIo(nativeFixture('https://in-toto.io/attestation/release/v0.2')) });
  assert.equal(snapshot.observed.image_digest, selector.image.digest);
  assert.equal(io.calls.filter(args => args[0] === 'ecr' && args[1] === 'batch-get-image').length, 1);
});
test('observer rejects an ECR entry whose digest differs from the selected immutable image', async () => {
  const ecrResult = { images: [
    { imageId: { imageDigest: selector.image.digest, imageTag: 'release-a' }, imageManifest },
    { imageId: { imageDigest: `sha256:${'9'.repeat(64)}`, imageTag: 'foreign' }, imageManifest },
  ] };
  const io = observationIo(undefined, ecrResult);
  await assert.rejects(observeDeployment({ binding, stackSources: io.stackSources, infraSha: binding.expectedInfraSha, io, env: observationEnv(),
    artifactIo: selectedArtifactIo(nativeFixture('https://in-toto.io/attestation/release/v0.2')) }), /Exact selected OCI manifest unavailable/);
});
test('observer rejects ECR manifest bytes whose hash differs from the selected digest', async () => {
  const io = observationIo(undefined, { images: [{ imageId: { imageDigest: selector.image.digest, imageTag: 'release-a' }, imageManifest: `${imageManifest} ` }] });
  await assert.rejects(observeDeployment({ binding, stackSources: io.stackSources, infraSha: binding.expectedInfraSha, io, env: observationEnv(),
    artifactIo: selectedArtifactIo(nativeFixture('https://in-toto.io/attestation/release/v0.2')) }), /Actual OCI manifest bytes differ from sealed selected digest/);
});
test('observer rejects wrong-purpose, legacy, missing and mismatched workload identities before launching verification', async () => {
  for (const purpose of ['api', 'worker']) for (const mode of ['wrong-purpose', 'legacy-name', 'missing', 'source', 'digest', 'environment-digest']) {
    const io = observationIo({ purpose, mode });
    await assert.rejects(observeDeployment({ binding, stackSources: io.stackSources, infraSha: binding.expectedInfraSha, io, env: observationEnv(),
      artifactIo: selectedArtifactIo(nativeFixture()) }), /Actual ECS task definition selection mismatch/, `${purpose}/${mode}`);
    assert.equal(io.calls.some(args => args[1] === 'register-task-definition'), false, 'Reject before private verification tasks');
  }
});

for (const predicateType of ['https://in-toto.io/attestation/release/v0.1', 'https://in-toto.io/attestation/release/v0.2']) {
  test(`authenticated ${predicateType} release preserves one complete signed statement across six checks`, async () => {
    const native = nativeFixture(predicateType);
    const original = canonicalJson(native);
    const io = selectedArtifactIo(native);
    const result = await verifySelection(binding, await mkdtemp(path.join(os.tmpdir(), 'anywear-infra-download-')), io);
    assert.equal(result.schema.minimum_version, 16);
    assert.deepEqual(io.nativeChecks, ['release', 'service-artifacts.json', 'post-confirmation.zip', 'pre-sign-up.zip', 'runtime-policy.json', 'service-schema.json']);
    assert.equal(canonicalJson(native), original, 'Consumer must preserve the original native statement/envelope');
    const bytes = await readFile(path.join(fixtureDirectory, 'pre-sign-up.zip'));
    await assert.rejects(verifySelection(binding, await mkdtemp(path.join(os.tmpdir(), 'anywear-infra-download-')),
      { ...io, async asset(repo, id) { return id === 2 ? Buffer.concat([bytes, Buffer.from('tamper')]) : io.asset(repo, id); } }), /Downloaded asset size\/hash differs/);
  });

  test(`${predicateType} consumer rejects a different policy-valid signed statement for each of the five assets`, async () => {
    const native = nativeFixture(predicateType);
    const altered = structuredClone(native);
    altered.verificationResult.statement.subject.reverse();
    altered.attestation.bundle.dsseEnvelope.payload = Buffer.from(canonicalJson(altered.verificationResult.statement)).toString('base64');
    const expected = { releaseId: selector.release.id, tag: `service-artifacts-${selector.image.service_sha}`, target: selector.image.service_sha,
      assetHashes: { 'service-artifacts.json': selector.release.manifest_sha256,
        ...Object.fromEntries([...Object.values(selector.lambdas), selector.runtime_policy, selector.schema].map(item => [item.file, item.sha256])) } };
    assertNativeReleaseAttestation(native, expected); assertNativeReleaseAttestation(altered, expected);
    for (const mismatch of ['service-artifacts.json', 'pre-sign-up.zip', 'post-confirmation.zip', 'runtime-policy.json', 'service-schema.json']) {
      const io = selectedArtifactIo(native);
      await assert.rejects(verifySelection(binding, await mkdtemp(path.join(os.tmpdir(), 'anywear-infra-mixed-native-')),
        { ...io, async attestation(tag, file) { return file && path.basename(file) === mismatch ? altered : native; } }),
        /different native statement/, mismatch);
    }
  });

  test(`${predicateType} policy-valid native evidence cannot qualify a failed producer`, async () => {
    const native = nativeFixture(predicateType);
    const expected = { releaseId: selector.release.id, tag: `service-artifacts-${selector.image.service_sha}`, target: selector.image.service_sha,
      assetHashes: { 'service-artifacts.json': selector.release.manifest_sha256,
        ...Object.fromEntries([...Object.values(selector.lambdas), selector.runtime_policy, selector.schema].map(item => [item.file, item.sha256])) } };
    assertNativeReleaseAttestation(native, expected);
    const io = selectedArtifactIo(native, 'failure');
    await assert.rejects(verifySelection(binding, await mkdtemp(path.join(os.tmpdir(), 'anywear-infra-failed-publisher-')), io), /complete successfully/);
    assert.deepEqual(io.nativeChecks, [], 'Reject failed producer before any native verification');
  });
}

test('operation main workflow/account/region/selection/identity/retention bind before credentials', () => {
  validateOperationInputs(env);
  for (const patch of [{ GITHUB_SHA: 'short' }, { GITHUB_REF: 'refs/heads/branch' }, { INFRA_OPERATION: 'unknown' },
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_WORKFLOW_REF: 'other' }, { ENABLE_BETA_DEPLOY: 'false' }, { AWS_REGION: 'us-east-1' },
    { INFRA_IDENTITY_PHASE: undefined }, { INFRA_RETENTION_PROTECTION: undefined }, { SELECTION_FILE: '../beta.json' }, { SELECTION_SHA256: 'short' }]) assert.throws(() => validateOperationInputs({ ...env, ...patch }));
});

test('admission operations and coherent restore require retired protected context and no tester mutation payload', () => {
  for (const operation of ['suspend-admission', 'resume-admission', 'restore-release']) {
    const workflow = operation === 'restore-release' ? 'beta-deploy' : 'beta-admission';
    const input = { ...env, GITHUB_WORKFLOW_REF: `git-malu/AnyWear-Infra/.github/workflows/${workflow}.yml@refs/heads/main`,
      INFRA_OPERATION: operation, INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true', TESTER_EMAILS: '[]',
      WINDOW_MINUTES: '60' };
    validateOperationInputs(input);
    for (const change of [{ INFRA_IDENTITY_PHASE: 'roles-added' }, { INFRA_RETENTION_PROTECTION: 'false' },
      { TESTER_EMAILS: '["someone@example.com"]' }, { TESTER_EMAILS: undefined }]) assert.throws(() => validateOperationInputs({ ...input, ...change }));
    if (operation === 'resume-admission') {
      // The bound is a required dispatch input, so a window always carries one.
      for (const minutes of ['14', '241', '60.5', 'sixty', '', undefined]) {
        assert.throws(() => validateOperationInputs({ ...input, WINDOW_MINUTES: minutes }), /Admission window minutes/);
      }
    } else validateOperationInputs({ ...input, WINDOW_MINUTES: '1' });
  }
});
test('maintenance deployment preserves both stopped stacks and rejects either mixed or unknown state', () => {
  const stack = value => ({ Outputs: [{ OutputKey: 'BetaActive', OutputValue: value }] });
  assert.equal(betaDeploymentActivity(stack('false'), stack('false')), false);
  assert.equal(betaDeploymentActivity(stack('true'), stack('true')), true);
  for (const [platform, workload] of [['true', 'false'], ['false', 'true']]) assert.throws(() => betaDeploymentActivity(stack(platform), stack(workload)), new RegExp(`Platform=${platform}, Workload=${workload}`));
  assert.throws(() => betaDeploymentActivity(stack(undefined), stack('false')), /Both/);
});
test('deployment strict binding rejects legacy, undeclared artifact and template/code/schema drift', () => {
  const record = recordWithIds(); validateDeploymentRecord(record);
  const snapshot = { stacks: record.stacks, observed: record.observed, schema: record.schema }; assertObservedMatchesDeployment(record, snapshot);
  for (const mutate of [r => r.schema_version = 1, r => r.selection.components.image.extra = 1,
    r => r.observed.lambdas['pre-sign-up'].code_sha256 = Buffer.alloc(32).toString('base64'),
    r => r.schema.applied_migration_ids[0].id = '0'.repeat(64), r => r.schema.applied_schema_version = 15,
    r => r.infra.workflow_path = '.github/workflows/other.yml']) {
    const value = structuredClone(record); mutate(value); assert.throws(() => validateDeploymentRecord(value));
  }
  const value = structuredClone(snapshot); value.stacks[0].template_sha256 = '0'.repeat(64);
  assert.throws(() => assertObservedMatchesDeployment(record, value), /differs/);
});
test('valid family observations retain actual provenance and cannot satisfy the legacy E2E deployment contract', () => {
  const legacy = recordWithIds();
  validateDeploymentRecord(legacy);
  assertObservedMatchesDeployment(legacy, { stacks: legacy.stacks, observed: legacy.observed, schema: legacy.schema });
  for (const file of qualifiedWorkflowPaths.filter(file => !file.endsWith('/runtime.yml'))) {
    const record = recordWithIds();
    record.record_type = 'anywear_infra_family_observation';
    record.infra.workflow_path = file;
    record.infra.workflow_ref = `git-malu/AnyWear-Infra/${file}@refs/heads/main`;
    record.schema.verification.executor.workflow_path = file;
    const snapshot = { stacks: record.stacks, observed: record.observed, schema: record.schema };
    validateSnapshot(snapshot, { infraWorkflows: [file] });
    assert.throws(() => validateDeploymentRecord(record), /Unknown deployment schema/);
    record.record_type = 'anywear_infra_deployment';
    assert.throws(() => validateDeploymentRecord(record), /Unexpected deployment workflow/);
    record.infra = structuredClone(legacy.infra);
    assert.throws(() => validateDeploymentRecord(record), /Untrusted verification executor/);
    assert.throws(() => assertObservedMatchesDeployment(legacy, snapshot), /Untrusted verification executor/);
  }
});

test('only the runtime family derives the accepted deployment record and no family artifact can pass as another', () => {
  const boundaryFor = file => operationBoundary({ ...env,
    GITHUB_WORKFLOW_REF: `git-malu/AnyWear-Infra/${file}@refs/heads/main`, INFRA_OPERATION: workflowOperations[file][0] });
  // The mapping is total over catalog families and derived from production code,
  // not repeated in the test; only qualified families can emit such a record.
  for (const file of Object.keys(workflowOperations)) {
    const boundary = boundaryFor(file);
    assert.equal(boundary.workflow, file);
    assert.equal(isDeploymentFamily(boundary.family), file.endsWith('/runtime.yml'));
    assert.equal(observationRecordType(boundary.family), file.endsWith('/runtime.yml') ? deploymentRecordType : familyObservationRecordType);
  }
  // The read-only state family is not a qualified producer: it is outside the
  // qualified set, builds no qualification session, and emits no observation
  // record at all, so it must not be read as producing a family observation.
  const state = { ...env, GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/beta-observe.yml@refs/heads/main', INFRA_OPERATION: 'state' };
  assert.deepEqual(workflowOperations['.github/workflows/beta-observe.yml'], ['state']);
  assert.equal(qualifiedWorkflowPaths.includes('.github/workflows/beta-observe.yml'), false);
  assert.deepEqual(families(state, 'operation'), []);
  assert.throws(() => families(state, 'qualification'), /Read-only observation cannot qualify with tasks/);
  const legacy = recordWithIds();
  validateDeploymentRecord(legacy);
  const legacySnapshot = { stacks: legacy.stacks, observed: legacy.observed, schema: legacy.schema };
  validateSnapshot(legacySnapshot, { infraWorkflows: ['.github/workflows/runtime.yml'] });
  for (const file of qualifiedWorkflowPaths.filter(file => !file.endsWith('/runtime.yml'))) {
    const record = recordWithIds();
    record.record_type = observationRecordType(boundaryFor(file).family);
    record.infra.workflow_path = file;
    record.infra.workflow_ref = `git-malu/AnyWear-Infra/${file}@refs/heads/main`;
    record.schema.verification.executor.workflow_path = file;
    const snapshot = { stacks: record.stacks, observed: record.observed, schema: record.schema };
    validateSnapshot(snapshot, { infraWorkflows: [file] });
    // A family observation cannot satisfy the accepted deployment contract ...
    assert.throws(() => validateDeploymentRecord(record), /Unknown deployment schema/, file);
    // ... not even with its record type forced to the accepted one ...
    record.record_type = deploymentRecordType;
    assert.throws(() => validateDeploymentRecord(record), /Unexpected deployment workflow/, file);
    // ... and the accepted runtime record cannot pass as this family's observation.
    assert.throws(() => validateSnapshot(legacySnapshot, { infraWorkflows: [file] }), /Untrusted verification executor/, file);
  }
});

test('schema16 image accepts compatible DB17 with independently hashed applied journal', () => {
  const record = recordWithIds(); record.schema.applied_schema_version = 17;
  record.schema.applied_migration_ids = [...record.schema.selected_migration_ids, { id: '9'.repeat(64), created_at: 2000 }];
  record.schema.observed_applied_journal_sha256 = contentHash(record.schema.applied_migration_ids);
  validateDeploymentRecord(record);
  assert.notEqual(record.schema.selected_journal_sha256, record.schema.observed_applied_journal_sha256);
});
test('volatile task/executor identities differ while pinned command/artifacts/schema remain equal', () => {
  const record = recordWithIds(); const snapshot = structuredClone({ stacks: record.stacks, observed: record.observed, schema: record.schema });
  snapshot.schema.verification.executor = { repository: 'git-malu/AnyWear-E2E', sha: '8'.repeat(40), workflow_path: '.github/workflows/beta-qualification.yml', run_id: 24, run_attempt: 2 };
  snapshot.schema.verification.task_arn = snapshot.schema.verification.task_arn.replace('a'.repeat(32), 'b'.repeat(32));
  assertObservedMatchesDeployment(record, snapshot);
  snapshot.schema.verification.command_sha256 = '0'.repeat(64); assert.throws(() => assertObservedMatchesDeployment(record, snapshot), /differs/);
});
test('Lambda stable hash excludes revision time, preserves ordered layers, normalizes set subnet IDs', () => {
  const config = { FunctionName: 'beta-example', Runtime: 'nodejs24.x', Handler: 'index.handler', Role: 'arn:role', MemorySize: 128, Timeout: 3,
    Architectures: ['x86_64'], Layers: [{ Arn: 'layer1', CodeSize: 1 }, { Arn: 'layer2' }], Environment: { Variables: { STAGE: 'beta' } },
    VpcConfig: { SubnetIds: ['b', 'a'], SecurityGroupIds: ['g2', 'g1'], VpcId: 'transient' }, RevisionId: 'volatile', LastModified: 'volatile' };
  const stable = stableLambdaConfiguration(config);
  assert.deepEqual(stable.VpcConfig.SubnetIds, ['a', 'b']); assert.equal(stable.RevisionId, undefined);
  assert.equal(contentHash(stable), contentHash(stableLambdaConfiguration({ ...config, RevisionId: 'new' })));
  assert.notEqual(contentHash(stable), contentHash(stableLambdaConfiguration({ ...config, Layers: [...config.Layers].reverse() })));
});
test('protected retention priority+count bound+authenticated preview fail closed', () => {
  const policy = { rules: [{ rulePriority: 1, selection: { tagStatus: 'tagged', tagPrefixList: ['protected-service-'], countType: 'imageCountMoreThan', countNumber: 1000 }, action: { type: 'expire' } },
    { rulePriority: 2, selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 30 }, action: { type: 'expire' } }] };
  verifyRetentionPolicy(policy, contentHash(policy));
  const required = [{ service_sha: selector.image.service_sha, digest: selector.image.digest }];
  verifyProtectedImages([{ imageDigest: selector.image.digest, imageTags: [`protected-service-${selector.image.service_sha}`] }], required);
  assert.throws(() => verifyProtectedImages([{ imageDigest: selector.image.digest, imageTags: ['normal'] }], required));
  assert.throws(() => verifyProtectedImages(Array.from({ length: 257 }, (_, i) => ({ imageDigest: `sha256:${sha256(String(i))}`, imageTags: ['protected-service-source'] })), required));
  assert.throws(() => verifyLifecyclePreview({ status: 'COMPLETE', previewResults: [{ imageDigest: selector.image.digest, action: { type: 'EXPIRE' } }] }, required));
  assert.throws(() => verifyRetentionPolicy({ rules: [policy.rules[1]] }));
});

test('direct verification rejects publisher repository/owner/fork/source identity before native reads and rechecks producer at completion', async () => {
  const native = nativeFixture();
  for (const after of [false, true]) {
    for (const mutate of [run => run.repository.owner.login = 'other', run => run.head_repository.owner.id = 1,
      run => run.head_repository.full_name = 'fork/AnyWear-Service', run => run.head_sha = '9'.repeat(40),
      run => run.run_attempt++, run => run.conclusion = 'failure']) {
      const base = selectedArtifactIo(native); let reads = 0;
      const io = { ...base, async api(endpoint) {
        const value = await base.api(endpoint);
        if (endpoint.includes('/actions/runs/') && ++reads === (after ? 2 : 1)) mutate(value);
        return value;
      } };
      await assert.rejects(verifySelection(binding, await mkdtemp(path.join(os.tmpdir(), 'infra-producer-negative-')), io), /complete successfully/);
      assert.equal(base.nativeChecks.length, after ? 6 : 0);
    }
  }
});
test('direct verification rejects release target, API asset sizes/digests and end-of-verification release drift', async () => {
  for (const [mutation, expected] of [
    [release => release.target_commitish = '9'.repeat(40), /source binding/],
    [release => release.assets[0].size++, /Downloaded asset size/],
    [release => release.assets[0].digest = `sha256:${'9'.repeat(64)}`, /API digest/],
    [release => release.assets[0].size = 0, /asset API size/]]) {
    const base = selectedArtifactIo(nativeFixture());
    await assert.rejects(verifySelection(binding, await mkdtemp(path.join(os.tmpdir(), 'infra-release-negative-')), {
      ...base, async api(endpoint) { const value = await base.api(endpoint); if (endpoint.includes('/releases/')) mutation(value); return value; },
    }), expected);
  }
  const base = selectedArtifactIo(nativeFixture()); let releases = 0;
  await assert.rejects(verifySelection(binding, await mkdtemp(path.join(os.tmpdir(), 'infra-release-drift-')), {
    ...base, async api(endpoint) { const value = await base.api(endpoint); if (endpoint.includes('/releases/') && ++releases === 2) value.assets[0].size++; return value; },
  }), /identity changed/);
});
