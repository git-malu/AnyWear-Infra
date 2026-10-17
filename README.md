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
| [runtime.yml](.github/workflows/runtime.yml) | Fixed qualified `observe`; preserves the existing E2E trusted v2 producer interface; starts an ECS verification task |
| [beta-observe.yml](.github/workflows/beta-observe.yml) | Fixed AWS read-only state/SSM status; usable with activation disabled; no tasks or schema qualification |
| [beta-lifecycle.yml](.github/workflows/beta-lifecycle.yml) | `start` / `stop` with the existing coordinated sequence |
| [beta-deploy.yml](.github/workflows/beta-deploy.yml) | Four `deploy-*` operations and closed-admission `restore-release`; a `deploy-platform` run is qualified only by a following fixed `runtime.yml` `observe` |
| [beta-schema.yml](.github/workflows/beta-schema.yml) | Selected-image `migrate` / `verify` tasks; `migrate` alone refuses unless the admission mirror proves closed admission |
| [beta-admission.yml](.github/workflows/beta-admission.yml) | `admission-status`, `add-testers`, `set-testers`, `suspend-admission`, `resume-admission`; `resume-admission` is the only operator-requestable opener and requests a bounded 15–240 minute window (default 60) that ends at its own bound and runs the recovery-only suspend a failed window needs; a tester write changes no admission state; status still starts tasks |
| [bin/infra.ts](bin/infra.ts), `deployScope=foundation` | Separate Foundation-only initial role bootstrap; no Service artifact input is required |
| [bin/infra.ts](bin/infra.ts), `deployScope=billing` | Separate account billing scope in `us-east-1`; application resources are not synthesized |
| [ecr-retention.mjs](scripts/ecr-retention.mjs) | Verify exact effective policy, protected current/rollback digests and completed expiration preview |
| [observe-deployment.mjs](scripts/observe-deployment.mjs) | Authenticate deployed templates, artifacts, configuration, schema and application identities |
| [production.yml](.github/workflows/production.yml) | Future Production scaffold with a pre-AWS blocker until a separately reviewed onboarding PR completes its contract |

Every Beta entry requires exact reviewed main, protected `beta`, committed
selection/hash, reviewed stack sources/hash and complete native release/publisher
verification before AWS credentials. Only deployment/lifecycle expose explicit
identity phase and retention inputs; other entries fix a protected source context
without asserting observed IAM state or changing CFN. Only admission accepts
tester payloads. All task/deployment entries require `ENABLE_BETA_DEPLOY=true`;
read-only state remains available when false. Repository-local Actions concurrency serializes Infra jobs; separate
Client and E2E writers still require scheduling coordination and verified cessation.
Deployment and runtime credentials are distinct, with operation-specific STS
session restrictions and source/IO guards. Final qualification assumes another
restricted runtime session permitting only the artifact-verifier task and its
verification/execution PassRole. The read-only session has no ECS or PassRole
permissions. Existing OIDC trust identifies Infra/environment, not workflow;
these source/session boundaries do not create an IAM-enforced workflow trust
boundary or restrict the capabilities of existing task roles. The current CDK CloudFormation
execution role uses `AdministratorAccess` without a permissions boundary, so the
deployment chain has account-wide effective authority; the dedicated role names
do not establish Beta resource isolation.
Production activation variables cannot bypass its source blocker; keep both
deployment/readiness gates disabled through #54.

Admission has one representation: `/anywear/beta/admission_mode`, a `String`
parameter whose value is a small JSON record. `{"mode":"closed"}` admits nothing;
`{"mode":"testers","expires_at":"<ISO instant>"}` admits only an exact-listed
tester or the anchored synthetic E2E namespace, and only until that instant.
`open` does not exist: Beta is tester-only by contract. Every reader applies the
same fail-closed rules — a missing, malformed, duplicated-key, unknown-mode,
extra-key, wrong-type or unparseable value reads closed, as does a `testers`
record without a canonical bound, a `closed` record carrying one, a past bound and
a bound beyond 240 minutes plus the read's one-minute clock-skew allowance.
Because the value carries its own bound, an abandoned window closes itself on this
surface with no writer, no grant and no deployment.

`resume-admission` is the only operation an operator can request that opens
admission, and the only one whose one-shot authority lists the lifecycle `resume`
action. It requests a window through the existing `beta-admission.yml` entry point
with an explicit `window_minutes` bound of 15–240 minutes (default 60). That
requestable bound is what the dispatch input, the one-shot payload guard and the
writer all carry, so a window can be neither longer nor requested by another
route; the Service reader then allows a named one-minute clock-skew tolerance on
top, because the writing one-shot container and the reading task are separate
clocks, so a window written at exactly 240 minutes does not read closed. The
window is the tester lane: the tester list is unchanged and no non-tester is
admitted. **It ends at that bound without anyone acting.** `suspend-admission`
restores the recorded decision early and records whether it ended a live window
(`ordinary`) or one the bound had already ended (`recovery`), classifying from the
database's stored pair rather than from the mirror. A window that fails after the
resume attempt issues the same pinned `suspend`, re-asserts the recorded decision
and records `close_kind=failed-window` rather than leaving a window open.
`suspend` is the only extra lifecycle action `resume-admission` may run, and it is
recovery-only: reachable from that failed-window path alone, with no operator
input that can request it. The same caveat applies to the stopped image's `drain`,
which restores the window it found: that is state restoration, not a new opening,
so the claim is that `resume-admission` is the only operation an operator can
*request* that opens admission.

A tester write (`add-testers` / `set-testers` through the lifecycle `set-testers`
action) writes the exact list and changes no admission state, so the flow for a
window is `add-testers` (optional) then `resume-admission`. `admission-status`
reports the effective mode every gate uses, the raw record each surface stores and
whether those raw records disagree, because after an abandoned window the database
still stores `testers` with a past bound while admission is closed. The standalone
`migrate` operation and the `start` migration sequence refuse unless the mirror
proves closed admission: a closed record or a tester window its own bound already
ended, never a record that merely reads closed because it is unreadable. [Beta
runbook](docs/runbooks/beta-infrastructure.md#admission-mode-migration-and-rollout)
carries the admission-mode migration order, its bounded failure mode and the
stopped-environment repair.

All six manual entries share `anywear-infra-runtime` without cancellation.
`runtime.yml` is the only workflow family whose run produces the legacy
`anywear_infra_deployment` v2 accepted by E2E; the standalone
[observe-deployment.mjs](scripts/observe-deployment.mjs) CLI can also emit an
accepted-shaped record from ambient environment variables without a workflow run.
Other task families emit `anywear_infra_family_observation` with their actual
workflow path; this is not an accepted E2E deployment input. A `deploy-platform`
run is therefore qualified only by a following fixed `runtime.yml` `observe` run at
reviewed main, which uploads `infra-deployment-<run-id>-<attempt>` containing
`deployment-record.json`. A deploy run cannot produce that record: the
`deploy-platform` operation session carries no task family of its own, and the
observation step of the same run stamps the run's own
`.github/workflows/beta-deploy.yml` path and record type
`anywear_infra_family_observation`, while the accepted record pins both
`anywear_infra_deployment` and the `runtime.yml` workflow path, which the E2E
consumer pins too. The deploy run still requires and uploads its own family
observation. Read-only observation emits sanitized `anywear_infra_state` inside
its operation record and makes no DB/policy/schema claim. See the [Beta
runbook](docs/runbooks/beta-infrastructure.md) for dispatch schemas, permissions,
lifecycle authority and recovery.

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
