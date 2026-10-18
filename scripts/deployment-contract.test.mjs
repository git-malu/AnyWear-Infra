import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHash } from './json-contract.mjs';
import { configuredStacks } from './operation-stacks.mjs';
import {
  DEPLOYMENT_RECORD_MEMBERS, SERVICE_DEPLOYMENT_RECORD_MEMBERS, SERVICE_DEPLOYMENT_RECORD_SCHEMA,
  SERVICE_ECS_IDENTITY_FIELDS, validateDeploymentGate,
  stageContractSchemaHash, taskDefinitionContentHash, stableTaskDefinition,
  validateDeploymentRecord, validateInfraDeploymentRecord, validateServiceDeploymentRecord,
} from './deployment-contract.mjs';
import { gateBlock } from '../packages/stage-contracts/test/gate-fixture.mjs';

const infraSha = 'a'.repeat(40); const serviceSha = 'b'.repeat(40);
const imageDigest = `sha256:${'c'.repeat(64)}`;
const inputs = [{ parameter: '/anywear/beta/vpc_id', version: '4', value_sha256: 'd'.repeat(64) },
  { parameter: '/anywear/beta/vpc_secondary_id', version: '7', value_sha256: 'e'.repeat(64) }];
const endpoint = 'https://d111111abcdef8.cloudfront.net';
const producer = (repository, workflow_path) => ({ repository, sha: repository === 'git-malu/AnyWear-Infra' ? infraSha : serviceSha,
  workflow_path, workflow_ref: `${repository}/${workflow_path}@refs/heads/main`, run_id: 11, run_attempt: 1 });

function infraRecord() {
  return { schema_version: 3, record_type: 'anywear_infra_deployment',
    producer: producer('git-malu/AnyWear-Infra', '.github/workflows/runtime.yml'),
    stacks: configuredStacks.map(stack => ({ name: stack.stack_name, region: stack.region,
      producer_repository: 'git-malu/AnyWear-Infra', producer_sha: infraSha, template_sha256: 'f'.repeat(64) })),
    inputs,
    observed: { lambdas: {
      'pre-sign-up': { code_sha256: `${'A'.repeat(43)}=`, configuration_sha256: '1'.repeat(64) },
      'post-confirmation': { code_sha256: `${'B'.repeat(43)}=`, configuration_sha256: '2'.repeat(64) } },
    queue_config_sha256: '3'.repeat(64), client_sha: '4'.repeat(40), endpoints: { client: endpoint } },
    schema: { content_sha256: stageContractSchemaHash(inputs) } };
}

