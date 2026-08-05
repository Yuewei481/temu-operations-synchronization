import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDailyTotalLayout,
  normalizeDailyTotalPayloadRows,
} from '../scripts/update_wps_daily_totals_cdp.js';

test('builds a two-column daily-total WPS layout', () => {
  assert.deepEqual(
    buildDailyTotalLayout({
      WPS_TOTAL_DATE_COLUMN: 'G',
      WPS_TOTAL_SALES_COLUMN: 'H',
      WPS_TOTAL_START_ROW: '3',
    }),
    { dateColumn: 7, salesColumn: 8, startRow: 3 },
  );
});

test('sorts daily totals and preserves zero sales', () => {
  assert.deepEqual(
    normalizeDailyTotalPayloadRows([
      { date: '2026/8/1', sales: 0 },
      { date: '2026-07-31', sales: '12' },
    ]),
    [
      { date: '2026/7/31', sales: 12 },
      { date: '2026/8/1', sales: 0 },
    ],
  );
});

test('rejects duplicate daily-total dates', () => {
  assert.throws(
    () => normalizeDailyTotalPayloadRows([
      { date: '2026/7/31', sales: 1 },
      { date: '2026-07-31', sales: 2 },
    ]),
    /Duplicate WPS daily-total date/,
  );
});

test('rejects impossible daily-total dates', () => {
  assert.throws(
    () => normalizeDailyTotalPayloadRows([{ date: '2026/2/31', sales: 1 }]),
    /Invalid WPS daily-total date/,
  );
});
