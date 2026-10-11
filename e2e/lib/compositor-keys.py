#!/usr/bin/env python3
"""Press a key chord through the compositor, the way a physical keyboard does.

    compositor-keys.py KEY_LEFTCTRL KEY_LEFTALT KEY_SPACE

Talks to mutter's org.gnome.Mutter.RemoteDesktop interface on the session bus
it finds in DBUS_SESSION_BUS_ADDRESS (the harness's private bus, never the
user's), opens an input session, presses every key in order and releases
them in reverse. Mutter feeds these into its normal input path, so they are
routed to whichever window has keyboard focus, Wayland-native or Xwayland,
exactly as real key presses are. That is what makes this injection, and not
XTest (which enters Xwayland directly), the one that can say whether an X11
key grab fires while a Wayland window is focused.

Keys are evdev names; the few the hotkey tests need are listed below.
"""
import sys
import time

from gi.repository import Gio, GLib

KEYCODES = {
    "KEY_LEFTCTRL": 29, "KEY_LEFTSHIFT": 42, "KEY_LEFTALT": 56, "KEY_LEFTMETA": 125,
    "KEY_SPACE": 57, "KEY_ENTER": 28, "KEY_ESC": 1, "KEY_F9": 67, "KEY_K": 37, "KEY_Q": 16,
}

DEST = "org.gnome.Mutter.RemoteDesktop"
IFACE = "org.gnome.Mutter.RemoteDesktop.Session"


def main(argv):
    names = argv[1:]
    if not names:
        sys.exit(__doc__)
    codes = []
    for name in names:
        if name not in KEYCODES:
            sys.exit(f"compositor-keys.py: unknown key {name!r}; known: {', '.join(KEYCODES)}")
        codes.append(KEYCODES[name])

    bus = Gio.bus_get_sync(Gio.BusType.SESSION)
    call = lambda path, iface, method, args=None: bus.call_sync(DEST, path, iface, method, args, None, 0, -1, None)
    session = call("/org/gnome/Mutter/RemoteDesktop", DEST, "CreateSession").unpack()[0]
    call(session, IFACE, "Start")
    # The virtual keyboard appears when the session starts; a key sent in the
    # same instant is dropped, so give it a moment to exist.
    time.sleep(0.3)
    try:
        for code in codes:
            call(session, IFACE, "NotifyKeyboardKeycode", GLib.Variant("(ub)", (code, True)))
            time.sleep(0.03)
        for code in reversed(codes):
            call(session, IFACE, "NotifyKeyboardKeycode", GLib.Variant("(ub)", (code, False)))
            time.sleep(0.03)
        # Give the compositor a moment to deliver before the device goes away.
        time.sleep(0.2)
    finally:
        call(session, IFACE, "Stop")


if __name__ == "__main__":
    main(sys.argv)
