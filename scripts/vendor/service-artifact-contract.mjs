import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';

export const SERVICE_REPOSITORY = 'git-malu/AnyWear-Service';
export const PUBLISHER_WORKFLOW = '.github/workflows/service-artifacts.yml';
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const FILE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CODE_HASH = /^[A-Za-z0-9+/]{43}=$/;
const fail = (message) => { throw new Error(message); };
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// JSON.parse silently accepts duplicate keys. Parse the grammar while checking every
// object before JSON.parse, including escaped aliases such as "a" and "\u0061".
export function parseStrictJson(bytes) {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let offset = 0;
  const whitespace = () => { while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++; };
  const string = () => {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '\\') offset++;
      else if (char === '"') return JSON.parse(text.slice(start, offset));
    }
    fail('unterminated JSON string');
  };
  const value = () => {
    whitespace();
    if (text[offset] === '"') return string();
    if (text[offset] === '{') {
      offset++; whitespace();
      const keys = new Set();
      if (text[offset] === '}') { offset++; return; }
      for (;;) {
        whitespace();
        if (text[offset] !== '"') fail('JSON object key required');
        const key = string();
        if (keys.has(key)) fail(`duplicate JSON key: ${key}`);
        keys.add(key); whitespace();
        if (text[offset++] !== ':') fail('JSON colon required');
        value(); whitespace();
        const next = text[offset++];
        if (next === '}') return;
        if (next !== ',') fail('JSON object delimiter required');
      }
    }
    if (text[offset] === '[') {
      offset++; whitespace();
      if (text[offset] === ']') { offset++; return; }
      for (;;) {
        value(); whitespace();
        const next = text[offset++];
        if (next === ']') return;
        if (next !== ',') fail('JSON array delimiter required');
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(offset));
    if (!match) fail('invalid JSON value');
    offset += match[0].length;
  };
  value(); whitespace();
  if (offset !== text.length) fail('unexpected trailing JSON content');
  const parsed = JSON.parse(text);
  canonicalJson(parsed); // Reject non-I-JSON numbers and lone UTF-16 surrogates.
  return parsed;
}

