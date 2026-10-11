//! Summon hotkey: registration at startup, the `get_hotkey`/`set_hotkey`
//! commands, and the small JSON file the chord is persisted in.
//!
//! The shortcut is registered here in Rust at startup, without waiting for the
//! frontend, so it cannot live in the webview's localStorage: Rust has no way
//! to read that. It gets a small JSON file in the app config directory instead.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut};

pub const CONFIG_FILE: &str = "hotkey.json";

pub struct HotkeyState {
    /// What is registered with the OS right now, in canonical spelling.
    pub active: Mutex<String>,
    /// Set when the saved shortcut could not be grabbed at startup, so
    /// Settings can say why the user's chord is not the one in effect.
    pub startup_error: Mutex<Option<String>>,
}

#[derive(serde::Serialize, Clone)]
pub struct HotkeyInfo {
    pub hotkey: String,
    pub default: String,
    pub error: Option<String>,
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
    let shortcut = parse(hotkey)?;
    app.global_shortcut().register(shortcut).map_err(|e| e.to_string())
}

/// Register the saved chord, falling back to the default if the OS refuses
/// it (another app took it since, or it came from a different platform).
/// Runs in setup, before the frontend has loaded, so summoning never waits
/// for it.
pub fn register_at_startup(app: &AppHandle) -> HotkeyState {
    let wanted = config_path(app)
        .map(|path| load(&path))
        .unwrap_or_else(|_| default_hotkey().to_string());
    let fallback = default_hotkey().to_string();

    let (active, startup_error) = match register(app, &wanted) {
        Ok(()) => (wanted, None),
        Err(reason) if wanted != fallback && register(app, &fallback).is_ok() => {
            eprintln!("Hotkey {wanted} could not be registered ({reason}); using {fallback}");
            (
                fallback.clone(),
                Some(format!(
                    "Your saved hotkey {wanted} could not be registered ({reason}), so the default {fallback} is active."
                )),
            )
        }
        Err(reason) => {
            eprintln!("Hotkey {wanted} could not be registered: {reason}");
            (
                wanted.clone(),
                Some(format!(
                    "{wanted} could not be registered ({reason}). Pick another combination; until then, use the tray or launch Peekaboo again to show it."
                )),
            )
        }
    };

    HotkeyState {
        active: Mutex::new(active),
        startup_error: Mutex::new(startup_error),
    }
}

fn info(state: &HotkeyState) -> HotkeyInfo {
    HotkeyInfo {
        hotkey: state.active.lock().map(|a| a.clone()).unwrap_or_default(),
        default: default_hotkey().to_string(),
        error: state.startup_error.lock().ok().and_then(|e| e.clone()),
    }
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
    let old = state.active.lock().map(|a| a.clone()).map_err(|e| e.to_string())?;

    if new != old {
        // New first, old second: if the OS refuses the new chord the old
        // one was never touched, so there is no moment without a hotkey.
        app.global_shortcut()
            .register(shortcut)
            .map_err(|e| format!("Could not use {new}: {e}. {old} still works."))?;
        if let Ok(previous) = parse(&old) {
            let _ = app.global_shortcut().unregister(previous);
        }
        if let Ok(mut active) = state.active.lock() {
            *active = new.clone();
        }
        let _ = app.emit("hotkey-changed", &new);
    }

    let path = config_path(&app)?;
    save(&path, &new)
        .map_err(|e| format!("{new} is active, but could not be saved for next launch: {e}"))?;
    // Whatever went wrong at startup, the user has now chosen a chord that
    // registered and persisted, so the message has served its purpose.
    if let Ok(mut error) = state.startup_error.lock() {
        *error = None;
    }
    Ok(info(&state))
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
}
