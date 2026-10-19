import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareTemplates } from './compare-templates.mjs';
import { platformStackName, recoveryFailureMessage, recoveryViolations, synthStage } from './recovery-contract.mjs';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => {
  if (index % 2 === 0) { assert.ok(value.startsWith('--') && args[index + 1], 'Options require --name value pairs');
    pairs.push([value.slice(2), args[index + 1]]); }
  return pairs;
}, []));
const repository = path.resolve(options.repository || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const baselineSnapshot = options['baseline-snapshot'] && path.resolve(options['baseline-snapshot']);
assert.ok(!(baselineSnapshot && options['baseline-repository']), 'Use one baseline source input');
const baselineRepository = baselineSnapshot ? path.join(baselineSnapshot, 'infra')
  : options['baseline-repository'] && path.resolve(options['baseline-repository']);
const baselineTemplates = options['baseline-templates'] && path.resolve(options['baseline-templates']);
assert.ok(!(baselineRepository && baselineTemplates), 'Use one baseline input');
const output = path.resolve(options.output || path.join(repository, 'cdk.matrix'));
assert.ok(options['artifact-directory'], '--artifact-directory is required');
const phases = options.phase ? [options.phase] : ['legacy', 'roles-added', 'retired'];
assert.ok(options['retention-protection'] === undefined || ['true', 'false'].includes(options['retention-protection']),
  '--retention-protection must be true or false');
const ecrImageRetention = options['retention-protection'] === 'true';
assert.ok(phases.every((phase) => ['legacy', 'roles-added', 'retired'].includes(phase)), 'Unknown identity phase');
const variants = [{ stage: 'dev' }, { stage: 'beta' }, { stage: 'prod' }];
const revision = (cwd) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
const source = { repository_sha: revision(repository), baseline_sha: baselineRepository && !baselineSnapshot && revision(baselineRepository) };
if (baselineSnapshot) {
  const snapshot = JSON.parse(readFileSync(path.join(baselineSnapshot, '.source-snapshot.json'), 'utf8'));
  assert.equal(snapshot.repository, 'git-malu/AnyWear-Service');
  assert.match(snapshot.source_sha, /^[a-f0-9]{40}$/);
  assert.match(snapshot.tree_sha, /^[a-f0-9]{40}$/);
  assert.match(snapshot.archive_sha256, /^[a-f0-9]{64}$/);
  for (const [file, hash] of Object.entries(snapshot.files)) {
    assert.ok(!path.isAbsolute(file) && file.split('/').every((part) => part && !['.', '..'].includes(part)), 'Safe source file');
    assert.equal(createHash('sha256').update(readFileSync(path.join(baselineSnapshot, file))).digest('hex'), hash,
      `Original source snapshot integrity: ${file}`);
  }
  source.baseline_sha = snapshot.source_sha;
  source.baseline_tree_sha = snapshot.tree_sha;
  source.baseline_archive_sha256 = snapshot.archive_sha256;
}
if (baselineTemplates) {
  const provenance = JSON.parse(readFileSync(path.join(baselineTemplates, 'provenance.json'), 'utf8'));
  assert.equal(provenance.repository, 'git-malu/AnyWear-Service', 'Baseline must retain Service provenance');
  assert.match(provenance.source_sha, /^[a-f0-9]{40}$/, 'Baseline source SHA');
  const cdkVersion = JSON.parse(readFileSync(path.join(repository, 'node_modules/aws-cdk-lib/package.json'), 'utf8')).version;
  assert.equal(provenance.cdk_version, cdkVersion, 'CDK version differs from the resource baseline');
  for (const [file, hash] of Object.entries(provenance.templates)) {
    // The release slice is Service's baseline; this repository's baseline set is
    // exactly the stack set this app still synthesizes.
    assert.match(file, /^(dev-active|beta-active|prod-active)\/AnyWear(?:Foundation|Platform|Billing)Stack(?:-(?:dev|beta|prod))?\.template\.json$/);
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(createHash('sha256').update(readFileSync(path.join(baselineTemplates, file))).digest('hex'), hash,
      `Baseline template integrity: ${file}`);
  }
  source.baseline_sha = provenance.source_sha;
  source.baseline_provenance = provenance;
}
if (baselineRepository && !baselineSnapshot) {
  // Never silently synthesize modified original CDK source as the baseline.
  execFileSync('git', ['diff', '--exit-code', '--', 'bin', 'lib', 'test', 'cdk.json', 'package-lock.json', 'package.json'],
    { cwd: baselineRepository, stdio: 'pipe' });
}
mkdirSync(output, { recursive: true });
function synth(cwd, directory, variant, phase, immutableInputs) {
  // The shared synthesis is what the pre-credential deployment check runs, so
  // the matrix and the deployment gate cannot drift into different shapes.
  return synthStage({ repository: cwd, directory, stage: variant.stage,
    inputs: immutableInputs ? { identityPhase: phase, ecrImageRetention, legacyRoleSource: 'cdk',
      artifactDirectory: path.resolve(options['artifact-directory']) } : undefined });
}
const reports = [];
for (const variant of variants) {
  const name = `${variant.stage}-active`;
  const baseline = baselineTemplates ? path.join(baselineTemplates, name) : path.join(output, 'baseline', name);
  if (baselineRepository) synth(baselineRepository, baseline, variant, 'legacy', false);
  for (const phase of phases) {
    const target = path.join(output, phase, name);
    const files = synth(repository, target, variant, phase, true);
    const platformTemplate = `${platformStackName(variant.stage)}.template.json`;
    assert.ok(files.includes(platformTemplate), `Missing ${platformTemplate} for ${name}/${phase}`);
    const violations = recoveryViolations(JSON.parse(readFileSync(path.join(target, platformTemplate), 'utf8')),
      { stage: variant.stage });
    if (violations.length) throw new Error(recoveryFailureMessage(violations,
      { stage: variant.stage, stackName: platformStackName(variant.stage) }));
    if (baselineRepository || baselineTemplates) {
      assert.deepEqual(files.sort(), readdirSync(baseline).filter((file) => file.endsWith('.template.json')).sort(), 'Stack set drift');
      for (const file of files) {
        reports.push(compareTemplates(JSON.parse(readFileSync(path.join(baseline, file), 'utf8')),
          JSON.parse(readFileSync(path.join(target, file), 'utf8')), {
            phase, stage: variant.stage, stackName: file.slice(0, -'.template.json'.length), ecrImageRetention,
          }));
      }
    }
  }
}
const report = { ...source, generated_at: new Date().toISOString(), variants, phases,
  comparison_kind: 'service-source-simulation', legacy_role_source: 'cdk',
  retention_protection: ecrImageRetention,
  accepted: reports.length ? reports.every((entry) => entry.accepted) : null, comparisons: reports };
writeFileSync(path.join(output, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ repository_sha: source.repository_sha, baseline_sha: source.baseline_sha,
  baseline_tree_sha: source.baseline_tree_sha, baseline_archive_sha256: source.baseline_archive_sha256,
  retention_protection: ecrImageRetention, accepted: report.accepted, comparisons: reports.length,
  allowed: reports.reduce((count, entry) => count + entry.allowed.length, 0),
  rejected: reports.flatMap((entry) => entry.rejected.map((difference) => ({ ...difference,
    phase: entry.phase, stage: entry.stage, stackName: entry.stackName }))), report: path.join(output, 'comparison.json') }, null, 2)}\n`);
if (report.accepted === false) process.exitCode = 1;
