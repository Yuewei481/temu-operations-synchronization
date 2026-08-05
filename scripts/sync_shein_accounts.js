import { spawn } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeCdpBrowser, getCdpOrigin, listCdpPages } from './cdp_client.js';
import { loadEnvFile } from './config.js';
import { readSheinAccountsFromEnv } from './shein_account_config.js';

const SHEIN_HOSTS = new Set(['sso.geiwohuo.com', 'www.geiwohuo.com']);
const SHEIN_TAB_STARTUP_WAIT_MS = 30 * 1000;

export async function syncSheinAccounts(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('No SHEIN accounts were configured.');
  }

  console.log(`Loaded ${accounts.length} SHEIN account task(s).`);
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    console.log(`\n========== SHEIN ${index + 1}/${accounts.length}: ${account.name} ==========`);
    await syncOneSheinAccount(account);
  }
  console.log('\nAll SHEIN account tasks finished.');
}

export async function syncOneSheinAccount(account) {
  const env = { ...process.env, ...account.env };
  const outputMode = account.outputMode;
  const pythonBin = env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  let succeeded = false;

  console.log(`SHEIN output mode: ${outputMode}`);
  console.log(`SHEIN CDP origin: ${getCdpOrigin(env)}`);
  console.log(`SHEIN source Excel: ${account.sourceExcel}`);

  try {
    await ensureChromeCdpAndSheinTab(env);
    await rm(account.salesDataPath, { force: true });
    await rm(account.wpsPayloadPath, { force: true });
    if (account.wpsDailyTotalEnabled) {
      await rm(account.dailyTotalsPayloadPath, { force: true });
    }
    if (outputMode === 1) {
      await rm(account.exportExcelPath, { force: true });
    }

    const collectionStartedAt = Date.now();
    await runStep('Collect SHEIN sales data', process.execPath, ['scripts/collect_shein_sales_cdp.js'], env);
    await assertFreshFile(account.salesDataPath, collectionStartedAt, 'SHEIN sales data');

    if (outputMode === 1) {
      await runStep('Export SHEIN sales Excel', pythonBin, ['scripts/export_sku_sales_excel.py'], env);
      succeeded = true;
      console.log('SHEIN collection and standalone Excel export finished.');
      return;
    }

    await runStep(
      'Build SHEIN date/name/sales payload',
      pythonBin,
      ['scripts/build_wps_append_payload.py', account.sourceExcel],
      env,
    );
    await assertFreshFile(account.wpsPayloadPath, collectionStartedAt, 'SHEIN update payload');

    if (outputMode === 2) {
      await runStep('Update SHEIN local target Excel', pythonBin, ['scripts/update_local_excel.py'], env);
      succeeded = true;
      console.log('SHEIN collection and local Excel update finished.');
      return;
    }

    await runStep(
      'Update SHEIN WPS target Excel',
      process.execPath,
      ['scripts/update_wps_existing_rows_cdp.js'],
      env,
    );
    if (account.wpsDailyTotalEnabled) {
      const totalsStartedAt = Date.now();
      await runStep(
        'Build SHEIN daily totals from matched products',
        pythonBin,
        ['scripts/build_daily_sales_totals.py'],
        env,
      );
      await assertFreshFile(
        account.dailyTotalsPayloadPath,
        totalsStartedAt,
        'SHEIN daily sales total payload',
      );
      await runStep(
        'Update SHEIN WPS daily sales totals',
        process.execPath,
        ['scripts/update_wps_daily_totals_cdp.js'],
        env,
      );
    }
    succeeded = true;
    console.log('SHEIN collection and WPS update finished.');
  } finally {
    if (succeeded && truthy(env.CLOSE_CHROME_AFTER_RUN)) {
      await closeChrome(env);
    } else if (!succeeded && truthy(env.CLOSE_CHROME_AFTER_RUN)) {
      console.log('SHEIN Chrome left open because the workflow failed before completion.');
    }
  }
}

async function ensureChromeCdpAndSheinTab(env) {
  const cdpOrigin = getCdpOrigin(env);
  const loginUrl = env.SELLER_LOGIN_URL;
  const startedByScript = !(await isCdpReachable(cdpOrigin));

  if (startedByScript) {
    await runStep('Start Chrome for SHEIN', process.execPath, ['scripts/start_chrome_cdp.js'], env);
    await waitForCdp(cdpOrigin, 30000);
    await waitForSheinTab(cdpOrigin, SHEIN_TAB_STARTUP_WAIT_MS);
  }

  const hasSheinTab = Boolean(await findSheinTab(cdpOrigin));
  if (!hasSheinTab && !startedByScript) {
    console.log('No SHEIN tab found in the configured Chrome. Opening the login page...');
    const response = await fetch(`${cdpOrigin}/json/new?${encodeURIComponent(loginUrl)}`, {
      method: 'PUT',
    });
    if (!response.ok) {
      throw new Error(`Unable to open SHEIN login tab via CDP (${response.status}).`);
    }
    await waitForSheinTab(cdpOrigin, SHEIN_TAB_STARTUP_WAIT_MS);
  } else if (!hasSheinTab) {
    console.log('The original SHEIN login tab is still loading; the collector will continue waiting for it.');
  }

  console.log(
    startedByScript
      ? 'Chrome was opened for SHEIN. Please finish the manual login in that window.'
      : 'The configured SHEIN Chrome session is already running.',
  );
}

async function findSheinTab(cdpOrigin) {
  const pages = await listCdpPages(cdpOrigin);
  return pages.find((page) => page.type === 'page' && isSheinUrl(page.url)) || null;
}

function isSheinUrl(url) {
  try {
    return SHEIN_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function waitForSheinTab(cdpOrigin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await findSheinTab(cdpOrigin);
    if (page) return page;
    await sleep(500);
  }
  return null;
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
    if (await isCdpReachable(cdpOrigin)) return;
    await sleep(500);
  }
  throw new Error(`Chrome CDP endpoint did not become available at ${cdpOrigin}/json`);
}

async function assertFreshFile(path, startedAt, label) {
  let fileStats;
  try {
    fileStats = await stat(path);
  } catch {
    throw new Error(`${label} was not created at ${path}.`);
  }
  if (fileStats.mtimeMs + 1000 < startedAt) {
    throw new Error(`${label} was not refreshed at ${path}.`);
  }
}

function runStep(label, command, args, env) {
  console.log(`\n==> ${label}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', (error) => reject(new Error(`${label} failed to start: ${error.message}`)));
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${label} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}

async function closeChrome(env) {
  const origin = getCdpOrigin(env);
  console.log(`Closing SHEIN Chrome for CDP endpoint: ${origin}`);
  try {
    const closed = await closeCdpBrowser(origin);
    console.log(closed ? 'SHEIN Chrome closed.' : 'SHEIN Chrome close skipped: no browser target found.');
  } catch (error) {
    console.log(`SHEIN Chrome close failed: ${error.message}`);
  }
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function main() {
  const fileEnv = await loadEnvFile('.env').catch(() => ({}));
  const env = { ...fileEnv, ...process.env };
  const accounts = readSheinAccountsFromEnv(env, process.cwd());
  await syncSheinAccounts(accounts);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
