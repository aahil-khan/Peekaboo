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

    #[tauri::command]
    pub fn plugin_get_selection() -> Option<String> {
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
        let setup_completed = if let Ok(lock) = state.settings.lock() {
            lock.setup_completed
        } else {
            true
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
            // Wide enough for the section rail plus a content column; the old
            // 480x520 forced five sections into one long undifferentiated scroll.
            .inner_size(780.0, 620.0)
            .min_inner_size(620.0, 460.0)
            .build();
        }
    }

    #[tauri::command]
    pub fn show_setup_mode(app: AppHandle) {
        use tauri::{Manager, WebviewUrl};
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

mod plugin_commands {
    use include_dir::{include_dir, Dir};
    use serde_json::{json, Value};
    use std::collections::{BTreeMap, VecDeque};
    use std::path::{Path, PathBuf};
    use tauri::AppHandle;

    /// Plugins shipped with the app, compiled in from `plugins/` at the repo
    /// root rather than copied into the user's config directory on first run.
    /// A copy would go stale the moment the app updated, leaving people running
    /// last version's plugin with nothing to indicate it.
    static BUILTIN_PLUGINS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../plugins");

    fn get_plugins_dir(_app: &AppHandle) -> Option<PathBuf> {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(home).join(".config").join("peekaboo").join("plugins"))
    }

    /// The plugin API revision this build speaks. Bump it when a change to the
    /// manifest schema or the ctx object would break a plugin written against
    /// the old one; additive changes do not need it.
    const SUPPORTED_API_VERSION: u64 = 1;

    fn manifest_id(value: &Value) -> Option<String> {
        value.get("plugin")?.get("id")?.as_str().map(str::to_owned)
    }

    /// Reject a manifest this build cannot honour.
    ///
    /// Every manifest already declared `api_version` and nothing read it, so a
    /// plugin written for a future revision would load anyway and fail somewhere
    /// deep in a hook. Refusing at discovery is a diagnosable error instead.
    fn api_version_error(value: &Value) -> Option<String> {
        let id = manifest_id(value).unwrap_or_else(|| "<unnamed>".into());
        match value.get("api_version").and_then(Value::as_u64) {
            Some(v) if v == SUPPORTED_API_VERSION => None,
            Some(v) if v > SUPPORTED_API_VERSION => Some(format!(
                "{id} needs plugin API v{v}; this build of Peekaboo speaks v{SUPPORTED_API_VERSION}"
            )),
            Some(v) => Some(format!(
                "{id} targets plugin API v{v}, which this build no longer supports (v{SUPPORTED_API_VERSION})"
            )),
            None => Some(format!("{id} has no api_version in its plugin.toml")),
        }
    }

    /// Record where a manifest came from, so Settings can tell a bundled plugin
    /// from an installed one — and show when a built-in has been overridden.
    fn tag_builtin(value: &mut Value, builtin: bool) {
        if let Some(plugin) = value.get_mut("plugin").and_then(Value::as_object_mut) {
            plugin.insert("builtin".into(), json!(builtin));
        }
    }

    fn builtin_manifests() -> Vec<Value> {
        BUILTIN_PLUGINS
            .dirs()
            .filter_map(|dir| {
                let file = dir.get_file(dir.path().join("plugin.toml"))?;
                let mut value = toml::from_str::<Value>(file.contents_utf8()?).ok()?;
                tag_builtin(&mut value, true);
                Some(value)
            })
            .collect()
    }

    #[tauri::command]
    pub fn discover_plugins(app: AppHandle) -> Result<Vec<Value>, String> {
        // Keyed by plugin id so a user plugin replaces the built-in of the same
        // name. That is the documented way to customise a bundled plugin, since
        // the bundled copy itself is not editable on disk.
        let mut by_id: BTreeMap<String, Value> = BTreeMap::new();

        for manifest in builtin_manifests() {
            if let Some(id) = manifest_id(&manifest) {
                by_id.insert(id, manifest);
            }
        }

        if let Some(plugins_dir) = get_plugins_dir(&app) {
            if !plugins_dir.exists() {
                let _ = std::fs::create_dir_all(&plugins_dir);
            }
            if let Ok(entries) = std::fs::read_dir(&plugins_dir) {
                for entry in entries.flatten() {
                    let toml_path = entry.path().join("plugin.toml");
                    if !toml_path.is_file() {
                        continue;
                    }
                    let Ok(text) = std::fs::read_to_string(&toml_path) else {
                        continue;
                    };
                    let Ok(mut value) = toml::from_str::<Value>(&text) else {
                        continue;
                    };
                    tag_builtin(&mut value, false);
                    // Kept rather than dropped, so Settings can say why it is
                    // not running. A plugin that vanishes silently is a support
                    // question; one that explains itself is not.
                    if let Some(reason) = api_version_error(&value) {
                        if let Some(plugin) = value.get_mut("plugin").and_then(Value::as_object_mut)
                        {
                            plugin.insert("unsupported".into(), json!(true));
                            plugin.insert("error".into(), json!(reason));
                        }
                    }
                    if let Some(id) = manifest_id(&value) {
                        by_id.insert(id, value);
                    }
                }
            }
        }

        Ok(by_id.into_values().collect())
    }

    /// Locate a user-installed plugin directory by manifest id.
    fn user_plugin_dir(app: &AppHandle, plugin_id: &str) -> Option<PathBuf> {
        let entries = std::fs::read_dir(get_plugins_dir(app)?).ok()?;
        for entry in entries.flatten() {
            let dir = entry.path();
            let toml_path = dir.join("plugin.toml");
            if !toml_path.is_file() {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&toml_path) else {
                continue;
            };
            let Ok(value) = toml::from_str::<Value>(&text) else {
                continue;
            };
            if manifest_id(&value).as_deref() == Some(plugin_id) {
                return Some(dir);
            }
        }
        None
    }

    #[tauri::command]
    pub fn get_plugin_js(app: AppHandle, plugin_id: String) -> Result<String, String> {
        // User directory first. An override has to win here as well as in
        // discovery, or a customised plugin would show its own manifest while
        // running the built-in's code.
        if let Some(dir) = user_plugin_dir(&app, &plugin_id) {
            for candidate in [dir.join("dist").join("index.js"), dir.join("index.js")] {
                if candidate.exists() {
                    return std::fs::read_to_string(&candidate)
                        .map_err(|e| format!("Failed to read {}: {e}", candidate.display()));
                }
            }
            return Err(format!(
                "Plugin {plugin_id} has neither dist/index.js nor index.js"
            ));
        }

        for dir in BUILTIN_PLUGINS.dirs() {
            let Some(file) = dir.get_file(dir.path().join("plugin.toml")) else {
                continue;
            };
            let Some(text) = file.contents_utf8() else {
                continue;
            };
            let Ok(value) = toml::from_str::<Value>(text) else {
                continue;
            };
            if manifest_id(&value).as_deref() != Some(plugin_id.as_str()) {
                continue;
            }
            return dir
                .get_file(dir.path().join("index.js"))
                .and_then(|f| f.contents_utf8())
                .map(str::to_owned)
                .ok_or_else(|| format!("Built-in plugin {plugin_id} has no index.js"));
        }

        Err(format!("Plugin {plugin_id} not found"))
    }

    fn home_dir() -> Result<PathBuf, String> {
        std::env::var("HOME")
            .map(PathBuf::from)
            .map_err(|_| "HOME is not set".to_string())
    }

    /// Per-plugin scratch space. It sits under a dot-directory, which the
    /// general rule below forbids, so it is permitted explicitly.
    fn plugin_data_dir(plugin_id: &str) -> Result<PathBuf, String> {
        let invalid = plugin_id.is_empty()
            || plugin_id.contains('/')
            || plugin_id.contains('\\')
            || plugin_id.contains("..");
        if invalid {
            return Err(format!("Invalid plugin id {plugin_id:?}"));
        }
        Ok(home_dir()?
            .join(".local")
            .join("share")
            .join("peekaboo")
            .join("plugin-data")
            .join(plugin_id))
    }

    /// Resolve to an absolute path with symlinks collapsed.
    ///
    /// This runs before the allowlist check, so a symlink sitting inside the
    /// permitted area but pointing outside it cannot be used to escape. A file
    /// being written need not exist yet, so the parent is canonicalised instead.
    fn canonical_target(raw: &str) -> Result<PathBuf, String> {
        let path = Path::new(raw);
        if path.exists() {
            return path.canonicalize().map_err(|e| format!("{raw}: {e}"));
        }
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| format!("{raw}: no parent directory"))?;
        let name = path
            .file_name()
            .ok_or_else(|| format!("{raw}: not a file path"))?;
        Ok(parent
            .canonicalize()
            .map_err(|e| format!("{}: {e}", parent.display()))?
            .join(name))
    }

    /// A plugin may touch its own data directory, and files under $HOME that
    /// contain no dot-component. That second rule is what keeps `~/.ssh`,
    /// `~/.aws` and `~/.bashrc` out of reach while leaving ordinary documents
    /// available.
    ///
    /// This is a real boundary, not a sandbox — plugin JavaScript still runs in
    /// the app's webview and can reach the network.
    fn check_allowed(plugin_id: &str, raw: &str) -> Result<PathBuf, String> {
        let data_dir = plugin_data_dir(plugin_id)?;
        let _ = std::fs::create_dir_all(&data_dir);
        check_allowed_in(&home_dir()?, &data_dir, raw)
    }

    /// The rule itself, with the two roots injected so it can be tested against
    /// a scratch directory instead of the real home.
    fn check_allowed_in(home: &Path, data_dir: &Path, raw: &str) -> Result<PathBuf, String> {
        let target = canonical_target(raw)?;

        if let Ok(canonical_data) = data_dir.canonicalize() {
            if target.starts_with(&canonical_data) {
                return Ok(target);
            }
        }

        let home = home
            .canonicalize()
            .map_err(|e| format!("Could not resolve home directory: {e}"))?;

        let rest = target.strip_prefix(&home).map_err(|_| {
            format!("{raw} is outside your home directory, which plugins may not access")
        })?;

        let hidden = rest
            .components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.'));
        if hidden {
            return Err(format!(
                "{raw} is hidden or inside a hidden directory; plugins may not access dotfiles"
            ));
        }

        Ok(target)
    }

    #[cfg(test)]
    mod builtin_tests {
        use super::{builtin_manifests, manifest_id, BUILTIN_PLUGINS};

        /// Built-ins are embedded at compile time, so a plugin that stops being
        /// discoverable would otherwise fail silently at runtime on a machine
        /// nobody is looking at.
        #[test]
        fn every_bundled_plugin_is_embedded_and_parses() {
            let ids: Vec<String> = builtin_manifests().iter().filter_map(manifest_id).collect();

            for expected in [
                "resources",
                "clipboard",
                "file",
                "selection-capture",
                "openai-compatible",
            ] {
                assert!(ids.contains(&expected.to_string()), "missing built-in: {expected}\nfound: {ids:?}");
            }
        }

        #[test]
        fn every_bundled_plugin_ships_its_javascript() {
            for dir in BUILTIN_PLUGINS.dirs() {
                let has_js = dir.get_file(dir.path().join("index.js")).is_some();
                assert!(has_js, "{} has a manifest but no index.js", dir.path().display());
            }
        }

        /// Not part of the normal suite: it walks the real home directory, so
        /// the result depends on the machine. Run it with
        /// `cargo test --lib search_budget -- --ignored --nocapture` when
        /// changing the traversal caps.
        #[test]
        #[ignore]
        fn search_budget() {
            // A query that matches nothing is the worst case: it never fills
            // the result cap, so the walk runs until the visit cap instead.
            for query in ["zzqxnomatch", "config"] {
                let start = std::time::Instant::now();
                let hits = super::plugin_search_files(query.into()).unwrap();
                let elapsed = start.elapsed();
                println!("searchFiles({query:?}): {} hits in {elapsed:?} (budget 800ms)", hits.len());
                assert!(elapsed.as_millis() < 800, "{query:?} exceeded its budget: {elapsed:?}");
            }
        }

        #[test]
        fn bundled_plugins_declare_a_supported_api_version() {
            for manifest in builtin_manifests() {
                assert_eq!(
                    super::api_version_error(&manifest),
                    None,
                    "a bundled plugin must never ship an api_version this build rejects"
                );
            }
        }

        #[test]
        fn api_version_rejects_future_missing_and_retired_revisions() {
            use serde_json::json;
            let manifest = |v: serde_json::Value| json!({ "api_version": v, "plugin": { "id": "x" } });

            assert!(super::api_version_error(&manifest(json!(99)))
                .unwrap()
                .contains("this build of Peekaboo speaks"));
            assert!(super::api_version_error(&manifest(json!(0)))
                .unwrap()
                .contains("no longer supports"));
            assert!(super::api_version_error(&json!({ "plugin": { "id": "x" } }))
                .unwrap()
                .contains("no api_version"));
            assert_eq!(
                super::api_version_error(&manifest(json!(super::SUPPORTED_API_VERSION))),
                None
            );
        }

        #[test]
        fn context_plugins_declare_a_command() {
            for manifest in builtin_manifests() {
                let is_context = manifest["plugin"]["type"].as_str() == Some("context");
                if !is_context {
                    continue;
                }
                let id = manifest_id(&manifest).unwrap_or_default();
                assert!(
                    manifest["context"]["command"].as_str().is_some(),
                    "context plugin {id} has no [context] command, so it can never be typed"
                );
            }
        }
    }

    #[cfg(test)]
    mod load_file_tests {
        use super::{load_file_inner, truncate_text, MAX_TEXT_BYTES};

        fn scratch(name: &str) -> std::path::PathBuf {
            let dir = std::env::temp_dir().join(format!("peekaboo-load-{name}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        #[test]
        fn reads_utf8_text() {
            let dir = scratch("text");
            let path = dir.join("notes.txt");
            std::fs::write(&path, "hello").unwrap();

            let v = load_file_inner(&path).unwrap();
            assert_eq!(v["media_type"], "text/plain");
            assert_eq!(v["encoding"], "utf8");
            assert_eq!(v["content"], "hello");
            assert_eq!(v["truncated"], false);
        }

        #[test]
        fn base64_encodes_images_rather_than_reading_them_as_text() {
            let dir = scratch("image");
            let path = dir.join("pixel.png");
            // Not a valid PNG, but non-UTF-8 — which is the point: the old
            // read_to_string path would have failed on exactly this.
            std::fs::write(&path, [0x89u8, 0x50, 0x4E, 0x47, 0xFF, 0xD8]).unwrap();

            let v = load_file_inner(&path).unwrap();
            assert_eq!(v["media_type"], "image/png");
            assert_eq!(v["encoding"], "base64");
            assert_eq!(v["content"], "iVBOR//Y");
        }

        #[test]
        fn refuses_binary_with_a_reason_naming_the_file() {
            let dir = scratch("binary");
            let path = dir.join("thing.bin");
            std::fs::write(&path, [0xFFu8, 0xFE, 0x00, 0x01]).unwrap();

            let err = load_file_inner(&path).expect_err("binary must be refused");
            assert!(err.contains("thing.bin"), "unhelpful message: {err}");
            assert!(err.contains("bin"), "message should name the format: {err}");
        }

        #[test]
        fn truncation_lands_on_a_character_boundary() {
            // A multi-byte character straddling the cut would panic a naive
            // slice, so the boundary walk is the whole point of this.
            let text = "é".repeat(MAX_TEXT_BYTES);
            let (out, truncated) = truncate_text(text);
            assert!(truncated);
            assert!(out.len() <= MAX_TEXT_BYTES);
            assert!(out.chars().all(|c| c == 'é'));
        }

        #[test]
        fn short_text_is_not_marked_truncated() {
            let (out, truncated) = truncate_text("short".into());
            assert_eq!(out, "short");
            assert!(!truncated);
        }

        /// pdf-extract is the one dependency here that parses hostile input.
        /// Run against a real PDF with
        /// `PEEKABOO_TEST_PDF=/path/to.pdf cargo test --lib pdf -- --ignored --nocapture`.
        #[test]
        #[ignore]
        fn extracts_text_from_a_real_pdf() {
            let Ok(path) = std::env::var("PEEKABOO_TEST_PDF") else {
                eprintln!("set PEEKABOO_TEST_PDF to run this");
                return;
            };
            match load_file_inner(std::path::Path::new(&path)) {
                Ok(v) => {
                    let text = v["content"].as_str().unwrap_or_default();
                    println!("extracted {} chars, truncated={}", text.len(), v["truncated"]);
                    println!("--- first 300 ---\n{}", &text[..text.len().min(300)]);
                    assert_eq!(v["extracted_from"], "pdf");
                }
                Err(e) => println!("refused (this is a valid outcome for a scan): {e}"),
            }
        }

        /// A malformed PDF must come back as an error, never as a panic that
        /// unwinds through the command and kills the app.
        #[test]
        fn a_corrupt_pdf_errors_instead_of_panicking() {
            let dir = scratch("badpdf");
            let path = dir.join("broken.pdf");
            std::fs::write(&path, b"%PDF-1.4\nthis is not really a pdf at all").unwrap();

            let err = load_file_inner(&path).expect_err("a corrupt PDF must not succeed");
            assert!(err.contains("PDF"), "unexpected message: {err}");
        }
    }

    #[cfg(test)]
    mod fs_scope_tests {
        use super::check_allowed_in;
        use std::path::{Path, PathBuf};

        /// A scratch "home" with a data dir inside it, unique per test so the
        /// suite can run in parallel.
        struct Scratch {
            root: PathBuf,
        }

        impl Scratch {
            fn new(name: &str) -> Self {
                let root = std::env::temp_dir().join(format!("peekaboo-fs-scope-{name}"));
                let _ = std::fs::remove_dir_all(&root);
                std::fs::create_dir_all(root.join("Documents")).unwrap();
                std::fs::create_dir_all(root.join(".ssh")).unwrap();
                std::fs::create_dir_all(root.join("data")).unwrap();
                Self { root }
            }
            fn home(&self) -> &Path {
                &self.root
            }
            fn data(&self) -> PathBuf {
                self.root.join("data")
            }
            fn path(&self, rel: &str) -> String {
                self.root.join(rel).to_string_lossy().into_owned()
            }
        }

        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.root);
            }
        }

        #[test]
        fn allows_an_ordinary_file_in_home() {
            let s = Scratch::new("ordinary");
            std::fs::write(s.root.join("Documents/notes.txt"), "hi").unwrap();
            assert!(check_allowed_in(s.home(), &s.data(), &s.path("Documents/notes.txt")).is_ok());
        }

        #[test]
        fn allows_a_file_that_does_not_exist_yet() {
            let s = Scratch::new("newfile");
            assert!(check_allowed_in(s.home(), &s.data(), &s.path("Documents/new.txt")).is_ok());
        }

        #[test]
        fn refuses_dotfiles_and_dot_directories() {
            let s = Scratch::new("dotfiles");
            std::fs::write(s.root.join(".ssh/id_ed25519"), "key").unwrap();
            std::fs::write(s.root.join(".bashrc"), "export").unwrap();

            for p in [".ssh/id_ed25519", ".bashrc"] {
                let err = check_allowed_in(s.home(), &s.data(), &s.path(p))
                    .expect_err("dot-paths must be refused");
                assert!(err.contains("hidden"), "unexpected message: {err}");
            }
        }

        #[test]
        fn refuses_paths_outside_home() {
            let s = Scratch::new("outside");
            let err = check_allowed_in(s.home(), &s.data(), "/etc/passwd")
                .expect_err("paths outside home must be refused");
            assert!(err.contains("outside your home"), "unexpected message: {err}");
        }

        #[test]
        fn refuses_traversal_out_of_home() {
            let s = Scratch::new("traversal");
            assert!(check_allowed_in(s.home(), &s.data(), &s.path("Documents/../../../etc/passwd"))
                .is_err());
        }

        #[test]
        fn allows_the_plugins_own_data_directory() {
            let s = Scratch::new("datadir");
            let target = s.data().join("cache.json").to_string_lossy().into_owned();
            assert!(check_allowed_in(s.home(), &s.data(), &target).is_ok());
        }

        /// The reason canonicalisation happens before the allowlist check: a
        /// link sitting in an allowed directory must not become a way out.
        #[cfg(unix)]
        #[test]
        fn refuses_a_symlink_pointing_out_of_home() {
            let s = Scratch::new("symlink");
            let link = s.root.join("Documents/escape");
            std::os::unix::fs::symlink("/etc", &link).unwrap();

            let err = check_allowed_in(s.home(), &s.data(), &s.path("Documents/escape/passwd"))
                .expect_err("symlink escape must be refused");
            assert!(err.contains("outside your home"), "unexpected message: {err}");
        }

        /// The dot-rule applies to the resolved path, so a plain-looking link
        /// into a hidden directory is refused too.
        #[cfg(unix)]
        #[test]
        fn refuses_a_symlink_into_a_hidden_directory() {
            let s = Scratch::new("hiddenlink");
            std::fs::write(s.root.join(".ssh/id_ed25519"), "key").unwrap();
            std::os::unix::fs::symlink(s.root.join(".ssh"), s.root.join("Documents/keys")).unwrap();

            assert!(
                check_allowed_in(s.home(), &s.data(), &s.path("Documents/keys/id_ed25519")).is_err()
            );
        }
    }

    #[tauri::command]
    pub fn plugin_read_file(plugin_id: String, path: String) -> Result<String, String> {
        let target = check_allowed(&plugin_id, &path)?;
        std::fs::read_to_string(&target).map_err(|e| format!("{}: {e}", target.display()))
    }

    #[tauri::command]
    pub fn plugin_write_file(
        plugin_id: String,
        path: String,
        text: String,
    ) -> Result<(), String> {
        let target = check_allowed(&plugin_id, &path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::write(&target, text).map_err(|e| format!("{}: {e}", target.display()))
    }

    const MAX_TEXT_BYTES: usize = 512 * 1024;
    const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

    fn image_media_type(ext: &str) -> Option<&'static str> {
        match ext {
            "png" => Some("image/png"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            "gif" => Some("image/gif"),
            "webp" => Some("image/webp"),
            "bmp" => Some("image/bmp"),
            _ => None,
        }
    }

    /// pdf-extract parses documents Peekaboo did not produce, and panics rather
    /// than erroring on some malformed ones. An unwind here would take the whole
    /// app down over a bad file the user merely pointed at, so it is contained.
    fn extract_pdf_text(path: &Path) -> Result<String, String> {
        let owned = path.to_path_buf();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            pdf_extract::extract_text(&owned)
        }));
        match result {
            Ok(Ok(text)) => Ok(text),
            Ok(Err(e)) => Err(format!("Could not read this PDF: {e}")),
            Err(_) => Err("Could not read this PDF — the parser failed on it".into()),
        }
    }

    fn truncate_text(mut text: String) -> (String, bool) {
        if text.len() <= MAX_TEXT_BYTES {
            return (text, false);
        }
        // Cut on a character boundary; slicing mid-codepoint would panic.
        let mut cut = MAX_TEXT_BYTES;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        (text, true)
    }

    fn load_file_inner(path: &Path) -> Result<Value, String> {
        use base64::Engine;

        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let size = std::fs::metadata(path)
            .map_err(|e| format!("{}: {e}", path.display()))?
            .len();

        if let Some(media_type) = image_media_type(&ext) {
            if size > MAX_IMAGE_BYTES {
                return Err(format!(
                    "That image is {:.1} MB; the limit is {} MB",
                    size as f64 / 1024.0 / 1024.0,
                    MAX_IMAGE_BYTES / 1024 / 1024
                ));
            }
            let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
            return Ok(json!({
                "media_type": media_type,
                "encoding": "base64",
                "content": base64::engine::general_purpose::STANDARD.encode(&bytes),
                "truncated": false,
            }));
        }

        if ext == "pdf" {
            let (text, truncated) = truncate_text(extract_pdf_text(path)?);
            if text.trim().is_empty() {
                return Err(
                    "That PDF has no extractable text — it is probably a scan of a page".into(),
                );
            }
            return Ok(json!({
                "media_type": "text/plain",
                "encoding": "utf8",
                "content": text,
                "truncated": truncated,
                "extracted_from": "pdf",
            }));
        }

        let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let text = String::from_utf8(bytes).map_err(|_| {
            format!(
                "{} is not a text file, and .{} is not a format Peekaboo can attach",
                path.file_name().unwrap_or_default().to_string_lossy(),
                if ext.is_empty() { "—".into() } else { ext.clone() }
            )
        })?;
        let (text, truncated) = truncate_text(text);

        Ok(json!({
            "media_type": "text/plain",
            "encoding": "utf8",
            "content": text,
            "truncated": truncated,
        }))
    }

    /// Load a file for attachment, deciding representation by type: images come
    /// back base64 for vision models, PDFs as extracted text, everything else as
    /// UTF-8 text or a refusal explaining why not.
    ///
    /// Distinct from `plugin_read_file`, which stays a plain UTF-8 read for
    /// plugins that want exactly that.
    #[tauri::command]
    pub async fn plugin_load_file(plugin_id: String, path: String) -> Result<Value, String> {
        let target = check_allowed(&plugin_id, &path)?;
        // Both PDF parsing and multi-megabyte base64 are slow enough to stall
        // the UI thread noticeably.
        tauri::async_runtime::spawn_blocking(move || load_file_inner(&target))
            .await
            .map_err(|e| format!("File load task failed: {e}"))?
    }

    const SEARCH_RESULT_LIMIT: usize = 40;
    const SEARCH_VISIT_LIMIT: usize = 40_000;
    const SEARCH_MAX_DEPTH: usize = 6;

    /// Never worth walking: large, generated, and never what someone means when
    /// they say "attach a file".
    const SKIP_DIRS: [&str; 7] = [
        "node_modules",
        "target",
        "dist",
        "build",
        "__pycache__",
        "venv",
        ".git",
    ];

    #[tauri::command]
    pub fn plugin_search_files(query: String) -> Result<Vec<Value>, String> {
        let needle = query.trim().to_lowercase();
        if needle.len() < 2 {
            return Ok(Vec::new());
        }

        let mut results: Vec<Value> = Vec::new();
        let mut visited = 0usize;
        let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::from([(home_dir()?, 0usize)]);

        // Breadth-first, so shallow matches — the ones a person is most likely
        // to mean — surface ahead of anything buried in a source tree. Both
        // caps exist to keep this inside the 800ms search budget on a large
        // home directory; hitting one truncates rather than hangs.
        while let Some((dir, depth)) = queue.pop_front() {
            if results.len() >= SEARCH_RESULT_LIMIT || visited >= SEARCH_VISIT_LIMIT {
                break;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };

            for entry in entries.flatten() {
                visited += 1;
                if visited >= SEARCH_VISIT_LIMIT {
                    break;
                }

                let name = entry.file_name().to_string_lossy().to_string();
                // The same rule check_allowed enforces, applied during the walk
                // so hidden files never reach the menu in the first place.
                if name.starts_with('.') {
                    continue;
                }

                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                if is_dir {
                    if depth < SEARCH_MAX_DEPTH && !SKIP_DIRS.contains(&name.as_str()) {
                        queue.push_back((entry.path(), depth + 1));
                    }
                    continue;
                }

                if name.to_lowercase().contains(&needle) {
                    if results.len() >= SEARCH_RESULT_LIMIT {
                        break;
                    }
                    results.push(json!({
                        "path": entry.path().to_string_lossy(),
                        "name": name,
                    }));
                }
            }
        }

        Ok(results)
    }

    #[tauri::command]
    pub async fn plugin_system_info() -> Result<Value, String> {
        // CPU percentages are meaningless until sysinfo has two samples a short
        // interval apart, so this has to sleep — on a blocking thread, not the
        // one servicing the UI.
        tauri::async_runtime::spawn_blocking(|| {
            use sysinfo::{Disks, System};

            let mut sys = System::new();
            sys.refresh_cpu_usage();
            std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
            sys.refresh_cpu_usage();
            sys.refresh_memory();

            let cpus = sys.cpus();
            let load = System::load_average();

            // Windows reports zeroes here rather than failing, which would look
            // like an idle machine instead of an unsupported metric.
            let load_average = if cfg!(target_os = "windows") {
                Value::Null
            } else {
                json!([load.one, load.five, load.fifteen])
            };

            let mut seen = std::collections::HashSet::new();
            let disk_list = Disks::new_with_refreshed_list();
            let disks: Vec<Value> = disk_list
                .list()
                .iter()
                .filter(|d| d.total_space() > 0)
                .filter(|d| seen.insert(d.mount_point().to_path_buf()))
                .map(|d| {
                    json!({
                        "mount_point": d.mount_point().to_string_lossy(),
                        "file_system": d.file_system().to_string_lossy(),
                        "total": d.total_space(),
                        "available": d.available_space(),
                    })
                })
                .collect();

            json!({
                "cpu": {
                    "usage": sys.global_cpu_usage(),
                    "cores": cpus.len(),
                    "brand": cpus.first().map(|c| c.brand().to_string()).unwrap_or_default(),
                    "load_average": load_average,
                },
                "memory": {
                    "total": sys.total_memory(),
                    "used": sys.used_memory(),
                    "swap_total": sys.total_swap(),
                    "swap_used": sys.used_swap(),
                },
                "disks": disks,
            })
        })
        .await
        .map_err(|e| format!("System info task failed: {e}"))
    }

    #[tauri::command]
    pub fn get_active_window() -> Result<serde_json::Value, String> {
        Err("getActiveWindow not implemented natively yet".into())
    }

    /// Interactive region capture, returned as base64-encoded PNG.
    ///
    /// Linux goes through xdg-desktop-portal. The private GNOME path
    /// (org.gnome.Shell.Screenshot SelectArea/ScreenshotArea) is NOT usable:
    /// GNOME 50 answers "ScreenshotArea is not allowed" for unwhitelisted
    /// callers, the same gating that blocks Introspect.GetWindows. The portal
    /// is the only working path, and it is the portable one across
    /// GNOME/KDE/wlroots regardless.
    #[tauri::command]
    pub async fn capture_region(app: AppHandle) -> Result<String, String> {
        #[cfg(target_os = "linux")]
        {
            use base64::Engine;

            // Hide the overlay so it doesn't end up in the shot. Deliberately
            // window.hide() rather than commands::hide_peek() — the latter emits
            // peek-visibility, which tears down frontend state and would drop the
            // in-progress conversation the capture is meant to be attached to.
            let window = super::get_peek_window(&app);
            let was_visible = window
                .as_ref()
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);

            if was_visible {
                if let Some(w) = &window {
                    let _ = w.hide();
                }
                // Let the compositor actually unmap the surface before capturing.
                tokio::time::sleep(std::time::Duration::from_millis(180)).await;
            }

            let result = async {
                let response = ashpd::desktop::screenshot::Screenshot::request()
                    .interactive(true)
                    .send()
                    .await
                    .map_err(|e| format!("Screenshot portal unavailable: {e}"))?
                    .response()
                    .map_err(|e| format!("Screenshot cancelled or denied: {e}"))?;

                let uri = response.uri().as_str();
                let path = url::Url::parse(uri)
                    .map_err(|e| format!("Malformed screenshot URI {uri}: {e}"))?
                    .to_file_path()
                    .map_err(|_| format!("Screenshot URI is not a local file: {uri}"))?;

                let bytes = std::fs::read(&path)
                    .map_err(|e| format!("Failed to read screenshot {}: {e}", path.display()))?;

                // The portal drops the file in the user's cache dir; don't leave
                // screenshots of their desktop lying around after we've read them.
                let _ = std::fs::remove_file(&path);

                if bytes.is_empty() {
                    return Err("Screenshot file was empty".to_string());
                }

                Ok::<String, String>(base64::engine::general_purpose::STANDARD.encode(&bytes))
            }
            .await;

            if was_visible {
                if let Some(w) = &window {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }

            result
        }

        #[cfg(not(target_os = "linux"))]
        {
            let _ = app;
            Err("capture_region is currently implemented for Linux (xdg-desktop-portal) only".into())
        }
    }

    #[tauri::command]
    pub fn type_text(_text: String) -> Result<(), String> {
        Err("typeText not implemented natively yet".into())
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
        .plugin(tauri_plugin_http::init())
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
            commands::plugin_get_selection,
            plugin_commands::discover_plugins,
            plugin_commands::get_plugin_js,
            plugin_commands::plugin_read_file,
            plugin_commands::plugin_write_file,
            plugin_commands::plugin_search_files,
            plugin_commands::plugin_system_info,
            plugin_commands::plugin_load_file,
            plugin_commands::get_active_window,
            plugin_commands::capture_region,
            plugin_commands::type_text,
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
