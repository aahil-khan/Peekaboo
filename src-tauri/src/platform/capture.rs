//! Interactive screen-region capture.

use tauri::AppHandle;

/// Interactive region capture, returned as base64-encoded PNG.
///
/// Linux goes through xdg-desktop-portal. The private GNOME path
/// (org.gnome.Shell.Screenshot SelectArea/ScreenshotArea) is NOT usable:
/// GNOME 50 answers "ScreenshotArea is not allowed" for unwhitelisted
/// callers, the same gating that blocks Introspect.GetWindows. The portal
/// is the only working path, and it is the portable one across
/// GNOME/KDE/wlroots regardless.
pub async fn capture_region(app: AppHandle) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        use base64::Engine;

        // Hide the overlay so it doesn't end up in the shot. Deliberately
        // window.hide() rather than window::hide_peek() — the latter emits
        // peek-visibility, which tears down frontend state and would drop the
        // in-progress conversation the capture is meant to be attached to.
        let window = crate::window::get_peek_window(&app);
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
