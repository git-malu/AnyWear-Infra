import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { runAuthorizationPreflight, AuthorizationPreflightError, simulationRequests, SIMULATION_SKIPS,
  PREFLIGHT_MARKER, preflightActionSet } from './authorization-preflight.mjs';
import { sessionPolicy, reads } from './operation-boundaries.mjs';
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
  const expectedPairs = Object.keys(reads).filter((pair) => !(pair in SIMULATION_SKIPS)).sort();
  assert.deepEqual(runtimePairs, expectedPairs);
  for (const request of runtime) {
    assert.equal(request.actions.includes(reads[request.pair]), true);
    for (const action of request.actions) {
      assert.equal(declaredCovers('beta-infra-runtime-role', action), true, `${action} is declared`);
    }
  }
  const deploy = simulationRequests('deploy', env, 'operation');
  assert.deepEqual(deploy.map((request) => request.pair), ['cloudformation/describe-stacks',
    'ssm/get-parameter', 'ec2/describe-managed-prefix-lists']);
  for (const request of deploy) for (const action of request.actions) {
    assert.equal(declaredCovers('beta-infra-deploy-role', action), true, `${action} is declared`);
  }
  // Every plan action is also granted by the session policy the preflight runs under.
  const sessionActions = new Set(JSON.parse(sessionPolicy('runtime', env, 'operation'))
    .Statement.flatMap((statement) => [statement.Action].flat()));
  for (const action of preflightActionSet('runtime', env, 'operation')) {
    assert.equal(sessionActions.has(action), true, `${action} is in the runtime session policy`);
  }
  assert.deepEqual(Object.keys(SIMULATION_SKIPS).sort(), ['cloudfront/get-distribution',
    'ecr/batch-get-image', 'sts/get-caller-identity']);
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
