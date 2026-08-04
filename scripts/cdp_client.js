const DEFAULT_CDP_ORIGIN = 'http://127.0.0.1:9222';

export function getCdpOrigin(env = process.env) {
  return env.CDP_ORIGIN || DEFAULT_CDP_ORIGIN;
}

export async function listCdpPages(cdpOrigin = getCdpOrigin()) {
  let response;
  try {
    response = await fetch(`${cdpOrigin}/json`);
  } catch (error) {
    throw new Error(
      `Chrome CDP endpoint unavailable at ${cdpOrigin}/json. Start Chrome with npm run start-chrome:cdp, or launch Chrome with --remote-debugging-port=9222.`,
    );
  }

  if (!response.ok) {
    throw new Error(`Chrome CDP endpoint unavailable at ${cdpOrigin}/json (${response.status})`);
  }

  return response.json();
}

export async function activateCdpPage(page, cdpOrigin = getCdpOrigin()) {
  if (!page?.id) {
    return;
  }

  await fetch(`${cdpOrigin}/json/activate/${page.id}`).catch(() => {});
}

export async function findCdpPage(predicate, cdpOrigin = getCdpOrigin()) {
  const pages = await listCdpPages(cdpOrigin);
  return pages.find((page) => page.type === 'page' && predicate(page)) || null;
}

export async function closeCdpBrowser(cdpOrigin = getCdpOrigin()) {
  const browserWebSocketUrl = await getBrowserWebSocketUrl(cdpOrigin);
  if (browserWebSocketUrl) {
    await sendOneShotCdp(browserWebSocketUrl, 'Browser.close');
    return true;
  }

  const pages = await listCdpPages(cdpOrigin);
  const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!page) {
    return false;
  }

  const cdpPage = new CdpPage(page);
  try {
    await cdpPage.send('Browser.close');
  } finally {
    await cdpPage.close();
  }
  return true;
}

async function getBrowserWebSocketUrl(cdpOrigin) {
  try {
    const response = await fetch(`${cdpOrigin}/json/version`);
    if (!response.ok) {
      return '';
    }
    const version = await response.json();
    return version.webSocketDebuggerUrl || '';
  } catch {
    return '';
  }
}

function sendOneShotCdp(webSocketUrl, method) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const id = 1;
    let settled = false;

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    socket.addEventListener(
      'open',
      () => {
        socket.send(JSON.stringify({ id, method }));
      },
      { once: true },
    );

    socket.addEventListener(
      'error',
      () => {
        finish(new Error(`Unable to send ${method} to Chrome CDP browser target.`));
      },
      { once: true },
    );

    socket.addEventListener('message', (event) => {
      const payload = JSON.parse(event.data);
      if (payload.id !== id) {
        return;
      }
      if (payload.error) {
        finish(new Error(`${payload.error.message}: ${payload.error.data || ''}`.trim()));
      } else {
        finish();
      }
    });

    socket.addEventListener(
      'close',
      () => {
        finish();
      },
      { once: true },
    );
  });
}

export class CdpPage {
  constructor(page) {
    if (!page?.webSocketDebuggerUrl) {
      throw new Error('CDP page is missing webSocketDebuggerUrl');
    }

    this.page = page;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(page.webSocketDebuggerUrl);
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
      this.socket.addEventListener(
        'close',
        () => reject(new Error('Chrome CDP target closed before the connection was ready.')),
        { once: true },
      );
    });
    this.socket.addEventListener('message', (event) => this.handleMessage(event));
    this.socket.addEventListener('error', () => {
      this.failPending(new Error('Chrome CDP target connection failed.'));
    });
    this.socket.addEventListener('close', () => {
      this.failPending(new Error('Inspected Chrome target navigated or closed.'));
    });
  }

  async close() {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }

  async send(method, params = {}) {
    await this.opened;
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Chrome CDP target is no longer open.');
    }
    const id = this.nextId;
    this.nextId += 1;
    const message = { id, method, params };

    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.socket.send(JSON.stringify(message));
    return result;
  }

  async evaluate(expression, options = {}) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: options.returnByValue ?? true,
    });

    if (response.exceptionDetails) {
      const description =
        response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        'Runtime.evaluate failed';
      throw new Error(description);
    }

    return response.result?.value;
  }

  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }

  handleMessage(event) {
    const payload = JSON.parse(event.data);
    if (!payload.id) {
      return;
    }

    const pending = this.pending.get(payload.id);
    if (!pending) {
      return;
    }

    this.pending.delete(payload.id);
    if (payload.error) {
      pending.reject(new Error(`${payload.error.message}: ${payload.error.data || ''}`.trim()));
      return;
    }

    pending.resolve(payload.result);
  }

  failPending(error) {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }
}
