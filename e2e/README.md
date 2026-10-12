# End-to-end tests

`npm run e2e` launches the real Peekaboo binary where nobody can see it,
drives its real WebKitGTK webview, and asserts on what the app does: what
it renders, what it sends to the model server, what it writes to disk.

```
npm run e2e                  # everything in e2e/tests
npm run e2e -- boot hotkey   # only files whose name contains one of these
npm run e2e -- --build       # rebuild the app first (it builds if the binary is missing)
E2E_REAL_OLLAMA=1 npm run e2e -- real   # one question to the Ollama on this machine
```

Screenshots, the hotkey experiment's report and the log of every process the
harness started land in `e2e/out/` (git-ignored). A failing test saves
`<test-name>-failed.png` and appends the app's own log to its error.

## What runs, and why each piece is there

The user is often working on the same desktop while a run happens, so the
app under test must never appear on their screen, take their focus, grab
their keys, or touch their data. Each part below removes one way that could
happen. `run.mjs` starts them in this order and kills every process group on
exit, including on Ctrl-C or a crash.

| Piece | What | Why |
| --- | --- | --- |
| Temp root | `mkdtemp` under the system temp dir, short name (`pk-e2e-XXXX`) | Unix socket paths are limited to 108 bytes; the Wayland and bus sockets live here. Deleted at the end unless `--keep` / `E2E_KEEP=1`. |
| `XDG_RUNTIME_DIR` | `<root>/run`, mode 0700 | Where Wayland sockets are looked up. The user's compositor socket is in a different directory, so the app cannot find it even by accident. |
| Session bus | `dbus-daemon` on `<root>/run/bus`, with a config that has no service directories | The single-instance plugin claims a bus name; on the user's bus a test instance would swallow their own launch. Nothing can be D-Bus-activated on this bus (the stock session config would start the real xdg-desktop-portal on the app's first portal call), so notifications, the tray and portals go nowhere, which is intended, and a test can stand in for a portal. |
| Display | **mutter** `--headless --virtual-monitor 1600x900` locally; **Xvfb** in CI (`E2E_DISPLAY=xvfb`) | Mutter headless is a real GNOME compositor on a virtual monitor with no seat, so the app runs Wayland-native exactly as on the user's desktop, with Xwayland for the X11-only global hotkey. CI runners have no GPU and no mutter, so there the app runs on GTK's X11 backend under Xvfb. |
| Mock model server | `lib/mock-ollama.mjs` on `$PORT+1` | Deterministic answers, and it records every request so tests assert on what the app actually sent. `$PORT+3` is kept free as the "unreachable server". |
| WebKitWebDriver | `/usr/bin/WebKitWebDriver` on `$PORT+2` | Ships with webkit2gtk. It launches the app itself and talks to its webview over the inspector protocol, so it carries the display and bus environment for the app. `tauri-driver` is only a proxy in front of it that renames capabilities, so it is not needed; the one thing it added is the `TAURI_WEBVIEW_AUTOMATION=true` variable, which `launch.sh` sets. |
| `lib/launch.sh` | The "browser binary" the driver starts | One driver serves every test but each test wants its own profile, so the profile comes in as a browser argument and the script turns it into `HOME` and the three `XDG_*_HOME` variables before `exec`ing the real binary. It also records the app's pid and environment for the isolation check. |

Every launch (`launchApp` in `lib/app.mjs`) then re-checks the isolation:
the app's recorded environment names the private display, bus and runtime
dir and nothing else; its `HOME` and XDG directories are inside the profile;
and the webview reports a 1600x900 screen, which no real monitor here has.
The boot test additionally lists every file the app wrote and asserts they
are all under the profile (SQLite history in `config/com.peekaboo.app/`,
WebKit data in `data/com.peekaboo.app/`, caches in `cache/`).

WebKitWebDriver chooses an extra loopback port of its own for the inspector
connection (`WEBKIT_INSPECTOR_SERVER`); it has no option to pin it.

## Writing a test

