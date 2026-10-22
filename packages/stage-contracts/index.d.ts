// Type declarations for @git-malu/stage-contracts.
//
// The package is plain ESM JavaScript; these declarations are the consumer-facing
// contract. The Service deployment record is v6, produced by AnyWear-Infra's
// `mutate.yml` `deploy-runtime` operation (the v3 core plus the required
// 600-second bake gate and the admitted `schema_boundary` comparison); Infra's
// `anywear_infra_deployment` stays v3 and never produces a gate or a boundary. No
// build step and no runtime dependencies.

/** The CloudFormation value kind a stage parameter needs. */
export type StageInputKind = 'String' | 'List';

/** One typed stage-base parameter definition. */
export interface StageParameter {
  /** Short parameter suffix, for example `vpc_id`. */
  readonly name: string;
  /** The `CfnParameter` value kind: `String` or `List`. */
  readonly kind: StageInputKind;
  /** Absolute published SSM name, for example `/anywear/beta/vpc_id`. */
  readonly parameter: string;
}

/** The stage the contract names apply to. */
export declare const STAGE_CONTRACT_STAGE: 'beta';

/** The 35 `/anywear/beta/...` names published in every Beta identity phase. */
export declare const STAGE_CONTRACT_PARAMETERS: readonly string[];

/** The one name published only while the identity phase creates the cleanup task role. */
export declare const STAGE_CONTRACT_CONDITIONAL_PARAMETERS: readonly string[];

/** All 36 names a deployment may read: the unconditional 35 plus the conditional one. */
export declare const STAGE_CONTRACT_READ_PARAMETERS: readonly string[];

/**
 * The typed stage-parameter definitions, sorted by absolute SSM name. Includes
 * the conditional `cleanup_task_role_arn`; filter with
 * `STAGE_CONTRACT_CONDITIONAL_PARAMETERS` for a legacy identity phase.
 */
export declare function stageParameters(): readonly StageParameter[];

/** One recorded stage-contract input: parameter name, SSM version and value hash. */
export interface StageInputRow {
  readonly parameter: string;
  readonly version: string;
  readonly value_sha256: string;
}

/** Validate the sorted, unique `inputs[]` rows of a v3 deployment record. */
export declare function validateStageInputs<T extends readonly StageInputRow[]>(rows: T): T;

/** The schema content hash derived from the recorded inputs. */
export declare function stageContractSchemaHash(rows: readonly StageInputRow[]): string;

/** The repository that owns the shared infrastructure, Foundation and stage base. */
export declare const INFRA_REPOSITORY: 'git-malu/AnyWear-Infra';

/** The repository that owns the release source; since #195 it produces no record. */
export declare const SERVICE_REPOSITORY: 'git-malu/AnyWear-Service';

/** `platformStackName('beta')` -> `AnyWearPlatformStack-beta`. */
export declare function platformStackName(stage: string): string;

/** `runtimeStackName('beta')` -> `AnyWearRuntimeStack-beta`. */
export declare function runtimeStackName(stage: string): string;

/** The release slice's one stack and the Infra workflow that deploys it. */
export interface ServiceRuntimeStack {
  readonly name: string;
  readonly region: string;
  readonly workflow_path: string;
}

export declare const SERVICE_RUNTIME_STACK: ServiceRuntimeStack;

/** The declared normalisation of a deployed template, as human-readable rules. */
export declare const DEPLOYED_TEMPLATE_NORMALISATION: readonly string[];

/**
 * Return a normalised copy of a deployed or synthesized CloudFormation template:
 * resource `Metadata` removed, the `CDKMetadata` resource and the
 * `CDKMetadataAvailable` condition dropped. The input is not mutated.
 */
export declare function normaliseDeployedTemplate(template: unknown): Record<string, unknown>;

/** The canonical sha256 of a deployed template after {@link normaliseDeployedTemplate}. */
export declare function canonicalDeployedTemplateHash(template: unknown): string;

