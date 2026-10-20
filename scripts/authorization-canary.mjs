import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CANARY_MARKER, REGION, canaryPlan, classifyAwsFailure, deriveAuthorizationSurface } from './authorization-inventory.mjs';

const execute = promisify(execFile);

// The pre-mutation interlock (Q1). It runs after the restricted session is
// assumed and before any mutation, calls each derived read once, and stops the
// operation with zero changes when the authorization engine denies a read.
// It covers the Infra deploy session and the Infra runtime session only; the
// Service CloudFormation execution role cannot be assumed from this job and is
// covered by the declared assertion plus the post-run observation.
//
// The canary's own invocations carry the stable session-name marker (D2), so the
// CloudTrail reconciliation can filter them out instead of reporting its own
// probe reads as used permissions.
export class AuthorizationDenialError extends Error {
  constructor(session, pair, detail) {
    super(`Authorization denied for ${session} read ${pair} before any mutation: ${detail}`);
    this.name = 'AuthorizationDenialError';
    this.session = session;
    this.pair = pair;
    this.denial = true;
  }
}

export function canaryCommand(probe, region = REGION) {
  const [service, operation] = probe.pair.split('/');
  return ['aws', service, operation, ...probe.args, '--region', region, '--output', 'json'];
}

function detailOf(error) {
  const stderr = String(error?.stderr ?? '').trim().split('\n').filter(Boolean);
  return (stderr[stderr.length - 1] ?? error?.message ?? 'unknown error').slice(0, 600);
}

async function probe({ session, probe: entry, credentials, run, timeout }) {
  const command = canaryCommand(entry);
  try {
    await run(command[0], command.slice(1), { env: credentials, timeout, maxBuffer: 1024 * 1024 });
    return { session, pair: entry.pair, result: 'permitted' };
  } catch (error) {
    const classification = classifyAwsFailure(error?.stderr);
    if (classification === 'authorization-denied') {
      throw new AuthorizationDenialError(session, entry.pair, detailOf(error));
    }
    if (classification === 'resource-absent') {
      return { session, pair: entry.pair, result: 'resource-absent', detail: detailOf(error) };
    }
    return { session, pair: entry.pair, result: 'unclassified-failure', detail: detailOf(error),
      message: 'The canary could not classify this read; it does not prove authorization and does not stop the operation.' };
  }
}

// `assume` must be credentialEnvironment(); a dedicated marked session is
// requested so no other runtime read shares the canary's CloudTrail identity.
export async function runAuthorizationCanary({ sessions, env, purpose = 'operation',
  assume, run = execute, timeout = 120_000, root = process.cwd() } = {}) {
  if (!Array.isArray(sessions) || sessions.length === 0) throw new Error('The canary needs at least one Infra session');
  // The derived surface supplies the credential-path filter: a read whose only
  // call site is the operator CLI is not executed by the deployed session.
  const surface = deriveAuthorizationSurface(root);
  const results = [];
  for (const session of sessions) {
    const plan = canaryPlan(session, surface);
    // A separate assumption per session kind: the canary's own invocations must
    // be distinguishable from the operation's ordinary reads (D2).
    const credentials = await assume(session === 'deploy' ? 'deploy' : 'runtime', env, purpose,
      { sessionMarker: CANARY_MARKER });
    for (const entry of plan.probes) {
      results.push(await probe({ session, probe: entry, credentials, run, timeout }));
    }
  }
  return { schema_version: 1, record_type: 'anywear_authorization_canary', session_marker: CANARY_MARKER,
    result: 'permitted', reads_probed: results.length, probes: results };
}
