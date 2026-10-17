import { canonicalJson, parseJson } from './json-contract.mjs';
import { ADMISSION_WINDOW_CLOCK_SKEW_MS, WINDOW_MINUTES_MAX } from './admission-window.mjs';

// Admission has one representation: one parameter carries one decision. The
// value is a small JSON record rather than a bare word because the decision has
// a temporal bound, and a reader that cannot see the bound would have to
// remember it — a remembered bound is a bound nobody enforces.
//
//   {"mode":"closed"}                                  nothing is admitted
//   {"mode":"testers","expires_at":"<ISO instant>"}    only the exact tester
//                                                      list until that instant
//
// `open` does not exist: Beta admission is tester-only by contract, and no
// delivered operation can admit a non-tester. Every reader applies the same
// fail-closed rules, so an abandoned window closes itself on this surface with
// no writer, no grant and no deployment.
//
// Two things stay separate everywhere below, on purpose:
//   * the *effective* decision, which is what gates admission, and
//   * the *raw recorded* record, which is what an operator must see to know the
//     database still stores `testers` with a past bound while admission is closed.
// Collapsing them lets a status line say "testers are admitted" about a closed
// environment, or hide a disagreeing pair behind one boolean.
export const ADMISSION_MODE_PARAMETER = '/anywear/beta/admission_mode';
export const ADMISSION_MODE_CLOSED = 'closed';
export const ADMISSION_MODE_TESTERS = 'testers';
export const ADMISSION_MODES = Object.freeze([ADMISSION_MODE_CLOSED, ADMISSION_MODE_TESTERS]);
// Byte-for-byte the fail-closed default `lib/platform-stack.ts` creates.
export const ADMISSION_MODE_DEFAULT = canonicalJson({ mode: ADMISSION_MODE_CLOSED });
// The same ceiling the Service read applies: the requestable 240 minutes plus
// the named one-minute clock-skew allowance, because the writing one-shot
// container and the reading task are separate clocks. The dispatch input keeps
// the hard 15-240 bound and never uses this allowance.
export const ADMISSION_MODE_MAX_AHEAD_MS = WINDOW_MINUTES_MAX * 60_000 + ADMISSION_WINDOW_CLOCK_SKEW_MS;

const UNPARSED = 'unparsed';
const MISSING = 'missing';

// Strict ISO-8601: a string that round-trips through the canonical UTC form.
// `Date.parse` alone is too permissive for a security decision: it accepts
// date-only values, rolls impossible dates into the next month, accepts slashes,
// and reads a naive timestamp in the reader's own time zone. Requiring
// `new Date(parsed).toISOString() === value` admits exactly the canonical instant
// form the writer produces and refuses everything else, so the one-shot writer and
// every reader agree byte-for-byte about what "the bound" is.
export function parseAdmissionInstant(value) {
  if (typeof value !== 'string') return undefined;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  if (new Date(at).toISOString() !== value) return undefined;
  return at;
}

// Two recorded bounds are the same fact when they name the same instant; the
// writer and the reader may spell the same instant differently.
export function sameAdmissionInstant(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left ?? null) === (right ?? null);
  }
  const a = parseAdmissionInstant(left); const b = parseAdmissionInstant(right);
  return a !== undefined && b !== undefined && a === b;
}

const resolution = (fields) => Object.freeze({
  admission_mode: ADMISSION_MODE_CLOSED, admission_window_expires_at: null,
  admission_mode_source: 'fail-closed', admission_mode_reason: null,
  admission_recorded_mode: UNPARSED, admission_recorded_expires_at: null, ...fields,
});

// The one decision every reader shares, applied to a raw recorded pair. A
// `testers` record admits only while its bound is canonical, strictly in the
// future and inside the ceiling; every other pair is closed, fail-closed, with
// the reason kept so the evidence can say why.
export function resolveAdmissionDecision(mode, expiresAt, now = Date.now()) {
  const recordedExpiry = typeof expiresAt === 'string' ? expiresAt : null;
  const recorded = { admission_recorded_mode: typeof mode === 'string' ? mode : UNPARSED,
    admission_recorded_expires_at: recordedExpiry };
  if (typeof mode !== 'string' || !ADMISSION_MODES.includes(mode)) return resolution({ ...recorded, admission_mode_reason: 'unknown-mode' });
  if (expiresAt !== undefined && expiresAt !== null && typeof expiresAt !== 'string') {
    return resolution({ ...recorded, admission_recorded_expires_at: UNPARSED, admission_mode_reason: 'wrong-type' });
  }
  if (mode === ADMISSION_MODE_CLOSED) {
    // A closed record carrying a bound contradicts itself, so it proves nothing.
    if (recordedExpiry !== null) return resolution({ ...recorded, admission_mode_reason: 'closed-with-expiry' });
    return resolution({ admission_mode_source: 'record', admission_recorded_mode: ADMISSION_MODE_CLOSED });
  }
  if (recordedExpiry === null) return resolution({ admission_recorded_mode: mode, admission_mode_reason: 'missing-expiry' });
  const at = parseAdmissionInstant(recordedExpiry);
  if (at === undefined) return resolution({ admission_recorded_mode: mode, admission_recorded_expires_at: UNPARSED, admission_mode_reason: 'malformed-expiry' });
  const ahead = at - now;
  if (ahead <= 0) return resolution({ ...recorded, admission_mode_reason: 'expired' });
  if (ahead > ADMISSION_MODE_MAX_AHEAD_MS) return resolution({ ...recorded, admission_mode_reason: 'beyond-bound' });
  return Object.freeze({ admission_mode: ADMISSION_MODE_TESTERS, admission_window_expires_at: recordedExpiry,
    admission_mode_source: 'record', admission_mode_reason: null,
    admission_recorded_mode: mode, admission_recorded_expires_at: recordedExpiry });
}

