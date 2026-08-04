import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveChromePath } from './chrome_path.js';
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

const chromePath = resolveChromePath(env);
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
