import { sha256 } from './json-contract.mjs';

// The exact `/anywear/beta/...` stage-contract surface published by
// `lib/stage-contract.ts` (25 parameters). The deployment record names each one
// with its SSM parameter version and the sha256 of its value, so a deployment is
// auditable without a committed cross-repository pin.
//
// This is a runtime-script mirror of the CDK construct because the workflow runs
// these scripts before (and without) compiling TypeScript. The shape is pinned by a
// contract test that compares this list with the synthesized Platform baseline.
export const STAGE_CONTRACT_STAGE = 'beta';
export const STAGE_CONTRACT_PARAMETERS = Object.freeze([
  'api_security_group_id',
  'auto_tagging_dlq_name',
  'auto_tagging_queue_arn',
  'auto_tagging_queue_name',
  'auto_tagging_queue_url',
  'cloudfront_prefix_list_id',
  'database_host',
  'database_port',
  'database_secret_arn',
  'ecs_cluster_name',
  'load_balancer_security_group_id',
  'operations_topic_arn',
  'private_subnet_ids',
  'public_subnet_ids',
  's3_bucket_arn',
  'service_repository_arn',
  'service_repository_name',
  'service_repository_uri',
  'vlm_config_arn',
  'vpc_id',
  'vto_dlq_name',
  'vto_queue_arn',
  'vto_queue_name',
  'vto_queue_url',
  'worker_security_group_id',
].map(name => `/anywear/${STAGE_CONTRACT_STAGE}/${name}`).sort());

// Read the consumed stage contract through one `ssm get-parameters` call and
// normalize it to the record's `inputs[]` rows. The value itself is never
// recorded, only its content hash and the parameter version that produced it.
export async function readStageInputs(io) {
  const response = await io.aws(['ssm', 'get-parameters', '--names', ...STAGE_CONTRACT_PARAMETERS], 'ap-east-1');
  const parameters = response.Parameters;
  if (!Array.isArray(parameters) || parameters.length !== STAGE_CONTRACT_PARAMETERS.length
    || (response.InvalidParameters ?? []).length !== 0) throw new Error('Stage contract parameters unavailable');
  const byName = new Map(parameters.map(parameter => [parameter?.Name, parameter]));
  return STAGE_CONTRACT_PARAMETERS.map(parameter => {
    const value = byName.get(parameter);
    if (!value || typeof value.Value !== 'string' || value.Type === 'SecureString') throw new Error(`Stage contract parameter ${parameter} unreadable`);
    if (!Number.isSafeInteger(Number(value.Version)) || Number(value.Version) < 1) throw new Error(`Stage contract parameter ${parameter} has no version`);
    return { parameter, version: String(value.Version), value_sha256: sha256(value.Value) };
  });
}
