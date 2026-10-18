// @git-malu/stage-contracts
//
// The versioned, dependency-free source of the AnyWear Beta stage contract:
// the SSM parameter surface the stage base publishes, the stack identities and
// Foundation service-role naming, and the pure v4 `anywear_service_deployment`
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
// schema and validators below are the generic v4 Service producer contract.
export const SERVICE_WORKLOAD_STACK = Object.freeze({
  name: workloadStackName(STAGE_CONTRACT_STAGE),
  region: 'ap-east-1',
  workflow_path: '.github/workflows/service-artifacts.yml',
});

// ---------------------------------------------------------------------------
// v3 deployment record core (v4 Service record adds the bake gate)
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
// writer. Infra's `anywear_infra_deployment` keeps the seven-member core below
// and never produces a gate.

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

// ---------------------------------------------------------------------------
// Deployment bake gate (Issue #162)
//
// A Service deployment records success only after a bounded 600-second bake read
// the six named signals live from the deployed state. The gate block is a
// required top-level member of the v4 `anywear_service_deployment` record; the
// Infra `anywear_infra_deployment` v3 record keeps the seven-member core and is
// never forced to produce one.
//
// The table below is one stage-free threshold set: `<stage>` appears only in
// resource and alarm names, never in a threshold, so Beta and Production share
// exactly the same pass criterion. A signal is `not-breaching` only when its
// recorded value is inside its threshold and every read produced enough data;
// missing, delayed or short data is `insufficient` and fails the gate exactly
// like `breaching`.

export const DEPLOYMENT_GATE_NAME_SUFFIX = 'anywear-deployment-bake';
export const DEPLOYMENT_GATE_DURATION_SECONDS = 600;
export const DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS = 15;
export const DEPLOYMENT_GATE_REQUEST_FLOOR = 30;
export const DEPLOYMENT_GATE_MAX_PROBES = 40;
export const DEPLOYMENT_GATE_RESULTS = Object.freeze(['passed', 'failed']);
export const DEPLOYMENT_GATE_STATES = Object.freeze(['not-breaching', 'breaching', 'insufficient']);
export const DEPLOYMENT_GATE_ALARM_STATES = Object.freeze(['OK', 'ALARM', 'INSUFFICIENT_DATA']);
export const DEPLOYMENT_GATE_FIELDS = Object.freeze([
  'name', 'result', 'started_at', 'ended_at', 'duration_seconds', 'service_sha', 'image_digest', 'probe', 'signals']);
export const DEPLOYMENT_GATE_PROBE_FIELDS = Object.freeze(['interval_seconds', 'probes_sent', 'request_floor']);
export const DEPLOYMENT_GATE_SIGNAL_FIELDS = Object.freeze([
  'name', 'state', 'value', 'threshold', 'comparison', 'alarms', 'reads', 'exceptions']);
export const DEPLOYMENT_GATE_SIGNAL_NAMES = Object.freeze([
  'alb_5xx_rate',
  'alb_p95_latency',
  'ecs_running_not_desired',
  'sqs_oldest_message_age',
  'sqs_dlq_depth',
  'outbox_oldest_age',
]);

// One stage-free table. Changing a threshold is a reviewed source change, not a
// deployment context or environment switch.
export const DEPLOYMENT_GATE_THRESHOLDS = Object.freeze({
  alb_5xx_rate: Object.freeze({ max_5xx: 0, min_requests: DEPLOYMENT_GATE_REQUEST_FLOOR }),
  alb_p95_latency: Object.freeze({ max_milliseconds: 5000 }),
  ecs_running_not_desired: Object.freeze({ max_gap_seconds: 120 }),
  sqs_oldest_message_age: Object.freeze({ max_seconds: 300 }),
  sqs_dlq_depth: Object.freeze({ max_depth: 0 }),
  outbox_oldest_age: Object.freeze({ max_age_milliseconds: 300000 }),
});

