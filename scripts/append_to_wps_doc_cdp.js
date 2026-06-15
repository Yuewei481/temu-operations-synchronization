import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { CdpPage, activateCdpPage, getCdpOrigin, listCdpPages } from './cdp_client.js';

const DEFAULT_DOC_URL = '';
const DEFAULT_SHEET_NAME = 'temu1店运营数据记录表';
const DEFAULT_PAYLOAD_PATH = 'output/wps-append-payload.json';
const DEFAULT_INITIAL_WAIT_MS = 30 * 1000;
const DEFAULT_ROW_HEIGHT_PX = 165;
const DEFAULT_IMAGE_SIZE_PX = 150;
const DEFAULT_IMAGE_COLUMN_WIDTH = 32;
const DEFAULT_ROW_HEIGHT_PADDING_PX = 6;
const DEFAULT_IMAGE_COLUMN_PADDING_PX = 10;
const DEFAULT_IMAGE_SOURCE_SCAN_ROWS = 1200;
const DEFAULT_APPEND_SCAN_MAX_ROW = 5000;
const DEFAULT_GENERATED_EXCEL_PATH = 'output/sales-data.xlsx';
const DEFAULT_GENERATED_IMAGE_DIR = 'output/excel-images';
const POLL_INTERVAL_MS = 1000;

async function main() {
  const cdpOrigin = getCdpOrigin();
  const docUrl = process.env.WPS_DOC_URL || DEFAULT_DOC_URL;
  if (!docUrl) {
    throw new Error('请在 .env 中配置 WPS_DOC_URL。');
  }
  const sheetName = process.env.WPS_SHEET_NAME || DEFAULT_SHEET_NAME;
  const payloadPath = resolve(process.env.WPS_APPEND_PAYLOAD || DEFAULT_PAYLOAD_PATH);
  const payload = JSON.parse(await readFile(payloadPath, 'utf8'));

  if (!payload.rows?.length) {
    throw new Error(`No rows to append in ${payloadPath}`);
  }

  console.log(`Rows to append: ${payload.rows.length}`);
  const pageInfo = await findOrOpenWpsPage(cdpOrigin, docUrl);
  await activateCdpPage(pageInfo, cdpOrigin);

  const page = new CdpPage(pageInfo);
  try {
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Browser.grantPermissions', {
      origin: new URL(pageInfo.url || docUrl).origin,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    }).catch(() => {});

    console.log(`WPS tab detected: ${pageInfo.url}`);
    const initialWaitMs = Number.parseInt(process.env.WPS_INITIAL_WAIT_MS || `${DEFAULT_INITIAL_WAIT_MS}`, 10);
    if (initialWaitMs > 0) {
      console.log(`Waiting ${Math.round(initialWaitMs / 1000)} seconds for WPS login/document loading...`);
      await sleep(initialWaitMs);
    }
    await waitForWpsSheetShell(page, sheetName, 120000);

    console.log(`Selecting sheet: ${sheetName}`);
    await clickPoint(page, buildSheetTabPointScript(sheetName));
    await sleep(1500);

    console.log('Detecting the first append row from column A...');
    const startRow = process.env.WPS_APPEND_START_ROW
      ? Number.parseInt(process.env.WPS_APPEND_START_ROW, 10)
      : await detectAppendStartRow(page);
    if (!Number.isFinite(startRow) || startRow < 3) {
      throw new Error(`Unable to detect append row. Set WPS_APPEND_START_ROW manually, for example WPS_APPEND_START_ROW=1439.`);
    }
    console.log(`Append start cell: A${startRow}`);

    await setNameBoxAddress(page, `A${startRow}`);
    await sleep(1000);
    await pressKey(page, 'Escape');
    await sleep(300);

    if (process.env.WPS_APPEND_DRY_RUN === '1') {
      console.log(`Dry run enabled. No rows were written. Detected append start cell: A${startRow}`);
      return;
    }

    console.log('Writing rows with WPS OpenApi and in-cell DISPIMG formulas.');
    const result = await appendRowsWithWpsOpenApi(page, payload.rows, startRow);
    if (result.missingImageNames.length) {
      console.log(`Images not found in existing WPS rows: ${result.missingImageNames.join(', ')}`);
    }
    console.log(`Rows written: ${result.written}`);

    const verification = await verifyPaste(page, payload.rows[0]);
    console.log(`Paste verification: ${verification}`);
    if (process.env.WPS_CLEANUP_AFTER_APPEND === '1') {
      await cleanupGeneratedLocalFiles(payload.rows);
    }
    console.log('Done. Please visually confirm the appended rows and images in WPS.');
  } finally {
    await page.close();
  }
}

