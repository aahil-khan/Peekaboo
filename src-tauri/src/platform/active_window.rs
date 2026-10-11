//! Which window had focus before the overlay was summoned.
//!
//! Not implemented on any OS yet. Per-OS implementations go here as
//! `#[cfg(target_os = "...")]` blocks, the way `selection.rs` and
//! `capture.rs` are laid out.

pub fn active_window() -> Result<serde_json::Value, String> {
    Err("getActiveWindow not implemented natively yet".into())
}
