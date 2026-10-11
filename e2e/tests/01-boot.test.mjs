import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, seededSettings, env, mock } from '../lib/app.mjs';

/*
 * Boot. These run first because everything else assumes them, and because
 * `launchApp` re-checks the isolation on every launch: the app is on the
 * private display and bus, and every file it writes is inside its profile.
 */

test('a fresh profile boots without a panic and shows the setup wizard', withApp({}, async (app) => {
  await app.use('setup');
  await app.waitFor('return !!document.querySelector(".peek-wizard")', { what: 'the setup wizard to render' });
  assert.equal(await app.exec('return document.visibilityState'), 'visible', 'the setup window should be shown');
  assert.match(await app.text('.peek-wizard'), /Ollama/, 'the wizard lists providers');

  // The overlay exists but is hidden, and nothing has been persisted as done.
  await app.use('peekaboo');
  assert.equal(await app.exec('return document.visibilityState'), 'hidden', 'the overlay window stays hidden');
  const persisted = await app.exec('return JSON.parse(localStorage.getItem("peekaboo-settings") || "{}").state?.setupCompleted ?? false');
  assert.equal(persisted, false);

  assert.doesNotMatch(app.appLog(), /panicked at/, 'no Rust panic in the app log');
  await app.use('setup');
  await app.shot('boot-fresh-setup-wizard');
}));

test('a seeded profile boots straight to a hidden overlay', withApp({ settings: seededSettings() }, async (app) => {
  await app.use('peekaboo');
  assert.equal(await app.exec('return document.visibilityState'), 'hidden', 'the overlay starts hidden');
  const state = await app.exec('return JSON.parse(localStorage.getItem("peekaboo-settings")).state');
  assert.equal(state.setupCompleted, true, 'the seed survived the relaunch');
  assert.equal(state.ollamaBaseUrl, env.mockUrl);

  // The setup window is pre-created hidden and must stay that way.
  await app.use('setup');
  assert.equal(await app.exec('return document.visibilityState'), 'hidden', 'setup must not appear on a configured install');
  assert.doesNotMatch(app.appLog(), /panicked at/, 'no Rust panic in the app log');

  await app.showOverlay();
  await app.shot('boot-seeded-overlay');
}));

test('the app writes only into its profile', withApp({ settings: seededSettings() }, async (app) => {
  await app.showOverlay();
  await app.ask('write something');
  const files = app.writtenFiles();
  const outside = files.filter((f) => !/^(home|config|data|cache)\//.test(f) && !/^app\.(pid|env|log)$/.test(f));
  assert.deepEqual(outside, [], 'nothing outside the four XDG roots');
  assert.ok(files.some((f) => f === 'config/com.peekaboo.app/peekaboo.db'), 'history database in the config dir');
  assert.ok(files.some((f) => f.startsWith('data/com.peekaboo.app/')), 'WebKit data in the data dir');

  const actual = app.appEnv();
  assert.equal(actual.HOME, `${app.profile}/home`);
  assert.ok(!('XDG_RUNTIME_DIR' in actual) || actual.XDG_RUNTIME_DIR === env.expected.XDG_RUNTIME_DIR);
  await mock.reset();
}));
