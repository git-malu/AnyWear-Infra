import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredStacks } from './operation-stacks.mjs';
import { STAGE_CONTRACT_PARAMETERS, readStageInputs } from './stage-contract-parameters.mjs';
import {
  DEPLOYMENT_RECORD_SCHEMA, INFRA_REPOSITORY, assertObservedMatchesDeployment, stageContractSchemaHash,
  stableLambdaConfiguration, validateDeploymentRecord, validateInfraDeploymentRecord, validateStageInputs,
} from './deployment-contract.mjs';
import { verifyLifecyclePreview, verifyProtectedImages, verifyRetentionPolicy } from './ecr-retention.mjs';

const infraSha = 'a'.repeat(40);
const endpoint = 'https://d111111abcdef8.cloudfront.net';
const stageInputs = STAGE_CONTRACT_PARAMETERS.map((parameter, index) => ({ parameter,
  version: String(index + 1), value_sha256: String(index % 10).repeat(64) }));
const observed = () => ({ lambdas: {
  'pre-sign-up': { code_sha256: `${'A'.repeat(43)}=`, configuration_sha256: '1'.repeat(64) },
  'post-confirmation': { code_sha256: `${'B'.repeat(43)}=`, configuration_sha256: '2'.repeat(64) } },
  queue_config_sha256: '3'.repeat(64), client_sha: '4'.repeat(40), endpoints: { client: endpoint } });
const record = () => ({ schema_version: 3, record_type: 'anywear_infra_deployment',
  producer: { repository: INFRA_REPOSITORY, sha: infraSha, workflow_path: '.github/workflows/runtime.yml',
    workflow_ref: `${INFRA_REPOSITORY}/.github/workflows/runtime.yml@refs/heads/main`, run_id: 41, run_attempt: 1 },
  stacks: configuredStacks.map(stack => ({ name: stack.stack_name, region: stack.region,
    producer_repository: INFRA_REPOSITORY, producer_sha: infraSha, template_sha256: 'f'.repeat(64) })),
  inputs: stageInputs,
  observed: observed(),
  schema: { content_sha256: stageContractSchemaHash(stageInputs) } });

test('the stage-contract name list is the 25 published Beta parameters, sorted', () => {
  assert.equal(STAGE_CONTRACT_PARAMETERS.length, 25);
  assert.deepEqual([...STAGE_CONTRACT_PARAMETERS], [...STAGE_CONTRACT_PARAMETERS].sort());
  assert.ok(STAGE_CONTRACT_PARAMETERS.every(name => /^\/anywear\/beta\/[a-z0-9_]+$/.test(name)));
  assert.deepEqual(validateStageInputs(stageInputs), stageInputs);
  assert.equal(stageContractSchemaHash([]), stageContractSchemaHash([]));
  assert.deepEqual(validateStageInputs([]), []);
  assert.throws(() => validateStageInputs([...stageInputs].reverse()), /sorted and unique/);
});

test('readStageInputs records versions and value hashes for every published parameter', async () => {
  const io = { async aws(args, region) {
    assert.deepEqual(args.slice(0, 2), ['ssm', 'get-parameters']);
    assert.equal(region, 'ap-east-1');
    const names = args.slice(3);
    assert.deepEqual(names, [...STAGE_CONTRACT_PARAMETERS]);
    return { Parameters: names.map((name, index) => ({ Name: name, Type: 'String', Value: `value-${index}`, Version: index + 1 })) };
  } };
  const rows = await readStageInputs(io);
  assert.equal(rows.length, 25);
  assert.deepEqual(rows.map(row => row.parameter), [...STAGE_CONTRACT_PARAMETERS]);
  assert.deepEqual(rows.map(row => row.version), STAGE_CONTRACT_PARAMETERS.map((_, index) => String(index + 1)));
  await assert.rejects(readStageInputs({ async aws() { return { Parameters: [], InvalidParameters: [] }; } }), /unavailable/);
  await assert.rejects(readStageInputs({ async aws() { return { Parameters: [{ Name: STAGE_CONTRACT_PARAMETERS[0], Type: 'String', Value: 'x', Version: 1 }], InvalidParameters: STAGE_CONTRACT_PARAMETERS.slice(1) }; } }), /unavailable/);
});

test('an Infra v3 record validates and equals its own authenticated observation', () => {
  const value = record();
  assert.deepEqual(validateDeploymentRecord(value), value);
  assert.deepEqual(validateInfraDeploymentRecord(value), value);
  const body = { stacks: value.stacks, inputs: value.inputs, observed: value.observed, schema: value.schema };
  assert.deepEqual(assertObservedMatchesDeployment(value, body), undefined);
  assert.throws(() => assertObservedMatchesDeployment(value, { ...body, observed: { ...value.observed, client_sha: '9'.repeat(40) } }),
    /Authenticated observation differs/);
});

