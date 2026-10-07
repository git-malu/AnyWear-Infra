import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { enforceBetaPlatformLogRetention } from './beta-platform-log-retention.mjs';

const exec = promisify(execFile);
const platformStack = 'AnyWearPlatformStack-beta';
const workloadStack = 'AnyWearWorkloadStack-beta';
const sleep = (milliseconds) => new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));

function values(entries, nameKey, valueKey) {
  return Object.fromEntries((entries ?? []).map((entry) => [entry[nameKey], entry[valueKey]]));
}

export function workloadRevision(stack) {
  const parameters = values(stack.Parameters, 'ParameterKey', 'ParameterValue');
  const digest = parameters.ServiceImageDigest;
  const commit = parameters.ServiceCommitSha;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? '')) {
    throw new Error('Beta lifecycle requires an existing pinned workload image and commit');
  }
  if (!parameters.VlmConfigArn || !/^pl-[a-z0-9]+$/.test(parameters.CloudFrontPrefixListId ?? '')) {
    throw new Error('Beta workload parameters are incomplete');
  }
  return { digest, commit, parameters };
}

export async function waitForTasks(io, cluster, { servicesAllowed, timeoutMs = 600_000 }) {
  if (cluster !== 'beta-anywear') throw new Error('Task inventory is restricted to the expected Beta cluster');
  const clusterArn = 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear';
  const taskArnPattern = /^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/[a-f0-9]{32}$/;
  const taskStatuses = new Set(['PROVISIONING', 'PENDING', 'ACTIVATING', 'RUNNING',
    'DEACTIVATING', 'STOPPING', 'DEPROVISIONING', 'STOPPED']);
  const deadline = io.now() + timeoutMs;
  while (true) {
    const listedArns = new Set();
    // A task can have desired STOPPED while its containers are still shutting down.
    for (const desiredStatus of ['RUNNING', 'STOPPED']) {
      let nextToken;
      const seenTokens = new Set();
      let pages = 0;
      do {
        if (++pages > 100 || (pages > 1 && io.now() >= deadline)) {
          throw new Error('Beta ECS task inventory pagination did not complete within its bound');
        }
        const listing = await io.aws(['ecs', 'list-tasks', '--cluster', cluster,
          '--desired-status', desiredStatus, '--max-results', '100', '--no-paginate',
          ...(nextToken ? ['--next-token', nextToken] : [])]);
        if (!Array.isArray(listing?.taskArns) || listing.taskArns.length > 100
          || listing.taskArns.some((arn) => typeof arn !== 'string' || !taskArnPattern.test(arn))) {
          throw new Error('Missing or malformed Beta ECS task inventory');
        }
        for (const arn of listing.taskArns) listedArns.add(arn);
        nextToken = listing.nextToken;
        if (nextToken !== undefined) {
          if (typeof nextToken !== 'string' || !nextToken || nextToken.length > 4096
            || /\s/.test(nextToken) || seenTokens.has(nextToken)) {
            throw new Error('Invalid or repeated Beta ECS task inventory pagination token');
          }
          seenTokens.add(nextToken);
        }
      } while (nextToken);
    }
    const taskArns = [...listedArns];
    if (taskArns.length === 0) return;
    const tasks = [];
    for (let offset = 0; offset < taskArns.length; offset += 100) {
      const batch = taskArns.slice(offset, offset + 100);
      const result = await io.aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', ...batch]);
      const described = result?.tasks;
      if (!Array.isArray(described) || described.length !== batch.length
        || (result.failures !== undefined && (!Array.isArray(result.failures) || result.failures.length > 0))
        || new Set(described.map((task) => task?.taskArn)).size !== batch.length
        || described.some((task) => !task || !batch.includes(task.taskArn) || task.clusterArn !== clusterArn
          || !taskStatuses.has(task.lastStatus) || typeof task.group !== 'string' || !task.group || task.group.length > 255)) {
        throw new Error('Unable to identify every Beta ECS task');
      }
      tasks.push(...described);
    }
    const busy = tasks.filter((task) => task.lastStatus !== 'STOPPED'
      && (!servicesAllowed || !['service:beta-anywear-api', 'service:beta-anywear-worker'].includes(task.group)));
    if (busy.length === 0) return;
    if (io.now() >= deadline) throw new Error('Beta still has running one-shot or service tasks; shutdown aborted');
    await io.sleep(10_000);
  }
}

