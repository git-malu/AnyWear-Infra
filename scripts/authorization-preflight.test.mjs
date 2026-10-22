import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { runAuthorizationPreflight, AuthorizationPreflightError, simulationRequests, SIMULATION_SKIPS,
  PREFLIGHT_MARKER, preflightActionSet, CONTEXT_ENTRIES } from './authorization-preflight.mjs';
import { sessionPolicy, reads, readOperations, workflowOperations } from './operation-boundaries.mjs';
import { createRuntimeIo } from './runtime-operation.mjs';

// The pre-mutation preflight's contract (#165): the simulation plan comes from the
// reviewed reads table, both the base policies and the generated session policy
// must allow every read, a missing action stops the operation before mutation, and
// the simulator's own session/actions are excluded from the observed layer.

const DECLARATION = JSON.parse(readFileSync(new URL('../test/fixtures/authorization-declared.json', import.meta.url), 'utf8'));
const operationEnvironment = (operation, workflow = 'mutate') => ({ GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra',
  GITHUB_REPOSITORY_ID: '1409047265', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40),
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: `git-malu/AnyWear-Infra/.github/workflows/${workflow}.yml@refs/heads/main`,
  GITHUB_RUN_ID: '39100318242', GITHUB_RUN_ATTEMPT: '1', ENABLE_BETA_MUTATION: 'true',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', INFRA_IDENTITY_PHASE: 'retired',
  INFRA_RETENTION_PROTECTION: 'true', INFRA_OPERATION: operation, TESTER_EMAILS: '[]' });

const declaredCovers = (role, action) => (DECLARATION.roles[role] ?? []).some((entry) => entry === action
  || entry === '*' || (entry.endsWith(':*') && action.startsWith(`${entry.slice(0, -1)}`)));

const simulation = ({ denyAction } = {}) => async (command, args) => {
  if (command !== 'aws') throw new Error(`unexpected command ${command}`);
  // The driver prefixes the service (`iam`) before the simulation subcommand; a
  // direct call carries the subcommand first.
  const offset = args[0] === 'iam' ? 1 : 0;
  const subcommand = args[offset];
  if (subcommand !== 'simulate-principal-policy' && subcommand !== 'simulate-custom-policy') {
    throw new Error(`unexpected aws call ${args.join(' ')}`);
  }
  const actions = args.slice(args.indexOf('--action-names', offset) + 1, args.indexOf('--resource-arns', offset));
  const resources = args.slice(args.indexOf('--resource-arns', offset) + 1, args.indexOf('--context-entries', offset));
  const results = [];
  for (const action of actions.filter((value) => value.includes(':'))) {
    for (const resource of resources.filter((value) => value.includes(':') || value === '*')) {
      results.push({ EvalActionName: action, EvalResourceName: resource,
        EvalDecision: action === denyAction ? 'implicitDeny' : 'allowed' });
    }
  }
  return { stdout: JSON.stringify({ EvaluationResults: results }) };
};

const failingSimulation = (stderr) => async () => {
  const error = new Error('command failed');
  error.stderr = stderr;
  throw error;
};

test('the plan comes from the reviewed reads table and stays inside the declared grants', () => {
  const env = operationEnvironment('migrate');
  const runtime = simulationRequests('runtime', env, 'operation');
  const runtimePairs = runtime.map((request) => request.pair).sort();
  const expectedPairs = Object.keys(reads).filter((pair) => !(pair in SIMULATION_SKIPS)
    && !(pair in readOperations)).sort();
  assert.deepEqual(runtimePairs, expectedPairs);
  for (const request of runtime) {
    assert.equal(request.actions.includes(reads[request.pair]), true);
    for (const action of request.actions) {
      assert.equal(declaredCovers('beta-infra-runtime-role', action), true, `${action} is declared`);
    }
  }
  // `deploy-runtime` runs the bake, so its plan is every reviewed read, skips aside.
  const bake = simulationRequests('runtime', operationEnvironment('deploy-runtime'), 'operation');
  assert.deepEqual(bake.map((request) => request.pair).sort(),
    Object.keys(reads).filter((pair) => !(pair in SIMULATION_SKIPS)).sort());
  for (const request of bake) for (const action of request.actions) {
    assert.equal(declaredCovers('beta-infra-runtime-role', action), true, `${action} is declared`);
  }
  const deploy = simulationRequests('deploy', env, 'operation');
  assert.deepEqual(deploy.map((request) => request.pair), ['cloudformation/describe-stacks',
    'ssm/get-parameter', 'ec2/describe-managed-prefix-lists']);
  for (const request of deploy) for (const action of request.actions) {
    assert.equal(declaredCovers('beta-infra-deploy-role', action), true, `${action} is declared`);
  }
  // Every plan action is also granted by the session policy the preflight runs under,
  // for the operation that runs the bake and for one that does not.
  for (const operation of ['migrate', 'deploy-runtime']) {
    const opEnv = operationEnvironment(operation);
    const sessionActions = new Set(JSON.parse(sessionPolicy('runtime', opEnv, 'operation'))
      .Statement.flatMap((statement) => [statement.Action].flat()));
    for (const action of preflightActionSet('runtime', opEnv, 'operation')) {
      assert.equal(sessionActions.has(action), true, `${operation}: ${action} is in the runtime session policy`);
    }
  }
  assert.deepEqual(Object.keys(SIMULATION_SKIPS).sort(), ['cloudfront/get-distribution', 'ecr/batch-get-image',
    'ecr/describe-images', 'ecr/get-lifecycle-policy', 'ecr/get-lifecycle-policy-preview',
    'ecr/start-lifecycle-policy-preview', 'ecs/register-task-definition', 'ecs/run-task', 'ecs/wait',
    'logs/get-log-events', 'logs/put-retention-policy', 'sts/get-caller-identity']);
});

