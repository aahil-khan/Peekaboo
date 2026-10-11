#!/usr/bin/env node
/**
 * One command for the whole end-to-end run:
 *
 *   npm run e2e              run every test in e2e/tests
 *   npm run e2e -- --build   rebuild the app first
 *   npm run e2e -- boot      only test files whose name contains "boot"
 *
 * It builds the app if the binary is missing, brings up a private display, a
 * private session bus, the mock model server and WebKitWebDriver, runs the
 * tests with node's own runner, and takes everything down again, whatever
 * the outcome. See README.md for why each piece is there.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockOllama } from './lib/mock-ollama.mjs';
import { ProcessSet, waitUntil, portOpen, fileExists, sleep } from './lib/procs.mjs';
import { chooseDisplayKind, startDisplay } from './lib/display.mjs';
import { driverReady } from './lib/webdriver.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, '..');
const argv = process.argv.slice(2);
const wantBuild = argv.includes('--build') || process.env.E2E_BUILD === '1';
const filters = argv.filter((a) => !a.startsWith('--'));

const binary = process.env.PEEKABOO_E2E_BIN || path.join(repo, 'src-tauri', 'target', 'debug', 'peekaboo-app');
const outDir = path.join(here, 'out');
// Ports: the task's own block when there is one (cx sets PORT), else 20000.
const basePort = Number(process.env.PORT || 20000);
const ports = { mock: basePort + 1, driver: basePort + 2, dead: basePort + 3 };

// Unix socket paths are limited to 108 bytes and the Wayland socket, the bus
// socket and WebKit's own live under this root, so it has to be short.
const root = fs.mkdtempSync(path.join(process.env.E2E_TMPDIR || os.tmpdir(), 'pk-e2e-'));
const keepRoot = argv.includes('--keep') || process.env.E2E_KEEP === '1';

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const logDir = path.join(outDir, 'logs');
fs.mkdirSync(logDir);

const procs = new ProcessSet(logDir);
let exitCode = 1;

try {
  exitCode = await main();
} catch (err) {
  console.error(`\ne2e: ${err.stack || err}`);
  exitCode = 1;
} finally {
  procs.killAll();
  await sleep(200);
  if (keepRoot) console.log(`e2e: keeping ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
  console.log(`e2e: logs and screenshots are in ${path.relative(repo, outDir)}`);
}
process.exit(exitCode);

async function main() {
  // ── 1. The app binary ──
  if (wantBuild || !fileExists(binary)) {
    console.log(`e2e: building the app (${wantBuild ? 'requested' : 'no binary at ' + binary})`);
    const build = spawnSync('npx', ['tauri', 'build', '--debug', '--no-bundle'], { cwd: repo, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('the app build failed');
  }
  if (!fileExists(binary)) throw new Error(`no app binary at ${binary}`);

  // ── 2. A private runtime directory and session bus ──
  // XDG_RUNTIME_DIR is where Wayland sockets live and must be 0700. Pointing
  // it here means the app cannot find the user's compositor even by accident.
  const runDir = path.join(root, 'run');
  fs.mkdirSync(runDir, { mode: 0o700 });
  for (const d of ['home', 'config', 'data', 'cache']) fs.mkdirSync(path.join(root, d));
  const baseEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG || 'C.UTF-8',
    XDG_RUNTIME_DIR: runDir,
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    // The compositor and WebKit want a GPU but must not need one.
    LIBGL_ALWAYS_SOFTWARE: process.env.E2E_SOFTWARE_GL === '1' ? '1' : undefined,
  };
  for (const key of Object.keys(baseEnv)) if (baseEnv[key] === undefined) delete baseEnv[key];

  const busPath = path.join(runDir, 'bus');
  procs.start('dbus', 'dbus-daemon', ['--session', '--nofork', '--nopidfile', `--address=unix:path=${busPath}`], { env: baseEnv });
  await waitUntil(() => fileExists(busPath), { what: 'the private session bus' });
  baseEnv.DBUS_SESSION_BUS_ADDRESS = `unix:path=${busPath}`;
  // No accessibility bus on the private session; GTK would otherwise try to
  // spawn one and log an error per process.
  baseEnv.NO_AT_BRIDGE = '1';

  // ── 3. The private display ──
  const kind = chooseDisplayKind();
  const display = await startDisplay(procs, kind, baseEnv, { x11: process.env.E2E_X11 !== '0' });
  console.log(`e2e: display is ${kind} (${Object.entries(display.env).map(([k, v]) => `${k}=${v}`).join(' ')})`);
  const appEnv = { ...baseEnv, ...display.env };

  // ── 4. The mock model server ──
  if (await portOpen(ports.mock)) throw new Error(`port ${ports.mock} is already taken`);
  if (await portOpen(ports.dead)) throw new Error(`port ${ports.dead} must be free; the "unreachable server" tests point at it`);
  const mock = createMockOllama();
  const mockUrl = await mock.listen(ports.mock);

  // ── 5. WebKitWebDriver ──
  // It launches the app itself, so it carries the app's environment. Only
  // the profile differs per test, and that goes through launch.sh.
  if (await portOpen(ports.driver)) throw new Error(`port ${ports.driver} is already taken`);
  procs.start('webkitwebdriver', 'WebKitWebDriver', [`--port=${ports.driver}`], {
    env: { ...appEnv, PEEKABOO_E2E_BIN: binary },
  });
  const driverUrl = `http://127.0.0.1:${ports.driver}`;
  await waitUntil(() => driverReady(driverUrl), { what: 'WebKitWebDriver' });

  // ── 6. The tests ──
  const expected = {
    XDG_RUNTIME_DIR: runDir,
    DBUS_SESSION_BUS_ADDRESS: baseEnv.DBUS_SESSION_BUS_ADDRESS,
    ...display.env,
  };
  const all = fs.readdirSync(path.join(here, 'tests')).filter((f) => f.endsWith('.test.mjs')).sort();
  const files = filters.length ? all.filter((f) => filters.some((x) => f.includes(x))) : all;
  if (files.length === 0) throw new Error(`no test files match ${filters.join(', ')}`);

  const runner = spawn(process.execPath, [
    '--test',
    '--test-concurrency=1',
    '--test-reporter=spec',
    `--test-timeout=${process.env.E2E_TEST_TIMEOUT || 180000}`,
    ...files.map((f) => path.join(here, 'tests', f)),
  ], {
    cwd: repo,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...appEnv,
      PEEKABOO_E2E_BIN: binary,
      E2E_DRIVER_URL: driverUrl,
      E2E_MOCK_URL: mockUrl,
      E2E_DEAD_URL: `http://127.0.0.1:${ports.dead}`,
      E2E_ROOT: root,
      E2E_OUT: outDir,
      E2E_DISPLAY_KIND: kind,
      E2E_EXPECTED_ENV: JSON.stringify(expected),
    },
  });
  const code = await new Promise((resolve) => runner.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0))));
  await mock.close();
  return code;
}
