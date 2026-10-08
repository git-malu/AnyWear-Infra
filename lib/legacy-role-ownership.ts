export type LegacyRoleOwnership = 'managed' | 'external';

export function readLegacyRoleOwnership(value: unknown): LegacyRoleOwnership {
  if (value !== 'managed' && value !== 'external') {
    throw new Error('Explicit legacyRoleOwnership=managed|external is required');
  }
  return value;
}
