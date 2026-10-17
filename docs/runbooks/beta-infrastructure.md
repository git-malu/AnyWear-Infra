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

The separately protected [cleanup acceptance fixture](beta-cleanup-acceptance.md)
records #86's source order, immutable bootstrap proof, narrowed task authority and
qualification/recovery requirements.

The accepted IAM boundary is limited to the named legacy Beta role: its trust is
deny-only with zero inline or attached grants. The inherited Dev wildcard E2E
subject, `cdk-*` assume-role chain and CloudFormation execution role with
`AdministratorAccess` and no permissions boundary remain unchanged and outside
this runbook's #54 claim. Operational single-queue ownership is not account-wide
IAM exclusivity or Beta resource isolation.

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
gate `ENABLE_BETA_DEPLOY=false`. The private plan returned 403 for branch
protection/rulesets; environment restriction is not repository branch protection.
Review exact source and inputs, coordinate one writer and freeze conflicting
Service/Client/E2E operations during #54 rollout. Enumerate Actions/local helpers,
CFN operations and ECS tasks; timeout or repository concurrency cannot prove peer
cessation. Ordinary Infra operations share `anywear-infra-runtime` with the
source-disabled Production workflow.

Environment configuration supplies account `650880818323`, region `ap-east-1`,
`INFRA_DEPLOY_ROLE_ARN=arn:aws:iam::650880818323:role/beta-infra-deploy-role`,
`INFRA_RUNTIME_ROLE_ARN=arn:aws:iam::650880818323:role/beta-infra-runtime-role` and
the activation gate. Every dispatch supplies committed selection file/raw hash
and stack-source file/raw hash. Operation, identity/retention and tester inputs
are exposed only by the relevant family in the [entry-point table](#entry-points).
The canonical [selection schema v2](../contracts/release-selection.md) binds full
independent Service component producers, release/asset IDs, hashes and ECR digest.

Before App credentials, source guards require the exact Infra Git origin/full
HEAD, main runtime workflow/account/region, clean tracked/untracked checkout and
no replacement refs or hidden-index masking. The actual selection is a regular
tracked canonical blob without path links, equal to the committed bytes and raw
hash. Before AWS OIDC, the Service-only read App token verifies the immutable
release/tag/source, exact five asset IDs/names/states/sizes/digests/downloaded
hashes and Lambda/policy/schema validation. Native release verification and all
five verify-asset calls use the same complete signed v0.1/v0.2 statement. Exact
completed-success publisher main source/workflow/run/attempt and both repository/
head-repository owner identities are independently checked before and after;
native signatures alone do not contain workflow/run identity. The final release
identity and source are also rechecked. See [direct verification](cutover-and-recovery.md#direct-release-verification).

Runtime uses the reviewed main workspace and `GITHUB_SHA`; E2E passes its reviewed
`compatibility.infra` pin and actual `.infra-source` checkout. Vendored verifier
code and reconstructed comparison selectors are not trust authorities. New
runtime rejects historical v1 inputs; original receipts/diagnostics remain frozen
history. There is no candidate/receipt/handshake workflow, mandatory issue URL,
writer token/expiry or publication Actions ZIP dependency. `APP_PRIVATE_KEY`
stays in protected secrets; only the scoped Service token reaches the CLI. Native
CLI capability probes precede App credentials and telemetry is fixed off.

`stack-sources/<reviewed-name>.json` has four unique rows: `stack_name`, `region`,
`source_repository`, `source_sha`. Retain each unchanged stack's actual producer
repository/full SHA; touched stacks bind the exact Infra executor. Only the
reviewed Infra `@executor` placeholder resolves to `GITHUB_SHA`; final records
carry full SHAs. Actual authenticated CFN Original hashes remain independent
from these reviewed source declarations and source synth comparisons.

The committed [Beta restart map](../../stack-sources/beta-restart.json) retains
Foundation's accepted Infra bootstrap source
`88679b61630bc2344258cafb0d35b4d0b02e3a0d` and Billing's Service source
`58444ebe15a0ea08ca8f0c8aa91d0ba8a7bfb759`. Their historical operation and
preservation-overlay evidence remains independent of these four-key rows.
Platform and Workload use Infra `@executor` because `start` deploys both stacks;
the merge's actual reviewed main SHA becomes their producer only after the
operation succeeds. No separate stopped Platform maintenance deployment is
needed: `start` already reconciles Platform before its pinned migration/verification.

Keep that reviewed main fixed through start and subsequent observation. The
restart map is valid for later `observe` at the same SHA after both deployments;
using it at a newer main would wrongly relabel unchanged stacks. Observation
from newer main requires a separately reviewed fixed map preserving the actual
deployed Platform/Workload SHAs. Final E2E binds the actual record-producing
Infra source and deployment record. This source map alone is not runtime proof
or authorization to activate Beta.

## Entry points

All six workflows use manual dispatch, exact reviewed main, the `beta` environment
and shared non-cancelling queue `anywear-infra-runtime`. Their local composite
[executor](../../.github/actions/beta-operation/action.yml) rejects cross-family
operations, verifies committed selection/stack-source hashes, probes native CLI
capability before App credentials, and verifies the complete immutable Service
release/publisher before AWS credentials. All task/deployment entries require
`ENABLE_BETA_DEPLOY=true`; the read-only observer remains available when false.
The environment restricts branches to main; no required-reviewer rule is currently
configured. Approval and writer allocation remain separate operational gates.

| Workflow | Dispatch operation | Additional inputs / AWS boundary |
| --- | --- | --- |
| [runtime.yml](../../.github/workflows/runtime.yml) | Fixed `observe`; no operation input | Qualified observation with artifact-verification task; legacy E2E producer |
| [beta-observe.yml](../../.github/workflows/beta-observe.yml) | Fixed `state`; no operation input | CFN and SSM read-only session; no tasks/PassRole/deploy role or schema assertion |
| [beta-lifecycle.yml](../../.github/workflows/beta-lifecycle.yml) | `start`, `stop` | Explicit required identity phase/retention; deploy and bounded lifecycle/schema task sessions |
| [beta-deploy.yml](../../.github/workflows/beta-deploy.yml) | Four `deploy-*`, `restore-release` | Explicit required identity phase/retention; stack-specific deployment and selected verification tasks; `deploy-platform` is qualified only by a following fixed `runtime.yml` `observe` |
| [beta-schema.yml](../../.github/workflows/beta-schema.yml) | `migrate`, `verify` | Selected corresponding task only |
| [beta-admission.yml](../../.github/workflows/beta-admission.yml) | `tester-status`, `tester-add`, `tester-replace`, `close-admission` | Only entry accepting `tester_emails`; verification/lifecycle tasks, no CDK |

Every dispatch requires selection file/raw hash and stack-source file/raw hash.
Non-CDK entries omit identity/retention inputs and fix `retired`/`true` source
context, which does not change CFN or prove observed IAM/retention state. CDK
entries accept explicit values without silently choosing a legacy/unprotected
context. Lifecycle dispatches and activation changes require explicit
authorization; starting/reactivating Beta requires explicit user consent. Source
delivery alone does not grant an environment writer or establish runtime
acceptance.

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
| `deploy-foundation` | Reconcile existing Foundation with reviewed identity phase; ordinary workflow still requires a sealed selection |
| `deploy-billing` | Reconcile existing Billing in `us-east-1` |
| `deploy-platform` | Reconcile Platform using selected prebuilt Lambda/policy inputs; retain observed image and both stacks' active/stopped state; reject mixed/unknown state; qualified only by a following fixed `runtime.yml` `observe` run, because this run's own observation record is a family observation |
| `deploy-workload` | Select the explicit immutable image; verify compatible applied schema before rollout; no implicit migration or down-migration |
| `restore-release` | Verify the candidate image's actual policy/schema against the applied DB, then reconcile selected Workload and Platform in the same queue; retain retired identity, protected retention, active state and closed admission; qualify the coherent tuple at the end |
| `migrate` | Invoke Service's forward migration command in the selected immutable image |
| `verify` | Invoke Service's verification command; verify the selected runtime without migrating |
| `start` | Restore network, suspend admission, run the pinned migration/verification sequence, restore Workload and health, then keep admission suspended |
| `stop` | Suspend admission, drain, stop Workload, verify task cessation, then stop paid Platform network; require both stopped outputs and closed admission readback; preserve failure state |
| `observe` | Collect authenticated active-Beta deployment evidence by launching a verification task; not AWS read-only |
| `state` | Record Platform/Workload status/activity and sanitized SSM admission state; no DB/schema/policy qualification |
| `tester-status` | Read admission/tester status through the selected existing Service lifecycle command |
| `tester-add`, `tester-replace` | Update the exact normalized tester list using the selected lifecycle command, with public intake closed |
| `close-admission` | Verify the deployed selected image/schema, suspend admission through its pinned lifecycle command, then prove DB/SSM consistency and preserve the observed tester list; keep both stacks active |

A dispatch uses reviewed repository files and explicit inputs, for example:

```sh
gh workflow run runtime.yml --repo git-malu/AnyWear-Infra --ref main \
  -f selection_file=selections/cutover.json -f selection_sha256="$SELECTION_SHA256" \
  -f stack_sources_file=stack-sources/cutover.json -f stack_sources_sha256="$STACK_SOURCES_SHA256"
```

For state-only observation use `beta-observe.yml` with the same four inputs. For
other families select their workflow/operation, adding identity/retention only
for lifecycle/deploy and tester payload only for admission. Use the actual
reviewed filenames, phase and retention setting. Initial role bootstrap uses the [Foundation-only procedure](cutover-and-recovery.md#foundation-only-bootstrap),
because no sealed Service release is needed to create the artifact publisher role.

## Retained Beta sizing and temporary telemetry

Issue #95 adds retained Workload parameters without changing lifecycle authority.
`BetaApiSizingProfile` defaults to `s1` (API CPU 512 / memory 1024 MiB); `s2-api`
selects CPU 256 / memory 512 MiB together. The S2 profile remains an unqualified
candidate until same-image acceptance and recovery evidence are recorded.
Worker remains CPU 1024 / memory 2048 MiB, and API desired/minimum counts stay 1/1.
`BetaSizingTelemetry` defaults to `false` and supplies `BETA_SIZING_TELEMETRY`
to both API and Worker. The selected Service artifact must implement the telemetry
contract, and its behavior must be accepted before enabling it; Infra source checks
alone do not establish that application behavior.

Only `beta-deploy.yml` exposes `beta_api_sizing_profile=preserve|s1|s2-api` and
`beta_sizing_telemetry=preserve|enable|disable`, both defaulting to `preserve`.
Absent or ordinary inputs retain both observed parameters through maintenance,
stop/start and release recovery. A pre-parameter deployment means S1 and telemetry
off. Unknown retained values fail before workload helper operations. An explicit
override is allowed only for `deploy-workload` on already-active, coherent Beta,
with the selected Service SHA/digest exactly matching the observed image. Other
operations reject overrides before credentials. Fixed `runtime.yml` has no sizing
or telemetry input. Neither input starts Beta or grants an environment writer.

For an explicitly authorized measurement, dispatch the reviewed `beta-deploy.yml`
with `operation=deploy-workload`, the unchanged immutable selection/stack-source
inputs and explicit profile/telemetry values. Preserve exact parameter readback
in the `workload-parameter-readback` event. The final authenticated observer also
records a `beta-sizing-state` event with both actual ECS task-definition ARNs,
CPU/memory and telemetry environment values. It rejects mismatches. These events
belong to the operation artifact; the strict v2 deployment snapshot stays unchanged.
State-only observation records retained values but cannot prove running telemetry.

After measurement, explicitly dispatch the reviewed current-main workload operation
with `beta_sizing_telemetry=disable`, the unchanged Service image and reviewed
stack-source binding. Use `beta_api_sizing_profile=s1` in that operation when
restoring S1, or `preserve` when retaining an accepted profile. Verify
`BetaSizingTelemetry=false`, both actual containers reporting telemetry `false`,
stable service rollout and the final observer/health result. An ordinary `preserve`
input or a stop/start cycle does not disable telemetry. If Beta is stopped or its
state is unknown, preserve that state; never reactivate Beta to restore telemetry.
This source delivery does not claim deployment, runtime acceptance or telemetry-off
restoration.

## Tester and cleanup ownership

Admission dispatch alone supplies `tester_emails` as a JSON string. Input normalization
occurs before credentials; operation evidence records the effective normalized
payload hash for the explicit action. `tester-status` requires the empty array `[]`.
Add/replace use exact normalized email addresses, at most 50 users and the bounded
SSM payload size. Their operation evidence records the effective payload hash.
Service's existing `configure-testers` command changes the allowlist and can resume
admission; public intake must already be closed. An empty tester payload is not
proof of suspended admission. Use `close-admission` after an authorized tester
window to restore suspension while preserving the required observed membership.

After cutover, Service's `beta-testers` entry point retains application-data
`cleanup` only. Infra owns status/add/replace. `beta-service-data-role` can run
only the reviewed verification/tester-cleanup families and pass their exact task
roles; `beta-service-artifact-role` has ECR publication rights without data/runtime
rights. Cleanup uses the separate `beta-anywear-tester-cleanup-task` role exposed
as `CleanupTaskRoleArn`; it does not receive the lifecycle task's admission-parameter
permissions. E2E delegates application cleanup through the pinned Service cleanup
entry point in its scheduled window. Its qualification role passes only the
read-only verification/execution task roles and cannot schedule tester cleanup or
lifecycle configuration/start/stop directly. Migrate older direct recovery helpers
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

Immediately before every Platform or Workload CDK call, including start/stop and recovery,
the runtime checks the exact synthesized cleanup output name and performs two
matching complete bounded execution/task inventory scans. Active, pending,
unknown, malformed, incomplete or changing inventories block deployment. The
cleanup task-family filters use the existing cluster-scoped ECS read permission;
IAM does not restrict that read to individual task families. The family executor
admits the exact cleanup machine/execution read ARNs only
for Platform/Workload deployment, recovery and lifecycle operation sessions.
Read-only state and final qualification sessions receive no Step Functions
permissions; neither can replace the cleanup capability or invoke cleanup.
Historical terminal failures require separate result reconciliation
instead of permanently blocking every future deployment. A terminal failure is
not proof of transaction rollback or successful cleanup recovery. First install
requires stable Workload output and Original template absence plus cleanup-family
task cessation and inspection of retained orphan machines outside the stack.

## Admission closure and coherent release recovery

Both `close-admission` and `restore-release` require `identity_phase=retired`,
`retention_protection=true` source context. Admission fixes this context;
deploy recovery requires the explicit inputs. `close-admission` accepts only
`tester_emails=[]`; deployment does not expose that payload. Here `[]` means no tester mutation
payload; it says nothing about the current SSM allowlist. Preserve the complete
observed membership, `intake_open=false` and suspended admission after any temporary
qualification policy window. Closing admission does not drain existing backlog.

`close-admission` requires stable active Platform/Workload and the selected image
already deployed. It verifies that image's actual policy, journal and applied
schema, runs its pinned lifecycle `close`, then reads all three SSM parameters.
Its pinned lifecycle `status` must prove suspension/intake/count and
`database_policy_matches_ssm=true`. Status evidence comes from the authenticated
stopped task's actual definition and exact CloudWatch log stream, with bounded
pagination and matching complete scans. Missing, malformed or duplicate status
fails. Final SSM readback must preserve the original tester membership. No CFN,
service scaling, migration, drain or implicit admission reopening occurs.

For a source-only admission operation, the committed
[runtime-only map](../../stack-sources/beta-runtime-only.json) retains all four
recorded producers, including Platform/Workload `ada13617da0280ca9a7da0798577db286e714edc`
from [S1 release restore](https://github.com/git-malu/AnyWear-Infra/actions/runs/37970047230)
(attempt `1`, deployment artifact `11635817118`). The earlier successful restart
and its original deployment record remain historical evidence, not the current
map's Platform/Workload source.
Foundation remains Infra `88679b61630bc2344258cafb0d35b4d0b02e3a0d` and Billing
remains Service `58444ebe15a0ea08ca8f0c8aa91d0ba8a7bfb759`.
Its current executor can be newer without relabeling unchanged stack producers.
If actual producers change, review a new exact map before use. New admission/
recovery operations reject `@executor` on any untouched stack.

`restore-release` requires both stacks already active/stable and admission already
suspended with intake closed. It verifies the selected candidate image's raw
runtime-policy identity, migration journal and compatibility with the applied DB
before either CFN deployment. It then deploys selected Workload, verifies its four
parameters and stable interfaces, deploys selected Platform, and qualifies selected
health and verification in the same queue. The strict fulltuple observer runs only
after this coherent sequence. Workload/Platform source rows bind this executor;
Foundation/Billing retain their explicit historical producers. Review the exact
Platform component/resource diff and recovery selection before allocating runtime.
The operation never migrates, starts stopped stacks, changes phase/retention,
configures testers or reopens admission. It preserves observed membership and
closed admission at every phase boundary.

An old signed release alone does not establish a usable rollback image: a raw
policy-byte mismatch fails the existing candidate check even if canonical policy
and schema match. A reviewed current coherent release is also a recovery input.
The single-stack `deploy-workload` operation remains strict; when an older
selection has different Lambda bytes, its final fulltuple observer fails until
Platform matches. Do not weaken these checks or call that mixed state a successful
recovery. Any restore failure records its stage, observed CFN parameters/activity,
admission and task evidence, with `requires-explicit-recovery`; those CFN parameter
readbacks are not actual running ECS identity proof. It never automatically
deploys the other stack, reverts or starts/reopens Beta. Final observation failure
also marks the preserved operation artifact failed. Only a separately reviewed
recovery may proceed from the observed partial state.

## Evidence and stopped-state recovery

Preserve `deployment-evidence/operation-record.json` under the always-attempted
`infra-operation-<run-id>-<attempt>` artifact even on failure. Its version-3
`anywear_infra_operation` record keeps the original
committed selection file/hash binding and independent selected Service component sources
separate from the current Infra executor SHA/run/attempt. It records actual
Original template hashes and the original Workload image/source readbacks,
the validated all-stack `stack_manifest` plus the operation's `changed_stack_names`,
completed one-shot task/deployment events,
recovery status and the operation result. Failed stop records actual Platform/Workload
outputs and stack statuses plus admission readback, and marks recovery as
`requires-explicit-start`; it never deploys active stacks or reopens intake. A
separately selected start is required after reviewing partial state. The record also retains the copied
lifecycle implementation's original Service source. Preserve authenticated task,
admission and stopped-state readbacks plus Actions logs for interruption/recovery
review; a recovery status alone does not establish those observations. A
successful recovery does not turn the failed operation into success. Failures
before record creation can leave no artifact; preserve Actions logs and the
operation record rather than manufacture a successful operation record.

### Operation-record provenance versions

Version-3 records define template evidence independently of the changed-stack set:
`stack_manifest` always carries every configured stack with its `Original` template
hash, while `changed_stack_names` records only what the operation mutated and still
drives deploy authorization, cleanup fencing and retention gates. Historical
version-2 records carried hand-authored per-stack `reviewed_stack_sources` and remain
readable during the dual run so both provenance paths can be compared before the
breaking removal. Unknown versions are rejected; there is no permissive fallback.

For active Beta, the fixed `runtime.yml` observation writes the unchanged
`anywear_infra_deployment` v2 from actual Original
CFN templates, Lambda CodeSha/stable configuration, running ECS definitions and
digests, queue settings, Client metadata/endpoints and a bounded read-only schema
task. It hashes template content, not AWS CLI response wrappers. The queue hash
proves only observed queue settings; full runtime policy and applied DB migrations
come from the exact-image verification task. The HTTP minimum-schema value does
not prove the applied DB version.

Other task families retain the same strict final snapshot but emit
`anywear_infra_family_observation` with their actual workflow path, not fabricated
`runtime.yml` provenance. Existing E2E accepts only the legacy v2 producer;
consumer expansion needs a separately reviewed pin/contract. Run fixed qualified
observation after coordinated family changes to produce that compatible input.
Offline source checks do not establish new runtime-interface acceptance. After
integration, run gate-disabled read-only observation and fixed qualified observation
with restricted sessions against the retained tuple, then obtain E2E acceptance of
the exact resulting legacy record. This source split does not imply AWS resource or
template deployment.

A `deploy-platform` run has no accepted evidence step of its own. It is qualified
only by a following fixed `runtime.yml` `observe` run at reviewed main, which
uploads `infra-deployment-<run-id>-<attempt>` containing
`deployment-record.json`. The deploy run cannot produce that record: it stamps the
run's own `.github/workflows/beta-deploy.yml` path and the record type
`anywear_infra_family_observation`, while the accepted record pins both
`anywear_infra_deployment` and the `runtime.yml` workflow path that the E2E
consumer also pins, and the `deploy-platform` operation session carries no task
family of its own. The deploy run still requires its own successful observation
whenever a stack ends active and uploads that family record
(`finalize-operation.mjs`); it is evidence, but not the accepted record. The
qualifying run needs both stacks active for the same reason the stopped case below
records: a stopped Beta produces no active-runtime record, and with either stack
stopped the observation step is skipped, leaving the run's own
`infra-operation-<run-id>-<attempt>` record as its only artifact; a failure before
record creation can leave none.

`runtime.yml` is the only workflow producer of the accepted record. This is a
statement about workflow runs, not about all software: the standalone
`observe-deployment.mjs` CLI can also emit an accepted-shaped record from ambient
environment variables outside a workflow run.

The read-only observer emits `anywear_infra_state` inside its operation artifact,
records final activity/status plus sanitized admission counts/hashes, and labels
qualification Not Applicable. Failed reads retain known partial state and mark
the operation failed. This record never claims DB policy equality or applied
schema. Observation remains possible while stopped or partially stopped and
never changes activation or starts tasks.

The unchanged image's one-shot inspection embeds Infra's reviewed read-only
command; it does not assume newly added Service code. Evidence binds command hash,
Infra source, original image/Service source, executor run/attempt and actual ECS
task/definition. Selected image migrations and observed applied migrations are
separate histories. A compatible older image may run against a later applied
schema; rollback never runs down migrations.

`stop` and maintenance deployments preserving both stopped stacks cannot produce
an active-runtime deployment record. The final actual Platform/Workload activity
readback controls active observation and upload, rather than the selected action. Preserve its operation
record and independently capture the original image/parameter tuple, admission
state and stopped-stack/task readbacks; the subsequent reviewed `start` supplies
active evidence. A still-running
verification/helper task remains registered for explicit recovery. Inspect it and
its owner before cleanup; expiry or task-runner failure is not task cessation.

Upload `deployment-evidence/deployment-record.json` as
`infra-deployment-<run-id>-<attempt>` with 90-day requested retention.
Record actual hashes and effective expiry; missing/expired
artifacts cannot authorize qualification or rollback. SSM selection/deployment
values alone are not observed release proof. Final E2E v2 qualification runs in a
separate scheduled window and compares authenticated observations before/after
against the exact deployment record.

Inactive CDK deployments explicitly pass `--no-rollback` to prevent native
CloudFormation rollback from restoring activity during stop or stopped-state
maintenance. Failure leaves partial resource state for explicit reviewed recovery;
resource replacements unsupported in this mode must fail rather than trigger a
restart. Preserve actual stack outputs/statuses and admission readback.

Before stop drains, the successful one-shot close is bound to the exact pinned
image/task/command and must set SSM and DB suspension in that reviewed Service
image. Infra immediately re-reads `admission_suspended=true`; false, malformed or
unavailable readback aborts before drain or CFN. The #54 maintenance operator also
preserves independent DB/SSM status proof before native drain. Task success or
requested flags do not substitute for these observed maintenance conditions.
