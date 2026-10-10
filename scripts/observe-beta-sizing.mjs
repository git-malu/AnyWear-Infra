import { retainedBetaSizingProfile, retainedBetaSizingTelemetry } from './beta-sizing-profile.mjs';

export function observeBetaSizing(stack, definitions) {
  const parameters = Object.fromEntries((stack.Parameters ?? []).map(row => [row.ParameterKey, row.ParameterValue]));
  const profile = retainedBetaSizingProfile(parameters);
  const telemetry = retainedBetaSizingTelemetry(parameters);
  const ecs = {};
  for (const purpose of ['api', 'worker']) {
    const definition = definitions[purpose];
    const container = definition?.containerDefinitions?.find(row => row.name === (purpose === 'api' ? 'ApiContainer' : 'WorkerContainer'));
    const values = container?.environment?.filter(row => row.name === 'BETA_SIZING_TELEMETRY') ?? [];
    // Absence is permitted only for the source predating the retained parameter.
    const legacyDisabled = parameters.BetaSizingTelemetry === undefined && values.length === 0 && telemetry === 'false';
    if (!legacyDisabled && (values.length !== 1 || values[0].value !== telemetry)) {
      throw new Error(`Observed ${purpose} telemetry differs from retained Beta parameter`);
    }
    const [cpu, memory] = purpose === 'worker' ? ['1024', '2048'] : profile === 's2-api' ? ['256', '512'] : ['512', '1024'];
    if (definition?.cpu !== cpu || definition.memory !== memory) throw new Error(`Observed ${purpose} size differs from retained Beta profile`);
    ecs[purpose] = { task_definition_arn: definition.taskDefinitionArn, cpu, memory,
      beta_sizing_telemetry: legacyDisabled ? 'absent-disabled' : values[0].value };
  }
  return { beta_api_sizing_profile: profile, beta_sizing_telemetry: telemetry, ecs };
}
