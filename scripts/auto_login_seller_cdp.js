import { CdpPage, getCdpOrigin, listCdpPages } from './cdp_client.js';
import { readSellerConfig } from './config.js';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 500;

async function main() {
  const config = readSellerConfig(process.env);
  const cdpOrigin = getCdpOrigin(process.env);
  const existingPages = await listCdpPages(cdpOrigin);

  if (existingPages.some((page) => isSellerHomeUrl(page.url))) {
    console.log('TEMU is already signed in; credential entry was skipped.');
    return;
  }

  if (existingPages.some((page) => isSettlementUrl(page.url))) {
    await waitForSellerHomePage(cdpOrigin);
    console.log('TEMU was already signed in and Seller Central was opened.');
    return;
  }

  const pageInfo = existingPages.find((page) => page.type === 'page' && isTemuUrl(page.url));
  if (!pageInfo) throw new Error('TEMU login tab was not found.');

  const page = new CdpPage(pageInfo);
  try {
    await page.send('Runtime.enable');
    await waitForLoginForm(page);
    await selectCountryCode(page, config.countryCode);
    await setInputValue(page, '请输入手机号', config.phone);
    await setInputValue(page, '请输入密码', config.password);
    await acceptAgreement(page);
    await clickLogin(page);
    await waitForSellerHomePage(cdpOrigin);
    console.log('TEMU credentials were filled from the local environment and login succeeded.');
  } finally {
    await page.close();
  }
}

async function waitForLoginForm(page) {
  const deadline = Date.now() + 30 * 1000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(`(() => {
      const visible = (node) => node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
      const phone = [...document.querySelectorAll('input')].find((node) => node.placeholder === '请输入手机号');
      if (visible(phone)) return true;
      const tab = [...document.querySelectorAll('button, [role="button"], [role="tab"], div, span')]
        .find((node) => node.textContent.trim() === '手机号登录' && visible(node));
      if (tab) (tab.closest('button, [role="button"], [role="tab"]') || tab).click();
      return false;
    })()`);
    if (ready) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('TEMU phone login form did not become visible.');
}

async function selectCountryCode(page, countryCode) {
  if (countryCode === '86') return;
  const result = await page.evaluate(`(() => {
    const wanted = ${JSON.stringify(`+${countryCode}`)};
    const visible = (node) => node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    const current = [...document.querySelectorAll('button, [role="button"], div, span')]
      .find((node) => /^\\+\\d+$/.test(node.textContent.trim()) && visible(node));
    if (!current) return 'picker-not-found';
    (current.closest('button, [role="button"]') || current).click();
    const option = [...document.querySelectorAll('button, [role="option"], li, div, span')]
      .find((node) => node.textContent.trim() === wanted && visible(node));
    if (!option) return 'option-not-found';
    (option.closest('button, [role="option"], li') || option).click();
    return 'selected';
  })()`);
  if (result !== 'selected') throw new Error(`Unable to select TEMU country code +${countryCode}: ${result}`);
}

async function setInputValue(page, placeholder, value) {
  const changed = await page.evaluate(`(() => {
    const input = [...document.querySelectorAll('input')]
      .find((node) => node.placeholder === ${JSON.stringify(placeholder)});
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  })()`);
  if (!changed) throw new Error(`TEMU login field was not found: ${placeholder}`);
}

async function acceptAgreement(page) {
  await page.evaluate(`(() => {
    const checkbox = document.querySelector('input[type="checkbox"]');
    if (checkbox && !checkbox.checked) checkbox.click();
  })()`);
}

async function clickLogin(page) {
  const clicked = await page.evaluate(`(() => {
    const visible = (node) => node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    const buttons = [...document.querySelectorAll('button')]
      .filter((node) => node.textContent.trim() === '登录' && visible(node));
    const button = buttons.at(-1);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error('Visible TEMU login button was not found.');
}

async function waitForSellerHomePage(cdpOrigin) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pages = await listCdpPages(cdpOrigin);
    if (pages.some((page) => isSellerHomeUrl(page.url))) return;

    const settlementPage = pages.find((page) => page.type === 'page' && isSettlementUrl(page.url));
    if (settlementPage) await clickEnterSellerCentral(settlementPage);
    await sleep(1000);
  }
  throw new Error('Timed out waiting for TEMU Seller Central after automatic login.');
}

async function clickEnterSellerCentral(pageInfo) {
  const page = new CdpPage(pageInfo);
  try {
    await page.send('Runtime.enable');
    await page.evaluate(`(() => {
      const visible = (node) => node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
      const button = [...document.querySelectorAll('button')]
        .find((node) => node.textContent.includes('进入') && visible(node));
      if (button) button.click();
    })()`);
  } finally {
    await page.close();
  }
}

function isTemuUrl(url) {
  return /^https:\/\/(seller\.kuajingmaihuo\.com|agentseller(?:-eu)?\.temu\.com)/.test(url);
}

function isSellerHomeUrl(url) {
  return /^https:\/\/agentseller(?:-eu)?\.temu\.com/.test(url);
}

function isSettlementUrl(url) {
  return /^https:\/\/seller\.kuajingmaihuo\.com\/settle/.test(url);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