const DEPLOYMENT_GATE_SIGNAL_DEFINITIONS = Object.freeze({
  alb_5xx_rate: Object.freeze({
    value: Object.freeze(['target_5xx', 'elb_5xx', 'request_count']),
    threshold: Object.freeze(['max_5xx', 'min_requests']),
    comparison: 'sum(target_5xx, elb_5xx) > max_5xx; request_count < min_requests is insufficient',
  }),
  alb_p95_latency: Object.freeze({
    value: Object.freeze(['p95_milliseconds']),
    threshold: Object.freeze(['max_milliseconds']),
    comparison: 'p95_milliseconds > max_milliseconds',
  }),
  ecs_running_not_desired: Object.freeze({
    value: Object.freeze(['longest_gap_seconds', 'max_sample_gap_seconds', 'samples', 'services']),
    threshold: Object.freeze(['max_gap_seconds']),
    comparison: 'longest_gap_seconds >= max_gap_seconds; a non-single or non-COMPLETED deployment is breaching',
  }),
  sqs_oldest_message_age: Object.freeze({
    value: Object.freeze(['vto_seconds', 'auto_tagging_seconds']),
    threshold: Object.freeze(['max_seconds']),
    comparison: 'max(vto_seconds, auto_tagging_seconds) > max_seconds',
  }),
  sqs_dlq_depth: Object.freeze({
    value: Object.freeze(['vto_depth', 'auto_tagging_depth']),
    threshold: Object.freeze(['max_depth']),
    comparison: 'vto_depth + auto_tagging_depth > max_depth',
  }),
  outbox_oldest_age: Object.freeze({
    value: Object.freeze(['oldest_age_milliseconds', 'backlog', 'lines_observed']),
    threshold: Object.freeze(['max_age_milliseconds']),
    comparison: 'oldest_age_milliseconds > max_age_milliseconds; backlog > 0 with a null age is breaching',
  }),
});

export const DEPLOYMENT_GATE_COMPARISONS = Object.freeze(Object.fromEntries(
  Object.entries(DEPLOYMENT_GATE_SIGNAL_DEFINITIONS).map(([name, definition]) => [name, definition.comparison])));

const GATE_STAGE = /^[a-z][a-z0-9-]*$/;

function requireStage(stage) {
  if (typeof stage !== 'string' || !GATE_STAGE.test(stage)) throw new Error('Invalid deployment stage');
  return stage;
}

/** `deploymentBakeName('beta')` -> `beta-anywear-deployment-bake`. */
export function deploymentBakeName(stage) {
  return `${requireStage(stage)}-${DEPLOYMENT_GATE_NAME_SUFFIX}`;
}

/** The stage encoded in `AnyWearWorkloadStack-<stage>`. */
export function workloadStageFromStack(stackName) {
  const match = typeof stackName === 'string' ? /^AnyWearWorkloadStack-([a-z][a-z0-9-]*)$/.exec(stackName) : null;
  if (!match) throw new Error('Invalid Workload stack identity');
  return match[1];
}

// The deployed alarm entities each signal records. Names are the only place the
// stage appears; the threshold table above has no stage key.
const DEPLOYMENT_GATE_ALARM_SUFFIXES = Object.freeze({
  alb_5xx_rate: Object.freeze(['alb-5xx']),
  alb_p95_latency: Object.freeze(['api-p95-latency']),
  ecs_running_not_desired: Object.freeze(['ecs-running-not-desired']),
  sqs_oldest_message_age: Object.freeze(['vto-oldest-message', 'auto-tagging-oldest-message']),
  sqs_dlq_depth: Object.freeze(['vto-dlq-not-empty', 'auto-tagging-dlq-not-empty']),
  outbox_oldest_age: Object.freeze(['outbox-oldest-age']),
});

/** The deployed alarm names for one signal, for example `beta-anywear-alb-5xx`. */
export function deploymentAlarmName(stage, signalName) {
  requireStage(stage);
  const suffixes = DEPLOYMENT_GATE_ALARM_SUFFIXES[signalName];
  if (!suffixes) throw new Error(`Unknown deployment gate signal ${signalName}`);
  return suffixes.map((suffix) => `${stage}-anywear-${suffix}`);
}

/** The six signals' deployed alarm names, keyed by signal name. */
export function deploymentAlarmNames(stage) {
  return Object.freeze(Object.fromEntries(DEPLOYMENT_GATE_SIGNAL_NAMES.map((name) => [
    name, Object.freeze(deploymentAlarmName(stage, name))])));
}

