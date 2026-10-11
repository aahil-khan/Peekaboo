import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { withApp, seededSettings, env } from '../lib/app.mjs';
import { sleep, waitUntil } from '../lib/procs.mjs';

/*
 * The configurable summon hotkey (PR #11). Rust owns it: registered before
 * the frontend loads, saved as hotkey.json in the app config directory.
 *
 * Registration needs an X11 display (the global-hotkey crate speaks nothing
 * else). On the mutter display that is Xwayland; on Xvfb it is the display
 * itself. With E2E_X11=0 there is none, and these tests show what a pure
 * Wayland session gets.
 */

const DEFAULT = 'Ctrl+Alt+Space';
const CONFIG = 'config/com.peekaboo.app/hotkey.json';
const display = env.expected.DISPLAY ?? null;
const lib = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'lib');

function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', path.join(lib, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}: ${err.trim()}`))));
  });
}

/** Press a chord with X11 key events (XTest): these enter Xwayland directly. */
const xtest = (...names) => run('xkeys.py', [display, ...names]);

/**
 * Press a chord through the compositor (mutter's RemoteDesktop interface on
 * the private bus): routed by focus like a physical keyboard. Only mutter
 * offers it; under Xvfb, XTest *is* the display server's own input.
 */
const compositor = (...names) => run('compositor-keys.py', names);
const CHORD_XTEST = ['Control_L', 'Alt_L', 'space'];
const CHORD_EVDEV = ['KEY_LEFTCTRL', 'KEY_LEFTALT', 'KEY_SPACE'];
const pressChord = () => (env.displayKind === 'mutter' ? compositor(...CHORD_EVDEV) : xtest(...CHORD_XTEST));
const injection = env.displayKind === 'mutter' ? 'mutter RemoteDesktop (compositor-level)' : 'XTest on Xvfb';

/** Hold an X11 window open on the private display; resolves once it is mapped. */
function xwindow() {
  const child = spawn('python3', ['-I', path.join(lib, 'xwin.py'), display], { stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [];
  child.stdout.on('data', (d) => events.push(...d.toString().split('\n').filter(Boolean)));
  const mapped = waitUntil(() => events.includes('mapped'), { timeout: 10000, what: 'the X11 window to map' });
  return { child, events, mapped, close: () => { child.stdin.end(); child.kill(); } };
}

// Without X11 the chord cannot be registered, and Rust is written to say so
// in `error`. It does not: the global-hotkey crate opens its X11 connection
// on a thread and reports Ok when that thread has died, so the app believes
// the hotkey is live on a pure-Wayland session. Bug 2 in the harness PR.
const SILENT_X11_FAILURE = 'the app reports the hotkey as registered with no X11 display (harness PR, bug 2)';

test('get_hotkey reports the default chord, registered', { todo: display ? false : SILENT_X11_FAILURE }, withApp({ settings: seededSettings() }, async (app, t) => {
  const info = await app.invoke('get_hotkey');
  assert.equal(info.default, DEFAULT);
  assert.equal(info.hotkey, DEFAULT);
  if (display) {
    assert.equal(info.error, null, `the default registered on ${display}`);
  } else {
    t.diagnostic(`no X11 display: get_hotkey answered ${JSON.stringify(info)}`);
    assert.match(info.error ?? '', /could not be registered/, 'with no X11 display the app should say the chord is not registered');
  }
}));

test('a changed hotkey persists to hotkey.json and the legend follows', withApp({ settings: seededSettings() }, async (app) => {
  const file = path.join(app.profile, CONFIG);
  assert.equal(fs.existsSync(file), false, 'no config file while the default is in use');

  const info = await app.invoke('set_hotkey', { hotkey: 'control+shift+F9' });
  assert.equal(info.hotkey, 'Ctrl+Shift+F9', 'stored in canonical spelling');
  assert.equal(info.error, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { hotkey: 'Ctrl+Shift+F9' });

  await app.showOverlay();
  await app.press('/', { alt: true });
  const legend = await app.waitFor('const el = document.querySelector(".peek-history"); return el && el.innerText.includes("Ctrl+Shift+F9") ? el.innerText : null', { what: 'the legend to show the new chord' });
  assert.doesNotMatch(legend, /Ctrl\+Alt\+Space/, 'the old chord is gone from the legend');
  await app.shot('hotkey-legend-after-change');
  await app.press('Escape');

  // Rejected chords leave the active one alone.
  await assert.rejects(app.invoke('set_hotkey', { hotkey: 'F9' }), /modifier/);
  assert.equal((await app.invoke('get_hotkey')).hotkey, 'Ctrl+Shift+F9');

  // Back to the default removes the file rather than writing it.
  await app.invoke('set_hotkey', { hotkey: DEFAULT });
  assert.equal(fs.existsSync(file), false, 'saving the default deletes hotkey.json');
}));

test('a saved hotkey is registered at the next launch', withApp({
  settings: seededSettings(),
  files: { [CONFIG]: JSON.stringify({ hotkey: 'Ctrl+Shift+F9' }) },
}, async (app) => {
  const info = await app.invoke('get_hotkey');
  assert.equal(info.hotkey, 'Ctrl+Shift+F9');
  if (display) assert.equal(info.error, null);
}));

test('a corrupt hotkey.json falls back to the default', withApp({
  settings: seededSettings(),
  files: { [CONFIG]: '{not json' },
}, async (app) => {
  assert.equal((await app.invoke('get_hotkey')).hotkey, DEFAULT);
}));

test('the Settings recorder changes the hotkey from a key press', withApp({ settings: seededSettings() }, async (app) => {
  await app.invoke('open_settings');
  await app.use('settings');
  await app.waitFor('return !!document.querySelector(".peek-hotkey-recorder")', { what: 'the hotkey recorder' });
  assert.equal(await app.text('.peek-hotkey-recorder'), DEFAULT);
  await app.click('.peek-hotkey-recorder');
  await app.waitFor('return document.querySelector(".peek-hotkey-recorder").dataset.recording === "true"', { what: 'recording to start' });
  await app.press('k', { ctrl: true, shift: true, css: '.peek-hotkey-recorder' });
  await app.waitFor('return document.querySelector(".peek-hotkey-recorder").innerText.trim() === "Ctrl+Shift+K"', { what: 'the recorder to show the new chord' });
  // Stored by W3C code name ("KeyK"), shown as the key's label ("K").
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app.profile, CONFIG), 'utf8')), { hotkey: 'Ctrl+Shift+KeyK' });
  assert.equal((await app.invoke('get_hotkey')).hotkey, 'Ctrl+Shift+KeyK');
  await app.shot('hotkey-recorder');
}));

