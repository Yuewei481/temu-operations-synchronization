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

function stripOptionalQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
