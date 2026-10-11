use tauri::{
    Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

// ─── Modules ─────────────────────────────────────────────────────────
// Every #[tauri::command] lives in one of these submodules, never at the
// crate root. Tauri v2's generate_handler! expands command macros into the
// module namespace; with the cdylib+rlib dual build, commands at the root
// produce duplicate definitions. Any non-root module is fine.
//
// - window:   the overlay, settings and setup windows, and AppState.
// - hotkey:   the summon shortcut and its config file.
// - plugins:  discovery, the filesystem allowlist, file loading, system info.
// - platform: OS-specific capabilities (selection, paste, capture, active
//             window), one file per capability.
// - llama:    the llama.cpp server process and the app's quit path.

mod hotkey;
mod llama;
mod platform;
mod plugins;
mod window;

// ─── App Bootstrap ──────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(window::AppState {
            settings: std::sync::Mutex::new(window::AppSettings {
                setup_completed: false,
            }),
        })
        .manage(llama::LlamaServer {
            child: std::sync::Mutex::new(None),
        })
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let state = app.state::<window::AppState>();
            window::toggle_peek(app.clone(), state);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                // Only the summon chord is ever registered, so there is nothing
                // to match the shortcut against.
                .with_handler(|app, _shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state == ShortcutState::Pressed {
                        let state = app.state::<window::AppState>();
                        window::toggle_peek(app.clone(), state);
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
            window::show_peek,
            window::hide_peek,
            window::toggle_peek,
            window::open_settings,
            window::quit_app,
            window::show_notification,
            window::resize_peek,
            window::resize_and_center,
            window::read_clipboard_image,
            window::update_settings,
            window::pick_file,
            window::show_setup_mode,
            window::hide_setup_mode,
            window::reload_app,
            window::reset_and_show_setup,
            platform::commands::plugin_get_selection,
            hotkey::get_hotkey,
            hotkey::set_hotkey,
            plugins::discovery::discover_plugins,
            plugins::discovery::get_plugin_js,
            plugins::fs::plugin_read_file,
            plugins::fs::plugin_write_file,
            plugins::files::plugin_search_files,
            plugins::sysinfo::plugin_system_info,
            plugins::files::plugin_load_file,
            platform::commands::get_active_window,
            platform::commands::capture_region,
            platform::commands::type_text,
            llama::launch_llama_server,
            llama::stop_llama_server,
            llama::get_server_status,
        ])
        .setup(|app| {

            // ── Register the summon hotkey ──
            // Native and independent of the frontend, so it works even while
            // the webview is still loading.
            app.manage(hotkey::register_at_startup(&app.handle()));
            let show_item = MenuItem::with_id(app, "show", "Show Peekaboo", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &settings_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .tooltip("Peekaboo")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => window::show_peek(app.clone()),
                    "settings" => window::open_settings(app.clone()),
                    "quit" => llama::quit(app),
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
            if let Some(window) = window::get_peek_window(&app.handle()) {
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
