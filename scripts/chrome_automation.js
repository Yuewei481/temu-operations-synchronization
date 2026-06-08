import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SELLER_HOME_ORIGIN = 'https://agentseller.temu.com';

export async function listChromeTabs() {
  const script = `
    tell application "Google Chrome"
      set tabLines to {}
      repeat with windowIndex from 1 to count windows
        set currentWindow to window windowIndex
        repeat with tabIndex from 1 to count tabs of currentWindow
          set currentTab to tab tabIndex of currentWindow
          set tabTitle to ""
          set tabUrl to ""
          try
            set tabTitle to title of currentTab as text
          end try
          try
            set tabUrl to URL of currentTab as text
          end try
          set end of tabLines to (windowIndex as text) & "\t" & (tabIndex as text) & "\t" & tabTitle & "\t" & tabUrl
        end repeat
      end repeat
      return tabLines
    end tell
  `;

  const { stdout } = await execFileAsync('osascript', ['-e', script], { maxBuffer: 1024 * 1024 });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [windowIndex, tabIndex, title, url] = line.split('\t');
      return { windowIndex, tabIndex, title, url };
    });
}

export async function findSellerHomeTab() {
  const tabs = await listChromeTabs();
  return tabs.find((tab) => tab.url.startsWith(SELLER_HOME_ORIGIN)) || null;
}

export async function executeChromeJavascript(tab, source) {
  const script = `
    on run argv
      set windowIndex to item 1 of argv as integer
      set tabIndex to item 2 of argv as integer
      set jsSource to item 3 of argv
      tell application "Google Chrome"
        return execute tab tabIndex of window windowIndex javascript jsSource
      end tell
    end run
  `;

  const { stdout } = await execFileAsync(
    'osascript',
    ['-e', script, String(tab.windowIndex), String(tab.tabIndex), source],
    { maxBuffer: 20 * 1024 * 1024 },
  );

  return stdout.trim();
}
