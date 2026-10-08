import { pathToFileURL } from 'node:url';
const platformStack = 'AnyWearPlatformStack-beta';
const workloadStack = 'AnyWearWorkloadStack-beta';
const terminalStackStatuses = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']);

function values(entries, nameKey, valueKey) {
  return Object.fromEntries((entries ?? []).map((entry) => [entry[nameKey], entry[valueKey]]));
}

export function workloadRevision(stack) {
  const parameters = values(stack.Parameters, 'ParameterKey', 'ParameterValue');
  const digest = parameters.ServiceImageDigest;
  const commit = parameters.ServiceCommitSha;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? '')) {
    throw new Error('Beta lifecycle requires an existing pinned workload image and commit');
  }
  if (!parameters.VlmConfigArn || !/^pl-[a-z0-9]+$/.test(parameters.CloudFrontPrefixListId ?? '')) {
    throw new Error('Beta workload parameters are incomplete');
  }
  return { digest, commit, parameters };
}

function selectedStartRevision(observed, selected) {
  if (!selected || typeof selected !== 'object'
    || !/^sha256:[a-f0-9]{64}$/.test(selected.digest ?? '')
    || !/^[a-f0-9]{40}$/.test(selected.commit ?? '')) {
    throw new Error('Selected Beta start revision is required and must be immutable');
  }
  const revision = workloadRevision(observed);
  return {
    ...revision,
    digest: selected.digest,
    commit: selected.commit,
    parameters: {
      ...revision.parameters,
      ServiceImageDigest: selected.digest,
      ServiceCommitSha: selected.commit,
    },
  };
}

function assertStartStack(stack, name) {
  if (!terminalStackStatuses.has(stack?.StackStatus)) {
    throw new Error(`Beta ${name} stack is not terminal: ${stack?.StackStatus ?? 'unavailable'}`);
  }
  const active = values(stack.Outputs, 'OutputKey', 'OutputValue').BetaActive;
  if (active !== 'false') throw new Error(`Beta ${name} stack must be inactive before start`);
}

export async function waitForTasks(io, cluster, { servicesAllowed, timeoutMs = 600_000 }) {
  if (cluster !== 'beta-anywear') throw new Error('Task inventory is restricted to the expected Beta cluster');
  const clusterArn = 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear';
  const taskArnPattern = /^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/[a-f0-9]{32}$/;
  const taskStatuses = new Set(['PROVISIONING', 'PENDING', 'ACTIVATING', 'RUNNING',
    'DEACTIVATING', 'STOPPING', 'DEPROVISIONING', 'STOPPED']);
  const deadline = io.now() + timeoutMs;
  while (true) {
    const listedArns = new Set();
    // A task can have desired STOPPED while its containers are still shutting down.
    for (const desiredStatus of ['RUNNING', 'STOPPED']) {
      let nextToken;
      const seenTokens = new Set();
      let pages = 0;
      do {
        if (++pages > 100 || (pages > 1 && io.now() >= deadline)) {
          throw new Error('Beta ECS task inventory pagination did not complete within its bound');
        }
        const listing = await io.aws(['ecs', 'list-tasks', '--cluster', cluster,
          '--desired-status', desiredStatus, '--max-results', '100', '--no-paginate',
          ...(nextToken ? ['--next-token', nextToken] : [])]);
        if (!Array.isArray(listing?.taskArns) || listing.taskArns.length > 100
          || listing.taskArns.some((arn) => typeof arn !== 'string' || !taskArnPattern.test(arn))) {
          throw new Error('Missing or malformed Beta ECS task inventory');
        }
        for (const arn of listing.taskArns) listedArns.add(arn);
        nextToken = listing.nextToken;
        if (nextToken !== undefined) {
          if (typeof nextToken !== 'string' || !nextToken || nextToken.length > 4096
            || /\s/.test(nextToken) || seenTokens.has(nextToken)) {
            throw new Error('Invalid or repeated Beta ECS task inventory pagination token');
          }
          seenTokens.add(nextToken);
        }
      } while (nextToken);
    }
    const taskArns = [...listedArns];
    if (taskArns.length === 0) return;
    const tasks = [];
    for (let offset = 0; offset < taskArns.length; offset += 100) {
      const batch = taskArns.slice(offset, offset + 100);
      const result = await io.aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', ...batch]);
      const described = result?.tasks;
      if (!Array.isArray(described) || described.length !== batch.length
        || (result.failures !== undefined && (!Array.isArray(result.failures) || result.failures.length > 0))
        || new Set(described.map((task) => task?.taskArn)).size !== batch.length
        || described.some((task) => !task || !batch.includes(task.taskArn) || task.clusterArn !== clusterArn
          || !taskStatuses.has(task.lastStatus) || typeof task.group !== 'string' || !task.group || task.group.length > 255)) {
        throw new Error('Unable to identify every Beta ECS task');
      }
      tasks.push(...described);
    }
    const busy = tasks.filter((task) => task.lastStatus !== 'STOPPED'
      && (!servicesAllowed || !['service:beta-anywear-api', 'service:beta-anywear-worker'].includes(task.group)));
    if (busy.length === 0) return;
    if (io.now() >= deadline) throw new Error('Beta still has running one-shot or service tasks; shutdown aborted');
    await io.sleep(10_000);
  }
}

