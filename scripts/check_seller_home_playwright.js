import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const TARGET_URL = 'https://agentseller.temu.com/';
const OUTPUT_SCREENSHOT = 'output/playwright/check-seller-home-playwright.png';

async function main() {
  await mkdir('output/playwright', { recursive: true });

  const context = await chromium.launchPersistentContext('output/playwright/playwright-check-profile', {
    headless: process.env.HEADLESS === '1',
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  });

  const page = context.pages()[0] || (await context.newPage());

  try {
    console.log(`Opening ${TARGET_URL} in Playwright Chrome for Testing...`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(5000);

    const url = page.url();
    const title = await page.title();
    const bodyText = await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '');
    const detected = /Seller Central|欢迎来到Seller central|销售管理|首页/.test(bodyText);

    await page.screenshot({ path: OUTPUT_SCREENSHOT, fullPage: true }).catch(() => {});

    console.log(`Final URL: ${url}`);
    console.log(`Title: ${title}`);
    console.log(`Detected Seller Central UI: ${detected ? 'yes' : 'no'}`);
    console.log(`Screenshot: ${OUTPUT_SCREENSHOT}`);

    if (!detected) {
      const preview = bodyText.replace(/\s+/g, ' ').slice(0, 500);
      console.log(`Page text preview: ${preview}`);
      process.exitCode = 1;
    }
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
