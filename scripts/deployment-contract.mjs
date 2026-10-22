import {
  DEPLOYMENT_GATE_ALARM_STATES,
  DEPLOYMENT_GATE_COMPARISONS,
  DEPLOYMENT_GATE_DURATION_SECONDS,
  DEPLOYMENT_GATE_FIELDS,
  DEPLOYMENT_GATE_MAX_PROBES,
  DEPLOYMENT_GATE_PROBE_FIELDS,
  DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS,
  DEPLOYMENT_GATE_REQUEST_FLOOR,
  DEPLOYMENT_GATE_RESULTS,
  DEPLOYMENT_GATE_SIGNAL_FIELDS,
  DEPLOYMENT_GATE_SIGNAL_NAMES,
  DEPLOYMENT_GATE_STATES,
  DEPLOYMENT_GATE_THRESHOLDS,
  DEPLOYMENT_INPUT_FIELDS,
  DEPLOYMENT_PRODUCER_FIELDS,
  DEPLOYMENT_RECORD_MEMBERS,
  DEPLOYMENT_STACK_FIELDS,
  INFRA_REPOSITORY,
  SCHEMA_BOUNDARY_APPLIED_FIELDS,
  SCHEMA_BOUNDARY_ASSET_FIELDS,
  SCHEMA_BOUNDARY_COMPARISON_FIELDS,
  SCHEMA_BOUNDARY_READER_FIELDS,
  SCHEMA_BOUNDARY_READER_SOURCES,
  SCHEMA_BOUNDARY_RESULTS,
  SERVICE_DEPLOYMENT_RECORD_MEMBERS,
  SERVICE_DEPLOYMENT_RECORD_SCHEMA,
  SERVICE_ECS_IDENTITY_FIELDS,
  SERVICE_OBSERVED_FIELDS,
  SERVICE_REPOSITORY,
  SERVICE_RUNTIME_STACK,
  SERVICE_SCHEMA_BOUNDARY_FIELDS,
  deploymentAlarmName,
  deploymentAlarmNames,
  deploymentBakeName,
  runtimeStageFromStack,
  schemaBoundaryPrefixHash,
  stageContractSchemaHash,
  stableTaskDefinition,
  taskDefinitionContentHash,
  validateDeploymentGate,
  validateSchemaBoundary,
  validateServiceDeploymentRecord,
  validateServiceStacks,
  validateStageInputs,
} from '@git-malu/stage-contracts';
import { canonicalJson, exact, matches, integer, SHA, HASH } from './json-contract.mjs';
import { configuredStacks } from './operation-stacks.mjs';

// The Service record schema, its field lists, the stage-contract validators, the
// v6 bake-gate and schema-boundary constants/validators and the task-definition
// identity are the versioned package's exports. This module re-exports them and
// keeps the Infra-only record schema, producer/stack validation and observation
// helpers.
export {
  DEPLOYMENT_GATE_ALARM_STATES,
  DEPLOYMENT_GATE_COMPARISONS,
  DEPLOYMENT_GATE_DURATION_SECONDS,
  DEPLOYMENT_GATE_FIELDS,
  DEPLOYMENT_GATE_MAX_PROBES,
  DEPLOYMENT_GATE_PROBE_FIELDS,
  DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS,
  DEPLOYMENT_GATE_REQUEST_FLOOR,
  DEPLOYMENT_GATE_RESULTS,
  DEPLOYMENT_GATE_SIGNAL_FIELDS,
  DEPLOYMENT_GATE_SIGNAL_NAMES,
  DEPLOYMENT_GATE_STATES,
  DEPLOYMENT_GATE_THRESHOLDS,
  DEPLOYMENT_INPUT_FIELDS,
  DEPLOYMENT_PRODUCER_FIELDS,
  DEPLOYMENT_RECORD_MEMBERS,
  DEPLOYMENT_STACK_FIELDS,
  INFRA_REPOSITORY,
  SCHEMA_BOUNDARY_APPLIED_FIELDS,
  SCHEMA_BOUNDARY_ASSET_FIELDS,
  SCHEMA_BOUNDARY_COMPARISON_FIELDS,
  SCHEMA_BOUNDARY_READER_FIELDS,
  SCHEMA_BOUNDARY_READER_SOURCES,
  SCHEMA_BOUNDARY_RESULTS,
  SERVICE_DEPLOYMENT_RECORD_MEMBERS,
  SERVICE_DEPLOYMENT_RECORD_SCHEMA,
  SERVICE_ECS_IDENTITY_FIELDS,
  SERVICE_OBSERVED_FIELDS,
  SERVICE_REPOSITORY,
  SERVICE_RUNTIME_STACK,
  SERVICE_SCHEMA_BOUNDARY_FIELDS,
  deploymentAlarmName,
  deploymentAlarmNames,
  deploymentBakeName,
  runtimeStageFromStack,
  schemaBoundaryPrefixHash,
  stageContractSchemaHash,
  stableTaskDefinition,
  taskDefinitionContentHash,
  validateDeploymentGate,
  validateSchemaBoundary,
  validateServiceDeploymentRecord,
  validateServiceStacks,
  validateStageInputs,
};

