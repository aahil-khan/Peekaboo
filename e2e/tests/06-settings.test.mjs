import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, seededSettings, mock, env } from '../lib/app.mjs';

/*
 * The Settings window. It runs under a different Tauri capability file
 * (aux-windows.json) than the overlay, so "the overlay can reach the server"
 * says nothing about whether Settings can. This is the test that would have
 * caught a missing `http` permission there.
 */

async function openSettings(app, section) {
  await app.use('peekaboo');
  await app.invoke('open_settings');
  await app.use('settings');
  await app.waitFor('return !!document.querySelector(".peek-settings-nav")', { what: 'the settings window to render' });
  if (section) {
    await app.exec(
      `const btn = [...document.querySelectorAll(".peek-settings-navbtn")].find((b) => b.innerText.trim() === arguments[0]);
       if (!btn) throw new Error("no settings section " + arguments[0]);
       btn.click();`,
      section,
    );
  }
}

async function checkConnection(app) {
  await app.exec(
    `const btn = [...document.querySelectorAll("button")].find((b) => /^Check (connection|& switch)$/.test(b.innerText.trim()));
     if (!btn) throw new Error("no check-connection button");
     btn.click();`,
  );
  return app.waitFor(
    `const el = document.querySelector(".peek-settings-desc.peek-tone-ok, .peek-settings-desc.peek-tone-error");
     return el ? { ok: el.classList.contains("peek-tone-ok"), text: el.innerText.trim() } : null;`,
    { what: 'the connection check to finish' },
  );
}

test('the Settings window opens and "check connection" reaches the mock', withApp({ settings: seededSettings() }, async (app) => {
  await mock.reset();
  await openSettings(app, 'AI provider');
  assert.equal(await app.exec('return document.visibilityState'), 'visible');
  assert.equal(await app.exec('return document.querySelector("input.peek-field--mono")?.value'), env.mockUrl, 'the Ollama address field shows the configured URL');

  const result = await checkConnection(app);
  assert.equal(result.ok, true, `check connection succeeded: ${result.text}`);
  const tags = await mock.to('/api/tags');
  assert.ok(tags.length >= 1, 'the request came from the Settings window');
  await app.shot('settings-check-connection-ok');
}));

test('"check connection" against a dead server reports the failure', withApp({
  settings: seededSettings({ ollamaBaseUrl: env.deadUrl }),
}, async (app) => {
  await openSettings(app, 'AI provider');
  const result = await checkConnection(app);
  assert.equal(result.ok, false);
  assert.match(result.text, /Ollama|connect/i);
  await app.shot('settings-check-connection-failed');
}));

test('a change in Settings reaches the overlay through the shared store', withApp({ settings: seededSettings() }, async (app) => {
  await openSettings(app, 'AI provider');
  await app.type('input.peek-field--mono', env.deadUrl);
  const wanted = JSON.stringify(env.deadUrl);
  await app.waitFor(
    `return JSON.parse(localStorage.getItem("peekaboo-settings")).state.ollamaBaseUrl === ${wanted}`,
    { what: 'the Settings window to persist the new URL' },
  );
  // localStorage is shared, but the overlay's store only learns of the change
  // through the storage event, which fires in every window but the writer.
  await app.use('peekaboo');
  await app.showOverlay();
  await app.waitFor('return /not detected/.test(document.querySelector(".peek-footer-statustext")?.innerText ?? "")', { what: 'the footer to report the dead server' });
  await app.shot('settings-change-reaches-overlay');
}));