Tests are plain `node:test` files in `e2e/tests/`, run serially (one app at a
time, since WebKitWebDriver holds one session). Use `withApp`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, seededSettings, mock } from '../lib/app.mjs';

test('asking a question sends the system prompt', withApp({ settings: seededSettings() }, async (app) => {
  await mock.reset();
  await app.showOverlay();                 // invoke('show_peek') and wait for the input
  const answer = await app.ask('hello');   // type, Enter, wait for the stream to end
  assert.equal(answer, 'The mock model says hello.');
  const [chat] = await mock.to('/api/chat');
  assert.equal(chat.body.messages[0].role, 'system');
  await app.shot('my-feature');            // e2e/out/my-feature.png
}));
```

- `settings` seeds the persisted frontend settings (`peekaboo-settings` in
  localStorage). `seededSettings()` is "setup done, Ollama at the mock". The
  seed goes in through a first launch that quits, so the launch the test
  sees is a genuine boot of a configured install. Omit it for a fresh
  profile, which shows the setup wizard.
- `files` writes profile-relative files before the first launch, e.g.
  `{ 'config/com.peekaboo.app/hotkey.json': '...' }`. A file named `env`
  (one `NAME=value` per line) is exported into the app's environment by
  `launch.sh`; the portal hotkey tests use it for `PEEKABOO_HOTKEY_BACKEND`.
- `app.use('settings' | 'setup' | 'peekaboo')` switches the session to that
  window. `app.invoke(command, args)` calls one of the app's Tauri commands
  from inside the webview, exactly as the frontend does.
- `app.exec(script, ...args)` runs JavaScript in the current window;
  `app.waitFor(script)` polls it until truthy. `app.text(css)`,
  `app.isShown(css)`, `app.click(css)`, `app.clickLabelled(ariaLabel)`,
  `app.type(css, text)`, `app.press(key, { alt, ctrl, shift })` drive the UI.
- `mock.reset()`, `mock.configure({ tokens, delayMs })`, `mock.requests()`,
  `mock.to('/api/chat')` control and read the model server. A recorded chat
  request has `body`, `headers`, `aborted` (the app closed the connection
  before the end) and `tokensSent`.
- Wrap a test that documents a known bug in `{ todo: 'pointer to the write-up' }`
  rather than deleting it: it keeps running, its failure does not fail the
  run, and it will show up as passing when the bug is fixed.

### How input works

Fedora's webkit2gtk is built without WebDriver's keyboard and mouse
simulation (every such call answers "unsupported operation"), so `type`,
`press` and `click` dispatch the DOM events inside the page that a real
keystroke or click would produce, on the same elements. Everything after the
event handler (state, IPC, Rust, the network) is real. GTK's own key handling
is not exercised that way; the hotkey test covers it with real X11 key events
(`lib/xkeys.py`, XTEST on the private display), which Xwayland hands to the
compositor as input.

### Things to know

- A hidden window gets no animation frames, so exit animations never finish
  while the overlay is hidden; wait on `document.visibilityState`, not on the
  DOM unmounting. A screenshot of a hidden window never returns; `app.shot`
  checks first and writes a note instead.
- The app's default Ollama URL is `localhost:11434`. A fresh (unseeded)
  profile will talk to a real Ollama on this machine if one is running; seed
  the mock URL for anything that asserts on requests.
- There is no xdg-desktop-portal on the private bus, and the GNOME backend
  for GlobalShortcuts needs gnome-shell behind it, so the portal hotkey path
  is tested against `lib/mock-portal.py`: a Python stand-in that owns
  `org.freedesktop.portal.Desktop` on the private bus and plays the desktop
  (grant, decline, hang, refuse), driven from the test over stdin. It needs
  `python3-gi`. What a real desktop's dialog does is a hand test.
- `E2E_TRACE=1` logs every WebDriver call with timing. `E2E_X11=0` runs the
  mutter display without Xwayland (a pure-Wayland session). `E2E_TEST_TIMEOUT`
  is per test, in ms.
