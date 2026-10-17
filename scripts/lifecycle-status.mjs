import { parseJson, canonicalJson } from './json-contract.mjs';

// A shell's stdout proves neither the Service response nor its task identity.
// Read only the authenticated stopped task's actual CloudWatch destination.
export async function readLifecycleStatus(io, task, definition) {
  const taskId = task?.taskArn?.match(/^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/([a-f0-9]{32})$/)?.[1];
  const container = definition?.containerDefinitions?.find(item => item.name === 'OneShot');
  const options = container?.logConfiguration?.options;
  if (!taskId || task.clusterArn !== 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear'
    || task.lastStatus !== 'STOPPED' || task.taskDefinitionArn !== definition?.taskDefinitionArn
    || definition.family !== 'beta-anywear-lifecycle'
    || JSON.stringify(container?.command) !== JSON.stringify(['node', 'dist/ops/beta-lifecycle.js', 'status'])
    || container.logConfiguration.logDriver !== 'awslogs'
    || options?.['awslogs-group'] !== '/anywear/beta/one-shot'
    || options['awslogs-region'] !== 'ap-east-1' || options['awslogs-stream-prefix'] !== definition.family) {
    throw new Error('Exact stopped lifecycle status task/log destination is unproven');
  }
  const args = ['logs', 'get-log-events', '--log-group-name', options['awslogs-group'],
    '--log-stream-name', `${definition.family}/OneShot/${taskId}`, '--start-from-head', '--limit', '1000'];
  let previous;
  for (let attempt = 0; attempt < 5; attempt++) {
    let token; const seen = new Set(); const messages = [];
    for (let page = 0; page < 16; page++) {
      const response = await io.aws([...args, ...(token ? ['--next-token', token] : [])]);
      if (!Array.isArray(response.events) || response.events.length > 1000
        || response.events.some(event => typeof event?.message !== 'string')) throw new Error('Lifecycle status log page is malformed');
      messages.push(...response.events.map(event => event.message));
      if (messages.length > 4096) throw new Error('Lifecycle status log inventory exceeds its bound');
      const next = response.nextForwardToken;
      if (typeof next !== 'string' || !next || next.length > 4096) throw new Error('Lifecycle status log pagination is unproven');
      if (next === token) break;
      if (seen.has(next) || page === 15) throw new Error('Lifecycle status log pagination did not complete');
      seen.add(next); token = next;
    }
    const statuses = [];
    for (const message of messages) {
      // The pinned Service emits one plain JSON object; unrelated log messages
      // are not status evidence. A malformed apparent status fails closed.
      if (!/"intake_open"/.test(message) || !/"admission_suspended"/.test(message)) continue;
      const value = parseJson(message);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Lifecycle status must be an object');
      if (!Object.hasOwn(value, 'intake_open') || !Object.hasOwn(value, 'admission_suspended')) continue;
      statuses.push(value);
    }
    if (statuses.length > 1) throw new Error('Lifecycle status log evidence is ambiguous');
    if (statuses.length === 1) {
      const current = canonicalJson(statuses[0]);
      if (previous === current) return statuses[0];
      if (previous !== undefined) throw new Error('Lifecycle status log evidence changed during readback');
      previous = current;
    } else previous = undefined;
    // Require two complete matching scans after task cessation, accounting for
    // delayed CloudWatch ingestion rather than trusting a first partial view.
    if (attempt < 4) await io.sleep(2000);
  }
  throw new Error('Unique authenticated lifecycle status evidence is unavailable');
}
