#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { BillingStack } from '../lib/billing-stack';
import { FoundationStack, readFoundationServices, SERVICE_SET_CONTEXT } from '../lib/foundation-stack';
import { DEFAULT_QWEATHER_API_HOST, PlatformStack } from '../lib/platform-stack';
import { EgressStack } from '../lib/egress-stack';
import { loadArtifactInputs } from '../lib/artifact-inputs';
import { readIdentityPhase } from '../lib/identity-phase';
import { readLegacyRoleSource } from '../lib/legacy-role-source';

const app = new cdk.App();
// A stale old key must fail for every scope instead of taking today's default:
// appScope, betaActive, environmentRunning and retentionProtection would
// otherwise synthesize a silently different shape. Issue #166 removed the
// environmentRunning active/stopped switch entirely: Beta now stops by deleting
// the Egress and Runtime stacks, so accepting the key would hide a stale caller.
if (app.node.tryGetContext('appScope') !== undefined) throw new Error('appScope was renamed to deployScope');
if (app.node.tryGetContext('betaActive') !== undefined) throw new Error('betaActive was removed: Beta activity is the existence of the Runtime stack, not an output');
if (app.node.tryGetContext('environmentRunning') !== undefined) throw new Error('environmentRunning was removed: Beta stops by deleting the Egress and Runtime stacks');
if (app.node.tryGetContext('retentionProtection') !== undefined) throw new Error('retentionProtection was renamed to ecrImageRetention');
const deployScope = app.node.tryGetContext('deployScope') || 'application';
if (!['application', 'foundation', 'billing', 'egress'].includes(deployScope)) throw new Error('Invalid deployScope');
const identityPhase = readIdentityPhase(app.node.tryGetContext('identityPhase'));
// Required even for Billing-only entry; source/simulation mode is never an
// implicit live fallback. Foundation validates the bound external account.
const legacyRoleSource = readLegacyRoleSource(app.node.tryGetContext('legacyRoleSource'));
if (legacyRoleSource === 'external' && process.env.CDK_DEFAULT_ACCOUNT !== '650880818323') {
  throw new Error('External legacy roles require the reviewed account 650880818323');
}
const ecrImageRetentionContext = app.node.tryGetContext('ecrImageRetention');
if (ecrImageRetentionContext !== undefined && !['true', 'false', true, false].includes(ecrImageRetentionContext)) {
  throw new Error('ecrImageRetention must be true or false');
}
const ecrImageRetention = ecrImageRetentionContext === true || ecrImageRetentionContext === 'true';

// Reviewed CDK context: the Foundation service set. It defaults to exactly
// today's single AnyWear-Service service; an additional service is a context
// value (`-c infraServices='[...]'`) plus a deploy, never an Infra source edit.
const services = readFoundationServices(app.node.tryGetContext(SERVICE_SET_CONTEXT));

// The FoundationStack creates account-wide resources like the GitHub OIDC Provider.
// It should be deployed ONCE per AWS account, before any environment stacks.
const env = process.env.CDK_DEFAULT_ACCOUNT && process.env.CDK_DEFAULT_REGION
  ? { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
  : undefined;
const billingEnv = process.env.CDK_DEFAULT_ACCOUNT
  ? { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.BILLING_REGION || 'us-east-1' }
  : { region: process.env.BILLING_REGION || 'us-east-1' };

if (deployScope !== 'billing') new FoundationStack(app, 'AnyWearFoundationStack', { env, identityPhase, legacyRoleSource, services });
if (deployScope === 'billing') new BillingStack(app, 'AnyWearBillingStack-beta', { stage: 'beta', env: billingEnv });

if (deployScope === 'application') {
const artifactDirectory = app.node.tryGetContext('artifactDirectory') || process.env.ANYWEAR_ARTIFACT_DIRECTORY;
if (typeof artifactDirectory !== 'string' || !artifactDirectory) throw new Error('artifactDirectory must identify locally verified immutable Service artifacts');
const artifactInputs = loadArtifactInputs(artifactDirectory);

const stage = app.node.tryGetContext('stage') || app.node.tryGetContext('env') || 'dev';
const qWeatherApiHost = app.node.tryGetContext('qweatherApiHost')
  || process.env.QWEATHER_API_HOST
  || DEFAULT_QWEATHER_API_HOST;
// The Base API CloudFront distribution owns a literal origin (the CloudFront
// stack-refactor MOVE requires it), so a Beta synthesis must state the live ALB
// DNS name. The deployment reads `ApiLoadBalancerDnsName` from the Service-owned
// Runtime stack (or the recorded live value during the one-time split migration)
// and passes it as this context value. Other stages have no such distribution.
const apiOriginDomainNameContext = app.node.tryGetContext('apiOriginDomainName');
if (apiOriginDomainNameContext !== undefined && typeof apiOriginDomainNameContext !== 'string') {
  throw new Error('apiOriginDomainName must be a DNS name');
}
if (stage === 'beta' && !apiOriginDomainNameContext) {
  throw new Error('The Beta Base stack requires -c apiOriginDomainName=<live API load-balancer DNS name>');
}
// Infra owns the account-wide Foundation/Billing stacks and the stage base only.
// The release slice (`AnyWearRuntimeStack-beta` / `-prod`) was moved to
// AnyWear-Service in #158 step B and is deployed from Service's own release
// chain; this app must not synthesize or deploy it. Issue #166 split the stage
// base's disposable egress into `AnyWearEgressStack-beta` and moved the API
// CloudFront distribution into Base.
new PlatformStack(app, `AnyWearPlatformStack-${stage}`, {
  stage,
  artifactInputs,
  identityPhase,
  ecrImageRetention,
  qWeatherApiHost,
  apiOriginDomainName: apiOriginDomainNameContext,
  env,
});

if (stage === 'beta') {
  new BillingStack(app, 'AnyWearBillingStack-beta', { stage, env: billingEnv });
}
}

// `egress` is the disposable network edge. It is a separate scope so
// `deploy-egress` / `delete-egress` synthesize only this stack and need no
// Service artifact directory; `cdk deploy/destroy --exclusively` then touches
// exactly this stack. Base publishes the VPC/subnet/route-table ids as
// CloudFormation exports (lib/base-exports.ts) and Egress imports them, so the
// two stacks share the Base-owned network without Egress re-creating route
// tables or a second association. Synthesis performs no AWS call.
if (deployScope === 'egress') {
  new EgressStack(app, 'AnyWearEgressStack-beta', { env });
}
