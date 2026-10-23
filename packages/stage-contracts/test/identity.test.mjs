import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  DEPLOYED_TEMPLATE_NORMALISATION,
  INFRA_REPOSITORY,
  SERVICE_REPOSITORY,
  SERVICE_RUNTIME_STACK,
  canonicalDeployedTemplateHash,
  normaliseDeployedTemplate,
  platformStackName,
  runtimeStackName,
  runtimeStageFromStack,
  stableTaskDefinition,
  taskDefinitionContentHash,
} from '../index.mjs';

test('stack identities are derived from the stage, not duplicated per caller', () => {
  assert.equal(INFRA_REPOSITORY, 'git-malu/AnyWear-Infra');
  assert.equal(SERVICE_REPOSITORY, 'git-malu/AnyWear-Service');
  assert.equal(platformStackName('dev'), 'AnyWearPlatformStack-dev');
  assert.equal(platformStackName('beta'), 'AnyWearPlatformStack-beta');
  assert.equal(platformStackName('prod'), 'AnyWearPlatformStack-prod');
  assert.equal(runtimeStackName('beta'), 'AnyWearRuntimeStack-beta');
  assert.equal(runtimeStackName('prod'), 'AnyWearRuntimeStack-prod');
  assert.equal(runtimeStageFromStack('AnyWearRuntimeStack-beta'), 'beta');
  assert.throws(() => runtimeStageFromStack('AnyWearPlatformStack-beta'), /Invalid Runtime stack identity/);
  // #195: the producer of the Runtime stack is Infra's single mutation entry.
  assert.deepEqual(SERVICE_RUNTIME_STACK, {
    name: 'AnyWearRuntimeStack-beta',
    region: 'ap-east-1',
    workflow_path: '.github/workflows/mutate.yml',
  });
  assert.ok(Object.isFrozen(SERVICE_RUNTIME_STACK));
});

test('the Service-role naming surface retired with the Foundation roles', async () => {
  const packageModule = await import('../index.mjs');
  assert.equal(packageModule.serviceDeployRoleName, undefined);
  assert.equal(packageModule.serviceDeployCfnRoleName, undefined);
  assert.equal(packageModule.serviceTrustSubject, undefined);
});

test('the declared normalisation removes only CDK diagnostics and hashes canonical JSON', () => {
  const deployed = {
    AWSTemplateFormatVersion: '2010-09-09',
    Parameters: { ServiceImageDigest: { Type: 'String' } },
    Conditions: {
      BetaApiS2: { 'Fn::Equals': [{ Ref: 'BetaApiSizingProfile' }, 's2-api'] },
      CDKMetadataAvailable: { 'Fn::Or': [{ 'Fn::Equals': [{ Ref: 'AWS::Region' }, 'ap-east-1'] }, true] },
    },
    Resources: {
      ComputeRuntimeApiServiceD2475D0A: { Type: 'AWS::ECS::Service', Metadata: { 'aws:cdk:path': 'ComputeRuntime/ApiService/Resource' } },
      CDKMetadata: { Type: 'AWS::CDK::Metadata', Condition: 'CDKMetadataAvailable',
        Properties: { Analytics: 'v2:deflate64:H4sIAAAAAAAA/...' } },
    },
    Outputs: { ApiServiceName: { Value: { Ref: 'ComputeRuntimeApiServiceD2475D0A' } } },
  };
  const normalised = normaliseDeployedTemplate(deployed);
  assert.deepEqual(Object.keys(normalised.Resources), ['ComputeRuntimeApiServiceD2475D0A']);
  assert.equal(normalised.Resources.ComputeRuntimeApiServiceD2475D0A.Metadata, undefined);
  assert.equal(normalised.Conditions.CDKMetadataAvailable, undefined);
  assert.deepEqual(Object.keys(normalised.Conditions), ['BetaApiS2']);
  assert.equal(normalised.Outputs.ApiServiceName.Value.Ref, 'ComputeRuntimeApiServiceD2475D0A');
  // The input is not mutated.
  assert.ok(deployed.Resources.CDKMetadata);
  assert.equal(normaliseDeployedTemplate(deployed).Resources.CDKMetadata, undefined);
  // A template with no CDK diagnostics normalises to itself, and an empty
  // Conditions member disappears rather than rendering as `{}`.
  const plain = { Resources: { A: { Type: 'AWS::S3::Bucket' } }, Conditions: { CDKMetadataAvailable: { 'Fn::Equals': [1, 1] } } };
  assert.deepEqual(normaliseDeployedTemplate(plain), { Resources: { A: { Type: 'AWS::S3::Bucket' } } });
  // The canonical hash is stable across CDK diagnostics and sensitive to a
  // single cloud-resource change.
  assert.equal(canonicalDeployedTemplateHash(deployed), canonicalDeployedTemplateHash(normaliseDeployedTemplate(deployed)));
  const changed = structuredClone(deployed);
  changed.Resources.ComputeRuntimeApiServiceD2475D0A.Type = 'AWS::ECS::TaskDefinition';
  assert.notEqual(canonicalDeployedTemplateHash(changed), canonicalDeployedTemplateHash(deployed));
  // An undeclared metadata key fails closed instead of being silently dropped.
  const unexpected = structuredClone(deployed);
  unexpected.Resources.ComputeRuntimeApiServiceD2475D0A.Metadata['aws:unreviewed'] = true;
  assert.throws(() => normaliseDeployedTemplate(unexpected), /Unreviewed deployed template metadata/);
  assert.throws(() => normaliseDeployedTemplate(null), /Invalid deployed template/);
  assert.throws(() => normaliseDeployedTemplate({ Resources: { CDKMetadata: { Type: 'AWS::S3::Bucket' } } }),
    /Invalid CDKMetadata resource identity/);
  assert.deepEqual([...DEPLOYED_TEMPLATE_NORMALISATION].length, 4);
});

