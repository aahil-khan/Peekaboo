import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, seededSettings, mock } from '../lib/app.mjs';

/*
 * Built-in plugins in the real webview. They are compiled into the binary,
 * discovered over IPC, and imported as ES modules from the app's
 * `peekaboo-plugin:` scheme; none of that runs in vitest.
 *
 * Loading depends on the Content Security Policy in tauri.conf.json naming
 * that scheme in script-src. Nothing but these tests would notice a mismatch:
 * `tauri dev` serves the frontend from Vite, where the policy is not applied.
 * That is how plugins came to be dead in every built app while working for
 * everyone who developed them (they were data: URLs then, which the policy
 * refuses).
 */

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

test('/resources resolves to an attachment and the attachment reaches the model', withApp({ settings: seededSettings() }, async (app) => {
  // The fix must not have been "allow data: scripts": the policy should still
  // refuse a script the page is handed as a string.
  const violations = await app.session.execAsync(
    `const done = arguments[0]; const out = [];
     window.addEventListener("securitypolicyviolation", (e) => out.push(e.violatedDirective + " blocked " + e.blockedURI));
     import("data:text/javascript;base64," + btoa("export default 1")).catch(() => {});
     setTimeout(() => done(out), 500);`,
  );
  assert.ok(violations.some((v) => v.includes('script-src')), `a data: module import is still refused by the CSP (saw ${JSON.stringify(violations)})`);
  // Naming script-src explicitly must not have cost the page its own inline
  // bootstrap script, which is what stamps the window kind before first paint.
  assert.equal(await app.exec('return document.documentElement.dataset.window'), 'peek', 'the inline bootstrap script in index.html still runs');

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

test('/clipboard previews what the clipboard holds', withApp({ settings: seededSettings() }, async (app) => {
  await app.showOverlay();
  await app.type('.peek-surface textarea', '/');
  await app.waitFor('return document.querySelectorAll(".peek-slash-item-title").length > 0', { what: 'the slash menu' });
  // Put something on the (private compositor's) clipboard through the same
  // plugin API the app uses; a headless compositor has no clipboard manager.
  await app.invoke('plugin:clipboard-manager|write_text', { data: { plainText: { text: 'copied for the e2e test' } } }).catch(() => {});
  await app.type('.peek-surface textarea', '/clipboard ');
  // The menu shows "Type to search." until the plugin's search() answers, so
  // wait for the plugin's own words rather than for the first thing on screen.
  // Either the text came back through the compositor, or the plugin reports
  // honestly that it could not read the clipboard; both are correct behaviour.
  const first = await app.waitFor(
    `const el = document.querySelector(".peek-slash-item-title, .peek-slash-group");
     const text = el ? el.innerText.trim() : "";
     return /copied for the e2e test|Clipboard (is empty|unavailable)/.test(text) ? text : null;`,
    { what: 'the clipboard plugin to answer (a preview, "Clipboard is empty" or "Clipboard unavailable")' },
  );
  assert.ok(first.length > 0);
  await app.shot('plugins-clipboard');
}));
