import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeDeployment, observeDeploymentCli, observerArguments } from './observe-deployment.mjs';
import { sha256 } from './json-contract.mjs';
import { configuredStacks } from './operation-stacks.mjs';
import { runtimeStack } from './one-writer.mjs';
import { STAGE_CONTRACT_CONDITIONAL_PARAMETERS, STAGE_CONTRACT_PARAMETERS,
  STAGE_CONTRACT_READ_PARAMETERS } from './stage-contract-parameters.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const infraSha = 'a'.repeat(40);
const endpoint = 'https://d111111abcdef8.cloudfront.net';
// AnyWear-E2E executes the observer from its own pinned checkout: its run SHA is
// the executor identity and --infra-sha is the observed Infra revision.
const executorEnvironment = (overrides = {}) => ({
  GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'b'.repeat(40),
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main',
  GITHUB_RUN_ID: '41', GITHUB_RUN_ATTEMPT: '1', AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ...overrides,
});
const templates = {
  AnyWearFoundationStack: { Resources: { FoundationTopic: { Type: 'AWS::SNS::Topic' } } },
  'AnyWearPlatformStack-beta': {
    Resources: { StageBaseBucket: { Type: 'AWS::S3::Bucket' } },
    Outputs: [
      { OutputKey: 'ClientBaseUrl', OutputValue: endpoint },
      { OutputKey: 'VtoQueueUrl', OutputValue: 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-vto' },
      { OutputKey: 'AutoTaggingQueueUrl',
        OutputValue: 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-auto-tagging' },
    ],
  },
  'AnyWearBillingStack-beta': { Resources: { BillingBudget: { Type: 'AWS::Budgets::Budget' } } },
  // Issue #166: the Service-owned Runtime stack exists while Beta runs; the
  // authenticated observation reads it but never adds it to the record's stacks.
  [runtimeStack]: { Resources: { RuntimeService: { Type: 'AWS::ECS::Service' } }, Outputs: [] },
};
const expectedInputs = (names) => names.map((parameter) => ({ parameter,
  version: String(STAGE_CONTRACT_READ_PARAMETERS.indexOf(parameter) + 1),
  value_sha256: sha256(`value-${STAGE_CONTRACT_READ_PARAMETERS.indexOf(parameter)}`) }));

function stackAbsenceError(stackName) {
  const stderr = `aws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stackName} does not exist`;
  return Object.assign(new Error(stderr), { stderr });
}

// A deterministic read-only AWS surface for the exact calls observeDeployment
// makes: no credentials, no network, no timers.
function fixtureIo({ invalidStageParameters = [], runtimeStatus = 'UPDATE_COMPLETE', runtimeError } = {}) {
  const stacks = new Map(configuredStacks.map((configured, index) => [configured.stack_name, {
    StackId: `arn:aws:cloudformation:${configured.region}:650880818323:stack/${configured.stack_name}/${index}`,
    StackName: configured.stack_name, StackStatus: 'UPDATE_COMPLETE', CreationTime: '2026-10-01T00:00:00.000Z',
    LastUpdatedTime: '2026-10-02T00:00:00.000Z', Outputs: templates[configured.stack_name]?.Outputs ?? [],
  }]));
  if (runtimeStatus !== null) {
    stacks.set(runtimeStack, {
      StackId: `arn:aws:cloudformation:ap-east-1:650880818323:stack/${runtimeStack}/runtime`,
      StackName: runtimeStack, StackStatus: runtimeStatus, CreationTime: '2026-10-01T00:00:00.000Z',
      LastUpdatedTime: '2026-10-02T00:00:00.000Z', Outputs: [],
    });
  }
  const byId = new Map([...stacks.values()].map(stack => [stack.StackId, stack]));
  return {
    async aws(args, region) {
      const argument = flag => args[args.indexOf(flag) + 1];
      if (args[0] === 'sts' && args[1] === 'get-caller-identity') return { Account: '650880818323' };
      if (args[0] === 'cloudformation' && args[1] === 'describe-stacks') {
        const name = argument('--stack-name');
        if (runtimeError && name === runtimeStack) throw runtimeError;
        const stack = stacks.get(name) ?? byId.get(name);
        if (!stack) throw stackAbsenceError(name);
        return { Stacks: [structuredClone(stack)] };
      }
      if (args[0] === 'cloudformation' && args[1] === 'get-template') {
        const stack = byId.get(argument('--stack-name'));
        return { TemplateBody: structuredClone(templates[stack.StackName]) };
      }
      if (args[0] === 'lambda' && args[1] === 'get-function') {
        const functionName = argument('--function-name');
        return { Configuration: { FunctionName: functionName, Runtime: 'nodejs24.x', Handler: 'index.handler',
          Role: 'arn:aws:iam::650880818323:role/beta-anywear-lambda', MemorySize: 512, Timeout: 30,
          Architectures: ['x86_64'], Environment: { Variables: { STAGE: 'beta' } }, LastUpdateStatus: 'Successful',
          CodeSha256: `${'A'.repeat(43)}=`, FunctionArn: `arn:aws:lambda:ap-east-1:650880818323:function:${functionName}` } };
      }
      if (args[0] === 'sqs' && args[1] === 'get-queue-attributes') {
        assert.match(argument('--queue-url'), /^https:\/\/sqs\.ap-east-1\.amazonaws\.com\/650880818323\/beta-anywear-/);
        return { Attributes: { QueueArn: 'arn:aws:sqs:ap-east-1:650880818323:beta-anywear-vto',
          VisibilityTimeout: '300', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: 'arn:aws:sqs:ap-east-1:650880818323:beta-anywear-vto-dlq',
            maxReceiveCount: 5 }) } };
      }
      if (args[0] === 'ssm' && args[1] === 'get-parameters') {
        const names = args.slice(3);
        assert.ok(names.length <= 10, 'ssm get-parameters accepts at most ten names per call');
        const parameters = names.filter(name => !invalidStageParameters.includes(name))
          .map(name => ({ Name: name,
            Type: name === '/anywear/beta/private_subnet_ids' ? 'StringList' : 'String',
            Value: `value-${STAGE_CONTRACT_READ_PARAMETERS.indexOf(name)}`,
            Version: STAGE_CONTRACT_READ_PARAMETERS.indexOf(name) + 1 }));
        return { Parameters: parameters,
          InvalidParameters: invalidStageParameters.filter(name => names.includes(name)) };
      }
      throw new Error(`Unsupported fixture call ${args.join(' ')}`);
    },
    async http(url) {
      assert.match(url, /^https:\/\/d111111abcdef8\.cloudfront\.net\/build-metadata\.json\?infra=/);
      return { component: 'AnyWear-Client', source_commit: 'c'.repeat(40) };
    },
  };
}