// RFC 8785: ECMAScript number/string serialization and UTF-16 key ordering.
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('non-finite JSON number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail('lone JSON surrogate');
      } else if (c >= 0xdc00 && c <= 0xdfff) fail('lone JSON surrogate');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('plain JSON value required');
  return `{${Object.keys(value).sort().map((key) => `${canonicalJson(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
export const contentSha256 = (value) => sha256(canonicalJson(value));

export function exactKeys(value, required, optional = [], label = 'object') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  for (const key of Object.keys(value)) if (![...required, ...optional].includes(key)) fail(`unknown ${label}.${key}`);
}
export function requirePattern(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`invalid ${label}`);
}
export function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`invalid ${label}`);
}
export function validateProducer(producer) {
  exactKeys(producer, ['repository', 'workflow_sha', 'workflow_ref', 'run_id', 'run_attempt'], [], 'producer');
  if (producer.repository !== SERVICE_REPOSITORY) fail('unexpected producer repository');
  requirePattern(producer.workflow_sha, SHA, 'producer.workflow_sha');
  if (producer.workflow_ref !== `${SERVICE_REPOSITORY}/${PUBLISHER_WORKFLOW}@refs/heads/main`) fail('untrusted publisher workflow_ref');
  positiveInteger(producer.run_id, 'producer.run_id');
  positiveInteger(producer.run_attempt, 'producer.run_attempt');
}
function originalEvidence(component, lambda = false) {
  const value = component.original_evidence;
  exactKeys(value, ['repository', 'source_sha', 'workflow_ref', 'run_id', 'run_attempt', 'job_id', 'run_conclusion', 'job_conclusion', 'artifact_phase'], lambda ? ['deployed'] : [], 'original_evidence');
  if (value.repository !== SERVICE_REPOSITORY || value.source_sha !== component.service_sha) fail('original component source mismatch');
  requirePattern(value.source_sha, SHA, 'original source');
  requirePattern(value.workflow_ref, /^git-malu\/AnyWear-Service\/\.github\/workflows\/[a-z0-9-]+\.yml@refs\/heads\/main$/, 'original workflow');
  for (const field of ['run_id', 'run_attempt', 'job_id']) positiveInteger(value[field], field);
  if (!['success', 'failure'].includes(value.run_conclusion) || !['success', 'failure'].includes(value.job_conclusion)) fail('original run/job outcome required');
  exactKeys(value.artifact_phase, ['name', 'conclusion', 'log_sha256', 'start_line', 'end_line', 'log_excerpt'], [], 'original artifact phase');
  requirePattern(value.artifact_phase.name, /^[a-z][a-z0-9-]+$/, 'artifact phase name');
  if (value.artifact_phase.conclusion !== 'success') fail('successful original artifact phase required');
  requirePattern(value.artifact_phase.log_sha256, HASH, 'original raw job log hash');
  positiveInteger(value.artifact_phase.start_line, 'phase start line'); positiveInteger(value.artifact_phase.end_line, 'phase end line');
  if (value.artifact_phase.end_line < value.artifact_phase.start_line) fail('invalid artifact phase log range');
  if (typeof value.artifact_phase.log_excerpt !== 'string' || !value.artifact_phase.log_excerpt || value.artifact_phase.log_excerpt.length > 64 * 1024) fail('bounded original phase log excerpt required');
  if (lambda) {
    exactKeys(value.deployed, ['repository', 'source_sha', 'workflow_ref', 'run_id', 'run_attempt', 'job_id', 'run_conclusion', 'job_conclusion', 'stack_name', 'template_sha256', 'asset_bucket', 'asset_key', 'code_sha256'], [], 'original deployed Lambda');
    if (value.deployed.repository !== SERVICE_REPOSITORY) fail('original deploy repository mismatch');
    requirePattern(value.deployed.source_sha, SHA, 'independent original deploy source');
    requirePattern(value.deployed.workflow_ref, /^git-malu\/AnyWear-Service\/\.github\/workflows\/[a-z0-9-]+\.yml@refs\/heads\/main$/, 'original deploy workflow');
    for (const field of ['run_id', 'run_attempt', 'job_id']) positiveInteger(value.deployed[field], `deployed.${field}`);
    if (!['success', 'failure'].includes(value.deployed.run_conclusion) || value.deployed.job_conclusion !== 'success') fail('successful original deployment job required; preserve actual overall outcome');
    requirePattern(value.deployed.stack_name, /^AnyWearPlatformStack-(beta|prod)$/, 'original stack');
    requirePattern(value.deployed.template_sha256, HASH, 'original template hash');
    requirePattern(value.deployed.asset_bucket, /^[a-z0-9][a-z0-9.-]+$/, 'original asset bucket');
    requirePattern(value.deployed.asset_key, /^[a-f0-9]{64}\.zip$/, 'original asset key');
    if (value.deployed.code_sha256 !== component.code_sha256) fail('original Lambda CodeSha mismatch');
  }
}
export const SOURCE_BUILD_OPTIONS = Object.freeze({
  bundle: true, platform: 'node', target: 'node24', format: 'cjs', minify: true,
  sourcemap: 'external', packages: 'bundle', external: [],
});

