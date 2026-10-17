import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
const exists = name => existsSync(fileURLToPath(new URL(name, root)));
const packageJson = JSON.parse(read('package.json'));

test('the package identity is the reviewed name, version and tag', () => {
  assert.equal(packageJson.name, '@git-malu/stage-contracts');
  assert.equal(packageJson.version, '0.1.0');
  assert.equal(`stage-contracts-v${packageJson.version}`, 'stage-contracts-v0.1.0');
  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.license, 'UNLICENSED');
  assert.equal(packageJson.engines.node, '>=24');
  assert.equal(packageJson.publishConfig.registry, 'https://npm.pkg.github.com');
  assert.equal(packageJson.private, undefined);
});

test('the published files are exactly the plain ESM entrypoint, its types and the README', () => {
  assert.deepEqual(packageJson.files, ['index.mjs', 'index.d.ts', 'README.md']);
  assert.equal(packageJson.main, './index.mjs');
  assert.equal(packageJson.types, './index.d.ts');
  assert.deepEqual(packageJson.exports['.'], {
    types: './index.d.ts',
    import: './index.mjs',
    default: './index.mjs',
  });
  for (const file of [...packageJson.files, packageJson.main, packageJson.types,
    packageJson.exports['.'].types, packageJson.exports['.'].import, packageJson.exports['.'].default]) {
    assert.ok(exists(file), `Missing published file ${file}`);
  }
});

test('the package has no build step and no runtime dependency', () => {
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.peerDependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
  assert.equal(packageJson.scripts.test, 'node --test test/*.test.mjs');
  assert.equal(packageJson.scripts.pack, 'npm pack');
  const source = read('index.mjs');
  assert.ok(!/from\s+['"]aws-cdk-lib['"]/.test(source), 'The package must not import aws-cdk-lib');
  assert.ok(!/require\(\s*['"]aws-cdk-lib['"]\s*\)/.test(source), 'The package must not require aws-cdk-lib');
  assert.ok(!/from\s+['"]constructs['"]/.test(source), 'The package must not import constructs');
  assert.ok(source.includes("from 'node:crypto'"), 'The package may only use Node built-ins');
});
