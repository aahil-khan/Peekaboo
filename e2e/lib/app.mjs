import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Session } from './webdriver.mjs';
import { MockClient, MOCK_MODEL } from './mock-ollama.mjs';
import { MONITOR } from './display.mjs';
import { sleep, waitUntil } from './procs.mjs';

export { MOCK_MODEL };

/** What run.mjs hands the tests through the environment. */
export const env = {
  driverUrl: process.env.E2E_DRIVER_URL,
  mockUrl: process.env.E2E_MOCK_URL,
  /** A loopback port nothing listens on, for "server unreachable" cases. */
  deadUrl: process.env.E2E_DEAD_URL,
  binary: process.env.PEEKABOO_E2E_BIN,
  root: process.env.E2E_ROOT,
  outDir: process.env.E2E_OUT,
  displayKind: process.env.E2E_DISPLAY_KIND,
  /** The display and bus the app is expected to be on. */
  expected: JSON.parse(process.env.E2E_EXPECTED_ENV || '{}'),
};

const LAUNCHER = path.join(path.dirname(new URL(import.meta.url).pathname), 'launch.sh');

export const mock = new MockClient(env.mockUrl);

/** A settings blob that skips setup and talks to the mock. */
export function seededSettings(overrides = {}) {
  return {
    setupCompleted: true,
    activeProvider: 'ollama',
    activeModel: MOCK_MODEL,
    ollamaBaseUrl: env.mockUrl,
    overlayTourSeen: true,
    ...overrides,
  };
}

let profileCounter = 0;

/**
 * One run of the app in a profile of its own.
 *
 * `settings` seeds the frontend's persisted settings (zustand's
 * `peekaboo-settings` in localStorage). WebKit keeps localStorage in its data
 * directory in a format of its own, so the seed goes in through the app: a
 * first launch writes it and quits, and the launch the test sees starts from
 * it like any later launch of a configured install.
 *
 * `files` are written into the profile before the first launch, as
 * profile-relative path -> contents, e.g. the hotkey config.
 */