export async function runBetaLifecycle(action, io) {
  if (!['start', 'stop'].includes(action)) throw new Error('Beta lifecycle action must be start or stop');
  const workload = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', workloadStack])).Stacks?.[0];
  const platform = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', platformStack])).Stacks?.[0];
  if (!workload || !platform) throw new Error('Beta platform and workload must exist before lifecycle operations');
  const revision = workloadRevision(workload);
  const output = values(platform.Outputs, 'OutputKey', 'OutputValue');
  const workloadOutputs = values(workload.Outputs, 'OutputKey', 'OutputValue');
  const cluster = output.EcsClusterName;
  if (cluster !== 'beta-anywear') throw new Error('Refusing lifecycle changes outside beta-anywear');
  const active = workloadOutputs.BetaActive !== 'false';
  const platformActive = output.BetaActive !== 'false';
  const oneShot = (command) => io.oneShot('lifecycle', revision, command);
  const deploy = (stack, enabled) => io.deploy(stack, enabled, revision);
  const healthy = async () => {
    await io.aws(['ecs', 'wait', 'services-stable', '--cluster', cluster,
      '--services', 'beta-anywear-api', 'beta-anywear-worker']);
    const stack = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', workloadStack])).Stacks[0];
    const outputs = values(stack.Outputs, 'OutputKey', 'OutputValue');
    await io.verifyHealth(outputs.ApiBaseUrl, revision);
    await io.oneShot('verify', revision, outputs.ApiBaseUrl);
  };
  const readAdmissionSuspension = async (operation) => {
    const value = (await io.aws(['ssm', 'get-parameter',
      '--name', '/anywear/beta/admission_suspended'])).Parameter?.Value;
    if (value !== 'true' && value !== 'false') {
      throw new Error(`Beta admission suspension must be a valid boolean before ${operation}`);
    }
    return value;
  };

  if (action === 'start') {
    const priorSuspension = await readAdmissionSuspension('starting');
    // Network restoration precedes every private task. Intake stays closed
    // through schema verification, workload rollout, and public health checks.
    await deploy(platformStack, true);
    await oneShot('close');
    await io.oneShot('migrate', revision);
    await io.oneShot('verify', revision);
    await deploy(workloadStack, true);
    await healthy();
    await oneShot(priorSuspension === 'true' ? 'close' : 'open');
    return;
  }

  if (!active && !platformActive) return;
  if (!active || !platformActive) {
    throw new Error('Beta is partially stopped; run start to restore a consistent state before stopping');
  }
  const priorSuspension = await readAdmissionSuspension('stopping');
  let infrastructureChanged = false;
  try {
    await oneShot('close');
    await oneShot('drain');
    await waitForTasks(io, cluster, { servicesAllowed: true });
    infrastructureChanged = true;
    await deploy(workloadStack, false);
    await waitForTasks(io, cluster, { servicesAllowed: false });
    await deploy(platformStack, false);
  } catch (error) {
    io.recordRecovery?.('began');
    try {
      if (infrastructureChanged) {
        await deploy(platformStack, true);
        await deploy(workloadStack, true);
        await healthy();
      }
      await oneShot(priorSuspension === 'true' ? 'close' : 'open');
      io.recordRecovery?.('succeeded');
    } catch (recoveryError) {
      io.recordRecovery?.('failed');
      throw new AggregateError(
        [error, recoveryError],
        'Beta shutdown and recovery failed; intake remains closed',
        { cause: recoveryError },
      );
    }
    throw new Error(priorSuspension === 'true'
      ? 'Beta shutdown aborted; prior admission suspension restored and runtime remains active'
      : 'Beta shutdown aborted; intake restored and runtime remains active', { cause: error });
  }
}

export function liveIo(options = {}) {
  const execute = options.exec ?? exec;
  const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const io = {
    region: process.env.AWS_REGION ?? 'ap-east-1',
    now: Date.now,
    sleep,
    async aws(args) {
      const { stdout } = await execute('aws', [...args, '--output', 'json'], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
      return stdout.trim() ? JSON.parse(stdout) : {};
    },
    async oneShot(role, revision, argument = '') {
      const { stdout, stderr } = await execute('bash', ['.github/scripts/run-one-shot-task.sh', 'beta', role,
        revision.digest, revision.commit, argument], { cwd: serviceRoot, maxBuffer: 10 * 1024 * 1024 });
      process.stdout.write(stdout);
      process.stderr.write(stderr);
    },
    async deploy(stack, active, revision) {
      const parameters = stack === workloadStack ? Object.entries(revision.parameters)
        .filter(([key]) => ['ServiceImageDigest', 'ServiceCommitSha', 'VlmConfigArn', 'CloudFrontPrefixListId'].includes(key))
        .flatMap(([key, value]) => ['--parameters', `${key}=${value}`]) : [];
      const { stdout, stderr } = await execute('npx', ['cdk', 'deploy', stack, '--exclusively', '--require-approval', 'never',
        '-c', 'stage=beta', '-c', `betaActive=${active}`, ...parameters], {
        cwd: path.join(serviceRoot, 'infra'), maxBuffer: 20 * 1024 * 1024,
      });
      process.stdout.write(stdout);
      process.stderr.write(stderr);
      if (stack === platformStack) console.log(JSON.stringify(await enforceBetaPlatformLogRetention(io)));
    },
    async verifyHealth(url, revision) {
      if (!/^https:\/\/[^/]+\.cloudfront\.net$/.test(url ?? '')) throw new Error('Expected the stable Beta CloudFront HTTPS URL');
      const deadline = Date.now() + 600_000;
      while (Date.now() < deadline) {
        try {
          const response = await globalThis.fetch(`${url}/health`, { signal: globalThis.AbortSignal.timeout(15_000) });
          const body = await response.json();
          if (response.ok && body.service_commit === revision.commit && body.image_digest === revision.digest) return;
        } catch { /* CloudFront origin propagation can lag ECS readiness. */ }
        await sleep(10_000);
      }
      throw new Error('Beta CloudFront health did not match the pinned revision within ten minutes');
    },
  };
  return io;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  throw new Error('Use scripts/runtime-operation.mjs with a recorded Infra writer window');
}
