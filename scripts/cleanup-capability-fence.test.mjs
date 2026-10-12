import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCleanupCapabilityQuiescent } from './cleanup-capability-fence.mjs';

const machine = 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup';
const execution = 'arn:aws:states:ap-east-1:650880818323:execution:beta-anywear-tester-cleanup:beta-cleanup-123';
const taskArn = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'c'.repeat(32)}`;
const workload = { StackStatus: 'UPDATE_COMPLETE', Outputs: [
  { OutputKey: 'CleanupOperationCleanupStateMachineArn3993CAF0', OutputValue: machine },
] };
const completed = { executionArn: execution, stateMachineArn: machine, status: 'SUCCEEDED' };

function fixture(overrides = {}) {
  const calls = []; let clock = 0;
  const io = { now: () => clock, sleep: async ms => { clock += ms; }, async aws(args) {
    calls.push(args);
    if (overrides[args[1]]) return overrides[args[1]](args, calls);
    if (args[1] === 'list-executions' || args[1] === 'describe-execution') return args[1] === 'list-executions'
      ? { executions: [completed] } : completed;
    if (args[1] === 'list-tasks') return { taskArns: [] };
    if (args[1] === 'get-template') return { TemplateBody: { Resources: {} } };
    throw new Error(`Unexpected mutation or read: ${args[1]}`);
  } };
  return { io, calls };
}

test('complete stable resource scans preserve terminal failures for separate result reconciliation', async () => {
  const failed = { ...completed, status: 'FAILED' };
  const { io, calls } = fixture({ 'list-executions': () => ({ executions: [failed] }), 'describe-execution': () => failed });
  const result = await assertCleanupCapabilityQuiescent(io, workload);
  assert.equal(result.execution_count, 1);
  assert.deepEqual(result.terminal_failed_execution_arns, [execution]);
  assert.equal(result.manager_result_reconciliation_required, true);
  assert.equal(calls.filter(args => args[1] === 'list-executions').length, 2);
  assert.equal(calls.filter(args => args[1] === 'list-tasks').length, 12);
  assert.ok(calls.every(args => !['stop-task', 'start-execution', 'redrive-execution'].includes(args[1])));
});

test('active, unknown, duplicate and changed execution inventories block replacement', async () => {
  for (const status of ['RUNNING', 'PENDING_REDRIVE', 'UNKNOWN']) {
    const { io } = fixture({ 'list-executions': () => ({ executions: [{ ...completed, status }] }) });
    await assert.rejects(assertCleanupCapabilityQuiescent(io, workload), /inventory/);
  }
  for (const rows of [[completed, completed], [{ ...completed, stateMachineArn: `${machine}-other` }], [{}]]) {
    const { io } = fixture({ 'list-executions': () => ({ executions: rows }) });
    await assert.rejects(assertCleanupCapabilityQuiescent(io, workload), /inventory/);
  }
  const { io } = fixture({ 'describe-execution': () => ({ ...completed, status: 'RUNNING' }) });
  await assert.rejects(assertCleanupCapabilityQuiescent(io, workload), /blocks replacement/);
  let listed = 0;
  const changed = fixture({ 'list-executions': () => ({ executions: listed++ ? [] : [completed] }) });
  await assert.rejects(assertCleanupCapabilityQuiescent(changed.io, workload), /changed between complete scans/);
});

test('cleanup task inventory requires unique exact stopped tasks and rejects running or omitted tasks', async () => {
  const stopped = { taskArn, clusterArn: 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear',
    taskDefinitionArn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-cleanup:7', lastStatus: 'STOPPED' };
  const listings = args => ({ taskArns: args.includes('beta-anywear-cleanup') ? [taskArn] : [] });
  const good = fixture({ 'list-tasks': listings, 'describe-tasks': () => ({ tasks: [stopped], failures: [] }) });
  assert.equal((await assertCleanupCapabilityQuiescent(good.io, workload)).cleanup_task_count, 1);
  for (const actual of [{ tasks: [{ ...stopped, lastStatus: 'PENDING' }] }, { tasks: [] },
    { tasks: [stopped], failures: [{ arn: taskArn }] }, { tasks: [{ ...stopped, taskDefinitionArn: 'other' }] }]) {
    const { io } = fixture({ 'list-tasks': listings, 'describe-tasks': () => actual });
    await assert.rejects(assertCleanupCapabilityQuiescent(io, workload), /inventory|blocks replacement/);
  }
});

test('separate acceptance fixture tasks also block capability replacement until stopped', async () => {
  const task = { taskArn, clusterArn: 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear',
    taskDefinitionArn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-cleanup-acceptance:7', lastStatus: 'RUNNING' };
  const { io } = fixture({ 'list-tasks': args => ({ taskArns: args.includes('beta-anywear-cleanup-acceptance') ? [taskArn] : [] }),
    'describe-tasks': () => ({ tasks: [task] }) });
  await assert.rejects(assertCleanupCapabilityQuiescent(io, workload), /blocks replacement/);
  task.lastStatus = 'STOPPED';
  assert.equal((await assertCleanupCapabilityQuiescent(io, workload)).cleanup_task_count, 1);
});

test('complete bounded pagination rejects loops, missing pages and oversized or foreign results', async () => {
  for (const result of [{}, { executions: [completed], nextToken: 'loop' },
    { executions: Array(101).fill(completed) }, { executions: [], nextToken: '' }]) {
    const { io } = fixture({ 'list-executions': () => result });
    await assert.rejects(assertCleanupCapabilityQuiescent(io, workload), /inventory|pagination/);
  }
  const { io } = fixture({ 'list-tasks': () => ({ taskArns: ['foreign'] }) });
  await assert.rejects(assertCleanupCapabilityQuiescent(io, workload), /inventory/);
});

test('first install requires stable source/output absence and still checks cleanup tasks', async () => {
  const first = { StackStatus: 'UPDATE_COMPLETE', Outputs: [] };
  const { io, calls } = fixture();
  const result = await assertCleanupCapabilityQuiescent(io, first);
  assert.equal(result.machine_arn, 'not-present-in-workload');
  assert.equal(calls.some(args => args[0] === 'stepfunctions'), false);
  const unknown = fixture({ 'get-template': () => ({ TemplateBody: { Resources: {
    Existing: { Type: 'AWS::StepFunctions::StateMachine', Properties: { StateMachineName: 'beta-anywear-tester-cleanup' } },
  } } }) });
  await assert.rejects(assertCleanupCapabilityQuiescent(unknown.io, first), /absence is unproven/);
  await assert.rejects(assertCleanupCapabilityQuiescent(io, { ...first, StackStatus: 'UPDATE_IN_PROGRESS' }), /Stable Workload/);
  await assert.rejects(assertCleanupCapabilityQuiescent(io, { ...workload, Outputs: [...workload.Outputs, ...workload.Outputs] }), /ambiguous/);
  await assert.rejects(assertCleanupCapabilityQuiescent(io, { ...workload, Outputs: [{ OutputKey: 'CleanupOperationCleanupStateMachineArnOTHER', OutputValue: machine }] }), /Unknown cleanup machine output/);
});
