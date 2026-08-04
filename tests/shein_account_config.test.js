import test from 'node:test';
import assert from 'node:assert/strict';
import { isSheinEnabled, readSheinAccountsFromEnv } from '../scripts/shein_account_config.js';

function baseEnv() {
  return {
    SHEIN_ENABLED: '1',
    SHEIN_ACCOUNT_COUNT: '1',
    SHEIN_OUTPUT_MODE: '1',
    SHEIN_ACCOUNT_1_NAME: 'SHEIN 1',
    SHEIN_ACCOUNT_1_CDP_PORT: '9322',
    SHEIN_ACCOUNT_1_CHROME_PROFILE: 'profiles/shein1',
    SHEIN_ACCOUNT_1_SOURCE_EXCEL: 'data/lookup.xlsx',
    SHEIN_ACCOUNT_1_SOURCE_EXCEL_SKU_CARGO_PRIMARY_COLUMN: 'A',
    SHEIN_ACCOUNT_1_SOURCE_EXCEL_SKU_CARGO_SECONDARY_COLUMN: 'B',
    SHEIN_ACCOUNT_1_SOURCE_EXCEL_NAME_COLUMN: 'C',
    SHEIN_ACCOUNT_1_EXPORT_EXCEL_PATH: 'output/shein1.xlsx',
  };
}

test('SHEIN is opt-in', () => {
  assert.equal(isSheinEnabled({}), false);
  assert.equal(isSheinEnabled({ SHEIN_ENABLED: '1' }), true);
});

test('builds an isolated SHEIN account using the existing lookup and output contract', () => {
  const [account] = readSheinAccountsFromEnv(baseEnv(), '/workspace');
  assert.equal(account.name, 'SHEIN 1');
  assert.equal(account.cdpPort, '9322');
  assert.equal(account.env.SOURCE_EXCEL_PATH, '/workspace/data/lookup.xlsx');
  assert.equal(account.env.SOURCE_EXCEL_SKU_CARGO_PRIMARY_COLUMN, 'A');
  assert.equal(account.env.SALES_DATA_JSON_PATH, '/workspace/output/shein-account-1-sales-data.json');
  assert.equal(account.env.WPS_UPDATE_PAYLOAD, '/workspace/output/shein-account-1-wps-payload.json');
  assert.equal(account.env.SHEIN_LOGIN_TIMEOUT_MS, '1800000');
});

test('only validates settings for the selected SHEIN output mode', () => {
  const env = baseEnv();
  env.SHEIN_OUTPUT_MODE = '3';
  delete env.SHEIN_ACCOUNT_1_EXPORT_EXCEL_PATH;
  env.SHEIN_ACCOUNT_1_WPS_DOC_URL = 'https://www.kdocs.cn/l/example';
  env.SHEIN_ACCOUNT_1_WPS_SHEET_NAME = '运营数据记录表';
  env.SHEIN_ACCOUNT_1_WPS_DATE_COLUMN = 'A';
  env.SHEIN_ACCOUNT_1_WPS_NAME_COLUMN = 'B';
  env.SHEIN_ACCOUNT_1_WPS_SALES_COLUMN = 'C';
  env.SHEIN_ACCOUNT_1_WPS_START_ROW = '4';
  const [account] = readSheinAccountsFromEnv(env, '/workspace');
  assert.equal(account.outputMode, 3);
  assert.equal(account.env.WPS_DATE_COLUMN, 'A');
});

test('multiple SHEIN accounts may share one lookup workbook', () => {
  const env = baseEnv();
  env.SHEIN_ACCOUNT_COUNT = '2';
  env.SHEIN_ACCOUNT_2_NAME = 'SHEIN 2';
  env.SHEIN_ACCOUNT_2_CDP_PORT = '9323';
  env.SHEIN_ACCOUNT_2_CHROME_PROFILE = 'profiles/shein2';
  env.SHEIN_ACCOUNT_2_SOURCE_EXCEL = 'data/lookup.xlsx';
  env.SHEIN_ACCOUNT_2_SOURCE_EXCEL_SKU_CARGO_PRIMARY_COLUMN = 'A';
  env.SHEIN_ACCOUNT_2_SOURCE_EXCEL_SKU_CARGO_SECONDARY_COLUMN = 'B';
  env.SHEIN_ACCOUNT_2_SOURCE_EXCEL_NAME_COLUMN = 'C';
  env.SHEIN_ACCOUNT_2_EXPORT_EXCEL_PATH = 'output/shein2.xlsx';

  const accounts = readSheinAccountsFromEnv(env, '/workspace');
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].sourceExcel, '/workspace/data/lookup.xlsx');
  assert.equal(accounts[1].sourceExcel, '/workspace/data/lookup.xlsx');
});
