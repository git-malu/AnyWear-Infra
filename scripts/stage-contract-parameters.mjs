import { sha256 } from './json-contract.mjs';

// The exact `/anywear/beta/...` stage-contract surface published by
// `lib/stage-contract.ts`: 34 names exist in every identity phase and variant,
// and `cleanup_task_role_arn` exists only while the phase creates the cleanup
// task role (`identityPhase !== 'legacy'`). The deployment record names each
// consumed parameter with its SSM parameter version and the sha256 of its value,
// so a deployment is auditable without a committed cross-repository pin.
//
// This is a runtime-script mirror of the CDK construct because the workflow runs
// these scripts before (and without) compiling TypeScript. The shape is pinned by a
// contract test that compares this list with the synthesized Platform baseline.
export const STAGE_CONTRACT_STAGE = 'beta';
export const STAGE_CONTRACT_PARAMETERS = Object.freeze([
  'api_security_group_id',
  'auto_tagging_dlq_name',
  'auto_tagging_dlq_url',
  'auto_tagging_queue_arn',
  'auto_tagging_queue_name',
  'auto_tagging_queue_url',
  'cloudfront_prefix_list_id',
  'database_host',
  'database_port',
  'database_secret_arn',
  'ecs_cluster_arn',
  'ecs_cluster_name',
  'isolated_subnet_ids',
  'load_balancer_security_group_id',
  'one_shot_execution_role_arn',
  'one_shot_log_group_arn',
  'one_shot_log_group_name',
  'one_shot_security_group_id',
  'operations_topic_arn',
  'private_subnet_ids',
  'public_subnet_ids',
  's3_bucket_arn',
  'service_repository_arn',
  'service_repository_name',
  'service_repository_uri',
  'verification_task_role_arn',
  'vlm_config_arn',
  'vpc_id',
  'vto_dlq_name',
  'vto_dlq_url',
  'vto_queue_arn',
  'vto_queue_name',
  'vto_queue_url',
  'worker_security_group_id',
].map(name => `/anywear/${STAGE_CONTRACT_STAGE}/${name}`).sort());

// Published only outside `identityPhase=legacy`, because the role those names
// point at is created only outside it. A reader accepts their absence and never
// accepts a missing unconditional name.
export const STAGE_CONTRACT_CONDITIONAL_PARAMETERS = Object.freeze([
  `/anywear/${STAGE_CONTRACT_STAGE}/cleanup_task_role_arn`,
].sort());

export const STAGE_CONTRACT_READ_PARAMETERS = Object.freeze([
  ...STAGE_CONTRACT_PARAMETERS, ...STAGE_CONTRACT_CONDITIONAL_PARAMETERS].sort());

// `ssm get-parameters` accepts at most 10 names per request, so the surface is
// read in deterministic batches instead of one oversized call.
export const SSM_GET_PARAMETERS_LIMIT = 10;
export const STAGE_CONTRACT_READ_BATCHES = Object.freeze(
  Array.from({ length: Math.ceil(STAGE_CONTRACT_READ_PARAMETERS.length / SSM_GET_PARAMETERS_LIMIT) },
    (_, index) => Object.freeze(STAGE_CONTRACT_READ_PARAMETERS.slice(
      index * SSM_GET_PARAMETERS_LIMIT, (index + 1) * SSM_GET_PARAMETERS_LIMIT))));

// Read the consumed stage contract through bounded `ssm get-parameters` calls and
// normalize it to the record's `inputs[]` rows. The value itself is never
// recorded, only its content hash and the parameter version that produced it.
export async function readStageInputs(io) {
  const byName = new Map();
  for (const batch of STAGE_CONTRACT_READ_BATCHES) {
    const response = await io.aws(['ssm', 'get-parameters', '--names', ...batch], 'ap-east-1');
    const parameters = response.Parameters;
    const invalid = response.InvalidParameters ?? [];
    if (!Array.isArray(parameters) || !Array.isArray(invalid)
      || invalid.some(parameter => !batch.includes(parameter) || !STAGE_CONTRACT_CONDITIONAL_PARAMETERS.includes(parameter))
      || parameters.length + invalid.length !== batch.length) {
      throw new Error('Stage contract parameters unavailable');
    }
    for (const parameter of parameters) {
      if (!batch.includes(parameter?.Name) || byName.has(parameter.Name)) {
        throw new Error(`Stage contract parameter ${parameter?.Name} unexpected`);
      }
      byName.set(parameter.Name, parameter);
    }
  }
  if (STAGE_CONTRACT_PARAMETERS.some(parameter => !byName.has(parameter))) {
    throw new Error('Stage contract parameters unavailable');
  }
  return STAGE_CONTRACT_READ_PARAMETERS.filter(parameter => byName.has(parameter)).map(parameter => {
    const value = byName.get(parameter);
    if (typeof value.Value !== 'string' || value.Type === 'SecureString') throw new Error(`Stage contract parameter ${parameter} unreadable`);
    if (!Number.isSafeInteger(Number(value.Version)) || Number(value.Version) < 1) throw new Error(`Stage contract parameter ${parameter} has no version`);
    return { parameter, version: String(value.Version), value_sha256: sha256(value.Value) };
  });
}
