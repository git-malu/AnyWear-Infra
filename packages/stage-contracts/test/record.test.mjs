import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  DEPLOYMENT_RECORD_MEMBERS,
  SERVICE_DEPLOYMENT_RECORD_MEMBERS,
  SERVICE_ECS_IDENTITY_FIELDS,
  SERVICE_OBSERVED_FIELDS,
  SERVICE_DEPLOYMENT_RECORD_SCHEMA,
  SERVICE_SCHEMA_BOUNDARY_FIELDS,
  INFRA_REPOSITORY,
  SERVICE_RUNTIME_STACK,
  SCHEMA_BOUNDARY_APPLIED_FIELDS,
  SCHEMA_BOUNDARY_ASSET_FIELDS,
  SCHEMA_BOUNDARY_COMPARISON_FIELDS,
  SCHEMA_BOUNDARY_READER_FIELDS,
  SCHEMA_BOUNDARY_READER_SOURCES,
  SCHEMA_BOUNDARY_RESULTS,
  schemaBoundaryPrefixHash,
  stageContractSchemaHash,
  stableTaskDefinition,
  taskDefinitionContentHash,
  validateSchemaBoundary,
  validateServiceDeploymentRecord,
} from '../index.mjs';
import { IMAGE_DIGEST, SERVICE_SHA, gateBlock, schemaBoundaryBlock } from './gate-fixture.mjs';

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
    schema_version: 6,
    record_type: SERVICE_DEPLOYMENT_RECORD_SCHEMA.record_type,
    producer: {
      repository: INFRA_REPOSITORY,
      sha: serviceSha,
      workflow_path: SERVICE_RUNTIME_STACK.workflow_path,
      workflow_ref: `${INFRA_REPOSITORY}/${SERVICE_RUNTIME_STACK.workflow_path}@refs/heads/main`,
      run_id: 11,
      run_attempt: 1,
    },
    stacks: [{
      name: SERVICE_RUNTIME_STACK.name,
      region: SERVICE_RUNTIME_STACK.region,
      producer_repository: INFRA_REPOSITORY,
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
    schema_boundary: schemaBoundaryBlock(),
  };
}

test('a complete Infra-produced v6 record validates, lists only the Runtime stack and requires the gate and boundary', () => {
  const record = serviceRecord();
  assert.deepEqual(validateServiceDeploymentRecord(record), record);
  assert.deepEqual([...SERVICE_DEPLOYMENT_RECORD_MEMBERS].sort(), Object.keys(record).sort());
  assert.deepEqual([...SERVICE_DEPLOYMENT_RECORD_MEMBERS].sort(),
    [...DEPLOYMENT_RECORD_MEMBERS, 'gate', 'schema_boundary'].sort());
  assert.deepEqual(SERVICE_DEPLOYMENT_RECORD_SCHEMA.stacks,
    [{ name: 'AnyWearRuntimeStack-beta', region: 'ap-east-1' }]);
  assert.equal(SERVICE_DEPLOYMENT_RECORD_SCHEMA.schema_version, 6);
  assert.equal(SERVICE_DEPLOYMENT_RECORD_SCHEMA.record_type, 'anywear_service_deployment');
  assert.deepEqual([...SERVICE_ECS_IDENTITY_FIELDS],
    ['service_arn', 'task_definition_arn', 'task_definition_sha256', 'image_digest']);
  assert.deepEqual([...SERVICE_OBSERVED_FIELDS].sort(),
    ['ecs', 'endpoints', 'image_digest', 'minimum_client_version', 'service_sha']);
  assert.deepEqual(SERVICE_DEPLOYMENT_RECORD_SCHEMA.observed, SERVICE_OBSERVED_FIELDS);
  assert.deepEqual(SERVICE_DEPLOYMENT_RECORD_SCHEMA.members, SERVICE_DEPLOYMENT_RECORD_MEMBERS);
  assert.deepEqual(SERVICE_DEPLOYMENT_RECORD_SCHEMA.schema_boundary, SERVICE_SCHEMA_BOUNDARY_FIELDS);
  assert.deepEqual([...SERVICE_SCHEMA_BOUNDARY_FIELDS], ['result', 'asset', 'applied', 'comparison', 'reader']);
  assert.deepEqual([...SCHEMA_BOUNDARY_ASSET_FIELDS],
    ['sha256', 'current_version', 'minimum_version', 'minimum_migration_count', 'journal_length']);
  assert.deepEqual([...SCHEMA_BOUNDARY_APPLIED_FIELDS], ['schema_version', 'journal_length']);
  assert.deepEqual([...SCHEMA_BOUNDARY_COMPARISON_FIELDS],
    ['checked_entries', 'prefix_sha256', 'pending_migrations']);
  assert.deepEqual([...SCHEMA_BOUNDARY_READER_FIELDS], ['source', 'service_sha', 'image_digest']);
  assert.deepEqual([...SCHEMA_BOUNDARY_READER_SOURCES], ['selected-image', 'deployed-image']);
  assert.deepEqual([...SCHEMA_BOUNDARY_RESULTS], ['compatible']);
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
    record.producer.workflow_ref = `${INFRA_REPOSITORY}/.github/workflows/runtime.yml@refs/heads/main`;
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
  // A pre-gate v3, the Service-produced v4 record and the pre-boundary v5 record
  // are historical shapes, not live inputs: v6 is the only accepted version.
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.schema_version = 3;
  })), /Unknown anywear_service_deployment schema/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.schema_version = 4;
  })), /Unknown anywear_service_deployment schema/);
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.schema_version = 5;
  })), /Unknown anywear_service_deployment schema/);
  // A genuine v5 record (its exact eight members, version 5) is refused as an
  // unknown schema — the version check precedes the member check — not as a
  // missing-member error.
  const genuineV5 = withChange(record => {
    record.schema_version = 5;
    delete record.schema_boundary;
  });
  assert.throws(() => validateServiceDeploymentRecord(genuineV5),
    /Unknown anywear_service_deployment schema/);
  // The v5 producer is Infra's `mutate.yml`; the retired Service workflow is not
  // a producer even when the repository field is changed with it.
  assert.throws(() => validateServiceDeploymentRecord(withChange(record => {
    record.producer.workflow_path = '.github/workflows/service-artifacts.yml';
    record.producer.workflow_ref = `${INFRA_REPOSITORY}/.github/workflows/service-artifacts.yml@refs/heads/main`;
  })), /Unexpected deployment workflow path/);
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

