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

  const browser = await chromium.launch({
    headless: config.headless,
    slowMo: config.headless ? 0 : 80,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  });

  const page = await context.newPage();

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

    await browser.close();
  } catch (error) {
    await page.screenshot({ path: config.screenshotPath, fullPage: true }).catch(() => {});
    console.error(`Login automation failed. Screenshot: ${config.screenshotPath}`);
    console.error(error);

    if (env.KEEP_BROWSER_ON_ERROR === '1' || env.KEEP_BROWSER_ON_ERROR === 'true') {
      console.error('Browser left open because KEEP_BROWSER_ON_ERROR is enabled.');
      return;
    }

    await browser.close();
    process.exitCode = 1;
  }
}

async function switchToPhoneLogin(page) {
  await page.getByText('手机号登录', { exact: true }).click({ timeout: THIRTY_SECONDS });
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
  await page.getByPlaceholder('请输入手机号').fill(config.phone);
  await page.getByPlaceholder('请输入密码').fill(config.password);

  await acceptAgreement(page);
}

async function submitLogin(page) {
  const loginButton = await lastVisible(page.getByText('登录', { exact: true }));
  await loginButton.click({ timeout: THIRTY_SECONDS });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

async function acceptAgreement(page) {
  const agreementText = page.getByText('我已阅读并同意');
  await agreementText.click({ timeout: THIRTY_SECONDS }).catch(async () => {
    const checkbox = page.locator('input[type="checkbox"]').first();
    await checkbox.evaluate((node) => {
      if (!node.checked) {
        node.click();
      }
    });
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

main();
