import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './config.js';
import { syncOneAccount } from './sync_collect_to_wps.js';
import { closeCdpBrowser, getCdpOrigin } from './cdp_client.js';

const DEFAULT_ACCOUNTS_PATH = 'accounts.json';
const ACCOUNT_TARGET_ENV_KEYS = [
  'SKU_SALES_EXCEL_PATH',
  'LOCAL_TARGET_EXCEL_PATH',
  'LOCAL_TARGET_EXCEL_SHEET_NAME',
  'LOCAL_TARGET_DATE_COLUMN',
  'LOCAL_TARGET_NAME_COLUMN',
  'LOCAL_TARGET_SALES_COLUMN',
  'LOCAL_TARGET_START_ROW',
  'WPS_DOC_URL',
  'WPS_SHEET_NAME',
  'WPS_DATE_COLUMN',
  'WPS_NAME_COLUMN',
  'WPS_SALES_COLUMN',
  'WPS_START_ROW',
  'WPS_DAILY_TOTAL_ENABLED',
  'WPS_TOTAL_DOC_URL',
  'WPS_TOTAL_SHEET_NAME',
  'WPS_TOTAL_DATE_COLUMN',
  'WPS_TOTAL_SALES_COLUMN',
  'WPS_TOTAL_START_ROW',
  'WPS_DAILY_TOTAL_PAYLOAD',
];

async function main() {
  const fileEnv = await loadEnvFile('.env').catch(() => ({}));
  const baseEnv = { ...fileEnv, ...process.env };
  const explicitAccountsPath = process.argv[2] || baseEnv.ACCOUNTS_CONFIG;
  const hasEnvAccounts = hasAccountEnvConfig(baseEnv);
  const accountsPath = explicitAccountsPath
    ? resolve(explicitAccountsPath)
    : resolve(DEFAULT_ACCOUNTS_PATH);

  let accounts;
  let configDir = process.cwd();
  let configSource;

  if (hasEnvAccounts && !explicitAccountsPath) {
    accounts = readAccountsFromEnv(baseEnv);
    configSource = '.env';
  } else if (existsSync(accountsPath)) {
    const config = loadAccountsConfig(accountsPath);
    accounts = Array.isArray(config) ? config : config.accounts;
    configDir = dirname(accountsPath);
    configSource = accountsPath;
  } else if (hasEnvAccounts) {
    accounts = readAccountsFromEnv(baseEnv);
    configSource = '.env';
  } else {
    throw new Error(
      `No account config found. Create accounts.json, pass a config path, or add ACCOUNT_1_SOURCE_EXCEL / ACCOUNT_1_CHROME_PROFILE to .env.`,
    );
  }

  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error(`No accounts found in ${configSource}.`);
  }

  const normalizedAccounts = accounts.map((account, index) => normalizeAccount(account, configDir, index, baseEnv));
  validateUniqueAccountSettings(normalizedAccounts);

  console.log(`Loaded ${normalizedAccounts.length} account task(s) from ${configSource}.`);

  for (let index = 0; index < normalizedAccounts.length; index += 1) {
    const account = normalizedAccounts[index];
    console.log(`\n========== Account ${index + 1}/${normalizedAccounts.length}: ${account.name} ==========`);
    await syncOneAccount({
      sourceExcelPath: account.sourceExcel,
      env: account.env,
    });
  }

  const { isSheinEnabled, readSheinAccountsFromEnv } = await import('./shein_account_config.js');
  if (isSheinEnabled(baseEnv)) {
    console.log('\nSHEIN follow-up is enabled. Closing all configured TEMU Chrome sessions first...');
    await closeConfiguredBrowsers(normalizedAccounts);
    const sheinAccounts = readSheinAccountsFromEnv(baseEnv, process.cwd());
    const { syncSheinAccounts } = await import('./sync_shein_accounts.js');
    await syncSheinAccounts(sheinAccounts);
  }

  console.log('\nAll account sync tasks finished.');
}

async function closeConfiguredBrowsers(accounts) {
  for (const account of accounts) {
    const origin = getCdpOrigin(account.env);
    try {
      const closed = await closeCdpBrowser(origin);
      console.log(closed ? `Closed TEMU Chrome at ${origin}.` : `No TEMU Chrome to close at ${origin}.`);
    } catch (error) {
      console.log(`Unable to close TEMU Chrome at ${origin}: ${error.message}`);
    }
  }
}

