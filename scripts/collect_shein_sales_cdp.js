import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, activateCdpPage, findCdpPage, getCdpOrigin } from './cdp_client.js';
import { parseHumanDelayConfig, randomHumanDelayMs } from './human_timing.js';
import { groupSheinDateRanges, parseSheinTargetDates } from './shein_date_ranges.js';

const SHEIN_HOSTS = new Set(['sso.geiwohuo.com', 'www.geiwohuo.com']);
const DEFAULT_HOME_URL = 'https://sso.geiwohuo.com/#/home';
const DEFAULT_DETAILS_URL = 'https://sso.geiwohuo.com/#/sbn/merchandise/details';

export async function collectSheinSales(env = process.env) {
  const cdpOrigin = getCdpOrigin(env);
  const homeUrl = env.SHEIN_HOME_URL || DEFAULT_HOME_URL;
  const detailsUrl = env.SHEIN_PRODUCT_DETAILS_URL || DEFAULT_DETAILS_URL;
  const loginTimeoutMs = parsePositiveMs(env.SHEIN_LOGIN_TIMEOUT_MS, 30 * 60 * 1000);
  const targetDates = parseSheinTargetDates(env);
  const dateRanges = groupSheinDateRanges(targetDates, 31);
  const humanDelay = parseHumanDelayConfig(env);
  const trendDelay = parseTrendDelay(env);
  const outputPath = resolve(env.SALES_DATA_JSON_PATH || 'output/shein-sales-data.json');

  console.log(`SHEIN target date(s): ${targetDates.join(', ')}`);
  console.log(
    `SHEIN date range(s): ${dateRanges.map((range) => `${range.start}..${range.end}`).join(', ')}`,
  );
  console.log('Checking the saved SHEIN Chrome session; waiting for manual login if needed...');
  await waitForSheinLogin(cdpOrigin, homeUrl, detailsUrl, loginTimeoutMs);

  await navigateSheinPage(cdpOrigin, homeUrl, detailsUrl);
  let page = await connectSheinPage(cdpOrigin, (url) => url.includes('#/sbn/merchandise/details'));
  try {
    await waitForProductList(page, 120000);
    await ensureFirstProductPage(page);
    const result = await collectAllProducts(page, {
      targetDates,
      dateRanges,
      humanDelay,
      trendDelay,
    });
    const payload = {
      source: 'SHEIN',
      collectedAt: new Date().toISOString(),
      targetDates,
      records: result.records,
      diagnostics: {
        expectedProducts: result.expectedProducts,
        visitedProducts: result.visitedProducts,
        uniqueCargoNumbers: result.records.length,
        pages: result.pages,
        expectedPages: result.expectedPages,
      },
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`Saved SHEIN sales data: ${outputPath}`);
    console.log(`Collected ${result.visitedProducts} product row(s) across ${result.pages} page(s).`);
    for (const record of result.records) {
      const values = record.salesByDate.map(({ date, sales }) => `${date}:${sales}`).join(', ');
      console.log(`SHEIN cargo ${record.skuCargoNo}: sales ${values}`);
    }
    return payload;
  } finally {
    await page.close();
  }
}

async function waitForSheinLogin(cdpOrigin, homeUrl, detailsUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = await findCdpPage(
      (item) => isAuthenticatedSheinUrl(item.url, homeUrl, detailsUrl),
      cdpOrigin,
    );
    if (target) {
      await activateCdpPage(target, cdpOrigin);
      console.log(`SHEIN login detected: ${target.url}`);
      return target;
    }
    await sleep(1000);
  }
  throw new Error('SHEIN login timed out before the authenticated home page was detected.');
}

async function navigateSheinPage(cdpOrigin, homeUrl, detailsUrl) {
  const target = await connectSheinPage(
    cdpOrigin,
    (url) => isAuthenticatedSheinUrl(url, homeUrl, detailsUrl),
  );
  try {
    await target.evaluate(`location.href = ${JSON.stringify(detailsUrl)}`);
  } catch (error) {
    if (!/navigated|closed|no longer open/i.test(error.message)) {
      throw error;
    }
  } finally {
    await target.close();
  }
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const pageTarget = await findCdpPage((item) => item.url.includes('#/sbn/merchandise/details'), cdpOrigin);
    if (pageTarget) {
      await activateCdpPage(pageTarget, cdpOrigin);
      return;
    }
    await sleep(500);
  }
  throw new Error(`SHEIN product details page did not load: ${detailsUrl}`);
}

async function connectSheinPage(cdpOrigin, predicate) {
  const target = await findCdpPage(
    (item) => isSheinUrl(item.url) && predicate(item.url),
    cdpOrigin,
  );
  if (!target) {
    throw new Error(`No SHEIN page is available at ${cdpOrigin}.`);
  }
  await activateCdpPage(target, cdpOrigin);
  return new CdpPage(target);
}

async function waitForProductList(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await inspectProductList(page);
    if (state.rows.length > 0) {
      console.log(`SHEIN product list detected with ${state.rows.length} visible row(s).`);
      return state;
    }
    await sleep(1000);
  }
  throw new Error('SHEIN product list did not render any rows within the allowed time.');
}

