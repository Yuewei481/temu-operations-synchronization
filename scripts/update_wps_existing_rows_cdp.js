import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CdpPage, activateCdpPage, getCdpOrigin, listCdpPages } from './cdp_client.js';

const DEFAULT_DOC_URL = 'https://www.kdocs.cn/l/REMOVED_PRIVATE_DOCUMENT';
const DEFAULT_SHEET_NAME = '运营数据记录表';
const DEFAULT_STORE_GROUP_TITLE = 'TEMU 1';
const DEFAULT_HEADER_ALIASES = {
  dateColumn: ['日期'],
  nameColumn: ['SKU', '商品名称', '商品名', '名称'],
  salesColumn: ['销量（件）', '销量', '销售量', '销售量（件）'],
  exposureColumn: ['曝光量（次）', '曝光量', '曝光'],
  clicksColumn: ['点击量（次）', '点击量', '点击'],
};
const DEFAULT_PAYLOAD_PATH = 'output/wps-append-payload.json';
const DEFAULT_INITIAL_WAIT_MS = 30 * 1000;
const DEFAULT_OPENAPI_TIMEOUT_MS = 180 * 1000;
const DEFAULT_SCAN_MAX_ROW = 5000;
const POLL_INTERVAL_MS = 1000;

async function main() {
  const cdpOrigin = getCdpOrigin();
  const docUrl = process.env.WPS_DOC_URL || DEFAULT_DOC_URL;
  const sheetName = process.env.WPS_SHEET_NAME || DEFAULT_SHEET_NAME;
  const storeGroupTitle = process.env.WPS_STORE_GROUP_TITLE || process.env.WPS_GROUP_TITLE || DEFAULT_STORE_GROUP_TITLE;
  const headerAliases = buildHeaderAliases();
  const payloadPath = resolve(process.env.WPS_UPDATE_PAYLOAD || process.env.WPS_APPEND_PAYLOAD || DEFAULT_PAYLOAD_PATH);
  const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
  const rows = payload.rows || [];

  if (!rows.length) {
    throw new Error(`No rows to update in ${payloadPath}`);
  }

  console.log(`Rows to match/update: ${rows.length}`);
  const pageInfo = await findOrOpenWpsPage(cdpOrigin, docUrl);
  await activateCdpPage(pageInfo, cdpOrigin);

  const page = new CdpPage(pageInfo);
  try {
    await page.send('Runtime.enable');
    await page.send('Page.enable');

    console.log(`WPS tab detected: ${pageInfo.url}`);
    const initialWaitMs = Number.parseInt(process.env.WPS_INITIAL_WAIT_MS || `${DEFAULT_INITIAL_WAIT_MS}`, 10);
    if (initialWaitMs > 0) {
      console.log(`Waiting ${Math.round(initialWaitMs / 1000)} seconds for WPS login/document loading...`);
      await sleep(initialWaitMs);
    }
    await waitForWpsSheetShell(page, sheetName, 120000);
    await waitForWpsOpenApi(page, wpsOpenApiTimeoutMs());

    console.log(`Activating sheet: ${sheetName}`);
    await activateWpsWorksheet(page, sheetName);
    const layout = await verifyTargetSheet(page, sheetName, storeGroupTitle, headerAliases);

    if (process.env.WPS_UPDATE_DRY_RUN === '1') {
      const preview = await updateExistingRows(page, rows, { dryRun: true, layout });
      printUpdateResult(preview);
      return;
    }

    const result = await updateExistingRows(page, rows, { dryRun: false, layout });
    printUpdateResult(result);
    console.log('Done. Existing rows were updated without changing the image column.');
  } finally {
    await page.close();
  }
}

function wpsOpenApiTimeoutMs() {
  return Number.parseInt(process.env.WPS_OPENAPI_TIMEOUT_MS || `${DEFAULT_OPENAPI_TIMEOUT_MS}`, 10);
}

function buildHeaderAliases() {
  return {
    dateColumn: splitHeaderAliases(process.env.WPS_DATE_HEADER, DEFAULT_HEADER_ALIASES.dateColumn),
    nameColumn: splitHeaderAliases(process.env.WPS_NAME_HEADER, DEFAULT_HEADER_ALIASES.nameColumn),
    salesColumn: splitHeaderAliases(process.env.WPS_SALES_HEADER, DEFAULT_HEADER_ALIASES.salesColumn),
    exposureColumn: splitHeaderAliases(process.env.WPS_EXPOSURE_HEADER, DEFAULT_HEADER_ALIASES.exposureColumn),
    clicksColumn: splitHeaderAliases(process.env.WPS_CLICKS_HEADER, DEFAULT_HEADER_ALIASES.clicksColumn),
  };
}