async function findOrOpenWpsPage(cdpOrigin, docUrl) {
  const pages = await listCdpPages(cdpOrigin);
  const existing = pages.find(
    (page) =>
      page.type === 'page' &&
      (page.url.includes('kdocs.cn') || page.url.includes('wps.cn')),
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

async function clickPoint(page, expression) {
  const point = await page.evaluate(expression);
  if (!point?.x || !point?.y) {
    throw new Error('Unable to find target click point in WPS page.');
  }
  await page.click(point.x, point.y);
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

async function detectAppendStartRow(page) {
  const openApiRow = await detectAppendStartRowWithWpsOpenApi(page).catch((error) => {
    console.log(`WPS OpenApi append-row detection failed, falling back to keyboard detection: ${error.message}`);
    return null;
  });
  if (openApiRow) {
    return openApiRow;
  }

  await setNameBoxAddress(page, 'A1048576');
  await sleep(1000);
  await sendNativeJumpToPreviousNonEmptyInColumn();
  await sleep(1500);

  const address = await readSelectedCellAddress(page);
  const match = /^A(\d+)$/i.exec(address || '');
  const anyColumnMatch = /^[A-Z]{1,3}(\d+)$/i.exec(address || '');
  if (match) {
    const row = Number.parseInt(match[1], 10);
    if (row >= 2) {
      return row + 1;
    }
  }
  if (anyColumnMatch) {
    const row = Number.parseInt(anyColumnMatch[1], 10);
    if (row >= 2) {
      return row + 1;
    }
  }

  throw new Error(
    `Unable to detect append row automatically. Expected the name box to show a used-cell address after jumping through column A, got ${address || 'empty'}.`,
  );
}

async function detectAppendStartRowWithWpsOpenApi(page) {
  const maxRow = Number.parseInt(process.env.WPS_APPEND_SCAN_MAX_ROW || `${DEFAULT_APPEND_SCAN_MAX_ROW}`, 10);
  return page.evaluate(browserFunction(async (scanMaxRow) => {
    if (!window.WPSOpenApi?.Application) {
      throw new Error('WPSOpenApi.Application is not available in this WPS page.');
    }

    await window.WPSOpenApi.documentReadyPromise?.catch?.(() => {});
    const app = window.WPSOpenApi.Application;
    const maxCandidate = Math.max(3, scanMaxRow);
    const columns = ['A', 'B', 'C', 'D', 'E', 'F'];

    for (let rowIndex = maxCandidate; rowIndex >= 3; rowIndex -= 1) {
      for (const column of columns) {
        const range = app.Range(`${column}${rowIndex}`);
        const text = String(await Promise.resolve(range.Text).catch(() => '') || '').trim();
        if (text) {
          return rowIndex + 1;
        }
        if (column === 'C') {
          const formula = String(await Promise.resolve(range.Formula).catch(() => '') || '').trim();
          if (formula) {
            return rowIndex + 1;
          }
        }
      }
    }

    return 3;
  }, maxRow));
}

function buildClipboardText(rows) {
  return rows
    .map((row) => [row.date, row.name, '', row.sales, row.exposure, row.clicks].map((value) => String(value ?? '')).join('\t'))
    .join('\n');
}

async function copyHtmlRowsToClipboard(cdpOrigin, rows) {
  const response = await fetch(`${cdpOrigin}/json/new?about:blank`, { method: 'PUT' });
  if (!response.ok) {
    throw new Error(`Unable to open temporary clipboard page (${response.status}).`);
  }

  const pageInfo = await response.json();
  const page = new CdpPage(pageInfo);
  try {
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.evaluate(`document.open(); document.write(${JSON.stringify(buildClipboardHtmlDocument(rows))}); document.close();`);
    await waitForClipboardImages(page);
    await page.evaluate(browserFunction(() => {
      const table = document.getElementById('wps-copy-table');
      const range = document.createRange();
      range.selectNode(table);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      window.focus();
    }));
    await sendCdpCopyCommand(page);
    await sleep(500);
  } finally {
    await closeTemporaryPage(page, pageInfo, cdpOrigin);
  }
}

async function waitForClipboardImages(page) {
  await page.evaluate(browserFunction(async () => {
    const images = [...document.querySelectorAll('#wps-copy-table img')];
    await Promise.all(
      images.map(async (image) => {
        if (image.complete && image.naturalWidth > 0) return;
        if (typeof image.decode === 'function') {
          await image.decode().catch(() => {});
        }
        if (image.complete && image.naturalWidth > 0) return;
        await new Promise((resolve) => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
        });
      }),
    );
  }));
}

function buildClipboardHtmlDocument(rows) {
  const cells = rows.map((row) => {
    const rowHeightPx = rowHeightForImage(row, DEFAULT_ROW_HEIGHT_PX);
    const imageWidthPx = positiveNumber(row.imageWidthPx) || DEFAULT_IMAGE_SIZE_PX;
    const imageHeightPx = positiveNumber(row.imageHeightPx) || DEFAULT_IMAGE_SIZE_PX;
    const image = row.imageDataUrl
      ? `<img src="${escapeHtml(row.imageDataUrl)}" width="${imageWidthPx}" height="${imageHeightPx}" style="width:${imageWidthPx}px;height:${imageHeightPx}px;object-fit:contain;" />`
      : '';
    return `<tr style="height:${rowHeightPx}px;"><td style="height:${rowHeightPx}px;vertical-align:middle;white-space:nowrap;">${escapeHtml(row.date)}</td><td style="height:${rowHeightPx}px;vertical-align:middle;white-space:nowrap;">${escapeHtml(row.name)}</td><td style="height:${rowHeightPx}px;vertical-align:middle;text-align:center;">${image}</td><td style="height:${rowHeightPx}px;vertical-align:middle;text-align:center;">${escapeHtml(row.sales)}</td><td style="height:${rowHeightPx}px;vertical-align:middle;text-align:center;">${escapeHtml(row.exposure)}</td><td style="height:${rowHeightPx}px;vertical-align:middle;text-align:center;">${escapeHtml(row.clicks)}</td></tr>`;
  }).join('');
  return `<!doctype html><html><body><table id="wps-copy-table" style="border-collapse:collapse;"><tbody>${cells}</tbody></table></body></html>`;
}

async function appendRowsWithWpsOpenApi(page, rows, startRow) {
  const rowHeight = fallbackRowHeight();
  const imageColumnWidth = imageColumnWidthForRows(rows);
  const scanRows = Number.parseInt(process.env.WPS_IMAGE_SOURCE_SCAN_ROWS || `${DEFAULT_IMAGE_SOURCE_SCAN_ROWS}`, 10);
  const useLocalImageUpload = process.env.WPS_IMAGE_MODE === 'local-upload';
  if (useLocalImageUpload) {
    return appendRowsWithLocalImageUpload(page, rows, startRow, rowHeight, imageColumnWidth);
  }

  return page.evaluate(browserFunction(async (payloadRows, firstRow, targetRowHeight, targetImageColumnWidth, maxScanRows) => {
    if (!window.WPSOpenApi?.Application) {
      throw new Error('WPSOpenApi.Application is not available in this WPS page.');
    }

    await window.WPSOpenApi.documentReadyPromise?.catch?.(() => {});
    const app = window.WPSOpenApi.Application;
    app.Range('C:C').ColumnWidth = targetImageColumnWidth;
    const wantedNames = new Set(payloadRows.map((row) => String(row.name || '').trim()).filter(Boolean));
    const imageFormulaByName = {};
    const sourceRowByName = {};
    const scanStart = Math.max(3, firstRow - Math.max(50, maxScanRows));

    for (let rowIndex = firstRow - 1; rowIndex >= scanStart && Object.keys(imageFormulaByName).length < wantedNames.size; rowIndex -= 1) {
      const name = String(await Promise.resolve(app.Range(`B${rowIndex}`).Text).catch(() => '') || '').trim();
      if (!wantedNames.has(name) || imageFormulaByName[name]) {
        continue;
      }

      const formula = String(await Promise.resolve(app.Range(`C${rowIndex}`).Formula).catch(() => '') || '').trim();
      if (formula.includes('DISPIMG(')) {
        imageFormulaByName[name] = formula;
        sourceRowByName[name] = rowIndex;
      }
    }

    const missingImageNames = [];
    for (let index = 0; index < payloadRows.length; index += 1) {
      const payloadRow = payloadRows[index];
      const targetRow = firstRow + index;
      const name = String(payloadRow.name || '').trim();
      const imageFormula = imageFormulaByName[name] || '';

      app.Range(`${targetRow}:${targetRow}`).RowHeight = rowHeightForImage(payloadRow, targetRowHeight);
      app.Range(`A${targetRow}`).Value = payloadRow.date || '';
      app.Range(`B${targetRow}`).Value = name;
      app.Range(`C${targetRow}`).Formula = imageFormula || '';
      app.Range(`D${targetRow}`).Value = toCellNumberOrText(payloadRow.sales);
      app.Range(`E${targetRow}`).Value = toCellNumberOrText(payloadRow.exposure);
      app.Range(`F${targetRow}`).Value = toCellNumberOrText(payloadRow.clicks);

      if (!imageFormula) {
        missingImageNames.push(name || `(row ${index + 1})`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
    return { written: payloadRows.length, missingImageNames, sourceRowByName };

    function toCellNumberOrText(value) {
      const text = String(value ?? '').trim();
      if (text === '') return '';
      return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
    }

    function rowHeightForImage(payloadRow, fallbackHeight) {
      const explicitHeight = Number(payloadRow.imageHeightPx);
      if (Number.isFinite(explicitHeight) && explicitHeight > 0) {
        return Math.ceil(explicitHeight + 6);
      }
      return fallbackHeight;
    }
  }, rows, startRow, rowHeight, imageColumnWidth, scanRows));
}

async function appendRowsWithLocalImageUpload(page, rows, startRow, rowHeight, imageColumnWidth) {
  await page.send('DOM.enable');
  await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
  const missingImageNames = [];
  let consecutiveImageFailures = 0;
  await page.evaluate(browserFunction((targetImageColumnWidth) => {
    window.WPSOpenApi.Application.Range('C:C').ColumnWidth = targetImageColumnWidth;
  }, imageColumnWidth));

  for (let index = 0; index < rows.length; index += 1) {
    const payloadRow = rows[index];
    const targetRow = startRow + index;
    const targetCell = `C${targetRow}`;

    console.log(`Writing row ${targetRow}: ${payloadRow.name || '(unnamed)'}`);
    await page.evaluate(browserFunction(async (row, rowIndex, targetRowHeight) => {
      if (!window.WPSOpenApi?.Application) {
        throw new Error('WPSOpenApi.Application is not available in this WPS page.');
      }
      await window.WPSOpenApi.documentReadyPromise?.catch?.(() => {});
      const app = window.WPSOpenApi.Application;
      app.Range(`${rowIndex}:${rowIndex}`).RowHeight = rowHeightForImage(row, targetRowHeight);
      app.Range(`A${rowIndex}`).Value = row.date || '';
      app.Range(`B${rowIndex}`).Value = row.name || '';
      app.Range(`C${rowIndex}`).Value = '';
      app.Range(`D${rowIndex}`).Value = toCellNumberOrText(row.sales);
      app.Range(`E${rowIndex}`).Value = toCellNumberOrText(row.exposure);
      app.Range(`F${rowIndex}`).Value = toCellNumberOrText(row.clicks);
      app.Range(`C${rowIndex}`).Select();

      function toCellNumberOrText(value) {
        const text = String(value ?? '').trim();
        if (text === '') return '';
        return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
      }

      function rowHeightForImage(payloadRow, fallbackHeight) {
        const explicitHeight = Number(payloadRow.imageHeightPx);
        if (Number.isFinite(explicitHeight) && explicitHeight > 0) {
          return Math.ceil(explicitHeight + 6);
        }
        return fallbackHeight;
      }
    }, payloadRow, targetRow, rowHeight));

    if (payloadRow.imagePath) {
      try {
        await uploadLocalImageToSelectedCell(page, payloadRow.imagePath, targetCell);
        consecutiveImageFailures = 0;
      } catch (error) {
        missingImageNames.push(payloadRow.name || `(row ${index + 1})`);
        console.log(`Image upload failed for ${payloadRow.name || targetCell}: ${error.message}`);
        consecutiveImageFailures += 1;
        if (consecutiveImageFailures >= 2) {
          throw new Error(
            `Stopped after ${consecutiveImageFailures} consecutive image upload failures. WPS toolbar may be stuck or not showing the Insert > Image menu.`,
          );
        }
      }
    } else {
      missingImageNames.push(payloadRow.name || `(row ${index + 1})`);
    }

    await sleep(500);
  }

  return { written: rows.length, missingImageNames, sourceRowByName: {} };
}

function fallbackRowHeight() {
  return Number.parseInt(process.env.WPS_ROW_HEIGHT_PX || `${DEFAULT_ROW_HEIGHT_PX}`, 10);
}

function rowHeightForImage(row, fallbackHeight = fallbackRowHeight()) {
  const imageHeight = positiveNumber(row.imageHeightPx);
  if (!imageHeight) {
    return fallbackHeight;
  }

  const padding = Number.parseInt(process.env.WPS_ROW_HEIGHT_PADDING_PX || `${DEFAULT_ROW_HEIGHT_PADDING_PX}`, 10);
  return Math.ceil(imageHeight + padding);
}

function imageColumnWidthForRows(rows) {
  const override = process.env.WPS_IMAGE_COLUMN_WIDTH;
  if (override) {
    return Number.parseFloat(override);
  }

  const maxImageWidth = Math.max(0, ...rows.map((row) => positiveNumber(row.imageWidthPx) || 0));
  if (!maxImageWidth) {
    return DEFAULT_IMAGE_COLUMN_WIDTH;
  }

  const padding = Number.parseInt(process.env.WPS_IMAGE_COLUMN_PADDING_PX || `${DEFAULT_IMAGE_COLUMN_PADDING_PX}`, 10);
  return Math.max(DEFAULT_IMAGE_COLUMN_WIDTH, Math.ceil((maxImageWidth + padding) / 7));
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

async function uploadLocalImageToSelectedCell(page, imagePath, targetCell) {
  const imageStats = await stat(imagePath).catch(() => null);
  if (!imageStats?.isFile()) {
    throw new Error(`Local image file not found: ${imagePath}`);
  }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.evaluate(browserFunction((cellAddress) => {
        window.WPSOpenApi.Application.Range(cellAddress).Select();
      }, targetCell));
      await sleep(500);
      await pressKey(page, 'Escape').catch(() => {});
      await sleep(300);

      await clickText(page, '插入');
      await waitForVisibleText(page, '图片', { minX: 500, maxY: 120, timeoutMs: 5000 });
      await clickText(page, '图片', { minX: 500, maxY: 100 });
      await hoverText(page, '单元格图片', { minX: 500, maxY: 250 });

      const chooserPromise = waitForCdpEvent(page, 'Page.fileChooserOpened', 8000);
      await clickText(page, '本地', { minX: 650, maxY: 240 });
      const chooser = await chooserPromise;
      await page.send('DOM.setFileInputFiles', { backendNodeId: chooser.backendNodeId, files: [imagePath] });
      const formula = await waitForCellImageFormula(page, targetCell, 15000);
      if (formula.includes('DISPIMG(')) {
        return;
      }
      throw new Error(`WPS did not create an in-cell image at ${targetCell}`);
    } catch (error) {
      lastError = error;
      console.log(`Image upload attempt ${attempt} failed for ${targetCell}: ${error.message}`);
      await pressKey(page, 'Escape').catch(() => {});
      await sleep(1000);
    }
  }
  throw lastError;
}

async function waitForVisibleText(page, text, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const point = await findTextPoint(page, text, options);
    if (point) {
      return point;
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for visible WPS menu item: ${text}`);
}

async function waitForCellImageFormula(page, targetCell, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let formula = '';
  while (Date.now() < deadline) {
    formula = await page.evaluate(browserFunction(async (cellAddress) => {
      const range = window.WPSOpenApi.Application.Range(cellAddress);
      return String(await Promise.resolve(range.Formula).catch(() => '') || '');
    }, targetCell));
    if (formula.includes('DISPIMG(')) {
      return formula;
    }
    await sleep(1000);
  }
  return formula;
}

function waitForCdpEvent(page, method, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      page.socket.removeEventListener('message', onMessage);
      rejectPromise(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);

    function onMessage(event) {
      const message = JSON.parse(event.data);
      if (message.method !== method) {
        return;
      }
      clearTimeout(timer);
      page.socket.removeEventListener('message', onMessage);
      resolvePromise(message.params);
    }

    page.socket.addEventListener('message', onMessage);
  });
}

async function clickText(page, text, options = {}) {
  const point = await findTextPoint(page, text, options);
  if (!point) {
    throw new Error(`Unable to find visible WPS menu item: ${text}`);
  }
  await page.click(point.x, point.y);
  await sleep(options.waitMs ?? 700);
}

async function hoverText(page, text, options = {}) {
  const point = await findTextPoint(page, text, options);
  if (!point) {
    throw new Error(`Unable to find visible WPS menu item: ${text}`);
  }
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
    buttons: 0,
  });
  await sleep(options.waitMs ?? 1000);
}

async function findTextPoint(page, text, options = {}) {
  const minX = options.minX ?? 0;
  const maxY = options.maxY ?? 9999;
  const exact = options.exact ?? true;
  return page.evaluate(browserFunction((targetText, targetMinX, targetMaxY, exactMatch) => {
    const candidates = [...document.querySelectorAll('button,div,span,a')]
      .filter((element) => {
        const elementText = (element.innerText || '').trim();
        return exactMatch ? elementText === targetText : elementText.includes(targetText);
      })
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.left >= targetMinX && rect.top <= targetMaxY)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const candidate = candidates[0];
    if (!candidate) {
      return null;
    }
    return {
      x: candidate.rect.left + candidate.rect.width / 2,
      y: candidate.rect.top + candidate.rect.height / 2,
    };
  }, text, minX, maxY, exact));
}

async function cleanupGeneratedLocalFiles(rows) {
  const imageDir = resolve(process.env.WPS_GENERATED_IMAGE_DIR || DEFAULT_GENERATED_IMAGE_DIR);
  const generatedExcelPath = resolve(process.env.WPS_GENERATED_EXCEL_PATH || DEFAULT_GENERATED_EXCEL_PATH);
  const payloadPath = resolve(process.env.WPS_APPEND_PAYLOAD || DEFAULT_PAYLOAD_PATH);
  const projectRoot = resolve('.');

  const imagePaths = new Set(
    rows
      .map((row) => row.imagePath)
      .filter(Boolean)
      .map((imagePath) => resolve(imagePath))
      .filter((imagePath) => imagePath.startsWith(imageDir)),
  );

  for (const imagePath of imagePaths) {
    await rm(imagePath, { force: true }).catch(() => {});
  }
  await removeEmptyDirectory(imageDir);

  for (const filePath of [generatedExcelPath, payloadPath]) {
    const resolved = resolve(filePath);
    if (resolved.startsWith(projectRoot)) {
      await rm(resolved, { force: true }).catch(() => {});
    }
  }

  console.log(`Cleaned generated local files: ${imagePaths.size} images, ${generatedExcelPath}, ${payloadPath}`);
}

async function removeEmptyDirectory(directoryPath) {
  const entries = await readdir(directoryPath).catch(() => null);
  if (entries && entries.length === 0) {
    await rm(directoryPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function closeTemporaryPage(page, pageInfo, cdpOrigin) {
  await page.send('Page.close').catch(() => {});
  await page.close().catch(() => {});
  if (pageInfo?.id) {
    await fetch(`${cdpOrigin}/json/close/${pageInfo.id}`).catch(() => {});
  }
}

async function setSystemClipboardText(text) {
  if (process.platform === 'darwin') {
    await writeToProcess('pbcopy', [], text);
    return;
  }

  if (process.platform === 'win32') {
    await writeToProcess(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Set-Clipboard -Value ([Console]::In.ReadToEnd())'],
      text,
    );
    return;
  }

  try {
    await writeToProcess('wl-copy', [], text);
  } catch {
    await writeToProcess('xclip', ['-selection', 'clipboard'], text);
  }
}

async function sendNativePasteShortcut() {
  if (process.platform === 'darwin') {
    await writeToProcess(
      'osascript',
      ['-e', 'tell application "Google Chrome" to activate', '-e', 'tell application "System Events" to keystroke "v" using command down'],
      '',
    );
    return;
  }

  if (process.platform === 'win32') {
    await writeToProcess(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        '$wshell = New-Object -ComObject wscript.shell; $wshell.AppActivate("Google Chrome") | Out-Null; Start-Sleep -Milliseconds 200; $wshell.SendKeys("^v")',
      ],
      '',
    );
    return;
  }

  await writeToProcess('xdotool', ['key', 'ctrl+v'], '');
}

async function sendNativeJumpToPreviousNonEmptyInColumn() {
  if (process.platform === 'darwin') {
    await writeToProcess(
      'osascript',
      ['-e', 'tell application "Google Chrome" to activate', '-e', 'tell application "System Events" to key code 126 using command down'],
      '',
    );
    return;
  }

  if (process.platform === 'win32') {
    await writeToProcess(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        '$wshell = New-Object -ComObject wscript.shell; $wshell.AppActivate("Google Chrome") | Out-Null; Start-Sleep -Milliseconds 200; $wshell.SendKeys("^{UP}")',
      ],
      '',
    );
    return;
  }

  await writeToProcess('xdotool', ['key', 'ctrl+Up'], '');
}

function writeToProcess(command, args, input) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${command} exited with code ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

async function focusNameBox(page) {
  const point = await page.evaluate(browserFunction(() => {
    const inputs = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')];
    const byValue = inputs.find((element) => /^[A-Z]{1,3}\d+$/.test(element.value || element.textContent || ''));
    const byPosition = inputs
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.left < 280 && rect.top > 170 && rect.top < 260 && rect.width > 40 && rect.height > 20)
      .sort((a, b) => a.rect.left - b.rect.left)[0]?.element;
    const target = byValue || byPosition;
    if (!target) {
      return null;
    }
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }));

  if (!point) {
    throw new Error('Unable to find WPS name box. Select any cell in the target sheet, then retry.');
  }
  await page.click(point.x, point.y);
  await sleep(300);
}

async function setNameBoxAddress(page, address) {
  const updated = await page.evaluate(browserFunction((targetAddress) => {
    const inputs = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')];
    const target = inputs
      .map((element) => ({ element, rect: element.getBoundingClientRect(), value: element.value || element.textContent || '' }))
      .filter(({ rect }) => rect.left < 280 && rect.top > 70 && rect.top < 140 && rect.width > 40 && rect.height > 20)
      .sort((a, b) => a.rect.left - b.rect.left)[0]?.element;
    if (!target) {
      return false;
    }

    target.focus();
    if ('value' in target) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value')?.set;
      setter?.call(target, targetAddress);
      if (!setter) target.value = targetAddress;
    } else {
      target.textContent = targetAddress;
    }
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: targetAddress }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, address));

  if (!updated) {
    throw new Error('Unable to find WPS name box. Select any cell in the target sheet, then retry.');
  }
  await sleep(300);
  await pressKey(page, 'Enter');
}

async function readSelectedCellAddress(page) {
  return page.evaluate(browserFunction(() => {
    const candidates = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')]
      .map((element) => (element.value || element.textContent || '').trim())
      .filter((value) => /^[A-Z]{1,3}\d+$/.test(value));
    return candidates[0] || '';
  }));
}

async function replaceFocusedText(page, text) {
  await pressShortcut(page, 'a', process.platform === 'darwin' ? { meta: true } : { control: true });
  await page.send('Input.insertText', { text });
}

async function pressPasteShortcut(page) {
  if (process.platform === 'darwin') {
    await pressShortcut(page, 'v', { meta: true });
    return;
  }
  await pressShortcut(page, 'v', { control: true });
}

async function sendCdpPasteCommand(page) {
  const modifiers = process.platform === 'darwin' ? 4 : 2;
  await page.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'v',
    code: 'KeyV',
    windowsVirtualKeyCode: 86,
    nativeVirtualKeyCode: 86,
    modifiers,
    commands: ['paste'],
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'v',
    code: 'KeyV',
    windowsVirtualKeyCode: 86,
    nativeVirtualKeyCode: 86,
    modifiers,
  });
}

async function sendCdpCopyCommand(page) {
  const modifiers = process.platform === 'darwin' ? 4 : 2;
  await page.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'c',
    code: 'KeyC',
    windowsVirtualKeyCode: 67,
    nativeVirtualKeyCode: 67,
    modifiers,
    commands: ['copy'],
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'c',
    code: 'KeyC',
    windowsVirtualKeyCode: 67,
    nativeVirtualKeyCode: 67,
    modifiers,
  });
}

async function pressShortcut(page, key, modifiers = {}) {
  const modifierKeys = [];
  if (modifiers.control) modifierKeys.push('Control');
  if (modifiers.meta) modifierKeys.push('Meta');
  if (modifiers.alt) modifierKeys.push('Alt');
  if (modifiers.shift) modifierKeys.push('Shift');
  const modifierValue = modifierMask(modifiers);

  for (const modifierKey of modifierKeys) {
    const normalized = normalizeKey(modifierKey);
    await page.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: normalized.key,
      code: normalized.code,
      windowsVirtualKeyCode: normalized.keyCode,
      nativeVirtualKeyCode: normalized.keyCode,
      modifiers: modifierValue,
    });
  }
  await pressKey(page, key, modifierValue);
  for (const modifierKey of modifierKeys.reverse()) {
    const normalized = normalizeKey(modifierKey);
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: normalized.key,
      code: normalized.code,
      windowsVirtualKeyCode: normalized.keyCode,
      nativeVirtualKeyCode: normalized.keyCode,
      modifiers: modifierValue,
    });
  }
}

function modifierMask(modifiers) {
  return (modifiers.alt ? 1 : 0) + (modifiers.control ? 2 : 0) + (modifiers.meta ? 4 : 0) + (modifiers.shift ? 8 : 0);
}

async function pressKey(page, key, modifiers = 0) {
  const normalized = normalizeKey(key);
  await page.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: normalized.key,
    code: normalized.code,
    windowsVirtualKeyCode: normalized.keyCode,
    nativeVirtualKeyCode: normalized.keyCode,
    modifiers,
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: normalized.key,
    code: normalized.code,
    windowsVirtualKeyCode: normalized.keyCode,
    nativeVirtualKeyCode: normalized.keyCode,
    modifiers,
  });
}

function normalizeKey(key) {
  const lower = key.toLowerCase();
  if (lower === 'enter') {
    return { key: 'Enter', code: 'Enter', keyCode: 13 };
  }
  if (lower === 'end') {
    return { key: 'End', code: 'End', keyCode: 35 };
  }
  if (lower === 'escape') {
    return { key: 'Escape', code: 'Escape', keyCode: 27 };
  }
  if (lower === 'arrowup') {
    return { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 };
  }
  if (lower === 'control') {
    return { key: 'Control', code: 'ControlLeft', keyCode: 17 };
  }
  if (lower === 'meta') {
    return { key: 'Meta', code: 'MetaLeft', keyCode: 91 };
  }
  if (lower === 'alt') {
    return { key: 'Alt', code: 'AltLeft', keyCode: 18 };
  }
  if (lower === 'shift') {
    return { key: 'Shift', code: 'ShiftLeft', keyCode: 16 };
  }
  const letter = lower.length === 1 ? lower : key;
  return { key: letter, code: `Key${letter.toUpperCase()}`, keyCode: letter.toUpperCase().charCodeAt(0) };
}

async function verifyPaste(page, firstRow) {
  return page.evaluate(browserFunction((row) => {
    const text = document.body?.innerText || '';
    const hasName = row.name ? text.includes(row.name) : true;
    const hasDate = row.date ? text.includes(row.date) : true;
    if (hasName && hasDate) {
      return 'first row is visible after paste';
    }
    return `could not verify visible first row; please check WPS manually`;
  }, firstRow));
}

function browserFunction(fn, ...args) {
  return `(${fn.toString()})(...${JSON.stringify(args)})`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
