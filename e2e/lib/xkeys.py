#!/usr/bin/env python3
"""Press a key chord on an X display with the XTEST extension.

    xkeys.py :2 Control_L Alt_L space

Every name but the last is held while the last is tapped. On the harness's
mutter display these land in Xwayland, which hands them to the compositor as
real input, so they reach whichever window has focus, Wayland-native or not.
On Xvfb they are plain X11 input. Either way they are what the app's global
hotkey (an X11 passive grab) is waiting for.
"""
import sys
import time

from Xlib import X, XK, display
from Xlib.ext import xtest


def main(argv):
    if len(argv) < 3:
        sys.exit(__doc__)
    disp = display.Display(argv[1])
    names = argv[2:]
    codes = []
    for name in names:
        keysym = XK.string_to_keysym(name)
        code = disp.keysym_to_keycode(keysym)
        if not keysym or not code:
            sys.exit(f"xkeys.py: no keycode for {name!r}")
        codes.append(code)
    for code in codes:
        xtest.fake_input(disp, X.KeyPress, code)
        disp.sync()
        time.sleep(0.02)
    for code in reversed(codes):
        xtest.fake_input(disp, X.KeyRelease, code)
        disp.sync()
        time.sleep(0.02)
    disp.close()


if __name__ == "__main__":
    main(sys.argv)
