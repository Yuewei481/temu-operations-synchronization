import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, activateCdpPage, getCdpOrigin, listCdpPages } from './cdp_client.js';
import {
  WPS_SIGN_IN_LABELS,
  isMatchingWpsDocumentPage,
  isRecoverableWpsNavigationError,
  isWpsLoginPage,
} from './wps_auth_state.js';

const DEFAULT_PAYLOAD_PATH = 'output/wps-daily-sales-totals.json';
const DEFAULT_INITIAL_WAIT_MS = 0;
const DEFAULT_LOGIN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SCAN_MAX_ROW = 5000;
const POLL_INTERVAL_MS = 1000;

export async function updateWpsDailyTotals(env = process.env) {
  const retryDeadline = Date.now() + positiveInteger(
    env.WPS_LOGIN_TIMEOUT_MS,
    DEFAULT_LOGIN_TIMEOUT_MS,
    'WPS_LOGIN_TIMEOUT_MS',
  );
  while (Date.now() < retryDeadline) {
    try {
      return await updateWpsDailyTotalsAttempt({
        ...env,
        WPS_LOGIN_TIMEOUT_MS: String(remainingTime(retryDeadline)),
      });
    } catch (error) {
      if (!isRecoverableWpsNavigationError(error) || remainingTime(retryDeadline) <= 0) throw error;
      console.log('WPS login/navigation replaced the page. Reconnecting and continuing to wait...');
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new Error('Timed out waiting for a stable signed-in WPS document.');
}

async function updateWpsDailyTotalsAttempt(env) {
  const cdpOrigin = getCdpOrigin(env);
  const docUrl = String(env.WPS_TOTAL_DOC_URL || '').trim();
  const sheetName = String(env.WPS_TOTAL_SHEET_NAME || '').trim();
  if (!docUrl) throw new Error('WPS_TOTAL_DOC_URL is required.');
  if (!sheetName) throw new Error('WPS_TOTAL_SHEET_NAME is required.');

  const layout = buildDailyTotalLayout(env);
  const payloadPath = resolve(env.WPS_DAILY_TOTAL_PAYLOAD || DEFAULT_PAYLOAD_PATH);
  const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
  const rows = normalizeDailyTotalPayloadRows(payload.rows || []);
  if (!rows.length) throw new Error(`No daily total rows to update in ${payloadPath}`);

  console.log(`Daily totals to match/update: ${rows.length}`);
  console.log(`Daily total target: ${docUrl} / ${sheetName}`);
  const loginDeadline = Date.now() + positiveInteger(
    env.WPS_LOGIN_TIMEOUT_MS,
    DEFAULT_LOGIN_TIMEOUT_MS,
    'WPS_LOGIN_TIMEOUT_MS',
  );
  await findOrOpenWpsPage(cdpOrigin, docUrl);
  const pageInfo = await waitForStableWpsPage(cdpOrigin, docUrl, loginDeadline);
  await activateCdpPage(pageInfo, cdpOrigin);

  const page = new CdpPage(pageInfo);
  try {
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    console.log(`WPS daily-total tab detected: ${pageInfo.url}`);

    const initialWaitMs = nonNegativeInteger(
      env.WPS_INITIAL_WAIT_MS,
      DEFAULT_INITIAL_WAIT_MS,
      'WPS_INITIAL_WAIT_MS',
    );
    if (initialWaitMs > 0) {
      console.log(`Waiting ${Math.round(initialWaitMs / 1000)} seconds for WPS login/document loading...`);
      await sleep(Math.min(initialWaitMs, remainingTime(loginDeadline)));
    }
    await waitForWpsReady(page, sheetName, remainingTime(loginDeadline));
    await activateWpsWorksheet(page, sheetName);
    await verifyTargetSheet(page, sheetName, layout);

    const dryRun = truthy(env.WPS_TOTAL_UPDATE_DRY_RUN);
    const cleanupAfterVerify = truthy(env.WPS_TOTAL_TEST_CLEANUP_AFTER_VERIFY);
    const result = await writeDailyTotals(page, rows, {
      dryRun,
      cleanupAfterVerify,
      layout,
      scanMaxRow: positiveInteger(
        env.WPS_TOTAL_UPDATE_SCAN_MAX_ROW,
        DEFAULT_SCAN_MAX_ROW,
        'WPS_TOTAL_UPDATE_SCAN_MAX_ROW',
      ),
      emptyRowStop: positiveInteger(
        env.WPS_TOTAL_EMPTY_ROW_STOP,
        50,
        'WPS_TOTAL_EMPTY_ROW_STOP',
      ),
    });
    printResult(result, dryRun);
    if (result.failedWrites.length) {
      await sleep(POLL_INTERVAL_MS);
      const currentPages = await listCdpPages(cdpOrigin);
      const loginPage = currentPages.find(isWpsLoginPage);
      if (loginPage) {
        throw new Error('WPS login required after attempted write. Reconnect after authentication.');
      }
      throw new Error(`${result.failedWrites.length} WPS daily-total cell write(s) failed verification.`);
    }
    if (result.failedCleanup.length) {
      throw new Error(`${result.failedCleanup.length} WPS daily-total test cell(s) failed cleanup verification.`);
    }
    return result;
  } finally {
    await page.close();
  }
}

export function buildDailyTotalLayout(env = process.env) {
  const dateColumn = excelColumnToIndex(env.WPS_TOTAL_DATE_COLUMN, 'WPS_TOTAL_DATE_COLUMN');
  const salesColumn = excelColumnToIndex(env.WPS_TOTAL_SALES_COLUMN, 'WPS_TOTAL_SALES_COLUMN');
  if (dateColumn === salesColumn) {
    throw new Error('WPS total date and sales columns must be different.');
  }
  const startRow = positiveInteger(env.WPS_TOTAL_START_ROW, null, 'WPS_TOTAL_START_ROW');
  return { dateColumn, salesColumn, startRow };
}

export function normalizeDailyTotalPayloadRows(rows) {
  const result = [];
  const seenDates = new Set();
  for (const row of rows || []) {
    const normalizedDate = normalizeDate(row?.date);
    if (!normalizedDate) throw new Error(`Invalid WPS daily-total date: ${row?.date}`);
    if (seenDates.has(normalizedDate)) {
      throw new Error(`Duplicate WPS daily-total date in payload: ${normalizedDate}`);
    }
    seenDates.add(normalizedDate);
    result.push({
      date: displayDate(normalizedDate),
      sales: cellNumber(row?.sales),
    });
  }
  return result.sort((left, right) => dateTime(left.date) - dateTime(right.date));
}

async function findOrOpenWpsPage(cdpOrigin, docUrl) {
  const pages = await listCdpPages(cdpOrigin);
  const existing = pages.find((page) => isMatchingWpsDocumentPage(page, docUrl));
  if (existing) return existing;
  const loginPage = pages.find(isWpsLoginPage);
  if (loginPage) return loginPage;

  const response = await fetch(`${cdpOrigin}/json/new?${encodeURIComponent(docUrl)}`, { method: 'PUT' });
  if (!response.ok) throw new Error(`Unable to open WPS daily-total document (${response.status}).`);
  return response.json();
}

async function waitForStableWpsPage(cdpOrigin, docUrl, deadline, stableMs = 5000) {
  let stableTargetId = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    const pages = await listCdpPages(cdpOrigin);
    const page = pages.find((candidate) => isMatchingWpsDocumentPage(candidate, docUrl));
    if (!page) {
      stableTargetId = '';
      stableSince = 0;
      console.log('Waiting for WPS login to return to the target document...');
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (page.id !== stableTargetId) {
      stableTargetId = page.id;
      stableSince = Date.now();
    }
    if (Date.now() - stableSince >= stableMs) {
      console.log('WPS target document remained stable after login.');
      return page;
    }
    console.log('Confirming that the WPS target document is stable...');
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('Timed out waiting for WPS login to return to the target document.');
}

function isMatchingWpsPage(page, docUrl) {
  const docId = docUrl.match(/\/l\/([^/?#]+)/)?.[1] || '';
  if (page.type !== 'page') return false;
  try {
    const candidate = new URL(page.url);
    const target = new URL(docUrl);
    return candidate.hostname === target.hostname &&
      (docId ? candidate.pathname.includes(`/l/${docId}`) : candidate.href === target.href);
  } catch {
    return false;
  }
}

async function waitForWpsReady(page, sheetName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await page.evaluate(browserFunction(async (targetSheetName, signInLabels) => {
      const visible = (element) => {
        const rect = element?.getBoundingClientRect();
        const style = element ? getComputedStyle(element) : null;
        return Boolean(rect && rect.width > 0 && rect.height > 0 &&
          style?.display !== 'none' && style?.visibility !== 'hidden');
      };
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const controls = [...document.querySelectorAll('button, a, [role="button"]')]
        .filter(visible)
        .map((element) => normalize(element.innerText || element.textContent || element.ariaLabel));
      const signInPrompt = controls.some((text) => signInLabels.some((label) =>
        text === label || text.startsWith(`${label} `) || text.endsWith(` ${label}`)
      ));
      const app = window.WPSOpenApi?.Application;
      if (!app) return { openApi: false, sheetReady: false, signedIn: !signInPrompt };
      await window.WPSOpenApi.documentReadyPromise?.catch?.(() => {});
      try {
        const sheet = app.Worksheets(targetSheetName);
        const actualName = String(await Promise.resolve(sheet?.Name).catch(() => '') || '');
        return { openApi: true, sheetReady: actualName === targetSheetName, signedIn: !signInPrompt };
      } catch {
        return { openApi: true, sheetReady: false, signedIn: !signInPrompt };
      }
    }, sheetName, WPS_SIGN_IN_LABELS));
    if (status.sheetReady && status.openApi && status.signedIn) {
      console.log('WPS daily-total document is ready.');
      return;
    }
    console.log(
      `Waiting for WPS daily-total document ` +
      `(sheet=${status.sheetReady ? 'ready' : 'waiting'}, API=${status.openApi ? 'ready' : 'waiting'}, ` +
      `login=${status.signedIn ? 'ready' : 'waiting'})...`,
    );
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for a signed-in WPS daily-total sheet: ${sheetName}`);
}

async function waitForWpsReadyLegacy(page, sheetName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await page.evaluate(browserFunction(async (targetSheetName) => {
      const app = window.WPSOpenApi?.Application;
      const bodyText = document.body?.innerText || '';
      const signInPrompt = bodyText.includes('Sign In Now') ||
        bodyText.split(/\s+/).some((text) => text === '\u767b\u5f55') ||
        bodyText.split(/\s+/).some((text) => text === '登录');
      if (!app) return { openApi: false, sheetReady: false, signedIn: !signInPrompt };
      await window.WPSOpenApi.documentReadyPromise?.catch?.(() => {});
      try {
        const sheet = app.Worksheets(targetSheetName);
        const actualName = String(await Promise.resolve(sheet?.Name).catch(() => '') || '');
        return { openApi: true, sheetReady: actualName === targetSheetName, signedIn: !signInPrompt };
      } catch {
        return { openApi: true, sheetReady: false, signedIn: !signInPrompt };
      }
    }, sheetName));
    if (status.sheetReady && status.openApi && status.signedIn) {
      console.log('WPS daily-total document is ready.');
      return;
    }
    console.log(
      `Waiting for WPS daily-total document ` +
      `(sheet=${status.sheetReady ? 'ready' : 'waiting'}, API=${status.openApi ? 'ready' : 'waiting'}, ` +
      `login=${status.signedIn ? 'ready' : 'waiting'})...`,
    );
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for WPS daily-total sheet: ${sheetName}`);
}

async function activateWpsWorksheet(page, sheetName) {
  const result = await page.evaluate(browserFunction(async (targetSheetName) => {
    if (!window.WPSOpenApi?.Application) {
      throw new Error('WPSOpenApi.Application is not available in this WPS page.');
    }
    await window.WPSOpenApi.documentReadyPromise?.catch?.(() => {});
    const app = window.WPSOpenApi.Application;
    const before = String(await Promise.resolve(app.ActiveSheet?.Name).catch(() => '') || '');
    const sheet = app.Worksheets(targetSheetName);
    await Promise.resolve(sheet.Activate());
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    const after = String(await Promise.resolve(app.ActiveSheet?.Name).catch(() => '') || '');
    return { before, after };
  }, sheetName));
  if (result.after !== sheetName) {
    throw new Error(`Activated wrong WPS sheet. Expected ${sheetName}, got ${result.after || '(empty)'}.`);
  }
  console.log(`Active daily-total sheet: ${result.after}`);
}

async function verifyTargetSheet(page, sheetName, layout) {
  const result = await page.evaluate(browserFunction(async (targetSheetName) => {
    const app = window.WPSOpenApi.Application;
    return String(await Promise.resolve(app.ActiveSheet?.Name).catch(() => '') || '');
  }, sheetName));
  if (result !== sheetName) {
    throw new Error(`Daily-total target sheet verification failed: ${result || '(empty)'}.`);
  }
  console.log(
    `Verified daily-total layout: date=${columnName(layout.dateColumn)}, ` +
    `sales=${columnName(layout.salesColumn)}, start row=${layout.startRow}`,
  );
}

async function writeDailyTotals(
  page,
  rows,
  { dryRun, cleanupAfterVerify, layout, scanMaxRow, emptyRowStop },
) {
  const scanState = await scanDailyTotalRows(page, { layout, scanMaxRow, emptyRowStop });
  console.log(`Daily-total scan completed through row ${scanState.lastUsedRow}.`);
  const result = await page.evaluate(browserFunction(async (
    payloadRows,
    shouldDryRun,
    shouldCleanupAfterVerify,
    sheetLayout,
    scannedState,
  ) => {
    if (!window.WPSOpenApi?.Application) {
      throw new Error('WPSOpenApi.Application is not available in this WPS page.');
    }
    await window.WPSOpenApi.documentReadyPromise?.catch?.(() => {});
    const app = window.WPSOpenApi.Application;
    const dateColumn = columnNameInBrowser(sheetLayout.dateColumn);
    const salesColumn = columnNameInBrowser(sheetLayout.salesColumn);
    const index = new Map();
    const salesByDate = new Map();
    const duplicateDates = scannedState.duplicateDates;
    const lastUsedRow = scannedState.lastUsedRow;
    for (const scannedRow of scannedState.rows) {
      index.set(scannedRow.date, scannedRow.row);
      salesByDate.set(scannedRow.date, scannedRow.sales);
    }

    const updated = [];
    const appended = [];
    const failedWrites = [];
    const cleaned = [];
    const failedCleanup = [];
    let nextRow = Math.max(sheetLayout.startRow, lastUsedRow + 1);
    for (const payloadRow of payloadRows) {
      const dateText = normalizeDateInBrowser(payloadRow.date);
      const existingRow = index.get(dateText);
      if (shouldCleanupAfterVerify && existingRow) {
        const existingSales = normalizeCellValue(salesByDate.get(dateText));
        const expectedSales = normalizeCellValue(payloadRow.sales);
        if (existingSales !== expectedSales) {
          throw new Error(
            `Refusing to alter existing test date ${payloadRow.date} at row ${existingRow}: ` +
            `expected test sales ${expectedSales}, found ${existingSales || '(empty)'}.`,
          );
        }
        const cleanupWrites = [
          { address: `${dateColumn}${existingRow}` },
          { address: `${salesColumn}${existingRow}` },
        ];
        for (const write of cleanupWrites) await clearCellValue(app, write.address);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        for (const write of cleanupWrites) {
          const actual = String(await cellText(app, write.address) || '').trim();
          if (actual) failedCleanup.push({ address: write.address, actual });
        }
        const recoveredRow = {
          row: existingRow,
          date: payloadRow.date,
          sales: String(payloadRow.sales),
        };
        if (!failedCleanup.some((failure) =>
          cleanupWrites.some((write) => write.address === failure.address))) {
          cleaned.push(recoveredRow);
        }
        continue;
      }
      const targetRow = existingRow || nextRow++;
      const rowWasAppended = !existingRow;
      const writes = rowWasAppended
        ? [
          { address: `${dateColumn}${targetRow}`, value: payloadRow.date, field: 'date' },
          { address: `${salesColumn}${targetRow}`, value: payloadRow.sales, field: 'sales' },
        ]
        : [{ address: `${salesColumn}${targetRow}`, value: payloadRow.sales, field: 'sales' }];

      if (!shouldDryRun) {
        for (const write of writes) await writeCellValue(app, write.address, write.value);
      }

      const resultRow = { row: targetRow, date: payloadRow.date, sales: String(payloadRow.sales) };
      if (rowWasAppended) {
        appended.push(resultRow);
        index.set(dateText, targetRow);
      } else {
        updated.push(resultRow);
      }

    }
    return { updated, appended, cleaned, duplicateDates, failedWrites, failedCleanup };

    async function writeCellValue(wpsApp, address, value) {
      const range = wpsApp.Range(address);
      range.Value2 = value;
    }

    async function clearCellValue(wpsApp, address) {
      const range = wpsApp.Range(address);
      await Promise.resolve(range.ClearContents?.()).catch(() => {});
      range.Value = '';
      await Promise.resolve(range.Value2 = '').catch(() => {});
      await Promise.resolve(range.Formula = '').catch(() => {});
    }

    async function cellText(wpsApp, address, useMergeTopLeft = false) {
      const range = wpsApp.Range(address);
      const directText = String(await Promise.resolve(range.Text).catch(() => '') || '').trim();
      if (directText || !useMergeTopLeft) return directText;
      const mergeArea = await Promise.resolve(range.MergeArea).catch(() => null);
      if (!mergeArea) return directText;
      return String(await Promise.resolve(mergeArea.Cells(1, 1).Text).catch(() => '') || '').trim();
    }

    function normalizeDateInBrowser(value) {
      const numeric = Number(value);
      if (value !== null && value !== '' && Number.isFinite(numeric) && numeric > 0) {
        const excelEpoch = Date.UTC(1899, 11, 30);
        const parsed = new Date(excelEpoch + Math.floor(numeric) * 86400000);
        return `${parsed.getUTCFullYear()}/${parsed.getUTCMonth() + 1}/${parsed.getUTCDate()}`;
      }
      const text = String(value ?? '').trim();
      if (!text) return '';
      const normalized = text.replace(/[年 月.\-]/g, '/').replace(/日/g, '').replace(/\/+/g, '/');
      const match = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
      return match ? `${Number(match[1])}/${Number(match[2])}/${Number(match[3])}` : normalized;
    }

    function normalizeCellValue(value) {
      const text = String(value ?? '').trim().replace(/,/g, '');
      return /^-?\d+(\.\d+)?$/.test(text) ? String(Number(text)) : text;
    }

    function columnNameInBrowser(column) {
      let name = '';
      let value = column;
      while (value > 0) {
        const remainder = (value - 1) % 26;
        name = String.fromCharCode(65 + remainder) + name;
        value = Math.floor((value - 1) / 26);
      }
      return name;
    }
  }, rows, dryRun, cleanupAfterVerify, layout, scanState));
  if (!dryRun && (result.updated.length || result.appended.length)) {
    await sleep(100);
    const verification = await verifyWrittenRows(
      page,
      [...result.updated, ...result.appended],
      layout,
    );
    result.failedWrites.push(...verification.failedWrites);
  }
  if (cleanupAfterVerify && !dryRun && result.appended.length && !result.failedWrites.length) {
    const cleanup = await cleanupTemporaryRows(page, result.appended, layout);
    result.cleaned.push(...cleanup.cleaned);
    result.failedCleanup.push(...cleanup.failedCleanup);
  }
  return result;
}

async function verifyWrittenRows(page, rows, layout) {
  return page.evaluate(browserFunction(async (writtenRows, sheetLayout) => {
    const app = window.WPSOpenApi?.Application;
    if (!app) throw new Error('WPSOpenApi.Application is not available in this WPS page.');
    const dateColumn = columnNameInBrowser(sheetLayout.dateColumn);
    const salesColumn = columnNameInBrowser(sheetLayout.salesColumn);
    const failedWrites = [];
    for (const row of writtenRows) {
      const dateAddress = `${dateColumn}${row.row}`;
      const salesAddress = `${salesColumn}${row.row}`;
      const actualDate = normalizeDateInBrowser(await cellText(app, dateAddress));
      const actualSales = normalizeCellValue(await cellText(app, salesAddress));
      const expectedDate = normalizeDateInBrowser(row.date);
      const expectedSales = normalizeCellValue(row.sales);
      if (actualDate !== expectedDate) {
        failedWrites.push({
          row: row.row,
          address: dateAddress,
          field: 'date',
          date: row.date,
          expected: expectedDate,
          actual: actualDate,
        });
      }
      if (actualSales !== expectedSales) {
        failedWrites.push({
          row: row.row,
          address: salesAddress,
          field: 'sales',
          date: row.date,
          expected: expectedSales,
          actual: actualSales,
        });
      }
    }
    return { failedWrites };

    async function cellText(wpsApp, address) {
      return String(await Promise.resolve(wpsApp.Range(address).Text).catch(() => '') || '').trim();
    }

    function normalizeDateInBrowser(value) {
      const text = String(value ?? '').trim();
      const normalized = text.replace(/[年 月.\-]/g, '/').replace(/日/g, '').replace(/\/+/g, '/');
      const match = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
      return match ? `${Number(match[1])}/${Number(match[2])}/${Number(match[3])}` : '';
    }

    function normalizeCellValue(value) {
      const text = String(value ?? '').trim().replace(/,/g, '');
      return /^-?\d+(\.\d+)?$/.test(text) ? String(Number(text)) : text;
    }

    function columnNameInBrowser(column) {
      let name = '';
      let value = column;
      while (value > 0) {
        const remainder = (value - 1) % 26;
        name = String.fromCharCode(65 + remainder) + name;
        value = Math.floor((value - 1) / 26);
      }
      return name;
    }
  }, rows, layout));
}

async function cleanupTemporaryRows(page, rows, layout) {
  return page.evaluate(browserFunction(async (testRows, sheetLayout) => {
    const app = window.WPSOpenApi?.Application;
    if (!app) throw new Error('WPSOpenApi.Application is not available in this WPS page.');
    const dateColumn = columnNameInBrowser(sheetLayout.dateColumn);
    const salesColumn = columnNameInBrowser(sheetLayout.salesColumn);
    const cleaned = [];
    const failedCleanup = [];
    for (const row of testRows) {
      const dateAddress = `${dateColumn}${row.row}`;
      const salesAddress = `${salesColumn}${row.row}`;
      const actualDate = normalizeDateInBrowser(await cellText(app, dateAddress));
      const actualSales = normalizeCellValue(await cellText(app, salesAddress));
      if (actualDate !== normalizeDateInBrowser(row.date) ||
          actualSales !== normalizeCellValue(row.sales)) {
        failedCleanup.push({
          address: `${dateAddress}/${salesAddress}`,
          actual: `${actualDate}/${actualSales}`,
        });
        continue;
      }
      for (const address of [dateAddress, salesAddress]) await clearCellValue(app, address);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      const remainingDate = String(await cellText(app, dateAddress) || '').trim();
      const remainingSales = String(await cellText(app, salesAddress) || '').trim();
      if (remainingDate || remainingSales) {
        failedCleanup.push({
          address: `${dateAddress}/${salesAddress}`,
          actual: `${remainingDate}/${remainingSales}`,
        });
      } else {
        cleaned.push(row);
      }
    }
    return { cleaned, failedCleanup };

    async function clearCellValue(wpsApp, address) {
      const range = wpsApp.Range(address);
      await Promise.resolve(range.ClearContents?.()).catch(() => {});
      range.Value = '';
      await Promise.resolve(range.Value2 = '').catch(() => {});
      await Promise.resolve(range.Formula = '').catch(() => {});
    }

    async function cellText(wpsApp, address) {
      return String(await Promise.resolve(wpsApp.Range(address).Text).catch(() => '') || '').trim();
    }

    function normalizeDateInBrowser(value) {
      const text = String(value ?? '').trim();
      const normalized = text.replace(/[年 月.\-]/g, '/').replace(/日/g, '').replace(/\/+/g, '/');
      const match = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
      return match ? `${Number(match[1])}/${Number(match[2])}/${Number(match[3])}` : '';
    }

    function normalizeCellValue(value) {
      const text = String(value ?? '').trim().replace(/,/g, '');
      return /^-?\d+(\.\d+)?$/.test(text) ? String(Number(text)) : text;
    }

    function columnNameInBrowser(column) {
      let name = '';
      let value = column;
      while (value > 0) {
        const remainder = (value - 1) % 26;
        name = String.fromCharCode(65 + remainder) + name;
        value = Math.floor((value - 1) / 26);
      }
      return name;
    }
  }, rows, layout));
}

async function scanDailyTotalRows(page, { layout, scanMaxRow, emptyRowStop }) {
  const rows = [];
  const duplicateDates = [];
  const dateIndex = new Map();
  let lastUsedRow = layout.startRow - 1;
  let consecutiveEmptyRows = 0;
  let finished = false;

  for (let chunkStart = layout.startRow; chunkStart <= scanMaxRow && !finished; chunkStart += 100) {
    const chunkEnd = Math.min(scanMaxRow, chunkStart + 99);
    const leftColumnIndex = Math.min(layout.dateColumn, layout.salesColumn);
    const rightColumnIndex = Math.max(layout.dateColumn, layout.salesColumn);
    const leftColumn = columnName(leftColumnIndex);
    const rightColumn = columnName(rightColumnIndex);
    const values = await page.evaluate(browserFunction(async (scanRange) => {
      const app = window.WPSOpenApi?.Application;
      if (!app) throw new Error('WPSOpenApi.Application is not available in this WPS page.');
      return await Promise.resolve(app.Range(scanRange).Value2);
    }, `${leftColumn}${chunkStart}:${rightColumn}${chunkEnd}`));
    const count = chunkEnd - chunkStart + 1;
    const matrix = normalizeRangeMatrix(values, count);
    const dateOffset = layout.dateColumn - leftColumnIndex;
    const salesOffset = layout.salesColumn - leftColumnIndex;
    const dates = matrix.map((row) => row[dateOffset] ?? '');
    const sales = matrix.map((row) => row[salesOffset] ?? '');

    for (let offset = 0; offset < count; offset += 1) {
      const rowIndex = chunkStart + offset;
      const dateText = normalizeScannedDate(dates[offset]);
      const salesText = String(sales[offset] ?? '').trim();
      if (dateText || salesText) {
        lastUsedRow = rowIndex;
        consecutiveEmptyRows = 0;
      } else {
        consecutiveEmptyRows += 1;
        if (consecutiveEmptyRows >= emptyRowStop) {
          finished = true;
          break;
        }
      }
      if (!dateText) continue;
      if (dateIndex.has(dateText)) {
        duplicateDates.push({
          date: dateText,
          firstRow: dateIndex.get(dateText),
          duplicateRow: rowIndex,
        });
        continue;
      }
      dateIndex.set(dateText, rowIndex);
      rows.push({ row: rowIndex, date: dateText, sales: salesText });
    }
  }
  return { rows, duplicateDates, lastUsedRow };
}

function normalizeRangeMatrix(value, expectedLength) {
  const sourceRows = Array.isArray(value) ? value : [[value]];
  const rows = sourceRows.map((row) => Array.isArray(row) ? row : [row]);
  while (rows.length < expectedLength) rows.push([]);
  return rows;
}

function normalizeScannedDate(value) {
  const text = String(value ?? '').trim();
  if (/^\d{4,6}(\.\d+)?$/.test(text) && Number(text) > 20000) {
    const parsed = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(text)) * 86400000);
    return `${parsed.getUTCFullYear()}/${parsed.getUTCMonth() + 1}/${parsed.getUTCDate()}`;
  }
  return normalizeDate(text);
}

function printResult(result, dryRun) {
  console.log(`${dryRun ? 'Dry-run matched' : 'Matched rows updated'}: ${result.updated.length}`);
  console.log(`${dryRun ? 'Dry-run missing' : 'New rows appended'}: ${result.appended.length}`);
  for (const row of [...result.updated, ...result.appended].slice(0, 30)) {
    console.log(`  row ${row.row}: ${row.date} -> total sales=${row.sales}`);
  }
  if (result.duplicateDates.length) {
    console.log(`Duplicate dates in configured date column: ${result.duplicateDates.length}`);
  }
  if (result.failedWrites.length) {
    for (const failure of result.failedWrites.slice(0, 20)) {
      console.log(
        `  failed ${failure.address}: expected=${failure.expected}, actual=${failure.actual || '(empty)'}`,
      );
    }
  }
  if (result.cleaned.length) {
    console.log(`Temporary test rows cleaned: ${result.cleaned.length}`);
  }
  if (result.failedCleanup.length) {
    for (const failure of result.failedCleanup.slice(0, 20)) {
      console.log(`  cleanup failed ${failure.address}: actual=${failure.actual}`);
    }
  }
}

function excelColumnToIndex(value, label) {
  const text = String(value || '').trim().toUpperCase();
  if (/^\d+$/.test(text) && Number(text) > 0) return Number(text);
  if (!/^[A-Z]+$/.test(text)) throw new Error(`Invalid ${label}: ${value}`);
  let result = 0;
  for (const character of text) result = result * 26 + character.charCodeAt(0) - 64;
  return result;
}

function normalizeDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const normalized = text.replace(/[年 月.\-]/g, '/').replace(/日/g, '').replace(/\/+/g, '/');
  const match = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return '';
  }
  return `${year}/${month}/${day}`;
}

function displayDate(value) {
  return normalizeDate(value);
}

function dateTime(value) {
  const match = normalizeDate(value).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : Number.MAX_SAFE_INTEGER;
}

function cellNumber(value) {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`Invalid WPS daily-total sales value: ${value}`);
  return Number(text);
}

function columnName(column) {
  let name = '';
  let value = column;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function positiveInteger(value, fallback, label) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function nonNegativeInteger(value, fallback, label) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be zero or positive.`);
  return parsed;
}

function remainingTime(deadline) {
  return Math.max(0, deadline - Date.now());
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isRecoverableNavigationError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('navigated or closed') ||
    message.includes('websocket') ||
    message.includes('target closed') ||
    message.includes('promise was collected') ||
    message.includes('login required after attempted write');
}

function browserFunction(fn, ...args) {
  return `(${fn.toString()})(...${JSON.stringify(args)})`;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  updateWpsDailyTotals().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
