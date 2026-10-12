# Protected Beta cleanup acceptance fixture

This bounded operator fixture implements [AnyWear #86](https://github.com/git-malu/AnyWear/issues/86).
Source delivery, immutable Service publication, deployed capability acceptance
and E2E qualification are separate gates. A merged PR or reviewed map grants no
environment window. The fixture refuses anything except stable active
Platform/Workload, closed intake and suspended admission.

## Source and release order

The committed `selections/beta-cleanup-86.json` snapshot selects Service
`2c9e6582a04e587ad627e2e96191b68069dab876`, release `409515424` and image
`sha256:f27797f979d6981c03d2818166b9e2a1db0d84539a9a7978f72a9cf5894f0574`.
The canonical selection SHA-256 is
`8c93ee1d4618fe3b0e46313fb933b45099773767d0ab9a63c1788f46ef3b4bb6`.
Native release/asset verification and successful-publisher provenance precede
cloud credentials. Infra consumes immutable artifacts without rebuilding Service.

Relative to observed source `ada13617da0280ca9a7da0798577db286e714edc`, the core
cleanup capability adds nine Platform `PublishOutput` interfaces and log-write
grants to the existing one-shot execution role. Deploy Platform first in an
explicitly authorized active Beta window after reviewing actual component/template
diffs. `stack-sources/beta-cleanup-86-platform.json` binds only touched Platform
to `@executor`; other stacks retain their historical producers. After actual
Platform acceptance, publish a separate reviewed map recording that producer
and binding the upcoming Workload deployment. Maps declare provenance; they do
not choose historical CDK implementations.

Workload provisions the core versioned cleanup capability and retained
`beta-anywear-cleanup-acceptance` task. The fixture adds exactly one Workload task,
one policy on the existing Infra runtime role and
`CleanupAcceptanceTaskDefinitionArn`; it adds no further Platform delta. Record
the observed state-machine version, fixture task revision, Infra producers and
coherent Service image. Fixture execution requires a final committed four-stack
map with explicit SHAs and rejects every `@executor`. Foundation lifecycle,
Billing and Client publication are outside this operation.

Deployment requires issue #104's reviewed finalizer repair and truthful gate-false
acceptance. Fixture source checks do not satisfy that independent prerequisite.

## Fixed authority and inputs

`.github/workflows/beta-cleanup-acceptance.yml` is separate from the six ordinary
workflow families. It uses the non-cancelling `anywear-infra-runtime` queue, the
`beta` environment, protected main source/owner checks and default-closed
`ENABLE_BETA_CLEANUP_ACCEPTANCE`. Keep that dedicated fixture gate closed except
for an explicitly authorized recorded window, then close it afterwards. This gate
is independent of `ENABLE_BETA_DEPLOY` and cannot start or restore Beta.

Only `prepare`, `inspect`, `release-task` and `cleanup` are accepted. Inputs name
the full deployed task ARN, exact Workload source, committed selection/hash,
committed final stack-map/hash, canonical request and canonical bootstrap origin.
The fixture request uses `run_scope` and exactly slots 2 and 3 with distinct
captured lowercase UUIDs and fixed chromium worker emails. Ordinary cleanup
strings retain camelCase `runScope` and `users[].sub`; reuse the bootstrap's exact
strings/hashes during qualification.

The task runs `node dist/ops/beta-cleanup-acceptance-fixture.js` with the selected
Service image, existing cleanup role and `beta-anywear-one-shot-execution` role.
Only the action/request are appended. Environment/role overrides, arbitrary
commands, task registration/stop, lifecycle changes and E2E fixture mutation
authority are absent. Independent read and run sessions use the existing Infra
runtime principal; each policy is measured against STS's 2048-byte bound. Reads
cover only the two Beta stacks, exact admission parameters, fixed definition,
cluster task inventory and fixture log prefix. RunTask covers only the exact
fixture definition/cluster; PassRole covers its two fixed ECS roles with the ECS
service condition. Credential errors omit tokens and secret command arguments.

## Bootstrap proof and phases

E2E owns the protected five-phase workflow and two-account budget. Infra requires
the exact completed-success main run, repository/head-repository numeric owner
identity, workflow path, source, run and attempt. Its eight-field origin binds
artifact ID, raw ZIP hash and raw manifest hash. GitHub digest/expiry, bounded
bytes, fixed archive names, duplicate-key rejection and metadata rereads prove
the input. ZIP contents are read to stdout; paths/links are never extracted or
followed on disk.

Intent publishes `creation-intent.json` and `account-budget.json` before creation.
Bootstrap publishes those exact intent bytes, `bootstrap-manifest.json` and the
captured budget. Validators bind two lease UUIDs, subjects/usernames, fixed budget
and statuses, producer scope, intent-before-creation and capture-before-bootstrap
timing, and the frozen Service/capability/fixture/selection/stack-map tuple.

1. Bootstrap captures both fresh identities and exact request strings, retaining
   both until teardown.
2. Fixture `prepare`/`inspect` precede an active-task-only refusal run. Then
   authenticate a fresh `inspect` proving both identities unchanged.
   A second `refusals` run performs only the mismatch case, importing the exact
   active-refusal origin and that fresh inspection. A second authenticated inspection
   again proves both unchanged. Both runs retain the same bootstrap and tuple.
3. That second `inspect` and `release-task` precede qualification. E2E publishes immutable
   operation intent and started/pending evidence, then deliberately ends tracking.
4. Fresh recovery imports exact preceding evidence and resumes the same execution
   and request, proving committed primary cleanup and repeat safety. No new
   account may be created; the sentinel remains intact.
5. An `inspect` verifies recovery before E2E teardown removes the sentinel
   and closes both leases. Preserve every run/attempt/artifact origin.

## Result and recovery

Success requires an actual unique STOPPED task, exit zero, selected image, fixed
command and one committed Service marker unchanged across complete log scans.
Service emits it only after commit and DB closure. Original/final stack versions,
Workload template, task definition, Platform outputs and admission must match.
The executor uploads `cleanup-acceptance-operation.json` as
`beta-cleanup-acceptance-<run>-<attempt>`; E2E authenticates the same protected
Infra artifact before accepting a fixture result.

Uncertain launches or unresolved tasks remain failure evidence. Do not retry
RunTask or stop a task automatically. Account for tasks, executions, Actions and
CFN before opening a new writer window. The replacement fence includes this
fixture family.

Recovery preserves the coherent newly published wrapper/fixture image and
current capability while source is repaired. Release `407218593` predates both;
that image under new capability source is incoherent. A historical release/map
alone proves no rollback. Existing protected E2E account recovery can provide
manual cleanup only after its authority and result are verified for an explicitly
authorized window. Retire old normal-cleanup grants only after capability, fixture
and manual fallback acceptance. This source introduces no ordinary cleanup workflow.