function loadAccountsConfig(accountsPath) {
  try {
    return JSON.parse(readFileSync(accountsPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read accounts config at ${accountsPath}: ${error.message}`);
  }
}

export function readAccountsFromEnv(env) {
  const indexes = readAccountIndexes(env);
  return indexes.map((index) => ({
    name: env[`ACCOUNT_${index}_NAME`],
    cdpPort: env[`ACCOUNT_${index}_CDP_PORT`] || env[`ACCOUNT_${index}_PORT`],
    cdpOrigin: env[`ACCOUNT_${index}_CDP_ORIGIN`],
    chromeProfile: env[`ACCOUNT_${index}_CHROME_PROFILE`] || env[`ACCOUNT_${index}_CDP_USER_DATA_DIR`],
    sourceExcel: env[`ACCOUNT_${index}_SOURCE_EXCEL`] || env[`ACCOUNT_${index}_SOURCE_EXCEL_PATH`],
    sourceExcelSkuCargoPrimaryColumn:
      env[`ACCOUNT_${index}_SOURCE_EXCEL_SKU_CARGO_PRIMARY_COLUMN`] ||
      env[`ACCOUNT_${index}_SOURCE_EXCEL_SKU_CARGO_COLUMN`] ||
      env[`ACCOUNT_${index}_SOURCE_EXCEL_SPU_COLUMN`] ||
      env[`ACCOUNT_${index}_SOURCE_SPU_COLUMN`],
    sourceExcelSkuCargoSecondaryColumn:
      env[`ACCOUNT_${index}_SOURCE_EXCEL_SKU_CARGO_SECONDARY_COLUMN`],
    sourceExcelNameColumn:
      env[`ACCOUNT_${index}_SOURCE_EXCEL_NAME_COLUMN`] || env[`ACCOUNT_${index}_SOURCE_NAME_COLUMN`],
    sourceExcelImageColumn:
      env[`ACCOUNT_${index}_SOURCE_EXCEL_IMAGE_COLUMN`] || env[`ACCOUNT_${index}_SOURCE_IMAGE_COLUMN`],
    exportExcelPath:
      env[`ACCOUNT_${index}_EXPORT_EXCEL_PATH`] || env[`ACCOUNT_${index}_SKU_SALES_EXCEL_PATH`],
    targetExcelPath: env[`ACCOUNT_${index}_TARGET_EXCEL_PATH`],
    targetExcelSheetName: env[`ACCOUNT_${index}_TARGET_EXCEL_SHEET_NAME`],
    targetExcelDateColumn: env[`ACCOUNT_${index}_TARGET_EXCEL_DATE_COLUMN`],
    targetExcelNameColumn: env[`ACCOUNT_${index}_TARGET_EXCEL_NAME_COLUMN`],
    targetExcelSalesColumn: env[`ACCOUNT_${index}_TARGET_EXCEL_SALES_COLUMN`],
    targetExcelStartRow: env[`ACCOUNT_${index}_TARGET_EXCEL_START_ROW`],
    wpsDocUrl: env[`ACCOUNT_${index}_WPS_DOC_URL`],
    wpsSheetName: env[`ACCOUNT_${index}_WPS_SHEET_NAME`],
    wpsDateColumn: env[`ACCOUNT_${index}_WPS_DATE_COLUMN`],
    wpsNameColumn: env[`ACCOUNT_${index}_WPS_NAME_COLUMN`],
    wpsSalesColumn: env[`ACCOUNT_${index}_WPS_SALES_COLUMN`],
    wpsStartRow: env[`ACCOUNT_${index}_WPS_START_ROW`],
    wpsDailyTotalEnabled:
      env[`ACCOUNT_${index}_WPS_DAILY_TOTAL_ENABLED`] ?? env.WPS_DAILY_TOTAL_ENABLED ?? '1',
    wpsTotalDocUrl: env[`ACCOUNT_${index}_WPS_TOTAL_DOC_URL`],
    wpsTotalSheetName: env[`ACCOUNT_${index}_WPS_TOTAL_SHEET_NAME`],
    wpsTotalDateColumn: env[`ACCOUNT_${index}_WPS_TOTAL_DATE_COLUMN`],
    wpsTotalSalesColumn: env[`ACCOUNT_${index}_WPS_TOTAL_SALES_COLUMN`],
    wpsTotalStartRow: env[`ACCOUNT_${index}_WPS_TOTAL_START_ROW`],
    wpsDailyTotalPayload: env[`ACCOUNT_${index}_WPS_DAILY_TOTAL_PAYLOAD`],
    sellerPhoneCountryCode: env[`ACCOUNT_${index}_SELLER_PHONE_COUNTRY_CODE`],
    sellerPhone: env[`ACCOUNT_${index}_SELLER_PHONE`],
    sellerPassword: env[`ACCOUNT_${index}_SELLER_PASSWORD`],
    sellerLoginUrl: env[`ACCOUNT_${index}_SELLER_LOGIN_URL`],
    humanDelayMinSeconds: env[`ACCOUNT_${index}_HUMAN_DELAY_MIN_SECONDS`],
    humanDelayMaxSeconds: env[`ACCOUNT_${index}_HUMAN_DELAY_MAX_SECONDS`],
    manualLoginTimeoutMs: env[`ACCOUNT_${index}_MANUAL_LOGIN_TIMEOUT_MS`],
    sellerHomeWaitMs: env[`ACCOUNT_${index}_SELLER_HOME_WAIT_MS`],
    sellerHomeAfterEntryMinWaitMs: env[`ACCOUNT_${index}_SELLER_HOME_AFTER_ENTRY_MIN_WAIT_MS`],
    sellerHomeAfterEntryTimeoutMs: env[`ACCOUNT_${index}_SELLER_HOME_AFTER_ENTRY_TIMEOUT_MS`],
    wpsInitialWaitMs: env[`ACCOUNT_${index}_WPS_INITIAL_WAIT_MS`],
    wpsLoginTimeoutMs: env[`ACCOUNT_${index}_WPS_LOGIN_TIMEOUT_MS`],
    closeChromeAfterRun: env[`ACCOUNT_${index}_CLOSE_CHROME_AFTER_RUN`],
    chromePath: env[`ACCOUNT_${index}_CHROME_PATH`],
    trafficTargetDates: env[`ACCOUNT_${index}_TRAFFIC_TARGET_DATES`],
    trafficDateRange: env[`ACCOUNT_${index}_TRAFFIC_DATE_RANGE`],
    pythonBin: env[`ACCOUNT_${index}_PYTHON_BIN`],
  }));
}

function hasAccountEnvConfig(env) {
  return readAccountIndexes(env).length > 0;
}

function readAccountIndexes(env) {
  if (env.ACCOUNT_COUNT) {
    const count = Number.parseInt(env.ACCOUNT_COUNT, 10);
    if (!Number.isFinite(count) || count < 1) {
      throw new Error('ACCOUNT_COUNT must be a positive integer.');
    }
    return Array.from({ length: count }, (_, index) => index + 1);
  }

  const indexes = new Set();
  for (const key of Object.keys(env)) {
    const match = /^ACCOUNT_(\d+)_/.exec(key);
    if (match) {
      indexes.add(Number.parseInt(match[1], 10));
    }
  }

  return [...indexes].sort((a, b) => a - b);
}

export function normalizeAccount(rawAccount, configDir, index, baseEnv = process.env) {
  if (!rawAccount || typeof rawAccount !== 'object') {
    throw new Error(`Account at index ${index} must be an object.`);
  }

  const name = rawAccount.name || `Account ${index + 1}`;
  const outputMode = parseOutputMode(rawAccount.outputMode || baseEnv.OUTPUT_MODE);
  const cdpPort = String(rawAccount.cdpPort || rawAccount.port || 9222 + index);
  const cdpOrigin = rawAccount.cdpOrigin || `http://127.0.0.1:${cdpPort}`;
  const sourceExcel = resolveConfigPath(rawAccount.sourceExcel || rawAccount.sourceExcelPath, configDir);
  const chromeProfile = resolveConfigPath(rawAccount.chromeProfile || rawAccount.cdpUserDataDir, configDir);
  const sourceExcelSkuCargoPrimaryColumn =
    rawAccount.sourceExcelSkuCargoPrimaryColumn ||
    rawAccount.sourceExcelSkuCargoColumn ||
    rawAccount.sourceExcelSpuColumn ||
    rawAccount.sourceSpuColumn ||
    'A';
  const sourceExcelSkuCargoSecondaryColumn = rawAccount.sourceExcelSkuCargoSecondaryColumn || 'B';
  const sourceExcelNameColumn = rawAccount.sourceExcelNameColumn || rawAccount.sourceNameColumn;
  const sourceExcelImageColumn = rawAccount.sourceExcelImageColumn || rawAccount.sourceImageColumn;
  const exportExcelPath = outputMode === 1
    ? resolveConfigPath(rawAccount.exportExcelPath || rawAccount.skuSalesExcelPath, configDir)
    : '';
  const targetExcelPath = outputMode === 2
    ? resolveConfigPath(rawAccount.targetExcelPath, configDir)
    : '';
  const wpsDailyTotalEnabled = outputMode === 3 && booleanFlag(
    rawAccount.wpsDailyTotalEnabled ?? baseEnv.WPS_DAILY_TOTAL_ENABLED ?? '1',
  );
  const wpsDailyTotalPayloadPath = wpsDailyTotalEnabled
    ? resolveConfigPath(
      rawAccount.wpsDailyTotalPayload || `output/temu-account-${index + 1}-daily-totals.json`,
      configDir,
    )
    : '';

  if (!sourceExcel) {
    throw new Error(`Account "${name}" is missing sourceExcel.`);
  }
  if (!chromeProfile) {
    throw new Error(`Account "${name}" is missing chromeProfile.`);
  }

  validateModeSpecificAccount(rawAccount, {
    name,
    outputMode,
    exportExcelPath,
    targetExcelPath,
    wpsDailyTotalEnabled,
  });

  const extraEnv = { ...(rawAccount.env || {}) };
  for (const key of ACCOUNT_TARGET_ENV_KEYS) {
    delete extraEnv[key];
  }
  delete extraEnv.OUTPUT_MODE;

  const accountEnv = stringifyEnv({
    ...extraEnv,
    CDP_PORT: cdpPort,
    CDP_ORIGIN: cdpOrigin,
    CDP_USER_DATA_DIR: chromeProfile,
    SOURCE_EXCEL_PATH: sourceExcel,
    SOURCE_EXCEL_SKU_CARGO_PRIMARY_COLUMN: sourceExcelSkuCargoPrimaryColumn,
    SOURCE_EXCEL_SKU_CARGO_SECONDARY_COLUMN: sourceExcelSkuCargoSecondaryColumn,
    SOURCE_EXCEL_NAME_COLUMN: sourceExcelNameColumn,
    SOURCE_EXCEL_IMAGE_COLUMN: sourceExcelImageColumn,
    OUTPUT_MODE: outputMode,
    ...(outputMode === 1 ? {
      SKU_SALES_EXCEL_PATH: exportExcelPath,
    } : {}),
    ...(outputMode === 2 ? {
      LOCAL_TARGET_EXCEL_PATH: targetExcelPath,
      LOCAL_TARGET_EXCEL_SHEET_NAME: rawAccount.targetExcelSheetName,
      LOCAL_TARGET_DATE_COLUMN: rawAccount.targetExcelDateColumn,
      LOCAL_TARGET_NAME_COLUMN: rawAccount.targetExcelNameColumn,
      LOCAL_TARGET_SALES_COLUMN: rawAccount.targetExcelSalesColumn,
      LOCAL_TARGET_START_ROW: rawAccount.targetExcelStartRow,
    } : {}),
    ...(outputMode === 3 ? {
      WPS_DOC_URL: rawAccount.wpsDocUrl,
      WPS_SHEET_NAME: rawAccount.wpsSheetName,
      WPS_DATE_COLUMN: rawAccount.wpsDateColumn,
      WPS_NAME_COLUMN: rawAccount.wpsNameColumn,
      WPS_SALES_COLUMN: rawAccount.wpsSalesColumn,
      WPS_START_ROW: rawAccount.wpsStartRow,
      ...(wpsDailyTotalEnabled ? {
        WPS_DAILY_TOTAL_ENABLED: '1',
        WPS_TOTAL_DOC_URL: rawAccount.wpsTotalDocUrl,
        WPS_TOTAL_SHEET_NAME: rawAccount.wpsTotalSheetName,
        WPS_TOTAL_DATE_COLUMN: rawAccount.wpsTotalDateColumn,
        WPS_TOTAL_SALES_COLUMN: rawAccount.wpsTotalSalesColumn,
        WPS_TOTAL_START_ROW: rawAccount.wpsTotalStartRow,
        WPS_DAILY_TOTAL_PAYLOAD: wpsDailyTotalPayloadPath,
      } : {
        WPS_DAILY_TOTAL_ENABLED: '0',
      }),
    } : {}),
    SELLER_PHONE_COUNTRY_CODE: rawAccount.sellerPhoneCountryCode,
    SELLER_PHONE: rawAccount.sellerPhone,
    SELLER_PASSWORD: rawAccount.sellerPassword,
    SELLER_LOGIN_URL: rawAccount.sellerLoginUrl,
    HUMAN_DELAY_MIN_SECONDS: rawAccount.humanDelayMinSeconds,
    HUMAN_DELAY_MAX_SECONDS: rawAccount.humanDelayMaxSeconds,
    MANUAL_LOGIN_TIMEOUT_MS: rawAccount.manualLoginTimeoutMs,
    SELLER_HOME_WAIT_MS: rawAccount.sellerHomeWaitMs,
    SELLER_HOME_AFTER_ENTRY_MIN_WAIT_MS: rawAccount.sellerHomeAfterEntryMinWaitMs,
    SELLER_HOME_AFTER_ENTRY_TIMEOUT_MS: rawAccount.sellerHomeAfterEntryTimeoutMs,
    WPS_INITIAL_WAIT_MS: rawAccount.wpsInitialWaitMs,
    WPS_LOGIN_TIMEOUT_MS: rawAccount.wpsLoginTimeoutMs,
    CLOSE_CHROME_AFTER_RUN: rawAccount.closeChromeAfterRun,
    CHROME_PATH: rawAccount.chromePath,
    TRAFFIC_TARGET_DATES: rawAccount.trafficTargetDates,
    TRAFFIC_DATE_RANGE: rawAccount.trafficDateRange,
    PYTHON_BIN: rawAccount.pythonBin,
  });
  const inheritedEnv = { ...baseEnv };
  for (const key of ACCOUNT_TARGET_ENV_KEYS) {
    delete inheritedEnv[key];
  }
  const env = stringifyEnv({
    ...inheritedEnv,
    ...accountEnv,
  });

  return {
    name,
    sourceExcel,
    cdpPort,
    chromeProfile,
    outputMode,
    exportExcelPath,
    targetExcelPath,
    wpsDailyTotalEnabled,
    wpsDailyTotalPayloadPath,
    wpsTotalTargetKey: wpsDailyTotalEnabled
      ? [
        rawAccount.wpsTotalDocUrl,
        rawAccount.wpsTotalSheetName,
        String(rawAccount.wpsTotalDateColumn || '').toUpperCase(),
        String(rawAccount.wpsTotalSalesColumn || '').toUpperCase(),
      ].join('|')
      : '',
    env,
  };
}

export function validateUniqueAccountSettings(accounts) {
  assertUnique(accounts, 'cdpPort', 'CDP port');
  assertUnique(accounts, 'chromeProfile', 'Chrome profile');
  assertUniqueNonEmpty(accounts.filter((account) => account.outputMode === 1), 'exportExcelPath', 'export Excel path');
  assertUniqueNonEmpty(accounts.filter((account) => account.outputMode === 2), 'targetExcelPath', 'target Excel path');
  assertUniqueNonEmpty(
    accounts.filter((account) => account.wpsDailyTotalEnabled),
    'wpsDailyTotalPayloadPath',
    'daily-total payload path',
  );
  assertUniqueNonEmpty(
    accounts.filter((account) => account.wpsDailyTotalEnabled),
    'wpsTotalTargetKey',
    'WPS daily-total target',
  );
}

export function parseOutputMode(value) {
  const mode = Number.parseInt(String(value || '').trim(), 10);
  if (![1, 2, 3].includes(mode)) {
    throw new Error('OUTPUT_MODE must be 1 (export Excel), 2 (update local Excel), or 3 (update WPS Excel).');
  }
  return mode;
}

function validateModeSpecificAccount(rawAccount, account) {
  const { name, outputMode, exportExcelPath, targetExcelPath, wpsDailyTotalEnabled } = account;
  if (outputMode === 1) {
    requireSetting(exportExcelPath, name, 'exportExcelPath (ACCOUNT_n_EXPORT_EXCEL_PATH)');
    return;
  }

  if (outputMode === 2) {
    requireSetting(targetExcelPath, name, 'targetExcelPath (ACCOUNT_n_TARGET_EXCEL_PATH)');
    requireSetting(rawAccount.targetExcelSheetName, name, 'targetExcelSheetName');
    requireSetting(rawAccount.targetExcelDateColumn, name, 'targetExcelDateColumn');
    requireSetting(rawAccount.targetExcelNameColumn, name, 'targetExcelNameColumn');
    requireSetting(rawAccount.targetExcelSalesColumn, name, 'targetExcelSalesColumn');
    requirePositiveInteger(rawAccount.targetExcelStartRow, name, 'targetExcelStartRow');
    return;
  }

  requireSetting(rawAccount.wpsDocUrl, name, 'wpsDocUrl (ACCOUNT_n_WPS_DOC_URL)');
  requireSetting(rawAccount.wpsSheetName, name, 'wpsSheetName');
  requireSetting(rawAccount.wpsDateColumn, name, 'wpsDateColumn');
  requireSetting(rawAccount.wpsNameColumn, name, 'wpsNameColumn');
  requireSetting(rawAccount.wpsSalesColumn, name, 'wpsSalesColumn');
  requirePositiveInteger(rawAccount.wpsStartRow, name, 'wpsStartRow');
  if (wpsDailyTotalEnabled) {
    requireSetting(rawAccount.wpsTotalDocUrl, name, 'wpsTotalDocUrl (ACCOUNT_n_WPS_TOTAL_DOC_URL)');
    requireSetting(rawAccount.wpsTotalSheetName, name, 'wpsTotalSheetName');
    requireSetting(rawAccount.wpsTotalDateColumn, name, 'wpsTotalDateColumn');
    requireSetting(rawAccount.wpsTotalSalesColumn, name, 'wpsTotalSalesColumn');
    requirePositiveInteger(rawAccount.wpsTotalStartRow, name, 'wpsTotalStartRow');
    if (String(rawAccount.wpsTotalDateColumn).trim().toUpperCase() ===
        String(rawAccount.wpsTotalSalesColumn).trim().toUpperCase()) {
      throw new Error(`Account "${name}" must use different WPS total date and sales columns.`);
    }
  }
}

function booleanFlag(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw new Error(`Invalid boolean flag: ${value}`);
}

function requireSetting(value, accountName, settingName) {
  if (!String(value || '').trim()) {
    throw new Error(`Account "${accountName}" is missing ${settingName} for the selected OUTPUT_MODE.`);
  }
}

function requirePositiveInteger(value, accountName, settingName) {
  requireSetting(value, accountName, settingName);
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number) || number < 1) {
    throw new Error(`Account "${accountName}" has invalid ${settingName}: ${value}`);
  }
}

function assertUnique(accounts, key, label) {
  const seen = new Map();
  for (const account of accounts) {
    const value = account[key];
    if (!seen.has(value)) {
      seen.set(value, account.name);
      continue;
    }

    throw new Error(
      `${label} "${value}" is used by both "${seen.get(value)}" and "${account.name}". Use a separate ${label} for each account.`,
    );
  }
}

function assertUniqueNonEmpty(accounts, key, label) {
  assertUnique(accounts.filter((account) => account[key]), key, label);
}

function resolveConfigPath(value, configDir) {
  if (!value) {
    return '';
  }

  const text = String(value);
  return isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text) ? text : resolve(configDir, text);
}

function stringifyEnv(values) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => [key, String(value)]),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
