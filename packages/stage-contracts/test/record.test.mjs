import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  DEPLOYMENT_RECORD_MEMBERS,
  SERVICE_DEPLOYMENT_RECORD_MEMBERS,
  SERVICE_ECS_IDENTITY_FIELDS,
  SERVICE_OBSERVED_FIELDS,
  SERVICE_DEPLOYMENT_RECORD_SCHEMA,
  SERVICE_REPOSITORY,
  SERVICE_RUNTIME_STACK,
  stageContractSchemaHash,
  stableTaskDefinition,
  taskDefinitionContentHash,
  validateServiceDeploymentRecord,
} from '../index.mjs';
import { IMAGE_DIGEST, SERVICE_SHA, gateBlock } from './gate-fixture.mjs';

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
const serviceSha = SERVICE_SHA;
const imageDigest = IMAGE_DIGEST;
const endpoint = 'https://d111111abcdef8.cloudfront.net';
const inputs = [
  { parameter: '/anywear/beta/public_subnet_ids', version: '2', value_sha256: 'a'.repeat(64) },
  { parameter: '/anywear/beta/vpc_id', version: '4', value_sha256: 'd'.repeat(64) },
];

const apiDefinition = {
  family: 'beta-anywear-api',
  taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-api-task',
  executionRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-api-execution',
  networkMode: 'awsvpc',
  cpu: '512',
  memory: '1024',
  containerDefinitions: [{
    name: 'ApiContainer',
    image: `650880818323.dkr.ecr.ap-east-1.amazonaws.com/beta-anywear-service@${imageDigest}`,
    command: ['node', 'dist/index.js'],
    environment: [{ name: 'B', value: '2' }, { name: 'A', value: '1' }],
  }],
};
const workerDefinition = { ...apiDefinition, family: 'beta-anywear-worker',
  taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-worker-task' };

function serviceRecord() {
  return {
    schema_version: 4,
    record_type: SERVICE_DEPLOYMENT_RECORD_SCHEMA.record_type,
    producer: {
      repository: SERVICE_REPOSITORY,
      sha: serviceSha,
      workflow_path: SERVICE_RUNTIME_STACK.workflow_path,
      workflow_ref: `${SERVICE_REPOSITORY}/${SERVICE_RUNTIME_STACK.workflow_path}@refs/heads/main`,
      run_id: 11,
      run_attempt: 1,
    },
    stacks: [{
      name: SERVICE_RUNTIME_STACK.name,
      region: SERVICE_RUNTIME_STACK.region,
      producer_repository: SERVICE_REPOSITORY,
      producer_sha: serviceSha,
      template_sha256: '5'.repeat(64),
    }],
    inputs,
    observed: {
      service_sha: serviceSha,
      image_digest: imageDigest,
      minimum_client_version: 0,
      ecs: {
        api: {
          service_arn: 'arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-api',
          task_definition_arn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-api:12',
          task_definition_sha256: taskDefinitionContentHash(apiDefinition),
          image_digest: imageDigest,
        },
        worker: {
          service_arn: 'arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-worker',
          task_definition_arn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-worker:12',
          task_definition_sha256: taskDefinitionContentHash(workerDefinition),
          image_digest: imageDigest,
        },
      },
      endpoints: { api: endpoint },
    },
    schema: { content_sha256: stageContractSchemaHash(inputs) },
    gate: gateBlock(),
  };
}

test('a complete Service v4 record validates, lists only the Runtime stack and requires the gate', () => {
  const record = serviceRecord();
  assert.deepEqual(validateServiceDeploymentRecord(record), record);
  assert.deepEqual([...SERVICE_DEPLOYMENT_RECORD_MEMBERS].sort(), Object.keys(record).sort());
  assert.deepEqual([...SERVICE_DEPLOYMENT_RECORD_MEMBERS].sort(),
    [...DEPLOYMENT_RECORD_MEMBERS, 'gate'].sort());
  assert.deepEqual(SERVICE_DEPLOYMENT_RECORD_SCHEMA.stacks,
    [{ name: 'AnyWearRuntimeStack-beta', region: 'ap-east-1' }]);
  assert.equal(SERVICE_DEPLOYMENT_RECORD_SCHEMA.schema_version, 4);
  assert.equal(SERVICE_DEPLOYMENT_RECORD_SCHEMA.record_type, 'anywear_service_deployment');
  assert.deepEqual([...SERVICE_ECS_IDENTITY_FIELDS],
    ['service_arn', 'task_definition_arn', 'task_definition_sha256', 'image_digest']);
  assert.deepEqual([...SERVICE_OBSERVED_FIELDS].sort(),
    ['ecs', 'endpoints', 'image_digest', 'minimum_client_version', 'service_sha']);
  assert.deepEqual(SERVICE_DEPLOYMENT_RECORD_SCHEMA.observed, SERVICE_OBSERVED_FIELDS);
  assert.deepEqual(SERVICE_DEPLOYMENT_RECORD_SCHEMA.members, SERVICE_DEPLOYMENT_RECORD_MEMBERS);
});

test('the Service record fails closed on producer, stack and schema drift', () => {
  const base = serviceRecord();
  const withChange = change => {
    const record = structuredClone(base);
    change(record);
    return record;
  };
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => { record.note = 'unexpected'; })),
    /Invalid deployment record fields/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => { delete record.schema; })),
    /Invalid deployment record fields/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => { record.record_type = 'anywear_infra_deployment'; })),
    /Unknown anywear_service_deployment schema/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.producer.repository = 'git-malu/AnyWear-Client';
    for (const stack of record.stacks) stack.producer_repository = 'git-malu/AnyWear-Client';
  })), /Unexpected deployment producer repository/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.producer.workflow_path = '.github/workflows/runtime.yml';
    record.producer.workflow_ref = `${SERVICE_REPOSITORY}/.github/workflows/runtime.yml@refs/heads/main`;
  })), /Unexpected deployment workflow path/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.stacks[0].name = 'AnyWearPlatformStack-beta';
  })), /Invalid stack identity in deployment record/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.stacks.push({ ...record.stacks[0], name: 'AnyWearPlatformStack-beta' });
  })), /exactly its producer's stacks/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.stacks[0].producer_sha = 'f'.repeat(40);
  })), /Stack producer differs from the deployment producer/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => { record.inputs = []; })),
    /Stage contract schema hash differs from the recorded inputs/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.inputs = [...record.inputs].reverse();
  })), /sorted and unique/);
});