/** The stage-base queues the bake reads, keyed by purpose. */
export function deploymentQueueNames(stage) {
  requireStage(stage);
  return Object.freeze({
    vto: `${stage}-anywear-vto`,
    vto_dlq: `${stage}-anywear-vto-dlq`,
    auto_tagging: `${stage}-anywear-auto-tagging`,
    auto_tagging_dlq: `${stage}-anywear-auto-tagging-dlq`,
  });
}

const count = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`);
  return value;
};
const nonNegative = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}`);
  return value;
};
const sameValue = (actual, expected, label) => {
  if (contentHash(actual) !== contentHash(expected)) throw new Error(`Invalid ${label}`);
  return actual;
};

function validateCloudWatchRead(read, stage, expected) {
  exact(read, ['source', 'namespace', 'metric_name', 'dimensions', 'statistic', 'period_seconds', 'datapoints'],
    'deployment gate CloudWatch read');
  if (read.source !== 'cloudwatch' || read.namespace !== 'AWS/ApplicationELB') {
    throw new Error('Invalid deployment gate CloudWatch read identity');
  }
  if (read.metric_name !== expected.metric_name || read.statistic !== expected.statistic
    || read.period_seconds !== expected.period_seconds || read.datapoints !== expected.datapoints) {
    throw new Error(`Invalid deployment gate ${expected.metric_name} read`);
  }
  exact(read.dimensions, ['LoadBalancer'], 'deployment gate read dimensions');
  matches(read.dimensions.LoadBalancer,
    new RegExp(`^app/${stage}-anywear-api/[a-z0-9]+$`), 'deployment gate load balancer dimension');
  return read;
}

function validateSignalReads(name, reads, stage) {
  if (!Array.isArray(reads)) throw new Error(`Invalid ${name} reads`);
  switch (name) {
    case 'alb_5xx_rate': {
      if (reads.length !== 3) throw new Error('Invalid alb_5xx_rate reads');
      validateCloudWatchRead(reads[0], stage, { metric_name: 'HTTPCode_Target_5XX_Count', statistic: 'Sum', period_seconds: 60, datapoints: 10 });
      validateCloudWatchRead(reads[1], stage, { metric_name: 'HTTPCode_ELB_5XX_Count', statistic: 'Sum', period_seconds: 60, datapoints: 10 });
      validateCloudWatchRead(reads[2], stage, { metric_name: 'RequestCount', statistic: 'Sum', period_seconds: 60, datapoints: 10 });
      return reads;
    }
    case 'alb_p95_latency':
      if (reads.length !== 1) throw new Error('Invalid alb_p95_latency reads');
      validateCloudWatchRead(reads[0], stage, { metric_name: 'TargetResponseTime', statistic: 'p95', period_seconds: 600, datapoints: 1 });
      return reads;
    case 'ecs_running_not_desired': {
      if (reads.length !== 1) throw new Error('Invalid ecs_running_not_desired reads');
      const read = reads[0];
      exact(read, ['source', 'cluster', 'services', 'samples'], 'deployment gate ECS read');
      if (read.source !== 'ecs' || read.cluster !== `${stage}-anywear`) {
        throw new Error('Invalid deployment gate ECS read identity');
      }
      sameValue(read.services, [`${stage}-anywear-api`, `${stage}-anywear-worker`], 'deployment gate ECS read services');
      count(read.samples, 'deployment gate ECS read samples');
      if (read.samples < 15) throw new Error('Insufficient deployment gate ECS samples');
      return reads;
    }
    case 'sqs_oldest_message_age':
    case 'sqs_dlq_depth': {
      if (reads.length !== 2) throw new Error(`Invalid ${name} reads`);
      const dlq = name === 'sqs_dlq_depth';
      const queues = deploymentQueueNames(stage);
      const expectedQueues = dlq
        ? [queues.vto_dlq, queues.auto_tagging_dlq]
        : [queues.vto, queues.auto_tagging];
      const attribute = dlq ? 'ApproximateNumberOfMessages' : 'ApproximateAgeOfOldestMessage';
      for (const [index, read] of reads.entries()) {
        exact(read, ['source', 'queue_name', 'attribute', 'samples'], 'deployment gate SQS read');
        if (read.source !== 'sqs' || read.queue_name !== expectedQueues[index] || read.attribute !== attribute) {
          throw new Error(`Invalid deployment gate ${name} read`);
        }
        count(read.samples, 'deployment gate SQS read samples');
        if (read.samples < 15) throw new Error('Insufficient deployment gate SQS samples');
      }
      return reads;
    }
    case 'outbox_oldest_age': {
      if (reads.length !== 1) throw new Error('Invalid outbox_oldest_age reads');
      const read = reads[0];
      exact(read, ['source', 'log_group', 'filter_pattern', 'samples'], 'deployment gate logs read');
      if (read.source !== 'logs' || read.log_group !== `/anywear/${stage}/worker`
        || read.filter_pattern !== '"Durable task outbox metrics"') {
        throw new Error('Invalid deployment gate logs read identity');
      }
      count(read.samples, 'deployment gate logs read samples');
      if (read.samples < 5) throw new Error('Insufficient deployment gate outbox log samples');
      return reads;
    }
    default:
      throw new Error(`Unknown deployment gate signal ${name}`);
  }
}

