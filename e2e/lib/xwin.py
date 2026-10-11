#!/usr/bin/env python3
"""Open a plain X11 window on a display and hold it until stdin closes.

    xwin.py :2

Prints "mapped" once the window is on screen. Used to give the compositor an
X11 (Xwayland) client to focus, so the hotkey test can compare what the
app's X11 key grab sees with an X11 window focused and with a Wayland-native
window focused.
"""
import sys
import threading

from Xlib import X, display


def main(argv):
    disp = display.Display(argv[1])
    screen = disp.screen()
    win = screen.root.create_window(
        100, 100, 300, 200, 1,
        screen.root_depth,
        X.InputOutput,
        X.CopyFromParent,
        background_pixel=screen.white_pixel,
        event_mask=X.StructureNotifyMask | X.FocusChangeMask | X.KeyPressMask,
    )
    win.set_wm_name("peekaboo-e2e-x11-window")
    win.map()
    disp.flush()

    def pump():
        while True:
            event = disp.next_event()
            if event.type == X.MapNotify:
                print("mapped", flush=True)
            elif event.type == X.FocusIn:
                print("focused", flush=True)
            elif event.type == X.KeyPress:
                print(f"keypress {event.detail}", flush=True)

    threading.Thread(target=pump, daemon=True).start()
    sys.stdin.read()


if __name__ == "__main__":
    main(sys.argv)
