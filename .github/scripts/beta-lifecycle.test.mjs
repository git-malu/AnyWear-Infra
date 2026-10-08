import assert from 'node:assert/strict';
import test from 'node:test';
import { runBetaLifecycle, waitForTasks } from './beta-lifecycle.mjs';

const platformName = 'AnyWearPlatformStack-beta';
const workloadName = 'AnyWearWorkloadStack-beta';
const apiUrl = 'https://beta-example.cloudfront.net';
const clusterArn = 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear';
const taskArn = (id) => `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${id.toString(16).padStart(32, '0')}`;
const parameters = {
  ServiceImageDigest: `sha256:${'a'.repeat(64)}`,
  ServiceCommitSha: 'b'.repeat(40),
  VlmConfigArn: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:beta-vlm',
  CloudFrontPrefixListId: 'pl-example',
};

function stack(active, workload = false) {
  return {
    StackStatus: 'UPDATE_COMPLETE',
    Parameters: Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
    Outputs: Object.entries({
      BetaActive: String(active),
      ...(workload ? { ApiBaseUrl: apiUrl } : { EcsClusterName: 'beta-anywear' }),
    }).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })),
  };
}

function lifecycleIo({ platformActive = true, workloadActive = true, suspended = 'false', expectedRevision = {
  digest: parameters.ServiceImageDigest, commit: parameters.ServiceCommitSha,
}, stackStatus = 'UPDATE_COMPLETE', fail } = {}) {
  const events = [];
  const revisions = [];
  let time = 0;
  const io = {
    now: () => time,
    async sleep(milliseconds) { time += milliseconds; },
    async aws(args) {
      if (args[0] === 'cloudformation') {
        const workload = args.at(-1) === workloadName;
        const result = stack(workload ? workloadActive : platformActive, workload);
        result.StackStatus = stackStatus;
        return { Stacks: [result] };
      }
      const operation = args.slice(0, 2).join(' ');
      events.push(`${operation}${operation === 'ecs list-tasks' ? ` ${args[args.indexOf('--desired-status') + 1]}` : ''}`);
      if (operation === 'ssm get-parameter') {
        assert.deepEqual(args, ['ssm', 'get-parameter', '--name', '/anywear/beta/admission_suspended']);
        if (fail?.(operation)) throw new Error('SSM suspension read failed');
        return { Parameter: { Value: suspended } };
      }
      if (operation === 'ecs list-tasks') return { taskArns: [] };
      if (operation === 'ecs wait') return {};
      assert.fail(`Unexpected AWS operation: ${args.join(' ')}`);
    },
    async oneShot(role, revision, argument = '') {
      assert.equal(revision.digest, expectedRevision.digest);
      assert.equal(revision.commit, expectedRevision.commit);
      revisions.push({ role, argument, digest: revision.digest, commit: revision.commit });
      const event = `oneShot ${role} ${argument}`.trim();
      events.push(event);
      if (event === 'oneShot lifecycle close') suspended = 'true';
      if (event === 'oneShot lifecycle open') suspended = 'false';
      if (fail?.(event)) throw new Error(event === 'oneShot lifecycle drain'
        ? 'Beta drain exceeded 60 minutes' : 'Injected operation failure');
    },
    async deploy(name, enabled, revision) {
      assert.equal(revision.digest, expectedRevision.digest);
      assert.equal(revision.commit, expectedRevision.commit);
      revisions.push({ role: 'deploy', argument: `deploy ${name} ${enabled}`, digest: revision.digest, commit: revision.commit });
      const event = `deploy ${name} ${enabled}`;
      events.push(event);
      if (fail?.(event)) throw new Error('Injected operation failure');
      if (name === workloadName) workloadActive = enabled; else platformActive = enabled;
    },
    async verifyHealth(url) {
      assert.equal(url, apiUrl);
      events.push('verifyHealth');
    },
  };
  return { io, events, revisions };
}

test('stop failure records actual state and requires separately selected start', async () => {
  const { io, events } = lifecycleIo({ fail: event => event === `deploy ${platformName} false` });
  const states = []; const outcomes = [];
  io.recordRecovery = value => outcomes.push(value); io.recordLifecycleState = value => states.push(value);
  await assert.rejects(runBetaLifecycle('stop', io), /Platform=true.*Workload=false.*admission_suspended=true/);
  assert.deepEqual(outcomes, ['requires-explicit-start']);
  assert.equal(states[0].workload_active, 'false'); assert.equal(states[0].platform_status, 'UPDATE_COMPLETE');
  assert.equal(events.some(event => /^deploy .* true$/.test(event) || event === 'oneShot lifecycle open'), false);
});

