# AnyWear Infra agent instructions

This repository owns shared AWS infrastructure and environment operations after
the verified #54 cutover. It owns the account-wide Foundation and Billing stacks
and the Beta stage's persistent `Base` stack (`AnyWearPlatformStack-beta`), plus
the disposable `Egress` stack (`AnyWearEgressStack-beta`). AnyWear-Service owns
the release slice (`AnyWearRuntimeStack-beta`, formerly `AnyWearWorkloadStack-beta`),
its CDK source and its deploy chain; Infra no longer synthesizes, deploys or
recovers that stack. AnyWear-Service
remains the application, migration, verification and immutable artifact
publisher. Earlier Service-side bootstrap authority is historical evidence only
and must not be relabeled as an Infra-produced deployment.

- Read the accepted ownership ADR and deployment contracts before modifying
  infrastructure. Keep proposed targets separate from observed implementation.
- Preserve existing stack names, construct/logical IDs, physical resources,
  endpoints, outputs and runtime-owned configuration through extraction.
- Service owns application/Lambda/migration/verification source and immutable
  artifacts. Do not generate the shared API or read mutable peer `main` as a
  deployment input. Client publishes independently through deployed interfaces.
- There is no committed selection and no cross-repository native-asset
  verification path. `deploy-platform` and `restore-release` take one reviewed
  Service release identity (`service_release_tag` + `service_commit`), download
  that sealed release's Lambda bundles, runtime policy and manifest with a
  read-only token, and prove each downloaded byte against the manifest before any
  credential. No Service-built artifact is committed here. Every other operation
  rejects a release identity.
- Deployment records are v3 (`anywear_infra_deployment`): producer identity, the
  exact stack set that producer owns, the stage-contract SSM parameters the run
  read (name, version, value hash), the authenticated observation and a content
  hash of the stage-contract schema surface. There is no `selection` member and
  no pin to another repository's release. Service produces
  `anywear_service_deployment` v4 from the same core plus a required 600-second
  six-signal bake `gate`; an Infra record never carries one.
- The versioned `@git-malu/stage-contracts` package
  (`packages/stage-contracts/`) is the single source of the stage-contract
  names/kinds, stack identities, v4 Service record and bake-gate validators and
  Foundation service-role naming. `npm run check` runs its tests. Change it only
  with a version bump and the matching `stage-contracts-v<version>` tag; Service
  pins the packed tarball, never a mutable branch.
- Do not claim repository branch protection when the private plan cannot enforce
  it. The configured Beta environment restricts the branch to main. Apply the
  independently reviewed exact source/inputs and operational coordination
  with one writer; these are distinct from repository branch protection.
- Use `gh` for GitHub and `aws` for AWS. Verify account, profile and region before
  cloud commands. Run package/build commands only within this repository.
- Before AWS mutations, verify protected main/workflow, explicit operation,
  account/region, the reviewed Service release identity when the operation takes
  one, identity phase, retention protection and rollback inputs. Use one Infra
  runtime queue. Enumerate conflicting Actions, local processes, CloudFormation
  operations and ECS/helper tasks; timeout does not establish cessation. Repository
  concurrency is not a cross-repository lock; migration rollout stays separately
  coordinated.
- Issue #166: Beta is three stacks with disjoint lifetimes. `Base`
  (`AnyWearPlatformStack-beta`, physical name retained) holds the VPC and its
  subnets plus each subnet's route table and association, Aurora, S3, Cognito,
  ECR, SQS, SSM params and both CloudFront distributions and is persistent;
  `Egress` (`AnyWearEgressStack-beta`) holds the NAT, EIP, the 0.0.0.0/0 default
  routes in the Base-owned private route tables and the S3 gateway endpoint and
  is deleted on stop (it creates no route table and no subnet association);
  `Runtime` (`AnyWearRuntimeStack-beta`, Service-owned) holds ALB, ECS
  services/task definitions, log groups and the cleanup operation and is deleted
  on stop. There is no `environmentRunning` switch, no `BetaActive` output and no
  stopped template. Beta run state is one fact: whether the Runtime stack exists.
  Stop deletes Runtime then Egress; start recreates Egress then Runtime, and
  `restore-release` requires Runtime to exist ("start first"). A Base mutation
  still reads Runtime terminal first (one writer); a missing Runtime is the
  stopped state, not an inactive variant to maintain.
