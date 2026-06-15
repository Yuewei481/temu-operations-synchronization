import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { closeCdpBrowser, getCdpOrigin, listCdpPages } from './cdp_client.js';

const DEFAULT_SOURCE_EXCEL_PATH = '/Users/yueweizhou/Desktop/工作簿12.xlsx';
const BUNDLED_PYTHON_PATH = '/Users/yueweizhou/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
const DEFAULT_LOGIN_URL =
  'https://seller.kuajingmaihuo.com/login?redirectUrl=https%3A%2F%2Fseller.kuajingmaihuo.com%2Fsettle%2Fsite-main%3FredirectUrl%3Dhttps%253A%252F%252Fseller.kuajingmaihuo.com%252F';
const SELLER_PAGE_HOSTS = [
  'seller.kuajingmaihuo.com',
  'agentseller.temu.com',
  'agentseller-eu.temu.com',
];

export async function syncOneAccount(options = {}) {
  const env = {
    ...process.env,
    ...removeUndefinedValues(options.env || {}),
  };
  const sourceExcelPath = resolve(options.sourceExcelPath || env.SOURCE_EXCEL_PATH || DEFAULT_SOURCE_EXCEL_PATH);
  const pythonBin = env.PYTHON_BIN || defaultPythonBin();
  let succeeded = false;

  console.log('Sync workflow started.');
  if (env.WPS_STORE_GROUP_TITLE || env.WPS_GROUP_TITLE) {
    console.log(`WPS group title: ${env.WPS_STORE_GROUP_TITLE || env.WPS_GROUP_TITLE}`);
  }
  console.log(`CDP origin: ${getCdpOrigin(env)}`);
  console.log(`Source Excel: ${sourceExcelPath}`);

  try {
    await ensureChromeCdpAndSellerTab(env);
    await runStep('Collect Seller Central data', process.execPath, ['scripts/collect_sales_data_cdp.js'], env);
    await runStep('Build WPS update payload', pythonBin, ['scripts/build_wps_append_payload.py', sourceExcelPath], env);
    await runStep('Update WPS existing rows', process.execPath, ['scripts/update_wps_existing_rows_cdp.js'], env);

    succeeded = true;
    console.log('Sync workflow finished.');
  } finally {
    if (succeeded && truthy(env.CLOSE_CHROME_AFTER_RUN)) {
      await closeChromeAfterRun(env);
    } else if (!succeeded && truthy(env.CLOSE_CHROME_AFTER_RUN)) {
      console.log('Chrome left open because the workflow failed before completion.');
    }
  }
}

function defaultPythonBin() {
  if (existsSync(BUNDLED_PYTHON_PATH)) {
    return BUNDLED_PYTHON_PATH;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

async function ensureChromeCdpAndSellerTab(env = process.env) {
  const cdpOrigin = getCdpOrigin(env);
  const loginUrl = env.SELLER_LOGIN_URL || DEFAULT_LOGIN_URL;
  const startedByScript = !(await isCdpReachable(cdpOrigin));

  if (startedByScript) {
    await runStep('Start Chrome with CDP', process.execPath, ['scripts/start_chrome_cdp.js'], env);
    await waitForCdp(cdpOrigin, 30000);
  }

  const pages = await listCdpPages(cdpOrigin);
  const hasSellerTab = pages.some(
    (page) =>
      page.type === 'page' &&
      SELLER_PAGE_HOSTS.some((host) => {
        try {
          return new URL(page.url).host === host;
        } catch {
          return false;
        }
      }),
  );

  if (!hasSellerTab) {
    console.log('No Seller Central tab found in Chrome. Opening login page...');
    const response = await fetch(`${cdpOrigin}/json/new?${encodeURIComponent(loginUrl)}`, { method: 'PUT' });
    if (!response.ok) {
      throw new Error(`Unable to open Seller Central login tab via CDP (${response.status}).`);
    }
  }

  console.log(
    startedByScript
      ? 'Chrome was opened by this workflow. Please finish manual login in that Chrome window.'
      : 'Chrome CDP is already running. Seller Central login/home tab is ready or has been opened.',
  );
}

async function isCdpReachable(cdpOrigin) {
  try {
    const response = await fetch(`${cdpOrigin}/json`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(cdpOrigin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpReachable(cdpOrigin)) {
      return;
    }
    await sleep(500);
  }

  throw new Error(`Chrome CDP endpoint did not become available at ${cdpOrigin}/json`);
}

function runStep(label, command, args, env = process.env) {
  console.log(`\n==> ${label}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
      shell: false,
    });

    child.on('error', (error) => {
      reject(new Error(`${label} failed to start: ${error.message}`));
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      const suffix = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`${label} failed with ${suffix}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function closeChromeAfterRun(env) {
  const cdpOrigin = getCdpOrigin(env);
  console.log(`Closing Chrome for CDP endpoint: ${cdpOrigin}`);
  try {
    const closed = await closeCdpBrowser(cdpOrigin);
    console.log(closed ? 'Chrome closed.' : 'Chrome close skipped: no CDP browser target found.');
  } catch (error) {
    console.log(`Chrome close failed: ${error.message}`);
  }
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function removeUndefinedValues(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function main() {
  const sourceExcelPath = process.argv[2];
  return syncOneAccount({ sourceExcelPath });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