test('stop drains and waits for all tasks before removing Beta network egress', async () => {
  const { io, events } = lifecycleIo();
  await runBetaLifecycle('stop', io);
  assert.deepEqual(events, [
    'ssm get-parameter',
    'oneShot lifecycle close', 'ssm get-parameter', 'oneShot lifecycle drain',
    'ecs list-tasks RUNNING', 'ecs list-tasks STOPPED',
    `deploy ${workloadName} false`,
    'ecs list-tasks RUNNING', 'ecs list-tasks STOPPED',
    `deploy ${platformName} false`, 'ssm get-parameter',
  ]);
});

test('drain and deployment failures preserve closed admission and never restart either stack', async () => {
  for (const failedEvent of ['oneShot lifecycle drain', `deploy ${workloadName} false`, `deploy ${platformName} false`]) {
    for (const suspended of ['false', 'true']) {
      const { io, events } = lifecycleIo({ suspended, fail: event => event === failedEvent });
      await assert.rejects(runBetaLifecycle('stop', io), error => {
        assert.match(error.message, /shutdown failed.*admission_suspended=true.*select start separately/);
        assert.ok(error.cause); return true;
      });
      assert.equal(events.some(event => /^deploy .* true$/.test(event) || event === 'oneShot lifecycle open'), false);
      assert.equal(events.at(-1), 'ssm get-parameter');
    }
  }
});
test('native rollback output is reported rather than treated as a successful stopped state', async () => {
  const { io, events } = lifecycleIo(); const deploy = io.deploy;
  io.deploy = async (name, enabled, revision) => { if (name === workloadName) return; await deploy(name, enabled, revision); };
  await assert.rejects(runBetaLifecycle('stop', io), /Platform=false.*Workload=true/);
  assert.equal(events.some(event => /^deploy .* true$/.test(event)), false);
});

test('missing, malformed, or unavailable suspension state aborts stop before any mutation', async () => {
  for (const suspended of [undefined, null, '', 'TRUE', '0', false]) {
    const { io, events } = lifecycleIo({ suspended: suspended ?? null });
    await assert.rejects(runBetaLifecycle('stop', io), /valid boolean before stopping/);
    assert.deepEqual(events, ['ssm get-parameter']);
  }
  const { io, events } = lifecycleIo({ fail: (event) => event === 'ssm get-parameter' });
  await assert.rejects(runBetaLifecycle('stop', io), /SSM suspension read failed/);
  assert.deepEqual(events, ['ssm get-parameter']);
});

test('start restores the network before private tasks and opens intake only after verification', async () => {
  const { io, events } = lifecycleIo({ platformActive: false, workloadActive: false, suspended: 'true' });
  await runBetaLifecycle('start', io, { selectedRevision: { digest: parameters.ServiceImageDigest, commit: parameters.ServiceCommitSha } });
  assert.deepEqual(events, [
    'ssm get-parameter', `deploy ${platformName} true`, 'oneShot lifecycle close', 'oneShot migrate', 'oneShot verify',
    `deploy ${workloadName} true`, 'ecs wait', 'verifyHealth',
    `oneShot verify ${apiUrl}`, 'oneShot lifecycle close',
  ]);
});

test('start preserves a pre-existing admission suspension after verification', async () => {
  const { io, events } = lifecycleIo({ platformActive: false, workloadActive: false, suspended: 'true' });
  await runBetaLifecycle('start', io, { selectedRevision: { digest: parameters.ServiceImageDigest, commit: parameters.ServiceCommitSha } });
  assert.deepEqual(events, [
    'ssm get-parameter', `deploy ${platformName} true`, 'oneShot lifecycle close', 'oneShot migrate', 'oneShot verify',
    `deploy ${workloadName} true`, 'ecs wait', 'verifyHealth',
    `oneShot verify ${apiUrl}`, 'oneShot lifecycle close',
  ]);
});

test('start rejects an unavailable admission state before mutating infrastructure', async () => {
  const { io, events } = lifecycleIo({ platformActive: false, workloadActive: false,
    fail: (event) => event === 'ssm get-parameter' });
  await assert.rejects(runBetaLifecycle('start', io, { selectedRevision: { digest: parameters.ServiceImageDigest, commit: parameters.ServiceCommitSha } }), /SSM suspension read failed/);
  assert.deepEqual(events, ['ssm get-parameter']);
});

