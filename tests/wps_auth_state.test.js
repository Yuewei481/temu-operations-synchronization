import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isMatchingWpsDocumentPage,
  isRecoverableWpsNavigationError,
  isWpsLoginPage,
  isWpsSignInText,
} from '../scripts/wps_auth_state.js';

const docUrl = 'https://www.kdocs.cn/l/test-document-id';

test('matches only the exact WPS document path', () => {
  assert.equal(isMatchingWpsDocumentPage({ type: 'page', url: docUrl }, docUrl), true);
  assert.equal(
    isMatchingWpsDocumentPage({ type: 'page', url: `${docUrl}?from=login` }, docUrl),
    true,
  );
  assert.equal(
    isMatchingWpsDocumentPage({ type: 'page', url: `${docUrl}/edit` }, docUrl),
    true,
  );
  assert.equal(
    isMatchingWpsDocumentPage({
      type: 'page',
      url: `https://account.wps.cn/login?cb=${encodeURIComponent(docUrl)}`,
    }, docUrl),
    false,
  );
  assert.equal(
    isMatchingWpsDocumentPage({ type: 'page', url: 'https://www.kdocs.cn/l/another-doc' }, docUrl),
    false,
  );
});

test('recognizes WPS account login pages independently from callback URLs', () => {
  assert.equal(isWpsLoginPage({ type: 'page', url: 'https://account.wps.cn/v1/chooseaccount' }), true);
  assert.equal(isWpsLoginPage({ type: 'page', url: 'https://account.kdocs.cn/passport' }), true);
  assert.equal(isWpsLoginPage({ type: 'page', url: docUrl }), false);
});

test('recognizes common visible WPS sign-in controls', () => {
  for (const label of ['Sign In', 'Sign In Now', 'Login', '\u767b\u5f55', '\u7acb\u5373\u767b\u5f55', '\u767b\u5f55\u8d26\u53f7']) {
    assert.equal(isWpsSignInText(label), true, label);
  }
  assert.equal(isWpsSignInText('\u5206\u4eab'), false);
  assert.equal(isWpsSignInText('\u8fd0\u8425\u6570\u636e\u8bb0\u5f55\u8868'), false);
});

test('classifies login navigation replacement errors as recoverable', () => {
  for (const message of [
    'Inspected target navigated or closed',
    'WebSocket connection closed',
    'Target closed',
    'Promise was collected',
    'WPS login required after attempted write',
  ]) {
    assert.equal(isRecoverableWpsNavigationError(new Error(message)), true, message);
  }
  assert.equal(isRecoverableWpsNavigationError(new Error('Wrong sheet name')), false);
});
