//! OS-specific capabilities behind one facade.
//!
//! The rest of the app calls the plain functions re-exported here and never
//! reaches for `cfg(target_os)` itself. Each capability has one file holding
//! its Linux, Windows and macOS code side by side, so the worker implementing
//! a capability on a new OS edits that one file and nothing else:
//!
//! - `selection.rs`: the text the user has selected in another app, read at
//!   summon time.
//! - `paste.rs`: putting a result back into the previous app as a paste.
//! - `focus.rs`: which window has keyboard focus, recorded at summon and
//!   verified before a paste.
//! - `clipboard.rs`: save, change detection and restore around a paste.
//! - `keys.rs`: chord sequencing, including releasing held modifiers.
//! - `x11.rs`: Linux-only X11 plumbing used by `focus` and `paste`.
//! - `capture.rs`: interactive screen-region capture.
//! - `active_window.rs`: which window had focus before the overlay.
//!
//! Where an OS has no implementation yet, the function returns an error
//! saying so rather than silently doing nothing. The Tauri commands in
//! `commands.rs` are thin wrappers; command names and return shapes are part
//! of the frontend contract and must not change here.

mod active_window;
mod capture;
mod clipboard;
pub mod commands;
mod focus;
mod keys;
mod paste;
mod selection;
#[cfg(target_os = "linux")]
mod x11;

pub use active_window::active_window;
pub use capture::capture_region;
pub use paste::{paste_result, type_text, PasteOutcome};
pub use selection::{capture_for_summon, capture_info, read as read_selection, CaptureInfo};
