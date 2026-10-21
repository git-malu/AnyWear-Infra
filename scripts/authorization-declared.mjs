import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The lint-produced declaration artifact: the Allow actions per reconciled role
// from the synthesized Foundation and Platform policy documents. It is generated
// and pinned by test/authorization-lint.test.ts. This module has no credential or
// driver dependency, so the credential-free record job can read it directly.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DECLARATION_FILE = path.join(root, 'test', 'fixtures', 'authorization-declared.json');

export async function loadDeclaredActions(file = DECLARATION_FILE) {
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  if (parsed?.record_type !== 'anywear_authorization_declared_actions' || !parsed.roles) {
    throw new Error('The declared authorization artifact has an unknown shape');
  }
  return parsed.roles;
}
