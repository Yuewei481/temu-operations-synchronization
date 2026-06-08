import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHumanDelayConfig, randomHumanDelayMs } from '../scripts/human_timing.js';

test('parseHumanDelayConfig uses default human delay range', () => {
  assert.deepEqual(parseHumanDelayConfig({}), {
    minMs: 2000,
    maxMs: 5000,
  });
});

test('parseHumanDelayConfig accepts custom second-based range', () => {
  assert.deepEqual(parseHumanDelayConfig({
    HUMAN_DELAY_MIN_SECONDS: '3',
    HUMAN_DELAY_MAX_SECONDS: '8',
  }), {
    minMs: 3000,
    maxMs: 8000,
  });
});

test('parseHumanDelayConfig rejects inverted ranges', () => {
  assert.throws(
    () => parseHumanDelayConfig({
      HUMAN_DELAY_MIN_SECONDS: '9',
      HUMAN_DELAY_MAX_SECONDS: '2',
    }),
    /HUMAN_DELAY_MIN_SECONDS must be less than or equal to HUMAN_DELAY_MAX_SECONDS/,
  );
});

test('randomHumanDelayMs stays within inclusive range', () => {
  for (let index = 0; index < 100; index += 1) {
    const value = randomHumanDelayMs({ minMs: 10, maxMs: 20 });
    assert.equal(Number.isInteger(value), true);
    assert.equal(value >= 10, true);
    assert.equal(value <= 20, true);
  }
});