export async function runBetaLifecycle(action, io, { selectedRevision } = {}) {
  if (!['start', 'stop'].includes(action)) throw new Error('Beta lifecycle action must be start or stop');
  const workload = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', workloadStack])).Stacks?.[0];
  const platform = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', platformStack])).Stacks?.[0];
  if (!workload || !platform) throw new Error('Beta platform and workload must exist before lifecycle operations');
  const revision = workloadRevision(workload);
  const output = values(platform.Outputs, 'OutputKey', 'OutputValue');
  const workloadOutputs = values(workload.Outputs, 'OutputKey', 'OutputValue');
  const cluster = output.EcsClusterName;
  if (cluster !== 'beta-anywear') throw new Error('Refusing lifecycle changes outside beta-anywear');
  if (![output.BetaActive, workloadOutputs.BetaActive].every(value => ['true', 'false'].includes(value))) throw new Error('Both Beta activity states must be observed');
  const active = workloadOutputs.BetaActive === 'true';
  const platformActive = output.BetaActive === 'true';
  const oneShot = (command, selected = revision) => io.oneShot('lifecycle', selected, command);
  const deploy = (stack, enabled, selected = revision) => io.deploy(stack, enabled, selected);
  const healthy = async (selected = revision) => {
    await io.aws(['ecs', 'wait', 'services-stable', '--cluster', cluster,
      '--services', 'beta-anywear-api', 'beta-anywear-worker']);
    const stack = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', workloadStack])).Stacks[0];
    const outputs = values(stack.Outputs, 'OutputKey', 'OutputValue');
    await io.verifyHealth(outputs.ApiBaseUrl, selected);
    await io.oneShot('verify', selected, outputs.ApiBaseUrl);
  };
  const readAdmissionSuspension = async (operation) => {
    const value = (await io.aws(['ssm', 'get-parameter',
      '--name', '/anywear/beta/admission_suspended'])).Parameter?.Value;
    if (value !== 'true' && value !== 'false') {
      throw new Error(`Beta admission suspension must be a valid boolean before ${operation}`);
    }
    return value;
  };

  if (action === 'start') {
    assertStartStack(platform, 'Platform');
    assertStartStack(workload, 'Workload');
    const startRevision = selectedStartRevision(workload, selectedRevision);
    const priorSuspension = await readAdmissionSuspension('starting');
    if (priorSuspension !== 'true') throw new Error('Stopped Beta admission must be suspended before starting');
    // Network restoration precedes every private task. Intake stays closed
    // through schema verification, workload rollout, and public health checks.
    await deploy(platformStack, true, startRevision);
    await oneShot('close', startRevision);
    await io.oneShot('migrate', startRevision);
    await io.oneShot('verify', startRevision);
    await deploy(workloadStack, true, startRevision);
    await healthy(startRevision);
    await oneShot('close', startRevision);
    return;
  }

  const observe = async () => {
    const state = {};
    for (const [key, name] of [['platform', platformStack], ['workload', workloadStack]]) {
      try {
        const stack = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', name])).Stacks?.[0];
        state[`${key}_active`] = values(stack?.Outputs, 'OutputKey', 'OutputValue').BetaActive ?? 'unavailable';
        state[`${key}_status`] = stack?.StackStatus ?? 'unavailable';
      } catch { state[`${key}_active`] = 'unavailable'; state[`${key}_status`] = 'unavailable'; }
    }
    try { state.admission_suspended = await readAdmissionSuspension('readback'); }
    catch { state.admission_suspended = 'unavailable'; }
    io.recordLifecycleState?.(state);
    return state;
  };
  const fail = async error => {
    const observed = await observe();
    io.recordRecovery?.('requires-explicit-start');
    throw new Error(`Beta shutdown failed; observed Platform=${observed.platform_active} (${observed.platform_status}), Workload=${observed.workload_active} (${observed.workload_status}), admission_suspended=${observed.admission_suspended}; select start separately after review`, { cause: error });
  };
  if (!active || !platformActive) {
    if (active !== platformActive) return fail(new Error('Beta is partially stopped'));
    const observed = await observe();
    if (observed.platform_active !== 'false' || observed.workload_active !== 'false' || observed.admission_suspended !== 'true') return fail(new Error('Stopped Beta admission is not proven closed'));
    return;
  }
  await readAdmissionSuspension('stopping');
  try {
    await oneShot('close');
    // The verified pinned-image close task sets both SSM and DB suspension.
    // Re-read SSM before drain, whose old-image implementation restores its
    // observed prior suspension; an inconsistent close must never reach drain.
    if (await readAdmissionSuspension('draining') !== 'true') throw new Error('Successful pinned close did not prove suspended admission before drain');
    await oneShot('drain');
    await waitForTasks(io, cluster, { servicesAllowed: true });
    await deploy(workloadStack, false);
    await waitForTasks(io, cluster, { servicesAllowed: false });
    await deploy(platformStack, false);
    const observed = await observe();
    if (observed.platform_active !== 'false' || observed.workload_active !== 'false'
      || observed.admission_suspended !== 'true') throw new Error('Stop readback does not prove both stacks stopped with admission closed');
  } catch (error) { await fail(error); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  throw new Error('Use scripts/runtime-operation.mjs with the committed selection');
}
