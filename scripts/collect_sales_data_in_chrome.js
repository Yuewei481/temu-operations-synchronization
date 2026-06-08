import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { executeChromeJavascript, findSellerHomeTab } from './chrome_automation.js';
import { parseHumanDelayConfig, randomHumanDelayMs } from './human_timing.js';

const DEFAULT_WAIT_MS = 2 * 60 * 1000;
const OUTPUT_PATH = 'output/sales-data.json';

async function main() {
  const sellerTab = await findSellerHomeTab();
  if (!sellerTab) {
    console.error('Seller Central home tab not found. Please finish manual login first.');
    process.exitCode = 1;
    return;
  }

  const waitMs = Number.parseInt(process.env.SELLER_HOME_WAIT_MS || `${DEFAULT_WAIT_MS}`, 10);
  const humanDelayConfig = parseHumanDelayConfig(process.env);
  console.log(`Seller Central home tab detected: ${sellerTab.url}`);
  console.log(`Waiting ${Math.round(waitMs / 1000)} seconds before collecting sales data...`);
  await sleep(waitMs);

  await humanPause('opening sales management parent menu', humanDelayConfig);
  await executeStep(sellerTab, buildClickSalesParentScript());
  await humanPause('opening sales management child menu', humanDelayConfig);
  await executeStep(sellerTab, buildClickSalesChildScript());
  await humanPause('checking for guide dialog', humanDelayConfig);
  await executeStep(sellerTab, buildDismissGuideScript());

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

async function executeStep(tab, source) {
  return executeChromeJavascript(tab, source);
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

function buildClickSalesChildScript() {
  return browserFunction(() => {
    const element = findSidebarText('销售管理', { preferBottom: true });
    if (!element) {
      throw new Error('未找到销售管理子菜单：销售管理');
    }

    clickElementCenter(element);
    return 'clicked sales child';
  });
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
      return (element.textContent || '').replace(/\s+/g, ' ').trim();
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
      const clickable = element.closest('button,[role="button"],a,div') || element;
      const rect = clickable.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) || clickable;
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }

    function collectVisibleSkuSalesRows() {
      const rows = Array.from(document.querySelectorAll('tr'))
        .map((row) => ({ row, text: normalizedText(row), rect: row.getBoundingClientRect() }))
        .filter((item) => item.rect.width > 0 && item.rect.height > 0);

      const records = [];
      for (let index = 0; index < rows.length; index += 1) {
        const skuMatch = rows[index].text.match(/SKU\s*ID\s*[:：]?\s*(\d+)/i);
        if (!skuMatch) {
          continue;
        }

        const skuId = skuMatch[1];
        const totalRow = rows.slice(index + 1, index + 6).find((candidate) => /(^|\s)合计(\s|$)/.test(candidate.text));
        const todaySales = totalRow ? extractTodaySalesFromTotalRow(totalRow.row) : '';

        records.push({
          skuId,
          todaySales,
          productText: rows[index].text,
          totalRowText: totalRow?.text || '',
        });
      }

      if (records.length > 0) {
        return records;
      }

      return collectVisibleSkuSalesRowsFromText();
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

    function collectVisibleSkuSalesRowsFromText() {
      const bodyText = normalizedText(document.body);
      const chunks = bodyText.split(/(?=SKU\s*ID\s*[:：]?\s*\d+)/i);
      return chunks
        .map((chunk) => {
          const skuMatch = chunk.match(/SKU\s*ID\s*[:：]?\s*(\d+)/i);
          if (!skuMatch) {
            return null;
          }

          const totalMatch = chunk.match(/合计\s+[-–—]\s+(-?\d+|-) /) || chunk.match(/合计\s+[-–—]?\s*(-?\d+|-)/);
          return {
            skuId: skuMatch[1],
            todaySales: totalMatch?.[1] || '',
            productText: chunk.slice(0, 500),
            totalRowText: totalMatch?.[0] || '',
          };
        })
        .filter(Boolean);
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
