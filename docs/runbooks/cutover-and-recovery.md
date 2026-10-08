# Infrastructure cutover and recovery

This is a reviewed procedure for [AnyWear #54](https://github.com/git-malu/AnyWear/issues/54),
not a record of completed AWS actions. Record execution, original resources,
release decisions and exact recovery outcomes in the issue and protected run
artifacts. The [Beta operation runbook](beta-infrastructure.md) owns normal inputs.

## Foundation-only bootstrap

The initial artifact publisher role must exist before Service can produce sealed
inputs for application CDK. In a separately assigned Foundation/account-IAM
operator window, check out the reviewed full Infra source, verify AWS account and
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

## Publication acceptance

The publication contract uses GitHub's native signed immutable-release statement
and a separately reviewed immutable receipt in Infra. The signed statement binds
the full release Git commit and all release assets. It has no publisher workflow,
run or attempt fields; preserve that distinction when reviewing provenance.
Service owns the shared publication parser and its fixture. An import publisher
and the independently proven original component producers remain separate.

[publication-acceptance.mjs](../../scripts/publication-acceptance.mjs) exports
`createPublicationCandidate` for the independent review preparation and
`loadPublicationAcceptance` for pinned consumer verification. Receipt v1 uses
`record_type=anywear_service_publication_acceptance` and these exact field groups:

| Fields | Preserved evidence |
| --- | --- |
| `schema_version`, `record_type` | Version `1` and the publication-acceptance record identity |
| `repository`, `producer` | Service repository name/ID/owner ID and complete original manifest publisher identity |
| `release` | Exact `id`, `tag`, full commit `target`, `manifest_asset_id`, `manifest_sha256`, and sorted `assets` with each `id`, `name`, `sha256`, `size` |
| `publication` | Exact `artifact_id`, `artifact_name`, `archive_sha256`, `record_sha256`, and original raw `record_base64` |
| `manager_acceptance_url`, `verified_at` | Manager review-comment reference and UTC verification timestamp; source approval comes from the separate reviewed Infra pin/window |

The shared native verifier and fixture are pinned from Service
`8dfb61b1ff4f671eed27d3a7cb8d315bed3d68ce`. The complete source paths and raw file
hashes are in [vendor provenance](../../scripts/vendor/provenance.json); retain
that pin when validating the [native fixture](../../test/fixtures/native-release-source.md).
The original CDK source-synth baseline has separate Service provenance in
`test/baselines/provenance.json`.

1. Independently retrieve the exact publisher run/attempt from Service using the
   read-only private-repository access. Require the expected repository,
   reviewed main source/workflow identity, `completed` status and `success`
   conclusion. Select the unique bounded Actions ZIP artifact named
   `service-artifact-publication-<run-id>-<attempt>` and its exact
   `service-artifact-publication.json` entry. Record the artifact ID, archive hash
   and raw publication-record byte hash. The ZIP is at most 2 MiB and contains
   exactly one record of at most 256 KiB; the receipt is at most 1 MiB. Reject
   duplicates, unexpected ZIP entries, excessive sizes, missing/expired archives
   or a different attempt. Compare the downloaded ZIP size/hash with the
   authenticated Actions inventory and its creation interval for that attempt.
2. Independently retrieve the sealed immutable release and every asset by exact
   release/asset ID. Verify GitHub's native signed release statement, the full Git
   commit and all asset names/hashes against the publication record, selected
   manifest and downloaded bytes. Retain the complete asset inventory and
   publisher/component producer identities. A partial asset comparison cannot
   establish acceptance, and the native statement cannot supply absent
   workflow/run identity.
3. Use the read-only [candidate CLI](../../scripts/create-publication-candidate.mjs)
   with the exact preparation selector and designated manager review-comment URL.
   It independently downloads every selected release asset, verifies the native
   statement, paginates the bounded publisher artifact inventory, and checks the
   completed-success publisher attempt before and after retrieval. Candidate
   creation grants no approval and makes no Git/AWS changes. Preserve the complete original
   publication record as embedded base64 plus its raw-byte SHA-256, its producer
   and asset evidence, and the original Actions archive hash. These contents must
   survive in the tracked receipt for long-term use even when the original
   Actions archive later expires.
4. The manager independently reviews the publication/run/release/assets and
   exact candidate bytes, then records the review handshake in an issue comment.
   Bind the reviewed receipt hash, manifest hash, full publisher source,
   run/attempt, release/asset IDs and evidence to that decision. A receipt that
   merely includes a comment URL does not authorize itself; retain the actual
   review decision and reviewer identity.
5. Add the accepted receipt as `publications/<full-manifest-sha256>.json` through
   the reviewed Infra commit. Add the selector's top-level
   `publication_acceptance: { file, sha256 }`, where `sha256` hashes the exact raw
   receipt bytes. Only then authorize the reviewed main writer window for that
   exact full Infra source, selector/hash, operation and expiry. The receipt
   review and source/window authorization are separate recorded decisions.
6. Subsequent consumers compare the live native signed release commit/all assets
   with the preserved receipt, manifest and raw hashes, and still require the
   exact publisher run/attempt to be available and completed successfully. Use
   explicit `trustedInfraRoot`/`expectedInfraSha`: runtime's reviewed main
   workspace at the window SHA, or E2E's `.infra-source` checkout at its reviewed
   `compatibility.infra` pin. Require the exact Infra origin/full HEAD and a clean
   checkout including untracked files. The receipt must be a regular tracked
   blob in that revision, traverse no linked paths and match its committed bytes
   and selector raw-byte hash. Missing runs, altered assets/receipts or another
   checkout fail closed. Later acceptance uses the preserved receipt evidence;
   expiration of the captured Actions ZIP does not erase it. A vendor directory
   or URL alone establishes no source trust.

The deployment record preserves `selection.publication_acceptance` with the
release and component sources, so qualification and rollback use the same reviewed
receipt rather than selecting another publisher attempt.

For candidate preparation, use the exact release/component IDs/hashes and future
receipt path. The preliminary selector can have a syntactically valid 64-hex
placeholder for the yet-unknown receipt hash; that file is only a review input.
Run the CLI with the configured read-only `GH_TOKEN`:

```sh
node scripts/create-publication-candidate.mjs \
  --selection selections/cutover-preparation.json \
  --output .service-artifacts/publication-candidate.json \
  --manager-acceptance-url "$REVIEW_COMMENT_URL"
```

The local candidate is written to `--output`. Stdout reports `candidate_only: true`,
the exact raw receipt-byte `sha256` and final `publications/<manifest-sha256>.json`
path. After independent manager review, the Git writer adds those exact receipt
bytes at that path through the reviewed Infra change and replaces the preparation
hash with the printed hash in the final selector. Authorize the window only after
that receipt/source review. The CLI output and a placeholder selector are not
accepted deployment inputs.

Before reviewing retention activation, compare both source matrices across all
three identity phases. In addition to the default matrix, run:

```sh
node scripts/synth-matrix.mjs --artifact-directory .service-artifacts/test --baseline-templates test/baselines --retention-protection true --output cdk.protected.matrix
```

Review `cdk.protected.matrix/comparison.json` with the default report. Source CI
produces both reports; real Original templates, physical maps and effective IAM
remain separate release evidence.

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
   protected current/rollback list, then complete the independent publication
   acceptance review above and commit its receipt. Reconcile Platform later with
   the same live artifacts and explicit `retentionProtection=true`, so CDK owns
   the identical policy. Never deploy the default `false` context over the staged
   protection.

Recheck digest/tag presence, effective hash and preview immediately before
deployment/rollback and after any authorized image publication. If the inventory
exceeds the bound or any check changes, hold selection/retirement and schedule
repair; never silently raise the threshold or discard a rollback digest.

If policy installation must be reversed, keep writers frozen, recheck that the
saved old policy would not expire required digests, and obtain the explicit
recovery writer/window for that exact original policy. Restore saved policy bytes
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
runtime window. The first Infra reconcile uses the same live image, Client,
Lambda bytes and policy. Review real change sets/diffs against original physical
identities; source-matrix equality alone does not authorize a replacement.
Verify stable independent Client publication through existing CFN/SSM outputs.
Retain the original templates, selected assets and usable recovery writer.

Exercise reviewed stop/start and compute rollback. `deploy-workload` can select a
previous immutable release while retaining compatible applied schema; it does not
run down migrations. `start` retains its explicit forward migration/verification
sequence for the pinned image, so its schema boundary and rollback compatibility
must already be reviewed. Failed stop attempts recovery of the original network,
Workload and admission state; authenticate their final readbacks and keep both
failure and recovery evidence.

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
accepted publication receipts, authenticated before/after observations and exact
source/run/attempt/artifact hashes before root registration, repository
reconciliation or resource cleanup.

Production deployment and readiness gates remain disabled. The workflow has a
source blocker before AWS credential assumption: changing an activation variable
cannot establish its missing target-account/runtime/verifier contract. A separately
reviewed onboarding PR must complete that contract before removing the blocker.
Future promotion also requires a sealed stable Service release, completed-success
exact E2E v2 qualification, digest-preserving promotion and scan policy. Artifact
prereleases, legacy v1 records or a Beta bootstrap do not activate that path.
#54 makes no Production execution claim.
