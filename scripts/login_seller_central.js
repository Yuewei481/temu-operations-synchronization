import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { loadEnvFile, readSellerConfig } from './config.js';

const FIVE_MINUTES = 5 * 60 * 1000;
const THIRTY_SECONDS = 30 * 1000;

async function main() {
  const env = { ...process.env, ...(await loadEnvFile('.env')) };
  const config = readSellerConfig(env);

  await mkdir(dirname(config.screenshotPath), { recursive: true });
  await mkdir(dirname(config.storageStatePath), { recursive: true });
  await mkdir(config.userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(config.userDataDir, {
    channel: config.browserChannel || undefined,
    headless: config.headless,
    slowMo: config.headless ? 0 : 80,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  });
  closeProtocolPages(context);

  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: THIRTY_SECONDS });
    await switchToPhoneLogin(page);
    await selectCountryCode(page, config.countryCode);
    await fillLoginForm(page, config);
    await submitLogin(page);

    await waitForFulfillmentCenter(page);
    const sellerPage = await enterSellerCentral(context, page);
    await waitForSellerCentralHome(sellerPage);

    await context.storageState({ path: config.storageStatePath });
    console.log(`Seller Central page opened: ${sellerPage.url()}`);
    console.log(`Storage state saved: ${config.storageStatePath}`);

    await context.close();
  } catch (error) {
    await page.screenshot({ path: config.screenshotPath, fullPage: true }).catch(() => {});
    console.error(`Login automation failed. Screenshot: ${config.screenshotPath}`);
    console.error(error);

    if (env.KEEP_BROWSER_ON_ERROR === '1' || env.KEEP_BROWSER_ON_ERROR === 'true') {
      console.error('Browser left open because KEEP_BROWSER_ON_ERROR is enabled.');
      return;
    }

    await context.close();
    process.exitCode = 1;
  }
}

async function switchToPhoneLogin(page) {
  await clickVisibleText(page, '手机号登录');
  await page.getByPlaceholder('请输入手机号').waitFor({ state: 'visible', timeout: THIRTY_SECONDS });
}

async function selectCountryCode(page, countryCode) {
  if (countryCode === '86') {
    return;
  }

  const wantedText = `+${countryCode}`;
  const countryPicker = await firstVisible(page.getByText(wantedText, { exact: true }));

  const currentText = normalizeText(await countryPicker.textContent());
  if (currentText === wantedText) {
    return;
  }

  await countryPicker.click();
  const option = page.getByText(wantedText, { exact: true }).or(page.getByText(countryCode, { exact: true }));
  await (await firstVisible(option)).click({ timeout: THIRTY_SECONDS });
}

async function fillLoginForm(page, config) {
  await typeInto(page.getByPlaceholder('请输入手机号'), config.phone);
  await typeInto(page.getByPlaceholder('请输入密码'), config.password);

  await acceptAgreement(page);
}

async function submitLogin(page) {
  await clickVisibleButton(page, '登录');
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

async function acceptAgreement(page) {
  const checkbox = page.locator('input[type="checkbox"]').first();
  await checkbox.evaluate((node) => {
    if (!node.checked) {
      node.click();
    }
  });

  await page.waitForFunction(() => {
    const input = document.querySelector('input[type="checkbox"]');
    return input?.checked === true;
  }, { timeout: THIRTY_SECONDS });
}

function closeProtocolPages(context) {
  context.on('page', async (newPage) => {
    await newPage.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    if (/\/protocols\//.test(newPage.url())) {
      await newPage.close().catch(() => {});
    }
  });
}

async function waitForFulfillmentCenter(page) {
  await page.getByText('履约中心', { exact: true }).waitFor({
    state: 'visible',
    timeout: FIVE_MINUTES,
  });

  await page.getByRole('button', { name: /进入/ }).waitFor({
    state: 'visible',
    timeout: THIRTY_SECONDS,
  });
}

async function enterSellerCentral(context, page) {
  const newPagePromise = context.waitForEvent('page', { timeout: THIRTY_SECONDS }).catch(() => null);
  await page.getByRole('button', { name: /进入/ }).click();

  const newPage = await newPagePromise;
  const sellerPage = newPage || page;
  await sellerPage.waitForLoadState('domcontentloaded', { timeout: THIRTY_SECONDS }).catch(() => {});
  return sellerPage;
}

async function waitForSellerCentralHome(page) {
  await page.waitForURL(/agentseller\.temu\.com|seller\.kuajingmaihuo\.com/, {
    timeout: FIVE_MINUTES,
  });

  await page.getByText(/Seller Central|欢迎来到Seller central|首页/).first().waitFor({
    state: 'visible',
    timeout: FIVE_MINUTES,
  });
}

function normalizeText(text) {
  return (text || '').replace(/\s+/g, '').trim();
}

async function firstVisible(locator) {
  const deadline = Date.now() + THIRTY_SECONDS;

  while (Date.now() < deadline) {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('No visible matching locator found before timeout.');
}

async function lastVisible(locator) {
  const deadline = Date.now() + THIRTY_SECONDS;

  while (Date.now() < deadline) {
    const count = await locator.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('No visible matching locator found before timeout.');
}

async function clickVisibleText(page, text) {
  const target = await firstVisible(page.getByText(text, { exact: true }));
  const box = await target.boundingBox();

  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return;
  }

  await target.evaluate((node) => {
    const clickable = node.closest('button,[role="button"],[role="tab"],a,div') || node;
    clickable.click();
  });
}

async function clickVisibleButton(page, text) {
  const button = await findVisibleButton(page, text);
  const box = await button.boundingBox();

  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return;
  }

  await button.evaluate((node) => node.click());
}

async function findVisibleButton(page, text) {
  const buttons = page.locator('button');
  const deadline = Date.now() + THIRTY_SECONDS;

  while (Date.now() < deadline) {
    const count = await buttons.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = buttons.nth(index);
      const candidateText = normalizeText(await candidate.textContent().catch(() => ''));
      if (candidateText === text && (await candidate.isVisible().catch(() => false))) {
        return candidate;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`No visible button found with text: ${text}`);
}

async function typeInto(locator, value) {
  await locator.click();
  await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await locator.pressSequentially(value, { delay: 60 });
}

main();