test('failed start verification never opens intake', async () => {
  const { io, events } = lifecycleIo({ platformActive: false, workloadActive: false, suspended: 'true',
    fail: (event) => event === `oneShot verify ${apiUrl}` });
  await assert.rejects(runBetaLifecycle('start', io, { selectedRevision: { digest: parameters.ServiceImageDigest, commit: parameters.ServiceCommitSha } }), /Injected operation failure/);
  assert.ok(!events.includes('oneShot lifecycle open'));
});

test('start hands the reviewed selection to every lifecycle and deployment action', async () => {
  const selected = { digest: `sha256:${'c'.repeat(64)}`, commit: 'd'.repeat(40) };
  const { io, events, revisions } = lifecycleIo({ platformActive: false, workloadActive: false, suspended: 'true', expectedRevision: selected });
  await runBetaLifecycle('start', io, { selectedRevision: selected });
  assert.deepEqual(revisions.map(({ role, argument, digest, commit }) => ({ role, argument, digest, commit })), [
    { role: 'deploy', argument: `deploy ${platformName} true`, ...selected },
    { role: 'lifecycle', argument: 'close', ...selected },
    { role: 'migrate', argument: '', ...selected },
    { role: 'verify', argument: '', ...selected },
    { role: 'deploy', argument: `deploy ${workloadName} true`, ...selected },
    { role: 'verify', argument: apiUrl, ...selected },
    { role: 'lifecycle', argument: 'close', ...selected },
  ]);
  assert.equal(events.at(-1), 'oneShot lifecycle close');
});

test('start requires inactive terminal stacks and suspended admission before mutation', async () => {
  const selected = { digest: parameters.ServiceImageDigest, commit: parameters.ServiceCommitSha };
  for (const [platformActive, workloadActive, stackStatus, error] of [
    [true, false, 'UPDATE_COMPLETE', /Platform stack must be inactive/],
    [false, true, 'UPDATE_COMPLETE', /Workload stack must be inactive/],
    [false, false, 'UPDATE_IN_PROGRESS', /Platform stack is not terminal/],
  ]) {
    const { io, events } = lifecycleIo({ platformActive, workloadActive, suspended: 'true', stackStatus });
    await assert.rejects(runBetaLifecycle('start', io, { selectedRevision: selected }), error);
    assert.equal(events.some((event) => event.startsWith('deploy ') || event.startsWith('oneShot ')), false);
  }
  const { io, events } = lifecycleIo({ platformActive: false, workloadActive: false, suspended: 'false' });
  await assert.rejects(runBetaLifecycle('start', io, { selectedRevision: selected }), /admission must be suspended/);
  assert.equal(events.some((event) => event.startsWith('deploy ') || event.startsWith('oneShot ')), false);
});

test('stop keeps the observed workload revision even when a selected start revision is supplied', async () => {
  const selected = { digest: `sha256:${'c'.repeat(64)}`, commit: 'd'.repeat(40) };
  const { io, revisions } = lifecycleIo({ suspended: 'false' });
  await runBetaLifecycle('stop', io, { selectedRevision: selected });
  assert.ok(revisions.length > 0);
  assert.ok(revisions.every(({ digest, commit }) => digest === parameters.ServiceImageDigest && commit === parameters.ServiceCommitSha));
});

test('an already stopped Beta is an idempotent no-op', async () => {
  const { io, events } = lifecycleIo({ platformActive: false, workloadActive: false, suspended: 'true' });
  await runBetaLifecycle('stop', io);
  assert.deepEqual(events, ['ssm get-parameter']);
});

test('stop rejects inconsistent platform and workload state before mutating anything', async () => {
  for (const [platformActive, workloadActive] of [[false, true], [true, false]]) {
    const { io, events } = lifecycleIo({ platformActive, workloadActive });
    await assert.rejects(runBetaLifecycle('stop', io), /shutdown failed/);
    assert.deepEqual(events, ['ssm get-parameter']);
  }
});

test('lifecycle rejects invalid actions and clusters outside Beta', async () => {
  const { io, events } = lifecycleIo();
  await assert.rejects(runBetaLifecycle('prod', io), /action must be start or stop/);
  io.aws = async (args) => {
    if (args.at(-1) === workloadName) return { Stacks: [stack(true, true)] };
    const platform = stack(true);
    platform.Outputs.find((output) => output.OutputKey === 'EcsClusterName').OutputValue = 'prod-anywear';
    return { Stacks: [platform] };
  };
  await assert.rejects(runBetaLifecycle('stop', io), /outside beta-anywear/);
  assert.deepEqual(events, []);
});

