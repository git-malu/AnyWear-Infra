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
canonical committed v2 selections. CI repeats all three phases with explicit
retention protection and uploads `cdk.matrix/comparison.json` and
`cdk.protected.matrix/comparison.json` as `infra-source-matrix`.

## Operations

| Entry point | Purpose |
| --- | --- |
| [runtime.yml](.github/workflows/runtime.yml) | Manual protected-main Beta deployment, migration, verification, lifecycle, observation and tester-allowlist operations |
| [bin/infra.ts](bin/infra.ts), `appScope=foundation` | Separate Foundation-only initial role bootstrap; no Service artifact input is required |
| [bin/infra.ts](bin/infra.ts), `appScope=billing` | Separate account billing scope in `us-east-1`; application resources are not synthesized |
| [ecr-retention.mjs](scripts/ecr-retention.mjs) | Verify exact effective policy, protected current/rollback digests and completed expiration preview |
| [observe-deployment.mjs](scripts/observe-deployment.mjs) | Authenticate deployed templates, artifacts, configuration, schema and application identities |
| [production.yml](.github/workflows/production.yml) | Future Production scaffold with a pre-AWS blocker until a separately reviewed onboarding PR completes its contract |

Every Beta operation requires protected exact main source, an explicit operation,
committed selection/hash, reviewed stack sources, identity phase and retention. Repository-local Actions concurrency serializes Infra jobs; separate
Client and E2E writers still require scheduling coordination and verified cessation.
Deployment and runtime credentials are distinct. The current CDK CloudFormation
execution role uses `AdministratorAccess` without a permissions boundary, so the
deployment chain has account-wide effective authority; the dedicated role names
do not establish Beta resource isolation.
Production activation variables cannot bypass its source blocker; keep both
deployment/readiness gates disabled through #54.

Artifact verification loads the actual committed canonical v2 selection at an
explicit trusted Infra root/full source pin and raw file hash. It checks the
immutable release/tag/source, all five asset identities/sizes/digests/bytes and
components, one complete native v0.1/v0.2 signed statement across six checks,
and exact completed-success publisher identity before and after verification.
Ordinary runtime performs these checks before AWS OIDC. Historical v1 inputs are
rejected; publication ZIP/receipt/handshake ceremony is retired. See the
[selection contract](docs/contracts/release-selection.md) and
[direct verification procedure](docs/runbooks/cutover-and-recovery.md#direct-release-verification).
