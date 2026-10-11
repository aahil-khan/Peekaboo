import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, seededSettings, mock } from '../lib/app.mjs';

/*
 * Built-in plugins in the real webview. They are compiled into the binary,
 * discovered over IPC, and loaded as data: URL modules; none of that runs in
 * vitest.
 *
 * Discovery works. Loading does not: the app's Content Security Policy
 * (`default-src 'self'` in tauri.conf.json, no script-src) refuses the
 * `data:` module import the registry uses, so no plugin ever resolves. The
 * two tests below are the bug's reproduction and are marked `todo` until it
 * is fixed; see "Bugs found" in the harness PR.
 */
const PLUGIN_LOADING_BUG = 'plugins cannot load: the CSP blocks data: module imports (harness PR, bug 1)';


test('"/" lists the built-in context commands', withApp({ settings: seededSettings() }, async (app) => {
  await app.showOverlay();
  await app.type('.peek-surface textarea', '/');
  const titles = await app.waitFor(
    `const items = [...document.querySelectorAll(".peek-slash-item-title")].map((el) => el.innerText.trim());
     return items.length ? items : null;`,
    { what: 'the slash menu' },
  );
  for (const command of ['/clipboard', '/file', '/resources']) {
    assert.ok(titles.includes(command), `${command} is listed in ${JSON.stringify(titles)}`);
  }
  await app.shot('plugins-slash-menu');
}));

test('/resources resolves to an attachment and the attachment reaches the model', { todo: PLUGIN_LOADING_BUG }, withApp({ settings: seededSettings() }, async (app) => {
  // Evidence for the write-up: the violation the browser reports.
  const violations = await app.session.execAsync(
    `const done = arguments[0]; const out = [];
     window.addEventListener("securitypolicyviolation", (e) => out.push(e.violatedDirective + " blocked " + e.blockedURI));
     import("data:text/javascript;base64," + btoa("export default 1")).catch(() => {});
     setTimeout(() => done(out), 500);`,
  );
  if (violations.length) console.log(`# CSP violation on a data: import: ${violations.join('; ')}`);

  await mock.reset();
  await app.showOverlay();
  // "/" first: the command list is discovered when the overlay appears, and a
  // command typed before that resolves to nothing.
  await app.type('.peek-surface textarea', '/');
  await app.waitFor('return document.querySelectorAll(".peek-slash-item-title").length > 0', { what: 'the slash menu' });
  await app.type('.peek-surface textarea', '/resources ');
  const items = await app.waitFor(
    `const items = [...document.querySelectorAll(".peek-slash-item-title")].map((el) => el.innerText.trim());
     return items.includes("CPU usage") ? items : null;`,
    { what: 'the /resources items' },
  );
  assert.deepEqual(items, ['CPU usage', 'Memory usage', 'Disk usage', 'Everything']);

  await app.press('Enter', { css: '.peek-surface textarea' });
  const chip = await app.waitFor('return document.querySelector(".peek-chip-label")?.innerText.trim() ?? null', { what: 'the attachment chip' });
  assert.equal(chip, 'CPU');
  assert.equal(await app.exec('return document.querySelector(".peek-surface textarea").value'), '', 'the command is cleared from the input');
  await app.shot('plugins-resources-attached');

  const answer = await app.ask('how busy is this machine?');
  assert.ok(answer.length > 0);
  const [chat] = await mock.to('/api/chat');
  const user = chat.body.messages.find((m) => m.role === 'user');
  assert.match(user.content, /CPU usage: \d+(\.\d+)?%/, 'the measured CPU line went to the model');
  assert.match(user.content, /how busy is this machine\?/, 'along with the question');
}));

test('/clipboard previews what the clipboard holds', { todo: PLUGIN_LOADING_BUG }, withApp({ settings: seededSettings() }, async (app) => {
  await app.showOverlay();
  await app.type('.peek-surface textarea', '/');
  await app.waitFor('return document.querySelectorAll(".peek-slash-item-title").length > 0', { what: 'the slash menu' });
  // Put something on the (private compositor's) clipboard through the same
  // plugin API the app uses; a headless compositor has no clipboard manager.
  await app.invoke('plugin:clipboard-manager|write_text', { data: { plainText: { text: 'copied for the e2e test' } } }).catch(() => {});
  await app.type('.peek-surface textarea', '/clipboard ');
  const first = await app.waitFor(
    `const el = document.querySelector(".peek-slash-item-title, .peek-slash-group, .peek-slash-empty");
     return el ? el.innerText.trim() : null;`,
    { what: 'the clipboard item' },
  );
  // Either the text came back through the compositor, or the plugin reports
  // honestly that it could not read the clipboard; both are correct behaviour.
  assert.ok(/copied for the e2e test|Clipboard (is empty|unavailable)/.test(first), `clipboard entry: ${first}`);
  await app.shot('plugins-clipboard');
}));
