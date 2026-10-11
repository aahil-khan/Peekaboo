//! The plugin system's native half: finding manifests and code, the
//! filesystem allowlist plugins read and write through, file loading and
//! search for attachments, and system info for the resources plugin.
//! The plugin contract itself is documented in `plugins/README.md` at the
//! repo root.

pub mod discovery;
pub mod files;
pub mod fs;
pub mod sysinfo;
