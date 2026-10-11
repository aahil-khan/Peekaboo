//! The overlay, settings and setup windows: showing, hiding, sizing, and the
//! app-wide settings the frontend pushes down. Nothing OS-specific lives here;
//! that goes through `crate::platform`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl, WebviewWindow};

// ─── Window Helper ───────────────────────────────────────────────────

pub fn get_peek_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("peekaboo")
}

static POSITIONED: AtomicBool = AtomicBool::new(false);

// ─── Dismissal ───────────────────────────────────────────────────────
// Hiding the overlay is two steps: tell the page, which fades the surface
// out, then unmap the window once the page says the fade is done. Unmapping
// straight away (as this used to) meant the fade never played, because a
// hidden webview gets no animation frames; and since the surface was then
// frozen fully visible, the fade-in on the next summon had nothing to animate
// from either. Summon and dismiss both just popped.

/// True between "the page was told to fade out" and "the window is unmapped".
static HIDING: AtomicBool = AtomicBool::new(false);
/// Bumped by every show and every hide, so a finish that arrives late (the
/// fallback timer, or the page's acknowledgement after a re-summon) can tell
/// it belongs to a dismissal that is no longer the current one.
static VISIBILITY_GENERATION: AtomicU64 = AtomicU64::new(0);
/// How long to wait for the page before unmapping anyway. The fade is 80 ms;
/// this only matters if the page is hung or was never loaded.
const HIDE_FALLBACK: std::time::Duration = std::time::Duration::from_millis(400);

/// Unmap the window, if dismissal `generation` is still the one in progress.
fn finish_hide_if_current(app: &AppHandle, generation: u64) {
    if VISIBILITY_GENERATION.load(Ordering::SeqCst) != generation {
        return;
    }
    if HIDING.swap(false, Ordering::SeqCst) {
        if let Some(window) = get_peek_window(app) {
            let _ = window.hide();
        }
    }
}

#[derive(Default, serde::Deserialize, Clone)]
pub struct AppSettings {
    pub setup_completed: bool,
}

pub struct AppState {
    pub settings: Mutex<AppSettings>,
}

#[tauri::command]
pub fn update_settings(state: State<'_, AppState>, settings: AppSettings) {
    if let Ok(mut lock) = state.settings.lock() {
        *lock = settings;
    }
}

#[tauri::command]
pub fn show_peek(app: AppHandle) {
    if let Some(window) = get_peek_window(&app) {
        if !POSITIONED.load(Ordering::Relaxed) {
            if let Ok(Some(monitor)) = window.current_monitor() {
                let size = monitor.size();
                let scale = monitor.scale_factor();
                let logical_w = size.width as f64 / scale;
                let logical_h = size.height as f64 / scale;
                let x = (logical_w / 2.0) - 330.0;
                let y = logical_h * 0.28;
                let _ = window.set_position(LogicalPosition::new(x, y));
                POSITIONED.store(true, Ordering::Relaxed);
            }
        }
        // A summon during the fade-out cancels the dismissal: whatever finish
        // is still on its way now carries a stale generation.
        VISIBILITY_GENERATION.fetch_add(1, Ordering::SeqCst);
        HIDING.store(false, Ordering::SeqCst);
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit("peek-visibility", true);
    }
}

/// Dismiss the overlay: the page fades the surface out and calls
/// `finish_hide`, which unmaps the window. Code that needs the window gone
/// *now* (to capture the screen, or to hand focus back before pasting) should
/// call `window.hide()` itself rather than wait on this.
#[tauri::command]
pub fn hide_peek(app: AppHandle) {
    let Some(window) = get_peek_window(&app) else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        // Nothing to fade. Still tell the page, so its state cannot disagree.
        let _ = app.emit("peek-visibility", false);
        return;
    }
    if HIDING.swap(true, Ordering::SeqCst) {
        return; // already on its way out
    }
    let generation = VISIBILITY_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit("peek-visibility", false);

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(HIDE_FALLBACK);
        finish_hide_if_current(&app, generation);
    });
}

/// The page's acknowledgement that the fade-out has finished.
#[tauri::command]
pub fn finish_hide(app: AppHandle) {
    finish_hide_if_current(&app, VISIBILITY_GENERATION.load(Ordering::SeqCst));
}