export async function launchApp({ name, settings, files } = {}) {
  profileCounter += 1;
  const profile = path.join(env.root, 'profiles', `${String(profileCounter).padStart(2, '0')}-${name ?? 'app'}`);
  fs.mkdirSync(profile, { recursive: true });
  for (const [rel, contents] of Object.entries(files ?? {})) {
    const target = path.join(profile, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  if (settings) {
    const seeder = await App.start(profile);
    try {
      await seeder.use('peekaboo');
      // The store persists itself again after any change, and model discovery
      // makes one within about a second of boot, overwriting whatever is in
      // localStorage with the defaults still in memory. The seed is written
      // from inside the page and re-written whenever that happens, until it
      // has stayed put for a while; the store never writes twice unprompted.
      const rewrites = await seeder.session.execAsync(
        `const [settings, done] = arguments;
         const blob = JSON.stringify({ state: settings, version: 1 });
         let rewrites = 0, quietSince = Date.now();
         localStorage.setItem("peekaboo-settings", blob);
         const timer = setInterval(() => {
           if (localStorage.getItem("peekaboo-settings") !== blob) {
             localStorage.setItem("peekaboo-settings", blob);
             rewrites += 1;
             quietSince = Date.now();
           } else if (Date.now() - quietSince > 1500) {
             clearInterval(timer);
             done(rewrites);
           }
         }, 50);`,
        settings,
      );
      if (rewrites > 3) throw new Error(`the app kept overwriting the seeded settings (${rewrites} times)`);
      const persisted = await seeder.exec('return JSON.parse(localStorage.getItem("peekaboo-settings")).state');
      for (const [key, value] of Object.entries(settings)) {
        assert.deepEqual(persisted[key], value, `seeded setting ${key}`);
      }
      // Let WebKit's storage process flush before the app goes away.
      await sleep(500);
    } finally {
      await seeder.quit();
    }
  }

  const app = await App.start(profile);
  await app.assertIsolated();
  return app;
}

export class App {
  constructor(session, profile) {
    this.session = session;
    this.profile = profile;
    this.labels = new Map();
    this.shots = 0;
  }

  static async start(profile) {
    const session = await Session.create(env.driverUrl, {
      browserName: 'wry',
      'webkitgtk:browserOptions': {
        binary: LAUNCHER,
        args: [`--profile=${profile}`],
      },
    });
    const app = new App(session, profile);
    await waitUntil(() => fs.existsSync(path.join(profile, 'app.pid')), { what: 'the app to record its pid' });
    app.pid = Number(fs.readFileSync(path.join(profile, 'app.pid'), 'utf8'));
    // Every window loads the same bundle; wait for the main one to mount.
    await app.use('peekaboo');
    await app.waitFor('return !!document.getElementById("root")', { what: 'the overlay webview to load' });
    return app;
  }

  // ── Windows ──

  /** Switch the session to the window with this Tauri label. */
  async use(label) {
    const known = this.labels.get(label);
    if (known) {
      try {
        await this.session.switchTo(known);
        return;
      } catch {
        this.labels.delete(label);
      }
    }
    const handle = await waitUntil(async () => {
      for (const h of await this.session.handles()) {
        await this.session.switchTo(h);
        const found = await this.session.exec('return window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null');
        if (found) this.labels.set(found, h);
        if (found === label) return h;
      }
      return null;
    }, { what: `a window labelled ${label}` });
    await this.session.switchTo(handle);
  }

  // ── Scripting ──

  exec(script, ...args) {
    return this.session.exec(script, ...args);
  }

  /** Call one of the app's own Tauri commands from inside the webview. */
  invoke(command, args = {}) {
    return this.session.execAsync(
      `const [command, args, done] = arguments;
       window.__TAURI_INTERNALS__.invoke(command, args).then(
         (value) => done({ ok: true, value }),
         (error) => done({ ok: false, error: String(error) }),
       );`,
      command, args,
    ).then((result) => {
      if (!result.ok) throw new Error(`invoke(${command}) failed: ${result.error}`);
      return result.value;
    });
  }

  /** Poll a script until it returns something truthy. */
  waitFor(script, { timeout = 10000, what = script } = {}) {
    return waitUntil(() => this.exec(script), { timeout, what });
  }

  async text(css) {
    return this.exec('const el = document.querySelector(arguments[0]); return el ? el.innerText : null', css);
  }

  /** Whether the element exists and takes up space on screen. */
  async isShown(css) {
    return this.exec(
      `const el = document.querySelector(arguments[0]);
       if (!el) return false;
       const r = el.getBoundingClientRect();
       return r.width > 0 && r.height > 0;`,
      css,
    );
  }

  // ── Input ──
  //
  // Fedora's WebKitGTK is built without WebDriver's keyboard and mouse
  // simulation (every such call answers "unsupported operation"), so input is
  // synthesised inside the page: the same DOM events React sees from a real
  // keystroke, dispatched on the same elements. Everything after the event
  // handler (state, IPC, Rust, the network) is the real thing. What this does
  // not exercise is GTK's own key handling, which is what the hotkey test
  // covers with real X11 key events.

  /** Put `text` into an input or textarea the way typing would, change event included. */
  async type(css, text) {
    await this.exec(
      `const [css, text] = arguments;
       const el = document.querySelector(css);
       if (!el) throw new Error("no element matches " + css);
       el.focus();
       const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
       Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
       el.dispatchEvent(new Event("input", { bubbles: true }));`,
      css, text,
    );
  }

  /**
   * Press one key, with modifiers, on the focused element (or `css`). The
   * event bubbles from the element to window, so both an element's own
   * handler and the overlay's global shortcuts see it, in that order.
   */
  async press(key, { alt = false, ctrl = false, shift = false, css = null } = {}) {
    const codes = { Enter: 'Enter', Escape: 'Escape', ArrowDown: 'ArrowDown', ArrowUp: 'ArrowUp', Tab: 'Tab', ' ': 'Space', '/': 'Slash', ',': 'Comma' };
    const code = codes[key] ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key);
    await this.exec(
      `const [key, code, mods, css] = arguments;
       const target = css ? document.querySelector(css) : (document.activeElement ?? document.body);
       if (!target) throw new Error("nothing to press " + key + " on");
       const init = { key, code, bubbles: true, cancelable: true, altKey: mods.alt, ctrlKey: mods.ctrl, shiftKey: mods.shift };
       target.dispatchEvent(new KeyboardEvent("keydown", init));
       target.dispatchEvent(new KeyboardEvent("keyup", init));`,
      key, code, { alt, ctrl, shift }, css,
    );
  }

  async click(css) {
    await this.exec(
      `const el = document.querySelector(arguments[0]);
       if (!el) throw new Error("no element matches " + arguments[0]);
       el.click();`,
      css,
    );
  }

  /** Click the element whose aria-label is exactly `label`. */
  clickLabelled(label) {
    return this.click(`[aria-label="${label.replace(/"/g, '\\"')}"]`);
  }

  // ── The overlay ──

  async showOverlay() {
    await this.use('peekaboo');
    await this.invoke('show_peek');
    await this.waitFor('return !!document.querySelector(".peek-surface textarea")', { what: 'the overlay to render' });
  }

  async hideOverlay() {
    await this.use('peekaboo');
    await this.invoke('hide_peek');
    // Not "until .peek-surface is gone": an unmapped webview gets no animation
    // frames, so the exit animation never finishes while the window is hidden.
    await this.waitFor('return document.visibilityState === "hidden"', { what: 'the overlay window to hide' });
  }

  /** Type a question, press Enter, and wait for the streamed answer to settle. */
  async ask(question, { timeout = 15000 } = {}) {
    await this.type('.peek-surface textarea', question);
    await this.press('Enter', { css: '.peek-surface textarea' });
    await this.waitFor(
      `const turns = document.querySelectorAll(".peek-thread-assistant");
       const last = turns[turns.length - 1];
       return !!last && !last.dataset.live && !last.querySelector(".peek-loading-dots") && last.innerText.trim().length > 0;`,
      { timeout, what: 'the answer to finish streaming' },
    );
    const turns = await this.exec('return [...document.querySelectorAll(".peek-thread-assistant")].map((el) => el.innerText.trim())');
    return turns[turns.length - 1];
  }

  // ── Evidence ──

  /** Save a PNG of the current window as <outDir>/<name>.png. */
  async shot(name) {
    fs.mkdirSync(env.outDir, { recursive: true });
    const file = path.join(env.outDir, `${name}.png`);
    try {
      // WebKit never answers a screenshot request for an unmapped window.
      const visibility = await this.exec('return document.visibilityState');
      if (visibility !== 'visible') throw new Error(`the window is ${visibility}`);
      fs.writeFileSync(file, await this.session.screenshot());
      this.shots += 1;
      return file;
    } catch (err) {
      // A hidden window has nothing to draw; say so instead of failing the test.
      fs.writeFileSync(file.replace(/\.png$/, '.txt'), `no screenshot: ${err.message}\n`);
      return null;
    }
  }

  /** The app process's environment, as it actually ran. */
  appEnv() {
    const out = {};
    for (const line of fs.readFileSync(path.join(this.profile, 'app.env'), 'utf8').split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  }

  appLog() {
    try { return fs.readFileSync(path.join(this.profile, 'app.log'), 'utf8'); } catch { return ''; }
  }

  /** Every file the app has written, relative to the profile. */
  writtenFiles() {
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(path.relative(this.profile, full));
      }
    };
    walk(this.profile);
    return out;
  }

  /**
   * The check behind the whole harness: the app is on the private display,
   * the private bus, and writing only into its profile. Runs on every launch.
   */
  async assertIsolated() {
    const actual = this.appEnv();
    for (const [key, value] of Object.entries(env.expected)) {
      assert.equal(actual[key], value, `app ${key} must be the harness's own`);
    }
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) {
      assert.ok(actual[key]?.startsWith(this.profile), `app ${key} (${actual[key]}) must be inside the profile`);
    }
    if (!('DISPLAY' in env.expected)) {
      assert.equal(actual.DISPLAY, undefined, 'app must not inherit a DISPLAY');
    }
    const screen = await this.exec('return { width: screen.width, height: screen.height }');
    assert.deepEqual(screen, MONITOR, 'the webview must see the virtual monitor, not a real screen');
  }

  // ── Lifecycle ──

  /** Ask the app to exit through its own quit path, then drop the session. */
  async quit() {
    try {
      await this.use('peekaboo');
      await this.session.execAsync(
        'const done = arguments[0]; window.__TAURI_INTERNALS__.invoke("quit_app").catch(() => {}); setTimeout(() => done(true), 50);',
      );
      await waitUntil(() => !alive(this.pid), { timeout: 5000, what: 'the app to quit' });
    } catch {
      // Fall through: the session delete and the kill below cover it.
    }
    await this.close();
  }

  async close() {
    try { await this.session.delete(); } catch { /* the driver may have lost it already */ }
    if (this.pid && alive(this.pid)) {
      try { process.kill(this.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Launch the app for one test, hand it to `body`, and clean up whatever
 * happens. A failing test gets a screenshot of where it stopped and the app's
 * own log in the error, which is usually where the explanation is.
 */
export function withApp(options, body) {
  return async (t) => {
    const slug = slugify(t.name);
    const app = await launchApp({ name: slug, ...options });
    try {
      await body(app, t);
      if (app.shots === 0) await app.shot(slug);
    } catch (err) {
      await app.shot(`${slug}-failed`).catch(() => {});
      const log = app.appLog().trim();
      if (log) err.message += `\n\n--- app.log ---\n${log.slice(-4000)}`;
      throw err;
    } finally {
      await app.quit();
    }
  };
}

export function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
