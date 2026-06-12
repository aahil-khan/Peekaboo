use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    WebviewWindow,
};

// ─── Window Helper ───────────────────────────────────────────────────

fn get_peek_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("peekaboo")
}

// ─── Commands — isolated in a module to avoid macro name collision ────
// (Tauri v2 generate_handler! expands command macros into the module
// namespace; cdylib+rlib dual compilation causes duplicate definition
// if commands are in the root. Wrapping in mod commands:: prevents it.)

mod commands {
    use tauri::{AppHandle, LogicalPosition, LogicalSize, Emitter};
    use super::get_peek_window;

    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use tauri::State;
    static POSITIONED: AtomicBool = AtomicBool::new(false);

    #[derive(Default, serde::Deserialize, Clone)]
    pub struct AppSettings {
        pub auto_capture_selection: bool,
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
            let _ = window.show();
            let _ = window.set_focus();
            let _ = app.emit("peek-visibility", true);
        }
    }

    #[tauri::command]
    pub fn hide_peek(app: AppHandle) {
        if let Some(window) = get_peek_window(&app) {
            let _ = app.emit("peek-visibility", false);
            // Reset to minimum height before hiding so reopening always starts from the same size
            let _ = window.set_size(LogicalSize::new(660.0_f64, 80.0_f64));
            let _ = window.hide();
        }
    }

    fn get_primary_selection() -> Option<String> {
        #[cfg(target_os = "linux")]
        {
            use std::process::Command;
            let mut selection = None;
            // Try Wayland primary selection first
            if let Ok(output) = Command::new("wl-paste").arg("-p").output() {
                if output.status.success() {
                    if let Ok(text) = String::from_utf8(output.stdout) {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            selection = Some(trimmed.to_string());
                        }
                    }
                }
            }
            // Fallback to X11 primary selection
            if selection.is_none() {
                if let Ok(output) = Command::new("xclip").args(["-o", "-selection", "primary"]).output() {
                    if output.status.success() {
                        if let Ok(text) = String::from_utf8(output.stdout) {
                            let trimmed = text.trim();
                            if !trimmed.is_empty() {
                                selection = Some(trimmed.to_string());
                            }
                        }
                    }
                }
            }
            // Clear selection if we got one to avoid stale captures
            if selection.is_some() {
                let _ = Command::new("wl-copy").args(["-p", "-c"]).status();
                let _ = Command::new("xclip").args(["-selection", "primary", "-i", "/dev/null"]).status();
            }
            selection
        }

        // Windows/macOS: read text from regular clipboard
        #[cfg(not(target_os = "linux"))]
        {
            use arboard::Clipboard;
            if let Ok(mut cb) = Clipboard::new() {
                if let Ok(text) = cb.get_text() {
                    let trimmed = text.trim().to_string();
                    if !trimmed.is_empty() {
                        return Some(trimmed);
                    }
                }
            }
            None
        }
    }

    #[tauri::command]
    pub fn toggle_peek(app: AppHandle, state: State<'_, AppState>) {
        let (capture_selection, setup_completed) = if let Ok(lock) = state.settings.lock() {
            (lock.auto_capture_selection, lock.setup_completed)
        } else {
            (true, true)
        };

        // If setup not done, shortcut opens setup window instead
        if !setup_completed {
            use tauri::{Manager, WebviewUrl};
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
            if window.is_visible().unwrap_or(false) {
                hide_peek(app);
            } else {
                if capture_selection {
                    if let Some(text) = get_primary_selection() {
                        let _ = window.emit("peek-highlighted-text", text);
                    }
                }
                show_peek(app);
            }
        }
    }

    #[tauri::command]
    pub fn open_settings(app: AppHandle) {
        use tauri::{Manager, WebviewUrl};
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
            .inner_size(480.0, 520.0)
            .build();
        }
    }

    #[tauri::command]
    pub fn show_setup_mode(app: AppHandle) {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("setup") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    #[tauri::command]
    pub fn hide_setup_mode(app: AppHandle) {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("setup") {
            let _ = window.hide();
        }
    }

    #[tauri::command]
    pub fn resize_peek(app: AppHandle, width: f64, height: f64) {
        if let Some(window) = get_peek_window(&app) {
            if let Ok(pos) = window.outer_position() {
                let _ = window.set_size(LogicalSize::new(width, height));
                let _ = window.set_position(pos);
            } else {
                let _ = window.set_size(LogicalSize::new(width, height));
            }
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
        use tauri::{Manager, WebviewUrl};
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
}

// ─── Llama Server Process State ─────────────────────────────────────

pub struct LlamaServer {
    child: std::sync::Mutex<Option<std::process::Child>>,
}

mod server_commands {
    use tauri::State;
    use super::LlamaServer;
    use std::process::Command;

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
}

// ─── App Bootstrap ──────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::AppState {
            settings: std::sync::Mutex::new(commands::AppSettings {
                auto_capture_selection: true,
                setup_completed: false,
            }),
        })
        .manage(LlamaServer {
            child: std::sync::Mutex::new(None),
        })
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let state = app.state::<commands::AppState>();
            commands::toggle_peek(app.clone(), state);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri_plugin_global_shortcut::{ShortcutState, Modifiers, Code};
                    if event.state == ShortcutState::Pressed {
                        let triggered = shortcut.matches(Modifiers::ALT, Code::Space)
                            || shortcut.matches(Modifiers::CONTROL, Code::Space);
                        if triggered {
                            let state = app.state::<commands::AppState>();
                            commands::toggle_peek(app.clone(), state);
                        }
                    }
                })
                .build(),
        )
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations(
                    "sqlite:peekaboo.db",
                    vec![
                        tauri_plugin_sql::Migration {
                            version: 1,
                            description: "Create sessions and messages tables",
                            sql: include_str!("../../src/db/migrations/001_initial.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 2,
                            description: "Create memories table",
                            sql: include_str!("../../src/db/migrations/002_memories.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 3,
                            description: "Enhance memories table",
                            sql: include_str!("../../src/db/migrations/003_memory_enhancements.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        }
                    ],
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::show_peek,
            commands::hide_peek,
            commands::toggle_peek,
            commands::open_settings,
            commands::show_notification,
            commands::resize_peek,
            commands::resize_and_center,
            commands::read_clipboard_image,
            commands::update_settings,
            commands::pick_file,
            commands::show_setup_mode,
            commands::hide_setup_mode,
            commands::reload_app,
            commands::reset_and_show_setup,
            server_commands::launch_llama_server,
            server_commands::stop_llama_server,
            server_commands::get_server_status,
        ])
        .setup(|app| {

            // ── Register Global Shortcuts ──
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Shortcut, Modifiers, Code, GlobalShortcutExt};
                let ctrl_space = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);
                let alt_space = Shortcut::new(Some(Modifiers::ALT), Code::Space);
                if let Err(err) = app.global_shortcut().register(ctrl_space) {
                    eprintln!("Failed to register Ctrl+Space: {:?}", err);
                }
                // Also register Alt+Space; may fail on Windows if system-reserved
                let _ = app.global_shortcut().register(alt_space);
            }
            let show_item = MenuItem::with_id(app, "show", "Show Peekaboo", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &settings_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .tooltip("Peekaboo")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => commands::show_peek(app.clone()),
                    "settings" => commands::open_settings(app.clone()),
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // ── Pre-create Setup window (hidden) — created from Rust so IPC works ──
            {
                use tauri::WebviewUrl;
                let _ = tauri::WebviewWindowBuilder::new(
                    app,
                    "setup",
                    WebviewUrl::App("index.html".into()),
                )
                .title("Welcome to Peekaboo")
                .inner_size(820.0, 720.0)
                .resizable(true)
                .center()
                .visible(false)
                .build();
            }

            // ── Focus Loss → Hide ──
            let app_handle = app.handle().clone();
            if let Some(window) = get_peek_window(&app.handle()) {
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        let _ = app_handle.emit("peek-focus-lost", ());
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Peekaboo");
}