async function collectAllProducts(page, options) {
  const recordsByCargo = new Map();
  const seenPageSignatures = new Set();
  let visitedProducts = 0;
  let pageNumber = 0;
  let expectedProducts = null;
  let expectedPages = null;

  while (true) {
    pageNumber += 1;
    const state = await inspectProductList(page);
    if (!state.rows.length) {
      throw new Error(`SHEIN page ${pageNumber} contains no identifiable product rows.`);
    }
    const expectedRows = expectedRowsOnPage(
      state.currentPage,
      state.expectedProducts,
      state.pageSize,
    );
    if (expectedRows !== null && state.rows.length !== expectedRows) {
      throw new Error(
        `SHEIN page ${state.currentPage} was not stable: expected ${expectedRows} rows, ` +
        `but found ${state.rows.length}.`,
      );
    }
    if (state.expectedProducts !== null) {
      expectedProducts = state.expectedProducts;
    }
    if (state.totalPages !== null) {
      expectedPages = state.totalPages;
    }
    const signature = state.rows.map((row) => row.cargoNumber).join('|');
    if (seenPageSignatures.has(signature)) {
      throw new Error(`SHEIN pagination repeated page ${pageNumber}; collection stopped to prevent duplicates.`);
    }
    seenPageSignatures.add(signature);

    console.log(
      `Reading SHEIN product page ${state.currentPage}` +
      `${state.totalPages ? `/${state.totalPages}` : ''}: ${state.rows.length} row(s).`,
    );
    for (let index = 0; index < state.rows.length; index += 1) {
      const row = state.rows[index];
      visitedProducts += 1;
      if (recordsByCargo.has(row.cargoNumber)) {
        console.log(`Duplicate cargo ${row.cargoNumber}; reusing the verified sales result.`);
        continue;
      }
      await humanPause(`opening SHEIN trend ${index + 1}/${state.rows.length}`, options.humanDelay);
      await openTrendForCargo(page, row.cargoNumber);
      try {
        await verifyTrendCargo(page, row.cargoNumber);
        await trendRenderPause(options.trendDelay, 'waiting for SHEIN trend controls');
        await selectOnlySalesMetric(page);
        await trendRenderPause(options.trendDelay, 'waiting for SHEIN metric update');
        const salesByDate = {};
        for (const range of options.dateRanges) {
          await refreshTrendDateRange(page, range, options.trendDelay);
          const rangeValues = await readTrendSales(page, range);
          Object.assign(salesByDate, rangeValues);
        }
        const missingDates = options.targetDates.filter((date) => salesByDate[date] === undefined);
        if (missingDates.length) {
          throw new Error(
            `Trend for cargo ${row.cargoNumber} did not expose target date(s): ${missingDates.join(', ')}`,
          );
        }
        recordsByCargo.set(row.cargoNumber, {
          skuCargoNo: row.cargoNumber,
          skuCargoNos: [row.cargoNumber],
          salesByDate: options.targetDates.map((date) => ({
            date,
            sales: String(salesByDate[date]),
          })),
        });
        console.log(
          `Read SHEIN cargo ${row.cargoNumber}: ${options.targetDates
            .map((date) => `${date}:${salesByDate[date]}`)
            .join(', ')}`,
        );
      } finally {
        await closeTrendModal(page);
      }
      await humanPause(`finished SHEIN product ${index + 1}/${state.rows.length}`, options.humanDelay);
    }

    if (!state.hasNextPage) {
      break;
    }
    await humanPause('opening next SHEIN product page', options.humanDelay);
    await clickNextProductPage(page, signature, state.currentPage);
  }

  if (expectedProducts !== null && visitedProducts !== expectedProducts) {
    throw new Error(
      `SHEIN completeness check failed: page footer reports ${expectedProducts} products, but ${visitedProducts} rows were visited.`,
    );
  }
  if (expectedPages !== null && pageNumber !== expectedPages) {
    throw new Error(
      `SHEIN completeness check failed: pagination reports ${expectedPages} pages, ` +
      `but ${pageNumber} pages were visited.`,
    );
  }
  return {
    records: [...recordsByCargo.values()],
    expectedProducts,
    visitedProducts,
    pages: pageNumber,
    expectedPages,
  };
}

export async function inspectProductList(page) {
  const state = await page.evaluate(`(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const normalizeCargo = (value) => String(value || '').replace(/\\D/g, '');
    const rows = [];
    for (const element of document.querySelectorAll('tr, [role="row"], .ant-table-row')) {
      if (!visible(element)) continue;
      const text = element.innerText || '';
      if (!text.includes('供方货号') || !text.includes('查看趋势')) continue;
      const match = /供方货号[：:]\\s*([^\\s]+)/.exec(text);
      const cargoNumber = normalizeCargo(match?.[1]);
      if (!cargoNumber) continue;
      rows.push({ cargoNumber, text: text.slice(0, 500) });
    }
    const bodyText = document.body.innerText || '';
    const totalMatch = /共\\s*(\\d+)\\s*条/.exec(bodyText);
    const pagination = [...document.querySelectorAll('.soui-pagination, .ant-pagination')].find(visible);
    const paginationButtons = pagination ? [...pagination.querySelectorAll('button')].filter(visible) : [];
    const numberedButtons = paginationButtons
      .map((element) => ({
        page: /^\\d+$/.test((element.innerText || '').trim()) ? Number((element.innerText || '').trim()) : null,
        current: element.classList.contains('soui-button-primary') ||
          element.classList.contains('ant-pagination-item-active') || element.getAttribute('aria-current') === 'page',
      }))
      .filter((item) => item.page !== null);
    const currentPage = numberedButtons.find((item) => item.current)?.page || numberedButtons[0]?.page || 1;
    const pageSizeMatch = /(\\d+)\\s*\\/\\s*[^\\d\\s]+/.exec(pagination?.innerText || '');
    const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : null;
    const totalPages = totalMatch && pageSize ? Math.ceil(Number(totalMatch[1]) / pageSize) : null;
    const lastButton = paginationButtons.at(-1);
    const arrowNextEnabled = Boolean(lastButton && !lastButton.disabled &&
      lastButton.getAttribute('aria-disabled') !== 'true' &&
      !lastButton.classList.contains('ant-pagination-disabled'));
    return {
      rows,
      expectedProducts: totalMatch ? Number(totalMatch[1]) : null,
      currentPage,
      pageSize,
      totalPages,
      pageNumbers: numberedButtons.map((item) => item.page),
      arrowNextEnabled,
    };
  })()`);
  return {
    ...state,
    hasNextPage: paginationHasNextPage(
      state.currentPage,
      state.totalPages,
      state.pageNumbers,
      state.arrowNextEnabled,
    ),
  };
}

export function paginationHasNextPage(
  currentPage,
  totalPages,
  pageNumbers,
  arrowNextEnabled = false,
) {
  if (Number.isInteger(totalPages) && totalPages > 0) return currentPage < totalPages;
  return pageNumbers.includes(currentPage + 1) || Boolean(arrowNextEnabled);
}

export function expectedRowsOnPage(currentPage, totalProducts, pageSize) {
  if (!Number.isInteger(currentPage) || currentPage < 1 ||
      !Number.isInteger(totalProducts) || totalProducts < 0 ||
      !Number.isInteger(pageSize) || pageSize < 1) return null;
  const remaining = totalProducts - (currentPage - 1) * pageSize;
  return Math.max(0, Math.min(pageSize, remaining));
}

