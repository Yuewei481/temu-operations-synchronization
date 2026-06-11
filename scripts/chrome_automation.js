import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SELLER_HOME_ORIGIN = 'https://agentseller.temu.com';
export const SELLER_SETTLE_ORIGIN = 'https://seller.kuajingmaihuo.com/settle';

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
      set AppleScript's text item delimiters to linefeed
      set joinedLines to tabLines as text
      set AppleScript's text item delimiters to ""
      return joinedLines
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

export async function findSellerEntryTab() {
  const tabs = await listChromeTabs();
  return (
    tabs.find((tab) => tab.url.startsWith(SELLER_HOME_ORIGIN)) ||
    tabs.find((tab) => tab.url.startsWith(SELLER_SETTLE_ORIGIN)) ||
    null
  );
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

  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      'osascript',
      ['-e', script, String(tab.windowIndex), String(tab.tabIndex), source],
      { maxBuffer: 20 * 1024 * 1024 },
    ));
  } catch (error) {
    const message = `${error.stderr || ''}\n${error.message || ''}`;
    if (message.includes('AppleScript') && message.includes('JavaScript')) {
      throw new Error(
        'Google Chrome blocked JavaScript from Apple Events. In Chrome, enable: View > Developer > Allow JavaScript from Apple Events, then run npm run collect-sales again.',
      );
    }

    throw error;
  }

  return stdout.trim();
}

export async function setChromeTabUrl(tab, url) {
  const script = `
    on run argv
      set windowIndex to item 1 of argv as integer
      set tabIndex to item 2 of argv as integer
      set targetUrl to item 3 of argv
      tell application "Google Chrome"
        set URL of tab tabIndex of window windowIndex to targetUrl
      end tell
    end run
  `;

  await execFileAsync('osascript', ['-e', script, String(tab.windowIndex), String(tab.tabIndex), url], {
    maxBuffer: 1024 * 1024,
  });
}

export async function clickChromeScreenPoint(tab, point) {
  const script = `
    on run argv
      set windowIndex to item 1 of argv as integer
      set tabIndex to item 2 of argv as integer
      set pointX to item 3 of argv as integer
      set pointY to item 4 of argv as integer
      tell application "Google Chrome"
        activate
        set active tab index of window windowIndex to tabIndex
        set index of window windowIndex to 1
      end tell
      delay 0.2
      tell application "System Events"
        click at {pointX, pointY}
      end tell
    end run
  `;

  try {
    await execFileAsync(
      'osascript',
      ['-e', script, String(tab.windowIndex), String(tab.tabIndex), String(Math.round(point.x)), String(Math.round(point.y))],
      { maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    const message = `${error.stderr || ''}\n${error.message || ''}`;
    if (message.includes('不允许辅助访问') || message.includes('not allowed assistive access')) {
      throw new Error(
        'macOS blocked native mouse clicks from osascript. Enable Accessibility permission for osascript/Codex in System Settings > Privacy & Security > Accessibility, then run npm run collect-sales again.',
      );
    }

    throw error;
  }
}
