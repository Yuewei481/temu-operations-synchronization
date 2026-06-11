import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { DEFAULT_LOGIN_URL } from './config.js';
import { parseHumanDelayConfig, randomHumanDelayMs } from './human_timing.js';

const DEFAULT_WAIT_MS = 2 * 60 * 1000;
const DEFAULT_MANUAL_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_PATH = 'output/sales-data-playwright.json';
const PROFILE_DIR = 'output/playwright/playwright-manual-profile';

async function main() {
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await mkdir(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    slowMo: 80,
  });

  const page = context.pages()[0] || (await context.newPage());

  try {
    console.log('Opening Seller Center login page in Playwright Chrome...');
    await page.goto(DEFAULT_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    console.log('Please log in manually in the Playwright browser window.');

    const sellerPage = await waitForSellerHomePage(context);
    console.log(`Seller Central home detected: ${sellerPage.url()}`);

    const waitMs = Number.parseInt(process.env.SELLER_HOME_WAIT_MS || `${DEFAULT_WAIT_MS}`, 10);
    const humanDelayConfig = parseHumanDelayConfig(process.env);
    console.log(`Waiting ${Math.round(waitMs / 1000)} seconds before collecting sales data...`);
    await sleep(waitMs);

    console.log('Step 1: opening left sidebar parent menu: 销售管理');
    await humanPause('opening sales management parent menu', humanDelayConfig);
    await clickVisibleText(sellerPage, '销售管理', { preferFirst: true });

    console.log('Step 2: clicking child menu: 销售管理');
    await humanPause('opening sales management child menu', humanDelayConfig);
    await clickVisibleText(sellerPage, '销售管理', { preferLast: true });
    await sellerPage.waitForTimeout(3000);

    console.log('Step 3: checking whether the guide dialog appears');
    await humanPause('checking for guide dialog', humanDelayConfig);
    const guideButton = sellerPage.getByText('我知道了', { exact: true }).last();
    if (await guideButton.isVisible().catch(() => false)) {
      await guideButton.click();
      console.log('Guide dialog result: dismissed guide');
    } else {
      console.log('Guide dialog result: guide not shown');
    }

    console.log('Step 4: reading visible SKU IDs and total-row today sales');
    await humanPause('reading SKU sales table', humanDelayConfig);
    const result = await sellerPage.evaluate(collectVisibleSkuSalesData);

    await writeFile(OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Collected ${result.records.length} visible SKU rows.`);
    console.log(`Saved: ${OUTPUT_PATH}`);

    for (const record of result.records) {
      console.log(`SKU ID ${record.skuId}: today sales ${record.todaySales}`);
    }
  } finally {
    if (process.env.KEEP_BROWSER_OPEN !== '1') {
      await context.close();
    } else {
      console.log('Browser left open because KEEP_BROWSER_OPEN=1.');
    }
  }
}

async function waitForSellerHomePage(context) {
  const timeoutMs = Number.parseInt(
    process.env.MANUAL_LOGIN_TIMEOUT_MS || `${DEFAULT_MANUAL_LOGIN_TIMEOUT_MS}`,
    10,
  );
  const deadline = Date.now() + timeoutMs;

  console.log(`Waiting up to ${Math.round(timeoutMs / 1000)} seconds for https://agentseller.temu.com/...`);
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      if (page.url().startsWith('https://agentseller.temu.com')) {
        await page.bringToFront();
        return page;
      }
    }

    await sleep(3000);
    console.log('Seller Central home not detected yet. Please complete manual login and click 进入 if needed...');
  }

  throw new Error('Timed out waiting for agentseller.temu.com in Playwright browser.');
}

async function clickVisibleText(page, text, options = {}) {
  const locator = page.getByText(text, { exact: true });
  const count = await locator.count();
  const indexes = Array.from({ length: count }, (_, index) => index);
  if (options.preferLast) {
    indexes.reverse();
  }

  for (const index of indexes) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }

    const box = await candidate.boundingBox();
    if (!box) {
      continue;
    }

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return;
  }

  throw new Error(`Visible text not found: ${text}`);
}

async function humanPause(label, config) {
  const delayMs = randomHumanDelayMs(config);
  console.log(`Human-like pause before ${label}: ${(delayMs / 1000).toFixed(1)} seconds`);
  await sleep(delayMs);
}

function collectVisibleSkuSalesData() {
  function normalizedText(element) {
    return (element.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function extractTodaySalesFromTotalRow(row) {
    const cells = Array.from(row.querySelectorAll('td,[role="cell"],.semi-table-row-cell,.TB_cell_5-116-1'))
      .map((cell) => normalizedText(cell))
      .filter(Boolean);
    const totalIndex = cells.findIndex((cell) => cell === '合计');
    const rightSide = totalIndex >= 0 ? cells.slice(totalIndex + 1) : cells;
    const number = rightSide.find((cell) => /^-?\d+(?:\.\d+)?$|^-$/.test(cell));
    return number || '';
  }

  const rows = Array.from(document.querySelectorAll('tr'))
    .map((row) => ({ row, text: normalizedText(row), rect: row.getBoundingClientRect() }))
    .filter((item) => item.rect.width > 0 && item.rect.height > 0);

  const records = [];
  for (let index = 0; index < rows.length; index += 1) {
    const skuMatch = rows[index].text.match(/SKU\s*ID\s*[:：]?\s*(\d+)/i);
    if (!skuMatch) {
      continue;
    }

    const totalRow = rows.slice(index + 1, index + 6).find((candidate) => /(^|\s)合计(\s|$)/.test(candidate.text));
    records.push({
      skuId: skuMatch[1],
      todaySales: totalRow ? extractTodaySalesFromTotalRow(totalRow.row) : '',
      productText: rows[index].text,
      totalRowText: totalRow?.text || '',
    });
  }

  return {
    collectedAt: new Date().toISOString(),
    url: location.href,
    title: document.title,
    records,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