#[tauri::command]
pub fn toggle_peek(app: AppHandle, state: State<'_, AppState>) {
    let setup_completed = if let Ok(lock) = state.settings.lock() {
        lock.setup_completed
    } else {
        true
    };

    // If setup not done, shortcut opens setup window instead
    if !setup_completed {
        if let Some(setup) = app.get_webview_window("setup") {
            let _ = setup.show();
            let _ = setup.set_focus();
        } else {
            // Window was closed by user — recreate it
            let _ = tauri::WebviewWindowBuilder::new(
                &app, "setup", WebviewUrl::App("index.html".into())
            )
            .title("Welcome to Peekaboo")
            .inner_size(820.0, 720.0)
            .resizable(true)
            .center()
            .build();
        }
        return;
    }

    if let Some(window) = get_peek_window(&app) {
        // Mid-fade the window is still mapped, but the user has already
        // dismissed it, so the key means "bring it back".
        if window.is_visible().unwrap_or(false) && !HIDING.load(Ordering::SeqCst) {
            hide_peek(app);
        } else {
            show_peek(app);
        }
    }
}

#[tauri::command]
pub fn open_settings(app: AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        let _ = tauri::WebviewWindowBuilder::new(
            &app,
            "settings",
            WebviewUrl::App("index.html".into())
        )
        .title("Peekaboo Settings")
        // Wide enough for the section rail plus a content column; the old
        // 480x520 forced five sections into one long undifferentiated scroll.
        .inner_size(780.0, 620.0)
        .min_inner_size(620.0, 460.0)
        .build();
    }
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    crate::llama::quit(&app);
}

#[tauri::command]
pub fn show_setup_mode(app: AppHandle) {
    if let Some(window) = app.get_webview_window("setup") {
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        // The setup window is normally pre-created hidden at startup, but
        // it can be closed outright. Rebuild it so "Run setup again" from
        // Settings is not a no-op.
        let _ = tauri::WebviewWindowBuilder::new(
            &app,
            "setup",
            WebviewUrl::App("index.html".into())
        )
        .title("Welcome to Peekaboo")
        .inner_size(820.0, 720.0)
        .center()
        .build();
    }
}

#[tauri::command]
pub fn hide_setup_mode(app: AppHandle) {
    if let Some(window) = app.get_webview_window("setup") {
        let _ = window.hide();
    }
}

#[tauri::command]
pub fn resize_and_center(app: AppHandle, width: f64, height: f64) {
    if let Some(window) = get_peek_window(&app) {
        let _ = window.set_size(LogicalSize::new(width, height));
        if let Ok(Some(monitor)) = window.current_monitor() {
            let size = monitor.size();
            let scale = monitor.scale_factor();
            let logical_w = size.width as f64 / scale;
            let logical_h = size.height as f64 / scale;
            let x = (logical_w - width) / 2.0;
            let y = (logical_h - height) / 2.0;
            let _ = window.set_position(LogicalPosition::new(x, y));
        }
    }
}

#[tauri::command]
pub fn reload_app(app: AppHandle) {
    if let Some(window) = get_peek_window(&app) {
        let _ = window.eval("window.location.reload()");
    }
}

#[tauri::command]
pub fn reset_and_show_setup(app: AppHandle) {
    if let Some(peek) = get_peek_window(&app) {
        let _ = peek.eval("window.location.reload()");
    }
    if let Some(setup) = app.get_webview_window("setup") {
        // Reload so the setup component resets to step 1 with cleared state
        let _ = setup.eval("window.location.reload()");
        let _ = setup.show();
        let _ = setup.set_focus();
    } else {
        // Window was destroyed (shouldn't happen with hide() now, but fallback)
        let _ = tauri::WebviewWindowBuilder::new(
            &app, "setup", WebviewUrl::App("index.html".into()),
        )
        .title("Welcome to Peekaboo")
        .inner_size(820.0, 720.0)
        .resizable(true)
        .center()
        .build();
    }
}

#[tauri::command]
pub fn show_notification(app: AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
}

#[tauri::command]
pub fn read_clipboard_image() -> Result<String, String> {
    use image::ImageEncoder;
    use base64::Engine;
    
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let image_data = clipboard.get_image().map_err(|e| e.to_string())?;
    
    let mut bytes: Vec<u8> = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(
            &image_data.bytes,
            image_data.width as u32,
            image_data.height as u32,
            image::ColorType::Rgba8.into(),
        )
        .map_err(|e| e.to_string())?;
        
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
pub async fn pick_file(title: String, filter_name: String, extensions: Vec<String>) -> Option<String> {
    let ext_refs: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    rfd::AsyncFileDialog::new()
        .set_title(&title)
        .add_filter(&filter_name, &ext_refs)
        .pick_file()
        .await
        .map(|f| f.path().to_string_lossy().to_string())
}
