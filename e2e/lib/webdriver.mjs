/**
 * The few WebDriver calls the suite needs, over fetch. WebKitWebDriver speaks
 * the W3C protocol, so there is nothing here that a client library would do
 * differently, and a dependency would be the only thing it added.
 */
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

export const Keys = {
  Enter: '',
  Escape: '',
  Tab: '',
  Backspace: '',
  Shift: '',
  Control: '',
  Alt: '',
  Meta: '',
  ArrowDown: '',
  ArrowUp: '',
};

export class WebDriverError extends Error {
  constructor(status, value) {
    super(`${value?.error ?? 'webdriver error'} (${status}): ${value?.message ?? JSON.stringify(value)}`);
    this.code = value?.error;
  }
}

const trace = process.env.E2E_TRACE === '1';

async function call(url, method, body, { timeout = 60000 } = {}) {
  const started = Date.now();
  if (trace) console.error(`[webdriver] ${method} ${url.replace(/^.*\/session\/[^/]+/, '')} ${body ? JSON.stringify(body).slice(0, 120) : ''}`);
  // WebKitWebDriver never answers some calls (a screenshot of an unmapped
  // window, for one), and a test that waits forever reports nothing.
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  }).catch((err) => {
    throw new Error(`${method} ${url.replace(/^.*\/session\/[^/]+/, '')} ${err.name === 'TimeoutError' ? `did not answer within ${timeout}ms` : err.message}`);
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { value: text }; }
  if (trace) console.error(`[webdriver]   -> ${res.status} in ${Date.now() - started}ms ${text.slice(0, 120)}`);
  if (!res.ok) throw new WebDriverError(res.status, data.value);
  return data.value;
}

export class Session {
  constructor(driverUrl, id) {
    this.driverUrl = driverUrl;
    this.id = id;
    this.base = `${driverUrl}/session/${id}`;
  }

  static async create(driverUrl, capabilities) {
    const value = await call(`${driverUrl}/session`, 'POST', { capabilities: { alwaysMatch: capabilities } });
    return new Session(driverUrl, value.sessionId);
  }

  /** Run a script in the current window; `return` gives the value back. */
  exec(script, ...args) {
    return call(`${this.base}/execute/sync`, 'POST', { script, args });
  }

  /** Same, but the script gets a callback as its last argument. */
  execAsync(script, ...args) {
    return call(`${this.base}/execute/async`, 'POST', { script, args });
  }

  handles() {
    return call(`${this.base}/window/handles`, 'GET');
  }

  switchTo(handle) {
    return call(`${this.base}/window`, 'POST', { handle });
  }

  /** PNG bytes of the current window's viewport. */
  async screenshot() {
    const b64 = await call(`${this.base}/screenshot`, 'GET', undefined, { timeout: 15000 });
    return Buffer.from(b64, 'base64');
  }

  async find(css) {
    const value = await call(`${this.base}/element`, 'POST', { using: 'css selector', value: css });
    return value[ELEMENT];
  }

  async findAll(css) {
    const value = await call(`${this.base}/elements`, 'POST', { using: 'css selector', value: css });
    return value.map((v) => v[ELEMENT]);
  }

  click(elementId) {
    return call(`${this.base}/element/${elementId}/click`, 'POST', {});
  }

  /** Type into an element with real key events, the way a person would. */
  sendKeys(elementId, text) {
    return call(`${this.base}/element/${elementId}/value`, 'POST', { text });
  }

  /**
   * Press a chord on the keyboard, e.g. `chord(Keys.Alt, 'h')`. The modifiers
   * go down in order, the last key is pressed, and everything is released.
   */
  async chord(...keys) {
    const mods = keys.slice(0, -1);
    const key = keys[keys.length - 1];
    const actions = [
      ...mods.map((value) => ({ type: 'keyDown', value })),
      { type: 'keyDown', value: key },
      { type: 'keyUp', value: key },
      ...mods.slice().reverse().map((value) => ({ type: 'keyUp', value })),
    ];
    await call(`${this.base}/actions`, 'POST', { actions: [{ type: 'key', id: 'keyboard', actions }] });
    await call(`${this.base}/actions`, 'DELETE');
  }

  delete() {
    return call(this.base, 'DELETE');
  }
}

export async function driverReady(driverUrl) {
  try {
    const value = await call(`${driverUrl}/status`, 'GET');
    return Boolean(value?.ready ?? true);
  } catch {
    return false;
  }
}
