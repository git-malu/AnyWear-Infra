# Infrastructure cutover and recovery

This is a reviewed procedure for [AnyWear #54](https://github.com/git-malu/AnyWear/issues/54),
not a record of completed AWS actions. Record execution, original resources,
release decisions and exact recovery outcomes in the issue and protected run
artifacts. The [Beta operation runbook](beta-infrastructure.md) owns normal inputs.

The procedure's accepted #54 boundary is now recorded: Infra owns the sole
operational Beta queue, while Service owns application/migration/verification
source and immutable artifacts. The named legacy Beta role has deny-only trust
with zero inline or attached grants. This does not claim account-wide IAM
exclusivity or Beta resource isolation; the inherited Dev wildcard E2E subject,
`cdk-*` assume-role chain and CloudFormation `AdministratorAccess` execution
role remain outside scope.

## Foundation-only bootstrap

The initial artifact publisher role must exist before Service can produce sealed
inputs for application CDK. In a separately assigned Foundation/account-IAM
operator allocation, check out the reviewed full Infra source, verify AWS account and
`ap-east-1`, and compare the existing Foundation Original template, physical map,
effective OIDC/role policies and proposed synth. `appScope=foundation` omits
application/Billing construction and skips the Service artifact loader:

```sh
npm ci
npm run build
npx cdk synth AnyWearFoundationStack -c appScope=foundation -c identityPhase=roles-added \
  -c legacyRoleOwnership=external
```

Once the manager accepts that exact source/diff and records the operator/writer
window, the existing authorized operator can reconcile only Foundation:

```sh
npx cdk deploy AnyWearFoundationStack --exclusively \
  -c appScope=foundation -c identityPhase=roles-added -c legacyRoleOwnership=external \
  --require-approval never
```

All CLI entry points require explicit `legacyRoleOwnership=managed|external`.
`managed` is the separately identified Service source/simulation baseline; it is
not the deployed-account ownership mode. The live Foundation Original contains
only the provider/helpers/metadata. Dev belongs to `AnyWearInfraStack-dev`, Beta
is outside Foundation, and no Prod pipeline role exists. `external` is limited to
account `650880818323`/`ap-east-1`, keeps those external identities untouched, and
creates only the six dedicated roles plus two Foundation policies. There is no
import/adoption or automatic legacy-role retirement. Ordinary runtime hardcodes
this same external mode for all CDK construction, avoiding a later collision.

This creates the six dedicated roles while retaining the old Beta trust/grants.
Read back roles, immutable OIDC subjects and effective policies before configuring
consumers. Keep the old executor usable until its jobs and rollback obligations
have ended. Ordinary `runtime.yml` deployment later requires a sealed selection;
that requirement does not apply to this explicit Foundation-only operator path.
`appScope=billing` similarly synthesizes only Billing and requires its separately
assigned `us-east-1` window.

Use existing authorized operator credentials for bootstrap. Do not run `cdk
bootstrap`, create a wider deployment policy, expand bootstrap trust, substitute a
shared principal or onboard Production to resolve a missing role/input.

The baseline CDK CloudFormation execution role has `AdministratorAccess` and no
permissions boundary. The new deploy role's exact bootstrap-role assumption list
therefore leads to transitive account-wide deployment authority. Direct runtime,
Client, Service and E2E policies are narrower; the deploy chain is not a Beta
resource security boundary. Inventory the deployed bootstrap assume/pass chain,
inline/managed policies and execution role before authorizing that chain. A future
permissions-boundary/bootstrap redesign needs its own accepted scope and diff.

## Direct release verification

The [v2 committed selection](../contracts/release-selection.md) is the one input
authority. A source PR reviews the exact release/component identities and hashes.
The ordinary [runtime workflow](../../.github/workflows/runtime.yml) automatically
checks actual Service inputs before AWS credentials; source checks themselves
perform no private native read or deployment. E2E uses the same reviewed verifier
with its actual immutable Infra checkout, rather than reconstructing a selector
as an authority. Historical v1 receipts and handshake diagnostics remain preserved
historical evidence and are explicitly rejected as new runtime inputs.

Verification requires trusted Infra origin/full HEAD and clean tracked/untracked
source, without replacement refs or hidden index flags. The selected file must be
a regular tracked canonical blob without path links and its raw bytes must equal
both the commit and the explicit SHA-256. Verify the immutable release ID/tag/
source, all five asset IDs/names/uploaded states/API sizes/digests and downloaded
hashes, then validate Lambda/policy/schema components. Preserve the complete
native v0.1/v0.2 signed immutable-release statement across `release verify` and
all five `verify-asset` calls. The native statement does not carry workflow/run
identity: independently read the exact completed-success publisher main source,
workflow/run/attempt and both repository/head-repository IDs/owner IDs/logins
before and after verification. Re-read immutable release identities at the end.
Unavailable or changed evidence fails closed.

The protected Beta job first checks exact main/workflow/account/region, operation,
selection, explicit identity/retention and stack sources. It then creates a scoped
read-only App token for AnyWear-Service contents/actions/attestations, verifies
the selected release, and only then obtains distinct AWS OIDC principals. The CLI
uses a fresh external empty config and fixes telemetry off, excluding ambient
credentials, debug/config/Git/Node overrides. Source CI pins CLI 2.101.0 and
reproduces its original relative device-id write in a credential-free isolated
Linux network namespace; the fixed environment must preserve strict clean source.

A direct invocation uses explicit immutable inputs:

```sh
node scripts/artifact-consumer.mjs \
  --selection selections/beta-baseline.json --selection-sha256 "$SELECTION_SHA256" \
  --trusted-infra-root "$TRUSTED_INFRA_ROOT" --infra-sha "$INFRA_SHA" \
  --output-dir .service-artifacts/selected
```

There is no publication Actions ZIP, executable candidate/receipt/handshake,
mandatory issue-comment URL, writer token or expiry field in this path. The
reviewed selection and actual signed release/publisher checks replace that
ceremony. This source interface does not authorize the #54 cutover: the manager
still coordinates one rollout writer, resource cessation and the separately
reviewed maintenance/recovery plan. Foundation-only bootstrap remains below its
existing separately allocated operator boundary and requires no Service artifact.

## Bootstrap ECR retention without a sealed-input cycle

GitHub immutable releases do not stop ECR's count-based garbage collection.
Protect the existing current and required rollback digests before old-writer
retirement. The first sealed artifact publisher may require proof of the protected
policy before application CDK can consume that release. Break this cycle with a
bounded initial operator procedure, not wider bootstrap permissions.

In a separately reviewed ECR maintenance window, bind the exact account/repository,
policy content hash, current/rollback `(service_sha, digest)` list and existing
authorized operator. Freeze conflicting image publishers and deployments. Save
the original `get-lifecycle-policy` response, its exact `lifecyclePolicyText` bytes
and canonical hash, image/tag inventory and original policy absence if applicable.
Preserve this outside the removable worktree and in protected evidence.

The target Beta policy is exactly:

```json
{
  "rules": [
    {
      "rulePriority": 1,
      "selection": {
        "tagStatus": "tagged",
        "tagPrefixList": ["protected-service-"],
        "countType": "imageCountMoreThan",
        "countNumber": 1000
      },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 2,
      "selection": {
        "tagStatus": "any",
        "countType": "imageCountMoreThan",
        "countNumber": 30
      },
      "action": { "type": "expire" }
    }
  ]
}
```

Its canonical content SHA-256 is
`2d589aee6958df20f54de927bf1efc11db94e49c8516793d2c874cc97b57976e`.
This identifies the reviewed target text; authenticated readback must establish
that the effective repository policy has the same hash.

1. Verify each required digest is still present. Retrieve its exact OCI manifest
   with `ecr batch-get-image`; preserve exact manifest bytes and verify their hash
   matches the selected digest. Add `protected-service-<full-Service-sha>` with
   `ecr put-image` against those same bytes. Verify the returned digest and exact
   tag; an existing tag pointing elsewhere fails. Do not rebuild, upload layers,
   retag an unrelated image or replace immutable tags.
2. Inventory all images/tags and verify the protected digest count is at most 256.
   The priority-1 threshold of 1000 leaves at least 744 images of headroom. Tag
   ordering protects qualifying digests from the lower-priority any-image rule;
   protection remains contingent on the reviewed bound and exact effective policy.
3. Preview the reviewed target policy using `ecr start-lifecycle-policy-preview`
   with its exact policy text. Wait for `COMPLETE`, retrieve every preview result
   and reject any `EXPIRE` action for a current/rollback digest. Do not accept an
   in-progress/failed preview or partial paginated inventory.
4. The assigned existing operator applies only that reviewed policy with `ecr
   put-lifecycle-policy`. Re-read its canonical hash, exact tags and all required
   digests, preview the effective policy again, and verify the policy has not
   changed during preview. Preserve both policy readbacks and preview results.
5. Under manager-approved Infra execution, `node scripts/ecr-retention.mjs required-images.json`
   validates the same rules/tags/bounds and completed preview, using
   `ECR_RETENTION_VERIFIED_POLICY_SHA256` to bind the approved hash. The required
   file is an array of exact `service_sha`/`digest` objects. The runtime role can
   tag existing manifests and preview/read the policy; it cannot directly replace
   the policy or upload/delete images. Initial policy installation uses the
   separately assigned existing operator, not an expanded runtime role.
6. Publish/import the sealed Service baseline with the verified policy hash and
   protected current/rollback list, then commit the reviewed v2 selection
   and verify it through the ordinary workflow described above. Reconcile Platform later with
   the same live artifacts and explicit `retentionProtection=true`, so CDK owns
   the identical policy. Never deploy the default `false` context over the staged
   protection.

Recheck digest/tag presence, effective hash and preview immediately before
deployment/rollback and after any authorized image publication. If the inventory
exceeds the bound or any check changes, hold selection/retirement and schedule
repair; never silently raise the threshold or discard a rollback digest.

If policy installation must be reversed, keep writers frozen, recheck that the
saved old policy would not expire required digests, and obtain the explicit
recovery writer for that exact original policy. Restore saved policy bytes
with the existing authorized operator, or restore absence only when absence was
the captured original state. Read back and hash the result, recheck digests and
record the failed protection attempt plus recovery result. Restoring a policy
does not restore an expired image. Keep new activation and old-role retirement
closed until a reviewed protection condition is available again.

## Application-preserving ownership cutover

Capture live Original CFN templates and physical resource maps independently from
the source-synth matrix. Preserve stack/construct/logical/resource identities,
SSM names/runtime admission values, exports, endpoints and unchanged database
behavior. The legacy `AnyWearInfraStack-dev` is outside this migration.

The baseline import retains independently proven component producers. Preserve
the already deployed Lambda ZIP bytes, their `index.js` and source maps, exact
bootstrap bucket/key, ZIP SHA-256/live `CodeSha256`, original protected build source,
lock/toolchain inputs and original run/attempt. A later recovery or equal source
contents does not invent build provenance. Keep imported image, policy and schema
producer sources separate from the manifest publisher's workflow SHA/run.

After roles and consumers are proved, freeze old Service infrastructure writers
and conflicting Client/E2E operations, verify cessation, then assign Infra one
runtime allocation. The first Infra reconcile uses the same live image, Client,
Lambda bytes and policy. Review real change sets/diffs against original physical
identities; source-matrix equality alone does not authorize a replacement.
Verify stable independent Client publication through existing CFN/SSM outputs.
Retain the original templates, selected assets and usable recovery writer.

Exercise reviewed stop/start and compute rollback. `deploy-workload` can select a
previous immutable release while retaining compatible applied schema; it does not
run down migrations. `start` retains its explicit forward migration/verification
sequence for the pinned image, so its schema boundary and rollback compatibility
must already be reviewed. Failed stop never implicitly restores network, Workload or admission. Record
actual outputs/statuses and admission state, preserve partial/stopped state, and
select a separately reviewed start after resolving the failure. Native CFN
rollback may leave active or mixed state; requested false flags are not evidence.

For #54, the bounded practical recovery was executed as [stop
37886520975](https://github.com/git-malu/AnyWear-Infra/actions/runs/37886520975)
then [start 37887802281](https://github.com/git-malu/AnyWear-Infra/actions/runs/37887802281),
both with historical Infra producer `bafc3072ea6aee2d5193009c014cb1cf04b43848`
and coherent Service release `407218593`. This does not exercise active
`restore-release` or automatic failure recovery. Historical release `406706155`
remains preserved evidence but is byte-incoherent and cannot be selected for
current rollback. Do not relabel the observed Client/Service tuple or historical
Infra producer as a newer documentation or executor revision.

For an ownership failure, suspend the new writer, enumerate its running tasks/CFN
operations and verify cessation. Restore the recorded legacy source/templates/
assets with exactly one old recovery writer. Do not relabel original Service-era
evidence as Infra-produced. No retired strict sampler/drill matrix is reintroduced
as a #54 gate.

## Retirement and final qualification

After rehearsal and rollback acceptance, schedule Foundation/IAM retirement
separately from Beta runtime and billing. In the actual `external` ownership mode,
`identityPhase=retired` removes template-owned Platform grants and retains the
dedicated consumers; Foundation never owned the old Beta role, so this phase
cannot retire its trust or unmanaged `AnyWearBetaPipelineBaseline`. Those require
the separately reviewed IAM writer/diff/readback after old sessions cease. Dev
remains with its original stack, and Production remains absent. The `managed`
source/simulation fixture's retired role is not a live retirement result.

Inventory and explicitly reconcile `AnyWearBetaPipelineBaseline`, all other
inline/managed attachments and bootstrap trust. Record exact intended removals
and read back effective authorization after the active executor and nested cleanup
helpers stop. Verify Service cannot assume CDK roles, Client cannot push Service
images/deploy CFN, and E2E cannot reconcile infrastructure. Retire Service CDK/runtime
entry points only after their recovery obligations and consumer migrations finish.

Observe new post-retirement Original templates and actual runtime identities,
publish a new trusted completed-success Infra deployment record, then run final
E2E v2 qualification against that exact record in its scheduled window. Pre-retirement
rehearsal hashes cannot substitute. Preserve deployment/operation/recovery records,
committed selection bytes, signed releases and publisher identities, authenticated
before/after observations and exact source/run/attempt/artifact hashes before root
registration, repository reconciliation or resource cleanup.

The accepted final correctness evidence is [E2E run
37949887097](https://github.com/git-malu/AnyWear-E2E/actions/runs/37949887097),
attempt `1`, with correlated Service cleanup [run
37950914153](https://github.com/git-malu/AnyWear-Service/actions/runs/37950914153)
and final admission closure [Infra run
37951949885](https://github.com/git-malu/AnyWear-Infra/actions/runs/37951949885).
The deployed Client `8320db0816b1c2d36e79a583160548744fd3d8c0`, Service
`ab211c8212444b735e614ef9a74f184d24744d6b` and historical Infra observer
`bafc3072ea6aee2d5193009c014cb1cf04b43848` remain distinct from the newer
qualification/cleanup executor heads. The suite intentionally skipped public
registration under closed intake; the observed provider timeout/retry case is a
correctness observation, not a latency SLA or a provider/network diagnosis.

Production deployment and readiness gates remain disabled. The workflow has a
source blocker before AWS credential assumption: changing an activation variable
cannot establish its missing target-account/runtime/verifier contract. A separately
reviewed onboarding PR must complete that contract before removing the blocker.
Future promotion also requires a sealed stable Service release, completed-success
exact E2E v2 qualification, digest-preserving promotion and scan policy. Artifact
prereleases, legacy v1 records or a Beta bootstrap do not activate that path.
#54 makes no Production execution claim.

Inactive CDK deployments explicitly pass `--no-rollback` to prevent native
CloudFormation rollback from restoring activity during stop or stopped-state
maintenance. Failure leaves partial resource state for explicit reviewed recovery;
resource replacements unsupported in this mode must fail rather than trigger a
restart. Preserve actual stack outputs/statuses and admission readback.