// Issue #195: the runtime session's plan, its session policy and its call
// allow-list are scoped to the reads the dispatched operation performs. The bake
// reads are Platform-installed grants, so requiring them from every operation
// would leave the Platform deploy — the operation that installs them — blocked.
test('only deploy-runtime simulates and is granted the bake reads', () => {
  const operations = Object.values(workflowOperations).flat();
  assert.equal(operations.length, 16);
  const bakeReads = ['cloudwatch/get-metric-statistics', 'cloudwatch/describe-alarms', 'logs/filter-log-events'];
  assert.deepEqual(Object.keys(readOperations).sort(), [...bakeReads].sort());
  for (const pair of bakeReads) {
    assert.ok(pair in reads, `${pair} is a reviewed read`);
    assert.deepEqual(readOperations[pair], ['deploy-runtime']);
  }
  for (const operation of operations) {
    const workflow = ['state', 'observe'].includes(operation) ? 'runtime' : 'mutate';
    const env = operationEnvironment(operation, workflow);
    const plan = new Set(simulationRequests('runtime', env, 'operation').map((request) => request.pair));
    const sessionActions = new Set(JSON.parse(sessionPolicy('runtime', env, 'operation'))
      .Statement.flatMap((statement) => [statement.Action].flat()));
    for (const pair of bakeReads) {
      assert.equal(plan.has(pair), operation === 'deploy-runtime', `${operation}: ${pair} in the plan`);
      assert.equal(sessionActions.has(reads[pair]), operation === 'deploy-runtime',
        `${operation}: ${reads[pair]} in the session policy`);
    }
    // The universal reads stay in every operation's plan.
    assert.equal(plan.has('ssm/get-parameters'), true, `${operation}: the stage-contract read remains`);
    assert.equal(plan.has('cloudformation/describe-stacks'), true, `${operation}: the stack read remains`);
  }
});

test('the preflight passes when both the base policies and the session policy allow every read', async () => {
  const result = await runAuthorizationPreflight({ sessions: ['runtime', 'deploy'],
    env: operationEnvironment('deploy-platform'), purpose: 'operation',
    assume: async () => ({ AWS_ACCESS_KEY_ID: 'x' }), run: simulation({}) });
  assert.equal(result.result, 'permitted');
  assert.equal(result.session_marker, PREFLIGHT_MARKER);
  assert.ok(result.evaluations.length > 10);
  assert.ok(result.evaluations.every((entry) => entry.evaluations >= 2));
});

test('a missing base grant fails closed before any mutation', async () => {
  const calls = [];
  const deny = async (command, args) => {
    calls.push({ command, args });
    if (command !== 'aws') throw new Error('a mutation must not run');
    return simulation({ denyAction: 'logs:DescribeLogGroups' })(command, args);
  };
  const io = await createRuntimeIo(operationEnvironment('migrate'), undefined, {
    purpose: 'operation', assume: async () => ({ AWS_ACCESS_KEY_ID: 'x' }), run: deny,
  });
  await assert.rejects(io.oneShot('migrate', { digest: `sha256:${'a'.repeat(64)}`, commit: 'b'.repeat(40) }),
    (error) => {
      assert.ok(error instanceof AuthorizationPreflightError);
      assert.equal(error.denial, true);
      assert.equal(error.reason, 'denied');
      assert.match(error.message, /logs:DescribeLogGroups/);
      return true;
    });
  assert.equal(calls.some((call) => call.command === 'bash'), false, 'the task script must not run');
});

