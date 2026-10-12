//! Summon hotkey: registration at startup, the `get_hotkey`/`set_hotkey`/
//! `configure_hotkey` commands, and the small JSON file the chord is
//! persisted in.
//!
//! The shortcut is registered here in Rust at startup, without waiting for the
//! frontend, so it cannot live in the webview's localStorage: Rust has no way
//! to read that. It gets a small JSON file in the app config directory instead.
//!
//! Two backends, chosen by `backend::choose` from what the session offers:
//!
//! - the OS grab (`native.rs`), always registered first. The only path on
//!   Windows, macOS and X11 sessions, and the fallback on Wayland while the
//!   portal is being asked or when it says no;
//! - the XDG GlobalShortcuts portal (`portal.rs`, Linux), asked in the
//!   background on Wayland sessions. The app only *proposes* the chord: the
//!   desktop and the user own the real binding, so once the portal grants, the
//!   grab is released, Settings shows what the desktop bound, and changing it
//!   goes through the desktop (`configure_hotkey`), not the recorder.
//!
//! `status.rs` is the pure state machine behind all of that and the report
//! the frontend reads; `trigger.rs` maps chords to and from portal triggers.

mod backend;
mod native;
#[cfg(target_os = "linux")]
mod portal;
// Off Linux the portal never reports, so its events and triggers are only
// built, never constructed.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod status;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod trigger;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{Modifiers, Shortcut};

pub use status::HotkeyInfo;
use status::{Native, PortalEvent, PortalPhase, Snapshot};

pub const CONFIG_FILE: &str = "hotkey.json";
/// The id the summon shortcut is bound under with the portal. Part of what
/// the desktop remembers across launches, so it must not change.
pub const SHORTCUT_ID: &str = "summon";

pub struct HotkeyState {
    inner: Mutex<Inner>,
    /// The open portal session, kept for `configure_hotkey` and so the
    /// binding stays alive. Linux only.
    #[cfg(target_os = "linux")]
    link: Mutex<Option<std::sync::Arc<portal::Link>>>,
}

struct Inner {
    configured: String,
    native: Native,
    portal: PortalPhase,
    portal_version: u32,
    grab_is_global: bool,
}

impl Inner {
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            configured: self.configured.clone(),
            default: default_hotkey().to_string(),
            native: self.native.clone(),
            portal: self.portal.clone(),
            portal_version: self.portal_version,
            grab_is_global: self.grab_is_global,
        }
    }
}

/// Ctrl+Space is completion in every editor and the input-source switch
/// on macOS; Alt+Space is the window menu on Windows and GNOME. Three-key
/// chords avoid all of that on Linux and Windows, and Option+Space is free
/// on a Mac.
pub fn default_for(os: &str) -> &'static str {
    match os {
        "macos" => "Alt+Space",
        _ => "Ctrl+Alt+Space",
    }
}

pub fn default_hotkey() -> &'static str {
    default_for(std::env::consts::OS)
}

/// One spelling per chord: fixed modifier order, then the key's W3C code
/// name. The parser accepts many spellings ("control", "CTRL", "Option"),
/// so this is what gets stored, compared and shown.
pub fn canonical(shortcut: &Shortcut) -> String {
    let key = shortcut.key.to_string();
    let mut parts: Vec<&str> = Vec::new();
    if shortcut.mods.contains(Modifiers::CONTROL) {
        parts.push("Ctrl");
    }
    if shortcut.mods.contains(Modifiers::ALT) {
        parts.push("Alt");
    }
    if shortcut.mods.contains(Modifiers::SHIFT) {
        parts.push("Shift");
    }
    if shortcut.mods.contains(Modifiers::SUPER) {
        parts.push("Super");
    }
    parts.push(&key);
    parts.join("+")
}

/// A bare key as a global grab would swallow it from every other app, so a
/// modifier is mandatory even though the underlying crate allows none.
pub fn parse(raw: &str) -> Result<Shortcut, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("No key combination given.".into());
    }
    let shortcut: Shortcut = raw
        .parse()
        .map_err(|_| format!("“{raw}” is not a key combination Peekaboo can bind."))?;
    if shortcut.mods.is_empty() {
        return Err("Add at least one modifier (Ctrl, Alt, Shift or Super).".into());
    }
    Ok(shortcut)
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Stored {
    hotkey: String,
}

/// The saved chord, if the file exists, is JSON and holds a valid chord.
/// Anything else reads as "nothing saved": a corrupt file must never cost
/// the app its hotkey.
pub fn read_saved(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let stored: Stored = serde_json::from_str(&text).ok()?;
    parse(&stored.hotkey).ok().map(|s| canonical(&s))
}

