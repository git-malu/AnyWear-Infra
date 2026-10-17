import { canonicalJson, parseJson } from './json-contract.mjs';

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

export const admissionParameterNames = Object.freeze({
  admission_suspended: '/anywear/beta/admission_suspended',
  intake_open: '/anywear/beta/intake_open',
  tester_emails: '/anywear/beta/tester_allowlist',
});

export function unavailableAdmissionState() {
  return { admission_suspended: 'unavailable', intake_open: 'unavailable', tester_emails: 'unavailable' };
}

export function canonicalTesterList(value) {
  return parseJson(normalizeTesterEmails(canonicalJson(value)));
}

export async function readAdmissionState(io) {
  const entries = Object.entries(admissionParameterNames);
  // Read every field even when another read fails, so failure evidence preserves
  // the actual known values without converting missing/malformed values to false.
  const reads = await Promise.allSettled(entries.map(async ([key, name]) => {
    const parameter = (await io.aws(['ssm', 'get-parameter', '--name', name])).Parameter;
    if (parameter?.Name !== undefined && parameter.Name !== name) throw new Error('Unexpected admission parameter identity');
    const value = parameter?.Value;
    if (key === 'tester_emails') return parseJson(normalizeTesterEmails(value));
    if (value !== 'true' && value !== 'false') throw new Error('Admission parameter requires an exact boolean');
    return value === 'true';
  }));
  const state = unavailableAdmissionState();
  for (let index = 0; index < entries.length; index++) {
    if (reads[index].status === 'fulfilled') state[entries[index][0]] = reads[index].value;
  }
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
