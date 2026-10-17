# `@git-malu/stage-contracts`

Versioned, dependency-free source of the AnyWear Beta stage contract, the stack
identities shared with AnyWear-Service, the v3 `anywear_service_deployment`
record validators, and the Foundation service-role naming helpers.

| | |
| --- | --- |
| Package | `@git-malu/stage-contracts` |
| Version | `0.1.0` |
| Tag | `stage-contracts-v0.1.0` |
| Registry | GitHub Packages (`https://npm.pkg.github.com`) |
| Runtime | Node.js 24+, plain ESM (`.mjs`) with `.d.ts`; no build step, no runtime dependency |

## Contents

- **Stage contract** — `STAGE_CONTRACT_STAGE` (`beta`), the 34 unconditional
  `/anywear/beta/...` names in `STAGE_CONTRACT_PARAMETERS`, the one conditional
  `cleanup_task_role_arn` name in `STAGE_CONTRACT_CONDITIONAL_PARAMETERS`, the
  35-name read surface in `STAGE_CONTRACT_READ_PARAMETERS`, and
  `stageParameters()` → `{ name, kind: 'String' | 'List', parameter }[]` (the
  absolute SSM name is `parameter`). The consumer creates its own
  `AWS::SSM::Parameter::Value<String>` / `...<List<String>>` `CfnParameter`s with
  the absolute name as the default; this package imports no CDK module.
- **Record inputs** — `validateStageInputs(rows)` and
  `stageContractSchemaHash(rows)` for the v3 record's sorted
  `{ parameter, version, value_sha256 }` rows and its schema content hash.
- **Stack identity** — `INFRA_REPOSITORY`, `SERVICE_REPOSITORY`,
  `platformStackName(stage)`, `workloadStackName(stage)`,
  `SERVICE_WORKLOAD_STACK`.
- **Service record** — `DEPLOYMENT_RECORD_MEMBERS`,
  `SERVICE_DEPLOYMENT_RECORD_SCHEMA`, `SERVICE_ECS_IDENTITY_FIELDS`,
  `stableTaskDefinition`, `taskDefinitionContentHash`,
  `validateServiceDeploymentRecord`. All pure: no AWS, network or filesystem.
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
npm pack    # git-malu-stage-contracts-0.1.0.tgz
```

## Publishing

Publishing is a separate, tag-triggered workflow
(`.github/workflows/publish-stage-contracts.yml`) with `packages: write`. Pushing
the annotated tag `stage-contracts-v0.1.0` runs the package tests, asserts the
tag equals `stage-contracts-v<package version>`, and publishes with
`NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to
`https://npm.pkg.github.com`. It holds no AWS credential and no deployment
authority.

Version bumps are a new `version` plus the matching `stage-contracts-v<version>`
tag; an existing tag is never moved or force-pushed.

## Consuming a pinned tarball

AnyWear-Service pins the packed artifact, not a mutable branch and not a registry
credential in the deploy job:

1. Commit the tarball (for example
   `git-malu-stage-contracts-0.1.0.tgz`) under `infra/vendor/`.
2. Pin it in `infra/package.json`:
   `"@git-malu/stage-contracts": "file:vendor/git-malu-stage-contracts-0.1.0.tgz"`.
3. Install with the workspace's usual frozen-lockfile command.

The tarball is built by `npm pack` in this directory; its sha256 and file list are
reported with the tag so a consumer can verify the bytes it commits.
