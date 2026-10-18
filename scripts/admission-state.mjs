import { canonicalJson, parseJson } from './json-contract.mjs';
import { ADMISSION_MODE_PARAMETER, isAdmissionProvablyClosed, parseAdmissionModeValue } from './admission-mode.mjs';

// The tester allowlist is itself an admission parameter, so its canonical form
// lives here with the rest of the admission state. `tester-allowlist.mjs`
// re-exports it, which lets the admission reader and the tester operation share
// one normalization without importing each other.
export function normalizeTesterEmails(bytes) {
  const emails = parseJson(bytes);
  if (!Array.isArray(emails) || emails.length > 50 || emails.some(email => typeof email !== 'string')) throw new Error('At most 50 exact tester emails required');
  const normalized = [...new Set(emails.map(email => email.trim().toLowerCase()))].sort();
  if (normalized.some(email => email.length > 254 || email.includes('*') || !/^[a-z0-9.!#$%&'+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email))) throw new Error('Exact tester email required');
  const payload = canonicalJson(normalized);
  if (Buffer.byteLength(payload) > 4096) throw new Error('Tester list exceeds SSM capacity');
  return payload;
}

// One mode record and the tester allowlist. The record is one key with one of two
// mode words and carries no bound, so there is no second admission value — and no
// clock — to disagree with it. Opening never changes the tester list.
export const admissionParameterNames = Object.freeze({
  admission_mode: ADMISSION_MODE_PARAMETER,
  tester_emails: '/anywear/beta/tester_allowlist',
});

export function unavailableAdmissionState() {
  return { admission_mode: 'unavailable', admission_mode_source: 'unavailable',
    admission_mode_reason: 'unavailable', admission_recorded_mode: 'unavailable',
    admission_recorded_keys: 'unavailable', tester_emails: 'unavailable' };
}

export function canonicalTesterList(value) {
  return parseJson(normalizeTesterEmails(canonicalJson(value)));
}

export async function readAdmissionState(io) {
  const entries = Object.entries(admissionParameterNames);
  // Read every field even when another read fails, so failure evidence preserves
  // the actual known values without converting missing/malformed values to false.
  // A mode value that is present but cannot prove closure is not a failed read:
  // the shared parser resolves it closed, fail-closed, with its reason kept.
  const reads = await Promise.allSettled(entries.map(async ([key, name]) => {
    const parameter = (await io.aws(['ssm', 'get-parameter', '--name', name])).Parameter;
    if (parameter?.Name !== undefined && parameter.Name !== name) throw new Error('Unexpected admission parameter identity');
    if (key === 'tester_emails') return parseJson(normalizeTesterEmails(parameter?.Value));
    return parseAdmissionModeValue(parameter?.Value);
  }));
  const state = unavailableAdmissionState();
  // `admissionParameterNames` is ordered: the mode record contributes its named
  // fields and observed key list, and the tester list contributes its normalized
  // array.
  if (reads[0].status === 'fulfilled') Object.assign(state, reads[0].value);
  if (reads[1].status === 'fulfilled') state.tester_emails = reads[1].value;
  if (reads.some(read => read.status === 'rejected')) {
    const error = new Error('Complete valid Beta admission state unavailable');
    error.observedAdmissionState = state;
    throw error;
  }
  return state;
}

// Evidence-only reads must record what was actually observed without turning a
// failed read into a failed operation. Sanitized unavailable fields keep the
// difference between "closed" and "unreadable" visible in the record.
export async function observeAdmissionState(io) {
  try {
    return { state: await readAdmissionState(io), result: 'observed' };
  } catch (error) {
    return { state: error.observedAdmissionState ?? unavailableAdmissionState(), result: 'unavailable' };
  }
}

// Closure that a mutating fence can act on. It refuses an unreadable mirror and a
// mirror whose value cannot prove closure; only a `closed` record this repository
// wrote proves it. Nothing closes on its own, so there is no elapsed-time case to
// accept.
export function assertProvableAdmissionClosure(state, message) {
  if (!isAdmissionProvablyClosed(state)) {
    throw new Error(`${message}: ${state?.admission_mode ?? 'unavailable'} (${state?.admission_mode_reason ?? 'unreadable'})`);
  }
  return state;
}
