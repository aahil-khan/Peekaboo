//! The llama.cpp server process the app can launch for local models, and the
//! one exit path that makes sure it never outlives the app.

use std::process::Command;
use tauri::{AppHandle, Manager, State};

// ─── Llama Server Process State ─────────────────────────────────────

pub struct LlamaServer {
    pub(crate) child: std::sync::Mutex<Option<std::process::Child>>,
}

/// The one exit path, shared by the tray menu and the overlay's quit command,
/// so a llama-server the app launched never outlives it.
pub fn quit(app: &AppHandle) {
    if let Ok(mut lock) = app.state::<LlamaServer>().child.lock() {
        if let Some(mut child) = lock.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    app.exit(0);
}

#[tauri::command]
pub fn launch_llama_server(
    state: State<'_, LlamaServer>,
    binary_path: String,
    args: Vec<String>,
) -> Result<(), String> {
    let mut lock = state.child.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut child) = *lock {
        let _ = child.kill();
        let _ = child.wait();
    }
    let child = Command::new(&binary_path)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to launch llama server: {}", e))?;
    *lock = Some(child);
    Ok(())
}

#[tauri::command]
pub fn stop_llama_server(state: State<'_, LlamaServer>) -> Result<(), String> {
    let mut lock = state.child.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut child) = *lock {
        let _ = child.kill();
        let _ = child.wait();
        *lock = None;
    }
    Ok(())
}

#[tauri::command]
pub fn get_server_status(state: State<'_, LlamaServer>) -> bool {
    if let Ok(mut lock) = state.child.lock() {
        if let Some(ref mut child) = *lock {
            match child.try_wait() {
                Ok(None) => return true,
                _ => { *lock = None; }
            }
        }
    }
    false
}
