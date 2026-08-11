import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import {
  normalizeAccount,
  parseOutputMode,
  readAccountsFromEnv,
  validateUniqueAccountSettings,
} from '../scripts/sync_accounts_to_wps.js';

const commonAccount = {
  name: 'TEMU 1',
  cdpPort: '9222',
  chromeProfile: 'profiles/temu1',
  sourceExcel: 'data/names.xlsx',
};

test('OUTPUT_MODE=1 only maps the standalone export target', () => {
  const account = normalizeAccount(
    {
      ...commonAccount,
      exportExcelPath: 'exports/temu1.xlsx',
      env: {
        WPS_DOC_URL: 'https://www.kdocs.cn/l/obsolete',
        LOCAL_TARGET_EXCEL_PATH: '/obsolete.xlsx',
        OUTPUT_MODE: '3',
      },
    },
    '/project',
    0,
    { OUTPUT_MODE: '1', WPS_DOC_URL: 'https://www.kdocs.cn/l/global-obsolete' },
  );

  assert.equal(account.outputMode, 1);
  assert.equal(account.exportExcelPath, resolve('/project', 'exports/temu1.xlsx'));
  assert.equal(account.env.SKU_SALES_EXCEL_PATH, resolve('/project', 'exports/temu1.xlsx'));
  assert.equal(account.env.WPS_DOC_URL, undefined);
  assert.equal(account.env.LOCAL_TARGET_EXCEL_PATH, undefined);
});

test('OUTPUT_MODE=2 only maps the existing local Excel target', () => {
  const account = normalizeAccount(
    {
      ...commonAccount,
      targetExcelPath: 'targets/temu1.xlsx',
      targetExcelSheetName: '运营数据记录表',
      targetExcelDateColumn: 'A',
      targetExcelNameColumn: 'B',
      targetExcelSalesColumn: 'C',
      targetExcelStartRow: '4',
    },
    '/project',
    0,
    { OUTPUT_MODE: '2' },
  );

  assert.equal(account.outputMode, 2);
  assert.equal(account.env.LOCAL_TARGET_EXCEL_PATH, resolve('/project', 'targets/temu1.xlsx'));
  assert.equal(account.env.LOCAL_TARGET_EXCEL_SHEET_NAME, '运营数据记录表');
  assert.equal(account.env.LOCAL_TARGET_DATE_COLUMN, 'A');
  assert.equal(account.env.LOCAL_TARGET_NAME_COLUMN, 'B');
  assert.equal(account.env.LOCAL_TARGET_SALES_COLUMN, 'C');
  assert.equal(account.env.LOCAL_TARGET_START_ROW, '4');
  assert.equal(account.env.SKU_SALES_EXCEL_PATH, undefined);
  assert.equal(account.env.WPS_DOC_URL, undefined);
});

test('OUTPUT_MODE=2 maps optional local daily-total settings', () => {
  const account = normalizeAccount(
    {
      ...commonAccount,
      targetExcelPath: 'targets/details.xlsx',
      targetExcelSheetName: '运营数据记录表',
      targetExcelDateColumn: 'A',
      targetExcelNameColumn: 'B',
      targetExcelSalesColumn: 'C',
      targetExcelStartRow: '4',
      localDailyTotalEnabled: '1',
      localTotalSheetName: '总销量表',
      localTotalDateColumn: 'G',
      localTotalSalesColumn: 'H',
      localTotalStartRow: '3',
    },
    '/project',
    0,
    { OUTPUT_MODE: '2' },
  );

  assert.equal(account.localDailyTotalEnabled, true);
  assert.equal(account.env.LOCAL_TOTAL_EXCEL_PATH, resolve('/project', 'targets/details.xlsx'));
  assert.equal(account.env.LOCAL_TOTAL_SHEET_NAME, '总销量表');
  assert.equal(account.env.LOCAL_TOTAL_DATE_COLUMN, 'G');
  assert.equal(account.env.LOCAL_TOTAL_SALES_COLUMN, 'H');
  assert.equal(account.env.LOCAL_TOTAL_START_ROW, '3');
  assert.equal(account.env.LOCAL_DAILY_TOTAL_PAYLOAD, resolve('/project', 'output/temu-account-1-daily-totals.json'));
});

test('OUTPUT_MODE=3 maps explicit WPS columns without a group title', () => {
  const account = normalizeAccount(
    {
      ...commonAccount,
      wpsDocUrl: 'https://www.kdocs.cn/l/account1',
      wpsSheetName: '运营数据记录表',
      wpsDateColumn: 'E',
      wpsNameColumn: 'F',
      wpsSalesColumn: 'G',
      wpsStartRow: '3',
      wpsDailyTotalEnabled: '1',
      wpsTotalDocUrl: 'https://www.kdocs.cn/l/totals1',
      wpsTotalSheetName: '总销量表',
      wpsTotalDateColumn: 'A',
      wpsTotalSalesColumn: 'B',
      wpsTotalStartRow: '3',
    },
    '/project',
    0,
    { OUTPUT_MODE: '3' },
  );

  assert.equal(account.outputMode, 3);
  assert.equal(account.env.WPS_DOC_URL, 'https://www.kdocs.cn/l/account1');
  assert.equal(account.env.WPS_SHEET_NAME, '运营数据记录表');
  assert.equal(account.env.WPS_DATE_COLUMN, 'E');
  assert.equal(account.env.WPS_NAME_COLUMN, 'F');
  assert.equal(account.env.WPS_SALES_COLUMN, 'G');
  assert.equal(account.env.WPS_START_ROW, '3');
  assert.equal(account.env.WPS_TOTAL_DOC_URL, 'https://www.kdocs.cn/l/totals1');
  assert.equal(account.env.WPS_TOTAL_SHEET_NAME, '总销量表');
  assert.equal(account.env.WPS_TOTAL_DATE_COLUMN, 'A');
  assert.equal(account.env.WPS_TOTAL_SALES_COLUMN, 'B');
  assert.equal(account.env.WPS_TOTAL_START_ROW, '3');
  assert.equal(account.env.SKU_SALES_EXCEL_PATH, undefined);
  assert.equal(account.env.LOCAL_TARGET_EXCEL_PATH, undefined);
});

