import { readFile } from 'node:fs/promises';

export const DEFAULT_LOGIN_URL =
  'https://seller.kuajingmaihuo.com/login?redirectUrl=https%3A%2F%2Fseller.kuajingmaihuo.com%2Fsettle%2Fsite-main%3FredirectUrl%3Dhttps%253A%252F%252Fseller.kuajingmaihuo.com%252F';

export function parseEnvText(text) {
  const env = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    env[key] = stripOptionalQuotes(value);
  }

  return env;
}

export async function loadEnvFile(path = '.env') {
  const text = await readFile(path, 'utf8');
  return parseEnvText(text);
}

export function readSellerConfig(env) {
  const requiredKeys = ['SELLER_PHONE_COUNTRY_CODE', 'SELLER_PHONE', 'SELLER_PASSWORD'];
  const missingKeys = requiredKeys.filter((key) => !env[key]);

  if (missingKeys.length > 0) {
    throw new Error(`Missing required env values: ${missingKeys.join(', ')}`);
  }

  return {
    countryCode: normalizeCountryCode(env.SELLER_PHONE_COUNTRY_CODE),
    phone: env.SELLER_PHONE.trim(),
    password: env.SELLER_PASSWORD,
    loginUrl: env.SELLER_LOGIN_URL || DEFAULT_LOGIN_URL,
    storageStatePath: env.SELLER_STORAGE_STATE_PATH || 'output/playwright/seller-storage-state.json',
    screenshotPath: env.SELLER_FAILURE_SCREENSHOT_PATH || 'output/playwright/login-failure.png',
    headless: env.HEADLESS === '1' || env.HEADLESS === 'true',
  };
}

function normalizeCountryCode(countryCode) {
  return countryCode.trim().replace(/^\+/, '');
}

function stripOptionalQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