- The Base stack publishes `api_base_url` and retains Aurora, both S3 buckets,
  the Cognito pool, the ECR repository and both CloudFront distributions
  (`DeletionPolicy`/`UpdateReplacePolicy: Retain`). The API CloudFront
  distribution moved from the Service stack into Base with a one-time reviewed
  CloudFormation stack-refactor MOVE; its logical ID is pinned in
  `lib/api-distribution.json` and its origin is the live literal ALB DNS name
  (`-c apiOriginDomainName=...`), never a same-stack `Fn::GetAtt`. The one-time
  migration (`scripts/migrate-beta-split.mjs` + its runbook) is never automatic,
  defaults to validation-only, and is a Deployment-stage action.
- Issue #166 keeps the three bounded Beta entries in the
  [operations catalog](README.md#operations): `check.yml` is automatic;
  `runtime.yml` is the manual `state`/`observe` entry,
  where `state` is read-only with restricted STS credentials and works with
  `ENABLE_BETA_MUTATION` closed, and `observe` is the manual qualified observation
  that produces the accepted `anywear_infra_deployment` v3 record for E2E
  compatibility; `mutate.yml` is the single manual mutation entry
  and rejects cross-family or out-of-scope inputs before credentials. Since #181 a
  deployment that changes a configured stack runs `preflight` → `verify` → `deploy`
  → `observe` → `record` in one run: the read-only `observe` job holds only the
  runtime role and writes the accepted v3 record with producer
  `.github/workflows/mutate.yml` and that run's id/attempt/source, while the
  mutation job keeps the write session and produces only its
  `anywear_infra_family_observation`. A missing accepted record after a completed
  mutation marks the operation record `partial`/`requires-explicit-recovery` and
  fails the run, so a deployment cannot enter Acceptance without it.
  `deploy-egress`/`delete-egress` change only the operation-owned
  `AnyWearEgressStack-beta` and are outside that trigger set, as are `migrate`, the
  admission operations and `state`; the trigger set is derived from the frozen
  stack tables, not restated. It now
  includes `deploy-egress` / `delete-egress`: both are `beta-deploy` family,
  change only `AnyWearEgressStack-beta`, and `delete-egress` refuses unless the
  Runtime stack is absent. `production.yml`
  is `workflow_call`-only and is not an entry. The five admission operations are
  `admission-status`, `add-testers`, `set-testers`, `open-admission` and
  `close-admission`; admission is one mode record with no window or expiry,
  `open-admission` takes no payload, and `close-admission` is the only thing that
  closes. Record family and record type derive
  from the operation, never from the hosting file. Preserve session restrictions for
  final qualification, actual workflow record identity and the v3 E2E producer
  boundary. Existing OIDC trust is repository/environment scoped, not workflow
  scoped; source/session checks do not narrow inherited task-role or downstream
  CDK authority.
  Initial `deployScope=foundation`
  bootstrap is a separately assigned operator allocation and needs no Service
  artifact. Never use `cdk bootstrap`, broader trust, shared-role fallback or new
  permissions to make a blocked bootstrap/consumer operation succeed.
- After #158 step C the only path that deploys the Service-owned release slice is
  AnyWear-Service's release chain, and that capability is installed. Issue #166
  renamed that slice to `AnyWearRuntimeStack-beta`; the historical runs below
  still refer to it by its then-name `AnyWearWorkloadStack-beta`. The deferred
  Foundation round has happened, so its two Service deploy roles from step A exist
  and Service's own `ENABLE_BETA_MUTATION=true` can act: Service run 39137577023
  ("Service release: deploy", `workflow_dispatch`, success, created
  2026-10-18T14:47:35Z) deployed the Service-owned release slice, and
  Infra `deploy-foundation` runs succeeded on 2026-10-18 at 12:48:21Z, 12:22:55Z,
  11:02:38Z and 07:33:47Z. No Infra entry may deploy, verify or recover that slice.
- Every CLI scope requires explicit `legacyRoleSource=cdk|external`.
  `cdk` reproduces the Service source fixture; never use it as the live
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
- The Beta stage base is published as SSM parameters under `/anywear/beta/` so the
  release slice can be deployed from a checkout that holds no Infra source. Two
  of those values are reviewed constants, not Platform resources: the VLM config
  secret ARN and the AWS-managed CloudFront origin-facing prefix list id. Change
  the constants only in a reviewed diff; the slice's own stack parameters are
  Service's to assert. Service
  deploys through `beta-service-deploy-role` (CloudFormation change sets for
  `AnyWearRuntimeStack-beta` only; `ssm:GetParameter*` under `/anywear/beta/`;
  the CDK CLI's own-credentials path: the `cdk-bootstrap/hnb659fds/version`
  parameter, list/object/bucket-location access to the dedicated
  `cdk-hnb659fds-assets-<account>-<region>` bucket)
  and `beta-service-deploy-cfn-role` (CloudFormation trust only, the Runtime
  stack's resource families and its four task roles). Neither assumes a
  `cdk-hnb659fds-*` role, carries a managed policy or holds account-wide grants;
  the policy-inventory tests keep the absent
  VPC/Aurora/Cognito/bucket-configuration/SQS/ECR-configuration/Foundation/
  other-stack grants absent. The roles, not this
  repository, are now the Runtime stack's deployment authority.
- Foundation's service set is reviewed CDK context, not source: `infraServices` is
  an array of `{ service, repository, repositoryId, environment }` descriptors
  defaulting to exactly the single `service` (`AnyWear-Service`, repository id
  `1158460323`, environment `beta`). Both role names and the immutable OIDC
  subject derive from the descriptor. The context is strict: an unknown key, a
  malformed descriptor, a duplicate service, a missing default service or a
  changed default descriptor fails synthesis before any resource is created. A
  second service is that context value plus a Foundation deploy carrying it, never
  an Infra source edit; the default context keeps the synthesized Foundation
  template equal to the authenticated live Foundation plus the recorded
  `test/fixtures/foundation-dedicated-additions.json` delta, whose #162 extension
  and #166 Runtime-scope extension (including the Foundation-owned
  `beta-infra-runtime-role` CloudFormation read grants for the M4 origin pre-read)
  are recorded in the fixture provenance (`test/foundation-services.test.ts`).
  The #166 extension is source-side only:
  `publication_verified` and `deployment_qualified` remain false until the
  Deployment gate deploys Foundation.
- The accepted #54 IAM boundary is scoped: the named legacy Beta role has
  deny-only trust with zero inline or attached grants, and Infra owns the one
  operational Beta queue. The inherited Dev wildcard E2E subject, `cdk-*`
  assume-role chain and CloudFormation execution role with `AdministratorAccess`
  and no permissions boundary remain unchanged and outside this scope. Do not
  claim account-wide IAM exclusivity or Beta resource isolation.
- `identityPhase=legacy` and `ecrImageRetention=false` preserve the source
  baseline by default. Role additions, retention activation and old-role
  retirement require separate reviewed diffs/operations. Initial cutover keeps the
  live image, Client, Lambda bytes, runtime policy, endpoints and schema behavior.
- Production activation/onboarding remains outside #54. Keep its deployment and
  readiness gates disabled; its source blocker must fail before AWS credentials
  even if an activation variable changes. A separately reviewed onboarding PR
  must establish the target account, runtime and verifier contract before removing
  that blocker. Do not add Production roles or broaden bootstrap in #54.
- Preserve other contributors' work. Keep one deployment writer per environment
  and verify that prior mutations have ceased before handoff.
- Review diffs, run `git diff --check`, and complete repository checks before
  publishing. PR merge alone does not establish deployed acceptance.
- Never commit credentials, runtime secrets or unredacted cloud diagnostics.

## Required source checks

Use Node.js 24 and npm within this repository for package commands.

```sh
npm ci
npm run audit:prod
npm run check
node scripts/create-test-inputs.mjs
node scripts/synth-matrix.mjs --artifact-directory .service-artifacts/test --baseline-templates test/baselines --output cdk.matrix
node scripts/synth-matrix.mjs --artifact-directory .service-artifacts/test --baseline-templates test/baselines --retention-protection true --output cdk.protected.matrix
git diff --check
```

Also synthesize the live Foundation with `deployScope=foundation`,
`identityPhase=roles-added`, `legacyRoleSource=external`, account `650880818323`
and application region `ap-east-1`, then run `scripts/compare-live-foundation.mjs`
against that output. CI preserves the actual CLI template and comparison. The
authenticated Original fixture permits exactly eight dedicated roles/five policies
(the fifth is the #166 runtime-role read grant);
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
[cutover/recovery runbook](docs/runbooks/cutover-and-recovery.md). The accepted
#54 qualification is [E2E run 37949887097](https://github.com/git-malu/AnyWear-E2E/actions/runs/37949887097),
attempt `1`, against reviewed E2E main `b60f2e26adec9ed7c03ee9e671099213321fbb99`;
its correlated Service cleanup is [run 37950914153](https://github.com/git-malu/AnyWear-Service/actions/runs/37950914153),
and final admission closure is [Infra run 37951949885](https://github.com/git-malu/AnyWear-Infra/actions/runs/37951949885).
This evidence verifies correctness for the recorded tuple, not a latency SLA.
Preserve source maps, original component/build provenance, operation/recovery
records and exact run/attempt/artifact hashes before workspace cleanup.
