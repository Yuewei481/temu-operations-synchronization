import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnvText } from '../scripts/config.js';

test('parseEnvText reads plain key value pairs and ignores comments', () => {
  assert.deepEqual(parseEnvText('A=1\n# comment\nB = two\nEMPTY=\n'), {
    A: '1',
    B: 'two',
    EMPTY: '',
  });
});
