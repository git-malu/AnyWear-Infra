import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  STAGE_CONTRACT_STAGE,
  STAGE_CONTRACT_PARAMETERS,
  STAGE_CONTRACT_CONDITIONAL_PARAMETERS,
  STAGE_CONTRACT_READ_PARAMETERS,
  stageParameters,
  validateStageInputs,
  stageContractSchemaHash,
} from '../index.mjs';

// The reviewed stage-base surface. The absolute names are the deployment record's
// `inputs[].parameter` values and the Platform stack's published SSM names, so a
// change here is a stage-contract change, not a refactor.
const EXPECTED_UNCONDITIONAL = [
  '/anywear/beta/api_base_url',
  '/anywear/beta/api_security_group_id',
  '/anywear/beta/auto_tagging_dlq_name',
  '/anywear/beta/auto_tagging_dlq_url',
  '/anywear/beta/auto_tagging_queue_arn',
  '/anywear/beta/auto_tagging_queue_name',
  '/anywear/beta/auto_tagging_queue_url',
  '/anywear/beta/cloudfront_prefix_list_id',
  '/anywear/beta/database_host',
  '/anywear/beta/database_port',
  '/anywear/beta/database_secret_arn',
  '/anywear/beta/ecs_cluster_arn',
  '/anywear/beta/ecs_cluster_name',
  '/anywear/beta/isolated_subnet_ids',
  '/anywear/beta/load_balancer_security_group_id',
  '/anywear/beta/one_shot_execution_role_arn',
  '/anywear/beta/one_shot_log_group_arn',
  '/anywear/beta/one_shot_log_group_name',
  '/anywear/beta/one_shot_security_group_id',
  '/anywear/beta/operations_topic_arn',
  '/anywear/beta/private_subnet_ids',
  '/anywear/beta/public_subnet_ids',
  '/anywear/beta/s3_bucket_arn',
  '/anywear/beta/service_repository_arn',
  '/anywear/beta/service_repository_name',
  '/anywear/beta/service_repository_uri',
  '/anywear/beta/verification_task_role_arn',
  '/anywear/beta/vlm_config_arn',
  '/anywear/beta/vpc_id',
  '/anywear/beta/vto_dlq_name',
  '/anywear/beta/vto_dlq_url',
  '/anywear/beta/vto_queue_arn',
  '/anywear/beta/vto_queue_name',
  '/anywear/beta/vto_queue_url',
  '/anywear/beta/worker_security_group_id',
];

const sha256 = value => createHash('sha256').update(value).digest('hex');

test('the contract names are the 35 unconditional Beta parameters plus one conditional name', () => {
  assert.equal(STAGE_CONTRACT_STAGE, 'beta');
  assert.deepEqual([...STAGE_CONTRACT_PARAMETERS], EXPECTED_UNCONDITIONAL);
  assert.deepEqual([...STAGE_CONTRACT_CONDITIONAL_PARAMETERS], ['/anywear/beta/cleanup_task_role_arn']);
  assert.deepEqual([...STAGE_CONTRACT_READ_PARAMETERS], [...EXPECTED_UNCONDITIONAL,
    '/anywear/beta/cleanup_task_role_arn'].sort());
  assert.equal(STAGE_CONTRACT_PARAMETERS.length, 35);
  assert.equal(STAGE_CONTRACT_CONDITIONAL_PARAMETERS.length, 1);
  assert.equal(STAGE_CONTRACT_READ_PARAMETERS.length, 36);
  assert.ok(STAGE_CONTRACT_PARAMETERS.every(name => /^\/anywear\/beta\/[a-z0-9_]+$/.test(name)));
  assert.ok([...STAGE_CONTRACT_PARAMETERS, ...STAGE_CONTRACT_CONDITIONAL_PARAMETERS]
    .every(name => STAGE_CONTRACT_READ_PARAMETERS.includes(name)));
  assert.ok(Object.isFrozen(STAGE_CONTRACT_PARAMETERS));
  assert.ok(Object.isFrozen(STAGE_CONTRACT_CONDITIONAL_PARAMETERS));
  assert.ok(Object.isFrozen(STAGE_CONTRACT_READ_PARAMETERS));
});

