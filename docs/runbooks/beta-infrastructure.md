# Reviewed Beta infrastructure operations

This runbook describes the bounded source entry points delivered by
[AnyWear #104](https://github.com/git-malu/AnyWear/issues/104), retaining the
independent historical cutover evidence from [AnyWear #54](https://github.com/git-malu/AnyWear/issues/54).
The verified cutover assigns Infra the sole operational Beta deployment queue.
AnyWear-Service remains the application, migration, verification and immutable
artifact publisher. Account `650880818323` uses `ap-east-1` for the application
and `us-east-1` for Billing. The cutover preserved the observed
image/Client/Lambda/policy tuple and endpoints; ordinary source merges do not
choose a newer application.

The accepted IAM boundary is limited to the named legacy Beta role: its trust is
deny-only with zero inline or attached grants. The inherited Dev wildcard E2E
subject, `cdk-*` assume-role chain and CloudFormation execution role with
`AdministratorAccess` and no permissions boundary remain unchanged and outside
this runbook's #54 claim. Operational single-queue ownership is not account-wide
IAM exclusivity or Beta resource isolation.

## Issue #166: three Beta stacks

Beta is three stacks with disjoint lifetimes. `Base` (`AnyWearPlatformStack-beta`,
physical name retained) holds the VPC and its subnets plus each subnet's route
table and association, Aurora, S3, Cognito, ECR, SQS, SSM parameters and both
CloudFront distributions and is persistent. `Egress` (`AnyWearEgressStack-beta`)
holds only the NAT, EIP, the 0.0.0.0/0 default routes in the Base-owned private
route tables, and the S3 gateway endpoint, and is deleted on stop; it creates no
route table and no subnet route-table association (AWS allows one association per
subnet and Base owns it). `Runtime` (`AnyWearRuntimeStack-beta`, Service-owned; it
replaced the old Workload identity) holds the ALB, ECS services/task definitions,
log groups and the cleanup operation and is deleted on stop.

There is no `environmentRunning` switch, no `BetaActive` output and no stopped
template. Run state is one fact: whether the Runtime stack exists. Stop deletes
Runtime then Egress; start recreates Egress then Runtime; `restore-release`
requires Runtime to exist ("start first"). A Base mutation still reads Runtime
terminal first (one writer), and a missing Runtime is the stopped state rather
than an inactive variant to maintain. The one-time Base/Runtime split migration
is Deployment-gated: see [beta-split-migration.md](beta-split-migration.md).

## Step C: the release slice left this repository

After #158 step C, Infra owns Foundation, the Beta Base stack, Egress and Billing
only. The Service release slice's CDK source and deploy chain live in
AnyWear-Service. The only path that can deploy that stack is Service's release
chain, and that path needs the deferred Foundation deploy (the two Service deploy
roles from step A, plus the round-3 CLI-path grants to `beta-service-deploy-role`:
the `cdk-bootstrap/hnb659fds/version` parameter, the dedicated
`cdk-hnb659fds-assets-650880818323-ap-east-1` template object, and that bucket's
list and location reads; no `cdk-hnb659fds-*` role assumption) and Service's own
`ENABLE_BETA_MUTATION=true`. Until that
round no workload deploy may be attempted from anywhere, and no Infra entry may
re-add one. The committed `selection`/`stack_sources` contract, its double-write
window, the cross-repository native-asset verification and the vendored Service
parser were deleted; `deploy-platform` and `restore-release` take one reviewed
Service release identity (`service_release_tag` + `service_commit`) and download
that sealed release's Lambda bundles, runtime policy and manifest before any
credential. Deployment records are v3 and contain no `selection`.

**Do not deploy the post-C Platform template while Service's slice still reads
`PublishOutput*` outputs.** CDK's weak cross-stack reference feature emits those
outputs into the stage base only while the slice is synthesized in the same app;
after C a Platform deploy no longer emits them. The issue #158 extension
publishes the ten additional SSM parameters (`cleanup_task_role_arn` only outside
`legacy`, plus verification/one-shot role ARNs, one-shot log-group name/ARN,
one-shot security-group id, cluster ARN, both DLQ URLs and `isolated_subnet_ids`)
that Service's step D converts the remaining reads to, so once C and D are both
deployed the Platform/Workload deploy order no longer matters. Until D lands,
schedule the Platform deploy after (or with) that change. Both matrices record
the final Platform template exactly: the Platform baselines were re-recorded
without the `PublishOutput*` outputs and with the new parameters, so the
comparison has no removal allowance.

The practical pinned recovery was [stop 37886520975](https://github.com/git-malu/AnyWear-Infra/actions/runs/37886520975)
followed by [start 37887802281](https://github.com/git-malu/AnyWear-Infra/actions/runs/37887802281),
using historical Infra producer `bafc3072ea6aee2d5193009c014cb1cf04b43848`
and coherent Service release `407218593`. Active `restore-release` and
automatic failure recovery remain unexercised. Historical release `406706155`
is preserved evidence only: its runtime-policy bytes are incoherent, so it is
not a selectable rollback input.

The final correctness qualification is [E2E run 37949887097](https://github.com/git-malu/AnyWear-E2E/actions/runs/37949887097),
with correlated cleanup [Service run 37950914153](https://github.com/git-malu/AnyWear-Service/actions/runs/37950914153)
and final admission closure [Infra run 37951949885](https://github.com/git-malu/AnyWear-Infra/actions/runs/37951949885).
It preserves deployed Client `8320db0816b1c2d36e79a583160548744fd3d8c0` and
Service `ab211c8212444b735e614ef9a74f184d24744d6b` identities separately from
the newer executor heads. Public registration was intentionally skipped while
intake was closed; the observed provider timeout/retry case establishes
correctness only, not a latency SLA.

## Protected source and direct immutable inputs

The recorded setup has a `beta` environment restricted to main and an activation
gate `ENABLE_BETA_MUTATION=false`. The private plan returned 403 for branch
protection/rulesets; environment restriction is not repository branch protection.
Review exact source and inputs, coordinate one writer and freeze conflicting
Service/Client/E2E operations during #54 rollout. Enumerate Actions/local helpers,
CFN operations and ECS tasks; timeout or repository concurrency cannot prove peer
cessation. Ordinary Infra operations share `anywear-infra-runtime` with the
source-disabled Production workflow.

Environment configuration supplies account `650880818323`, region `ap-east-1`,
`INFRA_DEPLOY_ROLE_ARN=arn:aws:iam::650880818323:role/beta-infra-deploy-role`,
`INFRA_RUNTIME_ROLE_ARN=arn:aws:iam::650880818323:role/beta-infra-runtime-role` and
the activation gate. `deploy-platform` and `restore-release` supply `service_release_tag` and
`service_commit`; every other operation rejects those inputs. Operation,
identity/retention and tester inputs are exposed only by the
relevant family in the [entry-point table](#entry-points). Admission takes no
bound input: lifecycle `resume` is invoked with no payload. Deployment records are
v3 (`anywear_infra_deployment`) with a producer identity, the configured stack
set, the stage-contract parameters read (name, version, value hash), the
authenticated observation and a derived schema content hash.

Before App credentials, source guards require the exact Infra Git origin/full
HEAD, main runtime workflow/account/region and clean tracked/untracked checkout.
`deploy-platform` and `restore-release` additionally carry the reviewed Service
release tag and source commit. Before AWS OIDC, a read-only Service token
downloads the sealed release (`service-artifacts.json`, `pre-sign-up.zip`,
`post-confirmation.zip`, `runtime-policy.json`) and every downloaded byte is
proved against the release manifest; the manifest's image source must equal the
reviewed commit. There is no selection schema, native attestation, vendored
parser or publisher-run identity check on this path. See
[direct release identity](cutover-and-recovery.md#direct-release-identity).

Runtime uses the reviewed main workspace and `GITHUB_SHA`. Every deployment record
is v3 and carries the authenticated Original template hashes, the stage-contract
parameter versions/value hashes it read and the derived schema content hash.
`APP_PRIVATE_KEY` stays in protected secrets and is used only by the two
operations that take a release. Publication ZIP/receipt/handshake ceremony stays
retired.

The former `stack-sources/<reviewed-name>.json` map (four rows: `stack_name`,
`region`, `source_repository`, `source_sha`) was deleted in #158 step C with the
selection contract. The configured stack set is now code
(`scripts/operation-stacks.mjs`): Foundation, the Beta stage base and Billing.
Actual authenticated CFN Original hashes remain independent evidence.

The historical committed Beta restart map (deleted with the selection contract)
retained
Foundation's accepted Infra bootstrap source
`88679b61630bc2344258cafb0d35b4d0b02e3a0d` and Billing's Service source
`58444ebe15a0ea08ca8f0c8aa91d0ba8a7bfb759`. Their historical operation and
preservation-overlay evidence remains independent of these four-key rows.
Platform and Workload use Infra `@executor` because `restore-release` reconciles both
stacks; the merge's actual reviewed main SHA becomes their producer only after the
operation succeeds.

Keep that reviewed main fixed through the protected deployment and subsequent
observation. The map is valid for later `observe` at the same SHA after both
deployments; using it at a newer main would wrongly relabel unchanged stacks.
Observation from newer main requires a separately reviewed fixed map preserving the
actual deployed Platform/Workload SHAs. E2E v3 qualification consumes no deployment
record and binds no Infra source: it observes the platform itself (three stacks, the
SSM inputs, both Lambdas, both queues and the Client domain, before and after the
suite). Deployment-record lineage belongs to #181. This source map alone is not
runtime proof or authorization to deploy.

## Entry points

Infra exposes three entries and two manual dispatch surfaces. `check.yml` is
automatic; `runtime.yml` (`state`, `observe`) and `mutate.yml` (the ten
mutation operations) are the only manual dispatch surfaces; `production.yml` is
`workflow_call`-only and not an entry. Both manual entries use exact reviewed
main, the `beta` environment and shared non-cancelling queue
`anywear-infra-runtime`. Their local composites split verification from
execution: [verify-operation](../../.github/actions/verify-operation/action.yml)
rejects cross-family operations, validates the reviewed Service release identity
for the two operations that take one, and verifies the downloaded sealed-release
bytes against its manifest before App credentials, and verifies the
complete immutable Service release/publisher before AWS credentials;
[deploy-operation](../../.github/actions/deploy-operation/action.yml) binds the
verified-inputs artifact, obtains the operation-specific restricted STS session,
runs the operation and finalizes the evidence. Only mutation requires
`ENABLE_BETA_MUTATION=true`; read-only `state` remains available when it is
closed. The environment restricts branches to main; no required-reviewer rule is
currently configured. Approval and writer allocation remain separate operational
gates.

| Workflow | Dispatch operation | Additional inputs / AWS boundary |
| --- | --- | --- |
| [check.yml](../../.github/workflows/check.yml) | none (PR / push main) | Source checks only; no dispatch surface |
| [runtime.yml](../../.github/workflows/runtime.yml) | `state`, `observe` | `state`: CFN and SSM read-only session, no tasks/PassRole/deploy role or schema assertion, works with the switch closed. `observe`: qualified observation of the stacks Infra produces; the accepted `anywear_infra_deployment` v3 producer |
| [mutate.yml](../../.github/workflows/mutate.yml) | `deploy-foundation`, `deploy-billing`, `deploy-platform`, `restore-release`, `migrate`, `admission-status`, `add-testers`, `set-testers`, `open-admission`, `close-admission` | Chain: `preflight` → `verify` → `deploy` (only job with `environment: beta` and `id-token: write`) → `record` (no credentials). Explicit identity phase/retention accepted but only vary for `deploy-*`/`restore-release`; stack-specific deployment and selected verification tasks; `deploy-platform` is qualified only by a following fixed `runtime.yml` `observe` |
| [production.yml](../../.github/workflows/production.yml) | none (`workflow_call` only) | Future Production scaffold; source-disabled pre-AWS blocker; not an entry |

`deploy-platform` and `restore-release` require the reviewed Service release tag
and source commit; every other operation rejects them.
Because one dispatch surface now hosts several operations, the per-operation
input scope is enforced in `scripts/runtime-operation.mjs` preflight rather than
by file presence: the tester payload belongs only to `add-testers`/`set-testers`,
admission accepts no bound input, and identity
phase/retention protection may vary only for `deploy-*`/`restore-release` (every
other operation runs `retired`/`true`). Sizing/telemetry are no longer inputs:
they belong to Service's release chain.
Non-deployment operations fixing `retired`/`true` source context does not change
CFN or prove observed IAM/retention state. Deployment and admission dispatches
require explicit authorization. Beta's paid compute and egress stop by deleting
the Runtime and Egress stacks, and start by recreating Egress then Runtime; no
operation selects a stopped Base template. Source delivery alone does not grant an
environment writer or establish runtime acceptance.

Every STS assumption includes an inline session restriction of at most 2048
characters. Task register/run/PassRole are limited to the operation's exact
families/roles; source guards also validate helper command/action. Direct writes
to ECR/SSM and unrelated tasks/deployments are rejected. Final qualification uses
a distinct session allowing only `artifact-verify` plus verification/execution
PassRole. Inherited credentials/profile/config are discarded. No role/grant/trust
or CDK resource is added. Existing OIDC trust binds Infra/environment, not workflow;
these reviewed source/session checks do not enforce workflow identity in IAM or
restrict the existing task roles' application privileges. Downstream CDK authority
remains unchanged. Unsupported reads still fail against existing role grants.
Every runtime CDK call explicitly selects `legacyRoleSource=external` for
this account. Foundation never constructs or adopts the external legacy roles.
The `cdk` source/simulation mode is used only by the independently labeled
Service baseline matrices and cannot substitute for the live Original comparison.

| Operation | Behavior |
| --- | --- |
| `deploy-foundation` | Reconcile existing Foundation with reviewed identity phase; takes no Service release identity and no committed selection |
| `deploy-billing` | Reconcile existing Billing in `us-east-1` |
| `deploy-platform` | Deploy the persistent Base stack from one reviewed Service release identity (`service_release_tag` + `service_commit`): the verify job downloads that sealed release's Lambda bundles, runtime policy and manifest with a read-only token and proves every byte against the manifest before any credential. A Base deploy requires the Runtime slice to be terminal when present (one writer) and reads its `ApiLoadBalancerDnsName` as the distribution origin; qualified only by a following fixed `runtime.yml` `observe` run, because this run's own observation record is a family observation |
| `deploy-egress` / `delete-egress` | Create or delete only `AnyWearEgressStack-beta`, the disposable NAT/EIP/default-route/S3-endpoint edge. It imports the Base VPC, NAT-placement subnet and private route-table ids from the Base CloudFormation exports and creates only the 0.0.0.0/0 routes in those tables (no route table, no association). `delete-egress` refuses unless the Runtime stack is absent, so the stop order is Runtime then Egress. Include these inputs only for their own operation |
| `restore-release` | Reconcile only `AnyWearPlatformStack-beta`; require retired identity, protected retention, closed admission and an existing terminal Runtime ("start first") before and after; never deploy, verify or recover the Runtime slice |
| ~~`deploy-workload`~~ | Removed in #158 step C; the slice was renamed to Runtime in #166 and is deployed only by AnyWear-Service's release chain |
| `migrate` | Invoke Service's forward migration command in the selected immutable image |
| `verify` | Invoke Service's verification command; verify the selected runtime without migrating |
| `observe` | Collect authenticated active-Beta deployment evidence by launching a verification task; not AWS read-only |
| `state` | Record Base/Runtime status and Runtime existence plus sanitized SSM admission state; no DB/schema/policy qualification |
| `admission-status` | Read the admission mode, the record's key set, the tester list and the database status through the selected existing Service lifecycle command. The record publishes the effective decision every gate uses, the recorded mode each surface stores and whether those raw records disagree |
| `add-testers`, `set-testers` | Update the exact normalized tester list using the selected lifecycle `set-testers` command, which refuses while admission is not provably closed. The write changes no admission state and cannot open admission: no admission operation may run `resume` except `open-admission`, and the record's admission read-back shows the mode and key set unchanged. Open admission separately with `open-admission` |
| `open-admission` | Refuse before resuming unless the selected Service's status proves effective closure and DB/SSM agreement, the database decision is closed and the mirror holds a `closed` record; then resume with **no payload**, re-read SSM and require the database status to report `testers`, matching policy and **no** `admission_window_expires_at` field. Records `admission-open-proof` (mode, source, tester count/hash, SSM record key set, database status field absence, SSM/DB agreement). The tester list is unchanged. Its only extra lifecycle action is the recovery-only `suspend` a failed open issues; no operator input can request it |
| `close-admission` | Close admission through its pinned lifecycle `suspend`, then prove effective DB/SSM agreement and preserve the observed tester list; The Runtime stack must exist and be terminal. Records whether it ended an open admission (`ordinary`) or one already closed (`already-closed`) from the database status |

A dispatch uses explicit inputs, for example:

```sh
gh workflow run mutate.yml --repo git-malu/AnyWear-Infra --ref main \
  -f operation=deploy-platform \
  -f service_release_tag="$SERVICE_RELEASE_TAG" -f service_commit="$SERVICE_COMMIT"
```

For state-only observation dispatch `runtime.yml` with `operation=state`; it works
with the stage switch closed. For mutation select `mutate.yml` and its operation,
adding identity/retention only for `deploy-*`/`restore-release`, tester payload
only for `add-testers`/`set-testers`, and the release identity only for
`deploy-platform`/`restore-release`. Admission takes no additional input.
`observe` is dispatched through
`runtime.yml`; the workflow path that produces the accepted deployment record does
not change. Initial role bootstrap uses the
[Foundation-only procedure](cutover-and-recovery.md#foundation-only-bootstrap),
because no sealed Service release is needed to create the artifact publisher role.

### Foundation service set

The Foundation deploy reconciles the reviewed `infraServices` CDK context set: an
array of `{ service, repository, repositoryId, environment }` descriptors, each
naming one workload service's deployment identities. The default is exactly the
single `service` descriptor (repository `AnyWear-Service`, repository id
`1158460323`, environment `beta`), so the default deploy is unchanged. Role names
(`beta-<service>-deploy-role`, `beta-<service>-deploy-cfn-role`) and the immutable
OIDC subject derive from the descriptor, so an additional service is a context
value carried by a Foundation deploy — the Foundation-only CLI entry with
`-c infraServices='[...]'`, or any reviewed dispatch that passes the same context —
never an edit to Infra source. The context is strict: an unknown descriptor key, a
malformed value, a duplicate service, a missing default service or a changed
default descriptor fails synthesis before any resource is created. A second
service adds only its own two roles and policies, scoped to its own workload stack
and resource families; the existing service's resources are unchanged.

## Retained Beta sizing (release-slice parameter, Service-owned)

Issue #95 adds retained Workload parameters without changing lifecycle authority.
`BetaApiSizingProfile` defaults to `s1` (API CPU 512 / memory 1024 MiB); `s2-api`
selects CPU 256 / memory 512 MiB together. The S2 profile remains an unqualified
candidate until same-image acceptance and recovery evidence are recorded.
Worker remains CPU 1024 / memory 2048 MiB, and API desired/minimum counts stay 1/1.
`BetaSizingTelemetry` defaults to `false` and supplies `BETA_SIZING_TELEMETRY`
to both API and Worker. The selected Service artifact must implement the telemetry
contract, and its behavior must be accepted before enabling it; Infra source checks
alone do not establish that application behavior.

`BetaApiSizingProfile` and `BetaSizingTelemetry` are parameters of
`AnyWearWorkloadStack-beta`. After #158 step C they are set and changed by
AnyWear-Service's release chain; Infra has no operation input for them and only
reads the retained values when it reports Beta state.
A pre-parameter deployment means S1 and telemetry off. Unknown retained values
fail closed in the state reader. `runtime.yml` state/observe has no sizing or
telemetry input, and no Infra operation can change either parameter; sizing
changes are dispatched from AnyWear-Service's release chain. Neither input starts
or stops Beta or grants an environment writer. State-only observation records the
retained values but cannot prove running telemetry.

After measurement, the rollout that disables telemetry is dispatched from
AnyWear-Service's release chain with `beta_sizing_telemetry=disable`, the unchanged
Service image and Service's own reviewed release inputs. Infra has no operation or
input for it. (Historical: before #158 step C this was Infra's `deploy-workload`
operation with `beta_api_sizing_profile=s1` to restore S1 or `preserve` to retain
an accepted profile, the unchanged Service image and a committed stack-source
binding. That operation and the stack-source map are deleted, so the command cannot
run from here.) Verify `BetaSizingTelemetry=false`, both actual containers reporting
telemetry `false`, stable service rollout and the final observer/health result. An
ordinary `preserve` input does not disable telemetry. A stopped Beta has no
Runtime stack, so there is no stopped template to reactivate; start by deploying
Egress and the Service release first. This source delivery does not claim deployment, runtime acceptance or
telemetry-off restoration.

## Tester and cleanup ownership

Admission dispatch alone supplies `tester_emails` as a JSON string. Input
normalization occurs before credentials; operation evidence records the effective
normalized payload hash for the explicit action. `admission-status` requires the
empty array `[]`. Add/set use exact normalized email addresses, at most 50
users and the bounded SSM payload size. Their operation evidence records the
effective payload hash.
The tester write is exactly that: `set-testers` replaces the list and changes no
admission state, and the Service command refuses while admission is not provably
closed. **A tester write cannot open admission, and no operation supplies a bound**;
the operator flow is `add-testers` (optional) and then
`open-admission`. An empty tester payload is not proof of closed admission
either. `admission-status` publishes the effective mode every gate uses, the
recorded mode each surface stores and whether those raw records disagree.

## Admission open and close

`open-admission` is the only operation an operator can request that opens
admission, and the only operation whose one-shot authority lists the lifecycle
`resume` action. It takes no payload: the Service has no bound to write, so the
`mutate.yml` dispatch, the one-shot guard and the lifecycle command carry none.

Opening and closing are the whole lifecycle:

- **closed:** `{"mode":"closed"}`. `close-admission` runs the pinned lifecycle
  `suspend` and records `close_kind=ordinary` when the database reported
  `testers`, or `already-closed` when it already reported `closed`. The
  classification is read from the database status, never from the SSM mirror.
- **testers:** `{"mode":"testers"}`. `open-admission` runs the pinned lifecycle
  `resume` and records the post-open proof. The tester list is untouched, so no
  non-tester is admitted.

**Nothing closes on its own.** There is no bound, no expiry and no time-based
backstop in the parameter, the reader or the writer. Open admission ends only when
`close-admission` writes `closed`, so an interrupted or failed `open-admission`
after its resume attempt leaves admission **open** and the operator recovery is
`close-admission` followed by an `admission-status` read-back. The failed-open path
issues one recovery-only `suspend` and records `close_kind=failed-open`, but that
covers only a run still executing: there is no self-healing, and a run interrupted
mid-flight can stay open until an explicit close.

The post-open read-back is also the executable proof that the deployed Service has
no window semantics: it requires `admission_mode=testers`, matching
`database_policy_matches_ssm`, and the **absence** of
`admission_window_expires_at`. A Service image from before this batch still reports
that field, so `open-admission` refuses it — naming the still-reported removed
window field — instead of reading a null as "no bound". The operation record then
carries one `admission-open-proof` event:

```json
{
  "type": "admission-open-proof",
  "schema_version": 1,
  "observed_at": "<ISO-8601>",
  "mode": "testers",
  "mode_source": "record",
  "no_bound": true,
  "tester_count": 2,
  "tester_emails_sha256": "<sha256 of the canonical tester list>",
  "surfaces_agree": true,
  "ssm": { "parameter": "/anywear/beta/admission_mode", "recorded_mode": "testers",
    "record_keys": ["mode"], "expires_at_present": false },
  "database": { "lifecycle_status_mode": "testers", "lifecycle_status_record": "testers",
    "lifecycle_status_reports_expires_at": false, "database_policy_matches_ssm": true,
    "tester_count": 2, "lifecycle_status_sha256": "<sha256 of the status>" }
}
```

`no_bound` is true only when the SSM record key set is exactly `["mode"]` and the
database status omits the removed field; `surfaces_agree` is true only when the
status reports the same mode, the same tester count and
`database_policy_matches_ssm=true`. Both must be true or the operation fails, so a
reader of the record sees "open, no bound, both surfaces agree" without reading
logs.

`close-admission` keeps the only other `suspend` entry in the reviewed one-shot
table. The `suspend` that `open-admission` may also run is **recovery-only**: the
driver reaches it solely from the failed-open path, no operator input can request
it, and it is the same pinned task `close-admission` runs.

After cutover, Service's `beta-testers` entry point retains application-data
`cleanup` only. Infra owns status/add/replace. `beta-service-data-role` can run
only the reviewed verification/tester-cleanup families and pass their exact task
roles; `beta-service-artifact-role` has ECR publication rights without data/runtime
rights. Cleanup uses the separate `beta-anywear-tester-cleanup-task` role exposed
as `CleanupTaskRoleArn`; it does not receive the lifecycle task's admission-parameter
permissions. E2E delegates application cleanup through the pinned Service cleanup
entry point in its scheduled window. Its qualification role passes only the
read-only verification/execution task roles and cannot schedule tester cleanup or
admission configuration directly. Migrate older direct recovery helpers
before retiring the old role; no shared-role fallback is allowed. Enumerate nested
cleanup jobs and ECS tasks before narrowing or retiring access.

The approved cleanup permissions include `ReceiveMessage`, `DeleteMessage` and
`ChangeMessageVisibility` on both exact DLQs. IAM limits AWS actions/resources;
it cannot filter individual DLQ message IDs, SQL statements or ECS container
commands. Exact cleanup is constrained by the trusted helper in the selected
immutable Service artifact, the reviewed exact payload and the coordinated writer allocation. Reading `DatabaseSecret` does not create a database principal with
read-only grants. Verification's read-only behavior comes from the reviewed
command and its read-only transaction, including the authenticated inspection's
`repeatable read read only` transaction; secret access alone does not enforce it.

Issue #86's fixed cleanup capability lives in Workload as the versioned
`beta-anywear-tester-cleanup` Standard state machine, with a 30-minute timeout.
`CleanupStateMachineVersionArn` is the execution input; the unversioned
`CleanupStateMachineArn` is for inventory. Its published definition binds both
complete ECS task-definition ARNs, their selected image, roles, private network
and commands. A latest task-family revision is never an execution input.
Each task supplies a distinct 64-character SHA-256 ECS client token derived
from the machine execution ARN and fixed verify/cleanup suffix. No general
state retry reruns cleanup after an uncertain outcome.
The envelope supplies schema version 1, string `operation_id`, `run_scope`,
`request_sha256`, `service_commit_sha`, `service_image_digest` and serialized
`cleanup_request`. Service identity must equal the deployed Workload parameters
before verification starts. The original envelope is serialized before either
task adds result data, then passed to Service's fixed
`dist/ops/beta-cleanup-operation.js` wrapper for complete request validation.

Both optimized ECS `.sync` results must identify the exact cluster and task
definition, `LastStatus=STOPPED`, exactly one `OneShot` container, `ExitCode=0`
and the selected image digest. Missing, nonzero, mismatched or ambiguous task
results fail; verification failure prevents cleanup. Successful machine output
is `anywear_beta_cleanup_tasks` schema version 1. It carries operation/hash/scope,
selected Service identity, cluster/log group, both actual task and definition
ARNs, stopped statuses, exit codes and fixed log-stream prefixes. It does not
assert a database commit from task completion alone.

Before Cognito deletion, E2E independently authenticates the exact immutable
machine version/input, stopped ECS tasks/definitions and fixed CloudWatch stream.
It requires one complete `ANYWEAR_BETA_CLEANUP_RESULT=` record from the selected
Service wrapper after cleanup returns, with matching operation/hash/scope and
Service identity plus `transaction_committed=true`. Duplicate, missing or
truncated proof rejects the cleanup result. E2E receives only the additional
fixed task-definition/cluster task reads and the two fixed log prefixes; it
cannot register or run cleanup tasks, pass their roles or change data directly.
Publishing this capability is source delivery only. A new selected Service
release containing the wrapper, separately authorized active-Beta deployment,
authenticated deployed version and E2E qualification remain separate gates.

The named machine, immutable versions and fixed task revisions have CloudFormation
`Retain` deletion and update-replacement policies. Retention preserves evidence;
it does not authorize invocation of a previous capability. Invocation and the
machine role's task-launch policy grant only the current exact version/revisions.
Before updating the cleanup capability, its roles/tasks or selected Service,
inventory matching executions, execution history and cluster tasks, then
reconcile every running, unknown or unresolved result before updating the cleanup
capability, its roles/tasks or selected Service. No such
operation may span a capability update: updating the shared machine role can
revoke the preceding version's exact task grants. If recovery must invoke an
older retained version after an update, first review an explicit bounded list of
its exact version/task ARNs and their compatibility; no wildcard, latest-family
fallback or retention-only claim supplies that authority. Retained resources
remain inventoried for separately authorized cleanup.

Immediately before every Platform or Workload CDK call, including recovery,
the runtime checks the exact synthesized cleanup output name and performs two
matching complete bounded execution/task inventory scans. Active, pending,
unknown, malformed, incomplete or changing inventories block deployment. The
cleanup task-family filters use the existing cluster-scoped ECS read permission;
IAM does not restrict that read to individual task families. The family executor
admits the exact cleanup machine/execution read ARNs only
for Platform/Workload deployment and recovery operation sessions.
Read-only state and final qualification sessions receive no Step Functions
permissions; neither can replace the cleanup capability or invoke cleanup.
Historical terminal failures require separate result reconciliation
instead of permanently blocking every future deployment. A terminal failure is
not proof of transaction rollback or successful cleanup recovery. First install
requires stable Workload output and Original template absence plus cleanup-family
task cessation and inspection of retained orphan machines outside the stack.

## Admission closure and coherent release recovery

Both `close-admission`/`open-admission` and `restore-release` require
`identity_phase=retired`, `retention_protection=true` source context. Admission
fixes this context; deploy recovery requires the explicit inputs. The admission
operations accept only `tester_emails=[]`; deployment does not expose that payload.
Here `[]` means no tester mutation
payload; it says nothing about the current SSM allowlist. Preserve the complete
observed membership and closed admission after any temporary
qualification policy window. Closing admission does not drain existing backlog.

`close-admission` requires stable active Platform/Workload and the selected image
already deployed. It verifies that image's actual policy, journal and applied
schema, runs its pinned lifecycle `suspend`, then reads both SSM parameters — the
admission mode record and the tester allowlist. Its pinned lifecycle `status` must
prove the effective mode closed, the tester count and
`database_policy_matches_ssm=true`; the classification of what it ended comes from
the stored database mode. Status evidence comes from the authenticated
stopped task's actual definition and exact CloudWatch log stream, with bounded
pagination and matching complete scans. Missing, malformed or duplicate status
fails. Final SSM readback must prove closure and preserve the original tester
membership. No CFN, service scaling, migration, drain or implicit admission
reopening occurs.

`open-admission` requires the same stable active Platform/Workload, the selected
image already deployed, `identity_phase=retired` and `retention_protection=true`.
It reads a lifecycle `status` **before** resuming and refuses unless that status
reports the effective mode closed and `database_policy_matches_ssm=true`, and
unless the SSM mirror holds a `closed` record. That read is the executable fence
against opening from a surface that disagrees with itself. The operation then
resumes with **no payload**, re-reads SSM, and requires the post-open status to
report the tester mode, a matching database policy and the absence of the removed
`admission_window_expires_at` field. Its record carries both admission phases, the
lifecycle status hash and one `admission-open-proof` event. `suspend` is the
operation's only extra lifecycle action, and it is recovery-only: the driver issues
it solely on the failed-open path, and no operator input can request it. No CFN,
service scaling or migration occurs, and no non-tester is admitted.

### Admission-mode status contract

The Service lifecycle `status` object is the cross-repository read-back, and the
Infra reader selects its log message by the contract field names. It carries
`admission_mode` (the **effective** decision every gate uses), `admission_record`
(the **raw stored** mode word), `database_record_differs` (boolean: the raw stored
mode differs from the effective decision), `tester_count` and
`database_policy_matches_ssm` (the effective decision and the tester list agree
across the two surfaces), plus the backlog/diagnostic fields. The Service status
no longer emits `admission_window_expires_at`: the field is omitted, not null.
The same vocabulary is used by the Service task audit (`policy.admission_mode`,
`policy.admission_record`, `policy.database_record_differs`) and by E2E, which
consumes `policy.admission_mode` as effective.

During a rollout, `status` may be read from a Service image deployed before this
batch. That image still emits `admission_window_expires_at`, so the status parser
**tolerates** its presence when it is a string or null, and the status selector
identifies the line by `admission_mode` and `admission_record` alone. The post-open
read-back is where absence becomes mandatory: `open-admission` refuses a status
that still carries the field, because the running Service has not dropped window
semantics yet. That refusal — not a null value — is the executable proof.

Because each surface stores its own mode word, `admission-status` publishes the
effective mode, the raw record from each surface and both disagreement flags: the
Service's `database_record_differs` and this comparison's `mirror_record_differs`
(does the status's raw word equal the mirror's recorded word), beside
`effective_matches`. A human is never shown "testers are admitted" about a closed
environment, and a disagreeing raw record is
visible instead of being reconciled silently. The Infra comparison is always
effective-to-effective: `status.admission_mode` against the mode derived
from the parameter, never against a stored word.

The parameter value encoding is fixed: `{"mode":"closed"}` and
`{"mode":"testers"}` are the only
accepted shapes, each exactly one `mode` key and its own canonical JSON encoding —
the same `JSON.stringify(JSON.parse(value)) === value` rule the Service reader
applies. Any extra key, including the removed `expires_at` in any spelling, is
refused with its reason and with the observed key list kept as evidence. The
Infra reader additionally refuses duplicate keys outright (its strict parser), so a
hand-edited value with a repeated `mode` is not a record for either the fence or
the admission read. The conformance table in
[`scripts/admission-operation.test.mjs`](../../scripts/admission-operation.test.mjs)
lists the accepted and refused values in one place so all three repositories can be
checked against the same list.

For a source-only admission operation, the committed
historical runtime-only stack-source map (deleted with the selection contract) retained all four
recorded producers, including Platform/Workload `ada13617da0280ca9a7da0798577db286e714edc`
from [S1 release restore](https://github.com/git-malu/AnyWear-Infra/actions/runs/37970047230)
(attempt `1`, deployment artifact `11635817118`). The earlier successful restart
and its original deployment record remain historical evidence, not the current
map's Platform/Workload source.
Foundation remains Infra `88679b61630bc2344258cafb0d35b4d0b02e3a0d` and Billing
remains Service `58444ebe15a0ea08ca8f0c8aa91d0ba8a7bfb759`.
Its current executor can be newer without relabeling unchanged stack producers.
If actual producers change, review a new exact map before use. New admission/
recovery operations (`close-admission`, `open-admission`, `restore-release`) reject
`@executor` on any untouched stack.

> **Historical evidence.** The historical restore sequence below and the
> [admission-mode migration and rollout](#admission-mode-migration-and-rollout-historical-pre-158-step-c)
> section record the specific Beta rounds as they were executed before #158 step C.
> They mention the `selection`/`stack_sources` contract and `deploy-workload`
> because those existed at the time; both are now deleted and the Workload slice is
> deployed only by AnyWear-Service. Do not attempt any `selections/...`,
> `stack-sources/...` or `deploy-workload` command from these records.

**Historical restore sequence (before #158 step C; the current single-stack
behavior is in the [operation table](#entry-points)).** `restore-release` had one
activation precondition: admission already closed. A
stable stack status is required for the CloudFormation mutation itself, not as an
activation requirement. It verifies the selected candidate image's raw
runtime-policy identity, migration journal and compatibility with the applied DB
before either CFN deployment. It then deploys selected Workload, verifies its four
parameters and stable interfaces, deploys selected Platform, and qualifies selected
health and verification in the same queue. The strict fulltuple observer runs only
after this coherent sequence. Workload/Platform source rows bind this executor;
Foundation/Billing retain their explicit historical producers. Review the exact
Platform component/resource diff and recovery selection before allocating runtime.
The operation never migrates, changes phase/retention, writes testers or opens
admission. It preserves observed membership and closed admission at every phase
boundary, and its postcondition is a terminal Base stack plus an existing
terminal Runtime stack after each deploy.

An old signed release alone does not establish a usable rollback image: a raw
policy-byte mismatch fails the existing candidate check even if canonical policy
and schema match. A reviewed current coherent release is also a recovery input.
The (now-removed) single-stack `deploy-workload` operation remained strict; when an
older selection had different Lambda bytes, its final fulltuple observer failed
until Platform matched. Do not weaken these checks or call that mixed state a
successful recovery. Any restore failure records its stage, observed CFN
parameters/activity, admission and task evidence, with
`requires-explicit-recovery`; those CFN parameter
readbacks are not actual running ECS identity proof. It never automatically
deploys the other stack, reverts or reopens admission. A final observation
failure still fails the job and records the preserved operation artifact as
`partial`: the mutation completed but its end state is unverified. Only a
separately reviewed recovery may proceed from the observed partial state.

## Evidence and operation recovery

Preserve `deployment-evidence/operation-record.json` under the always-attempted
`infra-operation-<run-id>-<attempt>` artifact even on failure. Its current
version-4 `anywear_infra_operation` record keeps the reviewed Service release
identity (`service_release`, only for the operation that took one) separate from
the current Infra executor SHA/run/attempt. It records actual
Original template hashes and the original Runtime image/source readbacks,
the validated all-stack `stack_manifest` plus the operation's `changed_stack_names`,
completed one-shot task/deployment events,
recovery status and the operation result. The result is `failed` when the
operation did not complete, `partial` when it completed but the required final
observation did not confirm the end state, and `succeeded` when it completed with
a confirmed or not-required end state. A failed operation retains the actual
Base/Runtime stack statuses and Runtime existence plus admission readback, and marks
recovery as `requires-explicit-recovery`; it never redeploys a sibling stack or
opens admission. The record also retains the copied
lifecycle implementation's original Service source. Preserve authenticated task,
admission and runtime readbacks plus Actions logs for interruption/recovery
review; a recovery status alone does not establish those observations. A
successful recovery does not turn the failed operation into success. Failures
before record creation can leave no artifact; preserve Actions logs and the
operation record rather than manufacture a successful operation record.

### Operation-record provenance versions

Version-4 `anywear_infra_operation` records are the current shape: `stack_manifest`
always carries every configured stack with its `Original` template hash, while
`changed_stack_names` records only what the operation mutated and still drives
deploy authorization, cleanup fencing and retention gates. The record carries the
reviewed `service_release` when the operation took one, and no `selection` member.
Historical version-3 records (template evidence separated from the changed-stack
set) and version-2 records (hand-authored per-stack `reviewed_stack_sources`)
remain readable as evidence; they are not operation inputs. Unknown versions are
rejected; there is no permissive fallback.

For active Beta, the fixed `runtime.yml` observation writes the current
`anywear_infra_deployment` v3 from actual Original
CFN templates, Lambda CodeSha/stable configuration, running ECS definitions and
digests, queue settings, Client metadata/endpoints and a bounded read-only schema
task. It hashes template content, not AWS CLI response wrappers. The queue hash
proves only observed queue settings; full runtime policy and applied DB migrations
come from the exact-image verification task. The HTTP minimum-schema value does
not prove the applied DB version.

Other task families retain the same strict final snapshot but emit
`anywear_infra_family_observation` with their actual workflow path, not fabricated
`runtime.yml` provenance. E2E v3 qualification consumes no Infra record, so the
legacy-producer and compatibility-pin acceptance rule is inert and retires in
Wave 2 (#180); deployment-record lineage belongs to #181. Run fixed qualified
observation after coordinated family changes to retain that deployment evidence.
Offline source checks do not establish new runtime-interface acceptance. After
integration, run gate-disabled read-only observation and fixed qualified observation
with restricted sessions against the retained tuple, and keep the resulting record
with the operation evidence. This source split does not imply AWS resource or
template deployment.

A `deploy-platform` run has no accepted evidence step of its own. It is qualified
only by a following fixed `runtime.yml` `observe` run at reviewed main, which
uploads `infra-deployment-<run-id>-<attempt>` containing
`deployment-record.json`. The deploy run cannot produce that record: it stamps the
run's own `.github/workflows/mutate.yml` path and the record type
`anywear_infra_family_observation`, while the accepted record pins both
`anywear_infra_deployment` and the `runtime.yml` workflow path. That record is
deployment evidence for lineage and rollback, not a qualification input, and the
`deploy-platform` operation session carries no task family of its own. The deploy
run still requires and uploads its own successful observation
(`finalize-operation.mjs`): every non-state operation ends on a terminal Base
readback plus an observed Runtime existence/status that must be accepted.
That family record is evidence, but not the accepted record. That
`deployment-record.json` remains the accepted deployment evidence; it no longer
advances a compatibility pin, since qualification reads the live state and its own
observations (#180). The pin routine in `AnyWear-E2E`'s
[`docs/compatibility-pin.md`](https://github.com/git-malu/AnyWear-E2E/blob/main/docs/compatibility-pin.md)
retires with the first live `full`.

`runtime.yml` is the only workflow producer of the accepted record. This is a
statement about workflow runs, not about all software: the standalone
`observe-deployment.mjs` CLI can also emit an accepted-shaped record from ambient
environment variables outside a workflow run.

The read-only observer emits `anywear_infra_state` inside its operation artifact,
records final activity/status plus sanitized admission counts/hashes, and labels
qualification Not Applicable. Failed reads retain known partial state and mark
the operation failed. This record never claims DB policy equality or applied
schema. Observation never changes activation or starts tasks.

The unchanged image's one-shot inspection embeds Infra's reviewed read-only
command; it does not assume newly added Service code. Evidence binds command hash,
Infra source, original image/Service source, executor run/attempt and actual ECS
task/definition. Selected image migrations and observed applied migrations are
separate histories. A compatible older image may run against a later applied
schema; rollback never runs down migrations.

Read-only `state` is the only operation that can observe the stopped state
(Runtime absent) without failing. Every protected mutation requires a terminal
Base stack; a Base mutation additionally requires a terminal Runtime when it
exists, and a failure to satisfy either fails the operation. A still-running
verification/helper task remains registered for explicit recovery. Inspect it and
its owner before cleanup; expiry or task-runner failure is not task cessation.

Upload `deployment-evidence/deployment-record.json` as
`infra-deployment-<run-id>-<attempt>` with 90-day requested retention.
Record actual hashes and effective expiry; missing/expired
artifacts cannot authorize qualification or rollback. SSM stage-contract/deployment
values alone are not observed release proof. Final E2E v3 qualification runs in a
separate scheduled window: it reads the live Client/Service identity, takes its own
authenticated before/after observation, and writes a self-contained record (no
committed pin and no deployment-record download).

## Admission-mode migration and rollout (historical, pre-#158 step C)

The steps below are the recorded pre-C procedure. The `selection` inputs and the
`deploy-workload` operation they dispatch were deleted in #158 step C and cannot be
run from this revision; the Workload slice is now deployed only by
AnyWear-Service's release chain. The sequence is retained as evidence.

The rename from the two boolean parameters to one mode record is expand → prove →
contract, and it spans three releases because the writable surface moves with the
Service image:

0. **With the previous Infra revision**, dispatch its admission-status operation
   (named `tester-status` there) and require the effective decision closed; record
   the observed mode and tester list. That recorded tuple is the pre-state
   the later equality proof compares against. Dispatch it with the deployed tuple's
   selection, `selections/beta-cleanup-150-148-5d16543.json` (Service `5d16543`,
   release `415612529`, schema 19).
1. **Platform deploy**: create `/anywear/beta/admission_mode` at
   `{"mode":"closed"}`, deploy the new Lambda readers and their exact
   `ssm:GetParameter`/`ssm:GetParameters` grant, and — when the additive and
   removal halves are dispatched from separate reviewed revisions — keep the two
   old parameters and their grants in place. The Platform stack owns the
   parameters, the grants and the two trigger readers; no admission operation can
   create them, and the old Workload image can only write the old parameters.
   Dispatch it with the same deployed-image selection;
   `deploy-platform` must retain the observed running image.
2. **`migrate`**: the forward-migration fence is satisfied by the
   CloudFormation-created `closed` value and by step 0's recorded tuple. The fence
   refuses open admission and every value that cannot *prove* closure, including a
   single throttled read. The Service migration `0021` adds the mode column with
   default `closed` and *then* added a check constraint requiring `testers` to carry
   a bound and `closed` to carry none — the constraint this batch's Service
   migration drops again — so migrating a database that still held a live window
   failed the constraint **before** the rename committed, leaving the old
   schema intact. That is why the documented `close-admission` predecessor is not
   a formality: it is what makes the migration apply, and a failed attempt is a
   fail-closed refusal rather than a half-migrated schema.

   **This dispatch is mandatory, not a formality.** Beta is deployed at Service
   `5d16543` with applied schema **19**, and the new image requires **20**.
   `deploy-workload` refuses an image the applied schema cannot support, so
   skipping this step does not partially roll Beta: it produces an `incompatible
   applied schema` refusal at step 3. The migration is a separate dispatch an
   operator must run, and step 3 is possible only after it applies.

   **Dispatch this step with a canonical selection for the schema-20 Service
   release**, not the deployed tuple's selection. The operation overwrites the
   observed revision's digest and commit with the selector's before it registers
   the one-shot, so this step legitimately runs the *new* image's migration while
   the old image is still deployed, and the operation record attributes the
   migrate one-shot (task ARN, `service_sha`, `image_digest`) to the new image.
   Report that identity, not the still-deployed old one.

   **A failed conclusion is not the evidence.** Issue
   [#157](https://github.com/git-malu/AnyWear/issues/157) records that `migrate`
   applies its mutation and then fails its own post-condition *because the workload
   has not been deployed yet*, so a migration that applied cleanly is recorded as a
   failed run. Read the migrate one-shot's own log stream, not the run conclusion:
   `AnyWear-Service/src/migrate.ts` ends with
   `logger.info({ schemaVersion: CURRENT_SCHEMA_VERSION }, 'Database migrations completed')`,
   so a completed migration emits one JSON line with
   `"msg":"Database migrations completed"` and `schemaVersion` — **20** for this
   change, which also proves which revision ran it.
   - **Applied but reported failed:** that log line is present with
     `schemaVersion: 20`, and the applied journal contains `0021`–`0023`. Treat the
     migration as applied and continue to step 3; do not re-run it to "fix" the
     failed conclusion.
   - **Did not apply:** no such log line; the run failed before migration
     completion. Do not proceed to the workload deploy.
   This reading is a **dependency on #157** and must be removed when that issue
   lands, so the workaround does not become folklore.
3. **`deploy-workload`**: roll out the new API/worker image, which reads and writes
   the mode record and queries the renamed admission table. Dispatch it with the
   same schema-20 selection; `deploy-workload` refuses an image the applied schema
   cannot support.
4. **`admission-status`**: read the new surface back and compare it with step 0's
   tuple. Both must be closed, and the record's `effective_matches` must be true;
   that comparison — not a diff of history — is the old/new equality proof.
   Dispatch it with the same schema-20 selection, which now matches the deployed
   image.
5. **Platform deploy**: delete the two old parameters **and** their IAM grants in
   the **same** deploy, never split. `PutParameter` with overwrite can recreate a
   deleted parameter, so resources without their grants are not a cut-off; the
   grant removal is what makes a still-deployed old revision incapable of
   resurrecting either name. The proof that deletion stuck is both old names
   returning `ParameterNotFound` **and** the deployed lifecycle role policy no
   longer listing them. From that point every image below the new revision is
   incapable of admission: it reads deleted parameters and queries a renamed
   table. Dispatch it with the same schema-20 selection; the removal deploy
   retains the deployed new image.

**Step 3 needs a selection this revision does not contain.** Beta is deployed at
Service `5d16543` (release `415612529`, schema 19), and every committed
`selections/*.json` in this revision tops out at that revision: none of them
selects the schema-20 Service release the new image belongs to. Steps 0 and 1 use
`selections/beta-cleanup-150-148-5d16543.json`; steps 2–5 need the canonical
selection for the schema-20 release, which must be added to `selections/` (with its
raw hash) before step 2 is dispatched. An operator who dispatches step 3 with a
schema-19 selection gets the `incompatible applied schema` refusal from the
pre-deploy compatibility check, not a partial rollout.

This revision's Platform source declares only the mode record, so a Platform deploy
from it performs steps 1 and 5 in one CloudFormation update. Accept that collapse,
and know exactly what it forbids and what it costs.

**The collision to forbid** is deleting the parameters while the *old Lambda
readers* are still deployed — that would leave registrations reading a missing
record — and splitting step 5's resource deletion from its grant deletion.
Deleting the old parameters before the new *workload* image runs is what this
revision does, and it is safe only because steps 0 and 2 already guarantee closure:
step 0 recorded the environment closed, the new record was created
`{"mode":"closed"}`, and the then-current migration constraint refused a live
window. Nothing is left open by the collapse.

**The cost is a maintenance window.** Between that Platform deploy and
`deploy-workload`, no admission operation can run: they require the selected
revision to equal the deployed image, which is still the old one. Admission is
nevertheless closed throughout, for the reasons above, so nothing is left open —
but the environment cannot be re-closed or observed through a reviewed operation
until the rollout lands. Dispatch the Platform deploy, `migrate` and `deploy-workload`
back to back, and treat the gap as a maintenance window rather than a normal
operating state.

**The alternative, and its cost.** If that window is unacceptable, cut the additive
half as an intermediate reviewed Infra revision that declares
`/anywear/beta/admission_mode` **and keeps** the two old parameters and both grant
sets, with the removal arriving in a later Platform deploy. That gives the old
readers a working record across the gap at the price of an extra revision to
maintain and an extra Platform deploy to authorise, which is why this issue
documents the collapse instead of building it.

**The `migrate` → `deploy-workload` gap is an error state, not a closed one.** The
old image queries the renamed table and fails with a missing-relation error, so no
task is admitted but nothing reports "closed", and a sign-up can pass the
SSM-backed Cognito edge and then dead-end at provisioning. Step 0 is what keeps
that gap fail-closed: it guarantees the old mirror read closed before the change,
and the new mode record was born closed. An open requested inside the gap fails
closed — `open-admission` refuses because the database status does not prove an
effective closed decision — and recovery is roll-forward, because `deploy-workload`
already refuses an image the
applied schema cannot support, so the pair cannot be reversed by accident.

**The standalone `migrate` fence.** `migrate` reads `/anywear/beta/admission_mode`
— already in the runtime read set, so it adds no grant and no CDK change — and
answers `closed`, `open` or `unproven`; only `closed` (a valid
`{"mode":"closed"}` record) is accepted. There is no expiry that admits the
migration on its own: a stale `testers` record reads `open` and must be closed
explicitly with `close-admission`, while a mirror restored to a bare word or any
other value that cannot prove closure makes the fence refuse.
