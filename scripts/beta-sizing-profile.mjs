const profiles = new Set(['s1', 's2-api']);

// Sizing is a release-slice parameter. Since #158 step C it is set and changed by
// AnyWear-Service's release chain; Infra only reads the retained values when it
// reports Beta state, so a missing parameter reads as the source default.
export function retainedBetaSizingProfile(parameters) {
  // The pre-profile source has the fixed S1 512/1024 pair.
  const observed = parameters.BetaApiSizingProfile === undefined ? 's1' : parameters.BetaApiSizingProfile;
  if (!profiles.has(observed)) throw new Error('Unknown retained Beta API sizing profile');
  return observed;
}

export function retainedBetaSizingTelemetry(parameters) {
  // Before this parameter, Service telemetry was disabled by default.
  const observed = parameters.BetaSizingTelemetry === undefined ? 'false' : parameters.BetaSizingTelemetry;
  if (!['false', 'true'].includes(observed)) throw new Error('Unknown retained Beta sizing telemetry');
  return observed;
}
