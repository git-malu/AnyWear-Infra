export type LegacyRoleSource = 'cdk' | 'external';

export function readLegacyRoleSource(value: unknown): LegacyRoleSource {
  if (value !== 'cdk' && value !== 'external') {
    throw new Error('Explicit legacyRoleSource=cdk|external is required');
  }
  return value;
}
