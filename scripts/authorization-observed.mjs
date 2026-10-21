// The observed surface (#165). CloudTrail is read over the reconciled roles' run
// window, and the actions actually used are compared with the actions the
// synthesized Foundation and Platform policy documents declare. The declaration
// artifact is produced by the lint check (test/authorization-lint.test.ts) and
// committed as test/fixtures/authorization-declared.json, so the credential-free
// reader can reconcile without synthesizing anything.
//
// Declared-but-unused is report-only (D3): a single run cannot justify narrowing a
// grant, because a branch, a stopped stack or an operation family may simply not
// have executed. Narrowing needs a minimum window and a reviewed policy change.

export const OBSERVED_SURFACE = Object.freeze({
  schema_version: 1,
  record_type: 'anywear_permissions_observed',
  minimum_window_minutes: 60,
  default_window_minutes: 180,
  max_window_days: 90,
  artifact_path: 'deployment-evidence/permissions-observed.json',
  // The preflight's own session and its simulator calls are instrumentation, not
  // operation permissions: reconciliation excludes both.
  self_markers: Object.freeze(['preflight']),
  self_instrumentation_actions: Object.freeze(['iam:SimulatePrincipalPolicy', 'iam:SimulateCustomPolicy']),
  retention_reason: 'A declared action can be unused because a code branch, a stack state (stopped Beta) or an operation family did not execute in one run. The artifact is retained with the deployment evidence (90 days) and a narrowing needs a window covering at least one deploy and one observe run, so a single run cannot delete a grant it merely did not exercise.',
  reconciled_roles: Object.freeze(['beta-infra-deploy-role', 'beta-infra-runtime-role',
    'beta-service-deploy-role', 'beta-service-deploy-cfn-role']),
  event_page_limit: 50,
});

// CloudTrail event sources are not IAM service prefixes: CloudWatch events are
// recorded under `monitoring.amazonaws.com` while the IAM action is
// `cloudwatch:...`. The alias map is reviewed, never inferred.
export const EVENT_SOURCE_ALIASES = Object.freeze({ monitoring: 'cloudwatch' });

const SESSION_ACQUISITION_ACTIONS = Object.freeze(['sts:AssumeRole', 'sts:AssumeRoleWithWebIdentity',
  'sts:GetSessionToken', 'sts:GetFederationToken']);
const SESSION_ACQUISITION_SOURCES = Object.freeze(['sts.amazonaws.com']);
const IGNORED_EVENT_SOURCES = Object.freeze(['signin.amazonaws.com']);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const globRegExp = (pattern) => new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);

// A declaration is a grant pattern: `cloudformation:*` declares any observed
// CloudFormation action and `*` declares everything.
export function actionCovered(declaredActions, action) {
  return declaredActions.some((granted) => granted === action
    || granted === '*'
    || (granted.endsWith(':*') && action.startsWith(`${granted.slice(0, -1)}`)));
}

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

export function isSelfInvocation(event, markers = OBSERVED_SURFACE.self_markers) {
  const detail = eventDetail(event);
  const session = detail.arn.split('/').pop() ?? '';
  return markers.some((marker) => session.split('-').includes(marker) || detail.arn.includes(`-${marker}-`));
}

