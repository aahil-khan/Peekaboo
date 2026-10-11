//! OS-specific capabilities behind one facade.
//!
//! The rest of the app calls the plain functions re-exported here and never
//! reaches for `cfg(target_os)` itself. Each capability has one file holding
//! its Linux, Windows and macOS code side by side, so the worker implementing
//! a capability on a new OS edits that one file and nothing else:
//!
//! - `selection.rs`: the text the user has selected in another app.
//! - `paste.rs`: typing text back into the previous app (`type_text`).
//! - `capture.rs`: interactive screen-region capture.
//! - `active_window.rs`: which window had focus before the overlay.
//!
//! Where an OS has no implementation yet, the function returns an error
//! saying so rather than silently doing nothing. The Tauri commands in
//! `commands.rs` are thin wrappers; command names and return shapes are part
//! of the frontend contract and must not change here.

mod active_window;
mod capture;
pub mod commands;
mod paste;
mod selection;

pub use active_window::active_window;
pub use capture::capture_region;
pub use paste::type_text;
pub use selection::selection;