pub fn load(path: &Path) -> String {
    read_saved(path).unwrap_or_else(|| default_hotkey().to_string())
}

/// Saving the default removes the file rather than writing it, so a reset
/// install keeps following the default if a later version changes it.
pub fn save(path: &Path, hotkey: &str) -> Result<(), String> {
    if hotkey == default_hotkey() {
        return match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&Stored { hotkey: hotkey.to_string() })
        .map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

// Not $HOME: it is unset on Windows, and this is the directory Tauri
// already derives per platform.
pub fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(CONFIG_FILE))
        .map_err(|e| e.to_string())
}

fn register(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    native::register(app, parse(hotkey)?)
}

/// Grab the saved chord, falling back to the default if the OS refuses it
/// (another app took it since, or it came from a different platform).
fn grab_at_startup(app: &AppHandle, wanted: &str) -> Native {
    let fallback = default_hotkey().to_string();
    match register(app, wanted) {
        Ok(()) => Native { active: Some(wanted.to_string()), error: None },
        Err(reason) if wanted != fallback && register(app, &fallback).is_ok() => {
            eprintln!("hotkey: {wanted} could not be registered ({reason}); using {fallback}");
            Native {
                active: Some(fallback.clone()),
                error: Some(format!(
                    "Your saved hotkey {wanted} could not be registered ({reason}), so the default {fallback} is active."
                )),
            }
        }
        Err(reason) => {
            eprintln!("hotkey: {wanted} could not be registered: {reason}");
            Native {
                active: None,
                error: Some(format!(
                    "{wanted} could not be registered ({reason}). Pick another combination; until then, use the tray or launch Peekaboo again to show it."
                )),
            }
        }
    }
}

/// Register the saved chord with the OS, manage the state, and, where the
/// session calls for it, ask the GlobalShortcuts portal in the background.
/// Runs in setup, before the frontend has loaded, so summoning never waits
/// for it; nothing here blocks on the portal.
pub fn register_at_startup(app: &AppHandle) {
    let wanted = config_path(app)
        .map(|path| load(&path))
        .unwrap_or_else(|_| default_hotkey().to_string());

    let env = backend::Environment::detect();
    let plan = backend::choose(&env);
    eprintln!("hotkey: {}", plan.reason);

    let native = grab_at_startup(app, &wanted);
    if let Some(chord) = &native.active {
        eprintln!("hotkey: {chord} registered through the OS grab");
    }

    app.manage(HotkeyState {
        inner: Mutex::new(Inner {
            configured: wanted.clone(),
            native,
            portal: PortalPhase::NotApplicable(plan.reason.clone()),
            portal_version: 0,
            grab_is_global: !env.wayland,
        }),
        #[cfg(target_os = "linux")]
        link: Mutex::new(None),
    });

    if plan.portal {
        #[cfg(target_os = "linux")]
        portal::start(app.clone(), wanted);
    }
}

fn info(state: &HotkeyState) -> HotkeyInfo {
    let snapshot = state
        .inner
        .lock()
        .map(|inner| inner.snapshot())
        .unwrap_or_else(|poisoned| poisoned.into_inner().snapshot());
    status::describe(&snapshot)
}

