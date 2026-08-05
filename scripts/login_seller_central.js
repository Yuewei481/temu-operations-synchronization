import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { loadEnvFile, readSellerConfig } from './config.js';

const ACTION_TIMEOUT_MS = 30 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

async function main() {
  const fileEnv = await loadEnvFile('.env').catch(() => ({}));
  const env = { ...fileEnv, ...process.env };
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
  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(config.loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: ACTION_TIMEOUT_MS,
    });

    if (!isAuthenticatedUrl(page.url())) {
      await switchToPhoneLogin(page);
      await selectCountryCode(page, config.countryCode);
      await page.getByPlaceholder('请输入手机号').fill(config.phone);
      await page.getByPlaceholder('请输入密码').fill(config.password);
      await acceptAgreement(page);
      await clickVisibleLoginButton(page);
    }

    await waitForAuthenticatedPage(context, page);
    await context.storageState({ path: config.storageStatePath });
    console.log('TEMU login completed. Authentication state was saved locally.');
    await context.close();
  } catch (error) {
    await page.screenshot({ path: config.screenshotPath, fullPage: true }).catch(() => {});
    console.error(`Automatic login failed. Screenshot: ${config.screenshotPath}`);
    console.error(error);

    if (env.KEEP_BROWSER_ON_ERROR === '1' || env.KEEP_BROWSER_ON_ERROR === 'true') {
      console.error('Chrome was left open for manual inspection.');
      return;
    }

    await context.close();
    process.exitCode = 1;
  }
}

async function switchToPhoneLogin(page) {
  const phoneInput = page.getByPlaceholder('请输入手机号');
  if (await phoneInput.isVisible().catch(() => false)) return;

  await page.getByText('手机号登录', { exact: true }).first().click({ timeout: ACTION_TIMEOUT_MS });
  await phoneInput.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
}

async function selectCountryCode(page, countryCode) {
  if (countryCode === '86') return;

  const wantedText = `+${countryCode}`;
  const picker = page.getByText(/^\+\d+$/, { exact: true }).first();
  await picker.click({ timeout: ACTION_TIMEOUT_MS });
  await page.getByText(wantedText, { exact: true }).last().click({ timeout: ACTION_TIMEOUT_MS });
}

async function acceptAgreement(page) {
  const checkbox = page.locator('input[type="checkbox"]').first();
  if ((await checkbox.count()) === 0) return;
  if (!(await checkbox.isChecked().catch(() => false))) {
    await checkbox.check({ force: true });
  }
}

async function clickVisibleLoginButton(page) {
  const candidates = page.getByRole('button', { name: '登录', exact: true });
  const count = await candidates.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      return;
    }
  }
  throw new Error('Visible TEMU login button was not found.');
}

async function waitForAuthenticatedPage(context, initialPage) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;

  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      if (isAuthenticatedUrl(page.url())) return page;
    }

    if (await initialPage.getByText('履约中心', { exact: true }).isVisible().catch(() => false)) {
      const enterButton = initialPage.getByRole('button', { name: /进入/ }).first();
      if (await enterButton.isVisible().catch(() => false)) {
        await enterButton.click();
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error('Timed out waiting for TEMU Seller Central after login.');
}

function isAuthenticatedUrl(url) {
  return /^https:\/\/(agentseller(?:-eu)?\.temu\.com|seller\.kuajingmaihuo\.com\/settle)/.test(url);
}

main();
