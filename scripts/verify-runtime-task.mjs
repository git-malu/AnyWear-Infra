import { readFile } from 'node:fs/promises';
import { sha256, parseJson, exact, canonicalJson, matches, SHA, integer } from './json-contract.mjs';
import { assertSchemaCompatibility } from './vendor/service-artifact-contract.mjs';
import { INFRA_REPOSITORY, region } from './deployment-contract.mjs';

export function assertVerificationExecutor(infraSha, env = process.env) {
  matches(infraSha, SHA, 'reviewed verification Infra source'); matches(env.GITHUB_SHA, SHA, 'verification executor source');
  integer(Number(env.GITHUB_RUN_ID), 'verification run'); integer(Number(env.GITHUB_RUN_ATTEMPT), 'verification attempt');
  const paths = env.GITHUB_REPOSITORY === INFRA_REPOSITORY ? ['.github/workflows/runtime.yml']
    : env.GITHUB_REPOSITORY === 'git-malu/AnyWear-E2E' ? ['.github/workflows/beta-qualification.yml', '.github/workflows/integration.yml'] : [];
  if (!paths.some(file => env.GITHUB_WORKFLOW_REF === `${env.GITHUB_REPOSITORY}/${file}@refs/heads/main`)
    || env.GITHUB_REF !== 'refs/heads/main' || env.AWS_ACCOUNT_ID !== '650880818323' || env.AWS_REGION !== region
    || env.GITHUB_REPOSITORY === INFRA_REPOSITORY && env.GITHUB_SHA !== infraSha) throw new Error('Protected verification executor/account/region/source required');
}

