# Seller Central Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Playwright script that logs into Kuajing Maihuo Seller Center with phone credentials from `.env`, enters the global Seller Central page, and persists browser state for later automation.

**Architecture:** Keep credential parsing and validation in a small testable module. Keep browser automation in one CLI script that reads config, runs headed by default, stores screenshots on failure, and captures the newly opened Seller Central page after clicking `进入`.

**Tech Stack:** Node.js, Playwright, Node's built-in test runner.

---

### Task 1: Project Runtime And Config

**Files:**
- Create: `package.json`
- Create: `.env`
- Create: `.env.example`
- Create: `tests/config.test.js`
- Create: `scripts/config.js`

- [ ] **Step 1: Write tests for env parsing and required config validation**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnvText, readSellerConfig } from '../scripts/config.js';

test('parseEnvText reads plain key value pairs and ignores comments', () => {
  assert.deepEqual(parseEnvText('A=1\n# comment\nB = two\nEMPTY=\n'), {
    A: '1',
    B: 'two',
    EMPTY: '',
  });
});

test('readSellerConfig returns normalized seller login settings', () => {
  const config = readSellerConfig({
    SELLER_PHONE_COUNTRY_CODE: '+86',
    SELLER_PHONE: '[REMOVED_PERSONAL_PHONE]',
    SELLER_PASSWORD: 'secret',
  });

  assert.equal(config.countryCode, '86');
  assert.equal(config.phone, '[REMOVED_PERSONAL_PHONE]');
  assert.equal(config.password, 'secret');
  assert.equal(config.loginUrl.startsWith('https://seller.kuajingmaihuo.com/login'), true);
});

test('readSellerConfig reports missing required env keys', () => {
  assert.throws(
    () => readSellerConfig({ SELLER_PHONE: '[REMOVED_PERSONAL_PHONE]' }),
    /Missing required env values: SELLER_PHONE_COUNTRY_CODE, SELLER_PASSWORD/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails before implementation**

Run: `npm test`

Expected: FAIL because `../scripts/config.js` does not exist.

- [ ] **Step 3: Implement the config module and project metadata**

`scripts/config.js` exports `parseEnvText`, `loadEnvFile`, and `readSellerConfig`.

- [ ] **Step 4: Run tests**

Run: `npm test`

Expected: PASS.

### Task 2: Browser Login Flow

**Files:**
- Create: `scripts/login_seller_central.js`
- Modify: `package.json`
- Create: `output/playwright/.gitkeep`

- [ ] **Step 1: Implement Playwright CLI flow**

The script launches Chromium, opens the login URL, switches to phone login, fills `+86`, phone, password, checks the agreement checkbox, clicks login, waits up to 5 minutes for the fulfillment center, clicks `进入`, then waits for the new Seller Central page.

- [ ] **Step 2: Add npm scripts**

Use `npm run login` for headed mode. Use `HEADLESS=1 npm run login` for headless mode.

- [ ] **Step 3: Verify syntax and tests**

Run: `npm test`

Expected: PASS.

Run: `node --check scripts/login_seller_central.js`

Expected: no syntax errors.

### Task 3: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document setup and run commands**

Explain `npm install`, `.env`, `npm run login`, and where screenshots/storage state are saved.

- [ ] **Step 2: Verify final status**

Run: `git status --short`.

Expected: new project files appear, and `.env` does not appear.
