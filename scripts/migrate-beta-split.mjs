#!/usr/bin/env node
// Issue #166 one-time Beta stack migration: Platform/Workload -> Base/Egress/Runtime.
//
// This operation is NEVER automatic. It has three separately authorized stages:
//
//   (a) pre-move  — rewrite the live Workload distribution origin from a
//                   same-stack `Fn::GetAtt` to the literal ALB DNS name the stack
//                   already resolves, and remove the distribution's `DependsOn`
//                   residue on resources that stay behind. This is a minimal
//                   in-place `update-stack` delta: the distribution ID and its
//                   `*.cloudfront.net` domain are preserved.
//   (b) preview   — read both live templates, build the Workload source and Base
//                   target, and call `create-stack-refactor`. Creation validates
//                   and produces the preview; it mutates no resource. Require
//                   exactly one MOVE and no CREATE/DELETE/UPDATE.
//   (c) execute   — only on a clean preview; execute the refactor, read the
//                   distribution ID/domain/status back, and leave deleting the
//                   old Workload stack as a separate explicit step.
//
// Without `--apply`, every stage only reads/validates/builds and prints the plan:
// the default mode executes nothing. The pure functions below are the reviewed
// contract and are unit-tested against recorded-shape fixtures; no test or
// validation-only run calls AWS.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const API_DISTRIBUTION = Object.freeze(JSON.parse(
  readFileSync(new URL('../lib/api-distribution.json', import.meta.url), 'utf8')));
export const WORKLOAD_STACK = API_DISTRIBUTION.sourceStack;
export const BASE_STACK = API_DISTRIBUTION.destinationStack;
export const SOURCE_LOGICAL_ID = API_DISTRIBUTION.sourceLogicalId;
export const DESTINATION_LOGICAL_ID = API_DISTRIBUTION.logicalId;
export const MOVED_OUTPUTS = Object.freeze(['ApiDistributionDomainName', 'ApiBaseUrl']);
export const REFACTOR_ACTION = Object.freeze({ action: 'MOVE', entity: 'RESOURCE', resourceType: 'AWS::CloudFront::Distribution' });
export const STAGES = Object.freeze(['pre-move', 'preview', 'execute']);

