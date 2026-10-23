# `@git-malu/stage-contracts`

Versioned, dependency-free source of the AnyWear Beta stage contract, the
Base/Egress/Runtime stack identities, the deployed-template normalisation, the
task-definition identity, and the 300-second six-signal bake gate's stage-free
constants and name builders.

| | |
| --- | --- |
| Package | `@git-malu/stage-contracts` |
| Version | `0.7.0` |
| Tag | `stage-contracts-v0.7.0` (created at Deployment, not by the change that bumps the version; `stage-contracts-v0.6.0` is the newest published tag) |
| Registry | GitHub Packages (`https://npm.pkg.github.com`) |
| Runtime | Node.js 24+, plain ESM (`.mjs`) with `.d.ts`; no build step, no runtime dependency |

## Contents

- **Stage contract** — `STAGE_CONTRACT_STAGE` (`beta`), the 35 unconditional
  `/anywear/beta/...` names in `STAGE_CONTRACT_PARAMETERS`, the one conditional
  `cleanup_task_role_arn` name in `STAGE_CONTRACT_CONDITIONAL_PARAMETERS`, the
  36-name read surface in `STAGE_CONTRACT_READ_PARAMETERS`, and
  `stageParameters()` → `{ name, kind: 'String' | 'List', parameter }[]` (the
  absolute SSM name is `parameter`). `api_base_url` (0.3.0) is the public API
  distribution endpoint published by the `Base` stack; it is unconditional. The
  consumer creates its own
  `AWS::SSM::Parameter::Value<String>` / `...<List<String>>` `CfnParameter`s with
  the absolute name as the default; this package imports no CDK module.
- **Stage inputs** — `validateStageInputs(rows)` and
  `stageContractSchemaHash(rows)` for the sorted
  `{ parameter, version, value_sha256 }` rows a stage-contract reader produces and
  the schema content hash derived from them.
- **Stack identity** — `INFRA_REPOSITORY`, `SERVICE_REPOSITORY`,
  `platformStackName(stage)`, `runtimeStackName(stage)`,
  `SERVICE_RUNTIME_STACK` and `runtimeStageFromStack(stackName)`. The persistent
  `Base` stack keeps the physical name `AnyWearPlatformStack-<stage>`; the release
  slice is `AnyWearRuntimeStack-<stage>`, deployed since 0.4.0 by Infra's
  `.github/workflows/mutate.yml`.
- **Deployed-template normalisation** — `DEPLOYED_TEMPLATE_NORMALISATION`,
  `normaliseDeployedTemplate(template)` and
  `canonicalDeployedTemplateHash(template)`. Every resource `Metadata` key is
  removed (only the reviewed CDK keys may be present), the
  `Resources/CDKMetadata` resource and the `Conditions/CDKMetadataAvailable`
  condition are dropped, and the result is hashed as canonical JSON. The producer
  and any reader call the same helper, so a synthesized baseline and a live
  read-back are directly comparable.
- **Task-definition identity** — `stableTaskDefinition(definition)` and
  `taskDefinitionContentHash(definition)`: the normalized content identity of one
  ECS task definition. A task-definition revision is CloudFormation bookkeeping,
  not identity, so the same image/environment/roles/command re-registers as a new
  revision and must not read as a change.
- **Deployment bake gate** — `DEPLOYMENT_GATE_NAME_SUFFIX`,
  `DEPLOYMENT_GATE_DURATION_SECONDS`, `DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS`,
  `DEPLOYMENT_GATE_REQUEST_FLOOR`, `DEPLOYMENT_GATE_MAX_PROBES`,
  `DEPLOYMENT_GATE_SIGNAL_NAMES` (the six fixed names, in order),
  `DEPLOYMENT_GATE_THRESHOLDS` and `DEPLOYMENT_GATE_COMPARISONS` (one stage-free
  table), `DEPLOYMENT_SQS_DEPTH_ATTRIBUTES`, `deploymentBakeName`,
  `deploymentAlarmName`, `deploymentAlarmNames` and `deploymentQueueNames`. The
  bake itself — the 300-second window, the probe budget, each signal's
  value/threshold/comparison self-consistency, the deployed alarm names and
  observed states, and each signal's exact read identity and minimum data points —
  is evaluated by AnyWear-Infra's `scripts/bake-gate.mjs` and fails the `deploy`
  job; no record member carries the result. The `sqs_oldest_message_age` read
  identity is two-sourced: the `AWS/SQS` `ApproximateAgeOfOldestMessage` `Maximum`
  metric per work queue (`GetMetricStatistics`), plus the three valid depth
  attributes from `GetQueueAttributes` (`DEPLOYMENT_SQS_DEPTH_ATTRIBUTES`). The
  age is not a `GetQueueAttributes` attribute; `ApproximateNumberOfMessagesVisible`
  is not a valid attribute name, so neither can appear in a read.

