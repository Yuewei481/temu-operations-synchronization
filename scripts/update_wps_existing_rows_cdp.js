import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CdpPage, activateCdpPage, getCdpOrigin, listCdpPages } from './cdp_client.js';
import { dateBatchKeys, orderRowsByDateBatch } from './date_batches.js';
import {
  WPS_SIGN_IN_LABELS,
  isMatchingWpsDocumentPage,
  isRecoverableWpsNavigationError,
  isWpsLoginPage,
} from './wps_auth_state.js';

const DEFAULT_DOC_URL = '';
const DEFAULT_SHEET_NAME = '运营数据记录表';
const DEFAULT_PAYLOAD_PATH = 'output/wps-append-payload.json';
const DEFAULT_INITIAL_WAIT_MS = 0;
const DEFAULT_LOGIN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SCAN_MAX_ROW = 5000;
const POLL_INTERVAL_MS = 1000;

async function main() {
  const retryDeadline = Date.now() + wpsLoginTimeoutMs();
  while (Date.now() < retryDeadline) {
    try {
      return await updateExistingRowsAttempt(retryDeadline);
    } catch (error) {
      if (!isRecoverableWpsNavigationError(error) || remainingTime(retryDeadline) <= 0) throw error;
      console.log('WPS login/navigation replaced the page. Reconnecting and continuing to wait...');
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new Error('Timed out waiting for a stable signed-in WPS document.');
}

async function updateExistingRowsAttempt(loginDeadline) {
  const cdpOrigin = getCdpOrigin();
  const docUrl = process.env.WPS_DOC_URL || DEFAULT_DOC_URL;
  if (!docUrl) {
    throw new Error('请在 .env 中配置 WPS_DOC_URL。');
  }
  const sheetName = process.env.WPS_SHEET_NAME || DEFAULT_SHEET_NAME;
  const configuredLayout = buildConfiguredLayout();
  const payloadPath = resolve(process.env.WPS_UPDATE_PAYLOAD || process.env.WPS_APPEND_PAYLOAD || DEFAULT_PAYLOAD_PATH);
  const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
  const rows = orderRowsByDateBatch(payload.rows || []);

  if (!rows.length) {
    throw new Error(`No rows to update in ${payloadPath}`);
  }

  console.log(`Rows to match/update: ${rows.length}`);
  console.log(`Date batch order: ${dateBatchKeys(rows).join(', ')}`);
  await findOrOpenWpsPage(cdpOrigin, docUrl);
  const pageInfo = await waitForStableWpsPage(cdpOrigin, docUrl, loginDeadline);
  await activateCdpPage(pageInfo, cdpOrigin);

  const page = new CdpPage(pageInfo);
  try {
    await page.send('Runtime.enable');
    await page.send('Page.enable');

    console.log(`WPS tab detected: ${pageInfo.url}`);
    const initialWaitMs = nonNegativeInteger(
      process.env.WPS_INITIAL_WAIT_MS,
      DEFAULT_INITIAL_WAIT_MS,
      'WPS_INITIAL_WAIT_MS',
    );
    if (initialWaitMs > 0) {
      console.log(`Waiting ${Math.round(initialWaitMs / 1000)} seconds for WPS login/document loading...`);
      await sleep(Math.min(initialWaitMs, remainingTime(loginDeadline)));
    }
    await waitForWpsReady(page, sheetName, remainingTime(loginDeadline));

    console.log(`Activating sheet: ${sheetName}`);
    await activateWpsWorksheet(page, sheetName);
    const layout = await verifyTargetSheet(page, sheetName, configuredLayout);

    if (process.env.WPS_UPDATE_DRY_RUN === '1') {
      const preview = await updateExistingRows(page, rows, { dryRun: true, layout });
      printUpdateResult(preview);
      return;
    }

    const result = await updateExistingRows(page, rows, { dryRun: false, layout });
    printUpdateResult(result);
    if (result.failedWrites.length) {
      await sleep(POLL_INTERVAL_MS);
      const currentPages = await listCdpPages(cdpOrigin);
      const loginPage = currentPages.find(isWpsLoginPage);
      if (loginPage) {
        throw new Error('WPS login required after attempted write. Reconnect after authentication.');
      }
      throw new Error(`${result.failedWrites.length} WPS detail cell write(s) failed verification.`);
    }
    console.log('Done. Rows were matched or appended using the configured date, name, and sales columns.');
  } finally {
    await page.close();
  }
}

function wpsLoginTimeoutMs() {
  return positiveInteger(process.env.WPS_LOGIN_TIMEOUT_MS, DEFAULT_LOGIN_TIMEOUT_MS, 'WPS_LOGIN_TIMEOUT_MS');
}

function positiveInteger(value, fallback, label) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function nonNegativeInteger(value, fallback, label) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be zero or a positive integer.`);
  }
  return parsed;
}

function remainingTime(deadline) {
  return Math.max(0, deadline - Date.now());
}

function buildConfiguredLayout() {
  const raw = {
    dateColumn: process.env.WPS_DATE_COLUMN,
    nameColumn: process.env.WPS_NAME_COLUMN,
    salesColumn: process.env.WPS_SALES_COLUMN,
  };
  const missing = Object.entries(raw)
    .filter(([, value]) => !String(value || '').trim())
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`Missing required WPS column configuration: ${missing.join(', ')}`);
  }
  const columns = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, excelColumnToIndex(value, key)]),
  );
  if (new Set(Object.values(columns)).size !== Object.values(columns).length) {
    throw new Error('WPS date, name, and sales columns must be different.');
  }
  const startRow = Number.parseInt(String(process.env.WPS_START_ROW || '').trim(), 10);
  if (!Number.isFinite(startRow) || startRow < 1) {
    throw new Error('WPS_START_ROW must be a positive integer.');
  }
  return { ...columns, startRow };
}

function excelColumnToIndex(value, label) {
  const text = String(value || '').trim().toUpperCase();
  if (/^\d+$/.test(text) && Number(text) > 0) {
    return Number(text);
  }
  if (!/^[A-Z]+$/.test(text)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  let result = 0;
  for (const character of text) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result;
}

async function findOrOpenWpsPage(cdpOrigin, docUrl) {
  const docId = '__strict_path_matching_only__';
  const pages = await listCdpPages(cdpOrigin);
  const matchingPage = pages.find((page) => isMatchingWpsDocumentPage(page, docUrl));
  if (matchingPage) return matchingPage;
  const loginPage = pages.find(isWpsLoginPage);
  if (loginPage) return loginPage;
  const existing = pages.find(
    (page) =>
      page.type === 'page' &&
      (page.url.includes('kdocs.cn') || page.url.includes('wps.cn')) &&
      (page.url.includes(docId) || page.title.includes('贺卡店运营数据及库存记录表')),
  );
  if (existing) {
    return existing;
  }

  const response = await fetch(`${cdpOrigin}/json/new?${encodeURIComponent(docUrl)}`, { method: 'PUT' });
  if (!response.ok) {
    throw new Error(`Unable to open WPS doc tab via CDP (${response.status}).`);
  }
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
      console.log('WPS login and document loading completed. Continuing immediately.');
      return;
    }
    console.log(
      `Waiting for WPS login/document loading ` +
      `(sheet=${status.sheetReady ? 'ready' : 'waiting'}, API=${status.openApi ? 'ready' : 'waiting'}, ` +
      `login=${status.signedIn ? 'ready' : 'waiting'})...`,
    );
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for a signed-in WPS sheet: ${sheetName}`);
}

