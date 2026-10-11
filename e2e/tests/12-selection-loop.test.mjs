import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { withApp, seededSettings, mock, env } from '../lib/app.mjs';
import { sleep, waitUntil } from '../lib/procs.mjs';

/*
 * The core loop, for real: text selected in another window, the summon
 * hotkey, the selection attached, an action run against the mock model, and
 * Enter pasting the result back into that window with the clipboard put
 * back afterwards.
 *
 * The "other window" is lib/xtext.py: a bare X11 window that owns the
 * PRIMARY selection (what a selection is on Linux), owns CLIPBOARD with some
 * prior content, and on Ctrl+V reads the clipboard the way any X11 app does.
 * On the mutter display it is an Xwayland client, so the app runs
 * Wayland-native, reads the selection through Xwayland and pastes with XTest
 * into Xwayland, after verifying that this window has X focus; on Xvfb it is
 * the X11 path end to end. The RemoteDesktop portal path (Wayland-native
 * targets) has no portal on the private bus and is a hand test.
 */

const display = env.expected.DISPLAY ?? null;
const lib = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'lib');

const SELECTED = 'i recieved you\'re email yesterday';
const PRIOR_CLIPBOARD = 'what was on the clipboard before';
const CLEANED = 'I received your email yesterday.';

function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', path.join(lib, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}: ${err.trim()}`))));
  });
}

/** The summon chord as real key events, routed by focus where the display allows it. */
const pressChord = () => (env.displayKind === 'mutter'
  ? run('compositor-keys.py', ['KEY_LEFTCTRL', 'KEY_LEFTALT', 'KEY_SPACE'])
  : run('xkeys.py', [display, 'Control_L', 'Alt_L', 'space']));

/** The text window: resolves `mapped` once it is on screen; `events` is its stdout. */
function textWindow(selected, clipboard) {
  const child = spawn('python3', ['-I', path.join(lib, 'xtext.py'), display, selected, clipboard], { stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [];
  child.stdout.on('data', (d) => events.push(...d.toString().split('\n').filter(Boolean)));
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const mapped = waitUntil(() => events.includes('mapped'), { timeout: 10000, what: 'the text window to map' });
  const pasted = () => events.filter((e) => e.startsWith('pasted ')).map((e) => JSON.parse(e.slice('pasted '.length)));
  return { child, events, mapped, pasted, stderr: () => stderr, close: () => { child.stdin.end(); child.kill(); } };
}

test('select, summon, read, paste back: the native loop into the window the text came from', { skip: display ? false : 'no X11 display on this run' }, withApp({ settings: seededSettings() }, async (app, t) => {
  await mock.reset();

  const win = textWindow(SELECTED, PRIOR_CLIPBOARD);
  try {
    await win.mapped;
    await sleep(700);

    // 1. Summon with real key events while the text window has focus. Rust
    //    reads the primary selection and records this window as the source,
    //    before the overlay is shown.
    await pressChord();
    await app.use('peekaboo');
    await app.waitFor('return document.visibilityState === "visible" && !!document.querySelector(".peek-surface textarea")', { timeout: 8000, what: 'the overlay to appear on the chord' });

    // 2. The selection arrived with the summon and the palette is up for it.
    const chip = await app.waitFor('const el = document.querySelector(".peek-chip-label"); return el ? el.innerText.trim() : null', { what: 'the selection chip' });
    assert.match(chip, /^Selection/, 'the attachment is the selection, read from the other window');
    const source = await app.waitFor('const el = document.querySelector(".peek-actions-source-preview"); return el ? el.innerText : null', { what: 'the actions palette' });
    assert.match(source, /i recieved you're email/, 'the palette previews the primary selection it captured');
    await app.shot('selection-loop-summoned');

    // 3. Apply a result. The streaming-then-Enter UI path is covered in
    //    11-actions; here we drive the native paste-back the frontend's
    //    applyResult() calls, to prove the half that was never real: Rust
    //    hides the overlay, confirms this X11 window still has focus, presses
    //    Ctrl+V into it with XTest, and restores the clipboard. (A headless
    //    compositor will not keep a Wayland overlay focused while another X11
    //    window is up, so the rAF-batched stream cannot settle in-window here;
    //    that is a harness limit, not the product's.)
    const outcome = await app.invoke('paste_result', { text: CLEANED });
    assert.equal(outcome.outcome, 'pasted', `the paste was delivered: ${JSON.stringify(outcome)}`);
    assert.match(outcome.method, /XTest/, 'through XTest on X11/Xwayland');

    await waitUntil(() => win.pasted().length > 0, { timeout: 8000, what: 'the text window to receive the paste' })
      .catch((err) => { throw new Error(`${err.message}\nwindow events: ${win.events.join(' | ')}\nwindow stderr: ${win.stderr()}`); });
    assert.deepEqual(win.pasted(), [CLEANED], 'the window read the cleaned result from the clipboard on Ctrl+V');
    t.diagnostic(`text window saw: ${win.events.join(' | ')}`);

    // 4. The clipboard goes back to what it held before the paste.
    const restored = await waitUntil(async () => {
      const text = await app.invoke('plugin:clipboard-manager|read_text').catch(() => null);
      return text === PRIOR_CLIPBOARD ? text : null;
    }, { timeout: 5000, what: 'the clipboard to be restored' });
    assert.equal(restored, PRIOR_CLIPBOARD);
  } finally {
    win.close();
  }
}));

test('a summon with nothing selected opens the overlay without an attachment', { skip: display ? false : 'no X11 display on this run' }, withApp({ settings: seededSettings() }, async (app) => {
  const win = textWindow('', '');
  try {
    await win.mapped;
    await sleep(700);
    await pressChord();
    await app.use('peekaboo');
    await app.waitFor('return document.visibilityState === "visible" && !!document.querySelector(".peek-surface textarea")', { timeout: 8000, what: 'the overlay to appear on the chord' });
    await sleep(500);
    assert.equal(await app.exec('return document.querySelectorAll(".peek-chip-label").length'), 0, 'nothing attached');
    assert.equal(await app.exec('return !!document.querySelector(".peek-actions")'), false, 'no palette without text');
    await app.shot('selection-loop-empty');
  } finally {
    win.close();
  }
}));

test('with capture switched off the summon records the window but attaches nothing', { skip: display ? false : 'no X11 display on this run' }, withApp({ settings: seededSettings({ captureSelectionOnSummon: false }) }, async (app) => {
  const win = textWindow(SELECTED, PRIOR_CLIPBOARD);
  try {
    await win.mapped;
    await sleep(700);
    await pressChord();
    await app.use('peekaboo');
    await app.waitFor('return document.visibilityState === "visible" && !!document.querySelector(".peek-surface textarea")', { timeout: 8000, what: 'the overlay to appear on the chord' });
    await sleep(500);
    assert.equal(await app.exec('return document.querySelectorAll(".peek-chip-label").length'), 0, 'the selection was not read');
    const info = await app.invoke('selection_capture_info');
    assert.deepEqual(info, { method: 'primary-selection', available: true, defaultOn: true });
  } finally {
    win.close();
  }
}));
