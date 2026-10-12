#!/usr/bin/env python3
"""A stand-in for xdg-desktop-portal's GlobalShortcuts interface.

    mock-portal.py MODE [--trigger=TEXT] [--remembered=TEXT]

Owns org.freedesktop.portal.Desktop on the session bus named by
DBUS_SESSION_BUS_ADDRESS (the harness's private bus, never the user's) and
answers what Peekaboo's hotkey code calls: the host-app Registry, then
CreateSession, ListShortcuts, BindShortcuts and ConfigureShortcuts, with the
Request/Response and Session objects the portal protocol wraps them in.

The real backends (xdg-desktop-portal-gnome, -kde) need the whole desktop
behind them, which the headless display does not run, so this is how the
portal path gets exercised at all. It plays one of these parts:

    grant      BindShortcuts binds the summon key; trigger_description is
               --trigger, or the preferred trigger the app proposed.
    decline    BindShortcuts answers "cancelled" (the user said no).
    empty      BindShortcuts succeeds with no shortcuts (the user unticked it).
    hang       BindShortcuts never answers (dialog left open).
    refuse     CreateSession fails with NotAllowed, as xdg-desktop-portal 1.21
               does for an app with no app id.

--remembered=TEXT makes ListShortcuts return the summon shortcut with that
trigger_description before any bind, as a desktop that remembers it would.

Every call is reported on stdout as one JSON line ({"event": ...}). Lines on
stdin drive the desktop side:

    activate               emit Activated for the summon shortcut
    change TEXT            emit ShortcutsChanged with TEXT as the new binding
    unbind                 emit ShortcutsChanged with no shortcuts
    close                  emit Closed on the session
"""
import json
import os
import sys
import time

from gi.repository import Gio, GLib

BUS_NAME = "org.freedesktop.portal.Desktop"
DESKTOP_PATH = "/org/freedesktop/portal/desktop"
GS_IFACE = "org.freedesktop.portal.GlobalShortcuts"
REQUEST_IFACE = "org.freedesktop.portal.Request"
SESSION_IFACE = "org.freedesktop.portal.Session"
REGISTRY_IFACE = "org.freedesktop.host.portal.Registry"

DESKTOP_XML = f"""
<node>
  <interface name="{REGISTRY_IFACE}">
    <method name="Register">
      <arg type="s" name="app_id" direction="in"/>
      <arg type="a{{sv}}" name="options" direction="in"/>
    </method>
    <property name="version" type="u" access="read"/>
  </interface>
  <interface name="{GS_IFACE}">
    <method name="CreateSession">
      <arg type="a{{sv}}" name="options" direction="in"/>
      <arg type="o" name="handle" direction="out"/>
    </method>
    <method name="BindShortcuts">
      <arg type="o" name="session_handle" direction="in"/>
      <arg type="a(sa{{sv}})" name="shortcuts" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/>
      <arg type="a{{sv}}" name="options" direction="in"/>
      <arg type="o" name="request_handle" direction="out"/>
    </method>
    <method name="ListShortcuts">
      <arg type="o" name="session_handle" direction="in"/>
      <arg type="a{{sv}}" name="options" direction="in"/>
      <arg type="o" name="request_handle" direction="out"/>
    </method>
    <method name="ConfigureShortcuts">
      <arg type="o" name="session_handle" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/>
      <arg type="a{{sv}}" name="options" direction="in"/>
    </method>
    <signal name="Activated">
      <arg type="o" name="session_handle"/>
      <arg type="s" name="shortcut_id"/>
      <arg type="t" name="timestamp"/>
      <arg type="a{{sv}}" name="options"/>
    </signal>
    <signal name="Deactivated">
      <arg type="o" name="session_handle"/>
      <arg type="s" name="shortcut_id"/>
      <arg type="t" name="timestamp"/>
      <arg type="a{{sv}}" name="options"/>
    </signal>
    <signal name="ShortcutsChanged">
      <arg type="o" name="session_handle"/>
      <arg type="a(sa{{sv}})" name="shortcuts"/>
    </signal>
    <property name="version" type="u" access="read"/>
  </interface>
</node>
"""

SESSION_XML = f"""
<node>
  <interface name="{SESSION_IFACE}">
    <method name="Close"/>
    <signal name="Closed"><arg type="a{{sv}}" name="details"/></signal>
    <property name="version" type="u" access="read"/>
  </interface>
</node>
"""