test('the Service observation pins the two ECS identities and the image digest', () => {
  const base = serviceRecord();
  const withChange = change => {
    const record = structuredClone(base);
    change(record);
    return record;
  };
  assert.deepEqual(validateServiceDeploymentRecord(base), base);
  // A revision-only change is not an identity failure.
  const revisionOnly = withChange(record => {
    record.observed.ecs.api.task_definition_arn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-api:13';
  });
  assert.deepEqual(validateServiceDeploymentRecord(revisionOnly), revisionOnly);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.observed.ecs.api.image_digest = `sha256:${'9'.repeat(64)}`;
  })), /ECS api image_digest differs from the deployed image/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.observed.ecs.api.task_definition_sha256 = 'not-a-content-hash';
  })), /Invalid ECS api task definition content hash/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.observed.ecs.api.service_arn = 'arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-worker';
  })), /Invalid ECS api service ARN/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.observed.endpoints = { api: endpoint, extra: endpoint };
  })), /Invalid endpoints fields/);
});

test('the Service observation requires a non-negative safe integer minimum client version', () => {
  const base = serviceRecord();
  const withChange = change => {
    const record = structuredClone(base);
    change(record);
    return record;
  };
  // 0 is the expand-stage floor: a pre-header Client stays accepted.
  assert.equal(validateServiceDeploymentRecord(base).observed.minimum_client_version, 0);
  for (const [label, value] of [['missing', undefined], ['negative', -1], ['fractional', 1.5],
    ['string', '1'], ['unsafe integer', Number.MAX_SAFE_INTEGER + 1], ['NaN', Number.NaN]]) {
    const record = withChange(candidate => {
      if (value === undefined) delete candidate.observed.minimum_client_version;
      else candidate.observed.minimum_client_version = value;
    });
    assert.throws(() => validateServiceDeploymentRecord(record),
      value === undefined ? /Invalid workload observed tuple fields/ : /Invalid observed minimum client version/,
      label);
  }
  const raised = withChange(record => { record.observed.minimum_client_version = 7; });
  assert.deepEqual(validateServiceDeploymentRecord(raised), raised);
});

test('the record gate must pass and stay bound to the observed Service and image', () => {
  const base = serviceRecord();
  const withChange = change => {
    const record = structuredClone(base);
    change(record);
    return record;
  };
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => { delete record.gate; })),
    /Invalid deployment record fields/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.gate.service_sha = 'f'.repeat(40);
  })), /Deployment gate Service differs from the observed Service/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.gate.image_digest = `sha256:${'9'.repeat(64)}`;
  })), /Deployment gate image differs from the observed image/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.gate.result = 'failed';
  })), /Deployment gate did not pass/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.gate.signals[4].value.vto_depth = 1;
  })), /Deployment gate signal sqs_dlq_depth is breaching/);
  // A pre-gate v3 Service record is a historical shape, not a live input.
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.schema_version = 3;
  })), /Unknown anywear_service_deployment schema/);
});

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
