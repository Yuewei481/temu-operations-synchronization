import { spawn } from 'node:child_process';
import { DEFAULT_LOGIN_URL, loadEnvFile } from './config.js';

async function main() {
  const env = await loadEnvFile('.env').catch(() => ({}));
  const loginUrl = env.SELLER_LOGIN_URL || DEFAULT_LOGIN_URL;

  const opener = spawn('open', ['-a', 'Google Chrome', loginUrl], {
    detached: true,
    stdio: 'ignore',
  });

  opener.unref();
  console.log(`Opened Seller Center login page in Google Chrome: ${loginUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
