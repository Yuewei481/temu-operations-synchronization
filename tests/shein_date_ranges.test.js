import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSheinDateRanges, normalizeIsoDate, parseSheinTargetDates } from '../scripts/shein_date_ranges.js';

test('normalizes SHEIN dates and rejects impossible dates', () => {
  assert.equal(normalizeIsoDate('2026/8/2'), '2026-08-02');
  assert.equal(normalizeIsoDate('2026-02-30'), '');
});

test('groups unordered requested dates into ascending contiguous ranges', () => {
  assert.deepEqual(
    groupSheinDateRanges(['2026-07-02', '2026-07-03', '2026-07-01', '2026-07-05']),
    [
      {
        start: '2026-07-01',
        end: '2026-07-03',
        dates: ['2026-07-01', '2026-07-02', '2026-07-03'],
      },
      { start: '2026-07-05', end: '2026-07-05', dates: ['2026-07-05'] },
    ],
  );
});

test('splits a contiguous range at the configured maximum length', () => {
  const dates = Array.from({ length: 35 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, index + 1));
    return date.toISOString().slice(0, 10);
  });
  const ranges = groupSheinDateRanges(dates, 31);
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].start, '2026-01-01');
  assert.equal(ranges[0].end, '2026-01-31');
  assert.equal(ranges[1].start, '2026-02-01');
  assert.equal(ranges[1].end, '2026-02-04');
});

test('parses and deduplicates configured target dates', () => {
  assert.deepEqual(
    parseSheinTargetDates({ SHEIN_TARGET_DATES: '2026-08-02,2026/08/01,2026-08-02' }),
    ['2026-08-01', '2026-08-02'],
  );
});
