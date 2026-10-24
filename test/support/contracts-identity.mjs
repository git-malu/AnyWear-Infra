// Generator for the committed contract identity fixture.
//
// `test/fixtures/contracts-v0.7.0-identity.json` records the identity of the
// retired stage-contract package's 0.7.0 producer and the values this repository
// now ships from `lib/contracts.mjs` and `lib/contracts.d.mts`. The fixture is
// historical evidence: it is the only place the producer's tag, paths and
// digests are written down, and `test/contracts/identity.test.mjs` proves the
// shipped bytes against it without network access or Git history.
//
// The static provenance members (producer tag/ref/commit/paths, the declared
// rewrites and the note) are reviewed content and are preserved as written. The
// measured members are recomputed from the shipped module. Run this generator
// after an intentional contract change and review the fixture delta:
//
//   node test/support/contracts-identity.mjs
//
// The canonical serialisation is the discipline the retired package tests used:
// object keys sorted, scalars through `JSON.stringify`, arrays in order.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CONTRACTS_MODULE = new URL('../../lib/contracts.mjs', import.meta.url);
export const CONTRACTS_DECLARATIONS = new URL('../../lib/contracts.d.mts', import.meta.url);
export const IDENTITY_FIXTURE = new URL('../fixtures/contracts-v0.7.0-identity.json', import.meta.url);

// The record/gate surface retired before the package itself: the seven names the
// retired package's surface test proved absent must stay absent.
export const ABSENT_NAMES = Object.freeze([
  'DEPLOYMENT_RECORD_MEMBERS',
  'SERVICE_DEPLOYMENT_RECORD_SCHEMA',
  'validateServiceDeploymentRecord',
  'validateDeploymentGate',
  'validateSchemaBoundary',
  'schemaBoundaryPrefixHash',
  'DEPLOYMENT_GATE_FIELDS',
]);

/** RFC 8785-style canonical JSON: sorted keys, `JSON.stringify` scalars, ordered arrays. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every value export with its kind and, for a constant, its canonical value. */
export function exportSurface(contracts) {
  return Object.keys(contracts).sort().map((name) => {
    const value = contracts[name];
    const kind = typeof value === 'function' ? 'function' : 'constant';
    return { name, kind, value: kind === 'function' ? null : value };
  });
}

/** The measured members of the fixture, recomputed from the shipped module. */
export function measure(contracts) {
  const names = Object.keys(contracts).sort();
  const constants = names.filter(name => typeof contracts[name] !== 'function');
  const functions = names.filter(name => typeof contracts[name] === 'function');
  return {
    export_names: names,
    constant_names: constants,
    function_names: functions,
    canonical_export_sha256: sha256(canonical(exportSurface(contracts))),
    counts: {
      parameters: contracts.STAGE_CONTRACT_PARAMETERS.length,
      conditional_parameters: contracts.STAGE_CONTRACT_CONDITIONAL_PARAMETERS.length,
      read_parameters: contracts.STAGE_CONTRACT_READ_PARAMETERS.length,
    },
    bake: {
      duration_seconds: contracts.DEPLOYMENT_GATE_DURATION_SECONDS,
      probe_interval_seconds: contracts.DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS,
      max_probes: contracts.DEPLOYMENT_GATE_MAX_PROBES,
      request_floor: contracts.DEPLOYMENT_GATE_REQUEST_FLOOR,
    },
    service_runtime_stack_sha256: sha256(canonical(contracts.SERVICE_RUNTIME_STACK)),
    thresholds_sha256: sha256(canonical(contracts.DEPLOYMENT_GATE_THRESHOLDS)),
  };
}

function rewrite(text, rewrites, direction) {
  let result = text;
  for (const { from, to } of rewrites) {
    const search = direction === 'forward' ? from : to;
    const replacement = direction === 'forward' ? to : from;
    const index = result.indexOf(search);
    if (index < 0) throw new Error(`Declared rewrite target is absent (${direction})`);
    if (result.indexOf(search, index + search.length) >= 0) throw new Error('Declared rewrite target is not unique');
    result = `${result.slice(0, index)}${replacement}${result.slice(index + search.length)}`;
  }
  return result;
}

/** Apply the declared comment rewrites to producer bytes. */
export function applyRewrites(bytes, rewrites) {
  return rewrite(bytes, rewrites, 'forward');
}

/** Reverse the declared comment rewrites back to producer bytes. */
export function reverseRewrites(bytes, rewrites) {
  return rewrite(bytes, rewrites, 'reverse');
}

/** The declared rewrites that apply to one destination file. */
export function rewritesFor(fixture, file) {
  return fixture.declared_rewrites.filter(rewrite => rewrite.file === file);
}

export function readFixture() {
  return JSON.parse(readFileSync(IDENTITY_FIXTURE, 'utf8'));
}

/** Preserve the reviewed producer record and replace only the measured members. */
export function buildFixture(existing, contracts) {
  return {
    note: existing.note,
    recorded_at: existing.recorded_at,
    producer_tag: existing.producer_tag,
    producer_ref: existing.producer_ref,
    producer_ref_kind: existing.producer_ref_kind,
    producer_commit: existing.producer_commit,
    producer_commit_kind: existing.producer_commit_kind,
    producer_paths: existing.producer_paths,
    producer_sha256: existing.producer_sha256,
    producer_bytes: existing.producer_bytes,
    declared_rewrites: existing.declared_rewrites,
    ...measure(contracts),
    absent_names: [...ABSENT_NAMES],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = buildFixture(readFixture(), await import(CONTRACTS_MODULE.href));
  writeFileSync(IDENTITY_FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${fileURLToPath(IDENTITY_FIXTURE)}`);
}
