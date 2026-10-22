import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENT_SQS_DEPTH_ATTRIBUTES } from '@git-malu/stage-contracts';

// Every AWS CLI call the 600-second bake runs. Since #195 the bake runs inside
// the Infra `deploy-runtime` operation under the read-only runtime session as
// `beta-infra-runtime-role`; its bake grants live in
// `lib/beta-role-grants.ts` and render into the Platform stack's
// `DedicatedPolicy`. This table is the completeness check for the bake surface:
// a new AWS call in `scripts/bake-gate.mjs` fails this test until it is added
// here with its IAM action and its `added_by_162` provenance.
export const BAKE_AWS_CALLS = Object.freeze({
  'cloudformation:list-stack-resources': Object.freeze({
    action: 'cloudformation:ListStackResources',
    granted_action: 'cloudformation:*',
    added_by_162: false,
    purpose: 'resolve the deployed ALB dimension from the Workload stack resources',
  }),
  'cloudwatch:get-metric-statistics': Object.freeze({
    action: 'cloudwatch:GetMetricStatistics',
    granted_action: 'cloudwatch:GetMetricStatistics',
    added_by_162: true,
    purpose: 'ALB 5xx counts, request count and TargetResponseTime p95, plus the AWS/SQS ApproximateAgeOfOldestMessage Maximum for each work queue',
  }),
  'cloudwatch:describe-alarms': Object.freeze({
    action: 'cloudwatch:DescribeAlarms',
    granted_action: 'cloudwatch:DescribeAlarms',
    added_by_162: true,
    purpose: 'record the nine deployed bake/SQS alarm names and states as evidence',
  }),
  'ecs:describe-services': Object.freeze({
    action: 'ecs:DescribeServices',
    granted_action: 'ecs:DescribeServices',
    added_by_162: true,
    purpose: 'sample running/desired counts and rollout state for the api and worker services',
  }),
  'sqs:get-queue-attributes': Object.freeze({
    action: 'sqs:GetQueueAttributes',
    granted_action: 'sqs:GetQueueAttributes',
    added_by_162: true,
    purpose: 'depth for the two DLQs and the three valid depth attributes on the two work queues (the oldest age is the AWS/SQS CloudWatch metric, not a GetQueueAttributes name)',
    attributes: DEPLOYMENT_SQS_DEPTH_ATTRIBUTES,
  }),
  'logs:filter-log-events': Object.freeze({
    action: 'logs:FilterLogEvents',
    granted_action: 'logs:FilterLogEvents',
    added_by_162: true,
    purpose: 'read the worker "Durable task outbox metrics" lines from /anywear/<stage>/worker',
  }),
});

const infraRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bakeSource = readFileSync(path.join(infraRoot, 'scripts', 'bake-gate.mjs'), 'utf8');

function observedCalls() {
  // The bake passes each CLI call as `[service, operation, ...]`; the metric read
  // assembles the same pair in `args`. Match either literal array form.
  const calls = new Set();
  for (const match of bakeSource.matchAll(/\[\s*'(cloudformation|cloudwatch|ecs|sqs|logs)'\s*,\s*'([a-z0-9-]+)'/g)) {
    calls.add(`${match[1]}:${match[2]}`);
  }
  return [...calls].sort();
}

test('the declared bake read table covers every AWS call the bake runs', () => {
  assert.deepEqual(observedCalls(), Object.keys(BAKE_AWS_CALLS).sort());
  // One `awsJson(runAws, ...)` definition plus exactly one call site per read.
  const awsJsonSites = (bakeSource.match(/awsJson\(runAws,/g) ?? []).length;
  assert.equal(awsJsonSites, Object.keys(BAKE_AWS_CALLS).length + 1,
    'a bake AWS call was added or removed without updating BAKE_AWS_CALLS');
});

test('each declared bake read records its IAM action and grant provenance', () => {
  for (const [call, entry] of Object.entries(BAKE_AWS_CALLS)) {
    assert.match(call, /^[a-z0-9]+:[a-z0-9-]+$/, `${call} is a lower-case service:operation pair`);
    assert.equal(typeof entry.action, 'string', `${call} needs an IAM action`);
    assert.equal(typeof entry.granted_action, 'string', `${call} needs the granted action`);
    assert.equal(typeof entry.purpose, 'string', `${call} needs a purpose`);
    assert.equal(typeof entry.added_by_162, 'boolean', `${call} needs grant provenance`);
  }
  // #162 added five of the six grants; the CloudFormation stack-resource read is
  // covered by the pre-existing `cloudformation:*` grant on the Workload stack.
  assert.deepEqual(Object.entries(BAKE_AWS_CALLS)
    .filter(([, entry]) => entry.added_by_162 === false).map(([call]) => call),
  ['cloudformation:list-stack-resources']);
});

test('the declared SQS read names only attributes the live API accepts', () => {
  // Deliberately independent of the package constant: this is the live API
  // contract the bake must satisfy. ApproximateAgeOfOldestMessage is a
  // CloudWatch metric, and ApproximateNumberOfMessagesVisible is not a
  // GetQueueAttributes attribute name at all.
  const liveValid = ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible',
    'ApproximateNumberOfMessagesDelayed'];
  const declared = BAKE_AWS_CALLS['sqs:get-queue-attributes'].attributes;
  assert.deepEqual([...declared], liveValid);
  for (const name of declared) assert.equal(liveValid.includes(name), true, `${name} is a live SQS attribute`);
  assert.equal(declared.includes('ApproximateAgeOfOldestMessage'), false);
  assert.equal(declared.includes('ApproximateNumberOfMessagesVisible'), false);
});
