# AnyWear Infra agent instructions

This repository owns shared AWS infrastructure and environment operations after
the verified #54 cutover. During bootstrap, AnyWear-Service remains the deployed
infrastructure authority.

- Follow the [AnyWear kanban workflow](https://github.com/git-malu/AnyWear/blob/main/.agents/skills/kanban-workflow/SKILL.md)
  and its [GitHub operations reference](https://github.com/git-malu/AnyWear/blob/main/.agents/skills/kanban-workflow/references/github-operations.md).
- Read the accepted ownership ADR and deployment contracts before modifying
  infrastructure. Keep proposed targets separate from observed implementation.
- Preserve existing stack names, construct/logical IDs, physical resources,
  endpoints, outputs and runtime-owned configuration through extraction.
- Service owns application/Lambda/migration/verification source and immutable
  artifacts. Do not generate the shared API or read mutable peer `main` as a
  deployment input. Client publishes independently through deployed interfaces.
- Commit one canonical v2 selection with full component source, release/asset
  identities and hashes. Ordinary runtime verifies the immutable Service release,
  direct tag/source, API sizes/digests, downloaded bytes and all components before
  AWS credentials. Preserve one complete native v0.1/v0.2 signed statement across
  release verification plus all five asset checks. Independently require exact
  completed-success publisher repository/workflow/main/source/run/attempt and
  both repository/head-repository owner identities before and after verification.
  Keep Service's shared parser/fixture full pin and hashes in
  `scripts/vendor/provenance.json`. Historical v1 records remain evidence only.
- Pass explicit `trustedInfraRoot`, `expectedInfraSha`, relative `selectionFile`
  and raw `selectionSha256`. Runtime uses exact reviewed main; E2E uses reviewed
  `compatibility.infra` and its actual `.infra-source` checkout. Require trusted
  Infra origin/full HEAD, clean tracked/untracked source, no replacement refs or
  hidden-index masking, a regular tracked selection without path links, and bytes
  equal to the committed canonical blob/hash. Vendored code is not a trust root.
  No publication ZIP, candidate/receipt, issue URL, token or expiry ceremony is a
  runtime prerequisite. Sanitized CLI children fix `GH_TELEMETRY=disabled`.
- Do not claim repository branch protection when the private plan cannot enforce
  it. The configured Beta environment restricts the branch to main. Apply the
  independently reviewed exact source/inputs and operational coordination
  with one writer; these are distinct from repository branch protection.
- Use `gh` for GitHub and `aws` for AWS. Verify account, profile and region before
  cloud commands. Run package/build commands here, never in the shell root.
- Before AWS mutations, verify protected main/workflow, explicit operation,
  account/region, committed selection/hash, identity phase, retention protection,
  reviewed stack source/hash and rollback inputs. Use one Infra runtime queue.
  Enumerate conflicting Actions, local processes, CloudFormation operations and
  ECS/helper tasks; timeout does not establish cessation. Repository concurrency
  is not a cross-repository lock; migration rollout stays separately coordinated.
- Maintenance deploys preserve both observed Platform and Workload activity.
  Unknown/mixed state fails with concrete evidence. Stop failures never implicitly
  start stacks or reopen admission; inactive CDK deploys use `--no-rollback` so
  native CFN failure cannot silently reactivate resources; preserve actual state and select start
  separately. Requested flags do not prove stopped state after CFN rollback.
- Use `runtime.yml` for ordinary Beta operations. Initial `appScope=foundation`
  bootstrap is a separately assigned operator allocation and needs no Service
  artifact. Never use `cdk bootstrap`, broader trust, shared-role fallback or new
  permissions to make a blocked bootstrap/consumer operation succeed.
- Every CLI scope requires explicit `legacyRoleOwnership=managed|external`.
  `managed` reproduces the Service source fixture; never use it as the live
  account plan. Foundation in account `650880818323`/`ap-east-1` owns only its
  existing provider/helpers. Live `external` leaves Dev/Beta legacy roles outside
  Foundation and Production absent, without import/adoption. Runtime always uses
  external. Later `identityPhase=retired` cannot retire external Beta trust or its
  unmanaged policy; a separate effective IAM writer/readback must do that.
- Dedicated roles separate direct responsibilities. The existing CDK execution
  role has `AdministratorAccess` and no permissions boundary: Infra deployment
  has transitive account-wide authority, not Beta resource isolation. Review
  effective bootstrap/inline/managed policies, including unmanaged
  `AnyWearBetaPipelineBaseline`, before retirement; synth alone cannot prove IAM.
- `identityPhase=legacy` and `retentionProtection=false` preserve the source
  baseline by default. Role additions, retention activation and old-role
  retirement require separate reviewed diffs/operations. Initial cutover keeps the
  live image, Client, Lambda bytes, runtime policy, endpoints and schema behavior.
- Production activation/onboarding remains outside #54. Keep its deployment and
  readiness gates disabled; its source blocker must fail before AWS credentials
  even if an activation variable changes. A separately reviewed onboarding PR
  must establish the target account, runtime and verifier contract before removing
  that blocker. Do not add Production roles or broaden bootstrap in #54.
- Keep one Git writer per physical repository and one deployment writer per
  environment. Preserve other owners' work and verify cessation before handoff.
- Delegate independent repository tasks with explicit paths/ownership; review
  child results before integration. Do not clean shared worktrees.
- Review diffs, run `git diff --check`, and complete repository checks before
  publishing. PR merge alone does not establish deployed acceptance.
- Never commit credentials, runtime secrets or unredacted cloud diagnostics.

## Required source checks

Use Node.js 24 and npm here; never run package commands in the AnyWear shell root.

```sh
npm ci
npm run audit:prod
npm run check
node scripts/create-test-inputs.mjs
node scripts/synth-matrix.mjs --artifact-directory .service-artifacts/test --baseline-templates test/baselines --output cdk.matrix
node scripts/synth-matrix.mjs --artifact-directory .service-artifacts/test --baseline-templates test/baselines --retention-protection true --output cdk.protected.matrix
git diff --check
```

Also synthesize the live Foundation with `appScope=foundation`,
`identityPhase=roles-added`, `legacyRoleOwnership=external`, account `650880818323`
and application region `ap-east-1`, then run `scripts/compare-live-foundation.mjs`
against that output. CI preserves the actual CLI template and comparison. The
authenticated Original fixture permits exactly six dedicated roles/two policies;
only fixed pseudo-parameter equivalence and declared CDK diagnostic metadata
differences are normalized. Provider/helper code, output and IAM changes fail.

`npm run check` runs CDK build/tests and Node contract/workflow tests. The production
dependency audit allows only the script's finite, dated exceptions; do not silently
renew them. Source matrix exceptions are exact Lambda asset locations, enumerated
Beta identity changes and explicitly selected retention activation. Unexpected
resource/output/endpoint/topology changes fail the gate. Original deployed CFN
templates and physical inventories remain an independent release check.

Both source matrices cover all three identity phases. The second explicitly
sets retention protection; review both `cdk.matrix/comparison.json` and
`cdk.protected.matrix/comparison.json`, which CI uploads together.

Review the [Beta runbook](docs/runbooks/beta-infrastructure.md) and
[cutover/recovery runbook](docs/runbooks/cutover-and-recovery.md). After IAM
retirement, collect a new deployment record and qualify that exact tuple through
E2E v2; earlier rehearsal evidence cannot substitute. Preserve source maps,
original component/build provenance, operation/recovery records and exact
run/attempt/artifact hashes before workspace cleanup.
