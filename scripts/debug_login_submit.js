import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { loadEnvFile, readSellerConfig } from './config.js';

const OUTPUT_PATH = 'output/playwright/login-submit-debug.json';
const SCREENSHOT_PATH = 'output/playwright/login-submit-debug.png';
const THIRTY_SECONDS = 30 * 1000;

async function main() {
  const env = { ...process.env, ...(await loadEnvFile('.env')) };
  const config = readSellerConfig(env);
  const events = [];

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });

  const browser = await chromium.launch({
    headless: config.headless,
    slowMo: config.headless ? 0 : 100,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  page.on('console', (message) => {
    events.push({ type: 'console', level: message.type(), text: message.text() });
  });
  page.on('pageerror', (error) => {
    events.push({ type: 'pageerror', text: error.message });
  });
  page.on('request', (request) => {
    const url = request.url();
    if (isInterestingUrl(url)) {
      events.push({ type: 'request', method: request.method(), url });
    }
  });
  page.on('response', (response) => {
    const url = response.url();
    if (isInterestingUrl(url)) {
      events.push({ type: 'response', status: response.status(), url });
    }
  });

  try {
    await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: THIRTY_SECONDS });
    await page.getByText('手机号登录', { exact: true }).click({ timeout: THIRTY_SECONDS });
    if (env.LOGIN_INPUT_METHOD === 'type') {
      await typeInto(page.getByPlaceholder('请输入手机号'), config.phone);
      await typeInto(page.getByPlaceholder('请输入密码'), config.password);
    } else {
      await page.getByPlaceholder('请输入手机号').fill(config.phone);
      await page.getByPlaceholder('请输入密码').fill(config.password);
    }
    await page.locator('input[type="checkbox"]').first().evaluate((node) => {
      if (!node.checked) {
        node.click();
      }
    });

    const beforeClick = await collectPageState(page);
    const loginTarget = await resolveLoginClickTarget(page);
    events.push({ type: 'chosen-click-target', target: loginTarget.info });

    await loginTarget.locator.click({ timeout: THIRTY_SECONDS });
    await page.waitForTimeout(8000);

    const afterClick = await collectPageState(page);
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });

    await writeFile(
      OUTPUT_PATH,
      JSON.stringify({ beforeClick, afterClick, events, screenshotPath: SCREENSHOT_PATH }, null, 2),
    );

    console.log(`Debug report saved: ${OUTPUT_PATH}`);
    console.log(`Debug screenshot saved: ${SCREENSHOT_PATH}`);
  } finally {
    await browser.close();
  }
}

async function resolveLoginClickTarget(page) {
  const targets = await page.locator('text="登录"').evaluateAll((nodes) =>
    nodes.map((node, index) => {
      const element = node instanceof HTMLElement ? node : node.parentElement;
      const buttonLike = element?.closest('button,[role="button"],a,div');
      const rect = buttonLike?.getBoundingClientRect();

      return {
        index,
        text: element?.textContent?.trim() || '',
        tag: buttonLike?.tagName || null,
        className: buttonLike?.getAttribute('class') || '',
        role: buttonLike?.getAttribute('role') || '',
        disabled: buttonLike?.hasAttribute('disabled') || buttonLike?.getAttribute('aria-disabled') || '',
        rect: rect
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null,
        visible: !!rect && rect.width > 0 && rect.height > 0,
      };
    }),
  );

  const index = targets.findLastIndex((target) => target.visible && target.text === '登录');
  if (index === -1) {
    throw new Error(`No visible exact login target found. Candidates: ${JSON.stringify(targets)}`);
  }

  return {
    locator: page.locator('text="登录"').nth(index),
    info: targets[index],
  };
}

async function collectPageState(page) {
  return {
    url: page.url(),
    title: await page.title(),
    loginTextCandidates: await page.locator('text="登录"').evaluateAll((nodes) =>
      nodes.map((node, index) => {
        const element = node instanceof HTMLElement ? node : node.parentElement;
        const rect = element?.getBoundingClientRect();
        return {
          index,
          text: element?.textContent?.trim() || '',
          tag: element?.tagName || null,
          className: element?.getAttribute('class') || '',
          visible: !!rect && rect.width > 0 && rect.height > 0,
          rect: rect
            ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            : null,
        };
      }),
    ),
    visibleMessages: await page.locator('body').evaluate((body) =>
      Array.from(body.querySelectorAll('*'))
        .filter((node) => {
          const element = node;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
        })
        .map((node) => node.textContent?.trim())
        .filter(Boolean)
        .filter((text) => /错误|失败|密码|验证码|登录|风险|异常|请/.test(text))
        .slice(0, 80),
    ),
  };
}

async function typeInto(locator, value) {
  await locator.click();
  await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await locator.pressSequentially(value, { delay: 60 });
}

function isInterestingUrl(url) {
  return /login|auth|passport|api|captcha|risk|verify|user/i.test(url);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