export async function runRuntimeVerification({ io, outputs, selector, manifest, schema, infraSha, env = process.env }) {
  const check = () => assertVerificationExecutor(infraSha, env);
  check();
  const code = await runtimeCommandBytes();
  const command = ['node', '-e', code.toString('utf8')];
  const image = `${selector.image.repository_uri}@${selector.image.digest}`;
  const required = ['EcsClusterName', 'PrivateSubnetIds', 'OneShotSecurityGroupId', 'VerificationTaskRoleArn', 'OneShotExecutionRoleArn',
    'OneShotLogGroupName', 'DatabaseSecretArn', 'DatabaseHost', 'DatabasePort', 'DatabaseName', 'WardrobeBucketName'];
  for (const key of required) if (!outputs[key]) throw new Error(`Missing verification interface ${key}`);
  if (outputs.EcsClusterName !== 'beta-anywear' || outputs.BetaActive !== 'true') throw new Error('Only active Beta supports runtime verification');
  const environment = Object.entries({ STAGE: 'beta', NODE_ENV: 'production', AWS_REGION: region,
    DB_SECRET_ARN: outputs.DatabaseSecretArn, DB_HOST: outputs.DatabaseHost, DB_PORT: outputs.DatabasePort, DB_NAME: outputs.DatabaseName,
    S3_BUCKET_NAME: outputs.WardrobeBucketName, TASK_TRANSPORT: 'sqs', SQS_VTO_QUEUE_URL: outputs.VtoQueueUrl,
    SQS_AUTO_TAGGING_QUEUE_URL: outputs.AutoTaggingQueueUrl, SERVICE_COMMIT_SHA: selector.image.service_sha, IMAGE_DIGEST: selector.image.digest })
    .map(([name, value]) => ({ name, value }));
  const family = 'beta-anywear-artifact-verify';
  const definition = { family, taskRoleArn: outputs.VerificationTaskRoleArn, executionRoleArn: outputs.OneShotExecutionRoleArn,
    networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], cpu: '512', memory: '1024', containerDefinitions: [{
      name: 'OneShot', image, command, essential: true, environment,
      logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': outputs.OneShotLogGroupName, 'awslogs-region': region, 'awslogs-stream-prefix': family } },
    }] };
  check();
  const registered = await io.aws(['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify(definition)]);
  const taskDefinitionArn = registered.taskDefinition?.taskDefinitionArn;
  if (!/^arn:aws:ecs:ap-east-1:650880818323:task-definition\/beta-anywear-artifact-verify:[1-9][0-9]*$/.test(taskDefinitionArn ?? '')) throw new Error('Verification task definition unproven');
  let taskArn;
  try {
    check();
    const started = await io.aws(['ecs', 'run-task', '--cluster', 'beta-anywear', '--launch-type', 'FARGATE', '--task-definition', taskDefinitionArn,
      '--network-configuration', JSON.stringify({ awsvpcConfiguration: { subnets: outputs.PrivateSubnetIds.split(','), securityGroups: [outputs.OneShotSecurityGroupId], assignPublicIp: 'DISABLED' } }),
      '--started-by', `infra-verify-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`]);
    if (started.failures?.length || started.tasks?.length !== 1) throw new Error('Verification task failed to launch');
    taskArn = started.tasks[0].taskArn;
    await io.aws(['ecs', 'wait', 'tasks-stopped', '--cluster', 'beta-anywear', '--tasks', taskArn]);
    const actual = await io.aws(['ecs', 'describe-tasks', '--cluster', 'beta-anywear', '--tasks', taskArn]);
    const task = actual.tasks?.[0]; const container = task?.containers?.find(c => c.name === 'OneShot');
    if (actual.failures?.length || actual.tasks?.length !== 1 || task.taskArn !== taskArn || task.taskDefinitionArn !== taskDefinitionArn
      || task.lastStatus !== 'STOPPED' || container?.exitCode !== 0 || container.imageDigest !== selector.image.digest) throw new Error('Actual stopped verification image/result mismatch');
    // Re-read registered code/image/roles instead of trusting the declaration.
    const actualDefinition = (await io.aws(['ecs', 'describe-task-definition', '--task-definition', taskDefinitionArn])).taskDefinition;
    const actualContainer = actualDefinition?.containerDefinitions?.find(c => c.name === 'OneShot');
    if (canonicalJson(actualContainer?.command) !== canonicalJson(command) || actualContainer.image !== image
      || actualDefinition.taskRoleArn !== outputs.VerificationTaskRoleArn || actualDefinition.executionRoleArn !== outputs.OneShotExecutionRoleArn) throw new Error('Verification execution definition drift');
    const logs = await io.aws(['logs', 'get-log-events', '--log-group-name', outputs.OneShotLogGroupName,
      '--log-stream-name', `${family}/OneShot/${taskArn.split('/').at(-1)}`, '--start-from-head', '--limit', '1000']);
    const events = (logs.events ?? []).filter(event => event.message.startsWith('ANYWEAR_RUNTIME_EVIDENCE:'));
    if (events.length !== 1) throw new Error('Unique bounded verification result unavailable');
    const evidence = parseJson(events[0].message.slice('ANYWEAR_RUNTIME_EVIDENCE:'.length));
    exact(evidence, ['record_type', 'schema_version', 'service_sha', 'image_digest', 'policy_file_sha256', 'policy_content_sha256',
      'selected_journal_sha256', 'selected_migration_ids', 'applied_schema_version', 'applied_migration_ids', 'observed_applied_journal_sha256'], 'runtime evidence');
    if (evidence.record_type !== 'anywear_read_only_runtime' || evidence.schema_version !== 1 || evidence.service_sha !== selector.image.service_sha
      || evidence.image_digest !== selector.image.digest || evidence.policy_file_sha256 !== manifest.components.runtime_policy.sha256
      || evidence.policy_content_sha256 !== manifest.components.runtime_policy.content_sha256
      || evidence.selected_journal_sha256 !== manifest.components.schema.journal_sha256) throw new Error('Immutable image policy/journal identity mismatch');
    const selected = schema.migrations.map(m => ({ id: m.sha256, created_at: m.created_at }));
    if (canonicalJson(evidence.selected_migration_ids) !== canonicalJson(selected)) throw new Error('Image migrations differ from selected schema asset');
    const compatibility = assertSchemaCompatibility(selected, evidence.applied_migration_ids, evidence.applied_schema_version, schema.minimum_version, schema.minimum_migration_count);
    return { policy_content_sha256: evidence.policy_content_sha256, schema: {
      selected_journal_sha256: evidence.selected_journal_sha256, observed_applied_journal_sha256: evidence.observed_applied_journal_sha256,
      selected_migration_ids: selected, applied_migration_ids: evidence.applied_migration_ids,
      selected_current_version: schema.current_version, minimum_schema_version: schema.minimum_version, minimum_migration_count: schema.minimum_migration_count, applied_schema_version: evidence.applied_schema_version,
      compatibility_result: compatibility, verification: { command_sha256: sha256(code), source_repository: INFRA_REPOSITORY, source_sha: infraSha,
        image_digest: selector.image.digest, service_sha: selector.image.service_sha,
        executor: { repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA,
          workflow_path: env.GITHUB_WORKFLOW_REF?.split('/').slice(2).join('/').split('@')[0], run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT) },
        task_arn: taskArn, task_definition_arn: taskDefinitionArn },
    } };
  } finally {
    // Keep a still-running task registered for explicit recovery. Deregistration
    // only follows authenticated STOPPED readback and never kills another task.
    if (taskArn) {
      const actual = await io.aws(['ecs', 'describe-tasks', '--cluster', 'beta-anywear', '--tasks', taskArn]);
      if (actual.tasks?.[0]?.lastStatus === 'STOPPED') { check(); await io.aws(['ecs', 'deregister-task-definition', '--task-definition', taskDefinitionArn]); }
    }
  }
}
export async function runtimeCommandBytes() {
  // Embed this exact shared contract in the unchanged image's one-shot command;
  // no newly added Service module/path is assumed. Hash the entire command.
  const shared = (await readFile(new URL('./json-contract.mjs', import.meta.url), 'utf8'))
    .replace("import { createHash } from 'node:crypto';", "const { createHash } = require('node:crypto');")
    .replace(/^export /gm, '');
  const command = await readFile(new URL('../.github/scripts/read-only-runtime.cjs', import.meta.url), 'utf8');
  const inner = `${shared}\n${command}`;
  // A parent-enforced OS process timeout also covers synchronous reads/hashing;
  // an event-loop timer alone cannot enforce that part of a total deadline.
  return Buffer.from(`const {spawnSync}=require('node:child_process');\nconst result=spawnSync(process.execPath,['-e',${JSON.stringify(inner)}],{timeout:30000,killSignal:'SIGKILL',maxBuffer:1048576});\nif(result.error||result.status!==0){console.error('Read-only evidence process deadline/result failed');process.exit(1);}\nprocess.stdout.write(result.stdout);\n`);
}
