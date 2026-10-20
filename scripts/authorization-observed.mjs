import { OBSERVED_SURFACE, declaredActions } from './authorization-inventory.mjs';

// The observed surface (D3). CloudTrail is read over the reconciled roles' run
// window, an observed action outside the declared set fails, and
// declared-but-unused stays report-only: a single run cannot justify narrowing a
// grant, because a branch, a stopped stack or an operation family may simply not
// have executed. The minimum window and the retention reason live in the
// inventory module (OBSERVED_SURFACE), not in this file.

const SESSION_ACQUISITION_ACTIONS = Object.freeze(['sts:AssumeRole', 'sts:AssumeRoleWithWebIdentity',
  'sts:GetSessionToken', 'sts:GetFederationToken']);
const SESSION_ACQUISITION_SOURCES = Object.freeze(['sts.amazonaws.com']);
const IGNORED_EVENT_SOURCES = Object.freeze(['signin.amazonaws.com']);

export function eventDetail(event) {
  try {
    const detail = typeof event?.CloudTrailEvent === 'string' ? JSON.parse(event.CloudTrailEvent) : event?.CloudTrailEvent;
    const identity = detail?.userIdentity ?? {};
    return {
      arn: typeof identity.arn === 'string' ? identity.arn : '',
      role: typeof identity.sessionContext?.sessionIssuer?.userName === 'string'
        ? identity.sessionContext.sessionIssuer.userName : undefined,
      invoked_by: typeof identity.invokedBy === 'string' ? identity.invokedBy : undefined,
    };
  } catch {
    return { arn: '', role: undefined, invoked_by: undefined };
  }
}

export function eventRole(event) {
  const detail = eventDetail(event);
  if (detail.role) return detail.role;
  const assumed = /:assumed-role\/([^/]+)\//.exec(detail.arn);
  if (assumed) return assumed[1];
  const plain = /:role\/([^/]+)$/.exec(detail.arn);
  return plain?.[1];
}

export function isCanaryInvocation(event, marker = OBSERVED_SURFACE.canary_marker) {
  const detail = eventDetail(event);
  const session = detail.arn.split('/').pop() ?? '';
  return session.split('-').includes(marker) || detail.arn.includes(`-${marker}-`);
}

export function eventAction(event) {
  if (typeof event?.EventSource !== 'string' || typeof event?.EventName !== 'string') return undefined;
  return `${event.EventSource.replace(/\.amazonaws\.com$/, '')}:${event.EventName}`;
}

export function assertObservationWindow({ start, end,
  minimumMinutes = OBSERVED_SURFACE.minimum_window_minutes,
  maxDays = OBSERVED_SURFACE.max_window_days } = {}) {
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) throw new Error('The observation window needs two valid ISO-8601 times');
  if (endTime <= startTime) throw new Error('The observation window ends before it starts');
  const minutes = (endTime - startTime) / 60_000;
  if (minutes < minimumMinutes) {
    throw new Error(`The observation window is ${minutes} minutes; narrowing needs at least ${minimumMinutes} minutes covering a deploy and an observe run (D3)`);
  }
  if (minutes > maxDays * 24 * 60) throw new Error(`The observation window exceeds the ${maxDays}-day CloudTrail event-history limit`);
  return { start: new Date(startTime).toISOString(), end: new Date(endTime).toISOString(), minutes };
}

