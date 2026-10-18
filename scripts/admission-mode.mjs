import { canonicalJson, parseJson } from './json-contract.mjs';

// Admission has one representation: one parameter carries one decision, and the
// decision is a mode word plus nothing else.
//
//   {"mode":"closed"}     nothing is admitted
//   {"mode":"testers"}    only the exact tester list, until an explicit close
//
// `open` does not exist: Beta admission is tester-only by contract, and no
// delivered operation can admit a non-tester. There is no clock and no bound:
// `testers` admits until `close-admission` writes `closed`, and no reader treats a
// record as expired. Closing is an explicit operation, so nothing closes itself.
//
// Two things stay separate everywhere below, on purpose:
//   * the *effective* decision, which is what gates admission, and
//   * the *raw recorded* record, which is what an operator must see to know what
//     the database still stores.
// Collapsing them lets a status line say "testers are admitted" about a closed
// environment, or hide a disagreeing pair behind one boolean.
//
// The record's *key set* is carried as evidence beside the decision: an accepted
// record has exactly `["mode"]`, so the key list itself proves that no bound field
// exists. The tester list is a separate parameter and is never read as admission.
export const ADMISSION_MODE_PARAMETER = '/anywear/beta/admission_mode';
export const ADMISSION_MODE_CLOSED = 'closed';
export const ADMISSION_MODE_TESTERS = 'testers';
export const ADMISSION_MODES = Object.freeze([ADMISSION_MODE_CLOSED, ADMISSION_MODE_TESTERS]);
// Byte-for-byte the fail-closed default `lib/platform-stack.ts` creates.
export const ADMISSION_MODE_DEFAULT = canonicalJson({ mode: ADMISSION_MODE_CLOSED });

const UNPARSED = 'unparsed';
const MISSING = 'missing';
const RECORD_KEY = 'mode';

const resolution = (fields) => Object.freeze({
  admission_mode: ADMISSION_MODE_CLOSED,
  admission_mode_source: 'fail-closed', admission_mode_reason: null,
  admission_recorded_mode: UNPARSED, admission_recorded_keys: 'unavailable', ...fields,
});

// The one decision every reader shares, applied to a recorded mode word. A
// `testers` record is open: there is no clock to consult, so only an explicit
// close changes the decision. Every other value is closed, fail-closed, with the
// reason kept so the evidence can say why.
export function resolveAdmissionDecision(mode) {
  if (typeof mode !== 'string' || !ADMISSION_MODES.includes(mode)) {
    return resolution({ admission_recorded_mode: typeof mode === 'string' ? mode : UNPARSED,
      admission_mode_reason: 'unknown-mode' });
  }
  return resolution({ admission_mode: mode, admission_mode_source: 'record',
    admission_recorded_mode: mode });
}

// The parameter value is one JSON record. `parseJson` rejects duplicate keys,
// which matters: Node's `JSON.parse` takes the last duplicate, so a hand-edited
// `{"mode":"closed","mode":"testers"}` would be readable as open by one
// implementation and closed by another. Here a duplicated key is not a record at
// all, and the value consequently cannot *prove* closure either.
//
// The encoding is also fixed: the value must be its own canonical JSON encoding,
// the same `JSON.stringify(JSON.parse(value)) === value` rule the Service reader
// applies. Whitespace, reordered-but-equivalent encodings and any other
// non-canonical spelling are refused, so the writer and every reader agree on one
// byte string per decision.
//
// The record has exactly one key. An extra key — the removed `expires_at` above
// all — is refused rather than ignored, and the observed key list is kept so the
// refusal (and a successful open) can show which keys were actually present.
export function parseAdmissionModeValue(value) {
  if (value === undefined || value === null) {
    return resolution({ admission_mode_reason: 'missing', admission_recorded_mode: MISSING });
  }
  if (typeof value !== 'string') return resolution({ admission_mode_reason: 'wrong-type', admission_recorded_mode: UNPARSED });
  let record;
  try { record = parseJson(value); } catch { return resolution({ admission_mode_reason: 'malformed', admission_recorded_mode: UNPARSED }); }
  const isObject = record !== null && typeof record === 'object' && !Array.isArray(record);
  const keys = isObject ? Object.keys(record).sort() : undefined;
  const recordedKeys = keys ? { admission_recorded_keys: keys } : {};
  if (JSON.stringify(record) !== value) {
    return resolution({ ...recordedKeys, admission_mode_reason: 'non-canonical', admission_recorded_mode: UNPARSED });
  }
  if (!isObject) return resolution({ admission_mode_reason: 'malformed', admission_recorded_mode: UNPARSED });
  if (typeof record.mode !== 'string') {
    return resolution({ ...recordedKeys, admission_mode_reason: 'wrong-type', admission_recorded_mode: UNPARSED });
  }
  if (!ADMISSION_MODES.includes(record.mode)) {
    return resolution({ ...recordedKeys, admission_mode_reason: 'unknown-mode', admission_recorded_mode: record.mode });
  }
  if (keys.length !== 1 || keys[0] !== RECORD_KEY) {
    return resolution({ ...recordedKeys, admission_mode_reason: 'extra-key', admission_recorded_mode: record.mode });
  }
  return Object.freeze({ ...resolveAdmissionDecision(record.mode), admission_recorded_keys: keys });
}