/*
 * Real key events. Two ways to inject them:
 *  - compositor-level: mutter's RemoteDesktop interface feeds the keys into
 *    its own input path, so they are routed by focus like a physical keyboard
 *    (Wayland-native window focused: the key goes to it and Xwayland never
 *    sees it; X11 window focused: Xwayland gets it and the grab can fire);
 *  - XTest: an X11 request straight into Xwayland, so the grab fires no matter
 *    what has focus. Says nothing about a real keyboard on Wayland; kept as a
 *    reference and as the only option on Xvfb, where it is the server's input.
 *
 * The case that must hold is the one a GNOME user hits: focus in some other
 * X11 app, press the chord, Peekaboo appears.
 */

/** Was a plain key, injected this way, delivered to the focused X11 window? */
async function deliversToX11(press, win) {
  const seen = win.events.filter((e) => e.startsWith('keypress')).length;
  await press();
  return waitUntil(() => win.events.filter((e) => e.startsWith('keypress')).length > seen, { timeout: 3000, what: 'the X11 window to see a key' }).then(() => true, () => false);
}

/** Was a plain key, injected this way, delivered to the focused webview? */
async function deliversToWebview(app, press) {
  await app.exec('window.__e2eKeys = []; window.addEventListener("keydown", (e) => window.__e2eKeys.push(e.key), true)');
  await press();
  return app.waitFor('return window.__e2eKeys.length > 0', { timeout: 3000, what: 'the webview to see a key' }).then(() => true, () => false);
}

async function chordToggles(app, press) {
  await app.use('peekaboo');
  const before = await app.exec('return document.visibilityState');
  await press();
  const after = await waitUntil(async () => {
    const now = await app.exec('return document.visibilityState');
    return now !== before ? now : null;
  }, { timeout: 4000, what: 'a visibility change' }).catch(() => before);
  return { fired: after !== before, before, after };
}

const METHODS = env.displayKind === 'mutter'
  ? [
    ['compositor-level (mutter RemoteDesktop NotifyKeyboardKeycode)', () => compositor(...CHORD_EVDEV), () => compositor('KEY_K')],
    ['XTest into Xwayland (reference only)', () => xtest(...CHORD_XTEST), () => xtest('k')],
  ]
  : [['XTest on Xvfb', () => xtest(...CHORD_XTEST), () => xtest('k')]];