/// Feed one portal event through the state machine and act on the
/// transition: the grab is released when the portal takes over and put back
/// when the portal lets go, and every window is told the key changed.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn apply_portal_event(app: &AppHandle, event: PortalEvent) {
    let state = app.state::<HotkeyState>();
    let Ok(mut inner) = state.inner.lock() else { return };
    let before = inner.portal.clone();
    let after = before.clone().apply(event, SHORTCUT_ID);
    if after == before {
        return;
    }
    match (&before, &after) {
        (_, PortalPhase::Granted { trigger_description }) => {
            if !before.is_granted() {
                if let Some(chord) = inner.native.active.take() {
                    if let Ok(shortcut) = parse(&chord) {
                        native::unregister(app, shortcut);
                    }
                    eprintln!("hotkey: using the GlobalShortcuts portal (desktop binding: {trigger_description}); the X11 grab of {chord} was released");
                } else {
                    eprintln!("hotkey: using the GlobalShortcuts portal (desktop binding: {trigger_description})");
                }
                inner.native.error = None;
            } else {
                eprintln!("hotkey: the desktop changed the binding to {trigger_description}");
            }
        }
        (PortalPhase::Granted { .. }, lost) => {
            let reason = match lost {
                PortalPhase::Lost(r) | PortalPhase::Declined(r) | PortalPhase::Unavailable(r) => r.as_str(),
                _ => "",
            };
            let configured = inner.configured.clone();
            inner.native = grab_at_startup(app, &configured);
            match &inner.native.active {
                Some(chord) => eprintln!("hotkey: the portal binding is gone ({reason}); falling back to the X11 grab of {chord}"),
                None => eprintln!("hotkey: the portal binding is gone ({reason}) and the X11 grab is not available either"),
            }
        }
        (_, PortalPhase::Requested { remembered }) => {
            eprintln!("hotkey: asked the portal to bind {} ({})", inner.configured, if *remembered { "the desktop remembers it; no dialog expected" } else { "first time; the desktop may show a dialog" });
        }
        (_, PortalPhase::Declined(reason)) => match &inner.native.active {
            Some(chord) => eprintln!("hotkey: the portal did not bind a key ({reason}); falling back to the X11 grab of {chord}"),
            None => eprintln!("hotkey: the portal did not bind a key ({reason}) and the X11 grab is not available: no summon key"),
        },
        (_, PortalPhase::Unavailable(reason)) => match &inner.native.active {
            Some(chord) => eprintln!("hotkey: the portal could not be used ({reason}); falling back to the X11 grab of {chord}"),
            None => eprintln!("hotkey: the portal could not be used ({reason}) and the X11 grab is not available: no summon key"),
        },
        _ => {}
    }
    inner.portal = after;
    drop(inner);
    let _ = app.emit("hotkey-changed", info(&state).hotkey);
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn set_portal_version(app: &AppHandle, version: u32) {
    let state = app.state::<HotkeyState>();
    let Ok(mut inner) = state.inner.lock() else { return };
    inner.portal_version = version;
}

#[tauri::command]
pub fn get_hotkey(state: State<'_, HotkeyState>) -> HotkeyInfo {
    info(&state)
}

#[tauri::command]
pub fn set_hotkey(
    app: AppHandle,
    state: State<'_, HotkeyState>,
    hotkey: String,
) -> Result<HotkeyInfo, String> {
    let shortcut = parse(&hotkey)?;
    let new = canonical(&shortcut);
    let (old, managed) = {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        (inner.native.active.clone(), inner.portal.is_granted())
    };
    if managed {
        return Err("On this desktop the summon key is managed by the system. Change it with “Change…” or in your desktop's keyboard settings.".into());
    }

    if old.as_deref() != Some(new.as_str()) {
        // New first, old second: if the OS refuses the new chord the old
        // one was never touched, so there is no moment without a hotkey.
        native::register(&app, shortcut).map_err(|e| match &old {
            Some(old) => format!("Could not use {new}: {e}. {old} still works."),
            None => format!("Could not use {new}: {e}."),
        })?;
        if let Some(previous) = old.as_deref().and_then(|o| parse(o).ok()) {
            native::unregister(&app, previous);
        }
        if let Ok(mut inner) = state.inner.lock() {
            inner.native.active = Some(new.clone());
        }
        let _ = app.emit("hotkey-changed", &new);
    }

    let path = config_path(&app)?;
    save(&path, &new)
        .map_err(|e| format!("{new} is active, but could not be saved for next launch: {e}"))?;
    // Whatever went wrong at startup, the user has now chosen a chord that
    // registered and persisted, so the message has served its purpose.
    if let Ok(mut inner) = state.inner.lock() {
        inner.configured = new;
        inner.native.error = None;
    }
    Ok(info(&state))
}