// The per-signal predicate is the record's own self-consistency rule: a signal
// that claims `not-breaching` must actually be inside its threshold.
function signalBreaches(name, value) {
  const threshold = DEPLOYMENT_GATE_THRESHOLDS[name];
  switch (name) {
    case 'alb_5xx_rate':
      return value.target_5xx + value.elb_5xx > threshold.max_5xx;
    case 'alb_p95_latency':
      return value.p95_milliseconds > threshold.max_milliseconds;
    case 'ecs_running_not_desired':
      return value.longest_gap_seconds >= threshold.max_gap_seconds
        || Object.values(value.services).some((service) => (
          service.deployment_count !== 1 || service.rollout_state !== 'COMPLETED'));
    case 'sqs_oldest_message_age':
      return Math.max(value.vto_seconds, value.auto_tagging_seconds) > threshold.max_seconds;
    case 'sqs_dlq_depth':
      return value.vto_depth + value.auto_tagging_depth > threshold.max_depth;
    case 'outbox_oldest_age':
      return (value.oldest_age_milliseconds !== null && value.oldest_age_milliseconds > threshold.max_age_milliseconds)
        || (value.oldest_age_milliseconds === null && value.backlog > 0);
    default:
      throw new Error(`Unknown deployment gate signal ${name}`);
  }
}

function validateSignalValue(name, value) {
  const definition = DEPLOYMENT_GATE_SIGNAL_DEFINITIONS[name];
  if (!definition) throw new Error(`Unknown deployment gate signal ${name}`);
  exact(value, definition.value, `deployment gate ${name} value`);
  switch (name) {
    case 'alb_5xx_rate':
      count(value.target_5xx, 'target 5xx count');
      count(value.elb_5xx, 'ELB 5xx count');
      count(value.request_count, 'request count');
      if (value.request_count < DEPLOYMENT_GATE_REQUEST_FLOOR) throw new Error('Insufficient deployment gate requests');
      break;
    case 'alb_p95_latency':
      nonNegative(value.p95_milliseconds, 'p95 latency');
      break;
    case 'ecs_running_not_desired':
      nonNegative(value.longest_gap_seconds, 'longest running/desired gap');
      nonNegative(value.max_sample_gap_seconds, 'maximum ECS sample gap');
      if (value.max_sample_gap_seconds > DEPLOYMENT_GATE_THRESHOLDS.ecs_running_not_desired.max_gap_seconds) {
        throw new Error('Insufficient deployment gate ECS sample cadence');
      }
      count(value.samples, 'ECS samples');
      if (value.samples < 15) throw new Error('Insufficient deployment gate ECS samples');
      exact(value.services, ['api', 'worker'], 'deployment gate ECS services');
      for (const [purpose, service] of Object.entries(value.services)) {
        exact(service, ['running_count', 'desired_count', 'deployment_count', 'rollout_state'],
          `deployment gate ${purpose} service`);
        count(service.running_count, `${purpose} running count`);
        count(service.desired_count, `${purpose} desired count`);
        count(service.deployment_count, `${purpose} deployment count`);
        matches(service.rollout_state, /^[A-Z][A-Z_]*$/, `${purpose} rollout state`);
      }
      break;
    case 'sqs_oldest_message_age':
      nonNegative(value.vto_seconds, 'VTO oldest message age');
      nonNegative(value.auto_tagging_seconds, 'auto-tagging oldest message age');
      break;
    case 'sqs_dlq_depth':
      count(value.vto_depth, 'VTO DLQ depth');
      count(value.auto_tagging_depth, 'auto-tagging DLQ depth');
      break;
    case 'outbox_oldest_age':
      if (value.oldest_age_milliseconds !== null) nonNegative(value.oldest_age_milliseconds, 'outbox oldest age');
      count(value.backlog, 'outbox backlog');
      count(value.lines_observed, 'outbox log lines');
      if (value.lines_observed < 5) throw new Error('Insufficient deployment gate outbox log samples');
      break;
    default:
      throw new Error(`Unknown deployment gate signal ${name}`);
  }
  if (signalBreaches(name, value)) throw new Error(`Deployment gate signal ${name} is breaching`);
  return value;
}