test('wait sees a one-shot task with desired STOPPED until lastStatus becomes STOPPED', async () => {
  let time = 0;
  let sleeps = 0;
  const statuses = [];
  const io = {
    now: () => time,
    async sleep(milliseconds) { time += milliseconds; sleeps += 1; },
    async aws(args) {
      if (args[1] === 'list-tasks') {
        const desired = args[args.indexOf('--desired-status') + 1];
        statuses.push(desired);
        return { taskArns: desired === 'STOPPED' ? [taskArn(1)] : [] };
      }
      return { tasks: [{ taskArn: taskArn(1), clusterArn, group: 'family:beta-anywear-lifecycle',
        lastStatus: sleeps === 0 ? 'STOPPING' : 'STOPPED' }] };
    },
  };
  await waitForTasks(io, 'beta-anywear', { servicesAllowed: true });
  assert.equal(sleeps, 1);
  assert.deepEqual(statuses, ['RUNNING', 'STOPPED', 'RUNNING', 'STOPPED']);
});

test('wait paginates both desired states, deduplicates ARNs, and describes at most 100 tasks per batch', async () => {
  const arns = Array.from({ length: 205 }, (_, index) => taskArn(index));
  const pages = {
    RUNNING: [{ taskArns: arns.slice(0, 100), nextToken: 'running-2' }, { taskArns: arns.slice(100, 110) }],
    STOPPED: [{ taskArns: arns.slice(100, 200), nextToken: 'stopped-2' }, { taskArns: arns.slice(200) }],
  };
  const pageCalls = [];
  const batches = [];
  const io = {
    now: () => 0,
    async sleep() { assert.fail('All tasks are already stopped'); },
    async aws(args) {
      if (args[1] === 'list-tasks') {
        const desired = args[args.indexOf('--desired-status') + 1];
        const page = args.includes('--next-token') ? 1 : 0;
        assert.ok(args.includes('--no-paginate'));
        assert.equal(args[args.indexOf('--max-results') + 1], '100');
        if (page === 1) assert.equal(args[args.indexOf('--next-token') + 1], pages[desired][0].nextToken);
        pageCalls.push(`${desired}-${page}`);
        return pages[desired][page];
      }
      const batch = args.slice(args.indexOf('--tasks') + 1);
      batches.push(batch);
      return { tasks: batch.map((taskArn) => ({ taskArn, clusterArn, group: 'family:beta-anywear-lifecycle', lastStatus: 'STOPPED' })) };
    },
  };
  await waitForTasks(io, 'beta-anywear', { servicesAllowed: false });
  assert.deepEqual(pageCalls, ['RUNNING-0', 'RUNNING-1', 'STOPPED-0', 'STOPPED-1']);
  assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 5]);
  assert.deepEqual(batches.flat(), arns);
});

test('running API and worker services are allowed only before the workload stop', async () => {
  let time = 0;
  const io = {
    now: () => time,
    async sleep(milliseconds) { time += milliseconds; },
    async aws(args) {
      if (args[1] === 'list-tasks') {
        const desired = args[args.indexOf('--desired-status') + 1];
        return { taskArns: desired === 'RUNNING' ? [taskArn(1), taskArn(2)] : [] };
      }
      return { tasks: [
        { taskArn: taskArn(1), clusterArn, group: 'service:beta-anywear-api', lastStatus: 'RUNNING' },
        { taskArn: taskArn(2), clusterArn, group: 'service:beta-anywear-worker', lastStatus: 'STOPPING' },
      ] };
    },
  };
  await waitForTasks(io, 'beta-anywear', { servicesAllowed: true });
  assert.equal(time, 0);
  await assert.rejects(waitForTasks(io, 'beta-anywear', { servicesAllowed: false, timeoutMs: 10_000 }), /shutdown aborted/);
  assert.equal(time, 10_000);
});

test('a stopping one-shot that exceeds the wait deadline aborts shutdown', async () => {
  const { io } = lifecycleIo();
  io.aws = async (args) => args[1] === 'list-tasks'
    ? { taskArns: args[args.indexOf('--desired-status') + 1] === 'STOPPED' ? [taskArn(1)] : [] }
    : { tasks: [{ taskArn: taskArn(1), clusterArn, lastStatus: 'STOPPING', group: 'family:beta-anywear-migrate' }] };
  await assert.rejects(waitForTasks(io, 'beta-anywear', { servicesAllowed: true, timeoutMs: 10_000 }), /shutdown aborted/);
  assert.equal(io.now(), 10_000);
});

