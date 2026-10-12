//! The OS grab through `tauri-plugin-global-shortcut`.
//!
//! On Linux its backend (the `global-hotkey` crate) speaks X11 only, and it
//! opens the display on a thread of its own: when there is no X server that
//! thread dies quietly and every later `register()` answers `Ok(())`, so the
//! app would believe a hotkey is live on a pure Wayland session. Checking the
//! display here first turns that into the error it is.

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

#[cfg(target_os = "linux")]
fn display_reachable() -> Result<(), String> {
    if std::env::var_os("DISPLAY").is_none_or(|v| v.is_empty()) {
        return Err("no X11 display (DISPLAY is unset)".into());
    }
    x11rb::connect(None)
        .map(|_| ())
        .map_err(|e| format!("no X11 display ({e})"))
}

#[cfg(not(target_os = "linux"))]
fn display_reachable() -> Result<(), String> {
    Ok(())
}

pub fn register(app: &AppHandle, shortcut: Shortcut) -> Result<(), String> {
    display_reachable()?;
    app.global_shortcut().register(shortcut).map_err(|e| e.to_string())
}

pub fn unregister(app: &AppHandle, shortcut: Shortcut) {
    let _ = app.global_shortcut().unregister(shortcut);
}
