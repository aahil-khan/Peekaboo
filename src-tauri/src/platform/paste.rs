//! Typing text back into the application the user came from.
//!
//! Not implemented on any OS yet. Per-OS implementations go here as
//! `#[cfg(target_os = "...")]` blocks, the way `selection.rs` and
//! `capture.rs` are laid out. The RemoteDesktop portal spikes for Linux are in
//! `examples/type_text_spike.rs` and `examples/keysym_diagnostic.rs`.

pub fn type_text(_text: &str) -> Result<(), String> {
    Err("typeText not implemented natively yet".into())
}
