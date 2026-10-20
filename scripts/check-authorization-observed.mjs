import { readFile } from 'node:fs/promises';
import { OBSERVED_SURFACE } from './authorization-inventory.mjs';
import { validateObservedRecord } from './authorization-observed.mjs';

// Credential-free reader for the `record` job: validate exactly the artifact the
// credentialed deploy job produced. An observed action outside the declared
// surface fails the run; declared-but-unused is printed for narrowing review.
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
const record = validateObservedRecord(JSON.parse(raw));
if (record.window.minutes < OBSERVED_SURFACE.minimum_window_minutes) {
  throw new Error(`Observed window ${record.window.minutes} minutes is shorter than the required ${OBSERVED_SURFACE.minimum_window_minutes}`);
}
process.stdout.write(`Observed ${record.observed_actions.length} AWS action(s) over ${record.window.minutes} minutes; ${record.excluded_canary_events} canary event(s) excluded.\n`);
process.stdout.write(`Declared-but-unused (report-only, no narrowing): ${record.declared_but_unused.length} action(s).\n`);
if (record.declared_but_unused.length) process.stdout.write(`${record.declared_but_unused.join('\n')}\n`);