export async function ensureFirstProductPage(page) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await inspectProductList(page);
    const expectedRows = expectedRowsOnPage(1, state.expectedProducts, state.pageSize);
    if (state.currentPage <= 1 &&
        (expectedRows === null || state.rows.length === expectedRows)) return;
    if (state.currentPage <= 1) {
      await sleep(300);
      continue;
    }
    const previousSignature = state.rows.map((row) => row.cargoNumber).join('|');
    const clicked = await page.evaluate(`(() => {
      const visible = (element) => {
        const rect = element?.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const pagination = [...document.querySelectorAll('.soui-pagination, .ant-pagination')].find(visible);
      if (!pagination) return false;
      const buttons = [...pagination.querySelectorAll('button')].filter(visible);
      const firstPage = buttons.find((button) => (button.innerText || '').trim() === '1');
      const previous = firstPage || buttons.find((button) =>
        !/^\\d+$/.test((button.innerText || '').trim()) && !button.disabled
      );
      if (!previous) return false;
      previous.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Unable to return SHEIN pagination from page ${state.currentPage} to page 1.`);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const nextState = await inspectProductList(page);
      const signature = nextState.rows.map((row) => row.cargoNumber).join('|');
      const firstPageRows = expectedRowsOnPage(1, nextState.expectedProducts, nextState.pageSize);
      if (nextState.currentPage === 1 && signature && signature !== previousSignature &&
          (firstPageRows === null || nextState.rows.length === firstPageRows)) break;
      await sleep(300);
    }
  }
  throw new Error('SHEIN product pagination did not return to page 1.');
}

async function openTrendForCargo(page, cargoNumber) {
  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const scrolled = await page.evaluate(`(() => {
      const cargo = ${JSON.stringify(cargoNumber)};
      const normalize = (value) => String(value || '').replace(/\\D/g, '');
      const row = [...document.querySelectorAll('tr, [role="row"], .ant-table-row')].find((element) => {
        const match = /供方货号[：:]\\s*([^\\s]+)/.exec(element.innerText || '');
        return normalize(match?.[1]) === cargo;
      });
      if (!row) return { ok: false, reason: 'row-not-found' };
      const button = [...row.querySelectorAll('button, a, span')].find((element) =>
        (element.innerText || '').trim() === '查看趋势'
      );
      if (!button) return { ok: false, reason: 'trend-button-not-found' };
      button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      return { ok: true };
    })()`);
    if (!scrolled?.ok) {
      throw new Error(`Unable to open SHEIN trend for cargo ${cargoNumber}: ${scrolled?.reason || 'unknown'}`);
    }

    await sleep(500);
    const control = await page.evaluate(`(() => {
      const cargo = ${JSON.stringify(cargoNumber)};
      const normalize = (value) => String(value || '').replace(/\\D/g, '');
      const row = [...document.querySelectorAll('tr, [role="row"], .ant-table-row')].find((element) => {
        const match = /供方货号[：:]\\s*([^\\s]+)/.exec(element.innerText || '');
        return normalize(match?.[1]) === cargo;
      });
      if (!row) return { ok: false, reason: 'row-disappeared-after-scroll' };
      const button = [...row.querySelectorAll('button, a, span')].find((element) =>
        (element.innerText || '').trim() === '查看趋势'
      );
      if (!button) return { ok: false, reason: 'trend-button-disappeared-after-scroll' };
      const rect = button.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      if (rect.width <= 0 || rect.height <= 0 || x < 0 || x > innerWidth || y < 0 || y > innerHeight) {
        return { ok: false, reason: 'trend-button-outside-viewport', rect: rect.toJSON?.() };
      }
      const hit = document.elementFromPoint(x, y);
      if (!hit || (!button.contains(hit) && !hit.contains(button))) {
        return {
          ok: false,
          reason: 'trend-button-obscured',
          hitText: (hit?.innerText || '').trim().slice(0, 80),
          hitClass: String(hit?.className || '').slice(0, 120),
        };
      }
      return { ok: true, x, y };
    })()`);
    if (!control?.ok) {
      lastReason = control?.reason || 'unknown';
      console.log(`SHEIN trend click attempt ${attempt}/3 for cargo ${cargoNumber} was not ready: ${lastReason}.`);
      await sleep(750);
      continue;
    }

    await page.click(control.x, control.y);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const open = await hasTrendModal(page);
      if (open) return;
      await sleep(250);
    }
    lastReason = 'modal-did-not-open-after-click';
    console.log(`SHEIN trend click attempt ${attempt}/3 for cargo ${cargoNumber} did not open the modal; retrying.`);
  }
  throw new Error(`SHEIN trend modal did not open for cargo ${cargoNumber}: ${lastReason}.`);
}

async function verifyTrendCargo(page, cargoNumber) {
  const modalCargo = await page.evaluate(`(() => {
    const visible = (element) => {
      const rect = element?.getBoundingClientRect();
      const style = element ? getComputedStyle(element) : null;
      return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
    };
    const modal = [...document.querySelectorAll('.soui-modal-panel, [role="dialog"], .ant-modal, .el-dialog')]
      .find((element) => {
        if (!visible(element)) return false;
        const text = element.innerText || '';
        const title = element.querySelector('.soui-modal-header-title')?.textContent?.trim();
        return (title === '趋势图' || text.includes('趋势图')) && text.includes('统计时间') && text.includes('统计指标');
      });
    const match = /供方货号[：:]\\s*([^\\s]+)/.exec(modal?.innerText || '');
    return String(match?.[1] || '').replace(/\\D/g, '');
  })()`);
  if (modalCargo !== cargoNumber) {
    throw new Error(`SHEIN trend identity mismatch: expected cargo ${cargoNumber}, found ${modalCargo || 'none'}.`);
  }
}

async function selectOnlySalesMetric(page) {
  let maximumAttempts = 40;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const state = await inspectMetricCheckboxes(page);
    if (!state.modalFound) {
      throw new Error('Unable to select only SHEIN sales metric: modal-not-found');
    }
    if (!state.items.some((item) => item.name === '销量')) {
      throw new Error('Unable to select only SHEIN sales metric: sales-checkbox-not-found');
    }
    maximumAttempts = Math.max(maximumAttempts, state.items.length * 2);
    const incorrect = state.items.find((item) => item.checked !== (item.name === '销量'));
    if (!incorrect) {
      console.log(`Verified SHEIN trend metric selection: 销量 only (1/${state.items.length}).`);
      return;
    }
    await page.click(incorrect.x, incorrect.y);
    const expectedChecked = incorrect.name === '销量';
    const changed = await waitForMetricState(page, incorrect.name, expectedChecked, 3000);
    if (!changed) {
      throw new Error(`SHEIN metric checkbox did not change state: ${incorrect.name}`);
    }
  }
  throw new Error('Unable to make 销量 the only selected SHEIN trend metric.');
}

