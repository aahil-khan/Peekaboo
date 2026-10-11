import fs from 'node:fs';
import { waitUntil, fileExists } from './procs.mjs';

/**
 * A display server nobody can see.
 *
 * Locally that is mutter in headless mode: a real GNOME compositor with a
 * virtual monitor and no connection to any seat, so the app under test is
 * Wayland-native exactly as it is on the user's desktop, and Xwayland is there
 * for the X11-only global hotkey. In CI there is no GPU and no mutter, so the
 * harness takes Xvfb and the app runs through GTK's X11 backend instead.
 *
 * The monitor is 1600x900 on purpose: an unusual size the app can report back
 * through `screen.width`, which is how a test proves the window is here and
 * not on a real screen.
 */
export const MONITOR = { width: 1600, height: 900 };

export function chooseDisplayKind() {
  const asked = process.env.E2E_DISPLAY;
  if (asked && asked !== 'auto') return asked;
  if (fileExists('/usr/bin/mutter')) return 'mutter';
  if (fileExists('/usr/bin/Xvfb')) return 'xvfb';
  throw new Error('Neither mutter nor Xvfb is installed; set E2E_DISPLAY to one that is');
}

/**
 * Start the display server and return the environment that makes a GTK app
 * use it. `baseEnv` already points XDG_RUNTIME_DIR and the session bus into
 * the private root; the display server lives there too.
 */
export async function startDisplay(procs, kind, baseEnv, { x11 = true } = {}) {
  if (kind === 'mutter') return startMutter(procs, baseEnv, { x11 });
  if (kind === 'xvfb') return startXvfb(procs, baseEnv);
  throw new Error(`Unknown display kind ${kind}`);
}

async function startMutter(procs, baseEnv, { x11 }) {
  const name = `peekaboo-e2e-${process.pid}`;
  const args = [
    '--wayland', '--headless',
    '--wayland-display', name,
    '--virtual-monitor', `${MONITOR.width}x${MONITOR.height}`,
  ];
  // Without Xwayland the app cannot register its global hotkey at all (the
  // crate behind it only speaks X11), which is the pure-Wayland situation.
  if (!x11) args.push('--no-x11');
  const env = {
    ...baseEnv,
    // Mutter reads GNOME keybindings and the like through gsettings. The
    // memory backend keeps it away from the user's dconf database entirely.
    GSETTINGS_BACKEND: 'memory',
  };
  delete env.WAYLAND_DISPLAY;
  delete env.DISPLAY;

  const child = procs.start('mutter', 'mutter', args, { env });
  const socket = `${baseEnv.XDG_RUNTIME_DIR}/${name}`;
  await waitUntil(() => fileExists(socket) || child.exitCode !== null, { timeout: 20000, what: 'the mutter Wayland socket' });
  if (child.exitCode !== null) throw new Error(`mutter exited with ${child.exitCode}; see mutter.log`);

  const result = { kind: 'mutter', env: { WAYLAND_DISPLAY: name, GDK_BACKEND: 'wayland' } };
  if (x11) {
    // Mutter picks a free X display number and logs it ("Using public X11
    // display :2"). Xwayland itself only starts when the first X11 client
    // connects, which will be the app's hotkey registration.
    const log = `${procs.logDir}/mutter.log`;
    const display = await waitUntil(() => {
      const match = fs.readFileSync(log, 'utf8').match(/Using public X11 display (:\d+)/);
      return match ? match[1] : null;
    }, { timeout: 10000, what: 'mutter to announce its Xwayland display' }).catch(() => null);
    if (display) {
      result.env.DISPLAY = display;
      // Xwayland requires the cookie mutter generated for it. Both the app's
      // hotkey registration and the test's key injection need it.
      const auth = fs.readdirSync(baseEnv.XDG_RUNTIME_DIR).find((f) => f.startsWith('.mutter-Xwaylandauth.'));
      if (auth) result.env.XAUTHORITY = `${baseEnv.XDG_RUNTIME_DIR}/${auth}`;
    }
  }
  return result;
}

async function startXvfb(procs, baseEnv) {
  let number = 90;
  while (fileExists(`/tmp/.X${number}-lock`) || fileExists(`/tmp/.X11-unix/X${number}`)) number += 1;
  const display = `:${number}`;
  const env = { ...baseEnv };
  delete env.WAYLAND_DISPLAY;
  delete env.DISPLAY;
  const child = procs.start('xvfb', 'Xvfb', [display, '-screen', '0', `${MONITOR.width}x${MONITOR.height}x24`, '-nolisten', 'tcp'], { env });
  await waitUntil(() => fileExists(`/tmp/.X11-unix/X${number}`) || child.exitCode !== null, { timeout: 15000, what: 'the Xvfb socket' });
  if (child.exitCode !== null) throw new Error(`Xvfb exited with ${child.exitCode}; see xvfb.log`);

  // Bare Xvfb has no window manager, so when the overlay unmaps nothing hands
  // keyboard focus back to the window the user was in — focus just vanishes,
  // which no real desktop does and which breaks paste-back's "is the previous
  // window still focused?" check. A tiny WM (openbox) reverts focus the way
  // mutter and every real session do. Optional: without it the display still
  // works for everything that does not depend on focus returning.
  const displayEnv = { ...env, DISPLAY: display };
  if (fileExists('/usr/bin/openbox')) {
    procs.start('openbox', 'openbox', ['--sm-disable'], { env: displayEnv });
  }
  return { kind: 'xvfb', env: { DISPLAY: display, GDK_BACKEND: 'x11' } };
}

