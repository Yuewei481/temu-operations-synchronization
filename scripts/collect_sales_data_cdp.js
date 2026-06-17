import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CdpPage, activateCdpPage, findCdpPage, getCdpOrigin } from './cdp_client.js';
import { parseHumanDelayConfig, randomHumanDelayMs } from './human_timing.js';

const SELLER_HOME_ORIGIN = 'https://agentseller.temu.com';
const SELLER_EU_ORIGIN = 'https://agentseller-eu.temu.com';
const SELLER_SETTLE_ORIGIN = 'https://seller.kuajingmaihuo.com/settle';
const SALES_MANAGEMENT_PATH = '/stock/fully-mgt/sale-manage/main';
const TRAFFIC_ANALYSIS_PATH = '/main/flux-analysis-full';
const DEFAULT_WAIT_MS = 15 * 1000;
const DEFAULT_MANUAL_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const DEFAULT_SALES_TABLE_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_TRAFFIC_TABLE_TIMEOUT_MS = 3 * 60 * 1000;
const OUTPUT_PATH = 'output/sales-data.json';
const TRAFFIC_QUERY_BUTTON_XPATH = '//*[@id="page_container_id"]/div[2]/div/div[1]/div[2]/form/div/div/div[5]/div/button[1]/span';

async function main() {
  const cdpOrigin = getCdpOrigin();
  const entryPage = await waitForEntryPage(cdpOrigin);
  if (!entryPage) {
    throw new Error(
      `Seller Central tab not found via CDP. Start Chrome with npm run start-chrome:cdp, then finish manual login.`,
    );
  }

  console.log(`Seller Central entry tab detected: ${entryPage.url}`);
  if (!entryPage.url.startsWith(SELLER_HOME_ORIGIN)) {
    console.log('Step 2 reached: fulfillment center entry page detected. Waiting for you to click 进入 manually...');
  }

  let sellerPageInfo = await waitForSellerHomePage(cdpOrigin);
  if (!sellerPageInfo) {
    throw new Error('Seller Central home tab not found. Please click 进入 manually and keep Chrome open.');
  }

  const waitMs = Number.parseInt(process.env.SELLER_HOME_WAIT_MS || `${DEFAULT_WAIT_MS}`, 10);
  const humanDelayConfig = parseHumanDelayConfig(process.env);
  console.log(`Seller Central home tab detected: ${sellerPageInfo.url}`);
  console.log(`Waiting ${Math.round(waitMs / 1000)} seconds before collecting sales data...`);
  await sleep(waitMs);

  let page = await attachToPage(sellerPageInfo, cdpOrigin);
  try {
    const targetDates = readTrafficTargetDates(process.env);
    console.log(`Target date(s): ${targetDates.join(', ')}`);

    if (process.env.COLLECT_TRAFFIC_ONLY === '1') {
      console.log('Traffic-only mode: collecting exposure and clicks only.');
      const result = {
        collectedAt: new Date().toISOString(),
        url: await evaluate(page, 'location.href'),
        title: await evaluate(page, 'document.title'),
        pages: [],
        records: [],
        trafficAnalysis: await collectEuTrafficAnalysis(page, humanDelayConfig, targetDates),
      };

      await mkdir(dirname(OUTPUT_PATH), { recursive: true });
      await writeFile(OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`);
      console.log(`Collected ${result.trafficAnalysis.records.length} traffic detail row(s).`);
      console.log(`Saved traffic-only result: ${OUTPUT_PATH}`);
      for (const record of result.trafficAnalysis.records) {
        console.log(
          `Traffic SPU ${record.spuId || 'unknown'}: ${record.date}, exposure ${record.exposure}, clicks ${record.clicks}, image ${record.imageStatus}`,
        );
      }
      return;
    }

    if (await isSalesManagePage(page)) {
      console.log('Step 1: already on sales management page; skipping sidebar navigation.');
    } else {
      if (!(await hasSalesChildLink(page))) {
        console.log('Step 1: opening left sidebar parent menu: 销售管理');
        await humanPause('opening sales management parent menu', humanDelayConfig);
        await clickPoint(page, buildSalesParentPointScript());
        await sleep(1200);
      } else {
        console.log('Step 1: sales management child menu is already visible.');
      }

      console.log('Step 2: clicking child menu: 销售管理');
      await humanPause('opening sales management child menu', humanDelayConfig);
      try {
        await clickPoint(page, buildSalesChildPointScript());
      } catch (error) {
        console.log(`Sales child menu click failed (${error.message}); navigating current tab to sales management URL.`);
        await evaluate(page, `location.href = "${SELLER_HOME_ORIGIN}${SALES_MANAGEMENT_PATH}"`);
      }

      let navigated = await waitForSalesManagePage(page, 30000);
      if (!navigated) {
        console.log('Sales management page did not open after sidebar click; navigating current tab directly.');
        await evaluate(page, `location.href = "${SELLER_HOME_ORIGIN}${SALES_MANAGEMENT_PATH}"`);
        navigated = await waitForSalesManagePage(page, 60000);
      }
      if (!navigated) {
        throw new Error('销售管理页面未打开：侧边栏点击和直接跳转都没有进入销售管理页面');
      }
    }

    console.log('Waiting for sales table data to appear...');
    const tableReady = await waitForSalesTableData(
      page,
      Number.parseInt(process.env.SALES_TABLE_TIMEOUT_MS || `${DEFAULT_SALES_TABLE_TIMEOUT_MS}`, 10),
    );
    if (!tableReady) {
      throw new Error('销售管理页面已打开，但没有在限定时间内看到 SKU ID 和合计行');
    }

    console.log('Step 3: checking whether the guide dialog appears');
    await humanPause('checking for guide dialog', humanDelayConfig);
    const guideResult = await evaluate(page, buildDismissGuideScript());
    console.log(`Guide dialog result: ${guideResult}`);

    console.log('Step 4: reading visible SPU IDs and date-specific sales');
    const result = await collectAllSalesPages(page, humanDelayConfig, targetDates);

    if (process.env.COLLECT_SALES_ONLY === '1') {
      await mkdir(dirname(OUTPUT_PATH), { recursive: true });
      await writeFile(OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`);
      console.log(`Collected ${result.records.length} sales row(s).`);
      console.log(`Saved sales-only result: ${OUTPUT_PATH}`);
      for (const record of result.records) {
        const salesSummary = (record.salesByDate || [])
          .map((item) => `${item.date}:${item.sales}`)
          .join(', ');
        console.log(`SPU ${record.spuId || 'unknown'}: sales ${salesSummary || record.todaySales || ''}`);
      }
      return;
    }

    console.log('Step 5: collecting traffic analysis details for 欧区');
    result.trafficAnalysis = await collectEuTrafficAnalysis(page, humanDelayConfig, targetDates);

    await mkdir(dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`);

    console.log(`Collected ${result.records.length} SPU rows from ${result.pages.length} page(s).`);
    console.log(`Collected ${result.trafficAnalysis.records.length} traffic detail row(s).`);
    console.log(`Saved: ${OUTPUT_PATH}`);
    for (const record of result.records) {
      const salesSummary = (record.salesByDate || [])
        .map((item) => `${item.date}:${item.sales}`)
        .join(', ');
      console.log(`SPU ${record.spuId || 'unknown'}: sales ${salesSummary || record.todaySales || ''}`);
    }
    for (const record of result.trafficAnalysis.records) {
      console.log(
        `Traffic SPU ${record.spuId || 'unknown'}: ${record.date}, exposure ${record.exposure}, clicks ${record.clicks}, image ${record.imageStatus}`,
      );
    }
  } finally {
    await page.close();
  }
}

async function waitForEntryPage(cdpOrigin) {
  const timeoutMs = Number.parseInt(
    process.env.MANUAL_LOGIN_TIMEOUT_MS || `${DEFAULT_MANUAL_LOGIN_TIMEOUT_MS}`,
    10,
  );
  const deadline = Date.now() + timeoutMs;
  console.log(`Waiting up to ${Math.round(timeoutMs / 1000)} seconds for Chrome CDP to reach Seller Central entry...`);

  while (Date.now() < deadline) {
    const page = await findCdpPage(
      (candidate) =>
        candidate.url.startsWith(SELLER_HOME_ORIGIN) ||
        candidate.url.startsWith(SELLER_EU_ORIGIN) ||
        candidate.url.startsWith(SELLER_SETTLE_ORIGIN),
      cdpOrigin,
    );
    if (page) {
      return page;
    }

    console.log('Seller Central entry not detected yet. Please complete manual login in Chrome...');
    await sleep(POLL_INTERVAL_MS);
  }

  return null;
}

async function waitForSellerHomePage(cdpOrigin) {
  const minWaitMs = Number.parseInt(process.env.SELLER_HOME_AFTER_ENTRY_MIN_WAIT_MS || '120000', 10);
  const timeoutMs = Number.parseInt(process.env.SELLER_HOME_AFTER_ENTRY_TIMEOUT_MS || '600000', 10);
  const startTime = Date.now();
  const minWaitDeadline = startTime + minWaitMs;
  const deadline = startTime + timeoutMs;
  let loadedPage = null;
  console.log(
    `Waiting at least ${Math.round(minWaitMs / 1000)} seconds and up to ${Math.round(timeoutMs / 1000)} seconds for agentseller.temu.com...`,
  );

  while (Date.now() < deadline) {
    const pages = (await findAllSellerHomePages(cdpOrigin));
    for (const page of pages) {
      if (await cdpPageHasLoadedShell(page)) {
        loadedPage = page;
        if (Date.now() >= minWaitDeadline) {
          return loadedPage;
        }
        console.log('Seller Central menu is loaded; waiting for the minimum post-entry delay to finish...');
        break;
      }
    }

    if (loadedPage) {
      // Keep the page warm until the minimum wait has elapsed.
    } else if (pages.length > 0) {
      console.log('agentseller.temu.com detected, but Seller Central menu is not loaded yet...');
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return loadedPage;
}

async function findAllSellerHomePages(cdpOrigin) {
  const { listCdpPages } = await import('./cdp_client.js');
  const pages = await listCdpPages(cdpOrigin);
  return pages.filter(
    (candidate) =>
      candidate.type === 'page' &&
      (candidate.url.startsWith(SELLER_HOME_ORIGIN) || candidate.url.startsWith(SELLER_EU_ORIGIN)),
  );
}

async function cdpPageHasLoadedShell(pageInfo) {
  const page = new CdpPage(pageInfo);
  try {
    await page.send('Runtime.enable');
    const text = await page.evaluate('(document.body && document.body.innerText) || ""');
    return text.includes('销售管理') || text.includes('备货管理') || text.includes('商品管理');
  } catch {
    return false;
  } finally {
    await page.close();
  }
}

async function attachToPage(pageInfo, cdpOrigin) {
  await activateCdpPage(pageInfo, cdpOrigin);
  const page = new CdpPage(pageInfo);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  return page;
}

async function evaluate(page, source) {
  return page.evaluate(source);
}

async function clickPoint(page, source) {
  const point = await evaluate(page, source);
  if (!point?.x || !point?.y) {
    throw new Error('没有找到可点击元素坐标，无法执行 CDP 鼠标点击');
  }

  await page.click(point.x, point.y);
}

async function isSalesManagePage(page) {
  const currentUrl = await evaluate(page, 'location.href');
  return currentUrl.includes(SALES_MANAGEMENT_PATH);
}

async function hasSalesChildLink(page) {
  return evaluate(page, browserFunction(() => Boolean(document.querySelector('a[href="/stock/fully-mgt/sale-manage/main"]'))));
}

async function waitForSalesManagePage(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentUrl = await evaluate(page, 'location.href');
    if (currentUrl.includes(SALES_MANAGEMENT_PATH)) {
      console.log(`Sales management page detected: ${currentUrl}`);
      return true;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return false;
}

async function waitForSalesTableData(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(
      page,
      `location.href.includes("${SALES_MANAGEMENT_PATH}") && document.body && document.body.innerText.includes("SKU ID") && document.body.innerText.includes("合计")`,
    );
    if (ready) {
      console.log('Sales table data detected.');
      return true;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return false;
}

async function collectAllSalesPages(page, humanDelayConfig, targetDates) {
  const initialState = await getPaginationState(page);
  const pageNumbers = initialState.pageNumbers.length > 0 ? initialState.pageNumbers : [initialState.activePage || 1];
  const pages = [];
  const records = [];

  for (const pageNumber of pageNumbers) {
    await goToSalesPage(page, pageNumber, humanDelayConfig);
    await waitForSalesTableData(
      page,
      Number.parseInt(process.env.SALES_TABLE_TIMEOUT_MS || `${DEFAULT_SALES_TABLE_TIMEOUT_MS}`, 10),
    );

    const state = await getPaginationState(page);
    const activePageNumber = state.activePage || pageNumber;
    const pageRecords = await collectSalesRecordsOnCurrentPage(page, activePageNumber, humanDelayConfig, targetDates);

    pages.push({
      pageNumber: activePageNumber,
      totalText: state.totalText,
      records: pageRecords,
    });
    records.push(...pageRecords.map((record) => ({ ...record, pageNumber: activePageNumber })));
    console.log(`Collected page ${activePageNumber}: ${pageRecords.length} SKU rows.`);
  }

  return {
    collectedAt: new Date().toISOString(),
    url: await evaluate(page, 'location.href'),
    title: await evaluate(page, 'document.title'),
    pages,
    records,
  };
}

async function collectSalesRecordsOnCurrentPage(page, pageNumber, humanDelayConfig, targetDates) {
  const initialRecords = JSON.parse(await evaluate(page, buildCollectSalesRecordsScript()));
  const count = initialRecords.length;
  const records = [];
  console.log(`Sales page ${pageNumber}: found ${count} product sales row(s).`);

  for (let index = 0; index < initialRecords.length; index += 1) {
    await humanPause(`reading sales product ${index + 1}/${count} on page ${pageNumber}`, humanDelayConfig);
    const record = initialRecords[index];
    if (!record?.spuId) {
      console.log(`Sales product ${index + 1}/${count} on page ${pageNumber}: skipped because row snapshot is incomplete.`);
      continue;
    }

    record.salesByDate = await collectSalesByDateForRecord(page, index, record, targetDates, humanDelayConfig);
    records.push(record);
    console.log(
      `Read sales product ${index + 1}/${count} on page ${pageNumber}: SPU ${record.spuId || 'unknown'}, ` +
        `sales ${record.salesByDate.map((item) => `${item.date}:${item.sales}`).join(', ')}`,
    );
    await humanPause(`finished sales product ${index + 1}/${count} on page ${pageNumber}`, humanDelayConfig);
  }

  return records;
}

async function collectSalesByDateForRecord(page, index, record, targetDates, humanDelayConfig) {
  if (!targetDates.length) {
    return [];
  }

  await ensureSalesTrendDialogClosed(page);

  if (!record.hasSalesTrend) {
    console.log(`Sales product ${index + 1}: no 销售趋势 button; filling requested date sales with 0.`);
    return targetDates.map((date) => ({ date, sales: '0', source: 'no-sales-trend' }));
  }

  let trendReady = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await ensureSalesTrendDialogClosed(page);
    await humanPause(`opening sales trend for product ${index + 1} (attempt ${attempt})`, humanDelayConfig);
    const opened = await openSalesTrendDialog(page, record);
    if (!opened) {
      console.log(`Sales product ${index + 1}: 销售趋势 button was expected but could not be clicked (attempt ${attempt}).`);
      continue;
    }

    trendReady = await waitForSalesTrendDialog(page, 60000);
    if (trendReady) {
      break;
    }

    console.log(`Sales product ${index + 1}: 销售趋势弹窗没有在限定时间内出现 (attempt ${attempt}).`);
    await forceCloseSalesTrendDialog(page);
  }

  if (!trendReady) {
    throw new Error(`SPU ${record.spuId} 有销售趋势按钮，但连续 3 次无法打开或识别销售趋势弹窗；已停止以避免写入错误销量。`);
  }
  const salesByDate = [];
  for (const targetDate of targetDates) {
    await humanPause(`hovering sales trend ${targetDate}`, humanDelayConfig);
    const recordForDate = await readSalesTrendPoint(page, targetDate);
    salesByDate.push(recordForDate || { date: targetDate, sales: '0', source: 'sales-trend-missing' });
  }

  await humanPause(`closing sales trend for product ${index + 1}`, humanDelayConfig);
  const closed = await closeSalesTrendDialog(page);
  if (!closed) {
    console.log(`Sales product ${index + 1}: 销售趋势弹窗没有正常关闭，使用 Escape 兜底。`);
    await forceCloseSalesTrendDialog(page);
  }
  await moveMouseAwayFromSalesTrend(page);
  return salesByDate;
}

async function openSalesTrendDialog(page, record) {
  let point = await evaluate(page, buildSalesTrendPointScript(record.spuId));
  if (!point?.x || !point?.y) {
    await evaluate(page, buildScrollSalesRecordIntoViewScript(record.spuId));
    await sleep(500);
    point = await evaluate(page, buildSalesTrendPointScript(record.spuId));
  }
  if (!point?.x || !point?.y) {
    return false;
  }
  await page.click(point.x, point.y);
  return true;
}

async function waitForSalesTrendDialog(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(page, buildHasSalesTrendDialogScript());
    if (ready) {
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

async function readSalesTrendPoint(page, targetDate) {
  const point = await evaluate(page, buildSalesTrendHoverPointScript(targetDate));
  if (!point?.x || !point?.y) {
    console.log(`Sales trend: unable to estimate hover point for ${targetDate}.`);
    return null;
  }

  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
    buttons: 0,
  });
  await sleep(700);
  const rawRecord = await evaluate(page, buildCollectSalesTrendTooltipScript(targetDate));
  const record = JSON.parse(rawRecord || 'null');
  if (!record) {
    console.log(`Sales trend: tooltip for ${targetDate} was not readable after hover.`);
    return null;
  }
  return record;
}

async function closeSalesTrendDialog(page) {
  const point = await evaluate(page, buildCloseSalesTrendPointScript());
  if (point?.x && point?.y) {
    await page.click(point.x, point.y);
    return waitForSalesTrendDialogClosed(page, 10000);
  }
  return forceCloseSalesTrendDialog(page);
}

async function waitForSalesTrendDialogClosed(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const closed = await evaluate(page, buildIsSalesTrendDialogClosedScript());
    if (closed) {
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

async function forceCloseSalesTrendDialog(page) {
  await evaluate(page, 'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  return waitForSalesTrendDialogClosed(page, 10000);
}

async function ensureSalesTrendDialogClosed(page) {
  const closed = await evaluate(page, buildIsSalesTrendDialogClosedScript());
  if (closed) {
    await moveMouseAwayFromSalesTrend(page);
    return true;
  }

  await forceCloseSalesTrendDialog(page);
  await moveMouseAwayFromSalesTrend(page);
  return evaluate(page, buildIsSalesTrendDialogClosedScript());
}

async function moveMouseAwayFromSalesTrend(page) {
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 24,
    y: 24,
    button: 'none',
    buttons: 0,
  });
  await sleep(300);
}

async function collectEuTrafficAnalysis(page, humanDelayConfig, targetDates = readTrafficTargetDates(process.env)) {
  const trafficDateRange = process.env.TRAFFIC_DATE_RANGE || chooseTrafficDateRange(targetDates);
  await openTrafficAnalysisPage(page, humanDelayConfig);
  await selectEuRegion(page, humanDelayConfig);
  await selectTrafficDateRange(page, humanDelayConfig, trafficDateRange);
  await waitForTrafficListPageWithRefresh(
    page,
    humanDelayConfig,
    Number.parseInt(process.env.TRAFFIC_TABLE_TIMEOUT_MS || `${DEFAULT_TRAFFIC_TABLE_TIMEOUT_MS}`, 10),
    trafficDateRange,
  );

  const pages = [];
  const records = [];
  const seenPages = new Set();
  const maxPages = Number.parseInt(process.env.TRAFFIC_MAX_PAGES || '30', 10);
  console.log(`Traffic target date(s): ${targetDates.join(', ')}`);
  console.log(`Traffic date range selected in page: ${trafficDateRange}`);

  for (let pageLoopIndex = 0; pageLoopIndex < maxPages; pageLoopIndex += 1) {
    await dismissFeedbackPopup(page);
    const state = await getPaginationState(page);
    const activePage = state.activePage || pageLoopIndex + 1;
    if (seenPages.has(activePage)) {
      break;
    }
    seenPages.add(activePage);

    await humanPause(`reading traffic list page ${activePage}`, humanDelayConfig);
    const pageRecords = await collectTrafficDetailsOnCurrentPageWithQueryRetry(page, activePage, humanDelayConfig, targetDates);
    pages.push({
      pageNumber: activePage,
      totalText: state.totalText,
      records: pageRecords,
    });
    records.push(...pageRecords);
    console.log(`Collected traffic page ${activePage}: ${pageRecords.length} product detail row(s).`);

    if (pageLoopIndex + 1 >= maxPages) {
      break;
    }

    const latestState = await getPaginationState(page);
    if (latestState.nextDisabled || !latestState.nextPoint) {
      break;
    }

    console.log(`Moving to traffic page after ${activePage}...`);
    await humanPause('moving to next traffic page', humanDelayConfig);
    await page.click(latestState.nextPoint.x, latestState.nextPoint.y);
    try {
      await waitForTrafficPageChange(page, activePage, 60000);
    } catch (error) {
      console.log(`Traffic next page did not open (${error.message}); keeping collected traffic data and continuing.`);
      break;
    }
  }

  return {
    collectedAt: new Date().toISOString(),
    region: '欧区',
    targetDates,
    dateRange: trafficDateRange,
    url: await evaluate(page, 'location.href'),
    title: await evaluate(page, 'document.title'),
    pages,
    records,
  };
}

async function openTrafficAnalysisPage(page, humanDelayConfig) {
  if (await isTrafficAnalysisPage(page)) {
    console.log('Traffic analysis page is already open.');
    return;
  }

  if (!(await hasTrafficAnalysisChildLink(page))) {
    console.log('Step 5.1: opening left sidebar parent menu: 经营分析');
    await humanPause('opening business analysis parent menu', humanDelayConfig);
    await clickPoint(page, buildBusinessAnalysisParentPointScript());
    await sleep(1200);
  } else {
    console.log('Step 5.1: business analysis child menu is already visible.');
  }

  console.log('Step 5.2: clicking child menu: 流量分析');
  await humanPause('opening traffic analysis child menu', humanDelayConfig);
  try {
    await clickPoint(page, buildTrafficAnalysisChildPointScript());
  } catch (error) {
    console.log(`Traffic analysis child menu click failed (${error.message}); navigating current tab to traffic analysis URL.`);
    await evaluate(page, `location.href = "${SELLER_HOME_ORIGIN}${TRAFFIC_ANALYSIS_PATH}"`);
  }

  const opened = await waitForTrafficAnalysisPage(page, 30000);
  if (!opened) {
    console.log('Traffic analysis sidebar click did not finish in time; navigating current tab to traffic analysis URL.');
    await evaluate(page, `location.href = "${SELLER_HOME_ORIGIN}${TRAFFIC_ANALYSIS_PATH}"`);
    await waitForTrafficAnalysisPage(page, 60000);
  }
}

async function selectEuRegion(page, humanDelayConfig) {
  const currentUrl = await evaluate(page, 'location.href');
  if (currentUrl.startsWith(`${SELLER_EU_ORIGIN}${TRAFFIC_ANALYSIS_PATH}`)) {
    console.log('Step 5.3: already on 欧区 traffic page.');
    return;
  }

  console.log('Step 5.3: selecting region: 欧区');
  await humanPause('selecting EU region', humanDelayConfig);
  await clickPoint(page, buildRegionPointScript('欧区'));
  const selected = await waitForEuTrafficPage(page, 60000);
  if (!selected) {
    console.log('EU region click did not finish in time; navigating current tab to EU traffic analysis URL.');
    await evaluate(page, `location.href = "${SELLER_EU_ORIGIN}${TRAFFIC_ANALYSIS_PATH}"`);
    await waitForEuTrafficPage(page, 60000);
  }
}

async function selectTrafficDateRange(page, humanDelayConfig, dateRange) {
  const alreadyHasRows = await evaluate(page, 'Boolean(document.body && document.body.innerText.includes("查看详情"))');
  const activeDate = await evaluate(page, buildActiveTrafficDateScript());
  if (alreadyHasRows && activeDate === dateRange) {
    console.log(`Step 5.4: traffic date range is already ${dateRange}.`);
    return;
  }

  await waitForTrafficDateControls(page, 60000);
  console.log(`Step 5.4: selecting traffic date range: ${dateRange}`);
  await humanPause(`selecting traffic date range ${dateRange}`, humanDelayConfig);
  await clickPoint(page, buildTrafficDatePointScript(dateRange));
  await waitForTrafficDateRows(page, 60000, dateRange);
}

async function waitForTrafficDateControls(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(page, buildHasTrafficDateControlsScript());
    if (ready) {
      return true;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error('流量分析日期筛选按钮没有在限定时间内出现');
}

async function isTrafficAnalysisPage(page) {
  const currentUrl = await evaluate(page, 'location.href');
  return currentUrl.includes(TRAFFIC_ANALYSIS_PATH);
}

async function hasTrafficAnalysisChildLink(page) {
  return evaluate(page, browserFunction(() => Boolean(findSidebarText('流量分析', { preferBottom: true }))));
}

async function waitForTrafficAnalysisPage(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentUrl = await evaluate(page, 'location.href');
    const text = await evaluate(page, '(document.body && document.body.innerText) || ""');
    if (currentUrl.includes(TRAFFIC_ANALYSIS_PATH) && text.includes('商品流量')) {
      console.log(`Traffic analysis page detected: ${currentUrl}`);
      return true;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return false;
}

async function waitForEuTrafficPage(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentUrl = await evaluate(page, 'location.href');
    const text = await evaluate(page, '(document.body && document.body.innerText) || ""');
    if (currentUrl.startsWith(`${SELLER_EU_ORIGIN}${TRAFFIC_ANALYSIS_PATH}`) && text.includes('欧区')) {
      console.log(`EU traffic analysis page detected: ${currentUrl}`);
      return true;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return false;
}

async function waitForTrafficListPage(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(
      page,
      `location.href.includes("${TRAFFIC_ANALYSIS_PATH}") && document.body && document.body.innerText.includes("商品明细") && document.body.innerText.includes("查看详情")`,
    );
    if (ready) {
      console.log('Traffic product list detected.');
      return true;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error('流量分析页面已打开，但没有在限定时间内看到商品明细和查看详情');
}

async function waitForTrafficListPageWithRefresh(page, humanDelayConfig, timeoutMs, dateRange) {
  const maxRefreshes = Number.parseInt(process.env.TRAFFIC_REFRESH_RETRIES || '2', 10);
  for (let attempt = 0; attempt <= maxRefreshes; attempt += 1) {
    const ready = await waitForTrafficListPageOrEmpty(page, timeoutMs);
    if (ready === 'ready') {
      return true;
    }

    if (attempt >= maxRefreshes) {
      break;
    }

    console.log(`Traffic list still has no detail rows after selecting ${dateRange} (${ready}); refreshing page and trying again...`);
    await humanPause('refreshing traffic analysis page', humanDelayConfig);
    await page.send('Page.reload', { ignoreCache: true });
    let recovered = await waitForEuTrafficPage(page, 60000);
    if (!recovered) {
      console.log('EU traffic page did not recover after refresh; navigating to EU traffic URL directly.');
      await evaluate(page, `location.href = "${SELLER_EU_ORIGIN}${TRAFFIC_ANALYSIS_PATH}"`);
      recovered = await waitForEuTrafficPage(page, 60000);
    }

    try {
      await selectTrafficDateRange(page, humanDelayConfig, dateRange);
    } catch (error) {
      if (!String(error.message || error).includes('日期筛选按钮')) {
        throw error;
      }

      console.log('Traffic date controls did not appear after refresh; navigating to EU traffic URL directly and retrying.');
      await evaluate(page, `location.href = "${SELLER_EU_ORIGIN}${TRAFFIC_ANALYSIS_PATH}"`);
      await waitForEuTrafficPage(page, 60000);
      await selectTrafficDateRange(page, humanDelayConfig, dateRange);
    }
  }

  throw new Error('流量分析页面已打开并刷新重试，但仍然没有看到商品明细和查看详情');
}

async function waitForTrafficListPageOrEmpty(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evaluate(
      page,
      `(() => {
        const text = document.body.innerText || "";
        if (!location.href.includes("${TRAFFIC_ANALYSIS_PATH}") || !text.includes("商品明细")) {
          return "loading";
        }
        if (text.includes("查看详情")) {
          return "ready";
        }
        if (text.includes("加载中")) {
          return "loading";
        }
        if (text.includes("暂无数据") || text.includes("共有 0 条")) {
          return "empty";
        }
        return "loading";
      })()`,
    );
    if (state === 'ready' || state === 'empty') {
      if (state === 'ready') {
        console.log('Traffic product list detected.');
      }
      return state;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return 'timeout';
}

async function waitForTrafficDateRows(page, timeoutMs, dateRange) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(
      page,
      'Boolean(document.body && document.body.innerText.includes("商品明细") && (document.body.innerText.includes("查看详情") || document.body.innerText.includes("暂无数据")))',
    );
    if (ready) {
      return true;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`点击${dateRange}后，流量分析商品明细没有在限定时间内刷新`);
}

async function waitForTrafficPageChange(page, previousPageNumber, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const state = await getPaginationState(page);
    const hasList = await evaluate(page, 'Boolean(document.body && document.body.innerText.includes("商品明细") && document.body.innerText.includes("查看详情"))');
    if (hasList && state.activePage && state.activePage !== previousPageNumber) {
      return true;
    }
  }

  throw new Error(`没有在限定时间内切换到流量分析下一页`);
}

async function collectTrafficDetailsOnCurrentPageWithQueryRetry(page, pageNumber, humanDelayConfig, targetDates) {
  const maxQueryRetries = Number.parseInt(process.env.TRAFFIC_EMPTY_QUERY_RETRIES || '2', 10);
  for (let attempt = 0; attempt <= maxQueryRetries; attempt += 1) {
    const pageRecords = await collectTrafficDetailsOnCurrentPage(page, pageNumber, humanDelayConfig, targetDates);
    if (pageRecords.length > 0 || attempt >= maxQueryRetries) {
      return pageRecords;
    }

    console.log(`Traffic page ${pageNumber} has no product rows; clicking 查询 and retrying (${attempt + 1}/${maxQueryRetries})...`);
    await humanPause('clicking traffic query button for empty list', humanDelayConfig);
    const clicked = await clickTrafficQueryButton(page);
    if (!clicked) {
      console.log('Traffic query button was not found; keeping empty traffic result for this page.');
      return pageRecords;
    }

    await waitForTrafficDateRows(page, 60000, '查询');
    await sleep(POLL_INTERVAL_MS);
  }

  return [];
}

async function clickTrafficQueryButton(page) {
  return evaluate(page, buildClickTrafficQueryButtonScript());
}

async function collectTrafficDetailsOnCurrentPage(page, pageNumber, humanDelayConfig, targetDates) {
  const rows = JSON.parse(await evaluate(page, buildCollectTrafficListRowsScript()));
  const count = rows.length;
  const records = [];
  const detailOpenRetries = Number.parseInt(process.env.TRAFFIC_DETAIL_OPEN_RETRIES || '3', 10);
  console.log(`Traffic page ${pageNumber}: found ${count} product detail row(s).`);

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    await dismissFeedbackPopup(page);
    console.log(`Opening traffic detail ${index + 1}/${count} on page ${pageNumber}: SPU ${row.spuId || 'unknown'}...`);
    await openTrafficDetailWithRetry(page, index, row, count, humanDelayConfig, detailOpenRetries);
    const detailDataReady = await waitForTrafficDetailData(page, 60000);
    if (!detailDataReady) {
      console.log(`Traffic detail ${index + 1}/${count}: detail shell opened, but no dated data row appeared before timeout.`);
    }

    await humanPause(`reading traffic detail ${index + 1}`, humanDelayConfig);
    const rawRecord = await evaluate(page, buildCollectTrafficDetailScript());
    const detailRecord = JSON.parse(rawRecord);
    const normalizedDetailRecord = {
      ...detailRecord,
      productTitle: row.productTitle || detailRecord.productTitle,
      spuId: row.spuId || detailRecord.spuId,
      imageSrc: row.imageSrc || detailRecord.imageSrc,
      imageAlt: row.imageAlt || detailRecord.imageAlt,
      imageStatus: row.imageStatus || detailRecord.imageStatus,
      imageRect: row.imageRect || detailRecord.imageRect,
    };
    const selectedRecords = selectTrafficRecordsForTargetDates(normalizedDetailRecord, targetDates);
    for (const record of selectedRecords) {
      records.push({
        ...record,
        listExposure: row.exposure,
        listClicks: row.clicks,
        pageNumber,
        rowIndex: index + 1,
        source: 'cdp-traffic-detail',
      });
    }

    const logRecords = selectedRecords.length > 0 ? selectedRecords : [detailRecord];
    console.log(
      `Read traffic detail ${index + 1}/${count}: SPU ${row.spuId || detailRecord.spuId || 'unknown'}, ` +
        logRecords.map((record) => `${record.date || 'no-date'} exposure ${record.exposure}, clicks ${record.clicks}${record.dateWasNormalized ? ` (source date ${record.originalDate})` : ''}`).join('; '),
    );
    await humanPause(`finished traffic detail ${index + 1}`, humanDelayConfig);
    await humanPause(`closing traffic detail ${index + 1}`, humanDelayConfig);
    await closeTrafficDetail(page);
    await waitForTrafficDetailClosed(page, 60000);
    await waitForTrafficListPage(page, 60000);
  }

  return records;
}

async function openTrafficDetailWithRetry(page, index, row, count, humanDelayConfig, maxAttempts) {
  const attempts = Math.max(1, maxAttempts || 1);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      console.log(
        `Retrying traffic detail ${index + 1}/${count} for SPU ${row.spuId || 'unknown'} ` +
          `(attempt ${attempt}/${attempts})...`,
      );
    }

    await ensureTrafficDetailClosed(page);
    await waitForTrafficListPage(page, 60000);
    await dismissFeedbackPopup(page);
    await humanPause(`opening traffic detail ${index + 1}${attempt > 1 ? ` retry ${attempt}` : ''}`, humanDelayConfig);

    try {
      await clickTrafficDetailButton(page, index, row.spuId);
      await waitForTrafficDetailPage(page, 60000);
      if (row.spuId) {
        await waitForTrafficDetailForSpu(page, row.spuId, 20000);
      }
      return true;
    } catch (error) {
      lastError = error;
      console.log(
        `Traffic detail ${index + 1}/${count} did not open as expected: ${error.message || error}. ` +
          (attempt < attempts ? 'Closing it and retrying.' : 'No retries left.'),
      );
      await ensureTrafficDetailClosed(page);
    }
  }

  throw lastError || new Error(`未能打开第 ${index + 1} 个商品的流量详情`);
}

function selectTrafficRecordsForTargetDates(detailRecord, targetDates) {
  const sourceRows = Array.isArray(detailRecord?.detailRows) && detailRecord.detailRows.length > 0
    ? detailRecord.detailRows
    : [{ date: detailRecord?.date || '', exposure: detailRecord?.exposure || '', clicks: detailRecord?.clicks || '' }];
  const records = [];

  for (const targetDate of targetDates) {
    const exact = sourceRows.find((row) => row.date === targetDate);
    const chosen = exact || normalizeContinuousZeroTrafficRow(sourceRows[0], targetDate);
    const resolved = chosen || zeroTrafficRowForMissingDate(targetDate);
    if (!chosen) {
      console.log(
        `Traffic detail SPU ${detailRecord?.spuId || 'unknown'}: target date ${targetDate} not found; ` +
          'using exposure 0 and clicks 0.',
      );
    }

    records.push({
      ...detailRecord,
      ...resolved,
      detailRows: undefined,
      date: resolved.date,
      exposure: resolved.exposure,
      clicks: resolved.clicks,
    });
  }

  return records;
}

function zeroTrafficRowForMissingDate(targetDate) {
  return {
    date: targetDate,
    exposure: '0',
    clicks: '0',
    source: 'missing-target-date-zero-filled',
    dateWasZeroFilled: true,
  };
}

function normalizeContinuousZeroTrafficRow(row, targetDate) {
  if (!row || !row.date || row.date === targetDate) {
    return row;
  }

  if (isZeroValue(row.exposure) && isZeroValue(row.clicks)) {
    return {
      ...row,
      originalDate: row.date,
      date: targetDate,
      dateWasNormalized: true,
    };
  }

  return null;
}

function isZeroValue(value) {
  const text = String(value ?? '').trim().replace(/,/g, '');
  return text !== '' && Number(text) === 0;
}

function readTrafficTargetDates(env) {
  const raw = env.TRAFFIC_TARGET_DATES || '';
  const parsed = raw
    .split(/[,\s]+/)
    .map((value) => normalizeConfiguredDate(value))
    .filter(Boolean);
  const unique = [...new Set(parsed)];
  return unique.length > 0 ? unique : [yesterdayDateInTimeZone('Asia/Shanghai')];
}

function normalizeConfiguredDate(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (!match) {
    throw new Error(`Invalid traffic target date "${text}". Use YYYY-MM-DD, for example 2026-06-09.`);
  }

  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function chooseTrafficDateRange(targetDates) {
  const yesterday = yesterdayDateInTimeZone('Asia/Shanghai');
  if (targetDates.length === 1 && targetDates[0] === yesterday) {
    return '昨日';
  }

  const now = Date.now();
  const oldestAgeDays = Math.max(
    ...targetDates.map((date) => Math.floor((now - new Date(`${date}T00:00:00+08:00`).getTime()) / (24 * 60 * 60 * 1000))),
  );
  return oldestAgeDays <= 7 ? '近7日' : '近30日';
}

function yesterdayDateInTimeZone(timeZone) {
  const now = new Date();
  const target = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(target);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function waitForTrafficDetailPage(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(
      page,
      'Boolean(document.body && document.body.innerText.includes("商品数据分析") && document.body.innerText.includes("流量明细"))',
    );
    if (ready) {
      return true;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error('点击查看详情后，没有在限定时间内看到商品数据分析详情页');
}

async function waitForTrafficDetailForSpu(page, spuId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visibleSpuId = await evaluate(page, buildTrafficDetailSpuScript());
    if (String(visibleSpuId || '') === String(spuId || '')) {
      return true;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`商品数据分析详情页没有切换到 SPU ${spuId}`);
}

async function waitForTrafficDetailData(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(page, buildHasTrafficDetailDataScript());
    if (ready === true || ready === 'true') {
      return true;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return false;
}

async function closeTrafficDetail(page) {
  const result = await evaluate(page, buildClickCloseTrafficDetailScript());
  if (result?.clicked) {
    return;
  }

  const point = await evaluate(page, buildCloseTrafficDetailPointScript());
  await page.click(point.x, point.y);
}

async function ensureTrafficDetailClosed(page) {
  const detailStillOpen = await evaluate(page, buildIsTrafficDetailVisibleScript());
  if (!detailStillOpen) {
    return true;
  }

  await closeTrafficDetail(page);
  return waitForTrafficDetailClosed(page, 60000);
}

async function clickTrafficDetailButton(page, index, spuId = '') {
  const result = await evaluate(page, buildTrafficDetailButtonPointForSpuScript(index, spuId));
  if (!result?.point) {
    throw new Error(result?.error || `未能定位第 ${index + 1} 个查看详情按钮`);
  }

  await page.click(result.point.x, result.point.y);
}

async function waitForTrafficDetailClosed(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detailStillOpen = await evaluate(page, buildIsTrafficDetailVisibleScript());
    if (!detailStillOpen) {
      return true;
    }

    await sleep(1000);
  }

  console.log('Detail close click did not finish in time; pressing Escape as fallback.');
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });

  const fallbackDeadline = Date.now() + 10000;
  while (Date.now() < fallbackDeadline) {
    const detailStillOpen = await evaluate(page, buildIsTrafficDetailVisibleScript());
    if (!detailStillOpen) {
      return true;
    }
    await sleep(1000);
  }

  throw new Error('商品数据分析详情页没有成功关闭');
}

async function dismissFeedbackPopup(page) {
  await evaluate(page, buildDismissFeedbackPopupScript());
}

async function goToSalesPage(page, pageNumber, humanDelayConfig) {
  const state = await getPaginationState(page);
  if (state.activePage === pageNumber) {
    return;
  }

  const targetPoint = state.pagePoints[String(pageNumber)];
  if (!targetPoint) {
    if (pageNumber === 1 && Object.keys(state.pagePoints || {}).length === 0) {
      console.log('Sales pagination is not visible; reading the current sales table as page 1.');
      return;
    }
    throw new Error(`未找到第 ${pageNumber} 页的分页按钮`);
  }

  console.log(`Moving to sales page ${pageNumber} from page ${state.activePage || 'unknown'}...`);
  await humanPause(`moving to sales page ${pageNumber}`, humanDelayConfig);
  const clickResult = await evaluate(page, buildClickPagerItemScript(pageNumber));
  if (!clickResult?.clicked) {
    await page.click(targetPoint.x, targetPoint.y);
  }
  await waitForActiveSalesPage(page, pageNumber, 60000);
}

async function getPaginationState(page) {
  return evaluate(page, buildGetPaginationStateScript());
}

async function waitForActiveSalesPage(page, pageNumber, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const state = await getPaginationState(page);
    const hasData = await evaluate(page, 'Boolean(document.body && document.body.innerText.includes("SKU ID") && document.body.innerText.includes("合计"))');
    if (state.activePage === pageNumber && hasData) {
      return true;
    }
  }

  throw new Error(`没有在限定时间内进入第 ${pageNumber} 页`);
}

function buildSalesParentPointScript() {
  return browserFunction(() => {
    const element = findSidebarText('销售管理', { preferTop: true });
    if (!element) {
      throw new Error('未找到左侧一级菜单：销售管理');
    }

    return viewportPointForElement(element);
  });
}

function buildSalesChildPointScript() {
  return browserFunction(() => {
    const element =
      document.querySelector('a[href="/stock/fully-mgt/sale-manage/main"]') ||
      findSidebarText('销售管理', { preferBottom: true });
    if (!element) {
      throw new Error('未找到销售管理子菜单：销售管理');
    }

    return viewportPointForElement(element);
  });
}

function buildDismissGuideScript() {
  return browserFunction(() => {
    const button = findVisibleByText('我知道了', { exact: true, tagNames: ['BUTTON', 'DIV', 'SPAN'] });
    if (!button) {
      return 'guide not shown';
    }

    const point = viewportPointForElement(button);
    const target = document.elementFromPoint(point.x, point.y) || button;
    target.click();
    return 'dismissed guide';
  });
}

function buildCollectSalesDataScript() {
  return browserFunction(() => {
    const records = collectVisibleSkuSalesRowsByCoordinates();
    return JSON.stringify({
      collectedAt: new Date().toISOString(),
      url: location.href,
      title: document.title,
      records,
    });
  });
}

function buildCountSalesRecordsScript() {
  return browserFunction(() => collectVisibleSkuSalesRowsByCoordinates().length);
}

function buildCollectSalesRecordScript(index) {
  return browserFunction(() => {
    const records = collectVisibleSkuSalesRowsByCoordinates();
    return JSON.stringify(records[__INDEX__] || null);
  }).replaceAll('__INDEX__', String(index));
}

function buildCollectSalesRecordsScript() {
  return browserFunction(() => JSON.stringify(collectVisibleSkuSalesRowsByCoordinates()));
}

function buildSalesTrendPointScript(spuId) {
  return browserFunction((targetSpuId) => {
    let records = collectVisibleSkuSalesRowsByCoordinates({ scrollTrendPointSpuId: targetSpuId });
    let record = records.find((item) => item.spuId === targetSpuId);
    if (record?.salesTrendPoint) {
      return record.salesTrendPoint;
    }

    const textItem = visibleTextItems()
      .find((item) => item.text.includes(targetSpuId) && /SPU\s*[:：]/i.test(item.text));
    if (textItem) {
      textItem.element.scrollIntoView({ block: 'center', inline: 'nearest' });
      records = collectVisibleSkuSalesRowsByCoordinates({ scrollTrendPointSpuId: targetSpuId });
      record = records.find((item) => item.spuId === targetSpuId);
    }

    return record?.salesTrendPoint || null;
  }, spuId);
}

function buildScrollSalesRecordIntoViewScript(spuId) {
  return browserFunction((targetSpuId) => {
    const item = visibleTextItems()
      .find((textItem) => textItem.text.includes(targetSpuId) && /SPU\s*[:：]/i.test(textItem.text));
    if (!item) {
      return false;
    }

    item.element.scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  }, spuId);
}

function buildSalesTrendHoverPointScript(targetDate) {
  return browserFunction((wantedDate) => {
    const modal = findSalesTrendModal();
    if (!modal) {
      return null;
    }

    const modalRect = modal.getBoundingClientRect();
    const targetTime = new Date(`${wantedDate}T00:00:00+08:00`).getTime();
    if (!Number.isFinite(targetTime)) {
      return null;
    }

    const dateItems = visibleTextItems()
      .filter((item) => modal.contains(item.element))
      .map((item) => ({ ...item, date: parseAxisDate(item.text, wantedDate) }))
      .filter((item) => item.date)
      .sort((a, b) => a.date.time - b.date.time);
    if (dateItems.length < 2) {
      return estimatePointFromCanvas();
    }

    let left = dateItems[0];
    let right = dateItems[dateItems.length - 1];
    for (let index = 0; index < dateItems.length - 1; index += 1) {
      if (dateItems[index].date.time <= targetTime && targetTime <= dateItems[index + 1].date.time) {
        left = dateItems[index];
        right = dateItems[index + 1];
        break;
      }
    }

    const leftX = centerX(left.rect);
    const rightX = centerX(right.rect);
    const ratio = right.date.time === left.date.time ? 0 : (targetTime - left.date.time) / (right.date.time - left.date.time);
    const x = leftX + (rightX - leftX) * ratio;

    const axisTop = Math.min(...dateItems.map((item) => item.rect.top));
    const chartTop = modalRect.top + modalRect.height * 0.24;
    const y = Math.max(chartTop, axisTop - 130);
    return { x, y };

    function estimatePointFromCanvas() {
      const canvas = salesTrendCanvasesForModal(modal)
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter((item) => item.rect.width > 500 && item.rect.height > 200)
        .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0];
      if (!canvas) {
        return null;
      }

      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 30);
      const target = new Date(`${wantedDate}T00:00:00`);
      const startTime = start.getTime();
      const endTime = end.getTime();
      const targetTime = target.getTime();
      if (!Number.isFinite(targetTime) || targetTime < startTime || targetTime > endTime) {
        return null;
      }

      const ratio = (targetTime - startTime) / (endTime - startTime);
      const plotLeft = canvas.rect.left + canvas.rect.width * 0.08;
      const plotRight = canvas.rect.left + canvas.rect.width * 0.75;
      const x = plotLeft + (plotRight - plotLeft) * ratio;
      const y = canvas.rect.top + canvas.rect.height * 0.55;
      return { x, y };
    }

    function parseAxisDate(text, referenceDate) {
      const value = String(text || '').trim();
      let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (match) {
        return datePartsToAxisDate(match[1], match[2], match[3]);
      }
      match = value.match(/^(\d{1,2})-(\d{1,2})$/);
      if (match) {
        return datePartsToAxisDate(referenceDate.slice(0, 4), match[1], match[2]);
      }
      return null;
    }

    function datePartsToAxisDate(year, month, day) {
      const normalized = `${Number(year).toString().padStart(4, '0')}-${Number(month).toString().padStart(2, '0')}-${Number(day).toString().padStart(2, '0')}`;
      return {
        value: normalized,
        time: new Date(`${normalized}T00:00:00+08:00`).getTime(),
      };
    }
  }, targetDate);
}

function buildCollectSalesTrendTooltipScript(targetDate) {
  return browserFunction((wantedDate) => {
    const modal = findSalesTrendModal();
    if (!modal) {
      return JSON.stringify(null);
    }

    const escapedDate = wantedDate.replaceAll('-', '\\-');
    const tooltipPattern = new RegExp(`${escapedDate}[\\s\\S]{0,80}?销量\\s*(\\d+(?:\\.\\d+)?)`);
    const dateText = wantedDate.replace(/^\\d{4}-/, '');
    const escapedShortDate = dateText.replaceAll('-', '\\-');
    const shortTooltipPattern = new RegExp(`${escapedShortDate}[\\s\\S]{0,80}?销量\\s*(\\d+(?:\\.\\d+)?)`);

    const tooltipCandidates = visibleElements()
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: normalizedText(element) }))
      .filter((item) => item.rect.width > 20 && item.rect.height > 10)
      .filter((item) => item.rect.width < 380 && item.rect.height < 220)
      .filter((item) => item.text.includes('销量'))
      .filter((item) => item.text.includes(wantedDate) || item.text.includes(dateText))
      .sort((a, b) => area(a.element) - area(b.element));

    let match = null;
    for (const item of tooltipCandidates) {
      match = item.text.match(tooltipPattern) || item.text.match(shortTooltipPattern);
      if (match) {
        break;
      }
    }

    return JSON.stringify(match
      ? { date: wantedDate, sales: match[1], source: 'sales-trend-tooltip' }
      : null);
  }, targetDate);
}

function buildHasSalesTrendDialogScript() {
  return browserFunction(() => {
    const modal = findSalesTrendModal();
    if (!modal) {
      return false;
    }

    return salesTrendCanvasesForModal(modal).some((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return rect.width > 500 && rect.height > 200;
    });
  });
}

function buildCloseSalesTrendPointScript() {
  return browserFunction(() => {
    const modal = findSalesTrendModal();
    if (!modal) {
      return null;
    }

    const candidates = visibleElements()
      .filter((element) => modal.contains(element))
      .filter((element) => {
        const className = String(element.className || '');
        const text = normalizedText(element);
        return className.includes('MDL_iconWrapper')
          || text === '我知道了'
          || text === '×'
          || text === 'X'
          || element.getAttribute('aria-label') === 'Close';
      })
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: normalizedText(element) }))
      .filter((item) => item.rect.width > 0 && item.rect.height > 0);
    const iconClose = candidates.find((item) => String(item.element.className || '').includes('MDL_iconWrapper'));
    const xClose = candidates.find((item) => item.text === '×' || item.text === 'X');
    const confirm = candidates.find((item) => item.text === '我知道了');
    const close = iconClose || xClose || confirm || candidates.sort((a, b) => b.rect.right - a.rect.right || a.rect.top - b.rect.top)[0];
    return close ? viewportPointForElement(close.element) : null;
  });
}

function buildIsSalesTrendDialogClosedScript() {
  return browserFunction(() => !findSalesTrendModal());
}

function buildGetPaginationStateScript() {
  return browserFunction(() => {
    const items = visibleElements().map((element) => ({
      element,
      text: normalizedText(element),
      rect: element.getBoundingClientRect(),
      className: String(element.className || ''),
      ariaDisabled: element.getAttribute('aria-disabled'),
      disabled: Boolean(element.disabled),
      style: window.getComputedStyle(element),
    }));

    const pagerItems = items
      .filter((item) => item.rect.width > 0 && item.rect.height > 0)
      .filter((item) => item.className.includes('PGT_pagerItem') && /^\d+$/.test(item.text))
      .sort((a, b) => Number(a.text) - Number(b.text));
    const activeItem = pagerItems.find((item) => item.className.includes('PGT_pagerItemActive'));
    const firstItem = pagerItems.find((item) => item.text === '1') || pagerItems[0] || null;
    const pagePoints = {};
    for (const item of pagerItems) {
      pagePoints[item.text] = viewportPointForElement(item.element);
    }
    const nextItem = items
      .filter((item) => item.rect.width > 0 && item.rect.height > 0)
      .filter((item) => item.className.includes('PGT_next'))
      .sort((a, b) => b.rect.top - a.rect.top)[0] || null;
    const totalItem = items.find((item) => item.className.includes('PGT_totalText'));

    return {
      activePage: activeItem ? Number(activeItem.text) : null,
      pageNumbers: pagerItems.map((item) => Number(item.text)),
      totalText: totalItem?.text || '',
      pagePoints,
      firstPagePoint: firstItem ? viewportPointForElement(firstItem.element) : null,
      nextPoint: nextItem ? viewportPointForElement(nextItem.element) : null,
      nextDisabled: !nextItem || nextItem.disabled || nextItem.ariaDisabled === 'true' ||
        nextItem.className.includes('disabled') || nextItem.style.pointerEvents === 'none',
    };
  });
}

function buildClickPagerItemScript(pageNumber) {
  return browserFunction(() => {
    const target = visibleElements()
      .filter((element) => String(element.className || '').includes('PGT_pagerItem'))
      .find((element) => normalizedText(element) === '__PAGE_NUMBER__');
    if (!target) {
      return { clicked: false };
    }

    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return { clicked: true };
  }).replaceAll('__PAGE_NUMBER__', String(pageNumber));
}

function buildBusinessAnalysisParentPointScript() {
  return browserFunction(() => {
    const element = findSidebarText('经营分析', { preferTop: true });
    if (!element) {
      throw new Error('未找到左侧一级菜单：经营分析');
    }

    return viewportPointForElement(element);
  });
}

function buildTrafficAnalysisChildPointScript() {
  return browserFunction(() => {
    const element = findSidebarText('流量分析', { preferBottom: true });
    if (!element) {
      throw new Error('未找到经营分析子菜单：流量分析');
    }

    return viewportPointForElement(element);
  });
}

function buildRegionPointScript(regionText) {
  return browserFunction(() => {
    const candidates = visibleElements()
      .filter((element) => normalizedText(element) === '__REGION_TEXT__')
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.top > 70 && item.rect.top < 180 && item.rect.left > window.innerWidth * 0.45);

    if (candidates.length === 0) {
      throw new Error('未找到区域切换按钮：__REGION_TEXT__');
    }

    candidates.sort((a, b) => area(a.element) - area(b.element));
    return viewportPointForElement(candidates[0].element);
  }).replaceAll('__REGION_TEXT__', regionText);
}

function buildTrafficDatePointScript(dateText) {
  return browserFunction(() => {
    const candidates = visibleElements()
      .filter((element) => normalizedText(element) === '__DATE_TEXT__')
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.width > 0 && item.rect.height > 0)
      .filter((item) => item.rect.top > 80)
      .sort((a, b) => area(a.element) - area(b.element));

    if (candidates.length === 0) {
      throw new Error('未找到流量分析日期按钮：__DATE_TEXT__');
    }

    return viewportPointForElement(candidates[0].element);
  }).replaceAll('__DATE_TEXT__', dateText);
}

function buildActiveTrafficDateScript() {
  return browserFunction(() => {
    const dateTexts = ['昨日', '今日', '本周', '本月', '近7日', '近30日'];
    const candidates = visibleElements()
      .map((element) => ({
        element,
        text: normalizedText(element),
        rect: element.getBoundingClientRect(),
        className: String(element.className || ''),
        color: window.getComputedStyle(element).color,
      }))
      .filter((item) => dateTexts.includes(item.text))
      .filter((item) => item.rect.width > 0 && item.rect.height > 0)
      .filter((item) => item.rect.top > 80);

    const active = candidates.find((item) => /active|selected|checked/i.test(item.className));
    if (active) {
      return active.text;
    }

    const blue = candidates.find((item) => item.color.includes('66, 122, 255') || item.color.includes('51, 102, 255'));
    return blue?.text || '';
  });
}

function buildHasTrafficDateControlsScript() {
  return browserFunction(() => {
    const dateTexts = new Set(['昨日', '今日', '本周', '本月', '近7日', '近30日']);
    return Boolean(
      visibleElements()
        .map((element) => ({ element, text: normalizedText(element), rect: element.getBoundingClientRect() }))
        .find((item) => dateTexts.has(item.text) && item.rect.width > 0 && item.rect.height > 0 && item.rect.top > 80),
    );
  });
}

function buildClickTrafficQueryButtonScript() {
  return browserFunction((xpath) => {
    const xpathNode = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    const xpathButton = xpathNode?.closest?.('button') || xpathNode;
    if (xpathButton) {
      xpathButton.scrollIntoView({ block: 'center', inline: 'center' });
      xpathButton.click();
      return true;
    }

    const candidates = Array.from(document.querySelectorAll('button, span, a'))
      .filter((element) => {
        const text = (element.textContent || '').trim();
        const rect = element.getBoundingClientRect();
        return text === '查询' && rect.width > 0 && rect.height > 0;
      });
    const fallback = candidates[0]?.closest?.('button') || candidates[0];
    if (!fallback) {
      return false;
    }

    fallback.scrollIntoView({ block: 'center', inline: 'center' });
    fallback.click();
    return true;
  }, TRAFFIC_QUERY_BUTTON_XPATH);
}

function buildCollectTrafficListRowsScript() {
  return browserFunction(() => {
    const rows = trafficDetailRows().map(({ element, ...row }) => row);
    return JSON.stringify(rows);
  });
}

function buildTrafficDetailButtonCountScript() {
  return browserFunction(() => trafficDetailButtons().length);
}

function buildTrafficDetailButtonPointScript(index) {
  return browserFunction(() => {
    const buttons = trafficDetailButtons();
    const target = buttons[__DETAIL_INDEX__];
    if (!target) {
      throw new Error(`未找到第 ${__DETAIL_INDEX__ + 1} 个查看详情按钮`);
    }

    return viewportPointForElement(target);
  }).replaceAll('__DETAIL_INDEX__', String(index));
}

function buildClickTrafficDetailButtonScript(index, spuId = '') {
  return browserFunction((wantedSpuId) => {
    const buttons = trafficDetailButtons();
    const rows = trafficDetailRows();
    const targetRow = wantedSpuId
      ? rows.find((row) => String(row.spuId || '') === String(wantedSpuId))
      : null;
    const target = targetRow?.element || buttons[__DETAIL_INDEX__];
    if (!target) {
      return {
        clicked: false,
        error: wantedSpuId
          ? `未找到 SPU ${wantedSpuId} 对应的查看详情按钮`
          : `未找到第 ${__DETAIL_INDEX__ + 1} 个查看详情按钮`,
      };
    }

    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return {
      clicked: true,
      method: targetRow ? 'spu-row' : 'index-fallback',
      spuId: targetRow?.spuId || '',
    };
  }, spuId).replaceAll('__DETAIL_INDEX__', String(index));
}

function buildTrafficDetailButtonPointForSpuScript(index, spuId = '') {
  return browserFunction((wantedSpuId) => {
    const buttons = trafficDetailButtons();
    const rows = trafficDetailRows();
    const targetRow = wantedSpuId
      ? rows.find((row) => String(row.spuId || '') === String(wantedSpuId))
      : null;
    const target = targetRow?.element || buttons[__DETAIL_INDEX__];
    if (!target) {
      return {
        point: null,
        error: wantedSpuId
          ? `未找到 SPU ${wantedSpuId} 对应的查看详情按钮`
          : `未找到第 ${__DETAIL_INDEX__ + 1} 个查看详情按钮`,
      };
    }

    target.scrollIntoView({ block: 'center', inline: 'center' });
    const point = viewportPointForElement(target);
    return {
      point,
      method: targetRow ? 'spu-row-point' : 'index-point-fallback',
      spuId: targetRow?.spuId || '',
    };
  }, spuId).replaceAll('__DETAIL_INDEX__', String(index));
}

function buildCollectTrafficDetailScript() {
  return browserFunction(() => {
    const lines = (document.body.innerText || '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const detailIndex = lines.findIndex((line) => line === '商品数据分析');
    const categoryIndex = lines.findIndex((line, index) => index > detailIndex && line.startsWith('类目'));
    const productTitle = categoryIndex > 0 ? lines[categoryIndex - 1] : '';
    const spuId = extractSpuId(lines);
    const detailRows = extractTrafficDetailRows(lines);
    const topRow = detailRows[0] || { date: '', exposure: '', clicks: '' };
    const image = extractTopLeftProductImage();

    return JSON.stringify({
      productTitle,
      spuId,
      date: topRow.date,
      exposure: topRow.exposure,
      clicks: topRow.clicks,
      detailRows,
      imageSrc: image?.src || '',
      imageAlt: image?.alt || '',
      imageStatus: image?.status || 'not-found-or-not-loaded',
      imageRect: image?.rect || null,
      detailUrl: location.href,
      detailTitle: document.title,
    });

    function extractSpuId(sourceLines) {
      for (let index = 0; index < sourceLines.length; index += 1) {
        const line = sourceLines[index];
        const inlineMatch = line.match(/SPU\s*(?:ID)?\s*[：:]\s*(\d+)/i);
        if (inlineMatch) {
          return inlineMatch[1];
        }

        if (/^SPU\s*(?:ID)?\s*[：:]?$/i.test(line) && /^\d+$/.test(sourceLines[index + 1] || '')) {
          return sourceLines[index + 1];
        }
      }

      return '';
    }

    function extractTrafficDetailRows(sourceLines) {
      const coordinateRows = extractTrafficDetailRowsByCoordinates();
      if (coordinateRows.length > 0) {
        return coordinateRows;
      }

      return extractTrafficDetailRowsFromText(sourceLines);
    }

    function extractTrafficDetailRowsFromText(sourceLines) {
      const startIndex = sourceLines.findIndex((line) => line === '流量明细');
      const rows = [];
      for (let index = startIndex + 1; index < sourceLines.length; index += 1) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceLines[index])) {
          continue;
        }

        const numbersAfterDate = sourceLines
          .slice(index + 1, index + 28)
          .filter((line) => /^-?\d+(?:\.\d+)?%?$/.test(line));

        rows.push({
          date: sourceLines[index],
          exposure: numbersAfterDate[0] || '',
          clicks: numbersAfterDate[1] || '',
        });
      }

      return rows;
    }

    function extractTrafficDetailRowsByCoordinates() {
      const items = visibleViewportTextItems();
      const flowHeader = items
        .filter((item) => item.text === '流量明细')
        .sort((a, b) => a.rect.top - b.rect.top)[0];
      const minTop = flowHeader ? flowHeader.rect.top : 0;

      const dateHeaders = items
        .filter((item) => item.text === '日期' && item.rect.top > minTop)
        .sort((a, b) => a.rect.top - b.rect.top);

      for (const dateHeader of dateHeaders) {
        const exposureHeader = nearestHeader(items, '曝光量', dateHeader);
        const clicksHeader = nearestHeader(items, '点击量', dateHeader);
        if (!exposureHeader || !clicksHeader) {
          continue;
        }

        const headerBottom = Math.max(
          dateHeader.rect.top + dateHeader.rect.height,
          exposureHeader.rect.top + exposureHeader.rect.height,
          clicksHeader.rect.top + clicksHeader.rect.height,
        );
        const dateItems = items
          .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.text))
          .filter((item) => item.rect.top > headerBottom - 4)
          .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
        if (dateItems.length === 0) {
          continue;
        }

        return dateItems.map((dateItem) => {
          const rowCenterY = dateItem.rect.top + dateItem.rect.height / 2;
          const rowItems = items.filter((item) => Math.abs(item.rect.top + item.rect.height / 2 - rowCenterY) < 18);
          return {
            date: dateItem.text,
            exposure: nearestNumericValue(rowItems, exposureHeader) || '',
            clicks: nearestNumericValue(rowItems, clicksHeader) || '',
          };
        });
      }

      return [];
    }

    function nearestHeader(items, text, dateHeader) {
      const dateTop = dateHeader.rect.top;
      return items
        .filter((item) => item.text === text)
        .filter((item) => item.rect.top > dateTop - 80 && item.rect.top < dateTop + 140)
        .sort((a, b) => Math.abs(a.rect.top - dateTop) - Math.abs(b.rect.top - dateTop))[0] || null;
    }

    function nearestNumericValue(rowItems, header) {
      const headerCenterX = header.rect.left + header.rect.width / 2;
      return rowItems
        .filter((item) => /^-?\d+(?:\.\d+)?%?$/.test(item.text))
        .sort((a, b) => Math.abs((a.rect.left + a.rect.width / 2) - headerCenterX) - Math.abs((b.rect.left + b.rect.width / 2) - headerCenterX))[0]
        ?.text || '';
    }

    function extractTopLeftProductImage() {
      const imageCandidates = Array.from(document.images)
        .map((imageElement) => {
          const rect = imageElement.getBoundingClientRect();
          return {
            src: imageElement.currentSrc || imageElement.src || '',
            alt: imageElement.alt || '',
            complete: imageElement.complete,
            naturalWidth: imageElement.naturalWidth,
            rect: toRect(rect),
            status: imageElement.complete && imageElement.naturalWidth > 0 ? 'loaded' : 'not-loaded',
          };
        })
        .filter((image) => isTopLeftProductImageRect(image.rect));

      if (imageCandidates.length > 0) {
        imageCandidates.sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);
        return imageCandidates[0];
      }

      const backgroundCandidates = visibleElements()
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const backgroundImage = window.getComputedStyle(element).backgroundImage;
          const match = backgroundImage.match(/url\(["']?(.*?)["']?\)/);
          return {
            src: match?.[1] || '',
            alt: element.getAttribute('aria-label') || element.getAttribute('title') || '',
            rect: toRect(rect),
            status: match?.[1] ? 'css-background' : 'placeholder-or-empty',
          };
        })
        .filter((image) => isTopLeftProductImageRect(image.rect))
        .filter((image) => image.src || image.rect.width >= 50);

      if (backgroundCandidates.length > 0) {
        backgroundCandidates.sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);
        return backgroundCandidates[0];
      }

      return null;
    }

    function isTopLeftProductImageRect(rect) {
      return rect.left >= 0 && rect.left < 180 && rect.top > 120 && rect.top < 360 && rect.width >= 30 && rect.height >= 30;
    }

    function toRect(rect) {
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }

    function visibleViewportTextItems() {
      return visibleElements()
        .map((element) => {
          const text = normalizedText(element);
          const rect = element.getBoundingClientRect();
          return { element, text, rect };
        })
        .filter((item) => item.text && item.rect.width > 0 && item.rect.height > 0)
        .filter((item) => item.rect.left >= 0 && item.rect.left < window.innerWidth)
        .filter((item) => item.rect.top >= 0 && item.rect.top < window.innerHeight + 250)
        .filter((item) => item.rect.width < window.innerWidth && item.rect.height < 240)
        .filter((item) => !hasChildWithSameText(item.element, item.text));
    }
  });
}

function buildTrafficDetailSpuScript() {
  return browserFunction(() => {
    const lines = (document.body?.innerText || '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const detailIndex = lines.findIndex((line) => line === '商品数据分析');
    const searchLines = detailIndex >= 0 ? lines.slice(detailIndex) : lines;

    for (let index = 0; index < searchLines.length; index += 1) {
      const line = searchLines[index];
      const inlineMatch = line.match(/SPU\s*(?:ID)?\s*[：:]\s*(\d+)/i);
      if (inlineMatch) {
        return inlineMatch[1];
      }

      if (/^SPU\s*(?:ID)?\s*[：:]?$/i.test(line) && /^\d+$/.test(searchLines[index + 1] || '')) {
        return searchLines[index + 1];
      }
    }

    return '';
  });
}

function buildHasTrafficDetailDataScript() {
  return browserFunction(() => {
    const lines = (document.body?.innerText || '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const startIndex = lines.findIndex((line) => line === '流量明细');
    if (startIndex < 0) {
      return false;
    }

    const dateIndex = lines.findIndex((line, index) => index > startIndex && /^\d{4}-\d{2}-\d{2}$/.test(line));
    if (dateIndex < 0) {
      return false;
    }

    const numbersAfterDate = lines
      .slice(dateIndex + 1, dateIndex + 28)
      .filter((line) => /^-?\d+(?:\.\d+)?%?$/.test(line));
    return numbersAfterDate.length >= 2;
  });
}

function buildIsTrafficDetailVisibleScript() {
  return browserFunction(() => {
    const hasTitle = visibleElements()
      .map((element) => ({ text: normalizedText(element), rect: element.getBoundingClientRect() }))
      .some(
        (item) =>
          item.text === '商品数据分析' &&
          item.rect.width < 180 &&
          item.rect.height < 60 &&
          item.rect.left >= 0 &&
          item.rect.left < window.innerWidth &&
          item.rect.top >= 0 &&
          item.rect.top < 120,
      );
    const hasFlowDetails = visibleElements()
      .map((element) => ({ text: normalizedText(element), rect: element.getBoundingClientRect() }))
      .some(
        (item) =>
          item.text === '流量明细' &&
          item.rect.width < 180 &&
          item.rect.height < 60 &&
          item.rect.left >= 0 &&
          item.rect.left < window.innerWidth &&
          item.rect.top >= 0 &&
          item.rect.top < window.innerHeight + 250,
      );

    return hasTitle && hasFlowDetails;
  });
}

function buildCloseTrafficDetailPointScript() {
  return browserFunction(() => {
    const exactClose = visibleElements()
      .filter((element) => ['×', 'x', 'X'].includes(normalizedText(element)))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.top < 220 && item.rect.left > window.innerWidth * 0.75)
      .sort((a, b) => b.rect.left - a.rect.left)[0];
    if (exactClose) {
      return viewportPointForElement(exactClose.element);
    }

    const ariaClose = visibleElements()
      .filter((element) => /close|关闭/i.test(element.getAttribute('aria-label') || element.getAttribute('title') || ''))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.top < 220 && item.rect.left > window.innerWidth * 0.75)
      .sort((a, b) => b.rect.left - a.rect.left)[0];
    if (ariaClose) {
      return viewportPointForElement(ariaClose.element);
    }

    const topRightIcon = visibleElements()
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return { element, rect, style };
      })
      .filter((item) => item.rect.top >= 0 && item.rect.top < 80)
      .filter((item) => item.rect.left > window.innerWidth * 0.92)
      .filter((item) => item.style.cursor === 'pointer' || item.element.tagName.toLowerCase() === 'svg')
      .sort((a, b) => b.rect.left - a.rect.left || a.rect.top - b.rect.top)[0];
    if (topRightIcon) {
      return viewportPointForElement(topRightIcon.element);
    }

    return { x: window.innerWidth - 14, y: 24 };
  });
}

function buildClickCloseTrafficDetailScript() {
  return browserFunction(() => {
    const candidates = visibleElements()
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return { element, rect, style };
      })
      .filter((item) => item.rect.width > 0 && item.rect.height > 0)
      .filter((item) => item.rect.top >= 0 && item.rect.top < 80)
      .filter((item) => item.rect.left > window.innerWidth - 90)
      .filter((item) => item.style.cursor === 'pointer' || item.element.tagName.toLowerCase() === 'svg')
      .sort((a, b) => b.rect.left - a.rect.left || a.rect.top - b.rect.top);
    const target = candidates.find((item) => item.element.tagName.toLowerCase() === 'svg') || candidates[0];
    if (!target) {
      return { clicked: false };
    }

    target.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { clicked: true };
  });
}

function buildDismissFeedbackPopupScript() {
  return browserFunction(() => {
    const title = findVisibleByText('您对商品流量的满意度评分', { exact: true });
    if (!title) {
      return 'feedback not shown';
    }

    const titleRect = title.getBoundingClientRect();
    const close = visibleElements()
      .filter((element) => ['×', 'x', 'X'].includes(normalizedText(element)))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.top >= titleRect.top - 40 && item.rect.top <= titleRect.top + 80)
      .filter((item) => item.rect.left > titleRect.left)
      .sort((a, b) => b.rect.left - a.rect.left)[0];

    if (!close) {
      return 'feedback close not found';
    }

    const point = viewportPointForElement(close.element);
    const target = document.elementFromPoint(point.x, point.y) || close.element;
    target.click();
    return 'feedback dismissed';
  });
}

function browserFunction(fn, ...args) {
  return `
    (() => {
      ${browserHelpers()}
      return (${fn.toString()})(...${JSON.stringify(args)});
    })();
  `;
}

function browserHelpers() {
  return String.raw`
    function visibleElements() {
      return Array.from(document.querySelectorAll('body *')).filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
    }

    function normalizedText(element) {
      return (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function findVisibleByText(text, options = {}) {
      const exact = options.exact !== false;
      const tagNames = options.tagNames || [];
      const candidates = visibleElements().filter((element) => {
        if (tagNames.length > 0 && !tagNames.includes(element.tagName)) {
          return false;
        }

        const value = normalizedText(element);
        return exact ? value === text : value.includes(text);
      });

      return candidates.sort((a, b) => area(a) - area(b))[0] || null;
    }

    function findSidebarText(text, options = {}) {
      const candidates = visibleElements()
        .filter((element) => normalizedText(element) === text)
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter((item) => item.rect.left < 360 && item.rect.top > 80);

      if (candidates.length === 0) {
        return null;
      }

      candidates.sort((a, b) => a.rect.top - b.rect.top);
      if (options.preferBottom) {
        return candidates[candidates.length - 1].element;
      }

      return candidates[0].element;
    }

    function area(element) {
      const rect = element.getBoundingClientRect();
      return rect.width * rect.height;
    }

    function viewportPointForElement(element) {
      const clickable = element.closest('a,button,[role="button"]') || element;
      clickable.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = clickable.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }

    function findSalesTrendModal() {
      const candidates = visibleElements()
        .filter((element) => {
          const text = normalizedText(element);
          return text.includes('销售趋势') && (
            text.includes('我知道了') ||
            text.includes('含已售罄SKU') ||
            text.includes('分SKU展示') ||
            text.includes('销量')
          );
        })
        .map((element) => ({ element, rect: element.getBoundingClientRect(), text: normalizedText(element) }))
        .filter((item) => {
          const rect = item.rect;
          return rect.width > 400
            && rect.height > 250
            && rect.width < window.innerWidth * 0.95
            && rect.height < window.innerHeight * 0.9
            && rect.left > 0
            && rect.top > 20
            && rect.right < window.innerWidth
            && rect.bottom < window.innerHeight;
        })
        .sort((a, b) => area(a.element) - area(b.element));
      return candidates[0]?.element || null;
    }

    function salesTrendCanvasesForModal(modal) {
      const modalRect = modal.getBoundingClientRect();
      return Array.from(document.querySelectorAll('canvas')).filter((canvas) => {
        const rect = canvas.getBoundingClientRect();
        return rect.width > 0
          && rect.height > 0
          && rect.left >= modalRect.left - 8
          && rect.top >= modalRect.top - 8
          && rect.right <= modalRect.right + 8
          && rect.bottom <= modalRect.bottom + 8;
      });
    }

    function collectVisibleSkuSalesRowsByCoordinates(options = {}) {
      const textItems = visibleTextItems();
      const todayHeader = findHeaderItem(textItems, '今日');
      if (!todayHeader) {
        return [];
      }

      const todayX = centerX(todayHeader.rect);
      const skuItems = textItems
        .map((item) => ({ ...item, skuMatch: item.text.match(/^SKU\s*ID\s*[:：]\s*(\d+)$/i) }))
        .filter((item) => item.skuMatch)
        .sort((a, b) => a.rect.top - b.rect.top);
      const skcCargoItems = textItems
        .map((item) => ({ ...item, skcCargoMatch: item.text.match(/^SKC货号\s*[:：]\s*(.+)$/) }))
        .filter((item) => item.skcCargoMatch)
        .sort((a, b) => a.rect.top - b.rect.top);
      const spuItems = textItems
        .map((item) => ({ ...item, spuMatch: item.text.match(/^SPU\s*[:：]\s*(\d+)$/i) }))
        .filter((item) => item.spuMatch)
        .sort((a, b) => a.rect.top - b.rect.top);
      const totalItems = textItems
        .filter((item) => item.text === '合计')
        .sort((a, b) => a.rect.top - b.rect.top);

      if (spuItems.length === 0 || totalItems.length === 0) {
        return [];
      }

      const records = [];
      let recordIndex = 0;
      let previousTotalY = -Infinity;
      for (const totalItem of totalItems) {
        const totalY = centerY(totalItem.rect);
        const groupedSpuItems = spuItems.filter((spuItem) => {
          const spuY = centerY(spuItem.rect);
          return spuY > previousTotalY && spuY < totalY;
        });
        const groupedSkcCargoItems = skcCargoItems.filter((skcCargoItem) => {
          const skcCargoY = centerY(skcCargoItem.rect);
          return skcCargoY > previousTotalY && skcCargoY < totalY;
        });
        const groupedSkus = skuItems.filter((skuItem) => {
          const skuY = centerY(skuItem.rect);
          return skuY > previousTotalY && skuY < totalY;
        });

        if (groupedSpuItems.length === 0) {
          previousTotalY = totalY;
          continue;
        }

        const todayCell = findCellAtColumn(textItems, totalItem.rect, todayX);
        const totalRowText = buildRowText(textItems, totalItem.rect);
        const skuIds = Array.from(new Set(groupedSkus.map((skuItem) => skuItem.skuMatch[1])));
        const skcCargoNos = Array.from(new Set(groupedSkcCargoItems.map((skcCargoItem) => skcCargoItem.skcCargoMatch[1].trim())));
        const uniqueSpuItems = uniqueItemsBy(groupedSpuItems, (spuItem) => spuItem.spuMatch[1]);
        for (let spuIndex = 0; spuIndex < uniqueSpuItems.length; spuIndex += 1) {
          const spuItem = uniqueSpuItems[spuIndex];
          const salesTrendItem = findSalesTrendItemForSpu(textItems, previousTotalY, totalY, uniqueSpuItems, spuIndex);
          const spuId = spuItem.spuMatch[1];
          const shouldScrollTrendPoint = options.scrollTrendPointSpuId === spuId;
          records.push({
            spuId,
            skuIds,
            skcCargoNos,
            todaySales: todayCell?.text || '',
            productText: buildNearbyText(textItems, spuItem.rect),
            totalRowText,
            hasSalesTrend: Boolean(salesTrendItem),
            salesTrendPoint: salesTrendItem
              ? (shouldScrollTrendPoint ? viewportPointForElement(salesTrendItem.element) : viewportPointForVisibleElement(salesTrendItem.element))
              : null,
            source: 'cdp-coordinate-total-row',
          });
          recordIndex += 1;
        }

        previousTotalY = totalY;
      }

      return records;
    }

    function findSalesTrendItemForSpu(textItems, groupTopY, groupBottomY, spuItems, spuIndex) {
      const current = spuItems[spuIndex];
      const currentY = centerY(current.rect);
      const previous = spuItems[spuIndex - 1];
      const next = spuItems[spuIndex + 1];
      const rowTopY = previous ? (centerY(previous.rect) + currentY) / 2 : groupTopY;
      const rowBottomY = next ? (currentY + centerY(next.rect)) / 2 : groupBottomY;

      const candidates = textItems
        .filter((item) => item.text === '销售趋势')
        .filter((item) => {
          const y = centerY(item.rect);
          return y > rowTopY && y < rowBottomY;
        })
        .sort((a, b) => b.rect.left - a.rect.left || a.rect.top - b.rect.top);
      return candidates[0] || null;
    }

    function viewportPointForVisibleElement(element) {
      const clickable = element.closest('a,button,[role="button"]') || element;
      const rect = clickable.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }

    function uniqueItemsBy(items, keyFn) {
      const seen = new Set();
      const unique = [];
      for (const item of items) {
        const key = keyFn(item);
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        unique.push(item);
      }

      return unique;
    }

    function trafficDetailButtons() {
      return trafficDetailRows().map((row) => row.element);
    }

    function trafficDetailRows() {
      const seen = new Set();
      return visibleElements()
        .filter((element) => normalizedText(element) === '查看详情')
        .map((element) => {
          const clickable = element.closest('a,button,[role="button"]') || element;
          const productRow = findProductRowForElement(clickable);
          const rect = clickable.getBoundingClientRect();
          return {
            element: clickable,
            productRow,
            rect,
            documentTop: rect.top + window.scrollY,
            documentLeft: rect.left + window.scrollX,
          };
        })
        .filter((item) => item.productRow)
        .filter((item) => item.rect.width > 0 && item.rect.height > 0)
        .filter((item) => item.rect.width <= 90 && item.rect.height <= 32)
        .filter((item) => item.rect.left > window.innerWidth * 0.55)
        .filter((item) => {
          const key = String(Math.round(item.documentLeft)) + ':' + String(Math.round(item.documentTop));
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        })
        .sort((a, b) => a.documentTop - b.documentTop || a.documentLeft - b.documentLeft)
        .map((item) => {
          const productInfo = collectTrafficListProductInfo(item.productRow, item.rect);
          return {
            element: item.element,
            productTitle: productInfo.productTitle,
            spuId: productInfo.spuId,
            exposure: productInfo.exposure,
            clicks: productInfo.clicks,
            imageSrc: productInfo.imageSrc,
            imageAlt: productInfo.imageAlt,
            imageStatus: productInfo.imageStatus,
            imageRect: productInfo.imageRect,
          };
        });
    }

    function findProductRowForElement(element) {
      let current = element;
      for (let depth = 0; current && current !== document.body && depth < 10; depth += 1) {
        const text = normalizedText(current);
        if (/SPU\s*[：:]\s*\d+/.test(text) || /SPU\s*[：:]\s+\d+/.test(text)) {
          return current;
        }

        current = current.parentElement;
      }

      return null;
    }

    function collectTrafficListProductInfo(rowElement, detailButtonRect) {
      const rowText = normalizedText(rowElement);
      const spuId = rowText.match(/SPU\s*[：:]\s*(\d+)/)?.[1] || '';
      const nameElement = rowElement.querySelector('[class*="goodsName"], [class*="goodsItem"]');
      const productTitle = normalizedText(nameElement) || rowText.split(' 办公用品')[0] || rowText.split(' 健康和家居用品')[0] || '';
      const numericItems = Array.from(rowElement.querySelectorAll('*'))
        .map((element) => {
          const text = normalizedText(element);
          const rect = element.getBoundingClientRect();
          return { element, text, rect };
        })
        .filter((item) => /^-?\d+(?:\.\d+)?$/.test(item.text))
        .filter((item) => item.rect.width > 0 && item.rect.height > 0)
        .filter((item) => item.rect.left > 600)
        .sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);
      const image = collectTrafficListRowImage(rowElement, detailButtonRect);

      return {
        productTitle,
        spuId,
        exposure: numericItems[0]?.text || '',
        clicks: numericItems[1]?.text || '',
        imageSrc: image.src,
        imageAlt: image.alt,
        imageStatus: image.status,
        imageRect: image.rect,
      };
    }

    function collectTrafficListRowImage(rowElement, detailButtonRect) {
      const imageElement = rowElement.querySelector('img');
      if (imageElement) {
        const rect = imageElement.getBoundingClientRect();
        return {
          src: imageElement.currentSrc || imageElement.src || '',
          alt: imageElement.alt || '',
          status: imageElement.complete && imageElement.naturalWidth > 0 ? 'loaded' : 'not-loaded',
          rect: toPlainRect(rect),
        };
      }

      const targetY = centerY(detailButtonRect);
      const nearbyImage = Array.from(document.images)
        .map((image) => {
          const rect = image.getBoundingClientRect();
          return { image, rect };
        })
        .filter((item) => item.rect.width > 20 && item.rect.height > 20)
        .filter((item) => item.rect.left > 240 && item.rect.left < 460)
        .filter((item) => Math.abs(centerY(item.rect) - targetY) < 70)
        .sort((a, b) => Math.abs(centerY(a.rect) - targetY) - Math.abs(centerY(b.rect) - targetY))[0];
      if (nearbyImage) {
        return {
          src: nearbyImage.image.currentSrc || nearbyImage.image.src || '',
          alt: nearbyImage.image.alt || '',
          status: nearbyImage.image.complete && nearbyImage.image.naturalWidth > 0 ? 'loaded' : 'not-loaded',
          rect: toPlainRect(nearbyImage.rect),
        };
      }

      const nearbyBackground = visibleElements()
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const backgroundImage = window.getComputedStyle(element).backgroundImage;
          const match = backgroundImage.match(/url\(["']?(.*?)["']?\)/);
          return { element, rect, src: match?.[1] || '' };
        })
        .filter((item) => item.src)
        .filter((item) => item.rect.width > 20 && item.rect.height > 20)
        .filter((item) => item.rect.left > 240 && item.rect.left < 460)
        .filter((item) => Math.abs(centerY(item.rect) - targetY) < 70)
        .sort((a, b) => Math.abs(centerY(a.rect) - targetY) - Math.abs(centerY(b.rect) - targetY))[0];
      if (nearbyBackground) {
        return {
          src: nearbyBackground.src,
          alt: nearbyBackground.element.getAttribute('aria-label') || nearbyBackground.element.getAttribute('title') || '',
          status: 'css-background',
          rect: toPlainRect(nearbyBackground.rect),
        };
      }

      return { src: '', alt: '', status: 'not-found-or-not-loaded', rect: null };
    }

    function toPlainRect(rect) {
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }

    function visibleTextItems() {
      return visibleElements()
        .map((element) => {
          const text = normalizedText(element);
          const rect = element.getBoundingClientRect();
          return { element, text, rect };
        })
        .filter((item) => item.text && item.rect.width > 0 && item.rect.height > 0)
        .filter((item) => item.rect.width < 520 && item.rect.height < 140)
        .filter((item) => !hasChildWithSameText(item.element, item.text));
    }

    function hasChildWithSameText(element, text) {
      return Array.from(element.children || []).some((child) => normalizedText(child) === text);
    }

    function findHeaderItem(textItems, text) {
      return textItems
        .filter((item) => item.text === text || item.text.startsWith(text + ' '))
        .filter((item) => item.rect.top > 80)
        .sort((a, b) => {
          const aScore = Math.abs(a.rect.top - 230) + Math.abs(centerX(a.rect) - window.innerWidth / 2);
          const bScore = Math.abs(b.rect.top - 230) + Math.abs(centerX(b.rect) - window.innerWidth / 2);
          return aScore - bScore;
        })[0] || null;
    }

    function findCellAtColumn(textItems, rowRect, targetX) {
      const rowCenterY = centerY(rowRect);
      const yTolerance = Math.max(18, rowRect.height * 0.8);
      const candidates = textItems
        .filter((item) => item.text !== '合计')
        .filter((item) => /^-?\d+(?:\.\d+)?$|^-$/.test(item.text))
        .filter((item) => Math.abs(centerY(item.rect) - rowCenterY) <= yTolerance)
        .sort((a, b) => Math.abs(centerX(a.rect) - targetX) - Math.abs(centerX(b.rect) - targetX));

      return candidates[0] || null;
    }

    function buildRowText(textItems, rowRect) {
      const rowCenterY = centerY(rowRect);
      const yTolerance = Math.max(18, rowRect.height * 0.8);
      return textItems
        .filter((item) => Math.abs(centerY(item.rect) - rowCenterY) <= yTolerance)
        .sort((a, b) => a.rect.left - b.rect.left)
        .map((item) => item.text)
        .join(' | ');
    }

    function buildNearbyText(textItems, rect) {
      const y = centerY(rect);
      return textItems
        .filter((item) => Math.abs(centerY(item.rect) - y) < 180)
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
        .map((item) => item.text)
        .slice(0, 30)
        .join(' | ');
    }

    function centerX(rect) {
      return rect.left + rect.width / 2;
    }

    function centerY(rect) {
      return rect.top + rect.height / 2;
    }
  `;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function humanPause(label, config) {
  const delayMs = randomHumanDelayMs(config);
  console.log(`Human-like pause before ${label}: ${(delayMs / 1000).toFixed(1)} seconds`);
  await sleep(delayMs);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
