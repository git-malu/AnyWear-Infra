import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAuthorizationSurface, PINNED_SURFACE, nonCoverageList, CREDENTIAL_PATHS, CANARY_MARKER,
  canaryPlan, classifyAwsFailure, IAM_ACTIONS, NON_DERIVED_REVIEWED_OPERATIONS, OBSERVED_SURFACE } from './authorization-inventory.mjs';
import { reconcileObserved, buildObservedRecord, validateObservedRecord, assertObservedDeclared,
  assertObservationWindow, isCanaryInvocation, eventAction } from './authorization-observed.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const cloudTrailEvent = (role, action, { session = 'infra-runtime-123', time = '2026-10-20T12:00:00Z' } = {}) => {
  const [service, name] = action.split(':');
  return { EventTime: time, EventSource: `${service}.amazonaws.com`, EventName: name,
    CloudTrailEvent: JSON.stringify({ userIdentity: { type: 'AssumedRole',
      arn: `arn:aws:sts::650880818323:assumed-role/${role}/${session}` } }) };
};

test('the derived surface matches the pinned call-site counts and operations', () => {
  const surface = deriveAuthorizationSurface(root);
  for (const [key, value] of Object.entries(PINNED_SURFACE)) {
    assert.equal(surface[key], value, `pinned ${key}`);
  }
  const pairs = surface.pairs.map((entry) => entry.pair).sort();
  assert.equal(pairs.length, 21);
  // The reviewed mapping table may name operations with no Infra call site (the
  // session-policy-only reads); every other mapping must be derived.
  assert.deepEqual(pairs, Object.keys(IAM_ACTIONS)
    .filter((pair) => !NON_DERIVED_REVIEWED_OPERATIONS.includes(pair)).sort());
  // Every site is attributed to a reviewed credential path.
  assert.deepEqual(Object.keys(surface.credential_paths).sort(), Object.keys(CREDENTIAL_PATHS).sort());
  assert.equal(surface.sites.length + surface.shell.length, PINNED_SURFACE.total_call_sites);
  assert.deepEqual(surface.shell.map((site) => site.pair), ['cloudformation/describe-stacks',
    'ecs/register-task-definition', 'ecs/run-task', 'ecs/wait', 'ecs/describe-tasks']);
  // The two forwarders are enumerated rather than skipped.
  assert.deepEqual(surface.dynamic_sites.map((site) => site.pairs).flat().sort(),
    ['cloudformation/list-stack-resources', 'logs/describe-log-groups', 'logs/get-log-events']);
  // The four credential positions exist; two own no io.aws site today.
  assert.equal(surface.credential_paths['deploy-session'].length, 0);
  assert.equal(surface.credential_paths['credential-free-observation'].length, 0);
  assert.ok(surface.pairs.some((entry) => entry.credential_paths.includes('operator-cli')));
});

test('every derived operation has a canary decision, and the deploy session is fully probed', () => {
  const surface = deriveAuthorizationSurface(root);
  const runtime = canaryPlan('runtime', surface);
  const derived = Object.keys(IAM_ACTIONS);
  const decided = [...runtime.probes.map((probe) => probe.pair), ...runtime.skipped.map((skip) => skip.pair)];
  for (const pair of derived) assert.ok(decided.includes(pair), `${pair} has a canary decision`);
  for (const skip of runtime.skipped) assert.ok(skip.reason, `${skip.pair} records a skip reason`);
  assert.ok(runtime.probes.length > 0);
  assert.equal(runtime.session_marker, CANARY_MARKER);
  // The operator-CLI retention reads are not executed by the deployed session and
  // the restricted runtime session does not grant the lifecycle reads: they are
  // skipped with a recorded reason, never probed (and the session is not widened).
  for (const pair of ['ecr/get-lifecycle-policy', 'ecr/get-lifecycle-policy-preview',
    'ecr/start-lifecycle-policy-preview', 'ecr/describe-images']) {
    assert.ok(runtime.skipped.some((skip) => skip.pair === pair), `${pair} is skipped`);
    assert.ok(!runtime.probes.some((probe) => probe.pair === pair), `${pair} is not probed`);
  }
  const operatorOnly = surface.pairs.filter((entry) => entry.credential_paths.length === 1
    && entry.credential_paths[0] === 'operator-cli').map((entry) => entry.pair);
  const probed = new Set(runtime.probes.map((probe) => probe.pair));
  assert.deepEqual(operatorOnly.filter((pair) => probed.has(pair)), []);
  const deploy = canaryPlan('deploy');
  assert.deepEqual(deploy.probes.map((probe) => probe.pair), ['sts/get-caller-identity',
    'cloudformation/describe-stacks', 'ssm/get-parameter', 'ec2/describe-managed-prefix-lists']);
});

