import { canonicalJson } from './json-contract.mjs';

// The admission window bound is one reviewed range, enforced at every point that
// can name it: the dispatch input, the one-shot payload guard, the driver and
// the recorded operation evidence. Keeping the constants, the parser and the
// payload builder in one module is what makes those points agree byte-for-byte
// instead of by a repeated literal.
export const WINDOW_MINUTES_MIN = 15;
export const WINDOW_MINUTES_MAX = 240;
export const WINDOW_MINUTES_DEFAULT = 60;
// The window writer is the one-shot lifecycle ECS container and the reader is
// the API/worker task, so the two clocks are independent. The bounded writer and
// the admission read allow the recorded expiry to sit at most this much beyond
// the requested bound; the dispatch input and the payload guard keep the hard
// 15–240 ceiling and do not use this allowance.
export const ADMISSION_WINDOW_CLOCK_SKEW_MS = 60_000;

// A dispatch `type: number` input reaches the executor as an environment string,
// so both a JavaScript safe integer and its canonical decimal string are
// accepted. Floats, signs, leading zeros, exponents, whitespace and every
// non-numeric form are rejected, as is any value outside the reviewed range.
const CANONICAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;

export function parseWindowMinutes(input) {
  let value = input;
  if (typeof value === 'string' && CANONICAL_INTEGER.test(value)) value = Number(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < WINDOW_MINUTES_MIN || value > WINDOW_MINUTES_MAX) {
    throw new Error(`Admission window minutes must be an integer from ${WINDOW_MINUTES_MIN} to ${WINDOW_MINUTES_MAX}`);
  }
  return value;
}

// The exact payload a lifecycle `open` action may carry. The dispatcher, the
// one-shot guard and the payload the driver sends are all this one byte string.
export function admissionWindowPayload(env = {}) {
  return canonicalJson({ window_minutes: parseWindowMinutes(env.WINDOW_MINUTES) });
}
