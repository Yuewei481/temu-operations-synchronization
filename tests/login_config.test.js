import assert from 'node:assert/strict';
import test from 'node:test';
import { hasCompleteSellerCredentials } from '../scripts/sync_collect_to_wps.js';

test('automatic TEMU login is enabled only when all credentials are present', () => {
  assert.equal(hasCompleteSellerCredentials({
    SELLER_PHONE_COUNTRY_CODE: '86',
    SELLER_PHONE: '13800000000',
    SELLER_PASSWORD: 'local-only-password',
  }), true);
});

test('partial TEMU credentials fall back to manual login', () => {
  assert.equal(hasCompleteSellerCredentials({ SELLER_PHONE_COUNTRY_CODE: '86' }), false);
  assert.equal(hasCompleteSellerCredentials({
    SELLER_PHONE_COUNTRY_CODE: '86',
    SELLER_PHONE: '13800000000',
    SELLER_PASSWORD: '',
  }), false);
  assert.equal(hasCompleteSellerCredentials({}), false);
});