export function eventAction(event) {
  if (typeof event?.EventSource !== 'string' || typeof event?.EventName !== 'string') return undefined;
  const source = event.EventSource.replace(/\.amazonaws\.com$/, '');
  return `${EVENT_SOURCE_ALIASES[source] ?? source}:${event.EventName}`;
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

// declaredByRole is the lint-produced declaration: { role: [actions] }. Every
// reconciled role must be declared; a missing role fails closed.
export function declaredActionsFor(declaredByRole, role) {
  const actions = declaredByRole?.[role];
  if (!Array.isArray(actions) || actions.length === 0) throw new Error(`No declared actions for reconciled role ${role}`);
  return actions;
}

export function reconcileObserved({ events, declaredByRole, roles = OBSERVED_SURFACE.reconciled_roles,
  selfMarkers = OBSERVED_SURFACE.self_markers } = {}) {
  if (!Array.isArray(events)) throw new Error('CloudTrail events must be an array');
  for (const role of roles) declaredActionsFor(declaredByRole, role);
  const observed = new Map(roles.map((role) => [role, new Set()]));
  let selfExcluded = 0;
  let outOfScope = 0;
  let ignored = 0;
  for (const event of events) {
    const action = eventAction(event);
    if (!action) continue;
    const source = `${event.EventSource}`;
    if (IGNORED_EVENT_SOURCES.includes(source)) { ignored += 1; continue; }
    if (SESSION_ACQUISITION_SOURCES.includes(source) && SESSION_ACQUISITION_ACTIONS.includes(action)) { ignored += 1; continue; }
    if (isSelfInvocation(event, selfMarkers)
      || OBSERVED_SURFACE.self_instrumentation_actions.some((instrumentation) => actionCovered([instrumentation], action))) {
      selfExcluded += 1;
      continue;
    }
    const role = eventRole(event);
    if (!role || !roles.includes(role)) { outOfScope += 1; continue; }
    observed.get(role).add(action);
  }
  const undeclared = [];
  const declaredButUnused = {};
  const perRole = {};
  for (const role of roles) {
    const declared = declaredActionsFor(declaredByRole, role);
    const used = [...observed.get(role)].sort();
    perRole[role] = used;
    for (const action of used) if (!actionCovered(declared, action)) undeclared.push({ role, action });
    declaredButUnused[role] = declared.filter((entry) => !used.some((action) => actionCovered([entry], action))).sort();
  }
  return {
    observed_actions: [...new Set(roles.flatMap((role) => perRole[role]))].sort(),
    undeclared_actions: undeclared,
    per_role: perRole,
    declared_but_unused: declaredButUnused,
    declared_but_unused_count: Object.values(declaredButUnused).reduce((total, actions) => total + actions.length, 0),
    excluded_self_events: selfExcluded,
    out_of_scope_events: outOfScope,
    ignored_events: ignored,
  };
}

export function buildObservedRecord({ events, window, declaredByRole, env = process.env } = {}) {
  const normalized = assertObservationWindow({
    ...window,
    minimumMinutes: window?.minimumMinutes ?? OBSERVED_SURFACE.minimum_window_minutes,
  });
  const reconciliation = reconcileObserved({ events, declaredByRole });
  return {
    schema_version: OBSERVED_SURFACE.schema_version,
    record_type: OBSERVED_SURFACE.record_type,
    generated_at: new Date().toISOString(),
    executor: { repository: env.GITHUB_REPOSITORY ?? 'git-malu/AnyWear-Infra',
      run_id: Number(env.GITHUB_RUN_ID) || null, run_attempt: Number(env.GITHUB_RUN_ATTEMPT) || null,
      source_sha: env.GITHUB_SHA ?? null },
    window: { ...normalized, minimum_minutes: OBSERVED_SURFACE.minimum_window_minutes },
    retention: { reason: OBSERVED_SURFACE.retention_reason, narrowing: 'report-only' },
    reconciled_roles: OBSERVED_SURFACE.reconciled_roles,
    self_markers: OBSERVED_SURFACE.self_markers,
    declaration_source: 'test/fixtures/authorization-declared.json (Allow actions in the synthesized Foundation and Platform policy documents)',
    lookup: { api: 'cloudtrail:LookupEvents', consistency: 'event history is eventually consistent; the window ends at generation time' },
    ...reconciliation,
  };
}

export function undeclaredDetail(undeclared) {
  return undeclared.map((entry) => `${entry.role}: ${entry.action}`).join(', ');
}

// A reader (or the credential-free record job) fails on an observed action the
// IaC does not declare. Declared-but-unused is printed, never fatal.
export function assertObservedDeclared(record) {
  if (!record || record.record_type !== OBSERVED_SURFACE.record_type) throw new Error('Not an observed authorization record');
  if (!Array.isArray(record.undeclared_actions)) throw new Error('Observed record has no undeclared_actions list');
  if (record.undeclared_actions.length) {
    throw new Error(`Observed undeclared AWS action(s): ${undeclaredDetail(record.undeclared_actions)}. Add a reviewed grant and declaration, or stop the operation.`);
  }
  return record;
}

export function validateObservedRecord(record, declaredByRole) {
  if (!record || record.record_type !== OBSERVED_SURFACE.record_type) throw new Error('Not an observed authorization record');
  if (!Array.isArray(record.observed_actions) || !record.per_role || !record.declared_but_unused) {
    throw new Error('Observed record lists are missing');
  }
  if (!record.window?.start || !record.window?.end) throw new Error('Observed record has no run window');
  assertObservationWindow(record.window);
  if (record.retention?.narrowing !== 'report-only') throw new Error('Declared-but-unused may not narrow automatically (D3)');
  // Recompute the undeclared set from the recorded per-role usage and the current
  // declaration artifact; never trust a possibly stale field alone.
  const undeclared = [];
  for (const role of OBSERVED_SURFACE.reconciled_roles) {
    const declared = declaredActionsFor(declaredByRole, role);
    for (const action of record.per_role[role] ?? []) {
      if (!actionCovered(declared, action)) undeclared.push({ role, action });
    }
  }
  if (undeclared.length || record.undeclared_actions.length) {
    throw new Error(`Observed undeclared AWS action(s): ${undeclaredDetail(undeclared.length ? undeclared : record.undeclared_actions)}. Add a reviewed grant and declaration, or stop the operation.`);
  }
  return record;
}