// Reconcile one run's CloudTrail event page set. The canary's own invocations
// (its marked session) are excluded so the sensor does not inject its own signal.
export function reconcileObserved({ events, declared = declaredActions(),
  roles = OBSERVED_SURFACE.reconciled_roles, canaryMarker = OBSERVED_SURFACE.canary_marker } = {}) {
  if (!Array.isArray(events)) throw new Error('CloudTrail events must be an array');
  const observed = new Set();
  const perRole = new Map(roles.map((role) => [role, new Set()]));
  let canaryExcluded = 0;
  let outOfScope = 0;
  const ignored = [];
  for (const event of events) {
    const action = eventAction(event);
    if (!action) continue;
    const source = `${event.EventSource}`;
    if (IGNORED_EVENT_SOURCES.includes(source)) { ignored.push({ reason: 'ignored-event-source', source }); continue; }
    if (SESSION_ACQUISITION_SOURCES.includes(source) && SESSION_ACQUISITION_ACTIONS.includes(action)) {
      ignored.push({ reason: 'session-acquisition', action }); continue;
    }
    if (isCanaryInvocation(event, canaryMarker)) { canaryExcluded += 1; continue; }
    const role = eventRole(event);
    if (!role || !roles.includes(role)) { outOfScope += 1; continue; }
    observed.add(action);
    perRole.get(role).add(action);
  }
  const declaredSet = new Set(declared);
  const observedActions = [...observed].sort();
  const undeclared = observedActions.filter((action) => !declaredSet.has(action));
  const declaredButUnused = declared.filter((action) => !observed.has(action)).sort();
  return {
    observed_actions: observedActions,
    undeclared_actions: undeclared,
    declared_but_unused: declaredButUnused,
    per_role: Object.fromEntries([...perRole].map(([role, actions]) => [role, [...actions].sort()])),
    excluded_canary_events: canaryExcluded,
    out_of_scope_events: outOfScope,
    ignored_events: ignored.length,
  };
}

export function buildObservedRecord({ events, window, declared = declaredActions(), env = process.env } = {}) {
  const normalized = assertObservationWindow({
    ...window,
    minimumMinutes: window?.minimumMinutes ?? OBSERVED_SURFACE.minimum_window_minutes,
  });
  const reconciliation = reconcileObserved({ events, declared });
  return {
    schema_version: OBSERVED_SURFACE.schema_version,
    record_type: OBSERVED_SURFACE.record_type,
    generated_at: new Date().toISOString(),
    executor: { repository: env.GITHUB_REPOSITORY ?? 'git-malu/AnyWear-Infra', run_id: Number(env.GITHUB_RUN_ID) || null,
      run_attempt: Number(env.GITHUB_RUN_ATTEMPT) || null, source_sha: env.GITHUB_SHA ?? null },
    window: { ...normalized, minimum_minutes: OBSERVED_SURFACE.minimum_window_minutes },
    retention: { reason: OBSERVED_SURFACE.retention_reason, narrowing: 'report-only' },
    reconciled_roles: OBSERVED_SURFACE.reconciled_roles,
    canary_marker: OBSERVED_SURFACE.canary_marker,
    lookup: { api: 'cloudtrail:LookupEvents', consistency: 'event history is eventually consistent; the window ends at generation time' },
    ...reconciliation,
  };
}

// A reader (or the credential-free record job) fails on an observed action the
// declared surface does not contain. Declared-but-unused is printed, never fatal.
export function assertObservedDeclared(record) {
  if (!record || record.record_type !== OBSERVED_SURFACE.record_type) throw new Error('Not an observed authorization record');
  if (!Array.isArray(record.undeclared_actions)) throw new Error('Observed record has no undeclared_actions list');
  if (record.undeclared_actions.length) {
    throw new Error(`Observed undeclared AWS action(s): ${record.undeclared_actions.join(', ')}. Add a reviewed grant and inventory entry, or stop the operation.`);
  }
  return record;
}

export function validateObservedRecord(record) {
  assertObservedDeclared(record);
  if (!Array.isArray(record.observed_actions) || !Array.isArray(record.declared_but_unused)) throw new Error('Observed record lists are missing');
  if (!record.window?.start || !record.window?.end) throw new Error('Observed record has no run window');
  assertObservationWindow(record.window);
  if (record.retention?.narrowing !== 'report-only') throw new Error('Declared-but-unused may not narrow automatically (D3)');
  return record;
}