test('the chord summons the overlay from an X11 window, with real key events', { skip: display ? false : 'no X11 display on this run' }, withApp({ settings: seededSettings() }, async (app, t) => {
  const [name, chord, key] = METHODS[0];
  t.diagnostic(`key injection: ${name}`);
  const win = xwindow();
  try {
    await win.mapped;
    await sleep(700);
    const delivered = await deliversToX11(key, win);
    t.diagnostic(`plain key delivered to the focused X11 window: ${delivered}`);

    const summon = await chordToggles(app, chord);
    t.diagnostic(`X11 window focused: chord ${summon.fired ? 'fired' : 'did not fire'} (${summon.before} -> ${summon.after})`);
    assert.ok(summon.fired && summon.after === 'visible', 'Ctrl+Alt+Space summons the overlay while an X11 window has focus');
    await app.shot('hotkey-summoned');

    // Informative: the overlay itself (Wayland-native on mutter) now has focus.
    await sleep(500);
    const overlayFocused = await app.exec('return document.hasFocus()');
    const dismiss = await chordToggles(app, chord);
    t.diagnostic(`overlay focused (hasFocus=${overlayFocused}): chord ${dismiss.fired ? 'hid it' : 'did not fire'}`);
    if (!dismiss.fired) await app.hideOverlay();
  } finally {
    win.close();
  }
}));

// One app per injection method: the two leave different modifier state
// behind in Xwayland, and mixing them in one session muddles the results.
for (const [name, chord, key] of METHODS) {
  test(`experiment (${name.split(' ')[0]}): does the X11 grab fire with an X11 window focused versus a Wayland-native window focused?`, { skip: display ? false : 'no X11 display on this run' }, withApp({ settings: seededSettings() }, async (app, t) => {
    const lines = [`display=${display} kind=${env.displayKind} | injection: ${name}`];

    // Case A: nothing of ours has focus.
    const a = await chordToggles(app, chord);
    if (a.after === 'visible') await app.hideOverlay();
    lines.push(`no window focused | chord ${a.fired ? 'FIRED' : 'did not fire'}`);

    // Case B: an X11 window (bare Xlib, mapped on the display) has focus.
    const win = xwindow();
    try {
      await win.mapped;
      await sleep(700);
      const delivered = await deliversToX11(key, win);
      const b = await chordToggles(app, chord);
      if (b.after === 'visible') await app.hideOverlay();
      lines.push(`X11 window focused (FocusIn seen: ${win.events.includes('focused')}, plain key delivered: ${delivered}) | chord ${b.fired ? 'FIRED' : 'did not fire'}`);
    } finally {
      win.close();
    }
    await sleep(500);

    // Case C: a Wayland-native window: the app's own Settings window. Whether
    // the headless compositor actually gives it keyboard focus is recorded,
    // because without that the line says nothing.
    await app.use('peekaboo');
    await app.invoke('open_settings');
    await app.use('settings');
    await app.waitFor('return document.visibilityState === "visible"', { what: 'the settings window' });
    await sleep(700);
    const focused = await app.exec('return document.hasFocus()');
    const delivered = await deliversToWebview(app, key);
    const c = await chordToggles(app, chord);
    if (c.after === 'visible') await app.hideOverlay();
    lines.push(`Wayland-native window focused (document.hasFocus: ${focused}, plain key delivered: ${delivered}) | chord ${c.fired ? 'FIRED' : 'did not fire'}`);

    // How Xwayland was started matters for reading XTest lines: with EI
    // (-enable-ei-portal) XTest can be forwarded to the compositor; without
    // it Xwayland handles XTest itself and the compositor never sees it.
    const xwayland = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map((pid) => {
      try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').split('\0').join(' ').trim(); } catch { return ''; }
    }).find((cmd) => /(^|\/)Xwayland /.test(cmd) && cmd.includes(` ${display} `)) ?? '(not found)';
    lines.push(`Xwayland: ${xwayland}`);

    for (const line of lines) t.diagnostic(line);
    fs.appendFileSync(path.join(env.outDir, 'hotkey-focus-experiment.txt'), lines.join('\n') + '\n\n');
    // No assertion on purpose: this records behaviour for the open question in
    // the PR; the test above is the one that must hold.
  }));
}