export function validateManifest(manifest) {
  exactKeys(manifest, ['schema_version', 'record_type', 'kind', 'producer', 'components'], [], 'manifest');
  if (manifest.schema_version !== 1 || manifest.record_type !== 'anywear_service_artifacts') fail('unknown Service manifest version/type');
  if (!['source-build', 'deployed-baseline-import'].includes(manifest.kind)) fail('unknown artifact kind');
  validateProducer(manifest.producer);
  exactKeys(manifest.components, ['image', 'lambdas', 'runtime_policy', 'schema'], [], 'components');
  exactKeys(manifest.components.lambdas, ['pre_sign_up', 'post_confirmation'], [], 'lambdas');
  const imported = manifest.kind === 'deployed-baseline-import';
  const optional = imported ? ['original_evidence'] : [];
  const image = manifest.components.image;
  exactKeys(image, ['service_sha', 'repository_uri', 'digest'], optional, 'image');
  requirePattern(image.repository_uri, /^650880818323\.dkr\.ecr\.ap-east-1\.amazonaws\.com\/[a-z0-9][a-z0-9/_-]+$/, 'image repository_uri');
  requirePattern(image.digest, DIGEST, 'image.digest');
  if (!imported && image.service_sha !== manifest.producer.workflow_sha) fail('source-build image differs from publisher source');
  const files = [];
  for (const [name, component] of Object.entries(manifest.components.lambdas)) {
    exactKeys(component, ['service_sha', 'file', 'sha256', 'code_sha256', 'handler', 'runtime', 'source_lock_sha256', 'bundler_version', 'build_options'], optional, `lambda.${name}`);
    if (component.handler !== 'index.handler' || component.runtime !== 'nodejs24.x') fail('unsupported Lambda handler/runtime');
    requirePattern(component.code_sha256, CODE_HASH, 'Lambda CodeSha');
    if (Buffer.from(component.sha256, 'hex').toString('base64') !== component.code_sha256) fail('Lambda file hash / CodeSha mismatch');
    requirePattern(component.source_lock_sha256, HASH, 'Lambda source lock hash');
    requirePattern(component.bundler_version, /^esbuild@\d+\.\d+\.\d+$/, 'bundler_version');
    exactKeys(component.build_options, Object.keys(SOURCE_BUILD_OPTIONS), [], 'build_options');
    const options = component.build_options;
    if (options.bundle !== true || options.platform !== 'node' || options.target !== 'node24' || options.format !== 'cjs' || typeof options.minify !== 'boolean' || !['external', 'linked'].includes(options.sourcemap) || options.packages !== 'bundle' || !Array.isArray(options.external) || options.external.some((v) => typeof v !== 'string' || !v)) fail('invalid Lambda build options');
    if (!imported && (component.bundler_version !== 'esbuild@0.28.0' || canonicalJson(options) !== canonicalJson(SOURCE_BUILD_OPTIONS))) fail('unexpected source-build toolchain/options');
    files.push(component.file);
  }
  const policy = manifest.components.runtime_policy;
  exactKeys(policy, ['service_sha', 'file', 'sha256', 'content_sha256'], optional, 'runtime_policy');
  requirePattern(policy.content_sha256, HASH, 'policy content hash');
  const schema = manifest.components.schema;
  exactKeys(schema, ['service_sha', 'file', 'sha256', 'journal_sha256', 'current_version', 'minimum_version'], optional, 'schema');
  requirePattern(schema.journal_sha256, HASH, 'schema journal hash');
  positiveInteger(schema.current_version, 'current_version'); positiveInteger(schema.minimum_version, 'minimum_version');
  if (schema.minimum_version > schema.current_version) fail('minimum schema exceeds current schema');
  files.push(policy.file, schema.file);
  const components = [image, ...Object.values(manifest.components.lambdas), policy, schema];
  for (const component of components) {
    requirePattern(component.service_sha, SHA, 'component source');
    if (!imported && component.service_sha !== image.service_sha) fail('source-build components differ');
    if (component !== image) {
      requirePattern(component.file, FILE, 'component file'); requirePattern(component.sha256, HASH, 'component hash');
      if (component.file === 'service-artifacts.json') fail('reserved manifest asset name');
    }
    if (imported) originalEvidence(component, Object.hasOwn(component, 'code_sha256'));
  }
  if (new Set(files).size !== files.length) fail('duplicate component asset file');
  return manifest;
}

export function validateSchemaAsset(asset) {
  exactKeys(asset, ['schema_version', 'record_type', 'current_version', 'minimum_version', 'minimum_migration_count', 'journal', 'migrations'], [], 'schema asset');
  if (asset.schema_version !== 1 || asset.record_type !== 'anywear_service_schema') fail('unknown schema asset version');
  positiveInteger(asset.current_version, 'current_version'); positiveInteger(asset.minimum_version, 'minimum_version');
  if (asset.minimum_version > asset.current_version) fail('invalid schema compatibility versions');
  exactKeys(asset.journal, ['version', 'dialect', 'entries'], [], 'journal');
  if (asset.journal.version !== '7' || asset.journal.dialect !== 'postgresql' || !Array.isArray(asset.journal.entries) || !Array.isArray(asset.migrations) || asset.migrations.length !== asset.journal.entries.length || !asset.migrations.length) fail('invalid migration journal');
  positiveInteger(asset.minimum_migration_count, 'minimum migration count');
  if (asset.minimum_migration_count > asset.migrations.length || asset.current_version === asset.minimum_version && asset.minimum_migration_count !== asset.migrations.length) fail('invalid minimum migration boundary');
  const tags = new Set(); let prior = 0;
  asset.journal.entries.forEach((entry, index) => {
    exactKeys(entry, ['idx', 'version', 'when', 'tag', 'breakpoints'], [], 'journal entry');
    if (entry.idx !== index || entry.version !== '7' || typeof entry.breakpoints !== 'boolean') fail('invalid journal entry');
    positiveInteger(entry.when, 'migration time');
    requirePattern(entry.tag, /^\d{4}_[a-z0-9_]+$/, 'migration tag');
    if (tags.has(entry.tag) || entry.when <= prior) fail('duplicate/unordered migration journal');
    tags.add(entry.tag); prior = entry.when;
    const migration = asset.migrations[index];
    exactKeys(migration, ['id', 'idx', 'created_at', 'sha256'], [], 'migration');
    if (migration.id !== entry.tag || migration.idx !== index || migration.created_at !== entry.when) fail('journal/migration mismatch');
    requirePattern(migration.sha256, HASH, 'migration SQL hash');
  });
  return asset;
}

