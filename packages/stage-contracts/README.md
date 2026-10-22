# `@git-malu/stage-contracts`

Versioned, dependency-free source of the AnyWear Beta stage contract, the
Base/Egress/Runtime stack identities, the deployed-template normalisation, and
the v5 `anywear_service_deployment` record and bake-gate validators that
AnyWear-Infra's `deploy-runtime` operation produces.

| | |
| --- | --- |
| Package | `@git-malu/stage-contracts` |
| Version | `0.4.0` |
| Tag | `stage-contracts-v0.4.0` (a post-merge publication step; `0.1.0` is the last tagged release) |
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
- **Record inputs** — `validateStageInputs(rows)` and
  `stageContractSchemaHash(rows)` for the v3 record core's sorted
  `{ parameter, version, value_sha256 }` rows and its schema content hash.
- **Stack identity** — `INFRA_REPOSITORY`, `SERVICE_REPOSITORY`,
  `platformStackName(stage)`, `runtimeStackName(stage)`,
  `SERVICE_RUNTIME_STACK`, `runtimeStageFromStack(stackName)` and
  `validateServiceStacks(rows)`. The persistent `Base` stack keeps the physical
  name `AnyWearPlatformStack-<stage>`; the release slice is
  `AnyWearRuntimeStack-<stage>`, deployed since 0.4.0 by Infra's
  `.github/workflows/mutate.yml`.
- **Deployed-template normalisation** — `DEPLOYED_TEMPLATE_NORMALISATION`,
  `normaliseDeployedTemplate(template)` and
  `canonicalDeployedTemplateHash(template)`. The record's
  `template_sha256` is the canonical hash of the deployed `Original` template
  after the declared normalisation: every resource `Metadata` key is removed
  (only the reviewed CDK keys may be present), the `Resources/CDKMetadata`
  resource and the `Conditions/CDKMetadataAvailable` condition are dropped, and
  the result is hashed as canonical JSON. The producer and any verifier call the
  same helper, so a synthesized baseline and a live read-back are directly
  comparable.
- **Service record v5** — `DEPLOYMENT_RECORD_MEMBERS` (the seven-member v3 core
  Infra still produces), `SERVICE_DEPLOYMENT_RECORD_MEMBERS` (the same core plus
  the required `gate`), `SERVICE_DEPLOYMENT_RECORD_SCHEMA`, the required
  `SERVICE_OBSERVED_FIELDS` tuple (`service_sha`, `image_digest`,
  `minimum_client_version`, `ecs`, `endpoints`), `SERVICE_ECS_IDENTITY_FIELDS`,
  `stableTaskDefinition`, `taskDefinitionContentHash`,
  `validateServiceDeploymentRecord`. The producer is
  `git-malu/AnyWear-Infra`'s `deploy-runtime` operation; v4 and earlier records
  are historical shapes and are rejected as unknown schemas.
  `minimum_client_version` is a required non-negative safe integer: it is the
  minimum Client version floor the observed Service enforces, read back from the
  deployed Service instead of being defaulted by the record producer. All pure:
  no AWS, network, filesystem or clock.
- **Deployment bake gate** — `DEPLOYMENT_GATE_SIGNAL_NAMES` (the six fixed
  names, in order), `DEPLOYMENT_GATE_THRESHOLDS` and
  `DEPLOYMENT_GATE_COMPARISONS` (one stage-free table), `deploymentAlarmNames`
  and `deploymentBakeName` (the only stage-bearing names), and
  `validateDeploymentGate(gate, stage)`, which enforces the 600-second window,
  the probe budget, each signal's value/threshold/comparison self-consistency,
  the deployed alarm names and observed states, and each signal's exact read
  identity and minimum data points. The `sqs_oldest_message_age` read identity is
  two-sourced: the `AWS/SQS` `ApproximateAgeOfOldestMessage` `Maximum` metric per
  work queue (`GetMetricStatistics`), plus the three valid depth attributes from
  `GetQueueAttributes` (`DEPLOYMENT_SQS_DEPTH_ATTRIBUTES`). The age is not a
  `GetQueueAttributes` attribute; `ApproximateNumberOfMessagesVisible` is not a
  valid attribute name, so neither can appear in the record.

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
npm pack    # git-malu-stage-contracts-0.4.0.tgz
```

## Publishing

Publishing is a separate, tag-triggered workflow
(`.github/workflows/publish-stage-contracts.yml`) with `packages: write`. Pushing
the annotated tag `stage-contracts-v0.4.0` runs the package tests, asserts the
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
dependency at all, so there is no second consumer and no re-vendor step; the
tag-driven publication stays available for a future external consumer.
