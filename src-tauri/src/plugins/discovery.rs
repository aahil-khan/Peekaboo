//! Where plugins come from: the built-ins compiled into the binary and the
//! user's own directory, with the latter overriding the former by id.

use include_dir::{include_dir, Dir};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
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