test('task lookup failures and omitted task results fail closed', async () => {
  for (const result of [{ failures: [{ arn: 'missing' }] }, { tasks: [] }]) {
    const io = {
      now: () => 0,
      async sleep() { assert.fail('Lookup errors must abort immediately'); },
      async aws(args) { return args[1] === 'list-tasks' ? { taskArns: [taskArn(1)] } : result; },
    };
    await assert.rejects(waitForTasks(io, 'beta-anywear', { servicesAllowed: false }), /identify every Beta ECS task/);
  }
});

test('missing, malformed, oversized, or foreign task inventories fail closed in either desired state', async () => {
  const invalid = [undefined, null, {}, { taskArns: null }, { taskArns: 'invalid' },
    { taskArns: [null] }, { taskArns: [1] }, { taskArns: ['task-1'] },
    { taskArns: [taskArn(1).replace('ap-east-1', 'us-east-1')] },
    { taskArns: [taskArn(1).replace('650880818323', '123456789012')] },
    { taskArns: [taskArn(1).replace('beta-anywear/', 'prod-anywear/')] },
    { taskArns: [taskArn(1).slice(0, -1)] }, { taskArns: Array.from({ length: 101 }, (_, id) => taskArn(id)) }];
  for (const desiredStatus of ['RUNNING', 'STOPPED']) {
    for (const listing of invalid) {
      const io = { now: () => 0,
        async sleep() { assert.fail('Invalid inventory must abort immediately'); },
        async aws(args) {
          assert.equal(args[1], 'list-tasks');
          return args[args.indexOf('--desired-status') + 1] === desiredStatus ? listing : { taskArns: [] };
        } };
      await assert.rejects(waitForTasks(io, 'beta-anywear', { servicesAllowed: true }), /malformed Beta ECS task inventory/);
    }
  }
});

test('invalid pagination tokens and token cycles fail closed in either desired state', async () => {
  for (const desiredStatus of ['RUNNING', 'STOPPED']) {
    for (const tokens of [[null], [''], [' '], [1], [false], [{}], [[]], ['x'.repeat(4097)],
      ['new\nline'], ['repeat', 'repeat'], ['first', 'second', 'first']]) {
      let calls = 0;
      const io = { now: () => 0,
        async sleep() { assert.fail('Invalid pagination must abort immediately'); },
        async aws(args) {
          assert.equal(args[1], 'list-tasks');
          if (args[args.indexOf('--desired-status') + 1] !== desiredStatus) return { taskArns: [] };
          assert.ok(calls < tokens.length, 'Pagination must not continue past the invalid token');
          return { taskArns: [], nextToken: tokens[calls++] };
        } };
      await assert.rejects(waitForTasks(io, 'beta-anywear', { servicesAllowed: false }), /pagination token/);
      assert.equal(calls, tokens.length);
    }
  }
});

test('pagination with distinct tokens is bounded even when the clock does not advance', async () => {
  for (const desiredStatus of ['RUNNING', 'STOPPED']) {
    let calls = 0;
    const io = { now: () => 0,
      async sleep() { assert.fail('Incomplete pagination must abort immediately'); },
      async aws(args) {
        assert.equal(args[1], 'list-tasks');
        if (args[args.indexOf('--desired-status') + 1] !== desiredStatus) return { taskArns: [] };
        return { taskArns: [], nextToken: `page-${++calls}` };
      } };
    await assert.rejects(waitForTasks(io, 'beta-anywear', { servicesAllowed: false }), /pagination did not complete within its bound/);
    assert.equal(calls, 100);
  }
});

test('pagination cannot continue after the existing wait deadline', async () => {
  let now = 0;
  let calls = 0;
  const io = { now: () => now,
    async sleep() { assert.fail('Expired pagination must abort immediately'); },
    async aws() { now = 10_000; calls += 1; return { taskArns: [], nextToken: 'next-page' }; } };
  await assert.rejects(waitForTasks(io, 'beta-anywear', { servicesAllowed: false, timeoutMs: 10_000 }), /pagination did not complete within its bound/);
  assert.equal(calls, 1);
});