test('stageParameters returns typed definitions sorted by absolute name', () => {
  const definitions = stageParameters();
  assert.ok(Object.isFrozen(definitions));
  assert.equal(definitions.length, 36);
  assert.deepEqual(definitions.map(definition => definition.parameter), [...STAGE_CONTRACT_READ_PARAMETERS]);
  assert.deepEqual(definitions.map(definition => definition.parameter),
    [...definitions.map(definition => definition.parameter)].sort());
  assert.equal(new Set(definitions.map(definition => definition.name)).size, 36);
  for (const definition of definitions) {
    assert.deepEqual(Object.keys(definition).sort(), ['kind', 'name', 'parameter']);
    assert.ok(Object.isFrozen(definition));
    assert.equal(definition.parameter, `/anywear/${STAGE_CONTRACT_STAGE}/${definition.name}`);
    assert.ok(['String', 'List'].includes(definition.kind), `Unexpected kind ${definition.kind}`);
  }
  assert.deepEqual(definitions.filter(definition => definition.kind === 'List').map(definition => definition.name),
    ['isolated_subnet_ids', 'private_subnet_ids', 'public_subnet_ids']);
  assert.deepEqual(definitions.filter(definition => STAGE_CONTRACT_CONDITIONAL_PARAMETERS
    .includes(definition.parameter)).map(definition => definition.name), ['cleanup_task_role_arn']);
});

test('stage inputs are sorted, unique rows with a version and a value hash', () => {
  const rows = [
    { parameter: '/anywear/beta/public_subnet_ids', version: '2', value_sha256: 'b'.repeat(64) },
    { parameter: '/anywear/beta/vpc_id', version: '4', value_sha256: 'd'.repeat(64) },
  ];
  assert.deepEqual(validateStageInputs(rows), rows);
  assert.deepEqual(validateStageInputs([]), []);
  assert.throws(() => validateStageInputs([...rows].reverse()), /sorted and unique/);
  assert.throws(() => validateStageInputs([rows[1], { ...rows[1] }]), /sorted and unique/);
  assert.throws(() => validateStageInputs([{ ...rows[1], parameter: '/anywear/beta/VPC' }]), /Invalid stage contract parameter/);
  assert.throws(() => validateStageInputs([{ ...rows[1], parameter: '/elsewhere/beta/vpc_id' }]), /Invalid stage contract parameter/);
  assert.throws(() => validateStageInputs([{ ...rows[1], version: '0' }]), /Invalid stage contract parameter version/);
  assert.throws(() => validateStageInputs([{ ...rows[1], value_sha256: 'not-a-hash' }]), /Invalid stage contract value hash/);
  assert.throws(() => validateStageInputs([{ ...rows[1], extra: true }]), /Invalid stage contract input fields/);
  assert.throws(() => validateStageInputs(Array.from({ length: 65 }, () => rows[1])), /Invalid stage contract inputs/);
});

test('the schema hash is recomputable from parameter and version only', () => {
  const rows = [
    { parameter: '/anywear/beta/public_subnet_ids', version: '2', value_sha256: 'b'.repeat(64) },
    { parameter: '/anywear/beta/vpc_id', version: '4', value_sha256: 'd'.repeat(64) },
  ];
  assert.equal(stageContractSchemaHash(rows), sha256(
    '[{"parameter":"/anywear/beta/public_subnet_ids","version":"2"},{"parameter":"/anywear/beta/vpc_id","version":"4"}]'));
  // The value hash and row order do not enter the schema identity; the sorted
  // parameter/version rows do, and a changed version changes the hash.
  assert.equal(stageContractSchemaHash(rows.map(row => ({ ...row, value_sha256: 'e'.repeat(64) }))),
    stageContractSchemaHash(rows));
  assert.notEqual(stageContractSchemaHash([rows[0], { ...rows[1], version: '5' }]), stageContractSchemaHash(rows));
  assert.equal(stageContractSchemaHash([]), sha256('[]'));
});