async function expectedRecord({ io, invalidStageParameters = [] } = {}) {
  const body = await observeDeployment({ infraSha, io: io ?? fixtureIo({ invalidStageParameters }),
    env: executorEnvironment() });
  return { schema_version: 3, record_type: 'anywear_infra_deployment',
    producer: { repository: 'git-malu/AnyWear-Infra', sha: infraSha, workflow_path: '.github/workflows/runtime.yml',
      workflow_ref: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main', run_id: 42, run_attempt: 1 },
    ...body };
}

test('the observer arguments accept exactly the v3 E2E invocation and reject a selection', () => {
  assert.deepEqual(observerArguments(['--expected', 'record.json', '--output', 'out.json', '--infra-sha', infraSha]),
    { expected: 'record.json', output: 'out.json', 'infra-sha': infraSha });
  assert.deepEqual(observerArguments(['--expected', 'record.json', '--output', 'out.json', '--infra-sha', infraSha,
    '--trusted-infra-root', repository]), { expected: 'record.json', output: 'out.json', 'infra-sha': infraSha,
    'trusted-infra-root': repository });
  assert.deepEqual(observerArguments(['--help']), { help: true });
  assert.throws(() => observerArguments(['--expected', 'record.json', '--selection', 'selections/x.json',
    '--output', 'out.json', '--infra-sha', infraSha]), /Unknown observer argument --selection/);
  assert.throws(() => observerArguments(['--expected', 'record.json', '--selection-sha256', 'f'.repeat(64),
    '--output', 'out.json', '--infra-sha', infraSha]), /Unknown observer argument --selection-sha256/);
  assert.throws(() => observerArguments(['--expected', 'record.json', '--infra-sha', infraSha]), /--output is required/);
  assert.throws(() => observerArguments(['--expected', 'record.json', '--output']), /requires a value/);
  assert.throws(() => observerArguments(['--expected', 'a', '--expected', 'b', '--output', 'out', '--infra-sha', infraSha]),
    /Duplicate observer argument --expected/);
});

test('the observer requires the Service-owned Runtime stack to exist and be terminal', async () => {
  for (const runtimeStatus of [null, 'UPDATE_IN_PROGRESS', 'UPDATE_ROLLBACK_FAILED']) {
    await assert.rejects(observeDeployment({ infraSha, io: fixtureIo({ runtimeStatus }), env: executorEnvironment() }),
      /AnyWearRuntimeStack-beta/, String(runtimeStatus));
  }
  // A throttled/denied Runtime read is not absence and must abort the observation.
  const throttle = Object.assign(new Error('aws: [ERROR]: An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded'),
    { stderr: 'aws: [ERROR]: An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded' });
  await assert.rejects(observeDeployment({ infraSha, io: fixtureIo({ runtimeStatus: null, runtimeError: throttle }),
    env: executorEnvironment() }), /Throttling/);
});

test('the observer CLI writes the authenticated v3 body that equals the expected record', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'anywear-observer-'));
  try {
    const record = await expectedRecord();
    assert.equal(record.inputs.length, STAGE_CONTRACT_PARAMETERS.length + STAGE_CONTRACT_CONDITIONAL_PARAMETERS.length);
    const expectedFile = path.join(directory, 'deployment-record.json');
    const outputFile = path.join(directory, 'aws-observation.json');
    await writeFile(expectedFile, `${JSON.stringify(record, null, 2)}\n`);
    const body = await observeDeploymentCli({ argv: ['--expected', expectedFile, '--output', outputFile,
      '--infra-sha', infraSha], io: fixtureIo(), env: executorEnvironment() });
    assert.deepEqual(JSON.parse(await readFile(outputFile, 'utf8')), body);
    assert.deepEqual(Object.keys(body).sort(), ['inputs', 'observed', 'schema', 'stacks']);
    assert.equal(body.schema.content_sha256, record.schema.content_sha256);
    // A different expected provenance or value digest is rejected, not written.
    const tampered = structuredClone(record);
    tampered.inputs[0].value_sha256 = 'f'.repeat(64);
    await writeFile(expectedFile, JSON.stringify(tampered));
    await assert.rejects(observeDeploymentCli({ argv: ['--expected', expectedFile, '--output', outputFile,
      '--infra-sha', infraSha], io: fixtureIo(), env: executorEnvironment() }), /Authenticated observation differs/);
    const otherSha = structuredClone(record);
    otherSha.producer.sha = 'd'.repeat(40);
    for (const stack of otherSha.stacks) stack.producer_sha = 'd'.repeat(40);
    await writeFile(expectedFile, JSON.stringify(otherSha));
    await assert.rejects(observeDeploymentCli({ argv: ['--expected', expectedFile, '--output', outputFile,
      '--infra-sha', infraSha], io: fixtureIo(), env: executorEnvironment() }), /different Infra revision/);
    // A service record is not an Infra deployment record.
    await writeFile(expectedFile, JSON.stringify({ ...record, record_type: 'anywear_service_deployment' }));
    await assert.rejects(observeDeploymentCli({ argv: ['--expected', expectedFile, '--output', outputFile,
      '--infra-sha', infraSha], io: fixtureIo(), env: executorEnvironment() }),
    /Invalid deployment record fields|exactly its producer's stacks/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the observer CLI reads a legacy stage base that publishes no cleanup parameter', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'anywear-observer-legacy-'));
  try {
    const invalid = [...STAGE_CONTRACT_CONDITIONAL_PARAMETERS];
    const record = await expectedRecord({ invalidStageParameters: invalid });
    assert.equal(record.inputs.length, STAGE_CONTRACT_PARAMETERS.length);
    assert.deepEqual(record.inputs.map(row => row.parameter), [...STAGE_CONTRACT_PARAMETERS]);
    const expectedFile = path.join(directory, 'deployment-record.json');
    const outputFile = path.join(directory, 'aws-observation.json');
    await writeFile(expectedFile, JSON.stringify(record));
    await observeDeploymentCli({ argv: ['--expected', expectedFile, '--output', outputFile, '--infra-sha', infraSha],
      io: fixtureIo({ invalidStageParameters: invalid }), env: executorEnvironment() });
    assert.deepEqual(JSON.parse(await readFile(outputFile, 'utf8')).inputs, expectedInputs(STAGE_CONTRACT_PARAMETERS));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the observer CLI binds an explicit trusted Infra root to the observed revision', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'anywear-observer-root-'));
  try {
    const head = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const body = await observeDeployment({ infraSha: head, io: fixtureIo(), env: executorEnvironment() });
    const record = { schema_version: 3, record_type: 'anywear_infra_deployment',
      producer: { repository: 'git-malu/AnyWear-Infra', sha: head, workflow_path: '.github/workflows/runtime.yml',
        workflow_ref: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main', run_id: 42, run_attempt: 1 },
      ...body };
    const expectedFile = path.join(directory, 'deployment-record.json');
    const outputFile = path.join(directory, 'aws-observation.json');
    await writeFile(expectedFile, JSON.stringify(record));
    await observeDeploymentCli({ argv: ['--expected', expectedFile, '--output', outputFile, '--infra-sha', head,
      '--trusted-infra-root', repository], io: fixtureIo(), env: executorEnvironment() });
    assert.deepEqual(JSON.parse(await readFile(outputFile, 'utf8')), body);
    await assert.rejects(observeDeploymentCli({ argv: ['--expected', expectedFile, '--output', outputFile,
      '--infra-sha', head, '--trusted-infra-root', directory], io: fixtureIo(), env: executorEnvironment() }),
    /Command failed|not the reviewed Infra revision/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
