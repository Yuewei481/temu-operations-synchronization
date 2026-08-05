import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
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
  assert.equal(account.env.SOURCE_EXCEL_PATH, resolve('/workspace', 'data/lookup.xlsx'));
  assert.equal(account.env.SOURCE_EXCEL_SKU_CARGO_PRIMARY_COLUMN, 'A');
  assert.equal(account.env.SALES_DATA_JSON_PATH, resolve('/workspace', 'output/shein-account-1-sales-data.json'));
  assert.equal(account.env.WPS_UPDATE_PAYLOAD, resolve('/workspace', 'output/shein-account-1-wps-payload.json'));
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
  env.SHEIN_ACCOUNT_1_WPS_TOTAL_DOC_URL = 'https://www.kdocs.cn/l/totals';
  env.SHEIN_ACCOUNT_1_WPS_TOTAL_SHEET_NAME = '总销量表';
  env.SHEIN_ACCOUNT_1_WPS_TOTAL_DATE_COLUMN = 'G';
  env.SHEIN_ACCOUNT_1_WPS_TOTAL_SALES_COLUMN = 'H';
  env.SHEIN_ACCOUNT_1_WPS_TOTAL_START_ROW = '3';
  const [account] = readSheinAccountsFromEnv(env, '/workspace');
  assert.equal(account.outputMode, 3);
  assert.equal(account.env.WPS_DATE_COLUMN, 'A');
  assert.equal(account.env.WPS_TOTAL_DATE_COLUMN, 'G');
  assert.equal(account.env.WPS_TOTAL_SALES_COLUMN, 'H');
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
  assert.equal(accounts[0].sourceExcel, resolve('/workspace', 'data/lookup.xlsx'));
  assert.equal(accounts[1].sourceExcel, resolve('/workspace', 'data/lookup.xlsx'));
});

test('SHEIN local Excel mode maps its own daily-total destination', () => {
  const env = baseEnv();
  env.SHEIN_OUTPUT_MODE = '2';
  delete env.SHEIN_ACCOUNT_1_EXPORT_EXCEL_PATH;
  env.SHEIN_ACCOUNT_1_TARGET_EXCEL_PATH = 'output/shein-details.xlsx';
  env.SHEIN_ACCOUNT_1_TARGET_EXCEL_SHEET_NAME = '运营数据记录表';
  env.SHEIN_ACCOUNT_1_TARGET_EXCEL_DATE_COLUMN = 'I';
  env.SHEIN_ACCOUNT_1_TARGET_EXCEL_NAME_COLUMN = 'J';
  env.SHEIN_ACCOUNT_1_TARGET_EXCEL_SALES_COLUMN = 'K';
  env.SHEIN_ACCOUNT_1_TARGET_EXCEL_START_ROW = '4';
  env.SHEIN_ACCOUNT_1_LOCAL_DAILY_TOTAL_ENABLED = '1';
  env.SHEIN_ACCOUNT_1_LOCAL_TOTAL_SHEET_NAME = '总销量表';
  env.SHEIN_ACCOUNT_1_LOCAL_TOTAL_DATE_COLUMN = 'G';
  env.SHEIN_ACCOUNT_1_LOCAL_TOTAL_SALES_COLUMN = 'H';
  env.SHEIN_ACCOUNT_1_LOCAL_TOTAL_START_ROW = '3';

  const [account] = readSheinAccountsFromEnv(env, '/workspace');
  assert.equal(account.localDailyTotalEnabled, true);
  assert.equal(account.env.LOCAL_TOTAL_EXCEL_PATH, resolve('/workspace', 'output/shein-details.xlsx'));
  assert.equal(account.env.LOCAL_TOTAL_DATE_COLUMN, 'G');
  assert.equal(account.env.LOCAL_TOTAL_SALES_COLUMN, 'H');
  assert.equal(account.dailyTotalsPayloadPath, resolve('/workspace', 'output/shein-account-1-daily-totals.json'));
});

test('multiple SHEIN cloud accounts keep independent daily-total columns', () => {
  const env = {
    ...baseEnv(),
    SHEIN_ACCOUNT_COUNT: '2',
    SHEIN_OUTPUT_MODE: '3',
  };
  delete env.SHEIN_ACCOUNT_1_EXPORT_EXCEL_PATH;
  for (const index of [1, 2]) {
    env[`SHEIN_ACCOUNT_${index}_NAME`] = `SHEIN ${index}`;
    env[`SHEIN_ACCOUNT_${index}_CDP_PORT`] = String(9321 + index);
    env[`SHEIN_ACCOUNT_${index}_CHROME_PROFILE`] = `profiles/shein${index}`;
    env[`SHEIN_ACCOUNT_${index}_SOURCE_EXCEL`] = 'data/lookup.xlsx';
    env[`SHEIN_ACCOUNT_${index}_WPS_DOC_URL`] = 'https://www.kdocs.cn/l/details';
    env[`SHEIN_ACCOUNT_${index}_WPS_SHEET_NAME`] = '运营数据记录表';
    env[`SHEIN_ACCOUNT_${index}_WPS_DATE_COLUMN`] = index === 1 ? 'A' : 'D';
    env[`SHEIN_ACCOUNT_${index}_WPS_NAME_COLUMN`] = index === 1 ? 'B' : 'E';
    env[`SHEIN_ACCOUNT_${index}_WPS_SALES_COLUMN`] = index === 1 ? 'C' : 'F';
    env[`SHEIN_ACCOUNT_${index}_WPS_START_ROW`] = '3';
    env[`SHEIN_ACCOUNT_${index}_WPS_TOTAL_DOC_URL`] = 'https://www.kdocs.cn/l/totals';
    env[`SHEIN_ACCOUNT_${index}_WPS_TOTAL_SHEET_NAME`] = '总销量表';
    env[`SHEIN_ACCOUNT_${index}_WPS_TOTAL_DATE_COLUMN`] = index === 1 ? 'G' : 'J';
    env[`SHEIN_ACCOUNT_${index}_WPS_TOTAL_SALES_COLUMN`] = index === 1 ? 'H' : 'K';
    env[`SHEIN_ACCOUNT_${index}_WPS_TOTAL_START_ROW`] = '3';
  }

  const accounts = readSheinAccountsFromEnv(env, '/workspace');
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].env.WPS_TOTAL_DATE_COLUMN, 'G');
  assert.equal(accounts[0].env.WPS_TOTAL_SALES_COLUMN, 'H');
  assert.equal(accounts[1].env.WPS_TOTAL_DATE_COLUMN, 'J');
  assert.equal(accounts[1].env.WPS_TOTAL_SALES_COLUMN, 'K');
  assert.notEqual(accounts[0].dailyTotalsPayloadPath, accounts[1].dailyTotalsPayloadPath);
});
