import { canonicalJson, parseJson, sha256 } from './json-contract.mjs';

const machineArn = 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup';
const executionPattern = /^arn:aws:states:ap-east-1:650880818323:execution:beta-anywear-tester-cleanup:[A-Za-z0-9_-]{1,80}$/;
const taskPattern = /^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/[a-f0-9]{32}$/;
const definitionPattern = /^arn:aws:ecs:ap-east-1:650880818323:task-definition\/beta-anywear-cleanup(?:-verify)?:[1-9][0-9]*$/;
const terminalExecutions = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED']);
const taskStates = new Set(['PROVISIONING', 'PENDING', 'ACTIVATING', 'RUNNING', 'DEACTIVATING', 'STOPPING', 'DEPROVISIONING', 'STOPPED']);
const stackStates = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']);
const families = ['beta-anywear-cleanup-verify', 'beta-anywear-cleanup'];

// This code proves resource cessation only. The manager separately reconciles
// pending owners and committed/unknown operation results before any replacement.
export async function assertCleanupCapabilityQuiescent(io, workload) {
  if (!stackStates.has(workload?.StackStatus) || !Array.isArray(workload.Outputs)
    || workload.Outputs.some(row => typeof row?.OutputKey !== 'string' || typeof row.OutputValue !== 'string')) throw new Error('Stable Workload cleanup capability inventory required');
  const outputs = workload.Outputs.filter(row => row.OutputKey === 'CleanupOperationCleanupStateMachineArn3993CAF0');
  if (workload.Outputs.some(row => row.OutputKey.startsWith('CleanupOperationCleanupStateMachineArn')
    && row.OutputKey !== 'CleanupOperationCleanupStateMachineArn3993CAF0')) throw new Error('Unknown cleanup machine output identity');
  if (outputs.length > 1 || outputs.length === 1 && outputs[0].OutputValue !== machineArn) throw new Error('Unknown or ambiguous cleanup machine output');
  const deployed = outputs.length === 1;
  if (!deployed) {
    const original = (await io.aws(['cloudformation', 'get-template', '--stack-name', 'AnyWearWorkloadStack-beta', '--template-stage', 'Original'])).TemplateBody;
    const template = typeof original === 'string' ? parseJson(original) : original;
    if (!template?.Resources || typeof template.Resources !== 'object' || Array.isArray(template.Resources) || Object.values(template.Resources).some(resource =>
      resource?.Type === 'AWS::StepFunctions::StateMachine' && resource.Properties?.StateMachineName === 'beta-anywear-tester-cleanup')) {
      throw new Error('Cleanup machine source/output absence is unproven');
    }
  }
  const deadline = io.now() + 60_000;
  const pages = async (args, field, pattern) => {
    const rows = []; const tokens = new Set(); let token;
    for (let count = 0; ; count++) {
      if (count >= 10 || io.now() >= deadline) throw new Error('Cleanup resource pagination exceeded its bound');
      const page = await io.aws([...args, '--max-results', '100', '--no-paginate', ...(token ? ['--next-token', token] : [])]);
      if (!Array.isArray(page?.[field]) || page[field].length > 100 || page[field].some(row => !pattern(row))) throw new Error('Malformed cleanup resource inventory');
      rows.push(...page[field]);
      token = page.nextToken;
      if (token === undefined) return rows;
      if (typeof token !== 'string' || !token || token.length > 4096 || /\s/.test(token) || tokens.has(token)) throw new Error('Invalid cleanup resource pagination token');
      tokens.add(token);
    }
  };
  const scan = async () => {
    const executions = [];
    if (deployed) {
      const listed = await pages(['stepfunctions', 'list-executions', '--state-machine-arn', machineArn], 'executions', row =>
        row?.stateMachineArn === machineArn && executionPattern.test(row?.executionArn ?? '') && terminalExecutions.has(row.status));
      if (new Set(listed.map(row => row.executionArn)).size !== listed.length) throw new Error('Duplicate cleanup execution inventory');
      for (const row of listed) {
        if (io.now() >= deadline) throw new Error('Cleanup execution description exceeded its bound');
        const actual = await io.aws(['stepfunctions', 'describe-execution', '--execution-arn', row.executionArn]);
        if (actual?.executionArn !== row.executionArn || actual.stateMachineArn !== machineArn
          || actual.status !== row.status || !terminalExecutions.has(actual.status)) throw new Error('Active, unknown or changing cleanup execution blocks replacement');
        executions.push({ arn: row.executionArn, status: actual.status });
      }
    }
    const taskArns = new Set();
    for (const family of families) for (const desired of ['RUNNING', 'STOPPED']) {
      const listed = await pages(['ecs', 'list-tasks', '--cluster', 'beta-anywear', '--family', family, '--desired-status', desired],
        'taskArns', arn => typeof arn === 'string' && taskPattern.test(arn));
      listed.forEach(arn => taskArns.add(arn));
    }
    const tasks = []; const arns = [...taskArns].sort();
    for (let offset = 0; offset < arns.length; offset += 100) {
      if (io.now() >= deadline) throw new Error('Cleanup task description exceeded its bound');
      const batch = arns.slice(offset, offset + 100);
      const actual = await io.aws(['ecs', 'describe-tasks', '--cluster', 'beta-anywear', '--tasks', ...batch]);
      if (!Array.isArray(actual?.tasks) || actual.tasks.length !== batch.length
        || actual.failures !== undefined && (!Array.isArray(actual.failures) || actual.failures.length)
        || new Set(actual.tasks.map(task => task?.taskArn)).size !== batch.length) throw new Error('Incomplete cleanup task inventory');
      for (const task of actual.tasks) {
        if (!batch.includes(task?.taskArn) || task.clusterArn !== 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear'
          || !definitionPattern.test(task.taskDefinitionArn ?? '') || !taskStates.has(task.lastStatus)
          || task.lastStatus !== 'STOPPED') throw new Error('Active or unknown cleanup task blocks replacement');
        tasks.push({ arn: task.taskArn, definition: task.taskDefinitionArn, status: task.lastStatus });
      }
    }
    return { machine_arn: deployed ? machineArn : 'not-present-in-workload',
      executions: executions.sort((a, b) => a.arn.localeCompare(b.arn)), tasks: tasks.sort((a, b) => a.arn.localeCompare(b.arn)) };
  };
  const before = await scan();
  await io.sleep(1000);
  const after = await scan();
  if (canonicalJson(before) !== canonicalJson(after)) throw new Error('Cleanup resource inventory changed between complete scans');
  return { machine_arn: after.machine_arn, execution_count: after.executions.length, cleanup_task_count: after.tasks.length,
    terminal_failed_execution_arns: after.executions.filter(row => row.status !== 'SUCCEEDED').map(row => row.arn),
    inventory_sha256: sha256(canonicalJson(after)), manager_result_reconciliation_required: true };
}
