import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { credentialEnvironment } from './runtime-operation.mjs';
import { OBSERVED_SURFACE, REGION } from './authorization-inventory.mjs';
import { buildObservedRecord } from './authorization-observed.mjs';

const execute = promisify(execFile);

// The observed layer's producer (D3). It runs in the credentialed deploy job
// after the operation, under the same restricted runtime session, and writes
// `permissions-observed.json`. It makes no mutation and its output is report-only
// narrowing input. The observed action set is reconciled against the one derived
// inventory module, never against a second derivation.

const OPTIONS = Object.freeze({ '--start-time': true, '--end-time': true, '--window-minutes': true,
  '--minimum-window-minutes': true, '--output': true });
const USAGE = `Usage: node scripts/observe-authorization-usage.mjs [--start-time <iso>] [--end-time <iso>]
  [--window-minutes <n>] [--minimum-window-minutes <n>] [--output <file>]

Reads CloudTrail LookupEvents for the reconciled roles' run window and writes
${OBSERVED_SURFACE.artifact_path}. An observed action outside the declared
surface fails; declared-but-unused is reported, never applied.
`;

export function observerArguments(argv = []) {
  if (argv.includes('--help')) return { help: true };
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!Object.hasOwn(OPTIONS, name)) throw new Error(`Unknown observed-surface argument ${name}`);
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value) throw new Error(`Observed-surface argument ${name} requires a value`);
    if (Object.hasOwn(options, name.slice(2))) throw new Error(`Duplicate observed-surface argument ${name}`);
    options[name.slice(2)] = value;
  }
  return options;
}

export async function lookupEvents({ credentials, start, end, run = execute, maxPages = 200 } = {}) {
  const events = [];
  let token;
  for (let page = 0; page < maxPages; page += 1) {
    const command = ['cloudtrail', 'lookup-events', '--start-time', start, '--end-time', end,
      '--max-results', String(OBSERVED_SURFACE.event_page_limit), '--region', REGION, '--output', 'json',
      ...(token ? ['--next-token', token] : [])];
    const result = await run('aws', command, { env: credentials, timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
    const body = result.stdout?.trim() ? JSON.parse(result.stdout) : {};
    if (!Array.isArray(body.Events)) throw new Error('CloudTrail LookupEvents returned no event list');
    events.push(...body.Events);
    token = body.NextToken;
    if (!token) return events;
  }
  throw new Error('CloudTrail LookupEvents pagination did not complete');
}

export async function observeAuthorizationUsage({ env = process.env, argv = process.argv.slice(2),
  run = execute, assume = credentialEnvironment, now = () => Date.now() } = {}) {
  const options = observerArguments(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return { help: true };
  }
  const output = options.output ?? OBSERVED_SURFACE.artifact_path;
  const end = options['end-time'] ? new Date(options['end-time']) : new Date(now());
  const minutes = Number(options['window-minutes'] ?? OBSERVED_SURFACE.default_window_minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('The window length must be a positive number of minutes');
  const start = options['start-time'] ? new Date(options['start-time']) : new Date(end.getTime() - minutes * 60_000);
  const minimumMinutes = Number(options['minimum-window-minutes'] ?? OBSERVED_SURFACE.minimum_window_minutes);
  const credentials = await assume('runtime', env, 'operation');
  const events = await lookupEvents({ credentials, start: start.toISOString(), end: end.toISOString(), run });
  const record = buildObservedRecord({ events, window: { start: start.toISOString(), end: end.toISOString(), minimumMinutes }, env });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(record, null, 2)}\n`);
  return { record, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await observeAuthorizationUsage();
}