test('a denied Egress destroy stops before npx cdk destroy', async () => {
  const calls = [];
  const deny = async (command, args) => {
    calls.push({ command, args });
    if (command !== 'aws') throw new Error('a mutation must not run');
    return simulation({ denyAction: 'cloudformation:DescribeStacks' })(command, args);
  };
  const io = await createRuntimeIo(operationEnvironment('delete-egress'), undefined, {
    purpose: 'operation', assume: async () => ({ AWS_ACCESS_KEY_ID: 'x' }), run: deny,
  });
  await assert.rejects(io.destroy('AnyWearEgressStack-beta'), (error) => error.denial === true);
  assert.equal(calls.some((call) => call.command === 'npx'), false);
});

// Issue #195's counter-check: scoping the plan must not weaken the one operation
// that performs the bake. `deploy-runtime` still simulates both bake reads under
// the runtime session and stops before the change set is created.
test('deploy-runtime still fails closed when the runtime role denies a bake read', async () => {
  const env = { ...operationEnvironment('deploy-runtime'), INFRA_IDENTITY_PHASE: 'roles-added',
    SERVICE_RELEASE_TAG: 'service-artifacts-4f2ba555', SERVICE_COMMIT: '4f2ba555'.padEnd(40, '0') };
  for (const denied of ['cloudwatch:DescribeAlarms', 'logs:FilterLogEvents']) {
    const calls = [];
    const deny = async (command, args) => {
      calls.push({ command, args });
      if (command !== 'aws') throw new Error('a mutation must not run');
      return simulation({ denyAction: denied })(command, args);
    };
    const io = await createRuntimeIo(env, undefined, {
      purpose: 'operation', assume: async () => ({ AWS_ACCESS_KEY_ID: 'x' }), run: deny });
    await assert.rejects(io.deployRuntimeChangeSet(
      { args: ['cdk', 'deploy', 'AnyWearRuntimeStack-beta', '--no-execute'] }), (error) => {
      assert.ok(error instanceof AuthorizationPreflightError);
      assert.equal(error.kind, 'runtime');
      assert.equal(error.denial, true);
      assert.match(error.message, new RegExp(denied));
      return true;
    });
    assert.equal(calls.some((call) => call.command === 'npx'), false, 'the change set must not be created');
  }
});

test('a simulator API error is classified apart from a denial', async () => {
  await assert.rejects(runAuthorizationPreflight({ sessions: ['runtime'],
    env: operationEnvironment('migrate'), purpose: 'operation',
    assume: async () => ({ AWS_ACCESS_KEY_ID: 'x' }),
    run: failingSimulation('An error occurred (AccessDenied) when calling the SimulatePrincipalPolicy operation') }),
  (error) => {
    assert.equal(error.reason, 'simulator-denied');
    assert.equal(error.denial, true);
    return true;
  });
  await assert.rejects(runAuthorizationPreflight({ sessions: ['runtime'],
    env: operationEnvironment('migrate'), purpose: 'operation',
    assume: async () => ({ AWS_ACCESS_KEY_ID: 'x' }),
    run: failingSimulation('An error occurred (NoSuchEntity) when calling the SimulateCustomPolicy operation') }),
  (error) => {
    assert.equal(error.reason, 'simulator-error');
    assert.equal(error.denial, false);
    return true;
  });
});

test('the preflight runs under a marked session and its simulator events are excluded', async () => {
  const assumed = [];
  await runAuthorizationPreflight({ sessions: ['runtime'], env: operationEnvironment('migrate'),
    purpose: 'operation', assume: async (kind, _env, _purpose, options) => {
      assumed.push({ kind, marker: options.sessionMarker });
      return { AWS_ACCESS_KEY_ID: 'x' };
    }, run: simulation({}) });
  assert.deepEqual(assumed, [{ kind: 'runtime', marker: PREFLIGHT_MARKER }]);
});