// The decision, for callers that only need the effective mode.
export const isAdmissionClosed = resolution => resolution?.admission_mode === ADMISSION_MODE_CLOSED;

// Closure something can act on. Only a record that *says* closed proves it: a
// fail-closed read of a missing, malformed or extra-key value reads closed for
// admission but proves nothing, so a mutation fence must not treat it as consent.
export const isAdmissionProvablyClosed = resolution =>
  isAdmissionClosed(resolution) && resolution?.admission_mode_source === 'record';

// A mutation fence needs three answers, not two. The reader's admission decision
// may be fail-closed on an unreadable or malformed value, which is right for
// admission and wrong for a fence: a fence must refuse when closure is not
// *proven*, and must never treat one throttled read as consent.
//   closed   — the record proves effective closure (a `closed` record)
//   open     — the record is `testers`
//   unproven — unreadable, missing, malformed, unknown, extra-key or non-canonical
export function admissionClosureProof(resolution) {
  if (isAdmissionProvablyClosed(resolution)) return 'closed';
  return resolution?.admission_mode === ADMISSION_MODE_TESTERS ? 'open' : 'unproven';
}

export const admissionClock = io => (typeof io?.now === 'function' ? io.now() : Date.now());

// Read exactly the admission parameter. `ssm:GetParameter` is already in the
// runtime read set, so this needs no grant and no CDK change.
export async function readAdmissionMode(io) {
  const parameter = (await io.aws(['ssm', 'get-parameter', '--name', ADMISSION_MODE_PARAMETER])).Parameter;
  if (parameter?.Name !== undefined && parameter.Name !== ADMISSION_MODE_PARAMETER) throw new Error('Unexpected admission parameter identity');
  return parseAdmissionModeValue(parameter?.Value);
}

// The forward-migration fence for the standalone `migrate` operation. It refuses
// `open` and `unproven` alike, and records what it observed so a refusal is
// evidence.
export async function assertMigrationAdmissionClosed(io, label = 'the standalone migrate operation') {
  let admission;
  let cause;
  try { admission = await readAdmissionMode(io); }
  catch (error) { cause = error; }
  const proof = admission ? admissionClosureProof(admission) : 'unproven';
  io.recordAdmissionState?.({ phase: 'migration-fence', proof,
    state: admission ?? { admission_mode: 'unavailable', admission_mode_source: 'unavailable',
      admission_mode_reason: 'unavailable', admission_recorded_mode: 'unavailable',
      admission_recorded_keys: 'unavailable', tester_emails: [] },
    result: proof === 'closed' ? 'observed' : 'refused' });
  if (proof !== 'closed') {
    throw new Error(`Admission mirror does not prove closed admission; refusing ${label}: ${admission ? describeAdmissionMode(admission) : 'unreadable mirror'}`, { cause });
  }
  return admission;
}

// Redacted, bounded one-line description for operation evidence and errors. It
// names the effective decision and the recorded record separately, and never a
// bound because there is none.
export function describeAdmissionMode(resolution) {
  const mode = typeof resolution?.admission_mode === 'string' ? resolution.admission_mode : 'unavailable';
  const reason = resolution?.admission_mode_reason ? ` (${resolution.admission_mode_reason})` : '';
  const recorded = typeof resolution?.admission_recorded_mode === 'string' ? resolution.admission_recorded_mode : 'unavailable';
  const keys = Array.isArray(resolution?.admission_recorded_keys) ? resolution.admission_recorded_keys.join(',') : 'unavailable';
  return `admission_mode=${mode}${reason}, recorded_mode=${recorded}, recorded_keys=${keys}`;
}
