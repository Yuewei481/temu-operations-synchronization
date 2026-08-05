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

test('readSellerConfig reads local-only login settings', () => {
  const config = readSellerConfig({
    SELLER_PHONE_COUNTRY_CODE: '+86',
    SELLER_PHONE: 'local-login-id',
    SELLER_PASSWORD: 'local-secret-value',
  });

  assert.equal(config.countryCode, '86');
  assert.equal(config.phone, 'local-login-id');
  assert.equal(config.password, 'local-secret-value');
  assert.match(config.loginUrl, /^https:\/\/seller\.kuajingmaihuo\.com\/login/);
});

test('readSellerConfig rejects incomplete local credentials', () => {
  assert.throws(
    () => readSellerConfig({ SELLER_PHONE: 'local-login-id' }),
    /SELLER_PHONE_COUNTRY_CODE, SELLER_PASSWORD/,
  );
});
