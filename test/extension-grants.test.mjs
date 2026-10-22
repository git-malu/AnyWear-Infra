import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The #162 Workload extension adds deployed resources that CloudFormation
// creates with the separate execution role `beta-service-deploy-cfn-role`
// (AnyWear-Infra/lib/foundation-stack.ts), not with the OIDC deploy role. This
// table is the Service half of that cross-repository grant contract: a new
// resource type in the extension must arrive with its full create/update/read/
// delete action set. AnyWear-Infra holds the role half in
// `test/fixtures/workload-extension-resources.json` and the test
// "grants the CloudFormation execution role every action the #162 extension
// resource types need"; this test fails first if a new type appears here without
// being added to both sides.
export const REQUIRED_CFN_ACTIONS = Object.freeze({
  'AWS::CloudWatch::Alarm': Object.freeze([
    'cloudwatch:PutMetricAlarm', 'cloudwatch:DescribeAlarms', 'cloudwatch:DeleteAlarms',
  ]),
  'AWS::Logs::MetricFilter': Object.freeze([
    'logs:PutMetricFilter', 'logs:DescribeMetricFilters', 'logs:DeleteMetricFilter',
  ]),
});

const infraRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineRoot = path.join(infraRoot, 'test', 'baselines');
const provenance = JSON.parse(readFileSync(path.join(baselineRoot, 'provenance.json'), 'utf8'));
const template = JSON.parse(readFileSync(
  path.join(baselineRoot, 'beta-active', 'AnyWearRuntimeStack-beta.template.json'), 'utf8'));

function extensionResources() {
  const added = provenance.alarm_extension?.added_resources;
  assert.ok(Array.isArray(added) && added.length > 0, 'the recorded alarm extension is missing');
  return added.map((logicalId) => {
    const resource = template.Resources?.[logicalId];
    assert.ok(resource, `the recorded extension resource ${logicalId} is not in the baseline`);
    return { logicalId, resource };
  });
}

test('the #162 extension adds only resource types whose CloudFormation grant set is recorded', () => {
  const types = extensionResources().map(({ resource }) => resource.Type);
  assert.deepEqual([...new Set(types)].sort(), Object.keys(REQUIRED_CFN_ACTIONS).sort());
});

test('every extension resource type declares create/update, read and delete actions', () => {
  for (const [type, actions] of Object.entries(REQUIRED_CFN_ACTIONS)) {
    assert.equal(new Set(actions).size, actions.length, `${type} actions must be unique`);
    assert.ok(actions.some((action) => /:(Put|Create)/.test(action)), `${type} needs a create/update action`);
    assert.ok(actions.some((action) => /:(Describe|Get)/.test(action)), `${type} needs a read action`);
    assert.ok(actions.some((action) => /:Delete/.test(action)), `${type} needs a delete action`);
  }
});

test('the extension resources carry no tags, so the execution role needs no tag action', () => {
  for (const { logicalId, resource } of extensionResources()) {
    assert.equal(resource.Properties?.Tags, undefined, `${logicalId} unexpectedly carries Tags`);
  }
});