export const account = '650880818323';
export const region = 'ap-east-1';
const INFRA_WORKFLOWS = Object.freeze(['.github/workflows/runtime.yml', '.github/workflows/mutate.yml']);
const equal = (actual, expected, label) => {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} differs from reviewed deployment`);
};

// v3 records the deployment, not a cross-repository release selection:
//
//   producer  the repository/commit/workflow that produced this record
//   stacks    every stack this record's producer owns, each with its producer
//             identity and the sha256 of its deployed Original template body
//   inputs    the stage-contract SSM parameters the deployment consumed:
//             name, parameter version and the sha256 of the value
//   observed  the authenticated observation that producer made
//   schema    a content hash of the consumed stage-contract schema surface
//             (parameter names + versions). It is a content identity, never a pin
//             to another repository's release. The database/applied schema
//             identity moved to the Service release chain with the release slice.
//
// `producer` is the record producer; `stacks[].producer_*` names the repository
// and commit that produced each listed stack. `template_sha256` is the content
// identity of the deployed template and remains the hard evidence for each row.
// Two producers share this core and never the stack lists:
//
//   anywear_infra_deployment   Infra: Foundation, the Beta Base stack, Billing
//   anywear_service_deployment Service: AnyWearRuntimeStack-beta only
//
// A record may not list a stack its own producer did not produce, so forcing one
// producer's stacks into the other's record is a validation failure, not a merge.
export const INFRA_OBSERVED_FIELDS = Object.freeze(['lambdas', 'queue_config_sha256', 'client_sha', 'endpoints']);

export const DEPLOYMENT_RECORD_SCHEMA = Object.freeze({
  schema_version: 3,
  record_type: 'anywear_infra_deployment',
  members: DEPLOYMENT_RECORD_MEMBERS,
  producer: DEPLOYMENT_PRODUCER_FIELDS,
  stack: DEPLOYMENT_STACK_FIELDS,
  input: DEPLOYMENT_INPUT_FIELDS,
  observed: INFRA_OBSERVED_FIELDS,
  stacks: Object.freeze(configuredStacks.map(stack => Object.freeze({ name: stack.stack_name, region: stack.region }))),
});

export function validateDeploymentProducer(producer, { repositories = [INFRA_REPOSITORY, SERVICE_REPOSITORY], workflowPaths } = {}) {
  exact(producer, DEPLOYMENT_PRODUCER_FIELDS, 'deployment producer');
  if (!repositories.includes(producer.repository)) throw new Error('Unexpected deployment producer repository');
  if (!producer.workflow_path?.startsWith('.github/workflows/')
    || producer.workflow_ref !== `${producer.repository}/${producer.workflow_path}@refs/heads/main`) throw new Error('Unexpected deployment workflow');
  if (workflowPaths && !workflowPaths.includes(producer.workflow_path)) throw new Error('Unexpected deployment workflow path');
  matches(producer.sha, SHA, 'deployment producer SHA');
  integer(producer.run_id, 'deployment run'); integer(producer.run_attempt, 'deployment attempt');
  return producer;
}

// Stack rows are validated against the producer's own expected stack set. A row
// may only name the record's producer: a stack produced by another repository is
// that repository's record, never a row here.
export function validateDeploymentStacks(rows, expected) {
  if (!Array.isArray(rows) || rows.length !== expected.length) throw new Error('Deployment record must list exactly its producer\'s stacks');
  const names = new Set();
  for (const row of rows) {
    const configured = expected.find(stack => stack.name === row?.name);
    if (!configured || names.has(row.name) || row.region !== configured.region) throw new Error('Invalid stack identity in deployment record');
    exact(row, DEPLOYMENT_STACK_FIELDS, 'deployment stack');
    matches(row.template_sha256, HASH, 'deployed template hash');
    names.add(row.name);
  }
  return rows;
}

export function validateProducerRows(record) {
  for (const row of record.stacks) {
    if (row.producer_repository !== record.producer.repository || row.producer_sha !== record.producer.sha) {
      throw new Error('Stack producer differs from the deployment producer');
    }
  }
}

function validateSchemaMember(record) {
  exact(record.schema, ['content_sha256'], 'stage contract schema');
  matches(record.schema.content_sha256, HASH, 'stage contract schema hash');
  if (record.schema.content_sha256 !== stageContractSchemaHash(record.inputs)) throw new Error('Stage contract schema hash differs from the recorded inputs');
}

export function validateInfraObserved(observed) {
  exact(observed, INFRA_OBSERVED_FIELDS, 'observed tuple');
  exact(observed.lambdas, ['pre-sign-up', 'post-confirmation'], 'Lambdas');
  for (const item of Object.values(observed.lambdas)) {
    exact(item, ['code_sha256', 'configuration_sha256'], 'Lambda identity');
    matches(item.code_sha256, /^[A-Za-z0-9+/]{43}=$/, 'Lambda CodeSha256'); matches(item.configuration_sha256, HASH, 'Lambda stable config');
  }
  matches(observed.queue_config_sha256, HASH, 'queue configuration hash');
  matches(observed.client_sha, SHA, 'observed Client');
  exact(observed.endpoints, ['client'], 'endpoints');
  matches(observed.endpoints.client, /^https:\/\/[a-z0-9]+\.cloudfront\.net$/, 'CloudFront endpoint');
  return observed;
}

// Authenticated observation body of the stage base. It covers exactly the stacks
// and resources Infra still produces.
export function validateSnapshot(snapshot) {
  exact(snapshot, ['stacks', 'observed', 'schema'], 'observation');
  validateDeploymentStacks(snapshot.stacks, DEPLOYMENT_RECORD_SCHEMA.stacks);
  exact(snapshot.schema, ['content_sha256'], 'stage contract schema');
  matches(snapshot.schema.content_sha256, HASH, 'stage contract schema hash');
  validateInfraObserved(snapshot.observed);
  return snapshot;
}

function validateRecordBase(record, schema) {
  exact(record, DEPLOYMENT_RECORD_MEMBERS, 'deployment record');
  if (record.schema_version !== schema.schema_version || record.record_type !== schema.record_type) {
    throw new Error(`Unknown ${schema.record_type} schema; historical v2 is not a direct-verification input`);
  }
  validateStageInputs(record.inputs);
  validateSchemaMember(record);
  validateDeploymentStacks(record.stacks, schema.stacks);
  validateProducerRows(record);
  return record;
}

export function validateInfraDeploymentRecord(record) {
  validateRecordBase(record, DEPLOYMENT_RECORD_SCHEMA);
  validateDeploymentProducer(record.producer, { repositories: [INFRA_REPOSITORY], workflowPaths: INFRA_WORKFLOWS });
  validateInfraObserved(record.observed);
  return record;
}

// A mutating Infra operation publishes the same authenticated observation under
// the family observation record type; it carries no deployment record type so it
// can never be mistaken for the accepted `observe` producer.
export function validateObservationRecord(record) {
  exact(record, ['schema_version', 'record_type', 'producer', 'stacks', 'inputs', 'observed', 'schema'], 'observation record');
  if (record.schema_version !== 3 || record.record_type !== 'anywear_infra_family_observation') throw new Error('Unknown family observation schema');
  validateDeploymentProducer(record.producer, { repositories: [INFRA_REPOSITORY], workflowPaths: INFRA_WORKFLOWS });
  validateStageInputs(record.inputs); validateSchemaMember(record);
  validateDeploymentStacks(record.stacks, DEPLOYMENT_RECORD_SCHEMA.stacks);
  validateProducerRows(record);
  validateInfraObserved(record.observed);
  return record;
}

// Dispatches on the record type, so a reader accepts either producer's record but
// never a mixed one.
export function validateDeploymentRecord(record) {
  if (record?.record_type === SERVICE_DEPLOYMENT_RECORD_SCHEMA.record_type) return validateServiceDeploymentRecord(record);
  return validateInfraDeploymentRecord(record);
}

export function assertObservedMatchesDeployment(record, body) {
  validateInfraDeploymentRecord(record);
  validateSnapshot({ stacks: body.stacks, observed: body.observed, schema: body.schema });
  equal(body, { stacks: record.stacks, inputs: record.inputs, observed: record.observed, schema: record.schema }, 'Authenticated observation');
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
