//! X11 plumbing shared by `focus.rs` and `paste.rs` on Linux: who has focus,
//! which modifier keys are physically down, and XTest key injection.
//!
//! This also serves X11 apps running under Xwayland on a Wayland session:
//! Xwayland delivers XTest events to its focused window, and when a
//! Wayland-native window has focus the X focus is `None`, which is exactly
//! the signal `focus.rs` needs.

use super::focus::Target;
use super::keys::{chord_sequence, Chord, KeyEvent, Modifier};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{self, AtomEnum, ConnectionExt as _, InputFocus, MapState, Window};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

const XK_SHIFT_L: u32 = 0xffe1;
const XK_SHIFT_R: u32 = 0xffe2;
const XK_CONTROL_L: u32 = 0xffe3;
const XK_CONTROL_R: u32 = 0xffe4;
const XK_META_L: u32 = 0xffe7;
const XK_META_R: u32 = 0xffe8;
const XK_ALT_L: u32 = 0xffe9;
const XK_ALT_R: u32 = 0xffea;
const XK_SUPER_L: u32 = 0xffeb;
const XK_SUPER_R: u32 = 0xffec;

fn modifier_for_keysym(keysym: u32) -> Option<Modifier> {
    match keysym {
        XK_SHIFT_L | XK_SHIFT_R => Some(Modifier::Shift),
        XK_CONTROL_L | XK_CONTROL_R => Some(Modifier::Control),
        XK_ALT_L | XK_ALT_R | XK_META_L | XK_META_R => Some(Modifier::Alt),
        XK_SUPER_L | XK_SUPER_R => Some(Modifier::Super),
        _ => None,
    }
}

fn keysym_for_modifier(modifier: Modifier) -> u32 {
    match modifier {
        Modifier::Shift => XK_SHIFT_L,
        Modifier::Control => XK_CONTROL_L,
        Modifier::Alt => XK_ALT_L,
        Modifier::Super => XK_SUPER_L,
    }
}

pub struct Display {
    conn: RustConnection,
    root: Window,
}

impl Display {
    pub fn open() -> Result<Self, String> {
        if std::env::var_os("DISPLAY").is_none() {
            return Err("there is no X11 display (DISPLAY is not set)".into());
        }
        let (conn, screen) = x11rb::connect(None).map_err(|e| format!("could not open the X11 display: {e}"))?;
        let root = conn.setup().roots[screen].root;
        Ok(Self { conn, root })
    }

    fn atom(&self, name: &str) -> Result<xproto::Atom, String> {
        Ok(self
            .conn
            .intern_atom(false, name.as_bytes())
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?
            .atom)
    }

    fn pid_of(&self, window: Window) -> Option<u32> {
        let atom = self.atom("_NET_WM_PID").ok()?;
        let reply = self.conn.get_property(false, window, atom, AtomEnum::CARDINAL, 0, 1).ok()?.reply().ok()?;
        let pid = reply.value32()?.next();
        pid
    }

    fn title_of(&self, window: Window) -> Option<String> {
        for name in ["_NET_WM_NAME", "WM_NAME"] {
            let atom = self.atom(name).ok()?;
            let reply = self.conn.get_property(false, window, atom, AtomEnum::ANY, 0, 256).ok()?.reply().ok()?;
            if reply.format == 8 && !reply.value.is_empty() {
                return Some(String::from_utf8_lossy(&reply.value).into_owned());
            }
        }
        None
    }

    fn parent_of(&self, window: Window) -> Option<Window> {
        let reply = self.conn.query_tree(window).ok()?.reply().ok()?;
        (reply.parent != x11rb::NONE && reply.parent != reply.root).then_some(reply.parent)
    }

