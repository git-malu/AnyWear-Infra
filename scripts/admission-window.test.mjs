import test from 'node:test';
import assert from 'node:assert/strict';
import { ADMISSION_WINDOW_CLOCK_SKEW_MS, WINDOW_MINUTES_DEFAULT, WINDOW_MINUTES_MAX, WINDOW_MINUTES_MIN,
  admissionWindowPayload, parseWindowMinutes } from './admission-window.mjs';

test('the reviewed bound is 15-240 minutes with a 60 minute default', () => {
  assert.equal(WINDOW_MINUTES_MIN, 15);
  assert.equal(WINDOW_MINUTES_MAX, 240);
  assert.equal(WINDOW_MINUTES_DEFAULT, 60);
  assert.ok(WINDOW_MINUTES_MIN < WINDOW_MINUTES_DEFAULT && WINDOW_MINUTES_DEFAULT < WINDOW_MINUTES_MAX);
});

test('the clock-skew allowance is one named minute for the separate writer and reader containers', () => {
  // Same value and same reason as the Service admission read: the one-shot
  // writer and the reading task do not share a clock. It never widens the bound
  // itself, which the payload parser still caps at 240 minutes.
  assert.equal(ADMISSION_WINDOW_CLOCK_SKEW_MS, 60_000);
  assert.throws(() => parseWindowMinutes('241'), /integer from 15 to 240/);
  assert.equal(parseWindowMinutes('240'), 240);
});

test('the shared parser accepts only an integer inside the reviewed range', () => {
  // A GitHub Actions `type: number` input reaches the executor as a decimal string.
  for (const [input, expected] of [[15, 15], [60, 60], [240, 240], ['15', 15], ['60', 60], ['240', 240]]) {
    assert.equal(parseWindowMinutes(input), expected, String(input));
  }
  for (const input of [14, 241, 0, -60, 60.5, '14', '241', '0', '-60', '60.5', '60.0', '060',
    ' 60', '60 ', '6e1', '0x3c', 'sixty', '', ' ', null, undefined, true, false, [], {}, [60], { minutes: 60 }, NaN, Infinity]) {
    assert.throws(() => parseWindowMinutes(input), /integer from 15 to 240/, String(input));
  }
});

test('the canonical payload is one byte string built from the dispatch input only', () => {
  assert.equal(admissionWindowPayload({ WINDOW_MINUTES: '60' }), '{"window_minutes":60}');
  assert.equal(admissionWindowPayload({ WINDOW_MINUTES: '15' }), '{"window_minutes":15}');
  assert.equal(admissionWindowPayload({ WINDOW_MINUTES: 240 }), '{"window_minutes":240}');
  // Same input, same bytes: the driver and the guard cannot drift.
  assert.equal(admissionWindowPayload({ WINDOW_MINUTES: '90', INFRA_OPERATION: 'open-admission' }),
    admissionWindowPayload({ WINDOW_MINUTES: '90' }));
  for (const env of [{}, { WINDOW_MINUTES: undefined }, { WINDOW_MINUTES: '14' }, { WINDOW_MINUTES: '241' },
    { WINDOW_MINUTES: '60.0' }, { WINDOW_MINUTES: 'sixty' }]) {
    assert.throws(() => admissionWindowPayload(env), /integer from 15 to 240/, JSON.stringify(env));
  }
});