// The task-definition identity survived #207: the record that consumed it is
// gone, but the deployed-service identity it proves (the normalized content hash)
// is still how a Runtime deploy and its reader compare a task definition.
const apiDefinition = {
  family: 'beta-anywear-api',
  taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-api-task',
  executionRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-api-execution',
  networkMode: 'awsvpc',
  cpu: '512',
  memory: '1024',
  containerDefinitions: [{
    name: 'ApiContainer',
    image: '650880818323.dkr.ecr.ap-east-1.amazonaws.com/beta-anywear-service@sha256:' + '9'.repeat(64),
    command: ['node', 'dist/index.js'],
    environment: [{ name: 'B', value: '2' }, { name: 'A', value: '1' }],
  }],
};
const workerDefinition = { ...apiDefinition, family: 'beta-anywear-worker',
  taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-worker-task' };
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('stableTaskDefinition is the normalized content identity, not the revision', () => {
  const expected = {
    family: 'beta-anywear-api',
    taskRoleArn: apiDefinition.taskRoleArn,
    executionRoleArn: apiDefinition.executionRoleArn,
    networkMode: 'awsvpc',
    cpu: '512',
    memory: '1024',
    container: {
      name: 'ApiContainer',
      image: apiDefinition.containerDefinitions[0].image,
      command: ['node', 'dist/index.js'],
      environment: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }],
    },
  };
  assert.deepEqual(stableTaskDefinition(apiDefinition), expected);
  assert.equal(taskDefinitionContentHash(apiDefinition), sha256(canonical(expected)));
  const reordered = structuredClone(apiDefinition);
  reordered.containerDefinitions[0].environment = [{ name: 'B', value: '2' }, { name: 'A', value: '1' }];
  assert.equal(taskDefinitionContentHash(reordered), taskDefinitionContentHash(apiDefinition));
  assert.notEqual(taskDefinitionContentHash(workerDefinition), taskDefinitionContentHash(apiDefinition));
  const noCommand = structuredClone(apiDefinition);
  delete noCommand.containerDefinitions[0].command;
  assert.deepEqual(stableTaskDefinition(noCommand).container.command, []);
  assert.throws(() => stableTaskDefinition({ family: 'x', containerDefinitions: [] }),
    /Single-container task definition required/);
  assert.throws(() => stableTaskDefinition(null), /Task definition observation unavailable/);
});
