import { isAbsolute, resolve } from 'node:path';
import { normalizeAccount, parseOutputMode, validateUniqueAccountSettings } from './sync_accounts_to_wps.js';

const DEFAULT_LOGIN_URL = 'https://sso.geiwohuo.com/#/login/';

export function readSheinAccountsFromEnv(env = process.env, configDir = process.cwd()) {
  const count = parseCount(env.SHEIN_ACCOUNT_COUNT || '1');
  const accounts = Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    const prefix = `SHEIN_ACCOUNT_${index}_`;
    const outputMode = parseOutputMode(env[`${prefix}OUTPUT_MODE`] || env.SHEIN_OUTPUT_MODE || env.OUTPUT_MODE);
    const raw = {
      name: env[`${prefix}NAME`] || `SHEIN ${index}`,
      cdpPort: env[`${prefix}CDP_PORT`] || 9321 + index,
      cdpOrigin: env[`${prefix}CDP_ORIGIN`],
      chromeProfile: env[`${prefix}CHROME_PROFILE`],
      sourceExcel: env[`${prefix}SOURCE_EXCEL`],
      sourceExcelSkuCargoPrimaryColumn: env[`${prefix}SOURCE_EXCEL_SKU_CARGO_PRIMARY_COLUMN`],
      sourceExcelSkuCargoSecondaryColumn: env[`${prefix}SOURCE_EXCEL_SKU_CARGO_SECONDARY_COLUMN`],
      sourceExcelNameColumn: env[`${prefix}SOURCE_EXCEL_NAME_COLUMN`],
      sourceExcelImageColumn: env[`${prefix}SOURCE_EXCEL_IMAGE_COLUMN`],
      outputMode,
      exportExcelPath: env[`${prefix}EXPORT_EXCEL_PATH`],
      targetExcelPath: env[`${prefix}TARGET_EXCEL_PATH`],
      targetExcelSheetName: env[`${prefix}TARGET_EXCEL_SHEET_NAME`],
      targetExcelDateColumn: env[`${prefix}TARGET_EXCEL_DATE_COLUMN`],
      targetExcelNameColumn: env[`${prefix}TARGET_EXCEL_NAME_COLUMN`],
      targetExcelSalesColumn: env[`${prefix}TARGET_EXCEL_SALES_COLUMN`],
      targetExcelStartRow: env[`${prefix}TARGET_EXCEL_START_ROW`],
      localDailyTotalEnabled:
        env[`${prefix}LOCAL_DAILY_TOTAL_ENABLED`] ?? env.SHEIN_LOCAL_DAILY_TOTAL_ENABLED ?? '0',
      localTotalExcelPath: env[`${prefix}LOCAL_TOTAL_EXCEL_PATH`],
      localTotalSheetName: env[`${prefix}LOCAL_TOTAL_SHEET_NAME`],
      localTotalDateColumn: env[`${prefix}LOCAL_TOTAL_DATE_COLUMN`],
      localTotalSalesColumn: env[`${prefix}LOCAL_TOTAL_SALES_COLUMN`],
      localTotalStartRow: env[`${prefix}LOCAL_TOTAL_START_ROW`],
      localDailyTotalPayload:
        env[`${prefix}LOCAL_DAILY_TOTAL_PAYLOAD`] || `output/shein-account-${index}-daily-totals.json`,
      wpsDocUrl: env[`${prefix}WPS_DOC_URL`],
      wpsSheetName: env[`${prefix}WPS_SHEET_NAME`],
      wpsDateColumn: env[`${prefix}WPS_DATE_COLUMN`],
      wpsNameColumn: env[`${prefix}WPS_NAME_COLUMN`],
      wpsSalesColumn: env[`${prefix}WPS_SALES_COLUMN`],
      wpsStartRow: env[`${prefix}WPS_START_ROW`],
      wpsDailyTotalEnabled:
        env[`${prefix}WPS_DAILY_TOTAL_ENABLED`] ?? env.SHEIN_WPS_DAILY_TOTAL_ENABLED ?? '1',
      wpsTotalDocUrl: env[`${prefix}WPS_TOTAL_DOC_URL`],
      wpsTotalSheetName: env[`${prefix}WPS_TOTAL_SHEET_NAME`],
      wpsTotalDateColumn: env[`${prefix}WPS_TOTAL_DATE_COLUMN`],
      wpsTotalSalesColumn: env[`${prefix}WPS_TOTAL_SALES_COLUMN`],
      wpsTotalStartRow: env[`${prefix}WPS_TOTAL_START_ROW`],
      wpsDailyTotalPayload:
        env[`${prefix}WPS_DAILY_TOTAL_PAYLOAD`] || `output/shein-account-${index}-daily-totals.json`,
      humanDelayMinSeconds: env[`${prefix}HUMAN_DELAY_MIN_SECONDS`] || env.SHEIN_HUMAN_DELAY_MIN_SECONDS,
      humanDelayMaxSeconds: env[`${prefix}HUMAN_DELAY_MAX_SECONDS`] || env.SHEIN_HUMAN_DELAY_MAX_SECONDS,
      manualLoginTimeoutMs: env[`${prefix}LOGIN_TIMEOUT_MS`] || env.SHEIN_LOGIN_TIMEOUT_MS || '1800000',
      closeChromeAfterRun: env[`${prefix}CLOSE_CHROME_AFTER_RUN`] || env.SHEIN_CLOSE_CHROME_AFTER_RUN || '1',
      chromePath: env[`${prefix}CHROME_PATH`] || env.CHROME_PATH,
      trafficTargetDates: env[`${prefix}TARGET_DATES`] || env.SHEIN_TARGET_DATES,
      pythonBin: env[`${prefix}PYTHON_BIN`] || env.PYTHON_BIN,
    };

    const normalized = normalizeAccount(raw, configDir, offset, {
      ...env,
      OUTPUT_MODE: String(outputMode),
    });
    const salesDataPath = resolveConfigPath(
      env[`${prefix}SALES_DATA_JSON_PATH`] || `output/shein-account-${index}-sales-data.json`,
      configDir,
    );
    const wpsPayloadPath = resolveConfigPath(
      env[`${prefix}WPS_UPDATE_PAYLOAD`] || `output/shein-account-${index}-wps-payload.json`,
      configDir,
    );
    normalized.env = {
      ...normalized.env,
      SELLER_LOGIN_URL: env[`${prefix}LOGIN_URL`] || env.SHEIN_LOGIN_URL || DEFAULT_LOGIN_URL,
      SHEIN_HOME_URL: env.SHEIN_HOME_URL || 'https://sso.geiwohuo.com/#/home',
      SHEIN_PRODUCT_DETAILS_URL:
        env.SHEIN_PRODUCT_DETAILS_URL || 'https://sso.geiwohuo.com/#/sbn/merchandise/details',
      SHEIN_LOGIN_TIMEOUT_MS:
        env[`${prefix}LOGIN_TIMEOUT_MS`] || env.SHEIN_LOGIN_TIMEOUT_MS || '1800000',
      SHEIN_TARGET_DATES: env[`${prefix}TARGET_DATES`] || env.SHEIN_TARGET_DATES || '',
      SHEIN_TREND_RENDER_DELAY_MIN_SECONDS:
        env[`${prefix}TREND_RENDER_DELAY_MIN_SECONDS`] ||
        env.SHEIN_TREND_RENDER_DELAY_MIN_SECONDS ||
        '5',
      SHEIN_TREND_RENDER_DELAY_MAX_SECONDS:
        env[`${prefix}TREND_RENDER_DELAY_MAX_SECONDS`] ||
        env.SHEIN_TREND_RENDER_DELAY_MAX_SECONDS ||
        '7',
      SALES_DATA_JSON_PATH: salesDataPath,
      WPS_UPDATE_PAYLOAD: wpsPayloadPath,
      WPS_APPEND_PAYLOAD: wpsPayloadPath,
    };
    return {
      ...normalized,
      index,
      salesDataPath,
      wpsPayloadPath,
      dailyTotalsPayloadPath:
        normalized.localDailyTotalPayloadPath || normalized.wpsDailyTotalPayloadPath,
    };
  });

  validateUniqueAccountSettings(accounts);
  return accounts;
}

export function isSheinEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.SHEIN_ENABLED || '').trim().toLowerCase());
}

function parseCount(value) {
  const count = Number.parseInt(String(value), 10);
  if (!Number.isFinite(count) || count < 1) {
    throw new Error('SHEIN_ACCOUNT_COUNT must be a positive integer.');
  }
  return count;
}

function resolveConfigPath(value, configDir) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  return isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text) ? text : resolve(configDir, text);
}