// The parameter value is one JSON record. `parseJson` rejects duplicate keys,
// which matters: Node's `JSON.parse` takes the last duplicate, so a hand-edited
// `{"mode":"closed","mode":"testers",...}` would be readable as open by one
// implementation and closed by another. Here a duplicated key is not a record at
// all, and the value consequently cannot *prove* closure either.
export function parseAdmissionModeValue(value, now = Date.now()) {
  if (value === undefined || value === null) {
    return resolution({ admission_mode_reason: 'missing', admission_recorded_mode: MISSING });
  }
  if (typeof value !== 'string') return resolution({ admission_mode_reason: 'wrong-type', admission_recorded_mode: UNPARSED });
  let record;
  try { record = parseJson(value); } catch { return resolution({ admission_mode_reason: 'malformed', admission_recorded_mode: UNPARSED }); }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return resolution({ admission_mode_reason: 'malformed', admission_recorded_mode: UNPARSED });
  }
  if (typeof record.mode !== 'string') return resolution({ admission_mode_reason: 'wrong-type', admission_recorded_mode: UNPARSED });
  if (!ADMISSION_MODES.includes(record.mode)) return resolution({ admission_mode_reason: 'unknown-mode', admission_recorded_mode: record.mode });
  const keys = Object.keys(record).sort();
  if (keys.length > 2 || keys.some(key => !['expires_at', 'mode'].includes(key))) {
    return resolution({ admission_mode_reason: 'extra-key', admission_recorded_mode: record.mode,
      admission_recorded_expires_at: typeof record.expires_at === 'string' ? record.expires_at : null });
  }
  return resolveAdmissionDecision(record.mode, record.expires_at, now);
}

// The decision, for callers that only need the effective mode.
export const isAdmissionClosed = resolution => resolution?.admission_mode === ADMISSION_MODE_CLOSED;

// Closure something can act on. A valid closed record proves it, and so does an
// expired tester window: both are the bound doing its job.
export function isAdmissionProvablyClosed(resolution) {
  if (!isAdmissionClosed(resolution)) return false;
  return resolution.admission_mode_source === 'record' || resolution.admission_mode_reason === 'expired';
}

// A mutation fence needs three answers, not two. The reader's admission decision
// may be fail-closed on an unreadable or malformed value, which is right for
// admission and wrong for a fence: a fence must refuse when closure is not
// *proven*, and must never treat one throttled read as consent.
//   closed   — the record proves effective closure (closed record, expired bound)
//   open     — a live tester window is recorded
//   unproven — unreadable, missing, malformed, unknown, inconsistent or over-long
export function admissionClosureProof(resolution) {
  if (isAdmissionProvablyClosed(resolution)) return 'closed';
  return resolution?.admission_mode === ADMISSION_MODE_TESTERS ? 'open' : 'unproven';
}

export const admissionClock = io => (typeof io?.now === 'function' ? io.now() : Date.now());

// Read exactly the admission parameter. `ssm:GetParameter` is already in the
// runtime read set, so this needs no grant and no CDK change.
export async function readAdmissionMode(io, now = admissionClock(io)) {
  const parameter = (await io.aws(['ssm', 'get-parameter', '--name', ADMISSION_MODE_PARAMETER])).Parameter;
  if (parameter?.Name !== undefined && parameter.Name !== ADMISSION_MODE_PARAMETER) throw new Error('Unexpected admission parameter identity');
  return parseAdmissionModeValue(parameter?.Value, now);
}

// The forward-migration fence, shared by the standalone `migrate` operation and
// the `start` sequence that invokes the same one-shot. It refuses `open` and
// `unproven` alike, and records what it observed so a refusal is evidence.
export async function assertMigrationAdmissionClosed(io, label = 'the standalone migrate operation') {
  let admission;
  let cause;
  try { admission = await readAdmissionMode(io); }
  catch (error) { cause = error; }
  const proof = admission ? admissionClosureProof(admission) : 'unproven';
  io.recordAdmissionState?.({ phase: 'migration-fence', proof,
    state: admission ?? { admission_mode: 'unavailable', admission_window_expires_at: 'unavailable',
      admission_mode_source: 'unavailable', admission_mode_reason: 'unavailable', tester_emails: [] },
    result: proof === 'closed' ? 'observed' : 'refused' });
  if (proof !== 'closed') {
    throw new Error(`Admission mirror does not prove closed admission; refusing ${label}: ${admission ? describeAdmissionMode(admission) : 'unreadable mirror'}`, { cause });
  }
  return admission;
}

// Redacted, bounded one-line description for operation evidence and errors. It
// names the effective decision and the recorded record separately.
export function describeAdmissionMode(resolution) {
  const mode = typeof resolution?.admission_mode === 'string' ? resolution.admission_mode : 'unavailable';
  const bound = typeof resolution?.admission_window_expires_at === 'string' ? resolution.admission_window_expires_at : 'none';
  const reason = resolution?.admission_mode_reason ? ` (${resolution.admission_mode_reason})` : '';
  const recorded = typeof resolution?.admission_recorded_mode === 'string' ? resolution.admission_recorded_mode : 'unavailable';
  return `admission_mode=${mode}${reason}, admission_window_expires_at=${bound}, recorded_mode=${recorded}`;
}
