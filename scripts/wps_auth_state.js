export const WPS_SIGN_IN_LABELS = Object.freeze([
  'sign in',
  'sign in now',
  'login',
  '\u767b\u5f55',
  '\u7acb\u5373\u767b\u5f55',
  '\u767b\u5f55\u8d26\u53f7',
  '\u8d26\u53f7\u767b\u5f55',
]);

export function isWpsSignInText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return false;
  return WPS_SIGN_IN_LABELS.some((label) =>
    text === label || text.startsWith(`${label} `) || text.endsWith(` ${label}`)
  );
}

export function isWpsLoginPage(page) {
  if (page?.type !== 'page') return false;
  try {
    const url = new URL(page.url);
    return url.hostname === 'account.wps.cn' || url.hostname === 'account.kdocs.cn';
  } catch {
    return false;
  }
}

export function isMatchingWpsDocumentPage(page, docUrl) {
  if (page?.type !== 'page') return false;
  try {
    const candidate = new URL(page.url);
    const target = new URL(docUrl);
    const docId = target.pathname.match(/^\/l\/([^/]+)/)?.[1] || '';
    return candidate.hostname === target.hostname &&
      (docId
        ? candidate.pathname === `/l/${docId}` || candidate.pathname.startsWith(`/l/${docId}/`)
        : candidate.href === target.href);
  } catch {
    return false;
  }
}

export function isRecoverableWpsNavigationError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('navigated or closed') ||
    message.includes('websocket') ||
    message.includes('target closed') ||
    message.includes('promise was collected') ||
    message.includes('login required after attempted write');
}