/** The exact top-level members of a v3 deployment record core (Infra owns this shape). */
export declare const DEPLOYMENT_RECORD_MEMBERS: readonly string[];

/** The exact `producer` fields of a v3 deployment record. */
export declare const DEPLOYMENT_PRODUCER_FIELDS: readonly string[];

/** The exact `stacks[]` fields of a v3 deployment record. */
export declare const DEPLOYMENT_STACK_FIELDS: readonly string[];

/** The exact `inputs[]` fields of a v3 deployment record. */
export declare const DEPLOYMENT_INPUT_FIELDS: readonly string[];

/** The exact `observed` fields of a v5/v6 Service deployment record. */
export declare const SERVICE_OBSERVED_FIELDS: readonly string[];

/** One ECS service identity recorded in the Service observation. */
export interface ServiceEcsIdentity {
  readonly service_arn: string;
  readonly task_definition_arn: string;
  readonly task_definition_sha256: string;
  readonly image_digest: string;
}

/** The exact fields of one ECS service identity in the Service observation. */
export declare const SERVICE_ECS_IDENTITY_FIELDS: readonly string[];

/** The required `observed` tuple of a v5 Service deployment record. */
export interface ServiceObserved {
  readonly service_sha: string;
  readonly image_digest: string;
  /** The minimum Client version floor the observed Service enforces. */
  readonly minimum_client_version: number;
  readonly ecs: { readonly api: ServiceEcsIdentity; readonly worker: ServiceEcsIdentity };
  readonly endpoints: { readonly api: string };
}

/** The exact top-level members of the v6 Service deployment record. */
export declare const SERVICE_DEPLOYMENT_RECORD_MEMBERS: readonly string[];

/** The exact fields of the required `gate` block. */
export declare const DEPLOYMENT_GATE_FIELDS: readonly string[];

/** The exact fields of one gate signal. */
export declare const DEPLOYMENT_GATE_SIGNAL_FIELDS: readonly string[];

/** The exact fields of the gate's probe budget. */
export declare const DEPLOYMENT_GATE_PROBE_FIELDS: readonly string[];

/** The fixed, ordered names of the six baked signals. */
export declare const DEPLOYMENT_GATE_SIGNAL_NAMES: readonly string[];

/** The three GetQueueAttributes names the live SQS API accepts for depth. */
export declare const DEPLOYMENT_SQS_DEPTH_ATTRIBUTES: readonly string[];

/** The one stage-free threshold table, keyed by signal name. */
export declare const DEPLOYMENT_GATE_THRESHOLDS: Readonly<Record<string, Readonly<Record<string, number>>>>;

/** The fixed comparison string of each signal, keyed by signal name. */
export declare const DEPLOYMENT_GATE_COMPARISONS: Readonly<Record<string, string>>;

/** The gate window: exactly 600 seconds. */
export declare const DEPLOYMENT_GATE_DURATION_SECONDS: 600;

/** Probe cadence: one `GET /readyz` every 15 seconds. */
export declare const DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS: 15;

/** Minimum probes and the ALB `RequestCount` floor for a usable 5xx denominator. */
export declare const DEPLOYMENT_GATE_REQUEST_FLOOR: 30;

/** The probe budget of a 600-second window. */
export declare const DEPLOYMENT_GATE_MAX_PROBES: 40;

/** `passed` is the only gate result a deployment record may carry. */
export declare const DEPLOYMENT_GATE_RESULTS: readonly string[];

/** Signal states; any state other than `not-breaching` fails the gate. */
export declare const DEPLOYMENT_GATE_STATES: readonly string[];

/** Observed alarm states recorded alongside each signal. */
export declare const DEPLOYMENT_GATE_ALARM_STATES: readonly string[];

/** The gate name included in every Service record's producer block (not used directly). */
export declare const DEPLOYMENT_GATE_NAME_SUFFIX: 'anywear-deployment-bake';

/** `deploymentBakeName('beta')` -> `beta-anywear-deployment-bake`. */
export declare function deploymentBakeName(stage: string): string;

