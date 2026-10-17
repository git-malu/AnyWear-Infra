// Type declarations for @git-malu/stage-contracts.
//
// The package is plain ESM JavaScript; these declarations are the consumer-facing
// contract. No build step and no runtime dependencies.

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

/** The 34 `/anywear/beta/...` names published in every Beta identity phase. */
export declare const STAGE_CONTRACT_PARAMETERS: readonly string[];

/** The one name published only while the identity phase creates the cleanup task role. */
export declare const STAGE_CONTRACT_CONDITIONAL_PARAMETERS: readonly string[];

/** All 35 names a deployment may read: the unconditional 34 plus the conditional one. */
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

/** The repository that owns the release slice and produces the Service record. */
export declare const SERVICE_REPOSITORY: 'git-malu/AnyWear-Service';

/** `platformStackName('beta')` -> `AnyWearPlatformStack-beta`. */
export declare function platformStackName(stage: string): string;

/** `workloadStackName('beta')` -> `AnyWearWorkloadStack-beta`. */
export declare function workloadStackName(stage: string): string;

/** The Service release slice's one stack and producer workflow. */
export interface ServiceWorkloadStack {
  readonly name: string;
  readonly region: string;
  readonly workflow_path: string;
}

export declare const SERVICE_WORKLOAD_STACK: ServiceWorkloadStack;

/** The exact top-level members of a v3 deployment record. */
export declare const DEPLOYMENT_RECORD_MEMBERS: readonly string[];

/** The exact `producer` fields of a v3 deployment record. */
export declare const DEPLOYMENT_PRODUCER_FIELDS: readonly string[];

/** The exact `stacks[]` fields of a v3 deployment record. */
export declare const DEPLOYMENT_STACK_FIELDS: readonly string[];

/** The exact `inputs[]` fields of a v3 deployment record. */
export declare const DEPLOYMENT_INPUT_FIELDS: readonly string[];

/** The exact `observed` fields of a Service v3 deployment record. */
export declare const SERVICE_OBSERVED_FIELDS: readonly string[];

/** The exact fields of one ECS service identity in the Service observation. */
export declare const SERVICE_ECS_IDENTITY_FIELDS: readonly string[];

/** The complete v3 `anywear_service_deployment` schema surface. */
export interface ServiceDeploymentRecordSchema {
  readonly schema_version: 3;
  readonly record_type: 'anywear_service_deployment';
  readonly members: readonly string[];
  readonly producer: readonly string[];
  readonly stack: readonly string[];
  readonly input: readonly string[];
  readonly observed: readonly string[];
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
 * Validate one v3 `anywear_service_deployment` record. Returns the input record
 * unchanged when it is valid.
 */
export declare function validateServiceDeploymentRecord<T>(record: T): T;

/** `serviceDeployRoleName('service')` -> `beta-service-deploy-role`. */
export declare function serviceDeployRoleName(service: string): string;

/** `serviceDeployCfnRoleName('service')` -> `beta-service-deploy-cfn-role`. */
export declare function serviceDeployCfnRoleName(service: string): string;

/** Options for {@link serviceTrustSubject}. */
export interface ServiceTrustSubjectOptions {
  /** The repository name only, for example `AnyWear-Service`. */
  readonly repository: string;
  /** GitHub's immutable repository id. */
  readonly repositoryId: number;
  /** The GitHub environment name, for example `beta`. */
  readonly environment: string;
}

/**
 * Build the immutable GitHub OIDC subject for a service environment:
 * `repo:git-malu@11473072/<repository>@<repositoryId>:environment:<environment>`.
 */
export declare function serviceTrustSubject(options: ServiceTrustSubjectOptions): string;