async function waitForMetricState(page, name, checked, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await inspectMetricCheckboxes(page);
    const item = state.items.find((candidate) => candidate.name === name);
    if (item?.checked === checked) return true;
    await sleep(150);
  }
  return false;
}

async function hasTrendModal(page) {
  return page.evaluate(`(() => {
    const visible = (element) => {
      const rect = element?.getBoundingClientRect();
      const style = element ? getComputedStyle(element) : null;
      return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
    };
    return [...document.querySelectorAll('.soui-modal-panel, [role="dialog"], .ant-modal, .el-dialog')]
      .some((element) => {
        if (!visible(element)) return false;
        const text = element.innerText || '';
        const title = element.querySelector('.soui-modal-header-title')?.textContent?.trim();
        return (title === '趋势图' || text.includes('趋势图')) && text.includes('统计时间') && text.includes('统计指标');
      });
  })()`);
}

async function inspectMetricCheckboxes(page) {
  return page.evaluate(`(() => {
    const visible = (element) => {
      const rect = element?.getBoundingClientRect();
      const style = element ? getComputedStyle(element) : null;
      return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
    };
    const modal = [...document.querySelectorAll('.soui-modal-panel, [role="dialog"], .ant-modal, .el-dialog')]
      .find((element) => {
        if (!visible(element)) return false;
        const text = element.innerText || '';
        return text.includes('趋势图') && text.includes('统计时间') && text.includes('统计指标');
      });
    if (!modal) return { modalFound: false, items: [] };
    const items = [...modal.querySelectorAll('.soui-checkbox-wrapper, label')]
      .map((wrapper) => {
        const input = wrapper.querySelector('input[type="checkbox"]');
        const desc = wrapper.querySelector('.soui-checkbox-desc, [data-soui-role="desc"]');
        const indicator = wrapper.querySelector('[data-soui-role="checkbox-indicator"], .soui-checkbox-indicator-wrapper');
        const name = (desc?.textContent || wrapper.innerText || '').trim();
        if (!input || !name || !visible(wrapper)) return null;
        const rect = (visible(indicator) ? indicator : wrapper).getBoundingClientRect();
        return {
          name,
          checked: Boolean(input.checked || wrapper.classList.contains('soui-checkbox-wrapper-checked')),
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        };
      })
      .filter(Boolean)
      .filter((item, index, all) => all.findIndex((candidate) => candidate.name === item.name) === index);
    return { modalFound: true, items };
  })()`);
}

async function openTrendDatePicker(page, placeholder) {
  const pickerWasOpen = await isDatePickerOpen(page);

  const input = await page.evaluate(`(() => {
    const placeholder = ${JSON.stringify(placeholder)};
    const visible = (element) => {
      const rect = element?.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const modal = [...document.querySelectorAll('.soui-modal-panel, [role="dialog"], .ant-modal, .el-dialog')]
      .find((element) => visible(element) && (element.innerText || '').includes('趋势图') &&
        (element.innerText || '').includes('统计时间'));
    const target = modal ? [...modal.querySelectorAll('input')].find((element) =>
      visible(element) && element.placeholder === placeholder
    ) : null;
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    const result = target.closest('.soui-datePicker-result-text');
    const resultRect = result?.getBoundingClientRect();
    return {
      input: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      result: resultRect && resultRect.width > 0 && resultRect.height > 0
        ? { x: resultRect.x + resultRect.width / 2, y: resultRect.y + resultRect.height / 2 }
        : null,
    };
  })()`);
  if (!input) {
    throw new Error(`SHEIN trend ${placeholder} input was not found.`);
  }

  if (pickerWasOpen) {
    await page.click(input.input.x, input.input.y);
    await sleep(500);
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      if (await isDatePickerOpen(page)) {
        const activePlaceholder = await activeTrendDateInputPlaceholder(page);
        if (activePlaceholder === placeholder) return;
      }
      await sleep(150);
    }
    throw new Error(`SHEIN trend date picker did not activate ${placeholder}.`);
  }

  const clickPoints = [input.input, input.result, input.input].filter(Boolean);
  for (const point of clickPoints) {
    await focusTrendDateInput(page, placeholder);
    await sleep(300);
    await page.click(point.x, point.y);
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      if (await isDatePickerOpen(page)) {
        await sleep(350);
        return;
      }
      await sleep(200);
    }
  }

  // The SHEIN control may ignore a CDP click while React is finishing a rerender.
  // Re-target the live input and dispatch its normal mouse sequence as a final retry.
  const dispatched = await page.evaluate(`(() => {
    const placeholder = ${JSON.stringify(placeholder)};
    const visible = (element) => {
      const rect = element?.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const modal = [...document.querySelectorAll('.soui-modal-panel, [role="dialog"], .ant-modal, .el-dialog')]
      .find((element) => visible(element) && (element.innerText || '').includes('趋势图') &&
        (element.innerText || '').includes('统计时间'));
    const target = modal ? [...modal.querySelectorAll('input')].find((element) =>
      visible(element) && element.placeholder === placeholder
    ) : null;
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.focus({ preventScroll: true });
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const EventClass = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      target.dispatchEvent(new EventClass(type, { bubbles: true, cancelable: true, view: window }));
    }
    return true;
  })()`);
  if (dispatched) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await isDatePickerOpen(page)) {
        await sleep(350);
        return;
      }
      await sleep(200);
    }
  }
  throw new Error(`SHEIN trend date picker did not open from ${placeholder}.`);
}

async function focusTrendDateInput(page, placeholder) {
  return page.evaluate(`(() => {
    const placeholder = ${JSON.stringify(placeholder)};
    const visible = (element) => {
      const rect = element?.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const modal = [...document.querySelectorAll('.soui-modal-panel, [role="dialog"], .ant-modal, .el-dialog')]
      .find((element) => visible(element) && (element.innerText || '').includes('趋势图') &&
        (element.innerText || '').includes('统计时间'));
    const target = modal ? [...modal.querySelectorAll('input')].find((element) =>
      visible(element) && element.placeholder === placeholder
    ) : null;
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.focus({ preventScroll: true });
    return true;
  })()`);
}

