import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { runAuthorizationCanary, AuthorizationDenialError, canaryCommand } from './authorization-canary.mjs';

// The pre-mutation interlock's contract (#165): a denial stops the operation
// before any mutation, a resource absence is classified separately and does not,
// and every probe runs under a marked session so CloudTrail can exclude it (D2).

const env = { GITHUB_RUN_ID: '39100318242' };
const credentials = { AWS_ACCESS_KEY_ID: 'probe' };

const recorder = ({ fail } = {}) => {
  const calls = [];
  return { calls, assume: async (kind, _env, purpose, options) => {
    calls.push({ kind, purpose, options });
    return credentials;
  }, run: async (command, args) => {
    calls.push({ command, args });
    if (fail) {
      const stderr = fail(args);
      if (stderr) {
        const error = new Error('command failed');
        error.stderr = stderr;
        throw error;
      }
    }
    return { stdout: '{}' };
  } };
};

test('the canary probes each deploy-session read under a marked session', async () => {
  const { calls, assume, run } = recorder({});
  const result = await runAuthorizationCanary({ sessions: ['deploy'], env, purpose: 'operation', assume, run });
  assert.equal(result.result, 'permitted');
  assert.equal(result.session_marker, 'canary');
  assert.equal(result.reads_probed, 4);
  assert.deepEqual(result.probes.map((probe) => probe.pair), ['sts/get-caller-identity',
    'cloudformation/describe-stacks', 'ssm/get-parameter', 'ec2/describe-managed-prefix-lists']);
  assert.deepEqual(assumeCalls(calls), [{ kind: 'deploy', purpose: 'operation', marker: 'canary' }]);
  const invocations = calls.filter((call) => call.command === 'aws').map((call) => call.args.slice(0, 2).join(' '));
  assert.deepEqual(invocations, ['sts get-caller-identity', 'cloudformation describe-stacks',
    'ssm get-parameter', 'ec2 describe-managed-prefix-lists']);
  assert.deepEqual(canaryCommand({ pair: 'cloudformation/describe-stacks', args: ['--stack-name', 's'] }),
    ['aws', 'cloudformation', 'describe-stacks', '--stack-name', 's', '--region', 'ap-east-1', '--output', 'json']);
});

test('an authorization denial stops the canary before the remaining reads and before any mutation', async () => {
  const { calls, assume, run } = recorder({ fail: (args) => (args[1] === 'describe-stacks'
    ? 'An error occurred (AccessDenied) when calling the DescribeStacks operation: User is not authorized'
    : '') });
  await assert.rejects(runAuthorizationCanary({ sessions: ['deploy'], env, purpose: 'operation', assume, run }), (error) => {
    assert.ok(error instanceof AuthorizationDenialError);
    assert.equal(error.denial, true);
    assert.equal(error.pair, 'cloudformation/describe-stacks');
    assert.match(error.message, /before any mutation/);
    return true;
  });
  const invoked = calls.filter((call) => call.command === 'aws').map((call) => call.args[1]);
  assert.deepEqual(invoked, ['get-caller-identity', 'describe-stacks']);
  assert.equal(calls.some((call) => call.command === 'npx' || call.args?.[0] === 'deploy'), false);
});

test('resource absence is classified apart from a denial and does not stop the canary', async () => {
  const { assume, run } = recorder({ fail: (args) => (args[1] === 'get-parameter'
    ? 'An error occurred (ParameterNotFound) when calling the GetParameter operation: parameter does not exist'
    : '') });
  const result = await runAuthorizationCanary({ sessions: ['deploy'], env, purpose: 'operation', assume, run });
  assert.equal(result.result, 'permitted');
  const ssm = result.probes.find((probe) => probe.pair === 'ssm/get-parameter');
  assert.equal(ssm.result, 'resource-absent');
  assert.equal(result.probes.filter((probe) => probe.result === 'permitted').length, 3);
});

test('an unclassified failure is recorded, never silently treated as permitted', async () => {
  const { assume, run } = recorder({ fail: () => 'Throttling: Rate exceeded' });
  const result = await runAuthorizationCanary({ sessions: ['deploy'], env, purpose: 'operation', assume, run });
  assert.equal(result.probes[0].result, 'unclassified-failure');
  assert.match(result.probes[0].message, /does not prove authorization/);
});

function assumeCalls(calls) {
  return calls.filter((call) => call.options !== undefined)
    .map((call) => ({ kind: call.kind, purpose: call.purpose, marker: call.options.sessionMarker }));
}

test('the runtime canary decision list has no unrecorded operation', async () => {
  const { plan } = await import('./authorization-inventory.mjs').then((module) => ({ plan: module.canaryPlan('runtime') }));
  assert.ok(plan.probes.length > 0);
  assert.ok(plan.skipped.every((skip) => skip.reason));
});

test('production.yml pins the app-token attestations read it needs', async () => {
  // The batch failure: a release-verifying path read the attestation API without
  // the attestations scope. Infra mints an app token for that read, so the input
  // is the declaration; no test pinned it before this one.
  const source = await readFile(new URL('../.github/workflows/production.yml', import.meta.url), 'utf8');
  const workflow = yaml.load(source);
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  const token = steps.find((step) => String(step.uses ?? '').startsWith('actions/create-github-app-token@'));
  assert.ok(token, 'production.yml must mint the reviewed app token');
  assert.equal(token.with['permission-attestations'], 'read',
    'the app token must carry attestations read for the release-verification read');
  assert.equal(token.with['permission-contents'], 'read');
  assert.equal(token.with['permission-actions'], 'read');
});
