import { spawn } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { closeCdpBrowser, getCdpOrigin, listCdpPages } from './cdp_client.js';

const DEFAULT_LOGIN_URL =
  'https://seller.kuajingmaihuo.com/login?redirectUrl=https%3A%2F%2Fseller.kuajingmaihuo.com%2Fsettle%2Fsite-main%3FredirectUrl%3Dhttps%253A%252F%252Fseller.kuajingmaihuo.com%252F';
const SELLER_PAGE_HOSTS = [
  'seller.kuajingmaihuo.com',
  'agentseller.temu.com',
  'agentseller-eu.temu.com',
];
const SELLER_TAB_STARTUP_WAIT_MS = 30 * 1000;
const SALES_DATA_PATH = resolve('output/sales-data.json');

export async function syncOneAccount(options = {}) {
  const env = {
    ...process.env,
    ...removeUndefinedValues(options.env || {}),
  };
  const configuredSourceExcel = String(options.sourceExcelPath || env.SOURCE_EXCEL_PATH || '').trim();
  if (!configuredSourceExcel) {
    throw new Error('SOURCE_EXCEL_PATH is required. Configure ACCOUNT_n_SOURCE_EXCEL in .env.');
  }
  const sourceExcelPath = resolve(configuredSourceExcel);
  env.SOURCE_EXCEL_PATH = sourceExcelPath;
  const pythonBin = env.PYTHON_BIN || defaultPythonBin();
  const outputMode = parseOutputMode(env.OUTPUT_MODE);
  validateOutputModeEnv(env, outputMode);
  let succeeded = false;

  console.log('Sync workflow started.');
  console.log(`Output mode: ${outputMode} (${outputModeLabel(outputMode)})`);
  console.log(`CDP origin: ${getCdpOrigin(env)}`);
  console.log(`Source Excel: ${sourceExcelPath}`);

  try {
    await ensureChromeCdpAndSellerTab(env);
    await rm(SALES_DATA_PATH, { force: true });
    if (outputMode === 1) {
      await rm(resolve(env.SKU_SALES_EXCEL_PATH), { force: true });
    }
    const collectionStartedAt = Date.now();
    await runStep('Collect Seller Central data', process.execPath, ['scripts/collect_sales_data_cdp.js'], env);
    await assertFreshSalesData(collectionStartedAt);

    if (outputMode === 1) {
      await runStep('Export SKU sales Excel', pythonBin, ['scripts/export_sku_sales_excel.py'], env);
      succeeded = true;
      console.log('Collection and standalone Excel export finished.');
      return;
    }

    await runStep('Build date/name/sales update payload', pythonBin, ['scripts/build_wps_append_payload.py', sourceExcelPath], env);
    if (outputMode === 2) {
      await runStep('Update local target Excel', pythonBin, ['scripts/update_local_excel.py'], env);
      succeeded = true;
      console.log('Collection and local Excel update finished.');
      return;
    }

    await runStep('Update WPS target Excel', process.execPath, ['scripts/update_wps_existing_rows_cdp.js'], env);

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

function parseOutputMode(value) {
  const mode = Number.parseInt(String(value || '').trim(), 10);
  if (![1, 2, 3].includes(mode)) {
    throw new Error('OUTPUT_MODE must be 1 (export Excel), 2 (update local Excel), or 3 (update WPS Excel).');
  }
  return mode;
}

function outputModeLabel(mode) {
  return {
    1: 'export a new Excel workbook only',
    2: 'update an existing local Excel workbook',
    3: 'update a WPS cloud workbook',
  }[mode];
}

function validateOutputModeEnv(env, mode) {
  if (mode === 1) {
    requireEnv(env, 'SKU_SALES_EXCEL_PATH');
    return;
  }
  if (mode === 2) {
    for (const key of [
      'LOCAL_TARGET_EXCEL_PATH',
      'LOCAL_TARGET_EXCEL_SHEET_NAME',
      'LOCAL_TARGET_DATE_COLUMN',
      'LOCAL_TARGET_NAME_COLUMN',
      'LOCAL_TARGET_SALES_COLUMN',
      'LOCAL_TARGET_START_ROW',
    ]) {
      requireEnv(env, key);
    }
    return;
  }
  for (const key of [
    'WPS_DOC_URL',
    'WPS_SHEET_NAME',
    'WPS_DATE_COLUMN',
    'WPS_NAME_COLUMN',
    'WPS_SALES_COLUMN',
    'WPS_START_ROW',
  ]) {
    requireEnv(env, key);
  }
}

function requireEnv(env, key) {
  if (!String(env[key] || '').trim()) {
    throw new Error(`${key} is required for OUTPUT_MODE=${env.OUTPUT_MODE}.`);
  }
}

async function assertFreshSalesData(collectionStartedAt) {
  let fileStats;
  try {
    fileStats = await stat(SALES_DATA_PATH);
  } catch {
    throw new Error('Sales collection ended without creating output/sales-data.json. Excel export was stopped.');
  }

  if (fileStats.mtimeMs + 1000 < collectionStartedAt) {
    throw new Error('Sales collection did not refresh output/sales-data.json. Excel export was stopped.');
  }
}

function defaultPythonBin() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

async function ensureChromeCdpAndSellerTab(env = process.env) {
  const cdpOrigin = getCdpOrigin(env);
  const loginUrl = env.SELLER_LOGIN_URL || DEFAULT_LOGIN_URL;
  const startedByScript = !(await isCdpReachable(cdpOrigin));

  if (startedByScript) {
    await runStep('Start Chrome with CDP', process.execPath, ['scripts/start_chrome_cdp.js'], env);
    await waitForCdp(cdpOrigin, 30000);
    console.log('Waiting for the login tab opened with Chrome to finish its initial navigation...');
    await waitForSellerTab(cdpOrigin, SELLER_TAB_STARTUP_WAIT_MS);
  }

  const hasSellerTab = Boolean(await findSellerTab(cdpOrigin));

  // start_chrome_cdp.js already supplied the login URL. Never create a second
  // login tab merely because the first tab is still loading on a slow machine.
  if (!hasSellerTab && !startedByScript) {
    console.log('No Seller Central tab found in Chrome. Opening login page...');
    const response = await fetch(`${cdpOrigin}/json/new?${encodeURIComponent(loginUrl)}`, { method: 'PUT' });
    if (!response.ok) {
      throw new Error(`Unable to open Seller Central login tab via CDP (${response.status}).`);
    }
    await waitForSellerTab(cdpOrigin, SELLER_TAB_STARTUP_WAIT_MS);
  } else if (!hasSellerTab) {
    console.log('The original Chrome login tab is still loading; the collector will keep waiting on that tab.');
  }

  console.log(
    startedByScript
      ? 'Chrome was opened by this workflow. Please finish manual login in that Chrome window.'
      : 'Chrome CDP is already running. Seller Central login/home tab is ready or has been opened.',
  );
}

async function waitForSellerTab(cdpOrigin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sellerTab = await findSellerTab(cdpOrigin);
    if (sellerTab) {
      return sellerTab;
    }
    await sleep(500);
  }
  return null;
}

async function findSellerTab(cdpOrigin) {
  const pages = await listCdpPages(cdpOrigin);
  return pages.find((page) => page.type === 'page' && isSellerPageUrl(page.url)) || null;
}

function isSellerPageUrl(url) {
  try {
    return SELLER_PAGE_HOSTS.includes(new URL(url).host);
  } catch {
    return false;
  }
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
