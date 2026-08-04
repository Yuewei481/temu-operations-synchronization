import assert from 'node:assert/strict';
import test from 'node:test';

import { dateBatchKeys, orderRowsByDateBatch } from '../scripts/date_batches.js';

test('groups rows by date in ascending chronological order', () => {
  const rows = [
    { date: '2026/08/02', name: 'A' },
    { date: '2026-08-01', name: 'B' },
    { date: '2026年8月2日', name: 'C' },
    { date: '2026/8/1', name: 'D' },
  ];

  const ordered = orderRowsByDateBatch(rows);

  assert.deepEqual(ordered.map((row) => row.name), ['B', 'D', 'A', 'C']);
  assert.deepEqual(dateBatchKeys(ordered), ['2026/8/1', '2026/8/2']);
});