test('the Infra record rejects a stack it does not produce or a wrong producer', () => {
  const value = record();
  const workload = { schema_version: 3, record_type: value.record_type,
    producer: { ...value.producer, repository: 'git-malu/AnyWear-Service', workflow_path: '.github/workflows/service-artifacts.yml',
      workflow_ref: 'git-malu/AnyWear-Service/.github/workflows/service-artifacts.yml@refs/heads/main' },
    stacks: [{ name: 'AnyWearWorkloadStack-beta', region: 'ap-east-1', producer_repository: 'git-malu/AnyWear-Service',
      producer_sha: infraSha, template_sha256: 'f'.repeat(64) }], inputs: stageInputs, observed: value.observed, schema: value.schema };
  assert.throws(() => validateDeploymentRecord(workload), /exactly its producer's stacks|Unexpected deployment workflow path/);
  assert.throws(() => validateDeploymentRecord({ ...value, inputs: [] }), /Stage contract schema hash differs/);
  assert.throws(() => validateDeploymentRecord({ ...value, producer: { ...value.producer, workflow_path: '.github/workflows/other.yml',
    workflow_ref: `${INFRA_REPOSITORY}/.github/workflows/other.yml@refs/heads/main` } }), /Unexpected deployment workflow path/);
});

test('stableLambdaConfiguration keeps only stable identity fields', () => {
  const config = { FunctionName: 'beta-anywear-pre-sign-up', Runtime: 'nodejs24.x', Handler: 'index.handler',
    Role: 'arn:aws:iam::650880818323:role/x', MemorySize: 512, Timeout: 30, Architectures: ['x86_64'],
    Environment: { Variables: { A: '1' }, Error: undefined }, Layers: [{ Arn: 'arn:layer' }],
    VpcConfig: { SubnetIds: ['b', 'a'], SecurityGroupIds: ['d', 'c'] }, LastModified: 'now', CodeSha256: 'ignored' };
  const stable = stableLambdaConfiguration(config);
  assert.deepEqual(stable, { FunctionName: config.FunctionName, Runtime: config.Runtime, Handler: config.Handler, Role: config.Role,
    MemorySize: 512, Timeout: 30, Architectures: ['x86_64'], Environment: { Variables: { A: '1' } }, Layers: ['arn:layer'],
    VpcConfig: { SubnetIds: ['a', 'b'], SecurityGroupIds: ['c', 'd'] } });
  assert.throws(() => stableLambdaConfiguration({ ...config, MemorySize: undefined }), /Missing Lambda stable field MemorySize/);
  assert.throws(() => stableLambdaConfiguration({ ...config, Environment: { Error: 'boom' } }), /environment observation unavailable/);
});

test('the retention validators keep the reviewed Beta policy bounds', () => {
  const policy = { rules: [
    { rulePriority: 1, selection: { tagStatus: 'tagged', tagPrefixList: ['protected-service-'], countType: 'imageCountMoreThan', countNumber: 1000 }, action: { type: 'expire' } },
    { rulePriority: 2, selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 30 }, action: { type: 'expire' } }] };
  const hash = verifyRetentionPolicy(policy);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.throws(() => verifyRetentionPolicy({ rules: [policy.rules[0]] }), /two priority-ordered/);
  assert.throws(() => verifyRetentionPolicy({ rules: [{ ...policy.rules[0], selection: { ...policy.rules[0].selection, countNumber: 10 } }, policy.rules[1]] }), /not the reviewed Beta policy/);
  const images = [{ imageDigest: `sha256:${'1'.repeat(64)}`, imageTags: ['protected-service-' + 'a'.repeat(40)] },
    { imageDigest: `sha256:${'2'.repeat(64)}`, imageTags: ['protected-service-' + 'b'.repeat(40)] }];
  assert.equal(verifyProtectedImages(images, [{ service_sha: 'a'.repeat(40), digest: `sha256:${'1'.repeat(64)}` }]), 2);
  assert.throws(() => verifyProtectedImages(images, [{ service_sha: 'c'.repeat(40), digest: `sha256:${'1'.repeat(64)}` }]), /lacks exact protected tag/);
  assert.equal(verifyLifecyclePreview({ status: 'COMPLETE', previewResults: [{ imageDigest: `sha256:${'2'.repeat(64)}`, action: { type: 'EXPIRE' } }] },
    [{ digest: `sha256:${'1'.repeat(64)}` }]), true);
  assert.throws(() => verifyLifecyclePreview({ status: 'COMPLETE', previewResults: [{ imageDigest: `sha256:${'1'.repeat(64)}`, action: { type: 'EXPIRE' } }] },
    [{ digest: `sha256:${'1'.repeat(64)}` }]), /would expire/);
});
