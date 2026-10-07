#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { BillingStack } from '../lib/billing-stack';
import { FoundationStack } from '../lib/foundation-stack';
import { DEFAULT_QWEATHER_API_HOST, PlatformStack } from '../lib/platform-stack';
import { WorkloadStack } from '../lib/workload-stack';
import { loadArtifactInputs } from '../lib/artifact-inputs';
import { readIdentityPhase } from '../lib/identity-phase';

const app = new cdk.App();
const appScope = app.node.tryGetContext('appScope') || 'application';
if (!['application', 'foundation', 'billing'].includes(appScope)) throw new Error('Invalid appScope');
const identityPhase = readIdentityPhase(app.node.tryGetContext('identityPhase'));
const retentionProtectionContext = app.node.tryGetContext('retentionProtection');
if (retentionProtectionContext !== undefined && !['true', 'false', true, false].includes(retentionProtectionContext)) {
  throw new Error('retentionProtection must be true or false');
}
const retentionProtection = retentionProtectionContext === true || retentionProtectionContext === 'true';

// The FoundationStack creates account-wide resources like the GitHub OIDC Provider.
// It should be deployed ONCE per AWS account, before any environment stacks.
const env = process.env.CDK_DEFAULT_ACCOUNT && process.env.CDK_DEFAULT_REGION
  ? { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
  : undefined;
const billingEnv = process.env.CDK_DEFAULT_ACCOUNT
  ? { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.BILLING_REGION || 'us-east-1' }
  : { region: process.env.BILLING_REGION || 'us-east-1' };

if (appScope !== 'billing') new FoundationStack(app, 'AnyWearFoundationStack', { env, identityPhase });
if (appScope === 'billing') new BillingStack(app, 'AnyWearBillingStack-beta', { stage: 'beta', env: billingEnv });

if (appScope === 'application') {
const artifactDirectory = app.node.tryGetContext('artifactDirectory') || process.env.ANYWEAR_ARTIFACT_DIRECTORY;
if (typeof artifactDirectory !== 'string' || !artifactDirectory) throw new Error('artifactDirectory must identify locally verified immutable Service artifacts');
const artifactInputs = loadArtifactInputs(artifactDirectory);

const stage = app.node.tryGetContext('stage') || app.node.tryGetContext('env') || 'dev';
const betaActiveContext = app.node.tryGetContext('betaActive');
if (betaActiveContext !== undefined && !['true', 'false', true, false].includes(betaActiveContext)) {
  throw new Error('betaActive must be true or false');
}
if (stage !== 'beta' && (betaActiveContext === 'false' || betaActiveContext === false)) {
  throw new Error('Only beta supports a stopped state');
}
const betaActive = betaActiveContext !== 'false' && betaActiveContext !== false;
const qWeatherApiHost = app.node.tryGetContext('qweatherApiHost')
  || process.env.QWEATHER_API_HOST
  || DEFAULT_QWEATHER_API_HOST;
const platform = new PlatformStack(app, `AnyWearPlatformStack-${stage}`, {
  stage,
  artifactInputs,
  identityPhase,
  retentionProtection,
  betaActive,
  qWeatherApiHost,
  env,
});

if (stage === 'beta') {
  new BillingStack(app, 'AnyWearBillingStack-beta', { stage, env: billingEnv });
}

if (stage === 'beta' || stage === 'prod') {
  new WorkloadStack(app, `AnyWearWorkloadStack-${stage}`, {
    stage,
    platform,
    betaActive,
    env,
  });
}
}