    /// The focused window, or `None` for `None`, `PointerRoot` and the root
    /// window itself (what X reverts to when the focused window goes away
    /// and no window manager steps in).
    pub fn focused(&self) -> Result<Option<Target>, String> {
        let focus = self.conn.get_input_focus().map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?.focus;
        if focus == x11rb::NONE || focus == u32::from(InputFocus::POINTER_ROOT) || focus == self.root {
            return Ok(None);
        }
        // Focus may sit on a child window; the client window (the one with
        // _NET_WM_PID, below the window manager's frame) is the stable
        // identity to compare later.
        let mut window = focus;
        let mut client = focus;
        for _ in 0..16 {
            if self.pid_of(window).is_some() {
                client = window;
                break;
            }
            match self.parent_of(window) {
                Some(parent) => window = parent,
                None => break,
            }
        }
        Ok(Some(Target { id: u64::from(client), pid: self.pid_of(client), title: self.title_of(client) }))
    }

    /// Put focus back on `target` when nothing has it (focus reverted to
    /// the root after the overlay unmapped). Never steals it from another window.
    pub fn refocus(&self, target: &Target) -> Result<(), String> {
        if self.focused()?.is_some() {
            return Ok(());
        }
        let window = target.id as Window;
        let attrs = self.conn.get_window_attributes(window).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?;
        if attrs.map_state != MapState::VIEWABLE {
            return Err("the window is no longer viewable".into());
        }
        self.conn
            .set_input_focus(InputFocus::PARENT, window, x11rb::CURRENT_TIME)
            .map_err(|e| e.to_string())?;
        self.conn.flush().map_err(|e| e.to_string())
    }

    fn keymap(&self) -> Result<(u8, u8, Vec<u32>), String> {
        let setup = self.conn.setup();
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let reply = self
            .conn
            .get_keyboard_mapping(min, max - min + 1)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        Ok((min, reply.keysyms_per_keycode, reply.keysyms))
    }

    fn keycode_for(&self, keysym: u32, (min, per, keysyms): &(u8, u8, Vec<u32>)) -> Option<u8> {
        let per = usize::from(*per);
        keysyms
            .chunks(per)
            .position(|syms| syms.first() == Some(&keysym))
            .map(|i| min + i as u8)
    }

    /// Modifier keys physically down right now, by keycode.
    fn held_modifiers(&self, map: &(u8, u8, Vec<u32>)) -> Result<Vec<(u8, Modifier)>, String> {
        let keys = self.conn.query_keymap().map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?.keys;
        let (min, per, keysyms) = map;
        let mut held = Vec::new();
        for keycode in *min..=255u8 {
            let down = keys[usize::from(keycode / 8)] & (1 << (keycode % 8)) != 0;
            if !down {
                continue;
            }
            let index = usize::from(keycode - min) * usize::from(*per);
            if let Some(modifier) = keysyms.get(index).and_then(|&k| modifier_for_keysym(k)) {
                held.push((keycode, modifier));
            }
        }
        Ok(held)
    }

    /// Press `chord` with XTest, releasing whatever modifiers the user still
    /// holds first.
    pub fn press_chord(&self, chord: Chord) -> Result<(), String> {
        let map = self.keymap()?;
        let modifier_key = self
            .keycode_for(keysym_for_modifier(chord.modifier), &map)
            .ok_or_else(|| format!("no key produces {:?} in this keyboard layout", chord.modifier))?;
        let letter_key = self
            .keycode_for(u32::from(chord.letter), &map)
            .ok_or_else(|| format!("no key produces '{}' in this keyboard layout", chord.letter))?;
        let held = self.held_modifiers(&map)?;
        for event in chord_sequence(&held, chord, modifier_key, letter_key) {
            let (kind, keycode) = match event {
                KeyEvent::Press(k) => (xproto::KEY_PRESS_EVENT, k),
                KeyEvent::Release(k) => (xproto::KEY_RELEASE_EVENT, k),
            };
            self.conn
                .xtest_fake_input(kind, keycode, x11rb::CURRENT_TIME, x11rb::NONE, 0, 0, 0)
                .map_err(|e| format!("XTest is not available: {e}"))?;
            self.conn.flush().map_err(|e| e.to_string())?;
            // Apps drop key events that arrive faster than a keyboard could send them.
            std::thread::sleep(std::time::Duration::from_millis(12));
        }
        Ok(())
    }
}

pub fn focused_target() -> Result<Option<Target>, String> {
    Display::open()?.focused()
}

pub fn refocus(target: &Target) -> Result<(), String> {
    Display::open()?.refocus(target)
}