REQUEST_XML = f"""
<node>
  <interface name="{REQUEST_IFACE}">
    <method name="Close"/>
    <signal name="Response">
      <arg type="u" name="response"/>
      <arg type="a{{sv}}" name="results"/>
    </signal>
  </interface>
</node>
"""

SUMMON = "summon"


def report(event, **fields):
    sys.stdout.write(json.dumps({"event": event, **fields}) + "\n")
    sys.stdout.flush()


def sanitize(sender):
    return sender.lstrip(":").replace(".", "_")


def shortcut_list(entries):
    """[(id, description, trigger)] as the a(sa{sv}) the portal returns."""
    return GLib.Variant(
        "a(sa{sv})",
        [(sid, {"description": GLib.Variant("s", desc), "trigger_description": GLib.Variant("s", trig)}) for sid, desc, trig in entries],
    )


class MockPortal:
    def __init__(self, conn, mode, trigger, remembered):
        self.conn = conn
        self.mode = mode
        self.trigger = trigger
        self.remembered = remembered
        self.sessions = {}  # path -> {"sender": str, "shortcuts": [(id, desc, trig)]}
        self.current = None
        self.registrations = []
        node = Gio.DBusNodeInfo.new_for_xml(DESKTOP_XML)
        for iface in node.interfaces:
            conn.register_object(DESKTOP_PATH, iface, self.on_call, self.on_get, None)

    # -- object paths ------------------------------------------------------

    def request_path(self, sender, options):
        token = options.get("handle_token", f"t{int(time.time() * 1000)}")
        return f"{DESKTOP_PATH}/request/{sanitize(sender)}/{token}"

    def session_path(self, sender, options):
        token = options.get("session_handle_token", f"s{int(time.time() * 1000)}")
        return f"{DESKTOP_PATH}/session/{sanitize(sender)}/{token}"

    def respond(self, sender, path, code, results, delay_ms=20):
        """Emit Request.Response to the caller a moment after the method returned."""
        def emit():
            self.conn.emit_signal(sender, path, REQUEST_IFACE, "Response", GLib.Variant("(ua{sv})", (code, results)))
            return False
        GLib.timeout_add(delay_ms, emit)

    # -- properties --------------------------------------------------------

    def on_get(self, conn, sender, path, iface, prop):
        if prop == "version":
            return GLib.Variant("u", 2 if iface == GS_IFACE else 1)
        return None

    # -- methods -----------------------------------------------------------

    def on_call(self, conn, sender, path, iface, method, params, invocation):
        handler = getattr(self, f"do_{method}", None)
        if handler is None:
            invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)
            return
        handler(sender, params.unpack(), invocation)

    def do_Register(self, sender, params, invocation):
        app_id, _options = params
        self.registrations.append(app_id)
        report("register", app_id=app_id)
        invocation.return_value(None)

    def do_CreateSession(self, sender, params, invocation):
        (options,) = params
        report("create_session")
        if self.mode == "refuse":
            invocation.return_dbus_error("org.freedesktop.portal.Error.NotAllowed", "An app id is required")
            return
        request = self.request_path(sender, options)
        session = self.session_path(sender, options)
        node = Gio.DBusNodeInfo.new_for_xml(SESSION_XML)
        self.conn.register_object(session, node.interfaces[0], self.on_session_call, self.on_get, None)
        remembered = [(SUMMON, "Summon Peekaboo", self.remembered)] if self.remembered else []
        self.sessions[session] = {"sender": sender, "shortcuts": remembered, "bound": False}
        self.current = session
        invocation.return_value(GLib.Variant("(o)", (request,)))
        self.respond(sender, request, 0, {"session_handle": GLib.Variant("s", session)})

    def on_session_call(self, conn, sender, path, iface, method, params, invocation):
        report("session_" + method.lower(), session=path)
        invocation.return_value(None)

    def do_ListShortcuts(self, sender, params, invocation):
        session, options = params
        request = self.request_path(sender, options)
        entries = self.sessions.get(session, {}).get("shortcuts", [])
        report("list", shortcuts=[list(e) for e in entries])
        invocation.return_value(GLib.Variant("(o)", (request,)))
        self.respond(sender, request, 0, {"shortcuts": shortcut_list(entries)})

    def do_BindShortcuts(self, sender, params, invocation):
        session, shortcuts, parent_window, options = params
        request = self.request_path(sender, options)
        asked = [(sid, info.get("description", ""), info.get("preferred_trigger")) for sid, info in shortcuts]
        report("bind", shortcuts=[list(a) for a in asked], parent_window=parent_window)
        state = self.sessions.setdefault(session, {"sender": sender, "shortcuts": [], "bound": False})
        if state["bound"]:
            invocation.return_dbus_error("org.freedesktop.portal.Error.Failed", "Shortcuts already bound for this session")
            return
        state["bound"] = True
        invocation.return_value(GLib.Variant("(o)", (request,)))
        if self.mode == "hang":
            return
        if self.mode == "decline":
            self.respond(sender, request, 1, {})
            return
        if self.mode == "empty":
            state["shortcuts"] = []
            self.respond(sender, request, 0, {"shortcuts": shortcut_list([])})
            return
        bound = [(sid, desc, self.trigger or preferred or "Unassigned") for sid, desc, preferred in asked]
        state["shortcuts"] = bound
        self.respond(sender, request, 0, {"shortcuts": shortcut_list(bound)})

    def do_ConfigureShortcuts(self, sender, params, invocation):
        session, parent_window, options = params
        report("configure", session=session, parent_window=parent_window)
        invocation.return_value(None)

    # -- the desktop side, driven from stdin -------------------------------

    def emit_desktop(self, name, variant):
        self.conn.emit_signal(None, DESKTOP_PATH, GS_IFACE, name, variant)

    def command(self, line):
        words = line.strip().split(" ", 1)
        if not words or not words[0]:
            return
        verb, arg = words[0], (words[1] if len(words) > 1 else "")
        session = self.current
        if session is None:
            report("error", message="no session yet")
            return
        if verb == "activate":
            stamp = int(time.monotonic() * 1000)
            self.emit_desktop("Activated", GLib.Variant("(osta{sv})", (session, SUMMON, stamp, {})))
            self.emit_desktop("Deactivated", GLib.Variant("(osta{sv})", (session, SUMMON, stamp + 40, {})))
            report("activated", session=session)
        elif verb == "change":
            entries = [(SUMMON, "Summon Peekaboo", arg)]
            self.sessions[session]["shortcuts"] = entries
            self.emit_desktop("ShortcutsChanged", GLib.Variant.new_tuple(GLib.Variant("o", session), shortcut_list(entries)))
            report("changed", session=session, trigger=arg)
        elif verb == "unbind":
            self.sessions[session]["shortcuts"] = []
            self.emit_desktop("ShortcutsChanged", GLib.Variant.new_tuple(GLib.Variant("o", session), shortcut_list([])))
            report("changed", session=session, trigger=None)
        elif verb == "close":
            self.conn.emit_signal(None, session, SESSION_IFACE, "Closed", GLib.Variant("(a{sv})", ({},)))
            report("closed", session=session)
        else:
            report("error", message=f"unknown command {verb!r}")


