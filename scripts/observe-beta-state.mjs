import { canonicalJson, sha256 } from './json-contract.mjs';
import { readAdmissionState } from './admission-operation.mjs';
import { retainedBetaSizingProfile, retainedBetaSizingTelemetry } from './beta-sizing-profile.mjs';

const unavailable = value => (value === undefined ? 'unavailable' : value);

// The admission mirror is self-describing: the mode, its recorded key set and
// where the decision came from are all observed fields, so a fail-closed read
// never looks like an observed closure. There is no bound field to report.
function admissionEvidence(admission) {
  const testers = admission?.tester_emails;
  return { admission_mode: unavailable(admission?.admission_mode),
    admission_mode_source: unavailable(admission?.admission_mode_source),
    admission_mode_reason: unavailable(admission?.admission_mode_reason),
    admission_recorded_mode: unavailable(admission?.admission_recorded_mode),
    admission_recorded_keys: unavailable(admission?.admission_recorded_keys),
    tester_count: Array.isArray(testers) ? testers.length : 'unavailable',
    tester_emails_sha256: Array.isArray(testers) ? sha256(canonicalJson(testers)) : 'unavailable' };
}

// This records infrastructure/SSM state only; it cannot establish DB/schema equality.
export async function observeBetaState(io) {
  const stacks = [];
  const state = { schema_version: 1, record_type: 'anywear_infra_state', stacks, qualification: 'not-applicable' };
  try {
  for (const name of ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta']) {
    const stack = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', name])).Stacks?.[0];
    if (stack?.StackName !== name || typeof stack.StackStatus !== 'string') throw new Error('Beta state stack identity unavailable');
    stacks.push({ stack_name: name, status: stack.StackStatus,
      beta_active: stack.Outputs?.find(row => row.OutputKey === 'BetaActive')?.OutputValue ?? 'unavailable' });
    if (name === 'AnyWearWorkloadStack-beta') {
      const parameters = Object.fromEntries((stack.Parameters ?? []).map(row => [row.ParameterKey, row.ParameterValue]));
      state.beta_sizing = { beta_api_sizing_profile: retainedBetaSizingProfile(parameters),
        beta_sizing_telemetry: retainedBetaSizingTelemetry(parameters), runtime_verification: 'not-applicable' };
    }
  }
  state.admission = admissionEvidence(await readAdmissionState(io));
  return state;
  } catch (cause) {
    // The shared reader preserves each independently known field even when another
    // SSM value is unreadable. Never retain raw tester addresses.
    state.admission = admissionEvidence(cause.observedAdmissionState);
    const error = new Error('Complete Beta state observation unavailable', { cause });
    error.observedState = state;
    throw error;
  }
}