function serviceRecord({ revision = 12, digest = imageDigest } = {}) {
  const taskDefinition = { family: 'beta-anywear-api', taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-api-task',
    executionRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-api-execution', networkMode: 'awsvpc', cpu: '512', memory: '1024',
    containerDefinitions: [{ name: 'ApiContainer', image: `650880818323.dkr.ecr.ap-east-1.amazonaws.com/beta-anywear-service@${imageDigest}`,
      command: ['node', 'dist/index.js'], environment: [{ name: 'B', value: '2' }, { name: 'A', value: '1' }] }] };
  return { schema_version: 4, record_type: SERVICE_DEPLOYMENT_RECORD_SCHEMA.record_type,
    producer: producer('git-malu/AnyWear-Service', '.github/workflows/service-artifacts.yml'),
    stacks: [{ name: 'AnyWearWorkloadStack-beta', region: 'ap-east-1', producer_repository: 'git-malu/AnyWear-Service',
      producer_sha: serviceSha, template_sha256: '5'.repeat(64) }],
    inputs,
    observed: { service_sha: serviceSha, image_digest: digest,
      ecs: { api: { service_arn: 'arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-api',
        task_definition_arn: `arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-api:${revision}`,
        task_definition_sha256: taskDefinitionContentHash(taskDefinition), image_digest: digest },
      worker: { service_arn: 'arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-worker',
        task_definition_arn: `arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-worker:${revision}`,
        task_definition_sha256: taskDefinitionContentHash({ ...taskDefinition, family: 'beta-anywear-worker',
          taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-worker-task' }), image_digest: digest } },
      endpoints: { api: endpoint } },
    schema: { content_sha256: stageContractSchemaHash(inputs) },
    gate: gateBlock() };
}

test('a complete Infra v3 record validates', () => {
  const record = infraRecord();
  assert.deepEqual(validateInfraDeploymentRecord(record), record);
  assert.deepEqual(validateDeploymentRecord(record), record);
  assert.deepEqual([...DEPLOYMENT_RECORD_MEMBERS].sort(), Object.keys(record).sort());
});

test('a complete Service v4 record validates, lists only the workload stack and carries the gate', () => {
  const record = serviceRecord();
  assert.deepEqual(validateServiceDeploymentRecord(record), record);
  assert.deepEqual(validateDeploymentRecord(record), record);
  assert.deepEqual(SERVICE_DEPLOYMENT_RECORD_SCHEMA.stacks, [{ name: 'AnyWearWorkloadStack-beta', region: 'ap-east-1' }]);
  assert.equal(SERVICE_DEPLOYMENT_RECORD_SCHEMA.schema_version, 4);
  assert.deepEqual([...SERVICE_DEPLOYMENT_RECORD_MEMBERS].sort(), Object.keys(record).sort());
  assert.deepEqual([...SERVICE_DEPLOYMENT_RECORD_MEMBERS].sort(), [...DEPLOYMENT_RECORD_MEMBERS, 'gate'].sort());
  assert.deepEqual(validateDeploymentGate(record.gate, 'beta'), record.gate);
});

test('both record types reject an extra or missing member', () => {
  for (const build of [infraRecord, serviceRecord]) {
    const extra = { ...build(), note: 'unexpected' };
    assert.throws(() => validateDeploymentRecord(extra), /Invalid deployment record fields/);
    const missing = structuredClone(build()); delete missing.schema;
    assert.throws(() => validateDeploymentRecord(missing), /Invalid deployment record fields/);
    const wrongProducer = structuredClone(build()); wrongProducer.producer.repository = 'git-malu/AnyWear-Client';
    assert.throws(() => validateDeploymentRecord(wrongProducer));
  }
  // A record may not borrow the other producer's stacks; the v4 Service record
  // additionally requires the gate member, so the member set is refused first.
  const crossed = infraRecord(); crossed.record_type = SERVICE_DEPLOYMENT_RECORD_SCHEMA.record_type;
  assert.throws(() => validateServiceDeploymentRecord(crossed), /Invalid deployment record fields/);
});

test('the Service producer may not carry an Infra stack or workflow', () => {
  const record = serviceRecord();
  assert.throws(() => validateServiceDeploymentRecord({ ...record,
    producer: producer('git-malu/AnyWear-Service', '.github/workflows/runtime.yml') }), /Unexpected deployment workflow path/);
});

test('a task-definition revision-only change is not an identity failure', () => {
  const before = serviceRecord({ revision: 12 }); const after = serviceRecord({ revision: 13 });
  assert.deepEqual(validateServiceDeploymentRecord(before), before);
  assert.deepEqual(validateServiceDeploymentRecord(after), after);
  assert.equal(after.observed.ecs.api.task_definition_sha256, before.observed.ecs.api.task_definition_sha256);
  assert.notEqual(after.observed.ecs.api.task_definition_arn, before.observed.ecs.api.task_definition_arn);
});

test('a content or image identity change fails and names the field', () => {
  const changedDigest = serviceRecord();
  changedDigest.observed.ecs.api.image_digest = `sha256:${'9'.repeat(64)}`;
  assert.throws(() => validateServiceDeploymentRecord(changedDigest), /ECS api image_digest differs from the deployed image/);
  const changedContent = serviceRecord();
  changedContent.observed.ecs.api.task_definition_sha256 = 'not-a-content-hash';
  assert.throws(() => validateServiceDeploymentRecord(changedContent), /Invalid ECS api task definition content hash/);
});

test('stableTaskDefinition normalizes environment order and rejects drift in content', () => {
  const base = { family: 'beta-anywear-api', taskRoleArn: 'r', executionRoleArn: 'e', networkMode: 'awsvpc', cpu: '512', memory: '1024',
    containerDefinitions: [{ name: 'ApiContainer', image: 'img', command: ['node'], environment: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }] }] };
  const reordered = structuredClone(base);
  reordered.containerDefinitions[0].environment = [{ name: 'B', value: '2' }, { name: 'A', value: '1' }];
  assert.equal(taskDefinitionContentHash(reordered), taskDefinitionContentHash(base));
  const changed = structuredClone(base); changed.containerDefinitions[0].environment[0].value = '9';
  assert.notEqual(taskDefinitionContentHash(changed), taskDefinitionContentHash(base));
  assert.deepEqual([...SERVICE_ECS_IDENTITY_FIELDS], ['service_arn', 'task_definition_arn', 'task_definition_sha256', 'image_digest']);
  assert.throws(() => stableTaskDefinition({ family: 'x', containerDefinitions: [] }), /Single-container task definition required/);
});
