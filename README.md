# AnyWear Infra

Private repository for AnyWear's shared AWS CDK application and infrastructure
operations. Extraction is tracked in [AnyWear #54](https://github.com/git-malu/AnyWear/issues/54).

This repository contains the CDK app, source checks and reviewed Beta operation
entry point. The verified #54 cutover assigns Infra the sole operational Beta
deployment queue. AnyWear-Service remains the application, migration,
verification and immutable artifact publisher; source delivery alone does not
establish AWS deployment or runtime acceptance.

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

The accepted #54 IAM boundary is deliberately scoped: the named legacy Beta role
retains deny-only trust and zero inline or attached grants, while the inherited
Dev wildcard E2E subject, `cdk-*` assume-role chain and CloudFormation execution
role with `AdministratorAccess` and no permissions boundary remain unchanged.
Infra's operational queue is not an account-wide IAM exclusivity or Beta
resource-isolation claim. The practical pinned recovery was [stop
37886520975](https://github.com/git-malu/AnyWear-Infra/actions/runs/37886520975)
followed by [start 37887802281](https://github.com/git-malu/AnyWear-Infra/actions/runs/37887802281),
both at historical Infra producer `bafc3072ea6aee2d5193009c014cb1cf04b43848`
with Service release `407218593`. Active `restore-release` and automatic
failure recovery were not exercised; historical release `406706155` remains
preserved evidence but is byte-incoherent and unselectable.

The final correctness qualification is [E2E run
37949887097](https://github.com/git-malu/AnyWear-E2E/actions/runs/37949887097),
with correlated cleanup [Service run
37950914153](https://github.com/git-malu/AnyWear-Service/actions/runs/37950914153)
and admission closure [Infra run
37951949885](https://github.com/git-malu/AnyWear-Infra/actions/runs/37951949885).
These records retain the deployed Client `8320db0816b1c2d36e79a583160548744fd3d8c0`
and Service `ab211c8212444b735e614ef9a74f184d24744d6b` identities separately
from newer executor heads. Public registration remained intentionally skipped
while intake was closed; the recorded provider timeout/retry case is a
correctness observation, not a latency guarantee.

Artifact verification loads the actual committed canonical v2 selection at an
explicit trusted Infra root/full source pin and raw file hash. It checks the
immutable release/tag/source, all five asset identities/sizes/digests/bytes and
components, one complete native v0.1/v0.2 signed statement across six checks,
and exact completed-success publisher identity before and after verification.
Ordinary runtime performs these checks before AWS OIDC. Historical v1 inputs are
rejected; publication ZIP/receipt/handshake ceremony is retired. See the
[selection contract](docs/contracts/release-selection.md) and
[direct verification procedure](docs/runbooks/cutover-and-recovery.md#direct-release-verification).
