# AnyWear Infra

Private repository for AnyWear's shared AWS CDK application and infrastructure
operations. Extraction is tracked in [AnyWear #54](https://github.com/git-malu/AnyWear/issues/54).

This repository contains the CDK app, source checks and reviewed Beta operation
entry point. AnyWear-Service remains the deployed infrastructure authority until
the separately recorded #54 cutover. Source delivery does not establish AWS
deployment, writer handoff or runtime acceptance.

The accepted [ownership ADR](https://github.com/git-malu/AnyWear-Meta/blob/main/architecture/ADR/0021-shared-infrastructure-repository.md)
assigns shared infrastructure to Infra, immutable application artifacts to Service,
independent web publishing to Client, and authenticated system qualification to E2E.
The root AnyWear shell records local submodule pins and does not deploy.

## Source checks

Use Node.js 24 and npm in this repository:

```sh
npm ci
npm run audit:prod
npm run check
node scripts/create-test-inputs.mjs
node scripts/synth-matrix.mjs --artifact-directory .service-artifacts/test --baseline-templates test/baselines --output cdk.matrix
node scripts/synth-matrix.mjs --artifact-directory .service-artifacts/test --baseline-templates test/baselines --retention-protection true --output cdk.protected.matrix
```

[Source CI](.github/workflows/check.yml) runs these checks without private peer
checkouts or cloud credentials. The matrix compares dev active, Beta active, Beta
stopped and prod active across the three identity phases, including Foundation and
Billing, against the preserved Service source templates. Fixture artifacts support
source tests; deployments use verified sealed Service releases and reviewed
publication acceptance receipts. CI repeats all three phases with explicit
retention protection and uploads `cdk.matrix/comparison.json` and
`cdk.protected.matrix/comparison.json` as `infra-source-matrix`.

## Operations

| Entry point | Purpose |
| --- | --- |
| [runtime.yml](.github/workflows/runtime.yml) | Manual protected-main Beta deployment, migration, verification, lifecycle, observation and tester-allowlist operations |
| [bin/infra.ts](bin/infra.ts), `appScope=foundation` | Separate Foundation-only initial role bootstrap; no Service artifact input is required |
| [bin/infra.ts](bin/infra.ts), `appScope=billing` | Separate account billing scope in `us-east-1`; application resources are not synthesized |
| [ecr-retention.mjs](scripts/ecr-retention.mjs) | Verify exact effective policy, protected current/rollback digests and completed expiration preview |
| [create-publication-candidate.mjs](scripts/create-publication-candidate.mjs) | Independently retrieve exact publication evidence and write a candidate receipt for manager review |
| [observe-deployment.mjs](scripts/observe-deployment.mjs) | Authenticate deployed templates, artifacts, configuration, schema and application identities |
| [production.yml](.github/workflows/production.yml) | Future Production scaffold with a pre-AWS blocker until a separately reviewed onboarding PR completes its contract |

Every Beta operation requires a manager-recorded source/expiry/operation/selection/
phase window. Repository-local Actions concurrency serializes Infra jobs; separate
Client and E2E writers still require explicit windows and verified cessation.
Deployment and runtime credentials are distinct. The current CDK CloudFormation
execution role uses `AdministratorAccess` without a permissions boundary, so the
deployment chain has account-wide effective authority; the dedicated role names
do not establish Beta resource isolation.
Production activation variables cannot bypass its source blocker; keep both
deployment/readiness gates disabled through #54.

Artifact acceptance compares GitHub's native signed immutable-release statement
with the full release commit and every asset, then binds the publisher's exact
completed-success run/attempt through a reviewed receipt committed in Infra.
The native signature has no workflow/run fields. Review the
[publication acceptance procedure](docs/runbooks/cutover-and-recovery.md#publication-acceptance)
before selecting a release; the receipt hash and exact trusted Infra revision are
deployment inputs.
The native verifier and fixture come from Service
`8dfb61b1ff4f671eed27d3a7cb8d315bed3d68ce`, with paths/hashes recorded in
[vendor provenance](scripts/vendor/provenance.json). Original CDK baseline
provenance remains separately recorded under `test/baselines`.

Read the [Beta operation runbook](docs/runbooks/beta-infrastructure.md) for exact
inputs and the [cutover and recovery runbook](docs/runbooks/cutover-and-recovery.md)
for bootstrap, retention, rollback and old-role retirement. Read
[AGENTS.md](AGENTS.md) before changing source. Keep live evidence and release
decisions in #54; these documents describe procedures, not successful executions.