/// Ask the desktop to show its own configuration UI for Peekaboo's shortcut
/// (`ConfigureShortcuts`, portal version 2). The new binding arrives through
/// `ShortcutsChanged`, so the answer here is only the current state.
#[tauri::command]
pub async fn configure_hotkey(app: AppHandle) -> Result<HotkeyInfo, String> {
    #[cfg(target_os = "linux")]
    {
        let state = app.state::<HotkeyState>();
        let link = state.link.lock().map_err(|e| e.to_string())?.clone();
        let (granted, version) = state
            .inner
            .lock()
            .map(|inner| (inner.portal.is_granted(), inner.portal_version))
            .map_err(|e| e.to_string())?;
        let Some(link) = link.filter(|_| granted) else {
            return Err("The summon key is not managed by the desktop right now.".into());
        };
        if version < 2 {
            return Err("This desktop's portal offers no shortcut editor; change the key in your desktop's keyboard settings.".into());
        }
        link.configure().await?;
        Ok(info(&state))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Err("The summon key is not managed by the desktop on this platform.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_global_shortcut::Code;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("peekaboo-hotkey-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(CONFIG_FILE)
    }

    #[test]
    fn parses_a_stored_string_into_a_shortcut() {
        let s = parse("Ctrl+Alt+Space").unwrap();
        assert_eq!(s.mods, Modifiers::CONTROL | Modifiers::ALT);
        assert_eq!(s.key, Code::Space);
        assert_eq!(canonical(&s), "Ctrl+Alt+Space");
    }

    #[test]
    fn canonical_form_absorbs_spelling_and_order() {
        for spelling in ["control+alt+space", " ALT + CTRL + SPACE ", "Alt+Control+Space"] {
            assert_eq!(canonical(&parse(spelling).unwrap()), "Ctrl+Alt+Space", "{spelling}");
        }
        assert_eq!(canonical(&parse("Option+Space").unwrap()), "Alt+Space");
        assert_eq!(canonical(&parse("Super+Shift+KeyK").unwrap()), "Shift+Super+KeyK");
        assert_eq!(canonical(&parse("Ctrl+Shift+1").unwrap()), "Ctrl+Shift+Digit1");
    }

    #[test]
    fn rejects_modifier_less_combinations() {
        for bare in ["Space", "KeyA", "F12"] {
            let err = parse(bare).unwrap_err();
            assert!(err.contains("modifier"), "{bare}: {err}");
        }
    }

    #[test]
    fn rejects_invalid_combinations() {
        for bad in ["", "   ", "Ctrl+", "Ctrl+Alt", "Ctrl+Nope", "Ctrl+A+B", "+Space", "Ctrl+ControlLeft"] {
            assert!(parse(bad).is_err(), "{bad:?} should not parse");
        }
    }

    #[test]
    fn per_os_defaults() {
        assert_eq!(default_for("macos"), "Alt+Space");
        assert_eq!(default_for("linux"), "Ctrl+Alt+Space");
        assert_eq!(default_for("windows"), "Ctrl+Alt+Space");
        assert_eq!(default_hotkey(), default_for(std::env::consts::OS));
        for os in ["macos", "linux", "windows"] {
            let s = parse(default_for(os)).unwrap();
            assert!(!s.mods.is_empty(), "{os} default needs a modifier");
            assert_eq!(canonical(&s), default_for(os), "{os} default must already be canonical");
            assert!(trigger::preferred_trigger(default_for(os)).is_some(), "{os} default must have a portal trigger");
        }
    }

    #[test]
    fn missing_config_falls_back_to_the_default() {
        let path = scratch("missing");
        assert!(read_saved(&path).is_none());
        assert_eq!(load(&path), default_hotkey());
    }

    #[test]
    fn corrupt_config_falls_back_to_the_default() {
        let path = scratch("corrupt");
        for body in ["", "not json", "{}", r#"{"hotkey": 5}"#, r#"{"hotkey": ""}"#, r#"{"hotkey": "Space"}"#, r#"{"hotkey": "Ctrl+Nope"}"#, "\u{0}\u{ff}"] {
            std::fs::write(&path, body).unwrap();
            assert!(read_saved(&path).is_none(), "{body:?} should read as unsaved");
            assert_eq!(load(&path), default_hotkey(), "{body:?}");
        }
    }

    #[test]
    fn saved_config_round_trips_in_canonical_form() {
        let path = scratch("roundtrip");
        save(&path, "control+shift+KeyP").unwrap();
        assert_eq!(load(&path), "Ctrl+Shift+KeyP");
        assert_eq!(read_saved(&path), Some("Ctrl+Shift+KeyP".into()));
    }

    #[test]
    fn saving_the_default_removes_the_file() {
        let path = scratch("reset");
        save(&path, "Ctrl+Shift+KeyP").unwrap();
        assert!(path.exists());
        save(&path, default_hotkey()).unwrap();
        assert!(!path.exists());
        save(&path, default_hotkey()).unwrap();
        assert_eq!(load(&path), default_hotkey());
    }

    #[test]
    fn every_chord_the_parser_accepts_maps_to_a_portal_trigger_and_back() {
        for raw in ["Ctrl+Alt+Space", "Super+KeyP", "Ctrl+Shift+F5", "Alt+Comma", "Ctrl+Alt+Digit9", "Shift+Alt+ArrowLeft", "Ctrl+Numpad7"] {
            let chord = canonical(&parse(raw).unwrap());
            let trigger = trigger::preferred_trigger(&chord).unwrap_or_else(|| panic!("{chord} has no trigger"));
            assert_eq!(trigger::chord_from_description(&trigger).as_deref(), Some(chord.as_str()));
            // And what comes back parses again as a shortcut.
            assert!(parse(&chord).is_ok());
        }
    }
}