test('the v6 schema boundary proves the comparison relations and the selected reader is the observed deployment', () => {
  const base = serviceRecord();
  const boundaryChange = (change) => {
    const record = structuredClone(base);
    change(record.schema_boundary);
    return record;
  };
  assert.deepEqual(validateServiceDeploymentRecord(base), base);
  assert.deepEqual(validateSchemaBoundary(base.schema_boundary), base.schema_boundary);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.note = 'unexpected';
  })), /Invalid schema boundary fields/);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    delete boundary.reader;
  })), /Invalid schema boundary fields/);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    delete boundary.applied.journal_length;
  })), /Invalid schema boundary applied fields/);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.result = 'refused';
  })), /Invalid schema boundary result/);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.asset.sha256 = 'not-a-hash';
  })), /Invalid schema boundary asset digest/);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.asset.current_version = 0;
  })), /Invalid schema boundary current version/);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.asset.minimum_version = 23;
  })), /Invalid schema boundary version range/);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.asset.minimum_migration_count = 27;
  })), /Schema boundary minimum migration count exceeds the release journal/);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.asset.minimum_version = 22;
  })), /Equal schema boundary versions must require the whole release journal/);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.applied.schema_version = 19;
  })), /Schema boundary applied version is below the release minimum/);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.applied.journal_length = 27;
  })), /Schema boundary applied journal is longer than the release journal/);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.comparison.checked_entries = 25;
  })), /Schema boundary checked entries differ from the applied journal length/);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.comparison.pending_migrations = 2;
  })), /Schema boundary pending migrations differ from the release journal tail/);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.comparison.prefix_sha256 = 'not-a-hash';
  })), /Invalid schema boundary prefix hash/);
  // A shortfall below the migration boundary is not a recordable compatible
  // state: the producer refuses it, so the validator must too.
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.applied.journal_length = 23;
    boundary.comparison.checked_entries = 23;
    boundary.comparison.pending_migrations = 3;
  })), /Schema boundary checked entries are below the minimum migration count/);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.reader.source = 'some-other-image';
  })), /Invalid schema boundary reader source/);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.reader.service_sha = 'short';
  })), /Invalid schema boundary reader Service/);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.reader.image_digest = 'sha256:short';
  })), /Invalid schema boundary reader image/);
  // A selected-image reader is the release under test, not an arbitrary image.
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.reader.service_sha = 'f'.repeat(40);
  })), /Schema boundary reader Service differs from the observed Service/);
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    boundary.reader.image_digest = `sha256:${'9'.repeat(64)}`;
  })), /Schema boundary reader image differs from the observed image/);
  // The one bounded fallback reads the pre-existing deployed image, so its
  // identity is recorded as observed and deliberately differs from `observed`.
  const fallback = boundaryChange(boundary => {
    boundary.reader = { source: 'deployed-image', service_sha: 'f'.repeat(40),
      image_digest: `sha256:${'9'.repeat(64)}` };
  });
  assert.deepEqual(validateServiceDeploymentRecord(fallback), fallback);
  // The record without the member is not a v6 record.
  assert.throws(() => validateServiceDeploymentRecord(boundaryChange(boundary => {
    delete boundary.result;
  })), /Invalid schema boundary fields/);
  const missing = structuredClone(base);
  delete missing.schema_boundary;
  assert.throws(() => validateServiceDeploymentRecord(missing), /Invalid deployment record fields/);
});

test('the schema boundary prefix hash is the canonical hash of the compared creation-time/hash pairs', () => {
  const entries = [
    { created_at: 1773041075909, sha256: 'a'.repeat(64) },
    { created_at: 1775482276416, sha256: 'b'.repeat(64) },
  ];
  assert.equal(schemaBoundaryPrefixHash(entries), sha256(canonical(entries)));
  assert.equal(schemaBoundaryPrefixHash([]), sha256(canonical([])));
  assert.notEqual(schemaBoundaryPrefixHash(entries.slice(0, 1)), schemaBoundaryPrefixHash(entries));
  // The order is the journal order, not a sorted set.
  assert.notEqual(schemaBoundaryPrefixHash([...entries].reverse()), schemaBoundaryPrefixHash(entries));
  assert.throws(() => schemaBoundaryPrefixHash([{ created_at: 1, hash: 'a'.repeat(64) }]),
    /Invalid schema boundary prefix entry fields/);
  assert.throws(() => schemaBoundaryPrefixHash([{ created_at: -1, sha256: 'a'.repeat(64) }]),
    /Invalid schema boundary prefix migration time/);
  assert.throws(() => schemaBoundaryPrefixHash([{ created_at: 1, sha256: 'abc' }]),
    /Invalid schema boundary prefix migration hash/);
  assert.throws(() => schemaBoundaryPrefixHash(Array.from({ length: 257 },
    () => ({ created_at: 1, sha256: 'a'.repeat(64) }))), /Invalid schema boundary prefix/);
});
