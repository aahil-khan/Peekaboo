//! Which window has keyboard focus: recorded when the overlay is summoned,
//! checked again before anything is pasted. Pasting into the wrong window is
//! the dangerous failure of the whole feature (a newline typed into a
//! terminal runs a command), so the rule is verify where the platform allows
//! it, and refuse rather than guess when the focus has moved.
//!
//! What each platform can tell:
//! - X11 (and X11 apps under Xwayland): the focused window, its process and
//!   title, through `GetInputFocus`.
//! - Windows: the foreground window (`GetForegroundWindow`).
//! - macOS: the frontmost application (`NSWorkspace`).
//! - Wayland-native apps: nothing. A Wayland compositor does not tell clients
//!   who has focus. On a Wayland session the only thing Peekaboo can verify
//!   is that focus did not move to or between X11 apps.

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// Platform identity of the window: X11 window id, HWND, or macOS pid.
    pub id: u64,
    pub pid: Option<u32>,
    pub title: Option<String>,
}

/// The paste-time decision, as a pure function of the two readings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// The same window has focus now as at summon time.
    Verified,
    /// The platform cannot say, and nothing contradicts it.
    Unverifiable(String),
    /// Something changed, or nothing was ever recorded.
    Refused(String),
}

/// `at_summon` is `None` when the overlay was not opened by a summon (tray,
/// a frontend call), `Some(None)` when no window this platform can see had
/// focus at summon time. `verifiable` is false on Wayland sessions, where
/// `None` means "a Wayland-native app, probably" rather than "nothing".
pub fn guard(
    at_summon: Option<&Option<Target>>,
    now: &Option<Target>,
    own_pid: u32,
    verifiable: bool,
) -> Verdict {
    let Some(at_summon) = at_summon else {
        return Verdict::Refused(
            "Peekaboo was not opened with the hotkey, so it does not know which window to paste into".into(),
        );
    };
    match at_summon {
        Some(target) => {
            if target.pid == Some(own_pid) {
                return Verdict::Refused("Peekaboo's own window had focus when it was summoned".into());
            }
            match now {
                Some(current) if current.id == target.id => Verdict::Verified,
                Some(current) => Verdict::Refused(format!(
                    "Focus moved to another window ({}) since Peekaboo was summoned from {}",
                    describe(current),
                    describe(target)
                )),
                None => Verdict::Refused(format!(
                    "{} no longer has keyboard focus",
                    describe(target)
                )),
            }
        }
        None if !verifiable => match now {
            Some(current) => Verdict::Refused(format!(
                "Focus moved to {} since Peekaboo was summoned",
                describe(current)
            )),
            None => Verdict::Unverifiable(
                "Wayland does not let Peekaboo see which window has focus, so the paste goes to whatever the compositor focused when the overlay closed".into(),
            ),
        },
        None => Verdict::Refused("No window had keyboard focus when Peekaboo was summoned".into()),
    }
}

fn describe(target: &Target) -> String {
    match &target.title {
        Some(title) if !title.is_empty() => format!("“{title}”"),
        _ => format!("window {}", target.id),
    }
}

/// Whether this session can see keyboard focus at all.
pub fn verifiable() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("WAYLAND_DISPLAY").is_none()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// The window with keyboard focus right now, as far as this platform can see.
pub fn current() -> Option<Target> {
    #[cfg(target_os = "linux")]
    {
        super::x11::focused_target().ok().flatten()
    }
    #[cfg(target_os = "windows")]
    {
        windows::foreground()
    }
    #[cfg(target_os = "macos")]
    {
        macos::frontmost()
    }
}