test('an authorization denial is classified apart from resource absence', () => {
  assert.equal(classifyAwsFailure('An error occurred (AccessDenied) when calling the GetRole operation: User is not authorized'), 'authorization-denied');
  assert.equal(classifyAwsFailure('An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id X does not exist'), 'resource-absent');
  assert.equal(classifyAwsFailure('An error occurred (ResourceNotFoundException) when calling the GetLogEvents operation'), 'resource-absent');
  assert.equal(classifyAwsFailure('some unrelated failure'), 'unknown');
  assert.equal(classifyAwsFailure(''), 'unknown');
});

test('the non-coverage list ships in the repository and pins its required limits', () => {
  const NON_COVERAGE = nonCoverageList(root);
  const ids = NON_COVERAGE.map((entry) => entry.id);
  assert.deepEqual(ids, ['runtime-sdk-calls', 'resource-less-actions', 'cdk-exec-role', 'condition-satisfaction',
    'service-release-chain', 'create-path', 'conditional-fallback', 'observed-layer-coverage']);
  for (const entry of NON_COVERAGE) {
    assert.ok(['declared', 'enforced', 'observed'].includes(entry.layer), `${entry.id} layer`);
    assert.ok(entry.summary.length > 20, `${entry.id} summary`);
    assert.ok(entry.consequence.length > 20, `${entry.id} consequence`);
  }
  const cdk = NON_COVERAGE.find((entry) => entry.id === 'cdk-exec-role');
  assert.match(cdk.summary, /AdministratorAccess/);
  assert.match(cdk.summary, /permissions boundary/);
  assert.ok(NON_COVERAGE.some((entry) => /Condition/.test(entry.summary)));
});

test('a service-wide declaration covers observed actions and monitoring maps to cloudwatch', () => {
  const declared = ['cloudformation:*', 'cloudwatch:GetMetricStatistics'];
  const window = { start: '2026-10-20T10:00:00Z', end: '2026-10-20T13:00:00Z' };
  const changeSet = cloudTrailEvent('beta-service-deploy-role', 'cloudformation:ExecuteChangeSet');
  const metric = { EventTime: '2026-10-20T12:00:00Z', EventSource: 'monitoring.amazonaws.com',
    EventName: 'GetMetricStatistics',
    CloudTrailEvent: JSON.stringify({ userIdentity: { type: 'AssumedRole',
      arn: 'arn:aws:sts::650880818323:assumed-role/beta-service-deploy-role/infra-deploy-1' } }) };
  assert.equal(eventAction(metric), 'cloudwatch:GetMetricStatistics');
  const record = buildObservedRecord({ events: [changeSet, metric], window, declared, env: {} });
  assert.deepEqual(record.undeclared_actions, []);
  assert.deepEqual(record.observed_actions, ['cloudformation:ExecuteChangeSet', 'cloudwatch:GetMetricStatistics']);
  // Both declared entries were exercised, so neither is reported unused; the
  // wildcard comparison is expansion-aware, not literal.
  assert.deepEqual(record.declared_but_unused, []);
  // An undeclared observed action still fails with the same semantics.
  const foreign = buildObservedRecord({ events: [cloudTrailEvent('beta-service-deploy-role', 's3:GetObject')],
    window, declared, env: {} });
  assert.deepEqual(foreign.undeclared_actions, ['s3:GetObject']);
  assert.throws(() => assertObservedDeclared(foreign), /undeclared AWS action/);
});