function validateGateSignal(signal, expectedName, stage) {
  exact(signal, DEPLOYMENT_GATE_SIGNAL_FIELDS, `deployment gate signal ${expectedName}`);
  if (signal.name !== expectedName) throw new Error('Deployment gate signals are not in fixed order');
  if (!DEPLOYMENT_GATE_STATES.includes(signal.state)) throw new Error('Invalid deployment gate signal state');
  if (signal.state !== 'not-breaching') throw new Error(`Deployment gate signal ${expectedName} is ${signal.state}`);
  validateSignalValue(expectedName, signal.value);
  sameValue(signal.threshold, DEPLOYMENT_GATE_THRESHOLDS[expectedName], `deployment gate ${expectedName} threshold`);
  if (signal.comparison !== DEPLOYMENT_GATE_SIGNAL_DEFINITIONS[expectedName].comparison) {
    throw new Error(`Invalid deployment gate ${expectedName} comparison`);
  }
  const expectedAlarms = deploymentAlarmName(stage, expectedName);
  if (!Array.isArray(signal.alarms) || signal.alarms.length !== expectedAlarms.length) {
    throw new Error(`Invalid deployment gate ${expectedName} alarms`);
  }
  for (const [index, alarm] of signal.alarms.entries()) {
    exact(alarm, ['name', 'state'], `deployment gate ${expectedName} alarm`);
    if (alarm.name !== expectedAlarms[index]) throw new Error(`Invalid deployment gate ${expectedName} alarm name`);
    if (!DEPLOYMENT_GATE_ALARM_STATES.includes(alarm.state)) throw new Error('Invalid deployment gate alarm state');
  }
  validateSignalReads(expectedName, signal.reads, stage);
  if (!Array.isArray(signal.exceptions) || signal.exceptions.length > 4) {
    throw new Error(`Invalid deployment gate ${expectedName} exceptions`);
  }
  for (const exception of signal.exceptions) {
    if (typeof exception !== 'string' || exception.length < 1 || exception.length > 500) {
      throw new Error(`Invalid deployment gate ${expectedName} exception`);
    }
  }
  return signal;
}

/**
 * Validate one passed deployment gate block for `stage`.
 *
 * The gate is the v4 record's evidence that a 600-second bake read all six named
 * signals live. Every signal must be `not-breaching`, carry its fixed threshold
 * and comparison, record the deployed alarm names/observed states, its exact
 * read identity and at least the minimum data points.
 */
