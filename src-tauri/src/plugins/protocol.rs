//! Serves plugin JavaScript to the webview over its own URI scheme.
//!
//! Plugins are ES modules, and the webview loads them with `import()`. They
//! used to be handed over as `data:` URLs, which the app's Content Security
//! Policy refuses in a built app, so every plugin was discovered and none ever
//! loaded (`tauri dev` serves the frontend from Vite, where the policy is not
//! applied, which is how that went unnoticed). Allowing `data:` in script-src
//! would have fixed it by letting the page run any script it can be handed as
//! a string. A dedicated scheme keeps the policy narrow: the only extra thing
//! the page may execute is what this handler chooses to serve.

use tauri::http::{Method, Request, Response, StatusCode};
use tauri::{UriSchemeContext, Wry};

/// `peekaboo-plugin://localhost/<plugin id>`. On Windows the webview spells the
/// same thing `http://peekaboo-plugin.localhost/<plugin id>`; the frontend
/// builds the URL with `convertFileSrc`, which knows the difference. Named in
/// `script-src` in tauri.conf.json and in src/lib/plugins/registry.ts.
pub const SCHEME: &str = "peekaboo-plugin";

/// Undo URL percent-encoding. `None` for a malformed escape or bytes that are
/// not UTF-8, which no id produced by the frontend ever is.
fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The plugin id a request path names: exactly one non-empty segment.
pub fn plugin_id_from_path(path: &str) -> Option<String> {
    let segment = path.strip_prefix('/').unwrap_or(path);
    if segment.is_empty() || segment.contains('/') {
        return None;
    }
    let id = percent_decode(segment)?;
    (!id.is_empty()).then_some(id)
}

fn respond(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        // A module import from another origin is a CORS request, and the
        // app's own origin differs by platform and between dev and a built
        // app. Plugin source is not a secret: it is either compiled into the
        // binary or a file the user put on their own disk.
        .header("Access-Control-Allow-Origin", "*")
        // A user editing a plugin must get the new file on the next load.
        .header("Cache-Control", "no-store")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn text(status: StatusCode, message: impl Into<String>) -> Response<Vec<u8>> {
    respond(status, "text/plain; charset=utf-8", message.into().into_bytes())
}

pub fn handle(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != Method::GET {
        return text(StatusCode::METHOD_NOT_ALLOWED, "Only GET is supported");
    }
    let Some(id) = plugin_id_from_path(request.uri().path()) else {
        return text(StatusCode::BAD_REQUEST, "Expected /<plugin id>");
    };
    match super::discovery::plugin_js(ctx.app_handle(), &id) {
        Ok(js) => respond(StatusCode::OK, "text/javascript; charset=utf-8", js.into_bytes()),
        Err(reason) => text(StatusCode::NOT_FOUND, reason),
    }
}

#[cfg(test)]
mod tests {
    use super::plugin_id_from_path;

    #[test]
    fn reads_the_id_from_a_one_segment_path() {
        assert_eq!(plugin_id_from_path("/clipboard").as_deref(), Some("clipboard"));
        assert_eq!(plugin_id_from_path("/selection-capture").as_deref(), Some("selection-capture"));
        // Some webviews hand the path over without its leading slash.
        assert_eq!(plugin_id_from_path("resources").as_deref(), Some("resources"));
    }

    #[test]
    fn decodes_what_the_frontend_encodes() {
        // encodeURIComponent("my plugin/é") — an id is free text in a manifest.
        assert_eq!(plugin_id_from_path("/my%20plugin%2F%C3%A9").as_deref(), Some("my plugin/é"));
    }

    #[test]
    fn refuses_paths_that_do_not_name_exactly_one_plugin() {
        for bad in ["", "/", "/a/b", "/a/", "//a", "/%", "/%2", "/%zz", "/%ff"] {
            assert_eq!(plugin_id_from_path(bad), None, "{bad:?}");
        }
    }
}
