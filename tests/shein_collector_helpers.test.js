import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTrendRefreshRange,
  normalizeSheinCargoNumber,
  parseSalesTooltip,
  trendChartMatchesRange,
} from '../scripts/collect_shein_sales_cdp.js';

test('normalizes a SHEIN supplier cargo number to digits only', () => {
  assert.equal(normalizeSheinCargoNumber('PP-202512102'), '202512102');
  assert.equal(normalizeSheinCargoNumber('ZZ_2025-07-02'), '20250702');
});

test('parses date and sales from a SHEIN chart tooltip', () => {
  assert.deepEqual(parseSalesTooltip('2026/07/28\n销量 2'), {
    date: '2026-07-28',
    sales: 2,
  });
  assert.deepEqual(parseSalesTooltip('2026-08-02 销量 1,234'), {
    date: '2026-08-02',
    sales: 1234,
  });
  assert.equal(parseSalesTooltip('no tooltip'), null);
});

test('builds a different valid range to force the SHEIN chart to refresh', () => {
  assert.deepEqual(buildTrendRefreshRange('2026-07-31', '2026-07-31'), {
    start: '2026-07-30',
    end: '2026-07-30',
  });
  assert.deepEqual(buildTrendRefreshRange('2026-07-01', '2026-07-31'), {
    start: '2026-06-30',
    end: '2026-07-30',
  });
  assert.deepEqual(buildTrendRefreshRange('2026-07-31', '2026-07-31', 2), {
    start: '2026-07-29',
    end: '2026-07-29',
  });
});

test('detects stale SHEIN chart axis dates even when date inputs look correct', () => {
  assert.equal(trendChartMatchesRange(['2026-07-31'], '2026-07-31', '2026-07-31'), true);
  assert.equal(
    trendChartMatchesRange(
      ['2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02', '2026-08-03'],
      '2026-07-31',
      '2026-07-31',
    ),
    false,
  );
  assert.equal(
    trendChartMatchesRange(['2026-07-30', '2026-07-31'], '2026-07-30', '2026-07-31'),
    true,
  );
});
