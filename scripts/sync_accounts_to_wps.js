import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { loadEnvFile } from './config.js';
import { syncOneAccount } from './sync_collect_to_wps.js';

const DEFAULT_ACCOUNTS_PATH = 'accounts.json';

async function main() {
  const fileEnv = await loadEnvFile('.env').catch(() => ({}));
  const baseEnv = { ...process.env, ...fileEnv };
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
      `No account config found. Create accounts.json, pass a config path, or add ACCOUNT_1_SOURCE_EXCEL / ACCOUNT_1_GROUP_TITLE / ACCOUNT_1_CHROME_PROFILE to .env.`,
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

  console.log('\nAll account sync tasks finished.');
}

function loadAccountsConfig(accountsPath) {
  try {
    return JSON.parse(readFileSync(accountsPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read accounts config at ${accountsPath}: ${error.message}`);
  }
}

function readAccountsFromEnv(env) {
  const indexes = readAccountIndexes(env);
  return indexes.map((index) => ({
    name: env[`ACCOUNT_${index}_NAME`],
    cdpPort: env[`ACCOUNT_${index}_CDP_PORT`] || env[`ACCOUNT_${index}_PORT`],
    cdpOrigin: env[`ACCOUNT_${index}_CDP_ORIGIN`],
    chromeProfile: env[`ACCOUNT_${index}_CHROME_PROFILE`] || env[`ACCOUNT_${index}_CDP_USER_DATA_DIR`],
    sourceExcel: env[`ACCOUNT_${index}_SOURCE_EXCEL`] || env[`ACCOUNT_${index}_SOURCE_EXCEL_PATH`],
    sourceExcelSpuColumn:
      env[`ACCOUNT_${index}_SOURCE_EXCEL_SPU_COLUMN`] || env[`ACCOUNT_${index}_SOURCE_SPU_COLUMN`],
    groupTitle:
      env[`ACCOUNT_${index}_GROUP_TITLE`] ||
      env[`ACCOUNT_${index}_WPS_GROUP_TITLE`] ||
      env[`ACCOUNT_${index}_WPS_STORE_GROUP_TITLE`],
    wpsDocUrl: env[`ACCOUNT_${index}_WPS_DOC_URL`],
    wpsSheetName: env[`ACCOUNT_${index}_WPS_SHEET_NAME`],
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
    closeChromeAfterRun: env[`ACCOUNT_${index}_CLOSE_CHROME_AFTER_RUN`],
    chromePath: env[`ACCOUNT_${index}_CHROME_PATH`],
    trafficTargetDate: env[`ACCOUNT_${index}_TRAFFIC_TARGET_DATE`],
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

function normalizeAccount(rawAccount, configDir, index, baseEnv = process.env) {
  if (!rawAccount || typeof rawAccount !== 'object') {
    throw new Error(`Account at index ${index} must be an object.`);
  }

  const name = rawAccount.name || rawAccount.groupTitle || `Account ${index + 1}`;
  const cdpPort = String(rawAccount.cdpPort || rawAccount.port || 9222 + index);
  const cdpOrigin = rawAccount.cdpOrigin || `http://127.0.0.1:${cdpPort}`;
  const sourceExcel = resolveConfigPath(rawAccount.sourceExcel || rawAccount.sourceExcelPath, configDir);
  const chromeProfile = resolveConfigPath(rawAccount.chromeProfile || rawAccount.cdpUserDataDir, configDir);
  const groupTitle = rawAccount.groupTitle || rawAccount.wpsGroupTitle || rawAccount.storeGroupTitle;
  const sourceExcelSpuColumn = rawAccount.sourceExcelSpuColumn || rawAccount.sourceSpuColumn;

  if (!sourceExcel) {
    throw new Error(`Account "${name}" is missing sourceExcel.`);
  }
  if (!chromeProfile) {
    throw new Error(`Account "${name}" is missing chromeProfile.`);
  }
  if (!groupTitle) {
    throw new Error(`Account "${name}" is missing groupTitle.`);
  }

  const accountEnv = stringifyEnv({
    CDP_PORT: cdpPort,
    CDP_ORIGIN: cdpOrigin,
    CDP_USER_DATA_DIR: chromeProfile,
    SOURCE_EXCEL_PATH: sourceExcel,
    SOURCE_EXCEL_SPU_COLUMN: sourceExcelSpuColumn,
    WPS_STORE_GROUP_TITLE: groupTitle,
    WPS_GROUP_TITLE: groupTitle,
    WPS_DOC_URL: rawAccount.wpsDocUrl,
    WPS_SHEET_NAME: rawAccount.wpsSheetName,
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
    CLOSE_CHROME_AFTER_RUN: rawAccount.closeChromeAfterRun,
    CHROME_PATH: rawAccount.chromePath,
    TRAFFIC_TARGET_DATE: rawAccount.trafficTargetDate,
    TRAFFIC_TARGET_DATES: rawAccount.trafficTargetDates,
    TRAFFIC_DATE_RANGE: rawAccount.trafficDateRange,
    PYTHON_BIN: rawAccount.pythonBin,
    ...(rawAccount.env || {}),
  });
  const env = stringifyEnv({
    ...baseEnv,
    ...accountEnv,
  });

  return {
    name,
    sourceExcel,
    cdpPort,
    chromeProfile,
    env,
  };
}

function validateUniqueAccountSettings(accounts) {
  assertUnique(accounts, 'cdpPort', 'CDP port');
  assertUnique(accounts, 'chromeProfile', 'Chrome profile');
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

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