export function validateRuntimePolicy(policy) {
  exactKeys(policy, ['vto', 'auto-tagging'], [], 'runtime policy');
  const fields = ['queueVisibilitySeconds', 'receiveVisibilitySeconds', 'dbLeaseMs', 'sqsHeartbeatMs', 'retryDelayBaseMs', 'retryDelayMaxMs', 'outboxRetryDelayMs', 'outboxMaxAttempts', 'maxAttempts', 'maxReceives', 'terminalRedriveSeconds'];
  for (const [name, entry] of Object.entries(policy)) {
    exactKeys(entry, fields, [], `policy.${name}`);
    for (const field of fields) positiveInteger(entry[field], `policy.${name}.${field}`);
    if (entry.receiveVisibilitySeconds > entry.queueVisibilitySeconds || entry.dbLeaseMs <= entry.receiveVisibilitySeconds * 1_000 || entry.sqsHeartbeatMs >= entry.receiveVisibilitySeconds * 1_000 || entry.retryDelayMaxMs < entry.retryDelayBaseMs || entry.outboxRetryDelayMs < entry.retryDelayBaseMs || entry.maxReceives < entry.maxAttempts * 3 || entry.terminalRedriveSeconds > entry.receiveVisibilitySeconds) fail(`incompatible runtime policy ${name}`);
  }
  return policy;
}

export function verifyAssetBytes(manifest, assets) {
  validateManifest(manifest);
  const components = [...Object.values(manifest.components.lambdas), manifest.components.runtime_policy, manifest.components.schema];
  exactKeys(assets, components.map((component) => component.file), [], 'assets');
  for (const component of components) if (sha256(assets[component.file]) !== component.sha256) fail(`tampered asset ${component.file}`);
  const policy = validateRuntimePolicy(parseStrictJson(assets[manifest.components.runtime_policy.file]));
  if (contentSha256(policy) !== manifest.components.runtime_policy.content_sha256) fail('policy content mismatch');
  const schema = validateSchemaAsset(parseStrictJson(assets[manifest.components.schema.file]));
  if (contentSha256(schema.journal) !== manifest.components.schema.journal_sha256 || schema.current_version !== manifest.components.schema.current_version || schema.minimum_version !== manifest.components.schema.minimum_version) fail('schema manifest mismatch');
  return { policy, schema };
}

export function minimumMigrationCount(journal, currentVersion, minimumVersion, boundary) {
  if (boundary === undefined && currentVersion === minimumVersion) return journal.entries.length;
  const index = journal.entries.findIndex((entry) => entry.tag === boundary);
  if (index < 0) fail('explicit minimum schema migration boundary required');
  return index + 1;
}

export function assertSchemaCompatibility(selected, applied, appliedVersion, minimumVersion, minimumCount = selected?.length) {
  positiveInteger(appliedVersion, 'applied schema version'); positiveInteger(minimumVersion, 'minimum schema version');
  positiveInteger(minimumCount, 'minimum migration count');
  if (appliedVersion < minimumVersion || !Array.isArray(selected) || !selected.length || minimumCount > selected.length || !Array.isArray(applied) || applied.length < minimumCount) fail('incompatible applied schema');
  for (const [name, migrations] of [['selected', selected], ['applied', applied]]) {
    let prior = 0;
    for (const migration of migrations) {
      exactKeys(migration, ['id', 'created_at'], [], `${name} migration`);
      requirePattern(migration.id, HASH, `${name} SQL hash`); positiveInteger(migration.created_at, `${name} migration time`);
      if (migration.created_at <= prior) fail(`unordered/duplicate ${name} migration`);
      prior = migration.created_at;
    }
  }
  selected.slice(0, applied.length).forEach((migration, index) => {
    if (canonicalJson(migration) !== canonicalJson(applied[index])) fail(`migration identity mismatch at ${index}`);
  });
  return 'compatible';
}
