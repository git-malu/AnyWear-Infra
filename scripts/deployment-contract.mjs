import { canonicalJson, contentHash, exact, matches, integer, SHA, HASH, DIGEST } from './json-contract.mjs';
import { validateSelection } from './artifact-consumer.mjs';

export const INFRA_REPOSITORY = 'git-malu/AnyWear-Infra';
export const SERVICE_REPOSITORY = 'git-malu/AnyWear-Service';
export const account = '650880818323';
export const region = 'ap-east-1';
const equal = (actual, expected, label) => {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} differs from reviewed deployment`);
};
const migrations = (rows, label) => {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 1024) throw new Error(`Invalid ${label}`);
  let previous = -1; const ids = new Set();
  for (const row of rows) {
    exact(row, ['id', 'created_at'], label); matches(row.id, HASH, 'migration hash'); integer(row.created_at, 'migration timestamp');
    if (row.created_at <= previous || ids.has(row.id)) throw new Error(`Unordered or duplicate ${label}`);
    previous = row.created_at; ids.add(row.id);
  }
};
export function validateSchemaEvidence(schema, { infraWorkflows = ['.github/workflows/runtime.yml'] } = {}) {
  exact(schema, ['selected_journal_sha256', 'observed_applied_journal_sha256', 'selected_migration_ids',
    'applied_migration_ids', 'selected_current_version', 'minimum_schema_version', 'minimum_migration_count', 'applied_schema_version',
    'compatibility_result', 'verification'], 'schema evidence');
  matches(schema.selected_journal_sha256, HASH, 'selected journal');
  matches(schema.observed_applied_journal_sha256, HASH, 'applied journal');
  migrations(schema.selected_migration_ids, 'selected migrations'); migrations(schema.applied_migration_ids, 'applied migrations');
  integer(schema.selected_current_version, 'current schema'); integer(schema.minimum_schema_version, 'minimum schema');
  integer(schema.minimum_migration_count, 'minimum migration count');
  integer(schema.applied_schema_version, 'applied schema');
  if (schema.minimum_schema_version > schema.selected_current_version || schema.applied_schema_version < schema.minimum_schema_version
    || schema.compatibility_result !== 'compatible') throw new Error('Schema compatibility failed');
  // Selected migrations must be the exact prefix of DB history; compatible later
  // applied migrations remain legal for compute rollback under ADR-0016.
  if (schema.minimum_migration_count > schema.selected_migration_ids.length || schema.applied_migration_ids.length < schema.minimum_migration_count
    || schema.selected_current_version === schema.minimum_schema_version && schema.minimum_migration_count !== schema.selected_migration_ids.length) throw new Error('Required migration boundary not applied');
  for (let i = 0; i < Math.min(schema.selected_migration_ids.length, schema.applied_migration_ids.length); i++) equal(schema.applied_migration_ids[i], schema.selected_migration_ids[i], 'Applied migration');
  if (contentHash(schema.applied_migration_ids) !== schema.observed_applied_journal_sha256) throw new Error('Applied journal hash mismatch');
  exact(schema.verification, ['command_sha256', 'source_repository', 'source_sha', 'image_digest', 'service_sha', 'executor', 'task_arn', 'task_definition_arn'], 'verification provenance');
  matches(schema.verification.command_sha256, HASH, 'command hash'); matches(schema.verification.source_sha, SHA, 'command source');
  matches(schema.verification.image_digest, DIGEST, 'verification image'); matches(schema.verification.service_sha, SHA, 'verification Service');
  if (schema.verification.source_repository !== INFRA_REPOSITORY) throw new Error('Unexpected verification producer');
  exact(schema.verification.executor, ['repository', 'sha', 'workflow_path', 'run_id', 'run_attempt'], 'verification executor');
  const executor = schema.verification.executor;
  if (![INFRA_REPOSITORY, 'git-malu/AnyWear-E2E'].includes(executor.repository)
    || !(executor.repository === INFRA_REPOSITORY ? infraWorkflows : ['.github/workflows/beta-qualification.yml', '.github/workflows/integration.yml']).includes(executor.workflow_path)) throw new Error('Untrusted verification executor');
  matches(executor.sha, SHA, 'executor source'); integer(executor.run_id, 'executor run'); integer(executor.run_attempt, 'executor attempt');
  matches(schema.verification.task_arn, /^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/[a-f0-9]{32}$/, 'verification task');
  matches(schema.verification.task_definition_arn, /^arn:aws:ecs:ap-east-1:650880818323:task-definition\/beta-anywear-artifact-verify:[1-9][0-9]*$/, 'verification task definition');
  return schema;
}
export function validateSnapshot(snapshot, options) {
  exact(snapshot, ['stacks', 'observed', 'schema'], 'observation');
  if (!Array.isArray(snapshot.stacks) || snapshot.stacks.length !== 4) throw new Error('Four deployed stacks required');
  const names = new Set();
  for (const stack of snapshot.stacks) {
    exact(stack, ['stack_name', 'region', 'source_repository', 'source_sha', 'template_sha256'], 'stack');
    if (!['AnyWearFoundationStack', 'AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta', 'AnyWearBillingStack-beta'].includes(stack.stack_name)
      || names.has(stack.stack_name) || stack.region !== (stack.stack_name.includes('Billing') ? 'us-east-1' : region)
      || ![INFRA_REPOSITORY, SERVICE_REPOSITORY].includes(stack.source_repository)) throw new Error('Invalid stack identity');
    names.add(stack.stack_name); matches(stack.source_sha, SHA, 'stack source'); matches(stack.template_sha256, HASH, 'Original template hash');
  }
  exact(snapshot.observed, ['service_sha', 'image_digest', 'ecs', 'lambdas', 'policy_content_sha256', 'queue_config_sha256', 'client_sha', 'endpoints'], 'observed tuple');
  const observed = snapshot.observed;
  matches(observed.service_sha, SHA, 'observed Service'); matches(observed.image_digest, DIGEST, 'observed image');
  matches(observed.client_sha, SHA, 'observed Client'); matches(observed.policy_content_sha256, HASH, 'policy'); matches(observed.queue_config_sha256, HASH, 'queue config');
  exact(observed.ecs, ['api', 'worker'], 'ECS identities');
  for (const [purpose, identity] of Object.entries(observed.ecs)) {
    exact(identity, ['service_arn', 'task_definition_arn', 'image_digest'], 'ECS task image identity');
    matches(identity.service_arn, new RegExp(`^arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-${purpose}$`), 'ECS service');
    matches(identity.task_definition_arn, new RegExp(`^arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-${purpose}:[1-9][0-9]*$`), 'ECS task definition');
    if (identity.image_digest !== observed.image_digest) throw new Error('ECS selected digest mismatch');
  }
  exact(observed.lambdas, ['pre-sign-up', 'post-confirmation'], 'Lambdas');
  for (const item of Object.values(observed.lambdas)) {
    exact(item, ['code_sha256', 'configuration_sha256'], 'Lambda identity');
    matches(item.code_sha256, /^[A-Za-z0-9+/]{43}=$/, 'Lambda CodeSha256'); matches(item.configuration_sha256, HASH, 'Lambda stable config');
  }
  exact(observed.endpoints, ['api', 'client'], 'endpoints');
  for (const url of Object.values(observed.endpoints)) matches(url, /^https:\/\/[a-z0-9]+\.cloudfront\.net$/, 'CloudFront endpoint');
  validateSchemaEvidence(snapshot.schema, options);
  equal(snapshot.schema.verification.service_sha, observed.service_sha, 'Verified image producer');
  equal(snapshot.schema.verification.image_digest, observed.image_digest, 'Verified digest');
  return snapshot;
}
export function validateDeploymentRecord(record) {
  exact(record, ['schema_version', 'record_type', 'infra', 'selection', 'stacks', 'observed', 'schema'], 'deployment record');
  if (record.schema_version !== 2 || record.record_type !== 'anywear_infra_deployment') throw new Error('Unknown deployment schema; historical v1 is not a direct-verification input');
  exact(record.infra, ['repository', 'sha', 'workflow_path', 'workflow_ref', 'run_id', 'run_attempt'], 'Infra run');
  const infra = record.infra;
  if (infra.repository !== INFRA_REPOSITORY || infra.workflow_path !== '.github/workflows/runtime.yml'
    || infra.workflow_ref !== `${INFRA_REPOSITORY}/${infra.workflow_path}@refs/heads/main`) throw new Error('Unexpected deployment workflow');
  matches(infra.sha, SHA, 'Infra SHA'); integer(infra.run_id, 'Infra run'); integer(infra.run_attempt, 'Infra attempt');
  exact(record.selection, ['file', 'sha256', 'release', 'components'], 'selection'); matches(record.selection.sha256, HASH, 'selector hash');
  matches(record.selection.file, /^selections\/[a-z0-9][a-z0-9._-]{0,127}\.json$/, 'committed selection path');
  exact(record.selection.release, ['repository', 'id', 'manifest_asset_id', 'manifest_sha256'], 'release');
  const release = record.selection.release;
  if (release.repository !== SERVICE_REPOSITORY) throw new Error('Unexpected Service release');
  integer(release.id, 'release ID'); integer(release.manifest_asset_id, 'manifest asset ID'); matches(release.manifest_sha256, HASH, 'manifest hash');
  exact(record.selection.components, ['image', 'lambdas', 'runtime_policy', 'schema'], 'component expectations');
  const selector = { schema_version: 2, record_type: 'anywear_infra_selection', release, ...record.selection.components };
  validateSelection(selector);
  if (contentHash(selector) !== record.selection.sha256) throw new Error('Canonical exact selector bytes mismatch');
  validateSnapshot({ stacks: record.stacks, observed: record.observed, schema: record.schema });
  if (record.schema.verification.source_sha !== infra.sha) throw new Error('Verification command source does not match Infra source');
  const components = record.selection.components;
  equal(record.observed.service_sha, components.image.service_sha, 'Selected image producer'); equal(record.observed.image_digest, components.image.digest, 'Selected digest');
  equal(record.observed.policy_content_sha256, components.runtime_policy.content_sha256, 'Selected runtime policy');
  for (const [name, key] of [['pre-sign-up', 'pre_sign_up'], ['post-confirmation', 'post_confirmation']]) equal(record.observed.lambdas[name].code_sha256, components.lambdas[key].code_sha256, 'Selected Lambda code');
  equal(record.schema.selected_journal_sha256, components.schema.journal_sha256, 'Selected journal');
  equal(record.schema.selected_current_version, components.schema.current_version, 'Selected current schema');
  equal(record.schema.minimum_schema_version, components.schema.minimum_version, 'Selected minimum schema');
  return record;
}
export function assertObservedMatchesDeployment(record, snapshot) {
  validateDeploymentRecord(record); validateSnapshot(snapshot);
  const stable = value => {
    const copied = structuredClone(value);
    delete copied.schema.verification.executor; delete copied.schema.verification.task_arn; delete copied.schema.verification.task_definition_arn;
    return copied;
  };
  equal(stable(snapshot), stable({ stacks: record.stacks, observed: record.observed, schema: record.schema }), 'Authenticated observation');
}

export function stableLambdaConfiguration(config) {
  const mapping = ['FunctionName', 'Runtime', 'Handler', 'Role', 'MemorySize', 'Timeout', 'Architectures', 'Environment',
    'Layers', 'VpcConfig', 'EphemeralStorage', 'LoggingConfig', 'KMSKeyArn'];
  const out = {};
  for (const key of mapping) if (config[key] !== undefined) out[key] = config[key];
  if (out.Environment) {
    if (out.Environment.Error || !out.Environment.Variables || typeof out.Environment.Variables !== 'object') throw new Error('Lambda environment observation unavailable');
    out.Environment = { Variables: out.Environment.Variables };
  }
  if (out.Layers) out.Layers = out.Layers.map(layer => layer.Arn);
  if (out.VpcConfig) out.VpcConfig = {
    SubnetIds: [...out.VpcConfig.SubnetIds].sort(), SecurityGroupIds: [...out.VpcConfig.SecurityGroupIds].sort(),
    ...(out.VpcConfig.Ipv6AllowedForDualStack !== undefined ? { Ipv6AllowedForDualStack: out.VpcConfig.Ipv6AllowedForDualStack } : {}),
  };
  for (const required of ['FunctionName', 'Runtime', 'Handler', 'Role', 'MemorySize', 'Timeout', 'Architectures']) {
    if (out[required] === undefined) throw new Error(`Missing Lambda stable field ${required}`);
  }
  return out;
}