async function isDatePickerOpen(page) {
  return page.evaluate(`(() => [...document.querySelectorAll('.soui-datePicker-picker')]
    .some((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }))()`);
}

async function closeTrendDatePicker(page) {
  if (!await isDatePickerOpen(page)) return;
  const dismissPoint = await page.evaluate(`(() => {
    const visible = (element) => {
      const rect = element?.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const modal = [...document.querySelectorAll('.soui-modal-panel, [role="dialog"], .ant-modal, .el-dialog')]
      .find((element) => visible(element) && (element.innerText || '').includes('趋势图') &&
        (element.innerText || '').includes('统计时间'));
    const header = modal?.querySelector('.soui-modal-header, .ant-modal-header') || modal;
    if (!header) return null;
    const rect = header.getBoundingClientRect();
    return { x: rect.x + Math.min(120, rect.width / 3), y: rect.y + Math.min(24, rect.height / 2) };
  })()`);
  if (!dismissPoint) {
    throw new Error('SHEIN trend date picker could not find a safe dismiss point.');
  }
  await page.click(dismissPoint.x, dismissPoint.y);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!await isDatePickerOpen(page)) return;
    await sleep(150);
  }
  throw new Error('SHEIN trend date picker remained open after clicking the modal header.');
}

async function activeTrendDateInputPlaceholder(page) {
  return page.evaluate(`(() => {
    const active = document.activeElement;
    return active instanceof HTMLInputElement ? active.placeholder || '' : '';
  })()`);
}

async function waitForTrendDateInputValue(page, placeholder, expectedValue, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await page.evaluate(`(() => {
      const placeholder = ${JSON.stringify(placeholder)};
      const input = [...document.querySelectorAll('input')].find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && element.placeholder === placeholder;
      });
      return input?.value || '';
    })()`);
    if (value === expectedValue) return true;
    await sleep(150);
  }
  return false;
}

async function inspectDatePicker(page) {
  return page.evaluate(`(() => {
    const visible = (element) => {
      const rect = element?.getBoundingClientRect();
      const style = element ? getComputedStyle(element) : null;
      return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
    };
    const center = (element) => {
      if (!visible(element)) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    };
    const normalizeMonth = (year, month) => {
      let normalizedYear = year;
      let normalizedMonth = month;
      while (normalizedMonth < 1) {
        normalizedMonth += 12;
        normalizedYear -= 1;
      }
      while (normalizedMonth > 12) {
        normalizedMonth -= 12;
        normalizedYear += 1;
      }
      return { year: normalizedYear, month: normalizedMonth };
    };
    return [...document.querySelectorAll('.soui-datePicker-picker')]
      .filter(visible)
      .map((panel, index) => {
        const infos = [...panel.querySelectorAll('.soui-datePicker-picker-header-info')]
          .map((element) => (element.textContent || '').trim());
        const headerText = infos.join(' ') || panel.querySelector('.soui-datePicker-picker-header-mid')?.textContent || '';
        const year = Number((/20\\d{2}/.exec(headerText) || [])[0]);
        const monthMatches = [...headerText.matchAll(/(\\d{1,2})\s*月/g)];
        const month = Number(monthMatches.at(-1)?.[1] || infos.map((value) => /^(\\d{1,2})/.exec(value)?.[1]).filter(Boolean).at(-1));
        const left = [...panel.querySelectorAll('.soui-datePicker-picker-header-left .soui-datePicker-picker-header-icon')];
        const right = [...panel.querySelectorAll('.soui-datePicker-picker-header-right .soui-datePicker-picker-header-icon')];
        const days = [...panel.querySelectorAll('td.soui-datePicker-picker-cell')]
          .filter((cell) => visible(cell) && !cell.classList.contains('soui-datePicker-picker-cell-disabled'))
          .map((cell) => {
            const day = Number((cell.textContent || '').trim());
            const bound = cell.classList.contains('soui-datePicker-picker-cell-bound');
            let actual = { year, month };
            if (bound && day > 20) actual = normalizeMonth(year, month - 1);
            if (bound && day < 15) actual = normalizeMonth(year, month + 1);
            return { day, year: actual.year, month: actual.month, bound, ...center(cell) };
          });
        return {
          index,
          title: (panel.querySelector('.soui-datePicker-picker-title')?.textContent || '').trim(),
          year,
          month,
          previousMonth: center(left[1] || left[0]),
          nextMonth: center(right[0] || right[1]),
          days,
        };
      });
  })()`);
}

async function moveDatePickerStartMonth(page, targetDate) {
  const target = parseIsoDateParts(targetDate);
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const panels = await inspectDatePicker(page);
    const panel = panels.find((item) => item.title === '开始时间') || panels[0];
    if (!panel || !panel.year || !panel.month) {
      throw new Error(`SHEIN date picker month could not be read for ${targetDate}.`);
    }
    const delta = monthIndex(target) - monthIndex(panel);
    if (delta === 0) return;
    const control = delta < 0 ? panel.previousMonth : panel.nextMonth;
    if (!control) throw new Error('SHEIN date picker month navigation control was not found.');
    await page.click(control.x, control.y);
    await sleep(250);
  }
  throw new Error(`SHEIN date picker could not navigate to ${targetDate}.`);
}

async function ensureDatePickerMonthVisible(page, targetDate) {
  return ensureDatePickerDateAvailable(page, targetDate, '结束时间');
}

async function ensureDatePickerDateAvailable(page, targetDate, panelTitle) {
  const target = parseIsoDateParts(targetDate);
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const panels = await inspectDatePicker(page);
    const preferred = panels.find((item) => item.title === panelTitle) || panels[0];
    if (preferred?.days.some((day) =>
      day.year === target.year && day.month === target.month && day.day === target.day
    )) return;
    if (!preferred || !preferred.year || !preferred.month) {
      throw new Error(`SHEIN date picker month could not be read for ${targetDate}.`);
    }
    const delta = monthIndex(target) - monthIndex(preferred);
    if (delta === 0) {
      throw new Error(
        `SHEIN date picker shows the correct month for ${targetDate}, ` +
        `but that date is disabled or unavailable in ${panelTitle}.`,
      );
    }
    const control = delta < 0 ? preferred.previousMonth : preferred.nextMonth;
    if (!control) throw new Error('SHEIN date picker month navigation control was not found.');
    await page.click(control.x, control.y);
    await sleep(250);
  }
  throw new Error(`SHEIN date picker could not expose ${targetDate}.`);
}