async function waitForWpsReadyLegacy(page, sheetName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await page.evaluate(`(() => {
      const bodyText = document.body?.innerText || '';
      return {
        sheetShell: bodyText.includes(${JSON.stringify(sheetName)}) && bodyText.includes('开始'),
        openApi: !!window.WPSOpenApi?.Application,
        signedIn: !bodyText.includes('Sign In Now') &&
          !bodyText.split(/\s+/).some((text) => text === '\u767b\u5f55'),
      };
    })()`);
    if (status.sheetShell && status.openApi && status.signedIn) {
      console.log('WPS login and document loading completed. Continuing immediately.');
      return;
    }
    console.log(
      `Waiting for WPS login/document loading (sheet=${status.sheetShell ? 'ready' : 'waiting'}, API=${status.openApi ? 'ready' : 'waiting'})...`,
    );
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 60000)} minutes waiting for WPS login/document/API: ${sheetName}`,
  );
}

async function clickPoint(page, expression) {
  const point = await page.evaluate(expression);
  if (!point?.x || !point?.y) {
    throw new Error('Unable to find target click point in WPS page.');
  }
  await page.click(point.x, point.y);
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
    await Promise.resolve(sheet.Activate()).catch((error) => {
      throw new Error(`Unable to activate worksheet ${targetSheetName}: ${error.message}`);
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const after = String(await Promise.resolve(app.ActiveSheet?.Name).catch(() => '') || '');
    return { before, after };
  }, sheetName));

  if (result.after !== sheetName) {
    throw new Error(`Activated wrong WPS sheet. Expected ${sheetName}, got ${result.after || '(empty)'}.`);
  }
  console.log(`Active sheet: ${result.after} (was ${result.before || 'unknown'})`);
}

async function verifyTargetSheet(page, sheetName, configuredLayout) {
  const result = await page.evaluate(browserFunction(async (targetSheetName, layout) => {
    const app = window.WPSOpenApi.Application;
    return {
      activeSheetName: String(await Promise.resolve(app.ActiveSheet?.Name).catch(() => '') || ''),
      layout,
    };
  }, sheetName, configuredLayout));

  if (result.activeSheetName !== sheetName) {
    throw new Error(`Target sheet verification failed. Expected ${sheetName}, got ${result.activeSheetName || '(empty)'}.`);
  }
  console.log(
    `Verified target layout: date=${configuredLayout.dateColumn}, name=${configuredLayout.nameColumn}, sales=${configuredLayout.salesColumn}, start row=${configuredLayout.startRow}`,
  );
  return configuredLayout;
}

function buildSheetTabPointScript(sheetName) {
  return browserFunction((targetText) => {
    const elements = [...document.querySelectorAll('button, div, span, a')];
    const candidate = elements
      .filter((element) => element.innerText?.trim() === targetText)
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 10 && rect.height > 10)
      .sort((a, b) => b.rect.top - a.rect.top)[0];
    if (!candidate) {
      return null;
    }
    candidate.element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = candidate.element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, sheetName);
}

async function updateExistingRows(page, rows, { dryRun, layout }) {
  const scanMaxRow = Number.parseInt(process.env.WPS_UPDATE_SCAN_MAX_ROW || `${DEFAULT_SCAN_MAX_ROW}`, 10);
  const emptyRowStop = positiveInteger(
    process.env.WPS_UPDATE_EMPTY_ROW_STOP,
    50,
    'WPS_UPDATE_EMPTY_ROW_STOP',
  );
  const scanState = await scanExistingDetailRows(page, { layout, scanMaxRow, emptyRowStop });
  console.log(`Detail scan completed through row ${scanState.lastUsedRow}.`);
  return page.evaluate(browserFunction(async (payloadRows, shouldDryRun, sheetLayout, scannedState) => {
    if (!window.WPSOpenApi?.Application) {
      throw new Error('WPSOpenApi.Application is not available in this WPS page.');
    }

    await window.WPSOpenApi.documentReadyPromise?.catch?.(() => {});
    const app = window.WPSOpenApi.Application;
    const index = new Map(scannedState.indexEntries);
    const duplicateKeys = scannedState.duplicateKeys;
    const dateColumn = columnName(sheetLayout.dateColumn);
    const nameColumn = columnName(sheetLayout.nameColumn);
    const salesColumn = columnName(sheetLayout.salesColumn);
    const lastUsedRow = scannedState.lastUsedRow;

    const updated = [];
    const appended = [];
    const failedWrites = [];
    let nextRow = Math.max(sheetLayout.startRow, lastUsedRow + 1);
    for (const payloadRow of payloadRows) {
      const dateText = normalizeDate(payloadRow.date);
      const nameText = normalizeName(payloadRow.name);
      const key = `${dateText}\u0000${nameText}`;
      const existingRow = index.get(key);
      const targetRow = existingRow || nextRow++;
      const rowWasAppended = !existingRow;

      if (!shouldDryRun) {
        const writes = rowWasAppended
          ? [
            { address: `${dateColumn}${targetRow}`, value: payloadRow.date || '', field: 'date' },
            { address: `${nameColumn}${targetRow}`, value: payloadRow.name || '', field: 'name' },
            { address: `${salesColumn}${targetRow}`, value: toCellNumberOrText(payloadRow.sales), field: 'sales' },
          ]
          : [
            { address: `${salesColumn}${targetRow}`, value: toCellNumberOrText(payloadRow.sales), field: 'sales' },
          ];
        for (const write of writes) {
          await writeCellValue(app, write.address, write.value);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        for (const write of writes) {
          const normalizeWriteValue = write.field === 'date'
            ? normalizeDate
            : write.field === 'name'
              ? normalizeName
              : normalizeCellValue;
          const actual = normalizeWriteValue(await cellText(app, write.address));
          const expected = normalizeWriteValue(write.value);
          if (actual !== expected) {
            failedWrites.push({
              row: targetRow,
              address: write.address,
              field: write.field,
              date: payloadRow.date || '',
              name: payloadRow.name || '',
              expected,
              actual,
            });
          }
        }
      }

      const resultRow = {
        row: targetRow,
        date: payloadRow.date || '',
        name: payloadRow.name || '',
        sales: String(payloadRow.sales ?? ''),
      };
      if (rowWasAppended) {
        appended.push(resultRow);
        index.set(key, targetRow);
      } else {
        updated.push(resultRow);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
    return { updated, appended, duplicateKeys, failedWrites };

    async function writeCellValue(wpsApp, address, value) {
      const range = wpsApp.Range(address);
      range.Value = value;
    }

    async function cellText(wpsApp, address, useMergeTopLeft = false) {
      const range = wpsApp.Range(address);
      const directText = String(await Promise.resolve(range.Text).catch(() => '') || '').trim();
      if (directText || !useMergeTopLeft) {
        return directText;
      }

      const mergeArea = await Promise.resolve(range.MergeArea).catch(() => null);
      if (!mergeArea) {
        return directText;
      }

      const mergedText = String(await Promise.resolve(mergeArea.Cells(1, 1).Text).catch(() => '') || '').trim();
      return mergedText || directText;
    }

    function normalizeName(value) {
      return String(value ?? '').replace(/\s+/g, ' ').trim();
    }

    function normalizeDate(value) {
      const text = String(value ?? '').trim();
      if (!text) {
        return '';
      }

      const normalized = text.replace(/[年月.\\-]/g, '/').replace(/日/g, '').replace(/\/+/g, '/');
      const match = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
      if (match) {
        return `${Number(match[1])}/${Number(match[2])}/${Number(match[3])}`;
      }
      return normalized;
    }

    function toCellNumberOrText(value) {
      const text = String(value ?? '').trim().replace(/,/g, '');
      if (text === '') return '';
      return /^-?\\d+(\\.\\d+)?$/.test(text) ? Number(text) : text;
    }

    function normalizeCellValue(value) {
      const text = String(value ?? '').trim().replace(/,/g, '');
      if (/^-?\\d+(\\.\\d+)?$/.test(text)) {
        return String(Number(text));
      }
      return text;
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
  }, rows, dryRun, layout, scanState));
}

async function scanExistingDetailRows(page, { layout, scanMaxRow, emptyRowStop }) {
  const index = new Map();
  const duplicateKeys = [];
  let lastUsedRow = layout.startRow - 1;
  let consecutiveEmptyRows = 0;
  let finished = false;
  const columnIndexes = [layout.dateColumn, layout.nameColumn, layout.salesColumn];
  const leftColumnIndex = Math.min(...columnIndexes);
  const rightColumnIndex = Math.max(...columnIndexes);

  for (let chunkStart = layout.startRow; chunkStart <= scanMaxRow && !finished; chunkStart += 100) {
    const chunkEnd = Math.min(scanMaxRow, chunkStart + 99);
    const rangeAddress = `${excelColumnName(leftColumnIndex)}${chunkStart}:` +
      `${excelColumnName(rightColumnIndex)}${chunkEnd}`;
    const values = await page.evaluate(browserFunction(async (scanRange) => {
      const app = window.WPSOpenApi?.Application;
      if (!app) throw new Error('WPSOpenApi.Application is not available in this WPS page.');
      return await Promise.resolve(app.Range(scanRange).Value2);
    }, rangeAddress));
    const count = chunkEnd - chunkStart + 1;
    const matrix = normalizeRangeMatrix(values, count);
    const dateOffset = layout.dateColumn - leftColumnIndex;
    const nameOffset = layout.nameColumn - leftColumnIndex;
    const salesOffset = layout.salesColumn - leftColumnIndex;

    for (let offset = 0; offset < count; offset += 1) {
      const rowIndex = chunkStart + offset;
      const dateText = normalizeScannedDate(matrix[offset][dateOffset]);
      const nameText = String(matrix[offset][nameOffset] ?? '').trim();
      const salesText = String(matrix[offset][salesOffset] ?? '').trim();
      if (dateText || nameText || salesText) {
        lastUsedRow = rowIndex;
        consecutiveEmptyRows = 0;
      } else {
        consecutiveEmptyRows += 1;
        if (consecutiveEmptyRows >= emptyRowStop) {
          finished = true;
          break;
        }
      }
      if (!dateText || !nameText) continue;
      const key = `${dateText}\u0000${nameText}`;
      if (index.has(key)) {
        duplicateKeys.push({
          key: `${dateText} / ${nameText}`,
          firstRow: index.get(key),
          duplicateRow: rowIndex,
        });
        continue;
      }
      index.set(key, rowIndex);
    }
  }
  return { indexEntries: [...index.entries()], duplicateKeys, lastUsedRow };
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
  const normalized = text.replace(/[年月\-]/g, '/').replace(/日/g, '').replace(/\/+/g, '/');
  const match = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  return match ? `${Number(match[1])}/${Number(match[2])}/${Number(match[3])}` : normalized;
}

function excelColumnName(column) {
  let name = '';
  let value = column;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function printUpdateResult(result) {
  console.log(`Matched rows updated: ${result.updated.length}`);
  if (result.updated.length) {
    console.log('Updated/matched preview:');
    for (const row of result.updated.slice(0, 20)) {
      console.log(`  row ${row.row}: ${row.date} / ${row.name} -> sales=${row.sales}`);
    }
    if (result.updated.length > 20) {
      console.log(`  ... ${result.updated.length - 20} more`);
    }
  }

  if (result.appended.length) {
    console.log(`New rows appended: ${result.appended.length}`);
    for (const row of result.appended.slice(0, 20)) {
      console.log(`  row ${row.row}: ${row.date} / ${row.name} -> sales=${row.sales}`);
    }
    if (result.appended.length > 20) {
      console.log(`  ... ${result.appended.length - 20} more appended`);
    }
  }

  if (result.duplicateKeys.length) {
    console.log(`Duplicate date/name keys in sheet: ${result.duplicateKeys.length}`);
    for (const duplicate of result.duplicateKeys.slice(0, 10)) {
      console.log(`  duplicate: ${duplicate.key} rows ${duplicate.firstRow}, ${duplicate.duplicateRow}`);
    }
  }

  if (result.failedWrites?.length) {
    console.log(`Failed write verifications: ${result.failedWrites.length}`);
    for (const failure of result.failedWrites.slice(0, 20)) {
      console.log(
        `  failed ${failure.address} (${failure.field}): ${failure.date} / ${failure.name}, expected=${failure.expected}, actual=${failure.actual || '(empty)'}`,
      );
    }
    if (result.failedWrites.length > 20) {
      console.log(`  ... ${result.failedWrites.length - 20} more failed writes`);
    }
  }
}

function browserFunction(fn, ...args) {
  return `(${fn.toString()})(...${JSON.stringify(args)})`;
}

function isRecoverableNavigationError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('navigated or closed') ||
    message.includes('websocket') ||
    message.includes('target closed') ||
    message.includes('promise was collected') ||
    message.includes('login required after attempted write');
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
