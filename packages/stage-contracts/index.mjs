// @git-malu/stage-contracts
//
// The versioned, dependency-free source of the AnyWear Beta stage contract:
// the SSM parameter surface the stage base publishes, the stack identities and
// Foundation service-role naming, and the pure v3 `anywear_service_deployment`
// record validators. AnyWear-Infra consumes it directly; AnyWear-Service pins a
// packed tarball. Nothing here reads AWS, CloudFormation or the filesystem.
//
// The stage reading itself belongs to the consumer: `stageParameters()` returns
// the typed definitions, and a CDK app creates its own
// `AWS::SSM::Parameter::Value<String|List<String>>` `CfnParameter`s from them.
// Keeping `aws-cdk-lib` out keeps this package usable by plain Node scripts.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Canonical JSON and content hashing
//
// The record's `schema.content_sha256` and each task-definition identity are
// content hashes over RFC 8785-style canonical JSON. The same bytes must hash the
// same here and in AnyWear-Service, so this stays self-contained instead of
// importing another repository's helper.

// RFC 8785 uses ECMAScript number serialization and UTF-16 property sorting.
function canonicalJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite JSON number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Unpaired Unicode surrogate');
      } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error('Unpaired Unicode surrogate');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== undefined) return `{${Object.keys(value).sort()
    .map(key => `${canonicalJson(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  throw new Error('Unsupported JSON value');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function contentHash(value) {
  return sha256(canonicalJson(value));
}

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function exact(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) throw new Error(`Invalid ${label} fields`);
  return value;
}

function matches(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function integer(value, label, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${label}`);
  return value;
}

// ---------------------------------------------------------------------------
// Stage contract
//
// The stage base is published as plain SSM parameters under
// `/anywear/beta/...`. Every name in `STAGE_CONTRACT_PARAMETERS` exists in every
// Beta identity phase and environment variant. `cleanup_task_role_arn` exists
// only while the phase creates the cleanup task role (`identityPhase !==
// 'legacy'`), so a reader accepts its absence and never accepts a missing
// unconditional name.

export const STAGE_CONTRACT_STAGE = 'beta';

const STAGE_CONTRACT_DEFINITIONS = Object.freeze([
  { name: 'api_security_group_id', kind: 'String', conditional: false },
  { name: 'auto_tagging_dlq_name', kind: 'String', conditional: false },
  { name: 'auto_tagging_dlq_url', kind: 'String', conditional: false },
  { name: 'auto_tagging_queue_arn', kind: 'String', conditional: false },
  { name: 'auto_tagging_queue_name', kind: 'String', conditional: false },
  { name: 'auto_tagging_queue_url', kind: 'String', conditional: false },
  { name: 'cleanup_task_role_arn', kind: 'String', conditional: true },
  { name: 'cloudfront_prefix_list_id', kind: 'String', conditional: false },
  { name: 'database_host', kind: 'String', conditional: false },
  { name: 'database_port', kind: 'String', conditional: false },
  { name: 'database_secret_arn', kind: 'String', conditional: false },
  { name: 'ecs_cluster_arn', kind: 'String', conditional: false },
  { name: 'ecs_cluster_name', kind: 'String', conditional: false },
  { name: 'isolated_subnet_ids', kind: 'List', conditional: false },
  { name: 'load_balancer_security_group_id', kind: 'String', conditional: false },
  { name: 'one_shot_execution_role_arn', kind: 'String', conditional: false },
  { name: 'one_shot_log_group_arn', kind: 'String', conditional: false },
  { name: 'one_shot_log_group_name', kind: 'String', conditional: false },
  { name: 'one_shot_security_group_id', kind: 'String', conditional: false },
  { name: 'operations_topic_arn', kind: 'String', conditional: false },
  { name: 'private_subnet_ids', kind: 'List', conditional: false },
  { name: 'public_subnet_ids', kind: 'List', conditional: false },
  { name: 's3_bucket_arn', kind: 'String', conditional: false },
  { name: 'service_repository_arn', kind: 'String', conditional: false },
  { name: 'service_repository_name', kind: 'String', conditional: false },
  { name: 'service_repository_uri', kind: 'String', conditional: false },
  { name: 'verification_task_role_arn', kind: 'String', conditional: false },
  { name: 'vlm_config_arn', kind: 'String', conditional: false },
  { name: 'vpc_id', kind: 'String', conditional: false },
  { name: 'vto_dlq_name', kind: 'String', conditional: false },
  { name: 'vto_dlq_url', kind: 'String', conditional: false },
  { name: 'vto_queue_arn', kind: 'String', conditional: false },
  { name: 'vto_queue_name', kind: 'String', conditional: false },
  { name: 'vto_queue_url', kind: 'String', conditional: false },
  { name: 'worker_security_group_id', kind: 'String', conditional: false },
]);

function stageParameterName(name) {
  return `/anywear/${STAGE_CONTRACT_STAGE}/${name}`;
}

// Public, typed definitions: the short suffix, the value kind a consumer's
// `CfnParameter` needs, and the absolute SSM name.
const STAGE_PARAMETER_DEFINITIONS = Object.freeze(STAGE_CONTRACT_DEFINITIONS
  .map(definition => Object.freeze({
    name: definition.name,
    kind: definition.kind,
    parameter: stageParameterName(definition.name),
  }))
  .sort((left, right) => (left.parameter < right.parameter ? -1 : left.parameter > right.parameter ? 1 : 0)));

const CONDITIONAL_NAMES = new Set(STAGE_CONTRACT_DEFINITIONS
  .filter(definition => definition.conditional)
  .map(definition => definition.name));

export const STAGE_CONTRACT_PARAMETERS = Object.freeze(STAGE_PARAMETER_DEFINITIONS
  .filter(definition => !CONDITIONAL_NAMES.has(definition.name))
  .map(definition => definition.parameter));

export const STAGE_CONTRACT_CONDITIONAL_PARAMETERS = Object.freeze(STAGE_PARAMETER_DEFINITIONS
  .filter(definition => CONDITIONAL_NAMES.has(definition.name))
  .map(definition => definition.parameter));

export const STAGE_CONTRACT_READ_PARAMETERS = Object.freeze(
  STAGE_PARAMETER_DEFINITIONS.map(definition => definition.parameter));

/**
 * The typed stage-parameter definitions, sorted by absolute SSM name.
 *
 * Each entry is `{ name, kind, parameter }`: the short suffix (`vpc_id`), the
 * CloudFormation value kind (`String` or `List`) and the absolute published name
 * (`/anywear/beta/vpc_id`). A consumer creates its own
 * `AWS::SSM::Parameter::Value<String>` or `...<List<String>>` `CfnParameter`
 * with that absolute name as its default.
 *
 * The conditional `cleanup_task_role_arn` definition is included; filter it with
 * `STAGE_CONTRACT_CONDITIONAL_PARAMETERS` when the identity phase is `legacy`.
 */
export function stageParameters() {
  return STAGE_PARAMETER_DEFINITIONS;
}

// `inputs[]` rows record the stage-contract parameter a deployment read: name,
// SSM version and the sha256 of the value. The value itself is never recorded.
export function validateStageInputs(rows) {
  if (!Array.isArray(rows) || rows.length > 64) throw new Error('Invalid stage contract inputs');
  let previous;
  for (const row of rows) {
    exact(row, DEPLOYMENT_INPUT_FIELDS, 'stage contract input');
    matches(row.parameter, /^\/anywear\/[a-z]+\/[a-z0-9_]+$/, 'stage contract parameter');
    matches(row.version, /^[1-9][0-9]*$/, 'stage contract parameter version');
    matches(row.value_sha256, HASH, 'stage contract value hash');
    if (previous !== undefined && !(previous < row.parameter)) throw new Error('Stage contract inputs must be sorted and unique');
    previous = row.parameter;
  }
  return rows;
}

// The schema member is derived from the recorded inputs, so a reader can
// recompute it instead of trusting a cross-repository pin.
export function stageContractSchemaHash(rows) {
  return contentHash(validateStageInputs(rows).map(({ parameter, version }) => ({ parameter, version })));
}

// ---------------------------------------------------------------------------
// Stack identity

export const INFRA_REPOSITORY = 'git-malu/AnyWear-Infra';
export const SERVICE_REPOSITORY = 'git-malu/AnyWear-Service';

export function platformStackName(stage) {
  return `AnyWearPlatformStack-${stage}`;
}

export function workloadStackName(stage) {
  return `AnyWearWorkloadStack-${stage}`;
}

// The Service release chain's one stack and its producer workflow. The record
// schema and validators below are the generic v3 Service producer contract.
export const SERVICE_WORKLOAD_STACK = Object.freeze({
  name: workloadStackName(STAGE_CONTRACT_STAGE),
  region: 'ap-east-1',
  workflow_path: '.github/workflows/service-artifacts.yml',
});

// ---------------------------------------------------------------------------
// v3 deployment record
//
//   producer  the repository/commit/workflow that produced this record
//   stacks    every stack this record's producer owns, each with its producer
//             identity and the sha256 of its deployed Original template body
//   inputs    the stage-contract SSM parameters the deployment consumed
//   observed  the authenticated observation that producer made
//   schema    a content hash of the consumed stage-contract schema surface
//
// Service produces `anywear_service_deployment` for `AnyWearWorkloadStack-beta`
// only. `validateServiceDeploymentRecord` is the consumer-side validator: a
// record it accepts is a record another producer can verify without trusting the
// writer.

export const DEPLOYMENT_RECORD_MEMBERS = Object.freeze(
  ['schema_version', 'record_type', 'producer', 'stacks', 'inputs', 'observed', 'schema']);
export const DEPLOYMENT_PRODUCER_FIELDS = Object.freeze(
  ['repository', 'sha', 'workflow_path', 'workflow_ref', 'run_id', 'run_attempt']);
export const DEPLOYMENT_STACK_FIELDS = Object.freeze(
  ['name', 'region', 'producer_repository', 'producer_sha', 'template_sha256']);
export const DEPLOYMENT_INPUT_FIELDS = Object.freeze(['parameter', 'version', 'value_sha256']);
export const SERVICE_OBSERVED_FIELDS = Object.freeze(['service_sha', 'image_digest', 'ecs', 'endpoints']);
// A task definition revision is CloudFormation bookkeeping, not identity: the same
// image/environment/roles/command re-registers as a new revision and must not fail.
// The ARN is recorded as evidence only; equality is the image digest plus the
// normalized task-definition content hash below.
export const SERVICE_ECS_IDENTITY_FIELDS = Object.freeze(
  ['service_arn', 'task_definition_arn', 'task_definition_sha256', 'image_digest']);

export const SERVICE_DEPLOYMENT_RECORD_SCHEMA = Object.freeze({
  schema_version: 3,
  record_type: 'anywear_service_deployment',
  members: DEPLOYMENT_RECORD_MEMBERS,
  producer: DEPLOYMENT_PRODUCER_FIELDS,
  stack: DEPLOYMENT_STACK_FIELDS,
  input: DEPLOYMENT_INPUT_FIELDS,
  observed: SERVICE_OBSERVED_FIELDS,
  stacks: Object.freeze([Object.freeze({
    name: SERVICE_WORKLOAD_STACK.name,
    region: SERVICE_WORKLOAD_STACK.region,
  })]),
});

function validateServiceProducer(producer) {
  exact(producer, DEPLOYMENT_PRODUCER_FIELDS, 'deployment producer');
  if (producer.repository !== SERVICE_REPOSITORY) throw new Error('Unexpected deployment producer repository');
  if (!producer.workflow_path?.startsWith('.github/workflows/')
    || producer.workflow_ref !== `${producer.repository}/${producer.workflow_path}@refs/heads/main`) throw new Error('Unexpected deployment workflow');
  if (producer.workflow_path !== SERVICE_WORKLOAD_STACK.workflow_path) throw new Error('Unexpected deployment workflow path');
  matches(producer.sha, SHA, 'deployment producer SHA');
  integer(producer.run_id, 'deployment run');
  integer(producer.run_attempt, 'deployment attempt');
  return producer;
}

// A stack row may only name the record's own producer and the exact configured
// stack set; a stack produced by another repository is that repository's record.
function validateServiceStacks(rows) {
  const expected = SERVICE_DEPLOYMENT_RECORD_SCHEMA.stacks;
  if (!Array.isArray(rows) || rows.length !== expected.length) {
    throw new Error('Deployment record must list exactly its producer\'s stacks');
  }
  const names = new Set();
  for (const row of rows) {
    const configured = expected.find(stack => stack.name === row?.name);
    if (!configured || names.has(row.name) || row.region !== configured.region) {
      throw new Error('Invalid stack identity in deployment record');
    }
    exact(row, DEPLOYMENT_STACK_FIELDS, 'deployment stack');
    matches(row.template_sha256, HASH, 'deployed template hash');
    names.add(row.name);
  }
  return rows;
}

function validateProducerRows(record) {
  for (const row of record.stacks) {
    if (row.producer_repository !== record.producer.repository || row.producer_sha !== record.producer.sha) {
      throw new Error('Stack producer differs from the deployment producer');
    }
  }
}

function validateSchemaMember(record) {
  exact(record.schema, ['content_sha256'], 'stage contract schema');
  matches(record.schema.content_sha256, HASH, 'stage contract schema hash');
  if (record.schema.content_sha256 !== stageContractSchemaHash(record.inputs)) {
    throw new Error('Stage contract schema hash differs from the recorded inputs');
  }
}

// The release slice's observed tuple: its two ECS services, the deployed image
// digest/source and the public API endpoint.
function validateServiceObserved(observed) {
  exact(observed, SERVICE_OBSERVED_FIELDS, 'workload observed tuple');
  matches(observed.service_sha, SHA, 'observed Service');
  matches(observed.image_digest, DIGEST, 'observed image');
  exact(observed.ecs, ['api', 'worker'], 'ECS identities');
  for (const [purpose, identity] of Object.entries(observed.ecs)) {
    exact(identity, SERVICE_ECS_IDENTITY_FIELDS, `ECS ${purpose} identity`);
    matches(identity.service_arn, new RegExp(`^arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-${purpose}$`), `ECS ${purpose} service ARN`);
    // Evidence only. Re-registering the same task definition produces a new
    // revision number; identity is the content hash and the image digest.
    matches(identity.task_definition_arn, new RegExp(`^arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-${purpose}:[1-9][0-9]*$`), `ECS ${purpose} task definition ARN`);
    matches(identity.task_definition_sha256, HASH, `ECS ${purpose} task definition content hash`);
    matches(identity.image_digest, DIGEST, `ECS ${purpose} image digest`);
    if (identity.image_digest !== observed.image_digest) {
      throw new Error(`ECS ${purpose} image_digest differs from the deployed image`);
    }
  }
  exact(observed.endpoints, ['api'], 'endpoints');
  matches(observed.endpoints.api, /^https:\/\/[a-z0-9]+\.cloudfront\.net$/, 'CloudFront endpoint');
  return observed;
}

function validateServiceRecordBase(record) {
  exact(record, DEPLOYMENT_RECORD_MEMBERS, 'deployment record');
  if (record.schema_version !== SERVICE_DEPLOYMENT_RECORD_SCHEMA.schema_version
    || record.record_type !== SERVICE_DEPLOYMENT_RECORD_SCHEMA.record_type) {
    throw new Error(`Unknown ${SERVICE_DEPLOYMENT_RECORD_SCHEMA.record_type} schema; historical v2 is not a direct-verification input`);
  }
  validateStageInputs(record.inputs);
  validateSchemaMember(record);
  validateServiceStacks(record.stacks);
  validateProducerRows(record);
  return record;
}

/**
 * Validate one v3 `anywear_service_deployment` record.
 *
 * Pure: no AWS, network or filesystem access. The record lists exactly the
 * Service producer's stack (`AnyWearWorkloadStack-beta`), the stage-contract SSM
 * inputs the deploy read and the authenticated Workload observation.
 */
export function validateServiceDeploymentRecord(record) {
  validateServiceRecordBase(record);
  validateServiceProducer(record.producer);
  validateServiceObserved(record.observed);
  return record;
}

// The normalized task definition whose content hash identifies a deployed ECS
// service. It changes with image, environment, roles, command and sizing, never
// with the revision number alone.
export function stableTaskDefinition(definition) {
  if (!definition || typeof definition !== 'object') throw new Error('Task definition observation unavailable');
  const container = definition.containerDefinitions?.length === 1 ? definition.containerDefinitions[0] : undefined;
  if (!container || typeof container.image !== 'string' || !container.image || !Array.isArray(container.environment)) {
    throw new Error('Single-container task definition required');
  }
  const environment = container.environment.map(entry => {
    if (typeof entry?.name !== 'string' || typeof entry?.value !== 'string') throw new Error('Task definition environment unavailable');
    return { name: entry.name, value: entry.value };
  }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return { family: definition.family, taskRoleArn: definition.taskRoleArn, executionRoleArn: definition.executionRoleArn,
    networkMode: definition.networkMode, cpu: definition.cpu, memory: definition.memory,
    container: { name: container.name, image: container.image, command: container.command ?? [], environment } };
}

export function taskDefinitionContentHash(definition) {
  return contentHash(stableTaskDefinition(definition));
}

// ---------------------------------------------------------------------------
// Foundation service-role naming and identity
//
// The Foundation stack creates one GitHub OIDC deploy role and one
// CloudFormation execution role per service. The stage prefix is the Beta stage
// contract's stage; the service slug names the owning repository's service.

const GITHUB_OWNER = 'git-malu';
const GITHUB_OWNER_ID = 11473072;
const SERVICE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPOSITORY_NAME = /^[A-Za-z0-9._-]+$/;
const ENVIRONMENT = /^[a-z][a-z0-9-]*$/;

function requireServiceSlug(service) {
  if (typeof service !== 'string' || !SERVICE_SLUG.test(service)) throw new Error('Invalid service name');
  return service;
}

/** `serviceDeployRoleName('service')` -> `beta-service-deploy-role`. */
export function serviceDeployRoleName(service) {
  return `${STAGE_CONTRACT_STAGE}-${requireServiceSlug(service)}-deploy-role`;
}

/** `serviceDeployCfnRoleName('service')` -> `beta-service-deploy-cfn-role`. */
export function serviceDeployCfnRoleName(service) {
  return `${STAGE_CONTRACT_STAGE}-${requireServiceSlug(service)}-deploy-cfn-role`;
}

/**
 * The immutable GitHub OIDC subject for a service repository environment:
 * `repo:git-malu@11473072/<repository>@<repositoryId>:environment:<environment>`.
 *
 * `repository` is the repository name only (`AnyWear-Service`), not owner/name.
 */
export function serviceTrustSubject({ repository, repositoryId, environment } = {}) {
  if (typeof repository !== 'string' || !REPOSITORY_NAME.test(repository)) throw new Error('Invalid service repository');
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) throw new Error('Invalid service repository id');
  if (typeof environment !== 'string' || !ENVIRONMENT.test(environment)) throw new Error('Invalid service environment');
  return `repo:${GITHUB_OWNER}@${GITHUB_OWNER_ID}/${repository}@${repositoryId}:environment:${environment}`;
}
