//! Reading the text the user currently has selected in another application.

/// The current selection, trimmed, or `None` when there is none or it cannot
/// be read on this platform.
pub fn selection() -> Option<String> {
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
