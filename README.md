# AnyWear Infra

Private repository for AnyWear's shared AWS CDK application and infrastructure
operations. Extraction is tracked in [AnyWear #54](https://github.com/git-malu/AnyWear/issues/54).

This repository contains the CDK app, a versioned constructs package, source
checks and reviewed Beta operation entry point. The verified #54 cutover assigns
Infra the sole operational Beta deployment queue. AnyWear-Service remains the
application, migration, verification and immutable artifact publisher; source
delivery alone does not establish AWS deployment or runtime acceptance.

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
checkouts or cloud credentials. The matrix compares dev active, Beta active and
prod active across the three identity phases against the preserved
Service source templates for the stack set this app still synthesizes
(Foundation, Base, Billing). Issue #166 removed the stopped Beta template: the
environment stops by deleting the Egress and Runtime stacks, so the Base template
has one variant. Fixture artifacts are a local stand-in for the
stage base's Service-built Lambda inputs; deployments download the sealed Service
release instead. CI repeats all three phases with explicit retention protection
and uploads `cdk.matrix/comparison.json` and
`cdk.protected.matrix/comparison.json` as `infra-source-matrix`.

## Stage contract

`AnyWearPlatformStack-beta` (the persistent `Base` stack) publishes the Beta stage
base as plain SSM parameters under `/anywear/beta/`. **35 names exist in every
identity phase and environment variant**: the public API distribution base URL
(`api_base_url`), the VPC and subnet tiers (public, private and isolated),
ECS cluster name and ARN, Aurora endpoint and secret, the three workload security
groups plus the one-shot task security group, the ECR repository identity, both
task queues, both queue and dead-letter-queue names and URLs, the wardrobe bucket
ARN, the operations topic, the CloudFront origin-facing prefix list id, the VLM
config secret ARN, and the one-shot verification/execution role ARNs and log
group name/ARN. One further name, `cleanup_task_role_arn`, is published only
while the identity phase creates the cleanup task role
(`identityPhase !== 'legacy'`). They join the four existing published names
(`cognito_user_pool_id`, `cognito_client_id`, `s3_bucket_name`,
`qweather_api_host`); the runtime-owned `admission_mode`, `tester_allowlist` and
`aws_region` parameters are not duplicated. Values come from the existing
Base resources; nothing reads another stack at deploy time. The ten values
added by the issue #158 extension replace the remaining weak
`Fn::GetStackOutput` reads; the Runtime stack resolves them from the stage
contract, so the Base/Runtime deploy order no longer matters. `private_subnet_ids` and
`isolated_subnet_ids` are the two Base subnet groups and are never empty
`StringList`s; the Egress stack adds the 0.0.0.0/0 routes to the Base-owned
Private route tables while it exists (Base keeps the route tables and their single
per-subnet associations).

Two values have no Base resource: `vlm_config_arn` and
`cloudfront_prefix_list_id` are reviewed constants read from the then-live
`AnyWearWorkloadStack-beta` parameters before the #166 split (account `650880818323`,
`ap-east-1`), recorded as identifiers only. They are changed only in a reviewed
diff. Any other stage must pass explicit values and fails closed without them.

Foundation no longer defines per-service deploy roles. Issue #195 retired
`beta-service-deploy-role` and `beta-service-deploy-cfn-role` with the Service
deploy chain: the release slice is deployed by `deploy-runtime` under the
existing `beta-infra-deploy-role`, which already assumes the standard CDK
bootstrap roles (`cdk-hnb659fds-deploy-role`, `-file-publishing-role`,
`-lookup-role`) and the bootstrap CloudFormation execution role
(`cdk-hnb659fds-cfn-exec-role-650880818323-ap-east-1`). The operation's own
preflight, change set and session policy are its scope; it does not claim IAM
isolation the bootstrap path does not provide. The live Foundation still carries
the four retired resources until a separately authorized `deploy-foundation`;
`test/fixtures/foundation-live-provenance.json` records them as
`pending_removal` and `beta-service-deploy-cfn-role` stays named by the live
Runtime stack's `RoleARN` until the first executed Runtime update rebinds it.
The Runtime stack's CDK source, baselines and deploy chain now live in this
repository (`lib/runtime-stack.ts`, `deployScope=runtime`), and `deploy-runtime`
with the Beta stage contract produces the v6 `anywear_service_deployment`
record, including the admitted `schema_boundary` comparison.

