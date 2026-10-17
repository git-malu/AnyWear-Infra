import { canonicalJson, contentHash, exact, matches, integer, SHA, HASH, DIGEST } from './json-contract.mjs';
import { configuredStacks } from './operation-stacks.mjs';

export const INFRA_REPOSITORY = 'git-malu/AnyWear-Infra';
export const SERVICE_REPOSITORY = 'git-malu/AnyWear-Service';
export const account = '650880818323';
export const region = 'ap-east-1';
const INFRA_WORKFLOWS = Object.freeze(['.github/workflows/runtime.yml', '.github/workflows/mutate.yml']);
// The Service release chain deploys the release slice. Its record is validated by
// the same generic v3 core but lists exactly the one stack it produces.
export const SERVICE_WORKLOAD_STACK = Object.freeze({ name: 'AnyWearWorkloadStack-beta', region: 'ap-east-1',
  workflow_path: '.github/workflows/service-artifacts.yml' });
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
//   anywear_infra_deployment   Infra: Foundation, the Beta stage base, Billing
//   anywear_service_deployment Service: AnyWearWorkloadStack-beta only
//
// A record may not list a stack its own producer did not produce, so forcing one
// producer's stacks into the other's record is a validation failure, not a merge.
export const DEPLOYMENT_RECORD_MEMBERS = Object.freeze(['schema_version', 'record_type', 'producer', 'stacks', 'inputs', 'observed', 'schema']);
export const DEPLOYMENT_PRODUCER_FIELDS = Object.freeze(['repository', 'sha', 'workflow_path', 'workflow_ref', 'run_id', 'run_attempt']);
export const DEPLOYMENT_STACK_FIELDS = Object.freeze(['name', 'region', 'producer_repository', 'producer_sha', 'template_sha256']);
export const DEPLOYMENT_INPUT_FIELDS = Object.freeze(['parameter', 'version', 'value_sha256']);
export const INFRA_OBSERVED_FIELDS = Object.freeze(['lambdas', 'queue_config_sha256', 'client_sha', 'endpoints']);
export const SERVICE_OBSERVED_FIELDS = Object.freeze(['service_sha', 'image_digest', 'ecs', 'endpoints']);
// A task definition revision is CloudFormation bookkeeping, not identity: the same
// image/environment/roles/command re-registers as a new revision and must not fail.
// The ARN is recorded as evidence only; equality is the image digest plus the
// normalized task-definition content hash below.
export const SERVICE_ECS_IDENTITY_FIELDS = Object.freeze(['service_arn', 'task_definition_arn', 'task_definition_sha256', 'image_digest']);

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

export const SERVICE_DEPLOYMENT_RECORD_SCHEMA = Object.freeze({
  schema_version: 3,
  record_type: 'anywear_service_deployment',
  members: DEPLOYMENT_RECORD_MEMBERS,
  producer: DEPLOYMENT_PRODUCER_FIELDS,
  stack: DEPLOYMENT_STACK_FIELDS,
  input: DEPLOYMENT_INPUT_FIELDS,
  observed: SERVICE_OBSERVED_FIELDS,
  stacks: Object.freeze([Object.freeze({ name: SERVICE_WORKLOAD_STACK.name, region: SERVICE_WORKLOAD_STACK.region })]),
});

// `inputs[]` is the stage-contract surface this record's run read from SSM, with
// each parameter's version and value hash. It may be empty: a producer that reads
// no stage-contract parameter records `[]` and the schema hash is the content hash
// of the empty list. Infra reads the 25 published stage-contract parameters during
// its authenticated observation (the stage base is their producer, and the read is
// what evidences the surface the release slice consumes); the Service record lists
// the same contract plus the four reused stage values it consumes at deploy time.
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

// The release slice's observed tuple: its two ECS services, the deployed image
// digest/source and the public API endpoint. Lambdas, queues and the Client belong
// to the stage base and are observed in the Infra record.
export function validateServiceObserved(observed) {
  exact(observed, SERVICE_OBSERVED_FIELDS, 'workload observed tuple');
  matches(observed.service_sha, SHA, 'observed Service'); matches(observed.image_digest, DIGEST, 'observed image');
  exact(observed.ecs, ['api', 'worker'], 'ECS identities');
  for (const [purpose, identity] of Object.entries(observed.ecs)) {
    exact(identity, SERVICE_ECS_IDENTITY_FIELDS, `ECS ${purpose} identity`);
    matches(identity.service_arn, new RegExp(`^arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-${purpose}$`), `ECS ${purpose} service ARN`);
    // Evidence only. Re-registering the same task definition produces a new
    // revision number; identity is the content hash and the image digest.
    matches(identity.task_definition_arn, new RegExp(`^arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-${purpose}:[1-9][0-9]*$`), `ECS ${purpose} task definition ARN`);
    matches(identity.task_definition_sha256, HASH, `ECS ${purpose} task definition content hash`);
    matches(identity.image_digest, DIGEST, `ECS ${purpose} image digest`);
    if (identity.image_digest !== observed.image_digest) throw new Error(`ECS ${purpose} image_digest differs from the deployed image`);
  }
  exact(observed.endpoints, ['api'], 'endpoints');
  matches(observed.endpoints.api, /^https:\/\/[a-z0-9]+\.cloudfront\.net$/, 'CloudFront endpoint');
  return observed;
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

export function validateServiceDeploymentRecord(record) {
  validateRecordBase(record, SERVICE_DEPLOYMENT_RECORD_SCHEMA);
  validateDeploymentProducer(record.producer, { repositories: [SERVICE_REPOSITORY], workflowPaths: [SERVICE_WORKLOAD_STACK.workflow_path] });
  validateServiceObserved(record.observed);
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
