import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  clickChromeScreenPoint,
  executeChromeJavascript,
  findSellerEntryTab,
  findSellerHomeTab,
} from './chrome_automation.js';
import { parseHumanDelayConfig, randomHumanDelayMs } from './human_timing.js';

const DEFAULT_WAIT_MS = 15 * 1000;
const DEFAULT_MANUAL_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const OUTPUT_PATH = 'output/sales-data.json';
const SALES_MANAGEMENT_PATH = '/stock/fully-mgt/sale-manage/main';

async function main() {
  const entryTab = await waitForSellerEntryTab();
  if (!entryTab) {
    console.error('Seller Central entry tab not found before timeout. Please finish manual login first.');
    process.exitCode = 1;
    return;
  }

  console.log(`Seller Central entry tab detected: ${entryTab.url}`);
  if (!entryTab.url.startsWith('https://agentseller.temu.com')) {
    console.log('Step 2 reached: fulfillment center entry page detected. Waiting for you to click 进入 manually...');
  }

  let sellerTab = await waitForSellerHomeTabAfterEntry();
  if (!sellerTab) {
    console.error('Seller Central home tab not found after entry page. Please click 进入 manually and check Chrome.');
    process.exitCode = 1;
    return;
  }

  const waitMs = Number.parseInt(process.env.SELLER_HOME_WAIT_MS || `${DEFAULT_WAIT_MS}`, 10);
  const humanDelayConfig = parseHumanDelayConfig(process.env);
  console.log(`Seller Central home tab detected: ${sellerTab.url}`);
  console.log(`Waiting ${Math.round(waitMs / 1000)} seconds before collecting sales data...`);
  await sleep(waitMs);

  if (await isSalesManagePage(sellerTab)) {
    console.log('Step 1: already on sales management page; skipping sidebar navigation.');
  } else {
    const childLinkVisible = await executeStep(sellerTab, buildHasSalesChildLinkScript());
    if (childLinkVisible !== 'true') {
      console.log('Step 1: opening left sidebar parent menu: 销售管理');
      await humanPause('opening sales management parent menu', humanDelayConfig);
      await nativeClickElement(sellerTab, buildSalesParentPointScript());
      await sleep(1500);
    } else {
      console.log('Step 1: sales management child menu is already visible.');
    }

    console.log('Step 2: clicking child menu: 销售管理');
    await humanPause('opening sales management child menu', humanDelayConfig);
    await nativeClickElement(sellerTab, buildSalesChildPointScript());

    const navigated = await waitForSalesManagePage(sellerTab, 30000);
    if (!navigated) {
      throw new Error('销售管理页面未打开：真实点击后没有进入销售管理页面');
    }
  }

  sellerTab = await refreshSellerTab(sellerTab);
  console.log('Waiting for sales table data to appear...');
  const tableReady = await waitForSalesTableData(sellerTab, 60000);
  if (!tableReady) {
    throw new Error('销售管理页面已打开，但没有在限定时间内看到 SKU ID 和合计行');
  }

  sellerTab = await refreshSellerTab(sellerTab);
  console.log('Step 3: checking whether the guide dialog appears');
  await humanPause('checking for guide dialog', humanDelayConfig);
  const guideResult = await executeStep(sellerTab, buildDismissGuideScript());
  console.log(`Guide dialog result: ${guideResult}`);

  sellerTab = await refreshSellerTab(sellerTab);
  console.log('Step 4: reading visible SKU IDs and total-row today sales');
  await humanPause('reading SKU sales table', humanDelayConfig);
  const rawResult = await executeStep(sellerTab, buildCollectSalesDataScript());
  const result = JSON.parse(rawResult);

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`);

  console.log(`Collected ${result.records.length} visible SKU rows.`);
  console.log(`Saved: ${OUTPUT_PATH}`);

  for (const record of result.records) {
    console.log(`SKU ID ${record.skuId}: today sales ${record.todaySales}`);
  }
}

async function waitForSellerEntryTab() {
  const timeoutMs = Number.parseInt(
    process.env.MANUAL_LOGIN_TIMEOUT_MS || `${DEFAULT_MANUAL_LOGIN_TIMEOUT_MS}`,
    10,
  );
  const deadline = Date.now() + timeoutMs;

  console.log(`Waiting up to ${Math.round(timeoutMs / 1000)} seconds for Chrome to reach Seller Central entry...`);
  while (Date.now() < deadline) {
    const entryTab = await findSellerEntryTab();
    if (entryTab) {
      return entryTab;
    }

    console.log('Seller Central entry not detected yet. Please complete manual login in Chrome...');
    await sleep(POLL_INTERVAL_MS);
  }

  return null;
}

async function waitForSellerHomeTabAfterEntry() {
  const timeoutMs = Number.parseInt(process.env.SELLER_HOME_AFTER_ENTRY_TIMEOUT_MS || '120000', 10);
  const deadline = Date.now() + timeoutMs;

  console.log(`Waiting up to ${Math.round(timeoutMs / 1000)} seconds for agentseller.temu.com...`);
  while (Date.now() < deadline) {
    const sellerTab = await findSellerHomeTab();
    if (sellerTab) {
      return sellerTab;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return null;
}

async function executeStep(tab, source) {
  try {
    return await executeChromeJavascript(tab, source);
  } catch (error) {
    if (!isStaleChromeTabError(error)) {
      throw error;
    }

    const refreshedTab = await findSellerHomeTab();
    if (!refreshedTab) {
      throw error;
    }

    return executeChromeJavascript(refreshedTab, source);
  }
}

async function refreshSellerTab(previousTab) {
  return (await findSellerHomeTab()) || previousTab;
}

function isStaleChromeTabError(error) {
  const message = error?.message || '';
  return message.includes('无效的索引') || message.includes('invalid index') || message.includes('不能获得');
}

async function nativeClickElement(tab, pointScript) {
  const currentTab = await refreshSellerTab(tab);
  const rawPoint = await executeStep(currentTab, pointScript);
  if (!rawPoint || rawPoint === 'missing value') {
    throw new Error('没有找到可点击元素坐标，无法执行真实鼠标点击');
  }

  const point = JSON.parse(rawPoint);
  await clickChromeScreenPoint(currentTab, point);
}

async function waitForSalesManagePage(tab, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentUrl = await executeStep(tab, 'location.href');
    if (currentUrl.includes(SALES_MANAGEMENT_PATH)) {
      console.log(`Sales management page detected: ${currentUrl}`);
      return true;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return false;
}

async function isSalesManagePage(tab) {
  const currentUrl = await executeStep(tab, 'location.href');
  return currentUrl.includes(SALES_MANAGEMENT_PATH);
}

async function waitForSalesTableData(tab, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await executeStep(
      tab,
      `(location.href.includes("${SALES_MANAGEMENT_PATH}") && document.body.innerText.includes("SKU ID") && document.body.innerText.includes("合计")) ? "true" : "false"`,
    );
    if (ready === 'true') {
      console.log('Sales table data detected.');
      return true;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return false;
}

function buildClickSalesParentScript() {
  return browserFunction(() => {
    const element = findSidebarText('销售管理', { preferTop: true });
    if (!element) {
      throw new Error('未找到左侧一级菜单：销售管理');
    }

    clickElementCenter(element);
    return 'clicked sales parent';
  });
}

function buildSalesParentPointScript() {
  return browserFunction(() => {
    const element = findSidebarText('销售管理', { preferTop: true });
    if (!element) {
      throw new Error('未找到左侧一级菜单：销售管理');
    }

    return JSON.stringify(screenPointForElement(element));
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

    return JSON.stringify(screenPointForElement(element));
  });
}

function buildHasSalesChildLinkScript() {
  return browserFunction(() => (document.querySelector('a[href="/stock/fully-mgt/sale-manage/main"]') ? 'true' : 'false'));
}

function buildDismissGuideScript() {
  return browserFunction(() => {
    const button = findVisibleByText('我知道了', { exact: true, tagNames: ['BUTTON', 'DIV', 'SPAN'] });
    if (!button) {
      return 'guide not shown';
    }

    clickElementCenter(button);
    return 'dismissed guide';
  });
}

function buildCollectSalesDataScript() {
  return browserFunction(() => {
    const records = collectVisibleSkuSalesRows();
    return JSON.stringify({
      collectedAt: new Date().toISOString(),
      url: location.href,
      title: document.title,
      records,
    });
  });
}

function browserFunction(fn) {
  return `
    (() => {
      ${browserHelpers()}
      return (${fn.toString()})();
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

    function clickElementCenter(element) {
      const clickable = element.closest('button,[role="button"],a') || element;
      const rect = clickable.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) || clickable;
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }

    function clickNavigationElement(element) {
      const clickable = element.closest('a,button,[role="button"]') || element;
      clickable.scrollIntoView({ block: 'center', inline: 'center' });
      if (typeof clickable.click === 'function') {
        clickable.click();
        return;
      }

      clickElementCenter(clickable);
    }

    function screenPointForElement(element) {
      const clickable = element.closest('a,button,[role="button"]') || element;
      clickable.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = clickable.getBoundingClientRect();
      const viewportLeft = window.screenX + (window.outerWidth - window.innerWidth) / 2;
      const viewportTop = window.screenY + (window.outerHeight - window.innerHeight);
      return {
        x: viewportLeft + rect.left + rect.width / 2,
        y: viewportTop + rect.top + rect.height / 2,
      };
    }

    function collectVisibleSkuSalesRows() {
      const coordinateRecords = collectVisibleSkuSalesRowsByCoordinates();
      if (coordinateRecords.length > 0) {
        return coordinateRecords;
      }

      return collectVisibleSkuSalesRowsFromText();
    }

    function collectVisibleSkuSalesRowsByCoordinates() {
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
      const totalItems = textItems
        .filter((item) => item.text === '合计')
        .sort((a, b) => a.rect.top - b.rect.top);

      if (skuItems.length === 0 || totalItems.length === 0) {
        return [];
      }

      const records = [];
      let previousTotalY = -Infinity;
      for (const totalItem of totalItems) {
        const totalY = centerY(totalItem.rect);
        const groupedSkus = skuItems.filter((skuItem) => {
          const skuY = centerY(skuItem.rect);
          return skuY > previousTotalY && skuY < totalY;
        });

        if (groupedSkus.length === 0) {
          previousTotalY = totalY;
          continue;
        }

        const todayCell = findCellAtColumn(textItems, totalItem.rect, todayX);
        const totalRowText = buildRowText(textItems, totalItem.rect);
        for (const skuItem of groupedSkus) {
          records.push({
            skuId: skuItem.skuMatch[1],
            todaySales: todayCell?.text || '',
            productText: buildNearbyText(textItems, skuItem.rect),
            totalRowText,
            source: 'coordinate-total-row',
          });
        }

        previousTotalY = totalY;
      }

      return records;
    }

    function visibleTextItems() {
      return visibleElements()
        .map((element) => {
          const text = normalizedTextFromInnerText(element);
          const rect = element.getBoundingClientRect();
          return { element, text, rect };
        })
        .filter((item) => item.text && item.rect.width > 0 && item.rect.height > 0)
        .filter((item) => item.rect.width < 500 && item.rect.height < 120)
        .filter((item) => !hasChildWithSameText(item.element, item.text));
    }

    function normalizedTextFromInnerText(element) {
      return (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function hasChildWithSameText(element, text) {
      return Array.from(element.children || []).some((child) => normalizedTextFromInnerText(child) === text);
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

    function collectVisibleSkuSalesRowsFromText() {
      const lines = (document.body.innerText || '')
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);

      const records = [];
      for (let index = 0; index < lines.length; index += 1) {
        const skuMatch = lines[index].match(/^SKU\s*ID\s*[:：]\s*(\d+)$/i);
        if (!skuMatch) {
          continue;
        }

        const nextSkuIndex = lines.findIndex((line, offset) => offset > index && /^SKU\s*ID\s*[:：]\s*\d+$/i.test(line));
        const searchEndIndex = nextSkuIndex > index ? nextSkuIndex : Math.min(lines.length, index + 120);
        const totalIndex = lines.findIndex((line, offset) => offset > index && offset < searchEndIndex && line === '合计');
        const totalValues = totalIndex >= 0 ? lines.slice(totalIndex + 1, totalIndex + 30) : [];

        records.push({
          skuId: skuMatch[1],
          todaySales: totalValues[2] || '',
          productText: lines.slice(Math.max(0, index - 8), index + 8).join(' | '),
          totalRowText: totalIndex >= 0 ? ['合计', ...totalValues].join(' | ') : '',
        });
      }

      return records;
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