`beta-infra-runtime-role` (Platform `DedicatedPolicy`) gains two read-only
statements for the deployment bake (#195): `cloudwatch:DescribeAlarms` on
`beta-anywear-*` and `logs:FilterLogEvents` on `/anywear/beta/worker`.
`beta-infra-deploy-role` gains the change-set `Describe`/`Execute`/`Delete`
statements scoped to the Runtime stack and its change-set ARNs. Both are read or
operation-scoped; no managed policy or account-wide grant is added.

### Versioned `@git-malu/stage-contracts`

[`packages/stage-contracts/`](packages/stage-contracts/README.md) is the
dependency-free, versioned source of the stage-contract names/kinds, the stack
identities, the v6 `anywear_service_deployment` validators (the v3 core plus the
required 600-second bake gate and the admitted `schema_boundary` comparison), the
gate's one stage-free threshold table, the schema-boundary prefix hash, the
deployed-template normalisation and the two Infra deployment roles' scope. It is
`@git-malu/stage-contracts` `0.5.0`; the `stage-contracts-v0.5.0` tag is a post-merge publication step created at
Deployment, not by this change (`0.3.0` is the newest published tag and `0.4.0`
was never tagged), and the package is packed with `npm pack`. The package is
consumed in this repository as an in-repo dependency with one consumer
repository: there is no cross-repository pin, no vendored tarball and no
Service deploy job. Publishing is the separate tag-triggered
[publish workflow](.github/workflows/publish-stage-contracts.yml)
(`packages: write`, `GITHUB_TOKEN`). `lib/stage-contract.ts` and the runtime
record scripts consume or re-export the package, and `npm run check` runs its
tests.

Infra's own `anywear_infra_deployment` record stays schema v3 and keeps the
seven-member core (`DEPLOYMENT_RECORD_MEMBERS`); it is never forced to produce a
`gate` or a `schema_boundary`. The pre-gate v3 Service shape was never produced
(the Service deployment pin is deferred), and historical v2 records remain
readable for the audit path only.

## Operations

Infra exposes **3 entries / 2 manual dispatch surfaces / 1 switch**
(`ENABLE_BETA_MUTATION`): one automatic source check and one release/observe
chain per deployable unit. `production.yml` stays in the tree but is
`workflow_call`-only, so it is not an entry.

| Entry | Trigger | Purpose |
| --- | --- | --- |
| [check.yml](.github/workflows/check.yml) | PR / push `main` | CDK build and tests, contract/workflow tests, live-Foundation comparison and both source matrices; no dispatch surface |
| [runtime.yml](.github/workflows/runtime.yml) | manual `operation: state \| observe` | `state`: fixed AWS read-only state/SSM status, usable with the stage switch closed, no tasks or schema qualification. `observe`: the manual accepted `anywear_infra_deployment` v3 producer for the stacks Infra owns |
| [mutate.yml](.github/workflows/mutate.yml) | manual `operation` (14 options) | `deploy-foundation`, `deploy-billing`, `deploy-platform`, `deploy-egress`, `delete-egress`, `deploy-runtime`, `stop-runtime`, `restore-release`, `migrate`, `admission-status`, `add-testers`, `set-testers`, `open-admission`, `close-admission`. A deployment that changes a configured stack also produces the accepted `anywear_infra_deployment` v3 record in the same run: `preflight` → `verify` → `deploy` → `observe` → `record`. `deploy-runtime` produces its own v6 `anywear_service_deployment` record from the `deploy` job and is outside that v3 trigger set |
| [production.yml](.github/workflows/production.yml) | `workflow_call` only | Future Production scaffold with its tested pre-AWS blocker; not a dispatch entry until a separately reviewed onboarding PR completes its contract |
| [bin/infra.ts](bin/infra.ts), `deployScope=foundation` | CLI | Separate Foundation-only initial role bootstrap; no Service artifact input is required |
| [bin/infra.ts](bin/infra.ts), `deployScope=billing` | CLI | Separate account billing scope in `us-east-1`; application resources are not synthesized |
| [bin/infra.ts](bin/infra.ts), `deployScope=egress` | CLI | Separate disposable `AnyWearEgressStack-beta` scope; no Service artifact input |
| [migrate-beta-split.mjs](scripts/migrate-beta-split.mjs) | CLI (Deployment-gated) | One-time Base/Runtime split: three separately authorized stages, validation-only by default; see its runbook |
| [ecr-retention.mjs](scripts/ecr-retention.mjs) | CLI | Verify exact effective policy, protected current/rollback digests and completed expiration preview |
| [observe-deployment.mjs](scripts/observe-deployment.mjs) | CLI | Authenticate the deployed stage-base templates, Lambdas, queues, Client and stage-contract parameters |

The `mutate.yml` menu is a superset of the retired per-family files. A dispatch
surface is per workflow, so `identity_phase`, `retention_protection`,
`tester_emails`, `service_release_tag` and `service_commit` are
workflow-level inputs; `scripts/runtime-operation.mjs` enforces their
per-operation scope in preflight, before any credential. Only a `deploy-*`
operation or `restore-release` may vary identity phase and retention protection;
every other operation must run the `retired` / `true` context. Only
`add-testers` and `set-testers` accept a tester payload. Only `deploy-platform`,
`deploy-runtime` and `restore-release` take a Service release identity. Admission
takes no bound input: lifecycle `resume` is invoked with no payload at all. The
standalone `verify` operation is retired, and the
`verify`/`artifact-verify` task families left with the release slice; Infra no
longer runs a release-verification task.

`mutate.yml` is one credential-timing chain: `preflight` (no environment, no
`id-token`, no App token; publishes `requires_accepted_observation` from the
shared trigger set before any credential) → `verify` (read-only release token only
when the operation takes a Service release; reads the release and downloads the
operation's consumed set — three stage-base files, or only `service-schema.json`
for `deploy-runtime`) → `deploy` (**the only job** that holds the mutation role:
`environment: beta`, `id-token: write`, `INFRA_DEPLOY_ROLE_ARN`, scheduled after
`verify`) → `observe` (only when the operation changes a configured stack and the
mutation succeeded: the second credential job, with the read-only
`INFRA_RUNTIME_ROLE_ARN` only and no mutation role) → `record` (no environment, no
`id-token`, no `environment:`). `runtime.yml` keeps the same invariant:
`preflight` holds no credentials, `state` and `observe` are the two credential
jobs, and `record` holds none. `state` runs with the stage switch closed;
`observe` stays behind it because it produces the accepted deployment record.

`state` and `observe` share `runtime.yml`, so the record family is derived from
the **operation**, not the file: `observe` keeps family `runtime` (the manual
accepted deployment-record producer), while `state` keeps family `beta-observe`
and can never be stamped `anywear_infra_deployment`. `deploy-*`/`restore-release`
keep `beta-deploy`, `migrate` keeps `beta-schema`, and the admission operations
keep `beta-admission`, so cross-repository record families stay stable. A
deployment chain that changes a configured stack (`deploy-foundation`,
`deploy-billing`, `deploy-platform`, `restore-release`) produces the accepted
record inside the same run: its `observe` job writes the v3 record with producer
`.github/workflows/mutate.yml` and that run's id/attempt/source SHA, and the
mutation job's own evidence is uploaded as
`infra-family-observation-<run-id>-<attempt>`. `deploy-egress`/`delete-egress`,
`deploy-runtime`, `migrate`, the admission operations and read-only `state` are
outside that trigger set: the Egress stop/start drill reports its family
observation and is never marked incomplete for lacking an accepted record,
`deploy-runtime` writes the v6 `anywear_service_deployment` record itself (the
passed bake plus the admitted `schema_boundary` comparison) and runs
no separate `observe` job, a migration or admission write changes no recorded
stack, and `state` makes no record claim. The trigger set is
derived from the frozen stack tables in [operation-stacks.mjs](scripts/operation-stacks.mjs)
by [observation-record.mjs](scripts/observation-record.mjs), not restated in YAML.

Every Beta entry requires exact reviewed main and protected `beta`; the three
operations that take a Service release identity also require the reviewed
Service release tag and commit. The release-identity read and the operation's
consumed download happen before AWS credentials, and each travelled file is
re-hashed once in the deploy job before its restricted STS session; `deploy-runtime`
additionally strictly validates the travelled `service-schema.json` there, so the
schema-boundary gate later compares an asset this pre-credential check already
proved. The sessions are
operation-specific and the read-only session carries no ECS or PassRole
permissions. Only mutation requires
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
parameter whose value is a small JSON record with exactly one key. `{"mode":"closed"}`
admits nothing; `{"mode":"testers"}` admits only an exact-listed tester or the
anchored synthetic E2E namespace, until an explicit close. `open` does not exist:
Beta is tester-only by contract. Every reader applies the same fail-closed rules —
a missing, malformed, duplicated-key, non-canonical, unknown-mode, extra-key,
wrong-type or unparseable value reads closed, as does anything that is not exactly
one `mode` key, including the retired two-key record that carried `expires_at`. The
decision is a mode and nothing else: there is no bound, no clock and no expiry.
The tester list is the separate `/anywear/beta/tester_allowlist`, and opening never
changes it.

`open-admission` is the only operation an operator can request that opens
admission, and the only one whose one-shot authority lists the lifecycle `resume`
action. It takes no payload — the Service has no bound to write — refuses before
resuming unless the database decision is provably closed, the database policy
agrees with SSM and the mirror holds a `closed` record, and then proves the open
through the lifecycle status read-back. That read-back requires the running Service
to stop reporting the removed `admission_window_expires_at` field, so the absence
is the executable proof that the deployed revision has no window semantics; a
Service image from before this batch is refused. The operation record carries one
`admission-open-proof` event: the mode, its source, the tester count and hash, the
SSM record key set (`["mode"]`), the database status field absence and SSM/DB
agreement, so the record itself says "open, no bound, both surfaces agree".
Opening is the tester lane: the list is unchanged and no non-tester is admitted.

**Close is the only thing that closes.** `close-admission` restores the recorded
`closed` decision through the pinned lifecycle `suspend` and records whether it
ended an open admission (`ordinary`) or one already closed. There is no automatic
closure and no time-based backstop: if `open-admission` is interrupted after its
resume attempt, admission stays open until an explicit `close-admission` and an
`admission-status` read-back. The failed-open path issues one recovery-only
`suspend`, re-asserts the recorded decision and records `close_kind=failed-open`;
no operator input can request that action, and it does not make an interrupted open
self-healing.

A tester write (`add-testers` / `set-testers` through the lifecycle `set-testers`
action) writes the exact list and changes no admission state, so the flow is
`add-testers` (optional) then `open-admission`. `admission-status` reports the
effective mode every gate uses, the recorded mode, the record's key set and whether
those raw records disagree. The standalone `migrate` operation refuses unless the
mirror proves closed admission with a `closed` record — never a record that merely
reads closed because it is unreadable — so a stale `testers` record must be closed
explicitly first. [Beta
runbook](docs/runbooks/beta-infrastructure.md#admission-open-and-close)
carries the mode-only contract, the post-open proof and the resident environment
repair.

Both manual entries share `anywear-infra-runtime` without cancellation. A run of
either entry can produce the accepted `anywear_infra_deployment` v3 record, and
record type and family are derived from the dispatched operation: `runtime.yml`
`observe` and the deployment chain's `observe` job both write it, each bound to its
own run, attempt, source SHA and workflow path. The record covers the stacks Infra
still produces (Foundation, the Beta stage base, Billing), the stage-contract
parameters the run read and a derived schema content hash; it contains no
`selection`. The Infra `deploy-runtime` operation produces the v6
`anywear_service_deployment` for `AnyWearRuntimeStack-beta` from the same generic
contract; the record types and families stay distinct, so neither record type can
claim the other's stacks. Other operations emit `anywear_infra_family_observation`
with their actual workflow path (`mutate.yml` for the absorbed families); this is
not an accepted E2E deployment input. A deployment chain uploads the accepted
record as `infra-deployment-<run-id>-<attempt>` containing
`deployment-record.json`, and its mutation job's family observation as
`infra-family-observation-<run-id>-<attempt>`, so the accepted contract and the
chain's own evidence never share an artifact name. When the accepted record is
missing after a completed mutation, the credential-free `record` job marks the
operation record `partial` with `requires-explicit-recovery` and an
`accepted-deployment-record` event, preserves it through its `if: always()` upload
and fails the run. Read-only `state` emits sanitized `anywear_infra_state` inside
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

The stage base's Service-built Lambda assets come from a reviewed Service release
identity: `deploy-platform`/`restore-release` take `service_release_tag` and
`service_commit`, read the sealed release and its tag ref over the REST API,
require the two Lambda bundles and the runtime policy to be present, uploaded and
digest-valid (extras such as the retired legacy manifest are ignored), download
only those three, and re-hash each travelled byte once in the deploy job before
any credential. `deploy-runtime` takes the same identity but downloads only the
release's `service-schema.json`, re-hashes it once and strictly validates it
before credentials, then compares it with the live applied journal before any
stack mutation (the `schema_boundary` member of the v6 record). The deploy
records the release tag, Service commit and the ECR
digest of the immutable `service-artifacts-<service_commit>` tag. There is no
committed selection, no release manifest, no vendored Service parser
and no cross-repository native-attestation path; publication ZIP/receipt/handshake
ceremony stays retired. See the
[direct release identity procedure](docs/runbooks/cutover-and-recovery.md#direct-release-identity).