const clone = value => structuredClone(value);
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
};
const same = (left, right, label) => {
  if (JSON.stringify(canonical(left)) !== JSON.stringify(canonical(right))) throw new Error(`${label} differs`);
};
const differences = (before, after, at = '') => {
  if (JSON.stringify(canonical(before)) === JSON.stringify(canonical(after))) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    return Array.from({ length }, (_, index) => differences(before[index], after[index], `${at}/${index}`)).flat();
  }
  if (before && after && typeof before === 'object' && typeof after === 'object'
    && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      differences(before[key], after[key], `${at}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
  }
  return [{ path: at, before, after }];
};

const distributionResource = (template, logicalId, stack) => {
  const resource = template?.Resources?.[logicalId];
  if (!resource || resource.Type !== 'AWS::CloudFront::Distribution') {
    throw new Error(`${stack} does not contain the expected CloudFront distribution ${logicalId}`);
  }
  return resource;
};

const originDomainName = resource => resource?.Properties?.DistributionConfig?.Origins?.[0]?.DomainName;

// (a) The pre-move Workload update. The only permitted changes are the first
// origin's `DomainName` (GetAtt -> live literal) and removal of the
// distribution's `DependsOn` entries. Outputs, parameters, conditions and every
// other resource stay byte-identical, so the stack keeps serving.
export function preMoveWorkloadUpdate(liveWorkload, { apiLoadBalancerDnsName } = {}) {
  if (typeof apiLoadBalancerDnsName !== 'string' || !apiLoadBalancerDnsName) {
    throw new Error('The pre-move update requires the live ApiLoadBalancerDnsName value');
  }
  const source = clone(liveWorkload);
  const resource = distributionResource(source, SOURCE_LOGICAL_ID, WORKLOAD_STACK);
  const domain = originDomainName(resource);
  const getAtt = domain?.['Fn::GetAtt'];
  if (getAtt) {
    if (getAtt.length !== 2 || getAtt[1] !== 'DNSName') throw new Error('Unexpected live distribution origin reference');
    const target = source.Resources[getAtt[0]];
    if (target?.Type !== 'AWS::ElasticLoadBalancingV2::LoadBalancer') {
      throw new Error('The live distribution origin does not name a same-stack load balancer');
    }
    resource.Properties.DistributionConfig.Origins[0].DomainName = apiLoadBalancerDnsName;
  } else if (domain !== apiLoadBalancerDnsName) {
    throw new Error('The live distribution origin is neither the expected GetAtt nor the recorded literal ALB DNS name');
  }
  const removedDependsOn = [];
  if (resource.DependsOn !== undefined) {
    if (!Array.isArray(resource.DependsOn)) throw new Error('Unreviewed DependsOn shape on the live distribution');
    for (const dependency of resource.DependsOn) {
      if (!source.Resources[dependency]) throw new Error(`DependsOn names an unknown resource ${dependency}`);
      removedDependsOn.push(dependency);
    }
    delete resource.DependsOn;
  }
  const allowedPaths = [
    ...(getAtt ? [`/Resources/${SOURCE_LOGICAL_ID}/Properties/DistributionConfig/Origins/0/DomainName`] : []),
    ...(removedDependsOn.length ? [`/Resources/${SOURCE_LOGICAL_ID}/DependsOn`] : []),
  ];
  const changes = differences(liveWorkload, source);
  const unexpected = changes.filter(change => !allowedPaths.includes(change.path));
  if (unexpected.length) throw new Error(`The pre-move update changed unexpected template paths: ${unexpected.map(change => change.path).join(', ')}`);
  // Outputs stay in the source until the refactor moves them.
  for (const output of MOVED_OUTPUTS) {
    if (!source.Outputs?.[output]) throw new Error(`The pre-move Workload template must keep its ${output} output`);
  }
  return { template: source, changes: changes.map(change => change.path), removedDependsOn,
    origin: { from: getAtt ? { 'Fn::GetAtt': getAtt } : domain, to: apiLoadBalancerDnsName } };
}

// The refactor is only eligible when every documented condition holds.
export function assertRefactorEligibility({ distributionType, workloadStackPolicy, baseStackPolicy, workloadTemplate }) {
  if (distributionType?.ProvisioningType !== 'FULLY_MUTABLE') {
    throw new Error(`AWS::CloudFront::Distribution is not FULLY_MUTABLE: ${distributionType?.ProvisioningType ?? 'unavailable'}`);
  }
  for (const [stack, policy] of [[WORKLOAD_STACK, workloadStackPolicy], [BASE_STACK, baseStackPolicy]]) {
    if (policy !== undefined && policy !== null) throw new Error(`Refactor is not allowed with a stack policy on ${stack}`);
  }
  const serialized = JSON.stringify(workloadTemplate);
  for (const pseudo of ['AWS::StackName', 'AWS::StackId']) {
    if (serialized.includes(pseudo)) throw new Error(`The Workload distribution references stack-varying pseudo parameter ${pseudo}`);
  }
  return true;
}

// Parameters, conditions, mappings and rules must not change in either refactor
// template relative to that stack's live template. CloudFormation rejects such a
// refactor, so the operation refuses before calling create-stack-refactor.
export function assertTemplateSurfaceUnchanged(live, refactored, stack) {
  for (const section of ['Parameters', 'Conditions', 'Mappings', 'Rules']) {
    same(live?.[section] ?? {}, refactored?.[section] ?? {}, `${stack} ${section}`);
  }
  return true;
}

// (b) Build the two refactor templates. The source is the live Workload template
// minus the distribution and its two outputs. The target is the live Base
// template plus exactly the distribution and outputs from Base's same-HEAD
// synthesis with `-c apiOriginDomainName=<live ALB DNS>`; never Base's full
// post-split synthesis, whose other changes belong to the next normal deploy.
export function buildRefactorTemplates({ liveWorkload, liveBase, baseSynth }) {
  const source = clone(liveWorkload);
  distributionResource(source, SOURCE_LOGICAL_ID, WORKLOAD_STACK);
  delete source.Resources[SOURCE_LOGICAL_ID];
  for (const output of MOVED_OUTPUTS) {
    if (!source.Outputs?.[output]) throw new Error(`The Workload template has no ${output} output to move`);
    delete source.Outputs[output];
  }
  if (Object.keys(source.Outputs ?? {}).length === 0) delete source.Outputs;
  const sourceChanges = differences(liveWorkload, source).map(change => change.path);
  const allowedSource = [`/Resources/${SOURCE_LOGICAL_ID}`, ...MOVED_OUTPUTS.map(output => `/Outputs/${output}`)];
  const unexpectedSource = sourceChanges.filter(change => !allowedSource.includes(change));
  if (unexpectedSource.length) throw new Error(`The refactor source changed unexpected paths: ${unexpectedSource.join(', ')}`);

  const movedDistribution = distributionResource(baseSynth, DESTINATION_LOGICAL_ID, `${BASE_STACK} synthesis`);
  const target = clone(liveBase);
  if (target.Resources?.[DESTINATION_LOGICAL_ID]) throw new Error(`${BASE_STACK} already contains ${DESTINATION_LOGICAL_ID}`);
  target.Resources[DESTINATION_LOGICAL_ID] = clone(movedDistribution);
  target.Outputs = { ...(target.Outputs ?? {}) };
  for (const output of MOVED_OUTPUTS) {
    const fromSynth = baseSynth.Outputs?.[output];
    if (!fromSynth) throw new Error(`${BASE_STACK} synthesis has no ${output} output to move`);
    target.Outputs[output] = clone(fromSynth);
  }
  const targetChanges = differences(liveBase, target).map(change => change.path);
  const allowedTarget = [`/Resources/${DESTINATION_LOGICAL_ID}`, ...MOVED_OUTPUTS.map(output => `/Outputs/${output}`)];
  const unexpectedTarget = targetChanges.filter(change => !allowedTarget.includes(change));
  if (unexpectedTarget.length) throw new Error(`The refactor target changed unexpected paths: ${unexpectedTarget.join(', ')}`);

  // The moved resource must carry the same configuration; only the destination
  // logical ID may differ. `UpdateReplacePolicy`/`DeletionPolicy` are resource
  // attributes, not configuration, and are asserted separately by synthesis.
  const liveDistribution = distributionResource(liveWorkload, SOURCE_LOGICAL_ID, WORKLOAD_STACK);
  same(liveDistribution.Type, movedDistribution.Type, 'Moved distribution type');
  same(liveDistribution.Properties, movedDistribution.Properties, 'Moved distribution configuration');

  assertTemplateSurfaceUnchanged(liveWorkload, source, WORKLOAD_STACK);
  assertTemplateSurfaceUnchanged(liveBase, target, BASE_STACK);
  return { source, target, sourceChanges, targetChanges,
    resourceMappings: [{
      Source: { StackName: WORKLOAD_STACK, LogicalResourceId: SOURCE_LOGICAL_ID },
      Destination: { StackName: BASE_STACK, LogicalResourceId: DESTINATION_LOGICAL_ID },
    }] };
}

// The migration mapping destination is the CDK constant Base pins, never a
// caller-chosen logical ID.
export function validateResourceMappings(mappings) {
  if (!Array.isArray(mappings) || mappings.length !== 1) throw new Error('Exactly one resource mapping is required');
  const [mapping] = mappings;
  same(mapping, {
    Source: { StackName: WORKLOAD_STACK, LogicalResourceId: SOURCE_LOGICAL_ID },
    Destination: { StackName: BASE_STACK, LogicalResourceId: DESTINATION_LOGICAL_ID },
  }, 'Resource mapping');
  if (mapping.Destination.LogicalResourceId !== API_DISTRIBUTION.logicalId) {
    throw new Error('The mapping destination is not the CDK-pinned distribution logical ID');
  }
  return mapping;
}

// (b) Validate the recorded preview. A clean preview is exactly one resource
// MOVE of the API distribution with no configuration change and no CREATE,
// DELETE or UPDATE. Anything else aborts before execution.
export function validateRefactorPreview({ describe, actions: previewActions, resourceMappings }) {
  if (!describe || typeof describe !== 'object') throw new Error('Refactor preview description is required');
  if (describe.ExecutionStatus !== 'AVAILABLE') throw new Error(`Refactor preview is not available: ${describe.ExecutionStatus ?? 'unavailable'}`);
  if (describe.StatusReason !== null && describe.StatusReason !== undefined) throw new Error('Refactor preview reports a status reason');
  if ((describe.UnsupportedResources ?? []).length) throw new Error('Refactor preview reports an unsupported resource');
  if ((describe.Conflicts ?? []).length) throw new Error('Refactor preview reports a conflict');
  const mapping = validateResourceMappings(resourceMappings);
  const list = previewActions?.StackRefactorActions;
  if (!Array.isArray(list) || list.length !== 1) {
    throw new Error(`Refactor preview must contain exactly one action; got ${Array.isArray(list) ? list.length : 'none'}`);
  }
  const [action] = list;
  if (action.Action !== REFACTOR_ACTION.action) throw new Error(`Refactor preview action ${action.Action} is not the single MOVE`);
  if (action.Entity !== undefined && action.Entity !== REFACTOR_ACTION.entity) throw new Error('Refactor preview action is not a resource action');
  const identifier = action.ResourceIdentifier ?? {};
  if (identifier.ResourceType !== REFACTOR_ACTION.resourceType) throw new Error('Refactor preview moves an unexpected resource type');
  if (identifier.LogicalResourceId !== mapping.Source.LogicalResourceId && identifier.LogicalResourceId !== mapping.Destination.LogicalResourceId) {
    throw new Error('Refactor preview does not move the mapped distribution');
  }
  return { clean: true, action, mapping };
}

// (c) Post-execution readback: the same physical distribution must exist in the
// Base stack with its domain preserved and a `Deployed` status.
export function validateReadback({ before, after, distribution }) {
  if (!before?.PhysicalResourceId || !after?.PhysicalResourceId) throw new Error('Distribution physical ID unavailable before or after the move');
  if (before.PhysicalResourceId !== after.PhysicalResourceId) throw new Error('The moved distribution changed physical ID');
  if (after.StackName !== BASE_STACK) throw new Error('The moved distribution is not in the Base stack');
  if (distribution?.Status !== 'Deployed') throw new Error(`The moved distribution is not Deployed: ${distribution?.Status ?? 'unavailable'}`);
  if (distribution.Id !== before.PhysicalResourceId) throw new Error('CloudFront distribution ID differs after the move');
  return { physicalId: before.PhysicalResourceId, domain: distribution.DomainName, status: distribution.Status };
}

// CLI -----------------------------------------------------------------------
const OPTIONS = Object.freeze({
  '--stage': true, '--workload-template': true, '--base-template': true, '--base-synth-template': true,
  '--api-load-balancer-dns-name': true, '--distribution-type': true, '--workload-stack-policy': true,
  '--base-stack-policy': true, '--describe': true, '--actions': true, '--resource-mappings': true,
  '--output': false, '--apply': false,
});

function parseArguments(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!Object.hasOwn(OPTIONS, name)) throw new Error(`Unknown migration argument ${name}`);
    if (OPTIONS[name] === false) { options[name.slice(2)] = true; continue; }
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value) throw new Error(`Migration argument ${name} requires a value`);
    options[name.slice(2)] = value;
    index += 1;
  }
  if (!STAGES.includes(options.stage)) throw new Error(`--stage must be one of ${STAGES.join(', ')}`);
  return options;
}

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const readOptionalJson = file => (file ? readJson(file) : undefined);

async function runAws(args, { run = defaultRun } = {}) {
  const stdout = await run('aws', args);
  return stdout.trim() ? JSON.parse(stdout) : {};
}

async function defaultRun(command, args) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const result = await promisify(execFile)(command, args, { maxBuffer: 10 * 1024 * 1024, timeout: 600_000 });
  return result.stdout;
}

// Runs one explicitly selected stage. Validation-only unless `--apply` is given.
// This is the only place that can call AWS, and it never does so implicitly.
export async function runStage(options, { run = defaultRun } = {}) {
  const stage = options.stage;
  if (stage === 'pre-move') {
    const plan = preMoveWorkloadUpdate(readJson(options['workload-template']), {
      apiLoadBalancerDnsName: options['api-load-balancer-dns-name'],
    });
    if (!options.apply) return { stage, applied: false, ...plan };
    // Write the minimal delta template and apply it in place. The pipeline is
    // passed as one argument so no shell parses the template.
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const directory = await mkdtemp(path.join(tmpdir(), 'anywear-beta-split-'));
    const templateFile = path.join(directory, 'workload-pre-move.template.json');
    await writeFile(templateFile, `${JSON.stringify(plan.template, null, 2)}\n`);
    await runAws(['cloudformation', 'update-stack', '--stack-name', WORKLOAD_STACK,
      '--template-body', `file://${templateFile}`, '--capabilities', 'CAPABILITY_NAMED_IAM'], { run });
    await runAws(['cloudformation', 'wait', 'stack-update-complete', '--stack-name', WORKLOAD_STACK], { run });
    return { stage, applied: true, changes: plan.changes, removedDependsOn: plan.removedDependsOn };
  }
  if (stage === 'preview') {
    const liveWorkload = readJson(options['workload-template']);
    const liveBase = readJson(options['base-template']);
    assertRefactorEligibility({ distributionType: readOptionalJson(options['distribution-type']),
      workloadStackPolicy: options['workload-stack-policy'] === undefined ? undefined : readOptionalJson(options['workload-stack-policy']),
      baseStackPolicy: options['base-stack-policy'] === undefined ? undefined : readOptionalJson(options['base-stack-policy']),
      workloadTemplate: liveWorkload });
    const templates = buildRefactorTemplates({ liveWorkload, liveBase,
      baseSynth: readJson(options['base-synth-template']) });
    validateResourceMappings(templates.resourceMappings);
    if (!options.apply) return { stage, applied: false, ...templates };
    const input = {
      StackDefinitions: [
        { StackName: WORKLOAD_STACK, TemplateBody: templates.source },
        { StackName: BASE_STACK, TemplateBody: templates.target },
      ],
      ResourceMappings: templates.resourceMappings,
    };
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const directory = await mkdtemp(path.join(tmpdir(), 'anywear-beta-split-'));
    const inputFile = path.join(directory, 'create-stack-refactor.json');
    await writeFile(inputFile, `${JSON.stringify(input)}\n`);
    const created = await runAws(['cloudformation', 'create-stack-refactor', '--cli-input-json', `file://${inputFile}`], { run });
    const preview = { describe: await runAws(['cloudformation', 'describe-stack-refactor',
      '--stack-refactor-id', created.StackRefactorId], { run }),
    actions: await runAws(['cloudformation', 'list-stack-refactor-actions',
      '--stack-refactor-id', created.StackRefactorId], { run }) };
    const clean = validateRefactorPreview({ ...preview, resourceMappings: templates.resourceMappings });
    return { stage, applied: true, stackRefactorId: created.StackRefactorId, preview, clean };
  }
  // execute: re-validate the recorded preview before the separate execution call.
  const describe = readJson(options.describe);
  const previewActions = readJson(options.actions);
  const mappings = readJson(options['resource-mappings']);
  const clean = validateRefactorPreview({ describe, actions: previewActions, resourceMappings: mappings });
  if (!options.apply) return { stage, applied: false, clean };
  if (!describe.StackRefactorId) throw new Error('A recorded StackRefactorId is required to execute');
  await runAws(['cloudformation', 'execute-stack-refactor', '--stack-refactor-id', describe.StackRefactorId], { run });
  await runAws(['cloudformation', 'wait', 'stack-refactor-complete', '--stack-refactor-id', describe.StackRefactorId], { run });
  return { stage, applied: true, clean, stackRefactorId: describe.StackRefactorId,
    readback: 'Read the distribution physical ID/domain/Deployed status and both stacks before deleting the Workload stack' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArguments(process.argv.slice(2));
  const result = await runStage(options);
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(options.output, output);
  }
  process.stdout.write(output);
}