def main(argv):
    if len(argv) < 2 or argv[1] not in ("grant", "decline", "empty", "hang", "refuse"):
        sys.exit(__doc__)
    mode = argv[1]
    trigger = None
    remembered = None
    for arg in argv[2:]:
        if arg.startswith("--trigger="):
            trigger = arg[len("--trigger="):]
        elif arg.startswith("--remembered="):
            remembered = arg[len("--remembered="):]
        else:
            sys.exit(f"mock-portal.py: unknown argument {arg!r}")

    conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    portal = MockPortal(conn, mode, trigger, remembered)
    loop = GLib.MainLoop()

    def acquired(connection, name):
        report("ready", name=name, mode=mode)

    def lost(connection, name):
        report("error", message=f"lost or could not own {name}; is another portal on this bus?")
        loop.quit()

    Gio.bus_own_name_on_connection(conn, BUS_NAME, Gio.BusNameOwnerFlags.NONE, acquired, lost)

    # Read the descriptor, not a buffered file: several commands written at
    # once arrive in one chunk, and a buffered readline would leave the rest
    # waiting for input that never comes.
    pending = b""

    def on_stdin(fd, condition):
        nonlocal pending
        chunk = os.read(fd, 65536)
        if not chunk:
            loop.quit()
            return False
        pending += chunk
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            portal.command(line.decode())
        return True

    GLib.io_add_watch(sys.stdin.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP, on_stdin)
    loop.run()


if __name__ == "__main__":
    main(sys.argv)
