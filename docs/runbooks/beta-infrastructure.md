# Reviewed Beta infrastructure operations

This runbook describes the source entry points for [AnyWear #54](https://github.com/git-malu/AnyWear/issues/54).
AnyWear-Service remains the deployed infrastructure authority until the recorded
cutover. Account `650880818323` uses `ap-east-1` for the application and `us-east-1`
for Billing. Initial cutover preserves the observed image/Client/Lambda/policy
tuple and endpoints; ordinary source merges do not choose a newer application.

## Private repository controls and access preflight

The 2026-10-08 setup readback has a `beta` environment limited to the `main`
branch. Its activation gate is `ENABLE_BETA_DEPLOY=false`. GitHub returned 403
for private repository rulesets/branch protection under the current plan; the
environment's branch restriction does not mean `main` has repository branch
protection. Use supported branch protection when available; the current controls
include the manager's recorded operational freeze: independently reviewed
exact source, one writer, no peer merges, exact-SHA window/dispatch gates, and
activation disabled between assigned operations. This does not authorize a
runtime operation by itself.

[app-access-preflight.yml](../../.github/workflows/app-access-preflight.yml)
only runs for same-repository PR1 on `codex/issue-54-infra-extraction` after the
manager sets `APP_ACCESS_REVIEWED_SHA` to that reviewed full head. A second
checkout/source guard runs before App credentials are used. It requests separate
single-repository tokens for Service contents/actions read, Infra contents/actions
read, and root AnyWear issues read. Exact repository/owner IDs, source commits,
completed-success CI attempts, and the original #54 owner claim are checked.
Only sanitized status/identity evidence is uploaded; key/token bytes stay inside
Actions. The workflow has no AWS credentials, OIDC permission, release mutation,
or deployment step. Close the variable gate after collecting the accepted run.

## Manager window and immutable inputs

Before enabling a writer, the manager records the exact Infra SHA, operation,
expiry, selector file/hash, stack-source file/hash, identity phase, retention
setting, original running tuple, rollback inputs, owner and #54 comment URL.
Freeze conflicting Service CDK/runtime dispatch and automatic deployments,
Client publishing and E2E/recovery windows. Enumerate their Actions, local
processes, nested helpers, CFN changes and ECS tasks; verify cessation before
handoff. Reusing a repository concurrency-group name does not coordinate peers.

The `beta` environment controls `ENABLE_BETA_DEPLOY` and these exact values:

| Variable | Required binding |
| --- | --- |
| `AWS_ACCOUNT_ID`, `AWS_REGION` | `650880818323`, `ap-east-1` |
| `INFRA_WRITER_WINDOW` | Recorded token, identical to dispatch `writer_window` |
| `INFRA_WINDOW_SHA` | Reviewed full Infra `GITHUB_SHA` on `refs/heads/main`, with the controls above |
| `INFRA_WINDOW_EXPIRES_AT` | Valid future timestamp; expiration stops subsequent guarded mutations |
| `INFRA_WINDOW_RECORD_URL` | #54 manager issue-comment URL |
| `INFRA_WINDOW_OPERATION` | Exact dispatch operation |
| `INFRA_WINDOW_SELECTION_SHA256` | SHA-256 of exact canonical selector bytes |
| `INFRA_WINDOW_STACK_SOURCES_SHA256` | SHA-256 of exact reviewed stack-source bytes |
| `INFRA_IDENTITY_PHASE` | `legacy`, `roles-added` or `retired`, identical to dispatch |
| `INFRA_RETENTION_PROTECTION` | `true` or `false`, identical to dispatch |
| `INFRA_DEPLOY_ROLE_ARN` | `arn:aws:iam::650880818323:role/beta-infra-deploy-role` |
| `INFRA_RUNTIME_ROLE_ARN` | `arn:aws:iam::650880818323:role/beta-infra-runtime-role` |
| `INFRA_WINDOW_TESTERS_SHA256` | Hash of normalized tester JSON for a tester operation |

`selections/<reviewed-name>.json` contains selector v1 with exact Service release,
manifest/asset IDs, hashes, ECR digest and independent component source SHAs.
Its top-level `publication_acceptance` binds the reviewed receipt path and raw
receipt-byte SHA-256:

```json
{
  "publication_acceptance": {
    "file": "publications/<manifest-sha256>.json",
    "sha256": "<raw-receipt-sha256>"
  }
}
```

`artifact-consumer.mjs` requires a sealed immutable release, native GitHub signed
release statement with the full Git commit and every asset, exact tag/source
binding, a live completed-success trusted publisher run/attempt, and the reviewed
receipt at the trusted Infra revision. Native release signatures have no workflow
or run identity; the [publication acceptance review](cutover-and-recovery.md#publication-acceptance)
supplies that binding from independently retrieved publication evidence. The
deployment record carries the same `selection.publication_acceptance` binding.
Missing assets, mismatched IDs/hashes, unknown versions, unavailable publisher
runs or modified/untracked receipts fail closed. Private reads use the configured
read-only GitHub App; installation access is proved before activation.
`APP_PRIVATE_KEY` stays in the protected secret store.

Every verifier caller supplies explicit `trustedInfraRoot` and `expectedInfraSha`.
Runtime uses the reviewed main workspace and exact `INFRA_WINDOW_SHA`/
`GITHUB_SHA`; E2E uses the `.infra-source` checkout at its reviewed
`compatibility.infra` pin. Require the exact Infra Git origin, matching full HEAD
and a clean checkout including untracked files. Verify the receipt is a regular
tracked blob at that commit, its path traverses no links, and its raw-byte hash
matches both the selector and committed bytes. Copying a verifier into a vendor
directory does not establish that directory as the trusted Infra source.

`stack-sources/<reviewed-name>.json` has four unique rows: `stack_name`, `region`,
`source_repository`, `source_sha`. Retain Service source identity for unchanged
Foundation/Billing stacks. A touched stack must name this exact Infra executor.
The reviewed Infra-only `@executor` placeholder resolves to `GITHUB_SHA` before
the final record is written; final records contain full SHAs. Source declarations
are reviewed provenance inputs; authenticated CFN Original templates supply the
actual deployed template hashes.

## Entry points

[runtime.yml](../../.github/workflows/runtime.yml) runs on manual dispatch, reviewed
main, the `beta` environment and an open activation gate. It validates the window
and source inputs before credentials, then assumes dedicated deploy/runtime roles
as needed. All its operations share the Infra queue.
Every runtime CDK call explicitly selects `legacyRoleOwnership=external` for
this account. Foundation never constructs or adopts the external legacy roles.
The `managed` source/simulation mode is used only by the independently labeled
Service baseline matrices and cannot substitute for the live Original comparison.

| Operation | Behavior |
| --- | --- |
| `deploy-foundation` | Reconcile existing Foundation with reviewed identity phase; ordinary workflow still requires a sealed selection |
| `deploy-billing` | Reconcile existing Billing in `us-east-1` |
| `deploy-platform` | Reconcile Platform using selected prebuilt Lambda/policy inputs; retain observed image and runtime active/stopped state |
| `deploy-workload` | Select the explicit immutable image; verify compatible applied schema before rollout; no implicit migration or down-migration |
| `migrate` | Invoke Service's forward migration command in the selected immutable image |
| `verify` | Invoke Service's verification command; verify the selected runtime without migrating |
| `start` | Restore network, suspend admission, run the pinned migration/verification sequence, restore Workload and health, then execute the recorded admission restoration |
| `stop` | Suspend admission, drain, stop Workload, verify task cessation, then stop paid Platform network; retain recovery inputs |
| `observe` | Collect authenticated active-Beta deployment evidence |
| `tester-status` | Read admission/tester status through the selected existing Service lifecycle command |
| `tester-add`, `tester-replace` | Update the exact normalized tester list using the selected lifecycle command, with public intake closed |

A dispatch uses reviewed repository files and exact manager values, for example:

```sh
gh workflow run runtime.yml --repo git-malu/AnyWear-Infra --ref main \
  -f operation=observe -f writer_window="$WINDOW" \
  -f selection_file=selections/cutover.json -f selection_sha256="$SELECTION_SHA256" \
  -f identity_phase=roles-added -f retention_protection=true \
  -f stack_sources_file=stack-sources/cutover.json
```

Use the actual reviewed filenames, phase and retention setting in the recorded
window. Initial role bootstrap uses the [Foundation-only procedure](cutover-and-recovery.md#foundation-only-bootstrap),
because no sealed Service release is needed to create the artifact publisher role.

## Tester and cleanup ownership

Tester dispatch supplies `tester_emails` as a JSON string. Input normalization
occurs before credentials; the manager binds the normalized payload hash through
`INFRA_WINDOW_TESTERS_SHA256` and binds the action through
`INFRA_WINDOW_OPERATION`. `tester-status` requires the empty array `[]`.
Add/replace use exact normalized email addresses, at most 50 users and the bounded
SSM payload size. Their operation evidence records the effective payload hash.
Service's existing `configure-testers` command closes admission, changes the
allowlist and restores the recorded suspension state; public intake must already
be closed. Do not use that path to reopen public registration.

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
immutable Service artifact, the reviewed exact payload and the frozen writer
window. Reading `DatabaseSecret` does not create a database principal with
read-only grants. Verification's read-only behavior comes from the reviewed
command and its read-only transaction, including the authenticated inspection's
`repeatable read read only` transaction; secret access alone does not enforce it.

## Evidence and stopped-state recovery

Preserve `deployment-evidence/operation-record.json` under the always-attempted
`infra-operation-<run-id>-<attempt>` artifact even on failure. Its version-1
`anywear_infra_operation` record keeps the original
selection/receipt binding and independent selected Service component sources
separate from the current Infra executor SHA/run/attempt. It records actual
Original template hashes and the original Workload image/source readbacks,
reviewed per-stack source declarations, completed one-shot task/deployment events,
recovery status and the operation result. The record also retains the copied
lifecycle implementation's original Service source. Preserve authenticated task,
admission and stopped-state readbacks plus Actions logs for interruption/recovery
review; a recovery status alone does not establish those observations. A
successful recovery does not turn the failed operation into success. Failures
before record creation can leave no artifact; preserve Actions logs and the
manager record rather than manufacture a successful operation record.

For active Beta, `observe-deployment.mjs` writes deployment v1 from actual Original
CFN templates, Lambda CodeSha/stable configuration, running ECS definitions and
digests, queue settings, Client metadata/endpoints and a bounded read-only schema
task. It hashes template content, not AWS CLI response wrappers. The queue hash
proves only observed queue settings; full runtime policy and applied DB migrations
come from the exact-image verification task. The HTTP minimum-schema value does
not prove the applied DB version.

The unchanged image's one-shot inspection embeds Infra's reviewed read-only
command; it does not assume newly added Service code. Evidence binds command hash,
Infra source, original image/Service source, executor run/attempt and actual ECS
task/definition. Selected image migrations and observed applied migrations are
separate histories. A compatible older image may run against a later applied
schema; rollback never runs down migrations.

`stop` cannot produce an active-runtime deployment record. Preserve its operation
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
