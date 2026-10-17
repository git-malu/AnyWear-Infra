import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cleanupMachineAuthSecretArn = 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:/anywear/beta/cleanup_machine_auth';
const cleanupMachineAuthPolicyArn = `${cleanupMachineAuthSecretArn}-??????`;

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, canonical(value[key])]));
  return value;
}

function differences(before, after, at = '') {
  if (JSON.stringify(canonical(before)) === JSON.stringify(canonical(after))) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object'
    && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      differences(before[key], after[key], `${at}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
  }
  return [{ path: at, before, after }];
}

const dedicatedRoleIds = new Map([['BetaInfraDeployRole', 'beta-infra-deploy-role'],
  ['BetaInfraRuntimeRole', 'beta-infra-runtime-role'], ['BetaServiceArtifactRole', 'beta-service-artifact-role'],
  ['BetaServiceDataRole', 'beta-service-data-role'], ['BetaClientPublishRole', 'beta-client-publish-role'],
  ['BetaE2EQualificationRole', 'beta-e2e-qualification-role']]);
const dedicatedPolicyIds = new Map([...dedicatedRoleIds].map(([id, name]) => [id.slice(4), name]));
function dedicatedResource(id, resource) {
  return (resource.Type === 'AWS::IAM::Role'
      && [...dedicatedRoleIds].some(([prefix, name]) => new RegExp(`^${prefix}[A-F0-9]{8}$`).test(id)
        && resource.Properties.RoleName === name))
    || (resource.Type === 'AWS::IAM::Policy'
      && ([...dedicatedRoleIds].some(([prefix]) => new RegExp(`^${prefix}DefaultPolicy[A-F0-9]{8}$`).test(id)
        && Array.isArray(resource.Properties.Roles) && resource.Properties.Roles.length === 1
        && typeof resource.Properties.Roles[0]?.Ref === 'string'
        && new RegExp(`^${prefix}[A-F0-9]{8}$`).test(resource.Properties.Roles[0].Ref))
        || [...dedicatedPolicyIds].some(([prefix, name]) => new RegExp(`^${prefix}DedicatedPolicy[A-F0-9]{8}$`).test(id)
          && JSON.stringify(resource.Properties.Roles) === JSON.stringify([name]))));
}

// These are the complete extraction exceptions. Role additions/retirement are
// independently inspected; all application resources/outputs remain exact.
export function compareTemplates(before, after, { phase = 'legacy', stage, stackName, ecrImageRetention = false } = {}) {
  assert.ok(['legacy', 'roles-added', 'retired'].includes(phase), 'Unknown identity phase');
  const allowed = [];
  const rejected = [];
  const baseline = structuredClone(before);
  const candidate = structuredClone(after);
  for (const [id, resource] of Object.entries(candidate.Resources ?? {})) {
    const cleanup = stackName === 'AnyWearPlatformStack-beta' && phase !== 'legacy' && !baseline.Resources?.[id]
      && ((/^CleanupTaskRole[A-F0-9]{8}$/.test(id) && resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === 'beta-anywear-tester-cleanup-task')
        || (/^CleanupTaskRoleDefaultPolicy[A-F0-9]{8}$/.test(id) && resource.Type === 'AWS::IAM::Policy'
          && resource.Properties.Roles?.length === 1 && /^CleanupTaskRole[A-F0-9]{8}$/.test(resource.Properties.Roles[0]?.Ref ?? '')));
    if (cleanup) { allowed.push({ path: `/Resources/${id}`, reason: 'Dedicated Beta cleanup task identity', after: resource }); delete candidate.Resources[id]; continue; }
    const dedicatedStack = stackName === 'AnyWearFoundationStack'
      || (stackName === 'AnyWearPlatformStack-beta' && resource.Type === 'AWS::IAM::Policy');
    if (!baseline.Resources?.[id] && phase !== 'legacy' && dedicatedStack && dedicatedResource(id, resource)) {
      allowed.push({ path: `/Resources/${id}`, reason: 'Dedicated Beta identity resource', after: resource });
      delete candidate.Resources[id];
    }
  }
  if (phase !== 'legacy' && stackName === 'AnyWearPlatformStack-beta' && !baseline.Outputs?.CleanupTaskRoleArn
    && /^CleanupTaskRole[A-F0-9]{8}$/.test(candidate.Outputs?.CleanupTaskRoleArn?.Value?.['Fn::GetAtt']?.[0] ?? '')
    && candidate.Outputs.CleanupTaskRoleArn.Value['Fn::GetAtt'][1] === 'Arn'
    && Object.keys(candidate.Outputs.CleanupTaskRoleArn).join(',') === 'Value') {
    allowed.push({ path: '/Outputs/CleanupTaskRoleArn', reason: 'Dedicated cleanup helper interface', after: candidate.Outputs.CleanupTaskRoleArn });
    delete candidate.Outputs.CleanupTaskRoleArn;
  }
  for (const difference of differences(baseline, candidate)) {
    const [, , id] = difference.path.split('/');
    const resource = before.Resources?.[id];
    const functionName = resource?.Properties?.FunctionName;
    const lambda = ['dev', 'beta', 'prod'].includes(stage)
      && [`${stage}-anywear-pre-sign-up`, `${stage}-anywear-post-confirmation-sync`].includes(functionName)
      && resource.Type === 'AWS::Lambda::Function';
    const codeLocation = lambda && difference.path === `/Resources/${id}/Properties/Code/S3Key`
      && typeof difference.before === 'string' && typeof difference.after === 'string'
      && /^[a-f0-9]{64}\.zip$/.test(difference.before) && /^[a-f0-9]{64}\.zip$/.test(difference.after);
    const assetMetadata = lambda && ['/Metadata/aws:asset:path', '/Metadata/aws:asset:is-bundled']
      .some((suffix) => difference.path === `/Resources/${id}${suffix}`);
    const retirement = phase === 'retired' && stackName === 'AnyWearPlatformStack-beta' && resource
      && ((['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)
        && JSON.stringify(resource.Properties.Roles) === JSON.stringify(['beta-github-actions-pipeline-role'])
        && difference.path === `/Resources/${id}` && difference.after === undefined));
    const expectedRetiredTrust = resource?.Type === 'AWS::IAM::Role'
      && resource.Properties.RoleName === 'beta-github-actions-pipeline-role'
      ? structuredClone(resource.Properties.AssumeRolePolicyDocument.Statement) : undefined;
    if (expectedRetiredTrust) expectedRetiredTrust[0].Condition.StringEquals['token.actions.githubusercontent.com:sub']
      = ['anywear:retired:beta-github-actions-pipeline-role'];
    const retiredFoundation = phase === 'retired' && stackName === 'AnyWearFoundationStack' && resource
      && ((resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === 'beta-github-actions-pipeline-role'
        && difference.path === `/Resources/${id}/Properties/AssumeRolePolicyDocument/Statement`
        && JSON.stringify(canonical(difference.after)) === JSON.stringify(canonical(expectedRetiredTrust)))
        || (resource.Type === 'AWS::IAM::Policy' && /^betaGitHubActionsRoleDefaultPolicy[A-F0-9]{8}$/.test(id)
          && difference.path === `/Resources/${id}` && difference.after === undefined));
    let protectedRetention = false;
    if (ecrImageRetention && resource?.Type === 'AWS::ECR::Repository'
      && resource.Properties.RepositoryName === `${stage}-anywear-service`
      && difference.path === `/Resources/${id}/Properties/LifecyclePolicy/LifecyclePolicyText`) {
      const original = JSON.parse(difference.before);
      const expected = { rules: [{ rulePriority: 1,
        selection: { tagStatus: 'tagged', tagPrefixList: ['protected-service-'],
          countType: 'imageCountMoreThan', countNumber: 1000 }, action: { type: 'expire' } },
      { rulePriority: 2, selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: stage === 'prod' ? 100 : 30 },
        action: { type: 'expire' } }] };
      protectedRetention = original.rules?.length === 1 && original.rules[0].rulePriority === 1
        && JSON.stringify(canonical(original.rules[0].selection)) === JSON.stringify(canonical(expected.rules[1].selection))
        && JSON.stringify(canonical(JSON.parse(difference.after))) === JSON.stringify(canonical(expected));
    }
    // CDK analytics is diagnostic metadata rather than a cloud resource update.
    const telemetry = resource?.Type === 'AWS::CDK::Metadata'
      && difference.path === `/Resources/${id}/Properties/Analytics`;
    // Issue #95 S1 is intentionally narrow: only the active Beta API service
    // desired count and its autoscaling minimum may change from 2 to 1. Keep
    // Worker scaling, Production/Dev and stopped-state templates covered by
    // the normal exact comparison. S2 sizes are checked separately below.
    const betaS1ReplicaReduction = stage === 'beta' && stackName === 'AnyWearWorkloadStack-beta'
      && ((resource?.Type === 'AWS::ECS::Service'
        && resource.Properties?.ServiceName === 'beta-anywear-api'
        && difference.path === `/Resources/${id}/Properties/DesiredCount`
        && difference.before === 2 && difference.after === 1)
      || (resource?.Type === 'AWS::ApplicationAutoScaling::ScalableTarget'
        && difference.path === `/Resources/${id}/Properties/MinCapacity`
        && difference.before === 2 && difference.after === 1
        && id.includes('ApiServiceTaskCountTarget')));
    // The retained profile defaults to S1 and atomically selects S2. Require
    // its complete declaration and exact paired expressions; other drift fails.
    const same = (value, expected) => JSON.stringify(canonical(value)) === JSON.stringify(canonical(expected));
    const profileParameter = { Type: 'String', Default: 's1', AllowedValues: ['s1', 's2-api'],
      Description: 'Retained Beta API sizing profile; s2-api is an unqualified Issue #95 candidate' };
    const profileCondition = { 'Fn::Equals': [{ Ref: 'BetaApiSizingProfile' }, 's2-api'] };
    const betaProfileScope = stage === 'beta' && stackName === 'AnyWearWorkloadStack-beta';
    const profileDeclaration = same(after.Parameters?.BetaApiSizingProfile, profileParameter)
      && same(after.Conditions?.BetaApiS2, profileCondition);
    const betaMachineAuthScope = stage === 'beta' && stackName === 'AnyWearWorkloadStack-beta';
    const policyRoleName = resource?.Properties?.Roles?.length === 1
      ? before.Resources?.[resource.Properties.Roles[0]?.Ref]?.Properties?.RoleName : undefined;
    const betaMachineAuthPolicy = betaMachineAuthScope
      && ['beta-anywear-api-task', 'beta-anywear-api-execution'].includes(policyRoleName)
      && difference.path === `/Resources/${id}/Properties/PolicyDocument/Statement`
      && Array.isArray(difference.before) && Array.isArray(difference.after)
      && difference.before.length === difference.after.length
      && !JSON.stringify(difference.before).includes(cleanupMachineAuthPolicyArn)
      && JSON.stringify(difference.after).split(cleanupMachineAuthPolicyArn).length - 1 === 1
      && (() => {
        const secretIndex = difference.before.findIndex((statement) => (
          statement?.Effect === 'Allow'
          && JSON.stringify(statement?.Action) === JSON.stringify(['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'])
          && !Array.isArray(statement.Resource)
        ));
        if (secretIndex < 0) return false;
        const afterStatement = difference.after[secretIndex];
        if (!Array.isArray(afterStatement?.Resource)
          || afterStatement.Resource.filter((value) => value === cleanupMachineAuthPolicyArn).length !== 1) return false;
        const stripped = structuredClone(afterStatement);
        stripped.Resource = stripped.Resource.filter((value) => value !== cleanupMachineAuthPolicyArn);
        if (stripped.Resource.length === 1) stripped.Resource = stripped.Resource[0];
        if (!same(stripped, difference.before[secretIndex])) return false;
        return same(
          difference.before.filter((_, index) => index !== secretIndex),
          difference.after.filter((_, index) => index !== secretIndex),
        );
      })();
    const apiTasks = Object.entries(after.Resources ?? {}).filter(([candidateId, candidate]) =>
      candidate?.Type === 'AWS::ECS::TaskDefinition' && (candidate.Properties?.Family === 'beta-anywear-api'
        || /^ComputeRuntimeApiTaskDefinition[A-F0-9]{8}$/.test(candidateId)));
    const profileSizePair = properties => same(properties?.Cpu, { 'Fn::If': ['BetaApiS2', '256', '512'] })
      && same(properties?.Memory, { 'Fn::If': ['BetaApiS2', '512', '1024'] });
    // A declaration-only change must not pass when active compute ignores it.
    const profileBinding = apiTasks.length === 0 ? after.Outputs?.BetaActive?.Value === 'false'
      && !Object.values(after.Resources ?? {}).some(candidate => candidate?.Type === 'AWS::ECS::Service'
        && candidate.Properties?.ServiceName === 'beta-anywear-api')
      : apiTasks.length === 1 && /^ComputeRuntimeApiTaskDefinition[A-F0-9]{8}$/.test(apiTasks[0][0])
        && apiTasks[0][1].Properties?.Family === 'beta-anywear-api' && profileSizePair(apiTasks[0][1].Properties);
    const betaSizingDeclaration = betaProfileScope && profileDeclaration && profileBinding && difference.before === undefined
      && ((difference.path === '/Parameters/BetaApiSizingProfile' && same(difference.after, profileParameter))
        || (difference.path === '/Conditions/BetaApiS2' && same(difference.after, profileCondition))
        || (difference.path === '/Conditions' && same(difference.after, { BetaApiS2: profileCondition })));
    const candidateResource = after.Resources?.[id];
    const telemetryParameter = { Type: 'String', Default: 'false', AllowedValues: ['false', 'true'],
      Description: 'Retained Beta API and Worker sizing telemetry; disabled by default' };
    const telemetryDeclaration = betaProfileScope && same(after.Parameters?.BetaSizingTelemetry, telemetryParameter);
    const betaTelemetryDeclaration = telemetryDeclaration && difference.before === undefined
      && difference.path === '/Parameters/BetaSizingTelemetry' && same(difference.after, telemetryParameter);
    const betaTelemetryEnvironment = telemetryDeclaration
      && /^ComputeRuntime(Api|Worker)TaskDefinition[A-F0-9]{8}$/.test(id)
      && resource?.Type === 'AWS::ECS::TaskDefinition' && candidateResource?.Type === resource.Type
      && ['beta-anywear-api', 'beta-anywear-worker'].includes(resource.Properties?.Family)
      && resource.Properties.Family === candidateResource.Properties?.Family
      && difference.path === `/Resources/${id}/Properties/ContainerDefinitions`
      && Array.isArray(difference.before) && difference.before.length === 1
      && Array.isArray(difference.after) && difference.after.length === 1
      && (() => {
        const containers = structuredClone(difference.after);
        const entries = containers[0].Environment;
        if (!Array.isArray(entries)) return false;
        const selected = entries.filter(entry => entry.Name === 'BETA_SIZING_TELEMETRY');
        if (selected.length !== 1 || !same(selected[0], { Name: 'BETA_SIZING_TELEMETRY', Value: { Ref: 'BetaSizingTelemetry' } })) return false;
        containers[0].Environment = entries.filter(entry => entry.Name !== 'BETA_SIZING_TELEMETRY');
        return same(containers, difference.before);
      })();
    const betaMachineAuthContainer = betaMachineAuthScope
      && /^ComputeRuntimeApiTaskDefinition[A-F0-9]{8}$/.test(id)
      && resource?.Type === 'AWS::ECS::TaskDefinition'
      && candidateResource?.Type === 'AWS::ECS::TaskDefinition'
      && resource.Properties?.Family === 'beta-anywear-api'
      && candidateResource.Properties?.Family === 'beta-anywear-api'
      && difference.path === `/Resources/${id}/Properties/ContainerDefinitions`
      && Array.isArray(difference.before) && difference.before.length === 1
      && Array.isArray(difference.after) && difference.after.length === 1
      && (() => {
        const containers = structuredClone(difference.after);
        const api = containers[0];
        const machineSecrets = api?.Secrets?.filter((secret) => (
          secret?.Name === 'CLEANUP_MACHINE_AUTH_SECRET'
          && secret?.ValueFrom === cleanupMachineAuthSecretArn
        )) ?? [];
        if (machineSecrets.length !== 1) return false;
        api.Secrets = api.Secrets.filter((secret) => !(
          secret?.Name === 'CLEANUP_MACHINE_AUTH_SECRET'
          && secret?.ValueFrom === cleanupMachineAuthSecretArn
        ));
        const telemetry = api.Environment?.filter((entry) => entry?.Name === 'BETA_SIZING_TELEMETRY') ?? [];
        if (telemetry.length > 0) {
          if (telemetry.length !== 1 || !telemetryDeclaration
            || !same(telemetry[0], { Name: 'BETA_SIZING_TELEMETRY', Value: { Ref: 'BetaSizingTelemetry' } })) return false;
          api.Environment = api.Environment.filter((entry) => entry?.Name !== 'BETA_SIZING_TELEMETRY');
        }
        return same(containers, difference.before);
      })();
    const betaS2ApiSize = betaProfileScope && profileDeclaration
      && /^ComputeRuntimeApiTaskDefinition[A-F0-9]{8}$/.test(id)
      && resource?.Type === 'AWS::ECS::TaskDefinition'
      && candidateResource?.Type === 'AWS::ECS::TaskDefinition'
      && resource.Properties?.Family === 'beta-anywear-api'
      && candidateResource.Properties?.Family === 'beta-anywear-api'
      && resource.Properties.Cpu === '512' && resource.Properties.Memory === '1024'
      && profileSizePair(candidateResource.Properties)
      && ['Cpu', 'Memory'].some((property) => difference.path === `/Resources/${id}/Properties/${property}`);
    // Issue #86 adds a deployment-owned cleanup operation. Its fixed task
    // definitions, state machine, version and E2E policy are intentionally
    // new resources; the cross-stack PublishOutput values are the reviewed
    // bindings needed to wire those tasks to existing Beta resources.
    const cleanupOperationResource = stage === 'beta' && phase !== 'legacy'
      && difference.path.startsWith('/Resources/CleanupOperation');
    const cleanupOperationOutput = stage === 'beta' && phase !== 'legacy'
      && (difference.path.startsWith('/Outputs/CleanupOperation')
        || difference.path.startsWith('/Outputs/PublishOutput'));
    const cleanupExecutionPolicy = stage === 'beta' && phase !== 'legacy'
      && difference.path.includes('/Resources/OneShotExecutionRoleDefaultPolicy')
      && difference.path.endsWith('/Properties/PolicyDocument/Statement');
    if (codeLocation || assetMetadata || retirement || retiredFoundation || telemetry || protectedRetention
      || betaS1ReplicaReduction || betaS2ApiSize || betaSizingDeclaration
      || betaTelemetryDeclaration || betaTelemetryEnvironment
      || betaMachineAuthPolicy || betaMachineAuthContainer
      || cleanupOperationResource || cleanupOperationOutput || cleanupExecutionPolicy) {
      allowed.push({ ...difference, reason: codeLocation || assetMetadata ? 'Verified prebuilt Lambda asset location'
        : retirement || retiredFoundation ? 'Reviewed old Beta identity retirement'
        : protectedRetention ? 'Explicit protected rollback retention activation'
          : betaS1ReplicaReduction ? 'Issue #95 S1 Beta API replica reduction'
            : betaS2ApiSize || betaSizingDeclaration ? 'Issue #95 retained Beta API size profile (S2 runtime unqualified)'
              : betaTelemetryDeclaration || betaTelemetryEnvironment ? 'Issue #95 retained Beta sizing telemetry (disabled by default)'
              : betaMachineAuthPolicy || betaMachineAuthContainer ? 'Issue #86 Beta API cleanup machine-auth secret binding'
              : cleanupOperationResource || cleanupOperationOutput || cleanupExecutionPolicy
              ? 'Issue #86 fixed Beta cleanup operation binding' : 'CDK diagnostic analytics' });
    } else rejected.push(difference);
  }
  return { phase, stage, stackName, accepted: rejected.length === 0, allowed, rejected };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [beforeFile, afterFile, phase = 'legacy', stage, outputFile] = process.argv.slice(2);
  assert.ok(beforeFile && afterFile, 'Usage: compare-templates.mjs BEFORE AFTER [PHASE STAGE OUTPUT]');
  const report = compareTemplates(JSON.parse(readFileSync(beforeFile, 'utf8')),
    JSON.parse(readFileSync(afterFile, 'utf8')), { phase, stage, stackName: path.basename(afterFile, '.template.json') });
  if (outputFile) writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.accepted) process.exitCode = 1;
}
