import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';

/**
 * Every long-running child the harness starts, so one call can end them all.
 *
 * Children run in their own process group. Killing the group takes their own
 * children with them: WebKitWebDriver's app, the app's WebKit helper
 * processes, mutter's Xwayland. Without that a failed run leaves a compositor
 * and a webview behind, and the next run finds its ports and sockets taken.
 */
export class ProcessSet {
  constructor(logDir) {
    this.logDir = logDir;
    this.children = [];
    this.stopped = false;
    const bye = (signal) => () => {
      this.killAll();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    process.once('SIGINT', bye('SIGINT'));
    process.once('SIGTERM', bye('SIGTERM'));
    process.once('exit', () => this.killAll());
  }

  /** Start a child whose stdout and stderr go to <logDir>/<name>.log. */
  start(name, command, args, { env, cwd } = {}) {
    const log = fs.openSync(`${this.logDir}/${name}.log`, 'a');
    const child = spawn(command, args, {
      env,
      cwd,
      detached: true,
      stdio: ['ignore', log, log],
    });
    fs.closeSync(log);
    child.on('exit', (code, signal) => {
      child.exitInfo = { code, signal };
    });
    // Unhandled 'error' events would crash the harness mid-teardown.
    child.on('error', (err) => {
      child.spawnError = err;
    });
    this.children.push({ name, child });
    return child;
  }

  /** SIGTERM every process group, then SIGKILL whatever is still there. */
  killAll() {
    if (this.stopped) return;
    this.stopped = true;
    for (const { child } of this.children.slice().reverse()) {
      if (child.pid && child.exitCode === null && !child.spawnError) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
      }
    }
    const deadline = Date.now() + 3000;
    for (const { child } of this.children) {
      if (!child.pid || child.spawnError) continue;
      while (Date.now() < deadline && child.exitCode === null && isAlive(child.pid)) {
        sleepSync(50);
      }
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `probe` returns a truthy value or the timeout passes. */
export async function waitUntil(probe, { timeout = 10000, every = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for ${what}`);
}

/** Wait for a child to exit, or throw if it does not. */
export function exited(child) {
  return child.exitCode !== null ? Promise.resolve() : once(child, 'exit');
}

/** Whether something is listening on 127.0.0.1:port. */
export function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

export function fileExists(path) {
  try { fs.statSync(path); return true; } catch { return false; }
}
