# Beta Base/Runtime split migration (one-time, Deployment-gated)

Issue #166 turns Beta into three stacks with disjoint lifetimes:

| Stack | CloudFormation stack | Owner | Lifetime |
| --- | --- | --- | --- |
| `Base` | `AnyWearPlatformStack-beta` (name retained) | AnyWear-Infra | persistent |
| `Egress` | `AnyWearEgressStack-beta` | AnyWear-Infra | deleted on stop |
| `Runtime` | `AnyWearRuntimeStack-beta` (replaces `AnyWearWorkloadStack-beta`) | AnyWear-Service | deleted on stop |

The only resource that changes stack is the API CloudFront distribution: a
one-time CloudFormation stack-refactor MOVE from the Service-owned legacy stack
to `Base`, preserving its physical ID and therefore its `*.cloudfront.net`
domain. This runbook executes nothing by itself and is not part of the source
delivery. **Do not run any stage without the Deployment gate's explicit
authorization recorded in the issue.**

## Non-negotiable preconditions

- The issue worker has recorded the user's Deployment decision for #166 (accept
  the three-stack split and supersede #159's resident direction).
- A fresh live Beta tuple read-back exists: both stacks, the API distribution ID
  and domain, the live `ApiLoadBalancerDnsName`, and the Workload stack's
  parameters/conditions/mappings hashes.
- Admission is provably closed (`admission-status`), and no Beta deployment,
  lifecycle action, one-shot task or CloudFormation operation is in flight.
- One Beta writer is allocated. The protected `main`/workflow context, account
  `650880818323`, region `ap-east-1` and a reviewed Service release identity are
  verified before any credential.
- The Foundation change that scopes both Service deploy roles to
  `AnyWearRuntimeStack-beta` is not required for the MOVE itself but must be
  deployed before the Runtime stack is first created (issue step 8).
- **Step 8 must also deploy the Foundation-owned runtime-role read grants before
  M4.** `beta-infra-runtime-role` needs `cloudformation:DescribeStacks` and
  `cloudformation:GetTemplate` on `AnyWearRuntimeStack-beta` (permanent: reading
  an absent stack is a `ValidationError` that still needs authorization) and on
  `AnyWearWorkloadStack-beta` (transitional: only the pre-MOVE origin read). The
  live runtime-role policy comes from the Base stack's `DedicatedPolicy` and
  covers Foundation/Platform/Workload, not Runtime; the new Runtime grant inside
  the Base template is applied by the same M4 update that needs the pre-read.
  Verify the synthesized Foundation policy contains both stack ARNs before
  starting M4. The Workload ARN is removed only in a later reviewed Foundation
  deploy, after M3/M4 has deleted Workload and the Base literal-origin fallback
  is the only origin source; removing it earlier re-breaks a stopped-state
  `deploy-platform`.

## Stage A — Workload pre-move update

The live distribution's `Origin.DomainName` is a same-stack `Fn::GetAtt` of the
ALB, which is what makes the resource unmovable. Resolve it to the literal the
stack already uses (the live `ApiLoadBalancerDnsName`) and remove the
distribution's `DependsOn` residue on resources that stay behind. This is a
minimal `update-stack` template delta: an in-place `Origin.DomainName` update
(CloudFront documents "No interruption"), so the distribution ID and domain are
preserved and the stack keeps serving.

```sh
# 1. Validation only (default): builds the delta and prints the exact changes.
node scripts/migrate-beta-split.mjs --stage pre-move \
  --workload-template <live-workload-original.json> \
  --api-load-balancer-dns-name <live ApiLoadBalancerDnsName>

# 2. Separate explicit authorization; applies the delta in place.
node scripts/migrate-beta-split.mjs --stage pre-move --apply \
  --workload-template <live-workload-original.json> \
  --api-load-balancer-dns-name <live ApiLoadBalancerDnsName>
```

Accept only when the planned change list is exactly:

- `/Resources/<distributionLogicalId>/Properties/DistributionConfig/Origins/0/DomainName`
- `/Resources/<distributionLogicalId>/DependsOn` (removed; may be empty)

Read back the distribution ID, domain and `Deployed` status and the public
`/health` response. No other Workload property changes and no Service source
commit is needed for this stage.

## Stage B — Refactor preview (no resource mutation)

Eligibility, all required:

- `aws cloudformation describe-type --type RESOURCE --type-name AWS::CloudFront::Distribution`
  reports `provisioningType=FULLY_MUTABLE`.
