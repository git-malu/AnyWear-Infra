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

Infra exposes **3 entries / 2 manual dispatch surfaces / 1 switch**
(`ENABLE_BETA_MUTATION`): one automatic source check and one release/observe
chain per deployable unit. `production.yml` stays in the tree but is
`workflow_call`-only, so it is not an entry.

| Entry | Trigger | Purpose |
| --- | --- | --- |
| [check.yml](.github/workflows/check.yml) | PR / push `main` | CDK build and tests, contract/workflow tests, native-CLI regression, live-Foundation comparison and both source matrices; no dispatch surface |
| [runtime.yml](.github/workflows/runtime.yml) | manual `operation: state \| observe` | `state`: fixed AWS read-only state/SSM status, usable with the stage switch closed, no tasks or schema qualification. `observe`: the accepted `anywear_infra_deployment` v2 producer; runs the artifact-verification task |
| [mutate.yml](.github/workflows/mutate.yml) | manual `operation` (11 options) | `deploy-foundation`, `deploy-billing`, `deploy-platform`, `deploy-workload`, `restore-release`, `migrate`, `admission-status`, `add-testers`, `set-testers`, `suspend-admission`, `resume-admission` |
| [production.yml](.github/workflows/production.yml) | `workflow_call` only | Future Production scaffold with its tested pre-AWS blocker; not a dispatch entry until a separately reviewed onboarding PR completes its contract |
| [bin/infra.ts](bin/infra.ts), `deployScope=foundation` | CLI | Separate Foundation-only initial role bootstrap; no Service artifact input is required |
| [bin/infra.ts](bin/infra.ts), `deployScope=billing` | CLI | Separate account billing scope in `us-east-1`; application resources are not synthesized |
| [ecr-retention.mjs](scripts/ecr-retention.mjs) | CLI | Verify exact effective policy, protected current/rollback digests and completed expiration preview |
| [observe-deployment.mjs](scripts/observe-deployment.mjs) | CLI | Authenticate deployed templates, artifacts, configuration, schema and application identities |

The `mutate.yml` menu is a superset of the retired per-family files. A dispatch
surface is per workflow, so `identity_phase`, `retention_protection`,
`window_minutes`, `tester_emails`, `beta_api_sizing_profile` and
`beta_sizing_telemetry` are workflow-level inputs; `scripts/runtime-operation.mjs`
enforces their per-operation scope in preflight, before any credential. Only a
`deploy-*` operation or `restore-release` may vary identity phase and retention
protection; every other operation must run the `retired` / `true` context. Only
`add-testers` and `set-testers` accept a tester payload. Only `deploy-workload`
may change sizing or telemetry. Only `resume-admission` reads `window_minutes`,
with the same bounded 15–240 minute contract (default 60) as before. The
standalone `verify` operation is retired; the `verify` **task family** remains an
internal step of `deploy-workload`, `restore-release` and the tester/admission
operations.

`mutate.yml` is one credential-timing chain: `preflight` (no environment, no
`id-token`, no App token) → `verify` (read-only App token; native release
statement, publisher run, every asset digest, committed selection bytes and stack
sources) → `deploy` (**the only job** with `environment: beta` and
`id-token: write`, scheduled after `verify`) → `record` (no environment, no
`id-token`, no `environment:`). `runtime.yml` keeps the same invariant:
`preflight` holds no credentials, `state` and `observe` are the two credential
jobs, and `record` holds none. `state` runs with the stage switch closed;
`observe` stays behind it because it runs a task and produces the accepted
deployment record.

`state` and `observe` share `runtime.yml`, so the record family is derived from
the **operation**, not the file: `observe` keeps family `runtime` (the accepted
deployment-record producer), while `state` keeps family `beta-observe` and can
never be stamped `anywear_infra_deployment`. `deploy-*`/`restore-release` keep
`beta-deploy`, `migrate` keeps `beta-schema`, and the admission operations keep
`beta-admission`, so cross-repository record families stay stable. A
`deploy-platform` run is still qualified only by a following fixed `runtime.yml`
`observe` run at reviewed main; a mutate run uploads its own
`anywear_infra_family_observation` record with its actual workflow path
(`mutate.yml`), which is not an accepted E2E deployment input.

