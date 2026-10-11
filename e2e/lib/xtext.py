#!/usr/bin/env python3
"""A stand-in for "the app the user came from" on an X display.

    xtext.py :2 "the selected words" ["what the clipboard held before"]

A plain X11 window that behaves like an app with text selected: it owns the
PRIMARY selection with the first argument (and CLIPBOARD with the second, if
given), serves both to any requester, and on Ctrl+V asks the clipboard owner
for its text and prints what it would have inserted. The test reads stdout:

    mapped
    focused / unfocused
    keypress <keycode> state <mask>
    lost PRIMARY|CLIPBOARD           another client took the selection
    pasted <json string>             Ctrl+V arrived and the clipboard was read

It focuses itself once mapped (no window manager on Xvfb would otherwise),
and holds the window until stdin closes. Everything speaks the X11 selection
protocol only, so it works the same under Xvfb and under mutter's Xwayland.
"""
import json
import sys
import threading

from Xlib import X, Xatom, display
from Xlib.protocol import event as xevent


def main(argv):
    if len(argv) < 3:
        sys.exit(__doc__)
    disp = display.Display(argv[1])
    owned = {"PRIMARY": argv[2]}
    if len(argv) > 3:
        owned["CLIPBOARD"] = argv[3]

    atoms = {name: disp.intern_atom(name) for name in ["PRIMARY", "CLIPBOARD", "TARGETS", "UTF8_STRING", "PEEKABOO_E2E_PASTE"]}
    names = {atom: name for name, atom in atoms.items()}
    screen = disp.screen()
    win = screen.root.create_window(
        100, 100, 400, 240, 1,
        screen.root_depth,
        X.InputOutput,
        X.CopyFromParent,
        background_pixel=screen.white_pixel,
        event_mask=X.StructureNotifyMask | X.FocusChangeMask | X.KeyPressMask | X.KeyReleaseMask | X.PropertyChangeMask,
    )
    win.set_wm_name("peekaboo-e2e-text-window")
    win.map()
    disp.flush()
    v_keycode = disp.keysym_to_keycode(ord("v"))

    def serve(event):
        """Answer a SelectionRequest for a selection we own."""
        selection = names.get(event.selection)
        text = owned.get(selection)
        prop = event.property if event.property != X.NONE else event.target
        granted = False
        if text is not None:
            if event.target == atoms["TARGETS"]:
                event.requestor.change_property(prop, Xatom.ATOM, 32, [atoms["TARGETS"], atoms["UTF8_STRING"], Xatom.STRING])
                granted = True
            elif event.target in (atoms["UTF8_STRING"], Xatom.STRING):
                event.requestor.change_property(prop, event.target, 8, text.encode("utf-8"))
                granted = True
        notify = xevent.SelectionNotify(
            time=event.time, requestor=event.requestor, selection=event.selection,
            target=event.target, property=prop if granted else X.NONE,
        )
        event.requestor.send_event(notify)
        disp.flush()

    def pump():
        for name in owned:
            win.set_selection_owner(atoms[name], X.CurrentTime)
        disp.flush()
        while True:
            event = disp.next_event()
            if event.type == X.MapNotify:
                win.set_input_focus(X.RevertToParent, X.CurrentTime)
                disp.flush()
                print("mapped", flush=True)
            elif event.type == X.FocusIn:
                print("focused", flush=True)
            elif event.type == X.FocusOut:
                print("unfocused", flush=True)
            elif event.type == X.KeyPress:
                print(f"keypress {event.detail} state {event.state}", flush=True)
                if event.detail == v_keycode and event.state & X.ControlMask:
                    win.convert_selection(atoms["CLIPBOARD"], atoms["UTF8_STRING"], atoms["PEEKABOO_E2E_PASTE"], event.time)
                    disp.flush()
            elif event.type == X.SelectionRequest:
                serve(event)
            elif event.type == X.SelectionClear:
                name = names.get(event.atom, str(event.atom))
                owned.pop(name, None)
                print(f"lost {name}", flush=True)
            elif event.type == X.SelectionNotify:
                if event.property == X.NONE:
                    print("pasted null", flush=True)
                    continue
                reply = win.get_full_property(event.property, X.AnyPropertyType)
                win.delete_property(event.property)
                value = reply.value if reply else b""
                if isinstance(value, bytes):
                    value = value.decode("utf-8", "replace")
                print(f"pasted {json.dumps(value)}", flush=True)

    threading.Thread(target=pump, daemon=True).start()
    sys.stdin.read()


if __name__ == "__main__":
    main(sys.argv)