/** The stage encoded in `AnyWearRuntimeStack-<stage>`. */
export declare function runtimeStageFromStack(stackName: string): string;

/** The deployed alarm names for one signal, for example `beta-anywear-alb-5xx`. */
export declare function deploymentAlarmName(stage: string, signalName: string): readonly string[];

/** The six signals' deployed alarm names, keyed by signal name. */
export declare function deploymentAlarmNames(stage: string): Readonly<Record<string, readonly string[]>>;

/** The stage-base queues the bake reads, keyed by purpose. */
export declare function deploymentQueueNames(stage: string): {
  readonly vto: string;
  readonly vto_dlq: string;
  readonly auto_tagging: string;
  readonly auto_tagging_dlq: string;
};

/** One observed alarm state recorded next to its signal. */
export interface DeploymentGateAlarm {
  readonly name: string;
  readonly state: 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';
}

/** The exact read identity of one signal data source. */
export interface DeploymentGateRead {
  readonly source: 'cloudwatch' | 'ecs' | 'sqs' | 'logs';
  readonly [field: string]: unknown;
}

/** One baked signal with its threshold, comparison, alarms, reads and exceptions. */
export interface DeploymentGateSignal {
  readonly name: string;
  readonly state: 'not-breaching' | 'breaching' | 'insufficient';
  readonly value: Readonly<Record<string, unknown>>;
  readonly threshold: Readonly<Record<string, number>>;
  readonly comparison: string;
  readonly alarms: readonly DeploymentGateAlarm[];
  readonly reads: readonly DeploymentGateRead[];
  readonly exceptions: readonly string[];
}

/** The passed 600-second six-signal bake gate. */
export interface DeploymentGate {
  readonly name: string;
  readonly result: 'passed';
  readonly started_at: string;
  readonly ended_at: string;
  readonly duration_seconds: 600;
  readonly service_sha: string;
  readonly image_digest: string;
  readonly probe: {
    readonly interval_seconds: 15;
    readonly probes_sent: number;
    readonly request_floor: 30;
  };
  readonly signals: readonly DeploymentGateSignal[];
}

/** Validate one passed deployment gate block for a stage. */
export declare function validateDeploymentGate(gate: unknown, stage: string): DeploymentGate;

/** The exact top-level members of the required v6 `schema_boundary` block. */
export declare const SERVICE_SCHEMA_BOUNDARY_FIELDS: readonly string[];

/** The exact fields of the boundary's sealed-asset summary. */
export declare const SCHEMA_BOUNDARY_ASSET_FIELDS: readonly string[];

/** The exact fields of the boundary's live applied summary. */
export declare const SCHEMA_BOUNDARY_APPLIED_FIELDS: readonly string[];

/** The exact fields of the boundary's comparison summary. */
export declare const SCHEMA_BOUNDARY_COMPARISON_FIELDS: readonly string[];

/** The exact fields of the boundary's reader identity. */
export declare const SCHEMA_BOUNDARY_READER_FIELDS: readonly string[];

/** The two reader identities: the selected release image and the deployed fallback. */
export declare const SCHEMA_BOUNDARY_READER_SOURCES: readonly ('selected-image' | 'deployed-image')[];

/** The only admitted boundary result. */
export declare const SCHEMA_BOUNDARY_RESULTS: readonly string[];

/** One compared journal pair: the migration creation time and the SQL hash. */
export interface SchemaBoundaryPrefixEntry {
  readonly created_at: number;
  readonly sha256: string;
}

/**
 * The canonical hash of the compared `{ created_at, sha256 }` prefix, in journal
 * order. A consumer holding the full applied rows (the operation record carries
 * them) can recompute it.
 */
export declare function schemaBoundaryPrefixHash(entries: readonly SchemaBoundaryPrefixEntry[]): string;

/** The sealed release asset summary recorded in a v6 deployment record. */
export interface SchemaBoundaryAsset {
  readonly sha256: string;
  readonly current_version: number;
  readonly minimum_version: number;
  readonly minimum_migration_count: number;
  readonly journal_length: number;
}

