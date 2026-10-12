//! Which way the summon hotkey gets registered, decided from what the
//! session offers rather than from a setting.
//!
//! The OS grab (`tauri-plugin-global-shortcut`, X11-only on Linux) is always
//! attempted first: it is the only path off Linux, and on a Wayland session it
//! is the fallback while the portal is being asked, or if the portal says no.
//! The GlobalShortcuts portal is tried on top of it only where it can exist.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Environment {
    pub os: String,
    /// `WAYLAND_DISPLAY` is set: the session is Wayland (GTK will run native).
    pub wayland: bool,
    /// `DISPLAY` is set: an X server (or Xwayland) is reachable for the grab.
    pub x11: bool,
    /// `PEEKABOO_HOTKEY_BACKEND`, a knob for the end-to-end harness, which
    /// runs on Xvfb in CI and still needs to exercise the portal path against
    /// its stand-in portal. Not documented for users.
    pub forced: Option<String>,
}

impl Environment {
    pub fn detect() -> Self {
        Self {
            os: std::env::consts::OS.to_string(),
            wayland: std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty()),
            x11: std::env::var_os("DISPLAY").is_some_and(|v| !v.is_empty()),
            forced: std::env::var("PEEKABOO_HOTKEY_BACKEND").ok().filter(|v| !v.is_empty()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// Ask the GlobalShortcuts portal (in the background) after the OS grab.
    pub portal: bool,
    /// Why, in one line for the log.
    pub reason: String,
}

pub fn choose(env: &Environment) -> Plan {
    match env.forced.as_deref() {
        Some("portal") => {
            return Plan { portal: true, reason: "portal forced by PEEKABOO_HOTKEY_BACKEND".into() };
        }
        Some("native") => {
            return Plan { portal: false, reason: "OS grab forced by PEEKABOO_HOTKEY_BACKEND".into() };
        }
        Some(other) => eprintln!("hotkey: ignoring PEEKABOO_HOTKEY_BACKEND={other:?} (portal or native)"),
        None => {}
    }
    if env.os != "linux" {
        return Plan { portal: false, reason: format!("{} has its own global hotkeys", env.os) };
    }
    if env.wayland {
        let grab = if env.x11 {
            "the X11 grab fires only while an X11 app has focus"
        } else {
            "there is no X server for the grab at all"
        };
        return Plan { portal: true, reason: format!("Wayland session: asking the GlobalShortcuts portal; {grab}") };
    }
    if env.x11 {
        return Plan { portal: false, reason: "X11 session: the X11 grab works from every app".into() };
    }
    Plan { portal: false, reason: "no display server found; the hotkey cannot be registered".into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(os: &str, wayland: bool, x11: bool) -> Environment {
        Environment { os: os.into(), wayland, x11, forced: None }
    }

    #[test]
    fn wayland_asks_the_portal_with_or_without_xwayland() {
        assert!(choose(&env("linux", true, true)).portal);
        assert!(choose(&env("linux", true, false)).portal);
        assert!(choose(&env("linux", true, false)).reason.contains("no X server"));
    }

    #[test]
    fn x11_sessions_keep_the_grab_alone() {
        let plan = choose(&env("linux", false, true));
        assert!(!plan.portal);
        assert!(plan.reason.contains("X11 session"));
    }

    #[test]
    fn no_display_at_all_is_said_so() {
        let plan = choose(&env("linux", false, false));
        assert!(!plan.portal);
        assert!(plan.reason.contains("no display server"));
    }

    #[test]
    fn other_operating_systems_never_touch_the_portal() {
        for os in ["windows", "macos"] {
            assert!(!choose(&env(os, true, true)).portal, "{os}");
            assert!(!choose(&env(os, false, false)).portal, "{os}");
        }
    }

    #[test]
    fn the_harness_knob_overrides_detection_on_linux_only_values() {
        let forced = |v: &str, os: &str| Environment { os: os.into(), wayland: false, x11: true, forced: Some(v.into()) };
        assert!(choose(&forced("portal", "linux")).portal);
        assert!(!choose(&forced("native", "linux")).portal);
        assert!(!choose(&Environment { forced: Some("native".into()), ..env("linux", true, true) }).portal);
        // Anything else is ignored and detection decides.
        assert!(!choose(&forced("x11", "linux")).portal);
        assert!(choose(&Environment { forced: Some("bogus".into()), ..env("linux", true, false) }).portal);
    }
}
