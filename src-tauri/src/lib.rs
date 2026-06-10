use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    WebviewWindow,
    LogicalPosition, LogicalSize,
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
    static POSITIONED: AtomicBool = AtomicBool::new(false);

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

    #[tauri::command]
    pub fn toggle_peek(app: AppHandle) {
        if let Some(window) = get_peek_window(&app) {
            if window.is_visible().unwrap_or(false) {
                hide_peek(app);
            } else {
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
}

// ─── App Bootstrap ──────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            commands::toggle_peek(app.clone());
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri_plugin_global_shortcut::{ShortcutState, Modifiers, Code};
                    if event.state == ShortcutState::Pressed {
                        if shortcut.matches(Modifiers::ALT, Code::Space) {
                            commands::toggle_peek(app.clone());
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
            commands::read_clipboard_image,
        ])
        .setup(|app| {
            // ── Register Alt+Space Shortcut ──
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Shortcut, Modifiers, Code, GlobalShortcutExt};
                let alt_space = Shortcut::new(Some(Modifiers::ALT), Code::Space);
                if let Err(err) = app.global_shortcut().register(alt_space) {
                    eprintln!("Failed to register Alt+Space global shortcut: {:?}", err);
                }
            }

            // ── System Tray ──
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