async function clickDatePickerDay(page, targetDate, panelTitle) {
  const target = parseIsoDateParts(targetDate);
  const panels = await inspectDatePicker(page);
  const preferred = panels.find((item) => item.title === panelTitle);
  const candidates = preferred ? [preferred] : panels;
  const day = candidates.flatMap((panel) => panel.days).find((item) =>
    item.year === target.year && item.month === target.month && item.day === target.day
  );
  if (!day) {
    throw new Error(`SHEIN date picker day ${targetDate} was not available in ${panelTitle}.`);
  }
  await page.click(day.x, day.y);
}

function parseIsoDateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid SHEIN ISO date: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function monthIndex(value) {
  return value.year * 12 + value.month;
}

async function setTrendDateRange(page, start, end) {
  const expectedStart = start.replaceAll('-', '/');
  const expectedEnd = end.replaceAll('-', '/');
  let lastValues = await readVisibleRangeValues(page);
  if (lastValues.start === expectedStart && lastValues.end === expectedEnd) {
    console.log(`SHEIN trend date range already selected: ${start}..${end}.`);
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await closeTrendDatePicker(page);
    await openTrendDatePicker(page, '开始时间');
    await moveDatePickerStartMonth(page, start);
    await ensureDatePickerDateAvailable(page, start, '开始时间');
    await clickDatePickerDay(page, start, '开始时间');
    if (!await waitForTrendDateInputValue(page, '开始时间', expectedStart)) {
      throw new Error(`SHEIN start date did not commit after selecting ${start}.`);
    }

    await openTrendDatePicker(page, '结束时间');
    await ensureDatePickerDateAvailable(page, end, '结束时间');
    await clickDatePickerDay(page, end, '结束时间');

    if (!await waitForTrendDateInputValue(page, '结束时间', expectedEnd)) {
      throw new Error(`SHEIN end date did not commit after selecting ${end}.`);
    }

    const pickerDeadline = Date.now() + 5000;
    while (Date.now() < pickerDeadline && await isDatePickerOpen(page)) {
      await sleep(150);
    }
    if (await isDatePickerOpen(page)) {
      throw new Error(`SHEIN date range ${start}..${end} did not finish after selecting the end date.`);
    }

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      lastValues = await readVisibleRangeValues(page);
      if (lastValues.start === expectedStart && lastValues.end === expectedEnd) {
        return;
      }
      await sleep(250);
    }

    console.log(
      `SHEIN trend date attempt ${attempt}/3 did not commit ${start}..${end}; ` +
      `current values are ${lastValues.start || '<blank>'}..${lastValues.end || '<blank>'}.`,
    );
    await closeTrendDatePicker(page);
  }
  throw new Error(
    `SHEIN trend date range did not update to ${start}..${end}; ` +
    `last values were ${lastValues.start || '<blank>'}..${lastValues.end || '<blank>'}.`,
  );
}

async function refreshTrendDateRange(page, range, trendDelay) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const currentValues = await readVisibleRangeValues(page);
      const alreadyShowsTarget = visibleRangeMatches(currentValues, range.start, range.end);
      if (alreadyShowsTarget || attempt > 1) {
        const refreshRange = buildTrendRefreshRangeOutsideCurrent(
          range.start,
          range.end,
          currentValues,
          attempt,
        );
        console.log(
          `Refreshing SHEIN trend chart with temporary range ` +
          `${refreshRange.start}..${refreshRange.end} before ${range.start}..${range.end}.`,
        );
        await setTrendDateRange(page, refreshRange.start, refreshRange.end);
        await trendRenderPause(trendDelay);
        await waitForTrendChartRange(page, { ...refreshRange, dates: [refreshRange.start] }, 12000);
      } else {
        console.log(
          `SHEIN trend inputs show ${currentValues.start || '<blank>'}..${currentValues.end || '<blank>'}; ` +
          `selecting target ${range.start}..${range.end} directly.`,
        );
      }

      await setTrendDateRange(page, range.start, range.end);
      await trendRenderPause(trendDelay);
      await waitForTrendChartRange(page, range, 12000);
      console.log(`Verified SHEIN chart range: ${range.start}..${range.end}.`);
      return;
    } catch (error) {
      lastError = error;
      console.log(
        `SHEIN chart refresh attempt ${attempt}/3 failed for ${range.start}..${range.end}: ` +
        `${error.message}`,
      );
      await closeTrendDatePicker(page);
    }
  }
  throw new Error(
    `SHEIN trend chart did not refresh to ${range.start}..${range.end}: ` +
    `${lastError?.message || 'unknown error'}`,
  );
}

async function waitForTrendChartRange(page, range, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let observedDates = [];
  while (Date.now() < deadline) {
    observedDates = await readTrendChartDates(page);
    if (trendChartMatchesRange(observedDates, range.start, range.end)) {
      return observedDates;
    }
    const hovered = await readAllChartPointsByHover(page, range.dates.length);
    observedDates = Object.keys(hovered).sort();
    if (trendChartMatchesRange(observedDates, range.start, range.end)) {
      return observedDates;
    }
    await sleep(500);
  }
  const inputs = await readVisibleRangeValues(page);
  throw new Error(
    `chart axis stayed at [${observedDates.join(', ') || 'no dates'}] while inputs showed ` +
    `${inputs.start || '<blank>'}..${inputs.end || '<blank>'}`,
  );
}

async function readTrendChartDates(page) {
  return page.evaluate(`(() => {
    const visible = (element) => {
      const rect = element?.getBoundingClientRect();
      const style = element ? getComputedStyle(element) : null;
      return Boolean(rect && rect.width > 0 && rect.height > 0 &&
        style?.display !== 'none' && style?.visibility !== 'hidden');
    };
    const normalizeDate = (value) => {
      const match = /(20\\d{2})[/-](\\d{1,2})[/-](\\d{1,2})/.exec(String(value || ''));
      return match
        ? match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0')
        : null;
    };
    const modal = [...document.querySelectorAll('.soui-modal-panel, [role="dialog"], .ant-modal, .el-dialog')]
      .find((element) => visible(element) && (element.innerText || '').includes('趋势图') &&
        (element.innerText || '').includes('统计指标'));
    if (!modal) return [];
    const charts = [...modal.querySelectorAll('svg')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return visible(element) && rect.width >= 300 && rect.height >= 120;
      })
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return bRect.width * bRect.height - aRect.width * aRect.height;
      });
    const chart = charts[0];
    if (!chart) return [];
    return [...new Set([...chart.querySelectorAll('text')]
      .map((element) => normalizeDate(element.textContent))
      .filter(Boolean))].sort();
  })()`);
}

