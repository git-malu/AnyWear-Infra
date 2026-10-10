import { canonicalJson, sha256 } from './json-contract.mjs';
import { readAdmissionState } from './admission-operation.mjs';

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
  }
  const admission = await readAdmissionState(io);
  state.admission = { admission_suspended: admission.admission_suspended, intake_open: admission.intake_open,
    tester_count: admission.tester_emails.length, tester_emails_sha256: sha256(canonicalJson(admission.tester_emails)) };
  return state;
  } catch (cause) {
    const admission = cause.observedAdmissionState;
    if (admission) state.admission = { admission_suspended: admission.admission_suspended, intake_open: admission.intake_open,
      tester_count: Array.isArray(admission.tester_emails) ? admission.tester_emails.length : 'unavailable',
      tester_emails_sha256: Array.isArray(admission.tester_emails) ? sha256(canonicalJson(admission.tester_emails)) : 'unavailable' };
    const error = new Error('Complete Beta state observation unavailable', { cause });
    error.observedState = state;
    throw error;
  }
}
