# `@git-malu/stage-contracts`

Versioned, dependency-free source of the AnyWear Beta stage contract, the
Base/Egress/Runtime stack identities shared with AnyWear-Service, the v4
`anywear_service_deployment` record and bake-gate validators, and the Foundation
service-role naming helpers.

| | |
| --- | --- |
| Package | `@git-malu/stage-contracts` |
| Version | `0.3.0` |
| Tag | `stage-contracts-v0.3.0` (a post-merge publication step; `0.1.0` is the last tagged release) |
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
  name `AnyWearPlatformStack-<stage>`; the Service-owned release slice is
  `AnyWearRuntimeStack-<stage>` (0.3.0 renamed it from the retired name).
- **Service record v4** — `DEPLOYMENT_RECORD_MEMBERS` (the seven-member v3 core
  Infra still produces), `SERVICE_DEPLOYMENT_RECORD_MEMBERS` (the same core plus
  the required `gate`), `SERVICE_DEPLOYMENT_RECORD_SCHEMA`, the required
  `SERVICE_OBSERVED_FIELDS` tuple (`service_sha`, `image_digest`,
  `minimum_client_version`, `ecs`, `endpoints`), `SERVICE_ECS_IDENTITY_FIELDS`,
  `stableTaskDefinition`, `taskDefinitionContentHash`,
  `validateServiceDeploymentRecord`. `minimum_client_version` is a required
  non-negative safe integer: it is the minimum Client version floor the observed
  Service enforces, read back from the deployed Service instead of being defaulted
  by the record producer. All pure: no AWS, network, filesystem or clock.
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
- **Foundation roles** — `serviceDeployRoleName('service')` →
  `beta-service-deploy-role`,
  `serviceDeployCfnRoleName('service')` → `beta-service-deploy-cfn-role`, and
  `serviceTrustSubject({ repository, repositoryId, environment })` for the
  immutable GitHub OIDC subject.

The conditional `cleanup_task_role_arn` definition is included in
`stageParameters()`; a legacy identity phase filters it with
`STAGE_CONTRACT_CONDITIONAL_PARAMETERS` and never treats its absence as an error.

## Test and pack

```sh
npm test    # node --test test/*.test.mjs
npm pack    # git-malu-stage-contracts-0.3.0.tgz
```

## Publishing

Publishing is a separate, tag-triggered workflow
(`.github/workflows/publish-stage-contracts.yml`) with `packages: write`. Pushing
the annotated tag `stage-contracts-v0.3.0` runs the package tests, asserts the
tag equals `stage-contracts-v<package version>`, and publishes with
`NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to
`https://npm.pkg.github.com`. It holds no AWS credential and no deployment
authority.

Version bumps are a new `version` plus the matching `stage-contracts-v<version>`
tag; an existing tag is never moved or force-pushed. A consumer may pin a
tarball packed from an unmerged release branch, but that vendor record names the
source commit and states that the tag-based re-vendor is a post-merge step.

## Consuming a pinned tarball

AnyWear-Service pins the packed artifact, not a mutable branch and not a registry
credential in the deploy job:

1. Commit the tarball (for example
   `git-malu-stage-contracts-0.3.0.tgz`) under `infra/vendor/`.
2. Pin it in `infra/package.json`:
   `"@git-malu/stage-contracts": "file:vendor/git-malu-stage-contracts-0.3.0.tgz"`.
3. Install with the workspace's usual frozen-lockfile command.

The tarball is built by `npm pack` in this directory; its sha256 and file list are
reported with the tag so a consumer can verify the bytes it commits.