export function buildTrendRefreshRange(start, end, attempt = 1) {
  const startDate = parseIsoDate(start);
  const endDate = parseIsoDate(end);
  const offsetDays = Math.max(1, Number(attempt) || 1);
  return {
    start: formatIsoDate(addUtcDays(startDate, -offsetDays)),
    end: formatIsoDate(addUtcDays(endDate, -offsetDays)),
  };
}

export function buildTrendRefreshRangeOutsideCurrent(start, end, currentValues, attempt = 1) {
  const currentStart = normalizeIsoDate(currentValues?.start);
  if (!currentStart) {
    const fallback = buildTrendRefreshRange(start, end, attempt);
    return { start: fallback.start, end: fallback.start };
  }
  const offsetDays = Math.max(1, Number(attempt) || 1);
  const temporaryDate = formatIsoDate(addUtcDays(parseIsoDate(currentStart), -offsetDays));
  return { start: temporaryDate, end: temporaryDate };
}

export function trendChartMatchesRange(observedDates, start, end) {
  const dates = [...new Set((observedDates || []).map(normalizeIsoDate).filter(Boolean))].sort();
  if (!dates.length) return false;
  if (start === end) {
    return dates.length === 1 && dates[0] === start;
  }
  return dates.every((date) => date >= start && date <= end) &&
    dates.includes(start) && dates.includes(end);
}

function normalizeIsoDate(value) {
  const match = /^(20\d{2})[/-](\d{1,2})[/-](\d{1,2})$/.exec(String(value || '').trim());
  return match
    ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
    : null;
}

function parseIsoDate(value) {
  const normalized = normalizeIsoDate(value);
  if (!normalized) throw new Error(`Invalid SHEIN ISO date: ${value}`);
  return new Date(`${normalized}T00:00:00.000Z`);
}

function addUtcDays(value, days) {
  return new Date(value.getTime() + days * 86400000);
}

function formatIsoDate(value) {
  return value.toISOString().slice(0, 10);
}

async function readVisibleRangeValues(page) {
  return page.evaluate(`(() => {
    const modal = [...document.querySelectorAll('.soui-modal-panel, [role="dialog"], .ant-modal, .el-dialog')]
      .find((element) => {
        const rect = element.getBoundingClientRect();
        const text = element.innerText || '';
        return rect.width > 0 && rect.height > 0 && text.includes('趋势图') && text.includes('统计时间');
      });
    if (!modal) return { start: '', end: '' };
    const inputs = [...modal.querySelectorAll('input')];
    return {
      start: inputs.find((input) => input.placeholder === '开始时间')?.value || '',
      end: inputs.find((input) => input.placeholder === '结束时间')?.value || '',
    };
  })()`);
}

async function readTrendSales(page, range) {
  const direct = await readEchartsOption(page, range.dates);
  if (Object.keys(direct).length === range.dates.length) {
    return direct;
  }
  const hovered = await readChartByHover(page, range.dates);
  return { ...direct, ...hovered };
}

async function readEchartsOption(page, dates) {
  return page.evaluate(`(() => {
    const requested = ${JSON.stringify(dates)};
    const normalizeDate = (value) => String(value || '').replaceAll('/', '-').slice(0, 10);
    const modal = [...document.querySelectorAll('.soui-modal-panel, [role="dialog"], .ant-modal, .el-dialog')]
      .find((element) => {
        const rect = element.getBoundingClientRect();
        const text = element.innerText || '';
        return rect.width > 0 && rect.height > 0 && text.includes('趋势图') && text.includes('统计指标');
      });
    if (!modal || !window.echarts?.getInstanceByDom) return {};
    for (const canvas of modal.querySelectorAll('canvas')) {
      const instance = window.echarts.getInstanceByDom(canvas.parentElement) || window.echarts.getInstanceByDom(canvas);
      if (!instance) continue;
      const option = instance.getOption();
      const categories = option.xAxis?.[0]?.data || [];
      const series = (option.series || []).find((item) => String(item.name || '').trim() === '销量');
      if (!series || !categories.length) continue;
      const result = {};
      categories.forEach((category, index) => {
        const date = normalizeDate(category);
        if (!requested.includes(date)) return;
        const raw = series.data?.[index];
        const value = typeof raw === 'object' ? raw.value : raw;
        const number = Number(value);
        if (Number.isFinite(number)) result[date] = number;
      });
      return result;
    }
    return {};
  })()`);
}

async function readChartByHover(page, dates) {
  const allPoints = await readAllChartPointsByHover(page, dates.length);
  return Object.fromEntries(
    Object.entries(allPoints).filter(([date]) => dates.includes(date)),
  );
}

function visibleRangeMatches(values, start, end) {
  return normalizeIsoDate(values?.start) === start && normalizeIsoDate(values?.end) === end;
}

async function readAllChartPointsByHover(page, expectedPointCount = 1) {
  const chart = await page.evaluate(`(() => {
    const modal = [...document.querySelectorAll('.soui-modal-panel, [role="dialog"], .ant-modal, .el-dialog')]
      .find((element) => {
        const rect = element.getBoundingClientRect();
        const text = element.innerText || '';
        return rect.width > 0 && rect.height > 0 && text.includes('趋势图') && text.includes('统计指标');
      });
    const charts = modal ? [...modal.querySelectorAll('canvas, svg')].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width >= 300 && rect.height >= 120;
    }) : [];
    const chart = charts.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return bRect.width * bRect.height - aRect.width * aRect.height;
    })[0];
    if (!chart) return null;
    const rect = chart.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`);
  if (!chart) {
    throw new Error('SHEIN sales chart canvas or SVG was not found.');
  }
  const result = {};
  const samples = Math.max(40, expectedPointCount * 8);
  for (let index = 0; index <= samples; index += 1) {
    const x = chart.x + chart.width * (0.04 + (0.92 * index) / samples);
    const y = chart.y + chart.height * 0.55;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await sleep(40);
    const tooltip = await page.evaluate(`(() => {
      const modal = [...document.querySelectorAll('.soui-modal-panel, [role="dialog"], .ant-modal, .el-dialog')]
        .find((element) => {
          const rect = element.getBoundingClientRect();
          const text = element.innerText || '';
          return rect.width > 0 && rect.height > 0 && text.includes('趋势图') && text.includes('统计指标');
        });
      if (!modal) return '';
      const candidates = [...document.querySelectorAll('div')].filter((element) => {
        const rect = element.getBoundingClientRect();
        const text = element.innerText || '';
        return rect.width > 0 && rect.height > 0 && /\\d{4}[/-]\\d{2}[/-]\\d{2}/.test(text) && text.includes('销量');
      });
      return candidates.sort((a, b) => a.innerText.length - b.innerText.length)[0]?.innerText || '';
    })()`);
    const parsed = parseSalesTooltip(tooltip);
    if (parsed) {
      result[parsed.date] = parsed.sales;
    }
  }
  return result;
}