test('task descriptions must match the exact requested identities, cluster, status and group', async () => {
  const first = { taskArn: taskArn(1), clusterArn, group: 'family:beta-anywear-lifecycle', lastStatus: 'STOPPED' };
  const second = { ...first, taskArn: taskArn(2) };
  const invalid = [undefined, null, {}, { tasks: null }, { tasks: {} }, { tasks: [first] },
    { tasks: [first, first] }, { tasks: [first, second, { ...first, taskArn: taskArn(3) }] },
    { tasks: [null, second] }, { tasks: [{ ...first, taskArn: taskArn(3) }, second] },
    { tasks: [{ ...first, clusterArn: undefined }, second] },
    { tasks: [{ ...first, clusterArn: clusterArn.replace('beta-anywear', 'prod-anywear') }, second] },
    ...[undefined, null, '', 'UNKNOWN', 1].map((lastStatus) => ({ tasks: [{ ...first, lastStatus }, second] })),
    ...[undefined, null, '', 1, 'x'.repeat(256)].map((group) => ({ tasks: [{ ...first, group }, second] })),
    ...[null, {}, 'invalid', [{ arn: taskArn(1), reason: 'MISSING' }]].map((failures) => ({ tasks: [first, second], failures }))];
  for (const result of invalid) {
    const io = { now: () => 0,
      async sleep() { assert.fail('Invalid task descriptions must abort immediately'); },
      async aws(args) { return args[1] === 'list-tasks' ? { taskArns: [taskArn(1), taskArn(2)] } : result; } };
    await assert.rejects(waitForTasks(io, 'beta-anywear', { servicesAllowed: true }), /identify every Beta ECS task/);
  }
});

test('task inventory rejects a different cluster before any AWS call', async () => {
  const io = { async aws() { assert.fail('Unexpected cluster must not be queried'); } };
  await assert.rejects(waitForTasks(io, 'prod-anywear', { servicesAllowed: false }), /expected Beta cluster/);
});

test('valid task descriptions may be reordered and only STOPPED satisfies the existing terminal rule', async () => {
  for (const lastStatus of ['PROVISIONING', 'PENDING', 'ACTIVATING', 'RUNNING', 'DEACTIVATING',
    'STOPPING', 'DEPROVISIONING', 'STOPPED']) {
    const io = { now: () => 0,
      async sleep() { assert.fail('Zero timeout must not sleep'); },
      async aws(args) {
        if (args[1] === 'list-tasks') return { taskArns: [taskArn(1), taskArn(2)] };
        return { failures: [], tasks: [2, 1].map((id) => ({ taskArn: taskArn(id), clusterArn,
          group: 'family:beta-anywear-lifecycle', lastStatus })) };
      } };
    const wait = waitForTasks(io, 'beta-anywear', { servicesAllowed: false, timeoutMs: 0 });
    if (lastStatus === 'STOPPED') await wait;
    else await assert.rejects(wait, /shutdown aborted/);
  }
});

test('invalid task inventory aborts stop before CDK and keeps admission closed', async () => {
  for (const suspended of ['false', 'true']) {
    const { io, events } = lifecycleIo({ suspended });
    const aws = io.aws;
    io.aws = async (args) => {
      const result = await aws(args);
      return args[0] === 'ecs' && args[1] === 'list-tasks' ? {} : result;
    };
    await assert.rejects(runBetaLifecycle('stop', io), (error) => {
      assert.match(error.message, /shutdown failed/);
      assert.match(error.cause.message, /malformed Beta ECS task inventory/);
      return true;
    });
    assert.ok(!events.some((event) => event.startsWith('deploy ')));
    assert.equal(events.at(-1), 'ssm get-parameter');
    assert.equal(events.includes('oneShot lifecycle open'), false);
  }
});

test('a successful close with false or unavailable suspension readback never drains or changes infrastructure', async () => {
  for (const closedState of ['false', 'invalid', undefined]) {
    const { io, events } = lifecycleIo(); const aws = io.aws; const oneShot = io.oneShot; let closed = false;
    io.oneShot = async (...args) => { await oneShot(...args); if (args[2] === 'close') closed = true; };
    io.aws = async args => { const result = await aws(args); return closed && args[0] === 'ssm' ? { Parameter: { Value: closedState } } : result; };
    await assert.rejects(runBetaLifecycle('stop', io), /shutdown failed/);
    assert.equal(events.includes('oneShot lifecycle drain'), false);
    assert.equal(events.some(event => event.startsWith('deploy ') || event === 'oneShot lifecycle open'), false);
  }
});
