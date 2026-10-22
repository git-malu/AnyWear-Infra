import { readFile } from 'node:fs/promises';
import { OBSERVED_SURFACE, validateObservedRecord } from './authorization-observed.mjs';
import { loadDeclaredActions } from './authorization-declared.mjs';

// Credential-free reader for the `record` job: validate exactly the artifact the
// credentialed deploy job produced against the lint-produced declaration. An
// observed action the IaC does not declare fails the run; declared-but-unused is
// printed for narrowing review.
const output = process.argv[2] ?? OBSERVED_SURFACE.artifact_path;
let raw;
try {
  raw = await readFile(output, 'utf8');
} catch (error) {
  if (error.code === 'ENOENT') {
    process.stdout.write(`No observed authorization artifact at ${output}; the observed layer produced none for this run.\n`);
    process.exit(0);
  }
  throw error;
}
const declaredByRole = await loadDeclaredActions();
const record = validateObservedRecord(JSON.parse(raw), declaredByRole);
if (record.window.minutes < OBSERVED_SURFACE.minimum_window_minutes) {
  throw new Error(`Observed window ${record.window.minutes} minutes is shorter than the required ${OBSERVED_SURFACE.minimum_window_minutes}`);
}
process.stdout.write(`Observed ${record.observed_actions.length} AWS action(s) over ${record.window.minutes} minutes; ${record.excluded_self_events} preflight/self event(s) excluded.\n`);
process.stdout.write(`Declared-but-unused (report-only, no narrowing): ${record.declared_but_unused_count} action(s).\n`);
for (const [role, actions] of Object.entries(record.declared_but_unused)) {
  if (actions.length) process.stdout.write(`${role}: ${actions.join(', ')}\n`);
}