export function parseSalesTooltip(text) {
  const dateMatch = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(String(text || ''));
  const salesMatch = /销量\s*([\d,]+(?:\.\d+)?)/.exec(String(text || ''));
  if (!dateMatch || !salesMatch) {
    return null;
  }
  return {
    date: `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`,
    sales: Number(salesMatch[1].replaceAll(',', '')),
  };
}

async function closeTrendModal(page) {
  await closeTrendDatePicker(page);
  if (!await hasTrendModal(page)) return;
  const control = await page.evaluate(`(() => {
    const visible = (element) => {
      const rect = element?.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const modal = [...document.querySelectorAll('.soui-modal-panel, [role="dialog"], .ant-modal, .el-dialog')]
      .find((element) => visible(element) && (element.innerText || '').includes('趋势图') &&
        (element.innerText || '').includes('统计指标'));
    if (!modal) return null;
    const button = modal.querySelector('.soui-modal-header-close') ||
      [...modal.querySelectorAll('button, span')].find((element) =>
        visible(element) && (['关闭', '×'].includes((element.innerText || '').trim()) ||
          /close/i.test([element.getAttribute('aria-label'), element.className].filter(Boolean).join(' ')))
      );
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  if (!control) {
    const closed = await page.evaluate(`(() => {
      const visible = (element) => {
        const rect = element?.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const modal = [...document.querySelectorAll('.soui-modal-panel, [role="dialog"], .ant-modal, .el-dialog')]
        .find((element) => visible(element) && (element.innerText || '').includes('趋势图') &&
          (element.innerText || '').includes('统计指标'));
      const button = modal?.querySelector('.soui-modal-header-close');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!closed) throw new Error('Unable to close the active SHEIN trend modal.');
  } else {
    await page.click(control.x, control.y);
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const open = await hasTrendModal(page);
    if (!open) {
      await sleep(400);
      return;
    }
    await sleep(200);
  }
  throw new Error('SHEIN trend modal remained open after the close action.');
}

export async function clickNextProductPage(page, previousSignature, previousPage) {
  const clicked = await page.evaluate(`(() => {
    const visible = (element) => {
      const rect = element?.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const pagination = [...document.querySelectorAll('.soui-pagination, .ant-pagination')].find(visible);
    if (!pagination) return false;
    const buttons = [...pagination.querySelectorAll('button')].filter(visible);
    const numbered = buttons
      .map((element) => ({
        element,
        page: /^\\d+$/.test((element.innerText || '').trim()) ? Number((element.innerText || '').trim()) : null,
        current: element.classList.contains('soui-button-primary') ||
          element.classList.contains('ant-pagination-item-active') || element.getAttribute('aria-current') === 'page',
      }))
      .filter((item) => item.page !== null);
    const currentPage = numbered.find((item) => item.current)?.page || numbered[0]?.page || 1;
    const nextNumbered = numbered.find((item) => item.page === currentPage + 1)?.element;
    const nonNumbered = buttons.filter((button) => !/^\\d+$/.test((button.innerText || '').trim()));
    const next = nextNumbered || nonNumbered.at(-1);
    if (!next || next.disabled || next.getAttribute('aria-disabled') === 'true' ||
        next.classList.contains('ant-pagination-disabled')) return false;
    next.click();
    return true;
  })()`);
  if (!clicked) {
    throw new Error('SHEIN product list reported a next page, but the next-page control was unavailable.');
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = await inspectProductList(page);
    const signature = state.rows.map((row) => row.cargoNumber).join('|');
    const expectedRows = expectedRowsOnPage(
      state.currentPage,
      state.expectedProducts,
      state.pageSize,
    );
    if (signature && signature !== previousSignature && state.currentPage === previousPage + 1 &&
        (expectedRows === null || state.rows.length === expectedRows)) return;
    await sleep(300);
  }
  throw new Error('SHEIN next product page did not finish loading.');
}

export function normalizeSheinCargoNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

function isSheinUrl(url) {
  try {
    return SHEIN_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isAuthenticatedSheinUrl(url, homeUrl, detailsUrl) {
  if (url.startsWith(homeUrl) || url.startsWith(detailsUrl)) return true;
  if (!isSheinUrl(url)) return false;
  const hash = new URL(url).hash;
  return hash.startsWith('#/home') || hash.startsWith('#/sbn/merchandise/details');
}

function parseTrendDelay(env) {
  const minSeconds = parseNonNegativeNumber(env.SHEIN_TREND_RENDER_DELAY_MIN_SECONDS, 5);
  const maxSeconds = parseNonNegativeNumber(env.SHEIN_TREND_RENDER_DELAY_MAX_SECONDS, 7);
  if (minSeconds > maxSeconds) {
    throw new Error('SHEIN_TREND_RENDER_DELAY_MIN_SECONDS must not exceed the maximum.');
  }
  return { minMs: minSeconds * 1000, maxMs: maxSeconds * 1000 };
}

function parseNonNegativeNumber(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid SHEIN delay value: ${value}`);
  }
  return number;
}

function parsePositiveMs(value, fallback) {
  const number = Number.parseInt(String(value || fallback), 10);
  if (!Number.isFinite(number) || number < 1) {
    throw new Error(`Invalid SHEIN timeout: ${value}`);
  }
  return number;
}

async function humanPause(label, config) {
  const delay = randomHumanDelayMs(config);
  console.log(`Human-like pause before ${label}: ${(delay / 1000).toFixed(1)} seconds`);
  await sleep(delay);
}

async function trendRenderPause(config) {
  const delay = randomHumanDelayMs(config);
  console.log(`Waiting ${(delay / 1000).toFixed(1)} seconds for the SHEIN trend chart...`);
  await sleep(delay);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  collectSheinSales().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
