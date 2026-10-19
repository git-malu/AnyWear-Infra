import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INFRA_REPOSITORY,
  SERVICE_REPOSITORY,
  SERVICE_RUNTIME_STACK,
  platformStackName,
  runtimeStackName,
  runtimeStageFromStack,
  validateServiceStacks,
  serviceDeployRoleName,
  serviceDeployCfnRoleName,
  serviceTrustSubject,
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
  assert.deepEqual(SERVICE_RUNTIME_STACK, {
    name: 'AnyWearRuntimeStack-beta',
    region: 'ap-east-1',
    workflow_path: '.github/workflows/service-artifacts.yml',
  });
  assert.ok(Object.isFrozen(SERVICE_RUNTIME_STACK));
  const row = { name: SERVICE_RUNTIME_STACK.name, region: SERVICE_RUNTIME_STACK.region,
    producer_repository: SERVICE_REPOSITORY, producer_sha: 'a'.repeat(40), template_sha256: 'b'.repeat(64) };
  assert.deepEqual(validateServiceStacks([row]), [row]);
  assert.throws(() => validateServiceStacks([{ ...row, name: 'AnyWearPlatformStack-beta' }]),
    /Invalid stack identity in deployment record/);
  assert.throws(() => validateServiceStacks([row, { ...row }]), /exactly its producer's stacks/);
});

test('Foundation service deploy roles are named per service and stage', () => {
  assert.equal(serviceDeployRoleName('service'), 'beta-service-deploy-role');
  assert.equal(serviceDeployCfnRoleName('service'), 'beta-service-deploy-cfn-role');
  assert.equal(serviceDeployRoleName('wardrobe'), 'beta-wardrobe-deploy-role');
  assert.equal(serviceDeployCfnRoleName('wardrobe'), 'beta-wardrobe-deploy-cfn-role');
  assert.throws(() => serviceDeployRoleName(''), /Invalid service name/);
  assert.throws(() => serviceDeployRoleName('Service'), /Invalid service name/);
  assert.throws(() => serviceDeployCfnRoleName('service_deploy'), /Invalid service name/);
});

test('the OIDC trust subject is the immutable owner/repository-id form', () => {
  assert.equal(serviceTrustSubject({ repository: 'AnyWear-Service', repositoryId: 1158460323,
    environment: 'beta' }), 'repo:git-malu@11473072/AnyWear-Service@1158460323:environment:beta');
  assert.equal(serviceTrustSubject({ repository: 'AnyWear-Service', repositoryId: 1158460323,
    environment: 'service-artifacts' }), 'repo:git-malu@11473072/AnyWear-Service@1158460323:environment:service-artifacts');
  assert.throws(() => serviceTrustSubject({ repository: 'git-malu/AnyWear-Service', repositoryId: 1, environment: 'beta' }),
    /Invalid service repository/);
  assert.throws(() => serviceTrustSubject({ repository: 'AnyWear-Service', repositoryId: 0, environment: 'beta' }),
    /Invalid service repository id/);
  assert.throws(() => serviceTrustSubject({ repository: 'AnyWear-Service', repositoryId: 1.5, environment: 'beta' }),
    /Invalid service repository id/);
  assert.throws(() => serviceTrustSubject({ repository: 'AnyWear-Service', repositoryId: 1, environment: '' }),
    /Invalid service environment/);
  assert.throws(() => serviceTrustSubject(), /Invalid service repository/);
});