test('a declared wildcard is reported unused only when no action under it was observed', () => {
  const window = { start: '2026-10-20T10:00:00Z', end: '2026-10-20T13:00:00Z' };
  const declared = ['cloudformation:*', 'logs:DescribeLogGroups'];
  const record = buildObservedRecord({ events: [cloudTrailEvent('beta-infra-runtime-role', 'cloudformation:DescribeStacks')],
    window, declared, env: {} });
  assert.deepEqual(record.declared_but_unused, ['logs:DescribeLogGroups']);
  assert.equal(validateObservedRecord(record).retention.narrowing, 'report-only');
});

test('the canary excludes its own marked invocations from reconciliation', () => {
  const canary = cloudTrailEvent('beta-infra-runtime-role', 'cloudformation:DescribeStacks',
    { session: `infra-runtime-${CANARY_MARKER}-39100318242` });
  const normal = cloudTrailEvent('beta-infra-runtime-role', 'cloudformation:DescribeStacks');
  assert.equal(isCanaryInvocation(canary), true);
  assert.equal(isCanaryInvocation(normal), false);
  const reconciled = reconcileObserved({ events: [canary, normal] });
  assert.equal(reconciled.excluded_canary_events, 1);
  assert.deepEqual(reconciled.observed_actions, ['cloudformation:DescribeStacks']);
});

test('session acquisition and out-of-scope roles do not enter the observed set', () => {
  const assumed = cloudTrailEvent('beta-infra-runtime-role', 'sts:AssumeRole', { session: 'infra-runtime-1' });
  const foreign = cloudTrailEvent('beta-client-publish-role', 's3:PutObject');
  const reconciled = reconcileObserved({ events: [assumed, foreign,
    cloudTrailEvent('beta-infra-runtime-role', 'logs:DescribeLogGroups')] });
  assert.deepEqual(reconciled.observed_actions, ['logs:DescribeLogGroups']);
  assert.equal(reconciled.ignored_events, 1);
  assert.equal(reconciled.out_of_scope_events, 1);
});

test('an observed action outside the declared surface fails; declared-but-unused is report-only', () => {
  const window = { start: '2026-10-20T10:00:00Z', end: '2026-10-20T13:00:00Z' };
  const declared = ['logs:DescribeLogGroups', 'cloudformation:DescribeStacks'];
  const undeclared = buildObservedRecord({ events: [cloudTrailEvent('beta-infra-runtime-role', 's3:GetObject')],
    window, declared, env: {} });
  assert.deepEqual(undeclared.undeclared_actions, ['s3:GetObject']);
  assert.throws(() => validateObservedRecord(undeclared), /undeclared AWS action/);
  assert.throws(() => assertObservedDeclared(undeclared), /undeclared AWS action/);

  // Only one of the two declared actions was observed: it is reported, not fatal.
  const unused = buildObservedRecord({ events: [cloudTrailEvent('beta-infra-runtime-role', 'logs:DescribeLogGroups')],
    window, declared, env: {} });
  assert.deepEqual(unused.declared_but_unused, ['cloudformation:DescribeStacks']);
  assert.equal(unused.retention.narrowing, 'report-only');
  assert.ok(unused.retention.reason.length > 40);
  assert.equal(validateObservedRecord(unused).declared_but_unused.length, 1);
});

test('a narrowing window shorter than the recorded minimum is refused', () => {
  assert.throws(() => assertObservationWindow({ start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z' }),
    /at least 60 minutes/);
  const accepted = assertObservationWindow({ start: '2026-10-20T10:00:00Z', end: '2026-10-20T11:00:00Z' });
  assert.equal(accepted.minutes, 60);
  assert.throws(() => assertObservationWindow({ start: '2026-10-20T10:00:00Z', end: '2025-01-01T00:00:00Z' }),
    /ends before it starts/);
  assert.equal(OBSERVED_SURFACE.artifact_path, 'deployment-evidence/permissions-observed.json');
  assert.equal(OBSERVED_SURFACE.minimum_window_minutes, 60);
});