test('every simulator context entry uses a valid context-key type', () => {
  // Run 39726665630: the simulator rejected ContextKeyType 'arn' (it has no ARN
  // type), so the preflight failed before any mutation. The CLI mock never
  // validated the enum; this test pins it.
  const allowed = new Set(['binary', 'ipList', 'booleanList', 'ip', 'boolean', 'numericList',
    'dateList', 'numeric', 'date', 'stringList', 'string', 'binaryList']);
  for (const entry of CONTEXT_ENTRIES) {
    assert.ok(allowed.has(entry.ContextKeyType),
      `${entry.ContextKeyName} uses ${entry.ContextKeyType}, which the simulator rejects`);
    assert.notEqual(entry.ContextKeyType, 'arn');
  }
  const cluster = CONTEXT_ENTRIES.find((entry) => entry.ContextKeyName === 'ecs:cluster');
  assert.ok(cluster, 'ecs:cluster must be supplied');
  assert.equal(cluster.ContextKeyType, 'string');
  assert.deepEqual(cluster.ContextKeyValues,
    ['arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear']);
});

test('account-level actions simulate on * and resource-level actions stay concrete', () => {
  // Run 39732059192: ecs:DescribeTaskDefinition has no resource-level support, so a
  // concrete task-definition ARN is an implicit deny even when the policy allows
  // the action on *. Pin the known account-level actions and keep the rest concrete.
  const noResource = new Set(['ecs:DescribeTaskDefinition', 'ecs:ListTasks',
    'ec2:DescribeManagedPrefixLists', 'logs:DescribeLogGroups', 'cloudwatch:GetMetricStatistics']);
  const plan = [...simulationRequests('runtime', operationEnvironment('deploy-runtime')), ...simulationRequests('deploy', {})];
  const seen = new Set();
  for (const request of plan) {
    for (const action of request.actions) {
      if (noResource.has(action)) {
        seen.add(action);
        assert.deepEqual(request.resources, ['*'], `${action} must simulate on *`);
      } else {
        assert.ok(!(request.resources.length === 1 && request.resources[0] === '*'),
          `${action} has resource-level support and must simulate a concrete form`);
      }
    }
  }
  assert.deepEqual([...seen].sort(), [...noResource].sort());
  const taskDefinition = plan.find((request) => request.pair === 'ecs/describe-task-definition');
  assert.deepEqual(taskDefinition.resources, ['*']);
  const logGroups = plan.find((request) => request.pair === 'logs/describe-log-groups');
  assert.deepEqual(logGroups.resources, ['*']);
});

test('the simulator-unevaluable log-stream read is skipped and the rest of the runtime plan remains', () => {
  // Read-only validation at e3d2854: every log-group:...:log-stream:... form returns
  // implicitDeny in the simulator, even under the session policy that grants the
  // action on *. The reviewed grant is on log-stream ARNs, so the plan skips it.
  const reason = SIMULATION_SKIPS['logs/get-log-events'];
  assert.ok(reason, 'logs/get-log-events must be a reviewed skip');
  assert.match(reason, /log-stream ARNs/);
  assert.match(reason, /implicitDeny/);
  assert.match(reason, /form probes 2026-10-22/);
  const plan = simulationRequests('runtime', operationEnvironment('deploy-runtime'));
  const pairs = plan.map((request) => request.pair).sort();
  assert.ok(!pairs.includes('logs/get-log-events'));
  assert.equal(plan.length, 15);
  assert.deepEqual(pairs, ['cloudformation/describe-stacks', 'cloudformation/get-template',
    'cloudformation/list-stack-resources', 'cloudwatch/describe-alarms', 'cloudwatch/get-metric-statistics',
    'ecs/describe-services', 'ecs/describe-task-definition', 'ecs/describe-tasks', 'ecs/list-tasks',
    'lambda/get-function', 'logs/describe-log-groups', 'logs/filter-log-events',
    'sqs/get-queue-attributes', 'ssm/get-parameter', 'ssm/get-parameters']);
});

test('production.yml pins the app-token attestations read it needs', async () => {
  // The batch failure: a release-verifying path read the attestation API without
  // the attestations scope. Infra mints an app token for that read, so the input
  // is the declaration; no test pinned it before this one.
  const source = await readFile(new URL('../.github/workflows/production.yml', import.meta.url), 'utf8');
  const { load } = await import('js-yaml');
  const workflow = load(source);
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  const token = steps.find((step) => String(step.uses ?? '').startsWith('actions/create-github-app-token@'));
  assert.ok(token, 'production.yml must mint the reviewed app token');
  assert.equal(token.with['permission-attestations'], 'read');
  assert.equal(token.with['permission-contents'], 'read');
  assert.equal(token.with['permission-actions'], 'read');
});