test('ACCOUNT_COUNT dynamically reads a future ACCOUNT_3 block', () => {
  const accounts = readAccountsFromEnv({
    ACCOUNT_COUNT: '3',
    ACCOUNT_1_NAME: 'TEMU 1',
    ACCOUNT_2_NAME: 'TEMU 2',
    ACCOUNT_3_NAME: 'TEMU 3',
    ACCOUNT_3_CDP_PORT: '9224',
    ACCOUNT_3_CHROME_PROFILE: 'profiles/temu3',
    ACCOUNT_3_SOURCE_EXCEL: 'data/temu3.xlsx',
    ACCOUNT_3_WPS_DOC_URL: 'https://www.kdocs.cn/l/account3',
    ACCOUNT_3_WPS_SHEET_NAME: '运营数据记录表',
    ACCOUNT_3_WPS_DATE_COLUMN: 'J',
    ACCOUNT_3_WPS_NAME_COLUMN: 'K',
    ACCOUNT_3_WPS_SALES_COLUMN: 'L',
    ACCOUNT_3_WPS_START_ROW: '5',
    ACCOUNT_3_WPS_TOTAL_DOC_URL: 'https://www.kdocs.cn/l/totals',
    ACCOUNT_3_WPS_TOTAL_SHEET_NAME: '总销量表',
    ACCOUNT_3_WPS_TOTAL_DATE_COLUMN: 'J',
    ACCOUNT_3_WPS_TOTAL_SALES_COLUMN: 'K',
    ACCOUNT_3_WPS_TOTAL_START_ROW: '3',
  });

  assert.equal(accounts.length, 3);
  assert.equal(accounts[2].name, 'TEMU 3');
  assert.equal(accounts[2].cdpPort, '9224');
  assert.equal(accounts[2].wpsDateColumn, 'J');
  assert.equal(accounts[2].wpsStartRow, '5');
});

test('only the selected output mode is required', () => {
  assert.doesNotThrow(() => normalizeAccount(
    { ...commonAccount, exportExcelPath: 'exports/temu1.xlsx' },
    '/project',
    0,
    { OUTPUT_MODE: '1' },
  ));

  assert.throws(
    () => normalizeAccount(commonAccount, '/project', 0, { OUTPUT_MODE: '3' }),
    /wpsDocUrl/,
  );
});

test('rejects invalid output modes', () => {
  assert.throws(() => parseOutputMode(''), /OUTPUT_MODE must be/);
  assert.throws(() => parseOutputMode('4'), /OUTPUT_MODE must be/);
});

test('rejects duplicate export paths only for accounts using mode 1', () => {
  assert.throws(
    () => validateUniqueAccountSettings([
      {
        name: 'TEMU 1',
        outputMode: 1,
        cdpPort: '9222',
        chromeProfile: '/profiles/temu1',
        exportExcelPath: '/exports/shared.xlsx',
        targetExcelPath: '',
      },
      {
        name: 'TEMU 2',
        outputMode: 1,
        cdpPort: '9223',
        chromeProfile: '/profiles/temu2',
        exportExcelPath: '/exports/shared.xlsx',
        targetExcelPath: '',
      },
    ]),
    /export Excel path/,
  );
});

test('allows output modes 2 and 3 to reuse write targets without collision checks', () => {
  assert.doesNotThrow(() => validateUniqueAccountSettings([
    {
      name: 'TEMU 1',
      outputMode: 2,
      cdpPort: '9222',
      chromeProfile: '/profiles/temu1',
      targetExcelPath: '/targets/shared.xlsx',
      localDailyTotalEnabled: true,
      localDailyTotalPayloadPath: '/payloads/shared.json',
      localTotalTargetKey: '/targets/shared.xlsx|总销量表|A|B',
    },
    {
      name: 'TEMU 2',
      outputMode: 2,
      cdpPort: '9223',
      chromeProfile: '/profiles/temu2',
      targetExcelPath: '/targets/shared.xlsx',
      localDailyTotalEnabled: true,
      localDailyTotalPayloadPath: '/payloads/shared.json',
      localTotalTargetKey: '/targets/shared.xlsx|总销量表|A|B',
    },
    {
      name: 'SHEIN 1',
      outputMode: 3,
      cdpPort: '9332',
      chromeProfile: '/profiles/shein1',
      wpsDailyTotalEnabled: true,
      wpsDailyTotalPayloadPath: '/payloads/wps-shared.json',
      wpsTotalTargetKey: 'https://www.kdocs.cn/l/shared|总销量表|G|H',
    },
    {
      name: 'SHEIN 2',
      outputMode: 3,
      cdpPort: '9333',
      chromeProfile: '/profiles/shein2',
      wpsDailyTotalEnabled: true,
      wpsDailyTotalPayloadPath: '/payloads/wps-shared.json',
      wpsTotalTargetKey: 'https://www.kdocs.cn/l/shared|总销量表|G|H',
    },
  ]));
});
