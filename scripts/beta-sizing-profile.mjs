const profiles = new Set(['s1', 's2-api']);

export function validateBetaSizingInput(env) {
  const requested = env.INFRA_BETA_API_SIZING_PROFILE === undefined ? 'preserve' : env.INFRA_BETA_API_SIZING_PROFILE;
  if (requested !== 'preserve' && !profiles.has(requested)) throw new Error('Invalid Beta API sizing profile');
  if (requested !== 'preserve' && env.INFRA_OPERATION !== 'deploy-workload') {
    throw new Error('Explicit Beta API sizing is restricted to deploy-workload');
  }
  return requested;
}

export function retainedBetaSizingProfile(parameters) {
  // The pre-profile source has the fixed S1 512/1024 pair.
  const observed = parameters.BetaApiSizingProfile === undefined ? 's1' : parameters.BetaApiSizingProfile;
  if (!profiles.has(observed)) throw new Error('Unknown retained Beta API sizing profile');
  return observed;
}

export function selectBetaSizingProfile(parameters, env, active) {
  const observed = retainedBetaSizingProfile(parameters);
  const requested = validateBetaSizingInput(env);
  if (typeof active !== 'boolean') throw new Error('Explicit observed Beta activity required for sizing');
  if (requested !== 'preserve' && !active) throw new Error('Explicit sizing requires already-active Beta');
  return requested === 'preserve' ? observed : requested;
}

export function validateBetaTelemetryInput(env) {
  const requested = env.INFRA_BETA_SIZING_TELEMETRY === undefined ? 'preserve' : env.INFRA_BETA_SIZING_TELEMETRY;
  if (!['preserve', 'enable', 'disable'].includes(requested)) throw new Error('Invalid Beta sizing telemetry input');
  if (requested !== 'preserve' && env.INFRA_OPERATION !== 'deploy-workload') {
    throw new Error('Explicit Beta sizing telemetry is restricted to deploy-workload');
  }
  return requested;
}

export function retainedBetaSizingTelemetry(parameters) {
  // Before this parameter, Service telemetry was disabled by default.
  const observed = parameters.BetaSizingTelemetry === undefined ? 'false' : parameters.BetaSizingTelemetry;
  if (!['false', 'true'].includes(observed)) throw new Error('Unknown retained Beta sizing telemetry');
  return observed;
}

export function selectBetaSizingTelemetry(parameters, env, active) {
  const observed = retainedBetaSizingTelemetry(parameters);
  const requested = validateBetaTelemetryInput(env);
  if (typeof active !== 'boolean') throw new Error('Explicit observed Beta activity required for telemetry');
  if (requested !== 'preserve' && !active) throw new Error('Explicit telemetry requires already-active Beta');
  return requested === 'preserve' ? observed : requested === 'enable' ? 'true' : 'false';
}

export function betaSizingChangeRequested(env) {
  const profile = validateBetaSizingInput(env);
  const telemetry = validateBetaTelemetryInput(env);
  return profile !== 'preserve' || telemetry !== 'preserve';
}

export function selectBetaSizingParameters(parameters, env, active) {
  return { ...parameters, BetaApiSizingProfile: selectBetaSizingProfile(parameters, env, active),
    BetaSizingTelemetry: selectBetaSizingTelemetry(parameters, env, active) };
}
