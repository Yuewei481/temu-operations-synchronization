import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnvText, readSellerConfig } from '../scripts/config.js';

test('parseEnvText reads plain key value pairs and ignores comments', () => {
  assert.deepEqual(parseEnvText('A=1\n# comment\nB = two\nEMPTY=\n'), {
    A: '1',
    B: 'two',
    EMPTY: '',
  });
});

test('readSellerConfig returns normalized seller login settings', () => {
  const config = readSellerConfig({
    SELLER_PHONE_COUNTRY_CODE: '+86',
    SELLER_PHONE: '13800000000',
    SELLER_PASSWORD: 'secret',
  });

  assert.equal(config.countryCode, '86');
  assert.equal(config.phone, '13800000000');
  assert.equal(config.password, 'secret');
  assert.equal(config.loginUrl.startsWith('https://seller.kuajingmaihuo.com/login'), true);
});

test('readSellerConfig reports missing required env keys', () => {
  assert.throws(
    () => readSellerConfig({ SELLER_PHONE: '13800000000' }),
    /Missing required env values: SELLER_PHONE_COUNTRY_CODE, SELLER_PASSWORD/,
  );
});