/// Give focus back to `target` where the platform allows it and nothing
/// else took it: after the overlay hides, X11 without a window manager
/// reverts focus to the root window, and Windows may leave no foreground
/// window. Only ever the window recorded at summon time.
pub fn restore(target: &Target) {
    #[cfg(target_os = "linux")]
    {
        let _ = super::x11::refocus(target);
    }
    #[cfg(target_os = "windows")]
    {
        windows::refocus(target);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = target;
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::Target;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, IsWindow, SetForegroundWindow,
    };

    pub fn foreground() -> Option<Target> {
        // SAFETY: plain user32 queries on the current desktop.
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            let mut buf = [0u16; 256];
            let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            let title = (len > 0).then(|| String::from_utf16_lossy(&buf[..len as usize]));
            Some(Target { id: hwnd as usize as u64, pid: (pid != 0).then_some(pid), title })
        }
    }

    pub fn refocus(target: &Target) {
        // SAFETY: the HWND came from GetForegroundWindow; IsWindow checks it
        // still exists before it is used.
        unsafe {
            let hwnd = target.id as usize as *mut core::ffi::c_void;
            if IsWindow(hwnd) == 0 {
                return;
            }
            let current = GetForegroundWindow();
            if current.is_null() || current == hwnd {
                SetForegroundWindow(hwnd);
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::Target;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    pub fn frontmost() -> Option<Target> {
        // SAFETY: NSWorkspace.sharedWorkspace.frontmostApplication and its
        // processIdentifier / localizedName are plain AppKit accessors on
        // objects AppKit owns.
        unsafe {
            let workspace: *mut AnyObject = msg_send![objc2::class!(NSWorkspace), sharedWorkspace];
            if workspace.is_null() {
                return None;
            }
            let app: *mut AnyObject = msg_send![workspace, frontmostApplication];
            if app.is_null() {
                return None;
            }
            let pid: i32 = msg_send![app, processIdentifier];
            let name: *mut AnyObject = msg_send![app, localizedName];
            let title = if name.is_null() {
                None
            } else {
                let utf8: *const std::os::raw::c_char = msg_send![name, UTF8String];
                (!utf8.is_null()).then(|| std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned())
            };
            Some(Target { id: pid as u64, pid: Some(pid as u32), title })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(id: u64, pid: u32, title: &str) -> Target {
        Target { id, pid: Some(pid), title: Some(title.into()) }
    }

    #[test]
    fn the_same_window_is_verified() {
        let editor = target(0x4a, 1200, "notes.txt");
        assert_eq!(guard(Some(&Some(editor.clone())), &Some(editor), 99, true), Verdict::Verified);
    }

    #[test]
    fn a_changed_window_is_refused_with_both_names() {
        let editor = target(0x4a, 1200, "notes.txt");
        let terminal = target(0x4b, 1300, "bash");
        match guard(Some(&Some(editor)), &Some(terminal), 99, true) {
            Verdict::Refused(reason) => {
                assert!(reason.contains("bash") && reason.contains("notes.txt"), "{reason}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn focus_that_went_away_is_refused() {
        let editor = target(0x4a, 1200, "notes.txt");
        assert!(matches!(guard(Some(&Some(editor)), &None, 99, true), Verdict::Refused(_)));
    }

    #[test]
    fn peekaboos_own_window_is_never_a_target() {
        let own = target(0x10, 4242, "Peekaboo");
        assert!(matches!(guard(Some(&Some(own.clone())), &Some(own), 4242, true), Verdict::Refused(_)));
    }

    #[test]
    fn no_summon_record_is_refused() {
        let editor = target(0x4a, 1200, "notes.txt");
        assert!(matches!(guard(None, &Some(editor), 99, true), Verdict::Refused(_)));
    }

    #[test]
    fn nothing_focused_on_a_verifiable_session_is_refused() {
        assert!(matches!(guard(Some(&None), &None, 99, true), Verdict::Refused(_)));
    }

    #[test]
    fn wayland_without_x11_focus_is_unverifiable_not_refused() {
        assert!(matches!(guard(Some(&None), &None, 99, false), Verdict::Unverifiable(_)));
    }

    #[test]
    fn wayland_focus_moving_to_an_x11_window_is_refused() {
        let x11 = target(0x4a, 1200, "xterm");
        assert!(matches!(guard(Some(&None), &Some(x11), 99, false), Verdict::Refused(_)));
    }

    #[test]
    fn titleless_windows_are_named_by_id() {
        let t = Target { id: 77, pid: None, title: None };
        assert_eq!(describe(&t), "window 77");
        assert_eq!(describe(&Target { title: Some(String::new()), ..t }), "window 77");
    }
}

// ─── The summon-time record ─────────────────────────────────────────

static AT_SUMMON: std::sync::Mutex<Option<Option<Target>>> = std::sync::Mutex::new(None);

/// Read the focused window and remember it for the paste that may follow.
pub fn record_at_summon() -> Option<Target> {
    let target = current();
    if let Ok(mut slot) = AT_SUMMON.lock() {
        *slot = Some(target.clone());
    }
    target
}

/// What `record_at_summon` saw: `None` if there was no summon yet.
pub fn at_summon() -> Option<Option<Target>> {
    AT_SUMMON.lock().ok().and_then(|slot| slot.clone())
}

/// Forget the record once it has been used, so a later Enter without a new
/// summon is refused rather than aimed at a stale window.
pub fn clear_at_summon() {
    if let Ok(mut slot) = AT_SUMMON.lock() {
        *slot = None;
    }
}