Every Beta entry requires exact reviewed main, protected `beta`, committed
selection/hash and reviewed stack sources/hash. Complete native release and
publisher-run verification happens before AWS credentials in both chains; the
restricted STS sessions are operation-specific and the read-only session carries
no ECS or PassRole permissions. Only mutation requires
`ENABLE_BETA_MUTATION=true`; read-only `state` remains available when it is
closed. Repository-local Actions concurrency (`anywear-infra-runtime`, no
cancellation) serializes Infra jobs; separate Client and E2E writers still require
scheduling coordination and verified cessation. Existing OIDC trust identifies
Infra/environment, not workflow; these source/session boundaries do not create an
IAM-enforced workflow trust boundary or restrict the capabilities of existing task
roles. The current CDK CloudFormation execution role uses `AdministratorAccess`
without a permissions boundary, so the deployment chain has account-wide
effective authority; the dedicated role names do not establish Beta resource
isolation. Production activation variables cannot bypass its source blocker; keep
both deployment/readiness gates disabled through #54.

Admission has one representation: `/anywear/beta/admission_mode`, a `String`
parameter whose value is a small JSON record. `{"mode":"closed"}` admits nothing;
`{"mode":"testers","expires_at":"<ISO instant>"}` admits only an exact-listed
tester or the anchored synthetic E2E namespace, and only until that instant.
`open` does not exist: Beta is tester-only by contract. Every reader applies the
same fail-closed rules — a missing, malformed, duplicated-key, non-canonical,
unknown-mode, extra-key, wrong-type or unparseable value reads closed, as does a
`testers` record without a canonical bound, a record carrying an explicit `null`
bound, a `closed` record carrying an instant, a past bound and a bound beyond 240
minutes plus the read's one-minute clock-skew allowance.
Because the value carries its own bound, an abandoned window closes itself on this
surface with no writer, no grant and no deployment.

`resume-admission` is the only operation an operator can request that opens
admission, and the only one whose one-shot authority lists the lifecycle `resume`
action. It requests a window through the `mutate.yml` entry point
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
input that can request it. `resume-admission` is therefore the only operation an
operator can *request* that opens admission.

A tester write (`add-testers` / `set-testers` through the lifecycle `set-testers`
action) writes the exact list and changes no admission state, so the flow for a
window is `add-testers` (optional) then `resume-admission`. `admission-status`
reports the effective mode every gate uses, the raw record each surface stores and
whether those raw records disagree, because after an abandoned window the database
still stores `testers` with a past bound while admission is closed. The standalone
`migrate` operation refuses unless the mirror proves closed admission: a closed record
or a tester window its own bound already ended, never a record that merely reads closed
because it is unreadable. [Beta
runbook](docs/runbooks/beta-infrastructure.md#admission-mode-migration-and-rollout)
carries the admission-mode migration order, its bounded failure mode and the resident
environment repair.

Both manual entries share `anywear-infra-runtime` without cancellation.
`runtime.yml` is the only workflow family whose run produces the legacy
`anywear_infra_deployment` v2 accepted by E2E, and record type and family are
derived from the dispatched operation; the standalone
[observe-deployment.mjs](scripts/observe-deployment.mjs) CLI can also emit an
accepted-shaped record from ambient environment variables without a workflow run.
Other operations emit `anywear_infra_family_observation` with their actual
workflow path (`mutate.yml` for the absorbed families); this is not an accepted
E2E deployment input. A `deploy-platform` run is therefore qualified only by a
following fixed `runtime.yml` `observe` run at
reviewed main, which uploads `infra-deployment-<run-id>-<attempt>` containing
`deployment-record.json`. A mutate run cannot produce that record: the
`deploy-platform` operation session carries no task family of its own, and the
observation step of the same run stamps the run's own
`mutate.yml` path and record type
`anywear_infra_family_observation`, while the accepted record pins both
`anywear_infra_deployment` and the `runtime.yml` workflow path, which the E2E
consumer pins too. The mutate run still requires and uploads its own family
observation. Read-only `state` emits sanitized `anywear_infra_state` inside
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