function splitHeaderAliases(value, fallback) {
  if (!value) {
    return fallback;
  }
  const aliases = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return aliases.length ? aliases : fallback;
}

async function findOrOpenWpsPage(cdpOrigin, docUrl) {
  const docId = docUrl.match(/\/l\/([^/?#]+)/)?.[1] || '';
  const pages = await listCdpPages(cdpOrigin);
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

async function waitForWpsSheetShell(page, sheetName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(
      `(document.body?.innerText || "").includes(${JSON.stringify(sheetName)}) && (document.body?.innerText || "").includes("开始")`,
    );
    if (ready) {
      return;
    }
    console.log('Waiting for WPS document to load. If needed, finish login in Chrome...');
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for WPS sheet shell: ${sheetName}`);
}

async function waitForWpsOpenApi(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page.evaluate('!!window.WPSOpenApi?.Application');
    if (ready) {
      return;
    }
    console.log('Waiting for WPS editing API to become available. If needed, finish WPS login in Chrome...');
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('Timed out waiting for WPSOpenApi.Application.');
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

async function verifyTargetSheet(page, sheetName, storeGroupTitle, headerAliases) {
  const layout = await page.evaluate(browserFunction(async (targetSheetName, targetGroupTitle, expectedHeaders) => {
    const app = window.WPSOpenApi.Application;
    const group = await findGroupLayout(app, targetGroupTitle, expectedHeaders);
    return {
      activeSheetName: String(await Promise.resolve(app.ActiveSheet?.Name).catch(() => '') || ''),
      group,
    };

    async function findGroupLayout(wpsApp, groupTitle, headerAliasesByRole) {
      const maxColumn = 120;
      const rowOne = [];
      for (let column = 1; column <= maxColumn; column += 1) {
        const text = normalizeText(await cellTextByIndex(wpsApp, 1, column));
        if (text) {
          rowOne.push({ column, text });
        }
      }

      const groupStart = rowOne.find((cell) => normalizeGroupTitle(cell.text) === normalizeGroupTitle(groupTitle));
      if (!groupStart) {
        throw new Error(`Unable to find store group title in row 1: ${groupTitle}`);
      }

      const nextGroup = rowOne.find((cell) => cell.column > groupStart.column);
      const groupEndColumn = nextGroup ? nextGroup.column - 1 : Math.min(maxColumn, groupStart.column + 24);
      const headers = {};
      for (let column = groupStart.column; column <= groupEndColumn; column += 1) {
        const text = normalizeHeader(await cellTextByIndex(wpsApp, 2, column));
        if (!text) {
          continue;
        }
        for (const [role, aliases] of Object.entries(headerAliasesByRole)) {
          if (!headers[role] && aliases.some((alias) => text === normalizeHeader(alias))) {
            headers[role] = column;
          }
        }
      }

      const required = ['dateColumn', 'nameColumn', 'salesColumn', 'exposureColumn', 'clicksColumn'];
      for (const key of required) {
        if (!headers[key]) {
          const expected = headerAliasesByRole[key].join(' / ');
          throw new Error(`Missing required header under ${groupTitle}: ${key}. Expected one of: ${expected}`);
        }
      }

      return {
        groupTitle: groupStart.text,
        groupStartColumn: groupStart.column,
        groupEndColumn,
        ...headers,
      };
    }

    async function cellTextByIndex(wpsApp, row, column) {
      const address = `${columnName(column)}${row}`;
      const range = wpsApp.Range(address);
      return String(await Promise.resolve(range.Text).catch(() => '') || '').trim();
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

    function normalizeText(value) {
      return String(value ?? '').replace(/\s+/g, ' ').trim();
    }

    function normalizeGroupTitle(value) {
      return normalizeText(value).replace(/\s+/g, '').toUpperCase();
    }

    function normalizeHeader(value) {
      return normalizeText(value).replace(/[（）()\s]/g, '');
    }
  }, sheetName, storeGroupTitle, headerAliases));

  if (layout.activeSheetName !== sheetName) {
    throw new Error(`Target sheet verification failed. Expected ${sheetName}, got ${layout.activeSheetName || '(empty)'}.`);
  }
  console.log(
    `Verified target group: ${layout.group.groupTitle} columns ${layout.group.groupStartColumn}-${layout.group.groupEndColumn}; date=${layout.group.dateColumn}, SKU=${layout.group.nameColumn}, sales=${layout.group.salesColumn}, exposure=${layout.group.exposureColumn}, clicks=${layout.group.clicksColumn}`,
  );
  return layout.group;
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
  return page.evaluate(browserFunction(async (payloadRows, maxRow, shouldDryRun, sheetLayout) => {
    if (!window.WPSOpenApi?.Application) {
      throw new Error('WPSOpenApi.Application is not available in this WPS page.');
    }

    await window.WPSOpenApi.documentReadyPromise?.catch?.(() => {});
    const app = window.WPSOpenApi.Application;
    const index = new Map();
    const duplicateKeys = [];
    const dateColumn = columnName(sheetLayout.dateColumn);
    const nameColumn = columnName(sheetLayout.nameColumn);
    const salesColumn = columnName(sheetLayout.salesColumn);
    const exposureColumn = columnName(sheetLayout.exposureColumn);
    const clicksColumn = columnName(sheetLayout.clicksColumn);

    for (let rowIndex = 3; rowIndex <= maxRow; rowIndex += 1) {
      const dateText = normalizeDate(await cellText(app, `${dateColumn}${rowIndex}`));
      const nameText = normalizeName(await cellText(app, `${nameColumn}${rowIndex}`));
      if (!dateText && !nameText) {
        continue;
      }
      if (!dateText || !nameText) {
        continue;
      }

      const key = `${dateText}\u0000${nameText}`;
      if (index.has(key)) {
        duplicateKeys.push({ key: `${dateText} / ${nameText}`, firstRow: index.get(key), duplicateRow: rowIndex });
        continue;
      }
      index.set(key, rowIndex);
    }

    const updated = [];
    const missing = [];
    for (const payloadRow of payloadRows) {
      const dateText = normalizeDate(payloadRow.date);
      const nameText = normalizeName(payloadRow.name);
      const key = `${dateText}\u0000${nameText}`;
      const targetRow = index.get(key);
      if (!targetRow) {
        missing.push({ date: payloadRow.date || '', name: payloadRow.name || '' });
        continue;
      }

      if (!shouldDryRun) {
        app.Range(`${salesColumn}${targetRow}`).Value = toCellNumberOrText(payloadRow.sales);
        app.Range(`${exposureColumn}${targetRow}`).Value = toCellNumberOrText(payloadRow.exposure);
        app.Range(`${clicksColumn}${targetRow}`).Value = toCellNumberOrText(payloadRow.clicks);
      }

      updated.push({
        row: targetRow,
        date: payloadRow.date || '',
        name: payloadRow.name || '',
        sales: String(payloadRow.sales ?? ''),
        exposure: String(payloadRow.exposure ?? ''),
        clicks: String(payloadRow.clicks ?? ''),
      });
    }

    return { updated, missing, duplicateKeys };

    async function cellText(wpsApp, address) {
      const range = wpsApp.Range(address);
      return String(await Promise.resolve(range.Text).catch(() => '') || '').trim();
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
  }, rows, scanMaxRow, dryRun, layout));
}

function printUpdateResult(result) {
  console.log(`Matched rows: ${result.updated.length}`);
  if (result.updated.length) {
    console.log('Updated/matched preview:');
    for (const row of result.updated.slice(0, 20)) {
      console.log(`  row ${row.row}: ${row.date} / ${row.name} -> sales=${row.sales}, exposure=${row.exposure}, clicks=${row.clicks}`);
    }
    if (result.updated.length > 20) {
      console.log(`  ... ${result.updated.length - 20} more`);
    }
  }

  if (result.missing.length) {
    console.log(`Missing rows: ${result.missing.length}`);
    for (const row of result.missing.slice(0, 20)) {
      console.log(`  missing: ${row.date} / ${row.name}`);
    }
    if (result.missing.length > 20) {
      console.log(`  ... ${result.missing.length - 20} more missing`);
    }
  }

  if (result.duplicateKeys.length) {
    console.log(`Duplicate date/name keys in sheet: ${result.duplicateKeys.length}`);
    for (const duplicate of result.duplicateKeys.slice(0, 10)) {
      console.log(`  duplicate: ${duplicate.key} rows ${duplicate.firstRow}, ${duplicate.duplicateRow}`);
    }
  }
}

function browserFunction(fn, ...args) {
  return `(${fn.toString()})(...${JSON.stringify(args)})`;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
