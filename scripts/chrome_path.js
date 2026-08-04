import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export function resolveChromePath(env = process.env, options = {}) {
  const platform = options.platform || process.platform;
  const pathExists = options.pathExists || existsSync;
  const explicitPath = String(env.CHROME_PATH || '').trim();

  if (explicitPath) {
    if (!pathExists(explicitPath)) {
      throw new Error(`CHROME_PATH does not exist: ${explicitPath}`);
    }
    return explicitPath;
  }

  const candidates = chromePathCandidates(env, platform);
  const detectedPath = candidates.find((candidate) => pathExists(candidate));
  if (detectedPath) {
    return detectedPath;
  }

  throw new Error(
    `Unable to find Google Chrome automatically. Set CHROME_PATH in .env. Checked: ${candidates.join(', ')}`,
  );
}

export function chromePathCandidates(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    return uniqueNonEmpty([
      env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env.PROGRAMFILES && win32.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env['PROGRAMFILES(X86)'] &&
        win32.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]);
  }

  if (platform === 'darwin') {
    return uniqueNonEmpty([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      posix.join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ]);
  }

  return uniqueNonEmpty([
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]);
}

function uniqueNonEmpty(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))];
}
