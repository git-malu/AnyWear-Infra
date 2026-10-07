export type IdentityPhase = 'legacy' | 'roles-added' | 'retired';

// The default is deliberately the deployed Service-era authorization state.
// A later phase requires the separately recorded release and writer gate.
export function readIdentityPhase(value: unknown): IdentityPhase {
  if (value === undefined) return 'legacy';
  if (value === 'legacy' || value === 'roles-added' || value === 'retired') return value;
  throw new Error('identityPhase must be legacy, roles-added or retired');
}