export function validateDeploymentGate(gate, stage) {
  requireStage(stage);
  exact(gate, DEPLOYMENT_GATE_FIELDS, 'deployment gate');
  if (gate.name !== deploymentBakeName(stage)) throw new Error('Invalid deployment gate name');
  if (gate.result !== 'passed') throw new Error('Deployment gate did not pass');
  matches(gate.started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, 'deployment gate start');
  matches(gate.ended_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, 'deployment gate end');
  const started = Date.parse(gate.started_at);
  const ended = Date.parse(gate.ended_at);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended - started !== DEPLOYMENT_GATE_DURATION_SECONDS * 1000) {
    throw new Error('Deployment gate window is not exactly 600 seconds');
  }
  if (gate.duration_seconds !== DEPLOYMENT_GATE_DURATION_SECONDS) throw new Error('Invalid deployment gate duration');
  matches(gate.service_sha, SHA, 'deployment gate Service');
  matches(gate.image_digest, DIGEST, 'deployment gate image');
  exact(gate.probe, DEPLOYMENT_GATE_PROBE_FIELDS, 'deployment gate probe');
  if (gate.probe.interval_seconds !== DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS
    || gate.probe.request_floor !== DEPLOYMENT_GATE_REQUEST_FLOOR) {
    throw new Error('Invalid deployment gate probe budget');
  }
  count(gate.probe.probes_sent, 'deployment gate probes');
  if (gate.probe.probes_sent < DEPLOYMENT_GATE_REQUEST_FLOOR
    || gate.probe.probes_sent > DEPLOYMENT_GATE_MAX_PROBES) {
    throw new Error('Insufficient deployment gate probes');
  }
  if (!Array.isArray(gate.signals) || gate.signals.length !== DEPLOYMENT_GATE_SIGNAL_NAMES.length) {
    throw new Error('Deployment gate must record exactly six signals');
  }
  for (const [index, signal] of gate.signals.entries()) {
    validateGateSignal(signal, DEPLOYMENT_GATE_SIGNAL_NAMES[index], stage);
  }
  return gate;
}

export const SERVICE_DEPLOYMENT_RECORD_MEMBERS = Object.freeze([...DEPLOYMENT_RECORD_MEMBERS, 'gate']);

export const SERVICE_DEPLOYMENT_RECORD_SCHEMA = Object.freeze({
  schema_version: 4,
  record_type: 'anywear_service_deployment',
  members: SERVICE_DEPLOYMENT_RECORD_MEMBERS,
  producer: DEPLOYMENT_PRODUCER_FIELDS,
  stack: DEPLOYMENT_STACK_FIELDS,
  input: DEPLOYMENT_INPUT_FIELDS,
  observed: SERVICE_OBSERVED_FIELDS,
  gate: DEPLOYMENT_GATE_FIELDS,
  signal: DEPLOYMENT_GATE_SIGNAL_FIELDS,
  signals: DEPLOYMENT_GATE_SIGNAL_NAMES,
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
  exact(record, SERVICE_DEPLOYMENT_RECORD_MEMBERS, 'deployment record');
  if (record.schema_version !== SERVICE_DEPLOYMENT_RECORD_SCHEMA.schema_version
    || record.record_type !== SERVICE_DEPLOYMENT_RECORD_SCHEMA.record_type) {
    throw new Error(`Unknown ${SERVICE_DEPLOYMENT_RECORD_SCHEMA.record_type} schema; historical records are not direct-verification inputs`);
  }
  validateStageInputs(record.inputs);
  validateSchemaMember(record);
  validateServiceStacks(record.stacks);
  validateProducerRows(record);
  return record;
}

/**
 * Validate one v4 `anywear_service_deployment` record.
 *
 * Pure: no AWS, network or filesystem access. The record lists exactly the
 * Service producer's stack (`AnyWearWorkloadStack-beta`), the stage-contract SSM
 * inputs the deploy read, the authenticated Workload observation, and the passed
 * 600-second six-signal bake gate bound to the same `service_sha`/`image_digest`.
 */
export function validateServiceDeploymentRecord(record) {
  validateServiceRecordBase(record);
  validateServiceProducer(record.producer);
  validateServiceObserved(record.observed);
  const stage = workloadStageFromStack(record.stacks[0].name);
  validateDeploymentGate(record.gate, stage);
  // The gate is evidence for this deployment only: a gate block from another
  // run cannot be reused for a different observed tuple.
  if (record.gate.service_sha !== record.observed.service_sha) {
    throw new Error('Deployment gate Service differs from the observed Service');
  }
  if (record.gate.image_digest !== record.observed.image_digest) {
    throw new Error('Deployment gate image differs from the observed image');
  }
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
