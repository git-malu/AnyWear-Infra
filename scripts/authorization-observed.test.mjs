import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OBSERVED_SURFACE, actionCovered, reconcileObserved, buildObservedRecord, validateObservedRecord,
  assertObservedDeclared, assertObservationWindow, isSelfInvocation, eventAction } from './authorization-observed.mjs';

const DECLARATION = JSON.parse(readFileSync(new URL('../test/fixtures/authorization-declared.json', import.meta.url), 'utf8'));
const DECLARED = DECLARATION.roles;

const cloudTrailEvent = (role, action, { session = 'infra-runtime-1', source, time = '2026-10-20T12:00:00Z' } = {}) => {
  const [service, name] = action.split(':');
  return { EventTime: time, EventSource: source ?? `${service}.amazonaws.com`, EventName: name,
    CloudTrailEvent: JSON.stringify({ userIdentity: { type: 'AssumedRole',
      arn: `arn:aws:sts::650880818323:assumed-role/${role}/${session}` } }) };
};
const window = { start: '2026-10-20T10:00:00Z', end: '2026-10-20T13:00:00Z' };

test('the declaration artifact covers every reconciled role and stays wildcard-aware', () => {
  for (const role of OBSERVED_SURFACE.reconciled_roles) {
    assert.ok(Array.isArray(DECLARED[role]) && DECLARED[role].length > 0, `${role} is declared`);
  }
  assert.equal(actionCovered(DECLARED['beta-service-deploy-role'], 'cloudformation:ExecuteChangeSet'), true);
  assert.equal(actionCovered(DECLARED['beta-infra-runtime-role'], 'cloudwatch:GetMetricStatistics'), true);
  assert.equal(actionCovered(DECLARED['beta-infra-runtime-role'], 's3:GetObject'), false);
});

test('self-instrumentation is excluded: the preflight session marker and the simulator actions', () => {
  const preflight = cloudTrailEvent('beta-infra-runtime-role', 'cloudformation:DescribeStacks',
    { session: `infra-runtime-${OBSERVED_SURFACE.self_markers[0]}-39100318242` });
  assert.equal(isSelfInvocation(preflight), true);
  const simulate = cloudTrailEvent('beta-infra-runtime-role', 'iam:SimulatePrincipalPolicy');
  const normal = cloudTrailEvent('beta-infra-runtime-role', 'logs:DescribeLogGroups');
  const reconciled = reconcileObserved({ events: [preflight, simulate, normal], declaredByRole: DECLARED });
  assert.equal(reconciled.excluded_self_events, 2);
  assert.deepEqual(reconciled.per_role['beta-infra-runtime-role'], ['logs:DescribeLogGroups']);
});

test('session acquisition and out-of-scope roles do not enter the observed set', () => {
  const assumed = cloudTrailEvent('beta-infra-runtime-role', 'sts:AssumeRole', { session: 'infra-runtime-1' });
  const foreign = cloudTrailEvent('beta-client-publish-role', 's3:PutObject');
  const reconciled = reconcileObserved({ events: [assumed, foreign,
    cloudTrailEvent('beta-infra-runtime-role', 'logs:DescribeLogGroups')], declaredByRole: DECLARED });
  assert.deepEqual(reconciled.observed_actions, ['logs:DescribeLogGroups']);
  assert.equal(reconciled.ignored_events, 1);
  assert.equal(reconciled.out_of_scope_events, 1);
});

test('CloudTrail monitoring events map to cloudwatch actions', () => {
  const event = cloudTrailEvent('beta-service-deploy-role', 'cloudwatch:GetMetricStatistics',
    { source: 'monitoring.amazonaws.com' });
  assert.equal(eventAction(event), 'cloudwatch:GetMetricStatistics');
  const reconciled = reconcileObserved({ events: [event], declaredByRole: DECLARED });
  assert.deepEqual(reconciled.undeclared_actions, []);
  assert.deepEqual(reconciled.per_role['beta-service-deploy-role'], ['cloudwatch:GetMetricStatistics']);
});

test('an observed action the IaC does not declare fails; declared-but-unused is report-only', () => {
  const undeclared = buildObservedRecord({ events: [cloudTrailEvent('beta-infra-runtime-role', 's3:GetObject')],
    window, declaredByRole: DECLARED, env: {} });
  assert.deepEqual(undeclared.undeclared_actions, [{ role: 'beta-infra-runtime-role', action: 's3:GetObject' }]);
  assert.throws(() => validateObservedRecord(undeclared, DECLARED), /undeclared AWS action/);
  assert.throws(() => assertObservedDeclared(undeclared), /undeclared AWS action/);

  const unused = buildObservedRecord({ events: [cloudTrailEvent('beta-infra-runtime-role', 'logs:DescribeLogGroups')],
    window, declaredByRole: DECLARED, env: {} });
  assert.ok(unused.declared_but_unused_count > 0);
  assert.deepEqual(unused.declared_but_unused['beta-infra-runtime-role'],
    DECLARED['beta-infra-runtime-role'].filter((entry) => entry !== 'logs:DescribeLogGroups').sort());
  assert.equal(unused.retention.narrowing, 'report-only');
  assert.ok(unused.retention.reason.length > 40);
  assert.equal(validateObservedRecord(unused, DECLARED).declared_but_unused_count, unused.declared_but_unused_count);
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
  assert.equal(OBSERVED_SURFACE.default_window_minutes, 180);
  assert.equal(OBSERVED_SURFACE.max_window_days, 90);
});

test('the observed record keeps the shape the workflow expects', () => {
  const record = buildObservedRecord({ events: [cloudTrailEvent('beta-infra-runtime-role', 'logs:DescribeLogGroups')],
    window, declaredByRole: DECLARED, env: { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra' } });
  assert.equal(record.record_type, OBSERVED_SURFACE.record_type);
  assert.ok(record.per_role && record.declared_but_unused && record.observed_actions);
  assert.equal(record.excluded_self_events, 0);
  assert.equal(record.window.minutes, 180);
  assert.ok(record.declaration_source.includes('authorization-declared.json'));
});