- Neither stack has a stack policy.
- The moved resource references no `AWS::StackName` or other stack-varying
  pseudo parameter.
- Neither refactor template changes a parameter, condition or mapping relative
  to that stack's live template.

Synthesize Base at the same HEAD with the live origin:

```sh
npx cdk synth AnyWearPlatformStack-beta --quiet \
  -c deployScope=application -c stage=beta -c legacyRoleSource=external \
  -c identityPhase=retired -c ecrImageRetention=true \
  -c artifactDirectory=<verified Service release directory> \
  -c apiOriginDomainName=<live ApiLoadBalancerDnsName>
```

Then build the two templates and create the preview:

```sh
# Validation only: builds the source/target templates and the one mapping.
node scripts/migrate-beta-split.mjs --stage preview \
  --workload-template <live-workload-original.json> \
  --base-template <live-base-original.json> \
  --base-synth-template <synth>/AnyWearPlatformStack-beta.template.json \
  --distribution-type <describe-type.json> \
  --output <preview-plan.json>

# Separate authorization: create-stack-refactor validates and records a preview;
# execution is a separate call.
node scripts/migrate-beta-split.mjs --stage preview --apply \
  --workload-template <live-workload-original.json> \
  --base-template <live-base-original.json> \
  --base-synth-template <synth>/AnyWearPlatformStack-beta.template.json \
  --distribution-type <describe-type.json> \
  --output <refactor-preview.json>
```

The Workload source is the live template minus the distribution and its two
outputs (`ApiDistributionDomainName`, `ApiBaseUrl`). The Base target is the live
Base template plus exactly the moved distribution and those outputs, taken from
Base's synthesis with `-c apiOriginDomainName=<live ALB DNS>` — never Base's
full post-split synthesis, whose other changes belong to the next normal deploy.
The `--resource-mappings` entry maps the live source logical ID to the pinned
Base destination logical ID in `lib/api-distribution.json`.

Require `describe-stack-refactor` to report no unsupported resource and no
conflict, and `list-stack-refactor-actions` to show **exactly one MOVE** (the
distribution) with no configuration change and **no CREATE or DELETE**. Any other
action, any reported difference or any eligibility failure aborts before
execution: the Workload keeps serving, the environment is untouched, the
migration returns for redesign, and a one-time endpoint change remains an
explicit user decision rather than a silent fallback.

## Stage C — Execute and read back

Only on a clean preview, and only with its own authorization:

```sh
node scripts/migrate-beta-split.mjs --stage execute --apply \
  --describe <describe-stack-refactor.json> \
  --actions <list-stack-refactor-actions.json> \
  --resource-mappings <resource-mappings.json> \
  --output <refactor-execute.json>
```

The readback below is followed by the remaining issue steps as separate
authorizations: update Base (`M4`), create Egress (`M5`), create Runtime (`M6`),
rewire the Base origin to the new ALB and verify `/readyz` plus identity (`M7`).

For **M4** both the Workload ALB and the Runtime stack are absent, so the Base
update takes no live ALB output: its API distribution origin is the literal
`Origin.DomainName` the pre-move update already wrote into the moved distribution
(the value is preserved by the MOVE). `scripts/runtime-operation.mjs`
`readApiOrigin` resolves in this order — the running Runtime stack's
`ApiLoadBalancerDnsName` (hard error if the stack exists but the output is
missing or not a DNS name), the literal origin read back from the Base stack's
Original template, then the legacy Workload output only while Base has no adopted
distribution (pre-MOVE) — and validates each as a domain. Base is read before
Workload so the stopped state after M4 never needs the transitional Workload
read. M7 then rewires the same distribution to the new Runtime ALB DNS.

## Abort behavior

Every refusal happens before the mutating call for its stage. A failed preview
mutates nothing and the environment keeps serving. A failed pre-move update is a
no-op unless CloudFormation reports it started; then use the stack's normal
rollback/continue path and record it. A failed execute is an explicit recovery
decision, not an automatic retry. Never run `--no-rollback`, never repeat a stage
without a fresh readback, and never delete the Workload stack until the
distribution readback is clean.

## What this source delivery did not do

No stage of this runbook was executed. No `aws` call, no `update-stack`, no
`create-stack-refactor`, no `execute-stack-refactor`, no stack deletion, no
distribution change and no Beta lifecycle/admission action happened while
delivering the source change. The unit tests run the pure builders and validators
against recorded-shape fixtures only.