### Changed in 0.7.0 (issue #219)

The bake window shortens to 300 seconds and every completeness rule is
recalibrated to what that window produces: 20 probes at the unchanged 15-second
cadence, an ALB `RequestCount` floor of 15 (75% of 20), five one-minute
`RequestCount` periods, 10 ECS and 10 SQS samples, 300-second
`TargetResponseTime` p95 and `ApproximateAgeOfOldestMessage` periods aligned to
the next 5-minute clock boundary, a 150-second queue age, a 150000 ms outbox age
and four outbox log lines. The gate keeps the same six signals, structure and
fail-closed predicate, the thresholds remain one stage-free table, and a
Production activation revisits these numbers at that point.

### Removed in 0.6.0 (issue #207)

The operation/deployment evidence chain is retired: there is no
`anywear_infra_verified_inputs`, `anywear_infra_operation`,
`anywear_infra_deployment`, `anywear_infra_family_observation` or
`anywear_service_deployment` record, and no record gate. The package no longer
exports `DEPLOYMENT_RECORD_MEMBERS`, `DEPLOYMENT_PRODUCER_FIELDS`,
`DEPLOYMENT_STACK_FIELDS`, `DEPLOYMENT_INPUT_FIELDS`, `SERVICE_OBSERVED_FIELDS`,
`SERVICE_ECS_IDENTITY_FIELDS`, `SERVICE_DEPLOYMENT_RECORD_MEMBERS`,
`SERVICE_DEPLOYMENT_RECORD_SCHEMA`, `validateServiceDeploymentRecord`,
`validateServiceStacks`, `SERVICE_SCHEMA_BOUNDARY_FIELDS`, the
`SCHEMA_BOUNDARY_*` constants, `schemaBoundaryPrefixHash`,
`validateSchemaBoundary`, `DEPLOYMENT_GATE_FIELDS`,
`DEPLOYMENT_GATE_PROBE_FIELDS`, `DEPLOYMENT_GATE_SIGNAL_FIELDS`,
`DEPLOYMENT_GATE_RESULTS`, `DEPLOYMENT_GATE_STATES`,
`DEPLOYMENT_GATE_ALARM_STATES` or `validateDeploymentGate`.

The audit trail is the platform's: the Actions run and its job/step conclusions,
the GitHub Environment deployment, CloudFormation stack events, the immutable
release tag→commit with per-asset digests, the ECR image digest, and the live
`/health` and `/readyz` endpoints. The schema-boundary comparison shape is owned
by Infra's schema-boundary gate (`scripts/schema-gate.mjs`), which still refuses
before any CloudFormation change; it is no longer a cross-repository record
member.

Issue #195 removed the Foundation service-role naming helpers
(`serviceDeployRoleName`, `serviceDeployCfnRoleName`, `serviceTrustSubject`) with
the two roles they named. The Runtime stack is deployed by the existing
`beta-infra-deploy-role` through the standard CDK bootstrap path.

The conditional `cleanup_task_role_arn` definition is included in
`stageParameters()`; a legacy identity phase filters it with
`STAGE_CONTRACT_CONDITIONAL_PARAMETERS` and never treats its absence as an error.

## Test and pack

```sh
npm test    # node --test test/*.test.mjs
npm pack    # git-malu-stage-contracts-0.7.0.tgz
```

## Publishing

Publishing is a separate, tag-triggered workflow
(`.github/workflows/publish-stage-contracts.yml`) with `packages: write`. Pushing
the annotated tag `stage-contracts-v0.7.0` runs the package tests, asserts the
tag equals `stage-contracts-v<package version>`, and publishes with
`NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to
`https://npm.pkg.github.com`. It holds no AWS credential and no deployment
authority.

Version bumps are a new `version` plus the matching `stage-contracts-v<version>`
tag; an existing tag is never moved or force-pushed.

## Consumption

AnyWear-Infra consumes the package from this checkout, not from a registry
credential and not from another repository's tarball:

```json
"@git-malu/stage-contracts": "file:packages/stage-contracts"
```

`npm ci` links it into `node_modules` and `npm run check` runs the package tests
with the repository's own source. Since #195 AnyWear-Service declares no CDK
dependency at all, so there is no installed second consumer and no re-vendor
step; AnyWear-E2E's `scripts/vendor/` copy is a frozen 0.3.0 historical pin that
#207 does not re-vendor. The tag-driven publication stays available for a future
external consumer.
