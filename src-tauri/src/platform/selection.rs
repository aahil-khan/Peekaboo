//! Reading the text the user has selected in another application.
//!
//! Two entry points: `read()` reads on demand (plugins' `ctx.getSelection`)
//! and `capture_for_summon()` runs inside the summon hotkey handler, before
//! the overlay is shown and takes focus. It also records which window had
//! focus, which `paste.rs` checks before putting anything back.
//!
//! Linux reads the primary selection through arboard: Wayland data-control
//! where the compositor offers it, X11 (or Xwayland, which mutter bridges
//! the primary selection into) otherwise. No side effects, no external
//! binaries; a failure to reach any selection is reported once, with what
//! to do about it.
//!
//! Windows and macOS have no selection read yet. Neither OS lets another
//! process read a selection without either the Accessibility API or asking
//! the focused app to copy, and that half is not written; `capture_info()`
//! says so, the Settings toggle shows it, and the overlay opens without an
//! attachment there. Paste-back works independently of it.

use super::focus;
use std::sync::atomic::{AtomicBool, Ordering};

/// How this platform captures, for the Settings toggle to explain itself.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInfo {
    pub method: &'static str,
    /// Whether this platform can read a selection at all.
    pub available: bool,
    /// On by default only where it has no side effects.
    pub default_on: bool,
}

pub fn capture_info() -> CaptureInfo {
    capture_info_for(std::env::consts::OS)
}

pub fn capture_info_for(os: &str) -> CaptureInfo {
    match os {
        "linux" => CaptureInfo { method: "primary-selection", available: true, default_on: true },
        _ => CaptureInfo { method: "none", available: false, default_on: false },
    }
}

/// What a summon hands the frontend.
#[derive(serde::Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SummonCapture {
    pub selection: Option<String>,
    /// The window the selection came from, when the platform can name it.
    pub source: Option<String>,
    /// Why nothing could be read, shown once per launch so a missing
    /// display or protocol is actionable rather than silent.
    pub error: Option<String>,
}

static WARNED: AtomicBool = AtomicBool::new(false);

/// Record the focused window, then read the selection if `enabled`. Runs
/// before the overlay is shown.
pub fn capture_for_summon(enabled: bool) -> SummonCapture {
    let target = focus::record_at_summon();
    let mut capture = SummonCapture {
        source: target.as_ref().and_then(|t| t.title.clone()),
        ..Default::default()
    };
    if !enabled || !capture_info().available {
        return capture;
    }
    match read() {
        Ok(text) => capture.selection = text,
        Err(error) => {
            eprintln!("selection capture: {error}");
            if !WARNED.swap(true, Ordering::Relaxed) {
                capture.error = Some(error);
            }
        }
    }
    capture
}

/// The current selection, trimmed, or `None` when nothing is selected.
/// `Err` is a real problem (no display, no protocol) with a message the
/// user can act on.
pub fn read() -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    {
        use arboard::{GetExtLinux, LinuxClipboardKind};
        let mut cb = arboard::Clipboard::new().map_err(|e| {
            format!("Peekaboo cannot read the selection: no clipboard connection ({e}). On Wayland this needs either a compositor with the data-control protocol or Xwayland.")
        })?;
        match cb.get().clipboard(LinuxClipboardKind::Primary).text() {
            Ok(text) => Ok(trimmed(text)),
            Err(arboard::Error::ContentNotAvailable) => Ok(None),
            Err(arboard::Error::ClipboardNotSupported) => Err(
                "Peekaboo cannot read the selection: this compositor offers no primary selection to other apps (no data-control protocol and no Xwayland).".into(),
            ),
            Err(e) => Err(format!("Peekaboo could not read the selection: {e}")),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(format!("Selection capture is not implemented on {} yet", std::env::consts::OS))
    }
}

fn trimmed(text: String) -> Option<String> {
    let t = text.trim();
    (!t.is_empty()).then(|| t.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_is_on_by_default_only_where_it_has_no_side_effects() {
        let linux = capture_info_for("linux");
        assert!(linux.available && linux.default_on);
        for os in ["windows", "macos"] {
            let info = capture_info_for(os);
            assert!(!info.available, "{os}");
            assert!(!info.default_on, "{os}");
        }
    }

    #[test]
    fn whitespace_only_selections_read_as_nothing() {
        assert_eq!(trimmed("  \n\t".into()), None);
        assert_eq!(trimmed("  word \n".into()), Some("word".into()));
    }

    #[test]
    fn a_disabled_capture_still_records_the_source_but_reads_nothing() {
        let capture = capture_for_summon(false);
        assert_eq!(capture.selection, None);
        assert_eq!(capture.error, None);
    }
}
