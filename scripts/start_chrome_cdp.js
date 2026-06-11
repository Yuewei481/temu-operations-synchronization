import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from './config.js';

const fileEnv = await loadEnvFile('.env').catch(() => ({}));
const env = { ...fileEnv, ...process.env };
const port = env.CDP_PORT || '9222';
const userDataDir =
  env.CDP_USER_DATA_DIR ||
  join(homedir(), 'seller-central-chrome-cdp-profile');
const loginUrl =
  env.SELLER_LOGIN_URL ||
  'https://seller.kuajingmaihuo.com/login?redirectUrl=https%3A%2F%2Fseller.kuajingmaihuo.com%2Fsettle%2Fsite-main%3FredirectUrl%3Dhttps%253A%252F%252Fseller.kuajingmaihuo.com%252F';

const chromePath = resolveChromePath();
const args = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  loginUrl,
];

const child = spawn(chromePath, args, {
  detached: true,
  stdio: 'ignore',
});
child.unref();

console.log(`Started Chrome with CDP port ${port}`);
console.log(`Chrome path: ${chromePath}`);
console.log(`User data dir: ${userDataDir}`);
console.log(`Login URL: ${loginUrl}`);

function resolveChromePath() {
  if (!env.CHROME_PATH) {
    throw new Error('Missing CHROME_PATH. Set it in .env to the full path of your local Chrome executable.');
  }

  if (!existsSync(env.CHROME_PATH)) {
    throw new Error(`CHROME_PATH does not exist: ${env.CHROME_PATH}`);
  }

  return env.CHROME_PATH;
}
