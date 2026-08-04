import assert from 'node:assert/strict';
import test from 'node:test';
import { chromePathCandidates, resolveChromePath } from '../scripts/chrome_path.js';

test('uses an explicit CHROME_PATH before automatic detection', () => {
  const result = resolveChromePath(
    { CHROME_PATH: 'D:\\Apps\\Chrome\\chrome.exe' },
    { platform: 'win32', pathExists: (value) => value === 'D:\\Apps\\Chrome\\chrome.exe' },
  );
  assert.equal(result, 'D:\\Apps\\Chrome\\chrome.exe');
});

test('detects Chrome from LOCALAPPDATA on Windows', () => {
  const env = {
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  };
  const expected = 'C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
  const result = resolveChromePath(env, {
    platform: 'win32',
    pathExists: (value) => value === expected,
  });
  assert.equal(result, expected);
});

test('lists all standard Windows Chrome locations', () => {
  const candidates = chromePathCandidates(
    {
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    },
    'win32',
  );
  assert.equal(candidates.length, 3);
});