/** The live applied summary recorded in a v6 deployment record. */
export interface SchemaBoundaryApplied {
  readonly schema_version: number;
  readonly journal_length: number;
}

/** The comparison recorded in a v6 deployment record. */
export interface SchemaBoundaryComparison {
  readonly checked_entries: number;
  readonly prefix_sha256: string;
  readonly pending_migrations: number;
}

/** The reader identity that produced the live applied summary. */
export interface SchemaBoundaryReader {
  readonly source: 'selected-image' | 'deployed-image';
  readonly service_sha: string;
  readonly image_digest: string;
}

/** The admitted schema-boundary comparison recorded in a v6 deployment record. */
export interface SchemaBoundary {
  readonly result: 'compatible';
  readonly asset: SchemaBoundaryAsset;
  readonly applied: SchemaBoundaryApplied;
  readonly comparison: SchemaBoundaryComparison;
  readonly reader: SchemaBoundaryReader;
}

/**
 * Validate one v6 `schema_boundary` member: exact members, the admitted result,
 * the version/migration-count range, the checked-entry/pending arithmetic and
 * the reader identity. Returns the input unchanged when it is valid.
 */
export declare function validateSchemaBoundary<T>(boundary: T): T;

/** The complete v6 `anywear_service_deployment` schema surface. */
export interface ServiceDeploymentRecordSchema {
  readonly schema_version: 6;
  readonly record_type: 'anywear_service_deployment';
  readonly members: readonly string[];
  readonly producer: readonly string[];
  readonly stack: readonly string[];
  readonly input: readonly string[];
  readonly observed: readonly string[];
  readonly gate: readonly string[];
  readonly signal: readonly string[];
  readonly signals: readonly string[];
  readonly schema_boundary: readonly string[];
  readonly schema_boundary_asset: readonly string[];
  readonly schema_boundary_applied: readonly string[];
  readonly schema_boundary_comparison: readonly string[];
  readonly schema_boundary_reader: readonly string[];
  readonly schema_boundary_reader_sources: readonly string[];
  readonly schema_boundary_results: readonly string[];
  readonly producer_repository: string;
  readonly template_normalisation: readonly string[];
  readonly stacks: readonly { readonly name: string; readonly region: string }[];
}

export declare const SERVICE_DEPLOYMENT_RECORD_SCHEMA: ServiceDeploymentRecordSchema;

/** The normalized task-definition identity whose content hash names a deployment. */
export interface StableTaskDefinition {
  readonly family: unknown;
  readonly taskRoleArn: unknown;
  readonly executionRoleArn: unknown;
  readonly networkMode: unknown;
  readonly cpu: unknown;
  readonly memory: unknown;
  readonly container: {
    readonly name: unknown;
    readonly image: string;
    readonly command: unknown;
    readonly environment: readonly { readonly name: string; readonly value: string }[];
  };
}

/** Normalize a deployed task definition to its stable identity fields. */
export declare function stableTaskDefinition(definition: unknown): StableTaskDefinition;

/** The sha256 content hash of the normalized task definition. */
export declare function taskDefinitionContentHash(definition: unknown): string;

/**
 * Validate one v6 `anywear_service_deployment` record, including its required
 * `gate` block bound to the observed Service/image and its `schema_boundary`
 * comparison. A `selected-image` reader must be the observed deployment. Returns
 * the input record unchanged when it is valid.
 */
export declare function validateServiceDeploymentRecord<T>(record: T): T;

/**
 * Validate the record's `stacks[]` rows: exactly the Service Runtime stack with
 * its configured region and the exact stack fields.
 */
export declare function validateServiceStacks<T extends readonly { readonly name: string }[]>(rows: T): T;

// Issue #195 retired the Foundation per-service deploy roles. The Runtime stack is
// deployed by the existing `beta-infra-deploy-role` through the standard CDK
// bootstrap path, so the role-naming and OIDC-subject helpers left with them.
