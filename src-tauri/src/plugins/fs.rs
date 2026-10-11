//! The filesystem boundary for plugins: which paths a plugin may read and
//! write, and the plain read/write commands that enforce it.

use std::path::{Path, PathBuf};

pub(super) fn home_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "HOME is not set".to_string())
}

/// Per-plugin scratch space. It sits under a dot-directory, which the
/// general rule below forbids, so it is permitted explicitly.
fn plugin_data_dir(plugin_id: &str) -> Result<PathBuf, String> {
    let invalid = plugin_id.is_empty()
        || plugin_id.contains('/')
        || plugin_id.contains('\\')
        || plugin_id.contains("..");
    if invalid {
        return Err(format!("Invalid plugin id {plugin_id:?}"));
    }
    Ok(home_dir()?
        .join(".local")
        .join("share")
        .join("peekaboo")
        .join("plugin-data")
        .join(plugin_id))
}

/// Resolve to an absolute path with symlinks collapsed.
///
/// This runs before the allowlist check, so a symlink sitting inside the
/// permitted area but pointing outside it cannot be used to escape. A file
/// being written need not exist yet, so the parent is canonicalised instead.
fn canonical_target(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if path.exists() {
        return path.canonicalize().map_err(|e| format!("{raw}: {e}"));
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("{raw}: no parent directory"))?;
    let name = path
        .file_name()
        .ok_or_else(|| format!("{raw}: not a file path"))?;
    Ok(parent
        .canonicalize()
        .map_err(|e| format!("{}: {e}", parent.display()))?
        .join(name))
}

/// A plugin may touch its own data directory, and files under $HOME that
/// contain no dot-component. That second rule is what keeps `~/.ssh`,
/// `~/.aws` and `~/.bashrc` out of reach while leaving ordinary documents
/// available.
///
/// This is a real boundary, not a sandbox — plugin JavaScript still runs in
/// the app's webview and can reach the network.
pub(super) fn check_allowed(plugin_id: &str, raw: &str) -> Result<PathBuf, String> {
    let data_dir = plugin_data_dir(plugin_id)?;
    let _ = std::fs::create_dir_all(&data_dir);
    check_allowed_in(&home_dir()?, &data_dir, raw)
}

/// The rule itself, with the two roots injected so it can be tested against
/// a scratch directory instead of the real home.
fn check_allowed_in(home: &Path, data_dir: &Path, raw: &str) -> Result<PathBuf, String> {
    let target = canonical_target(raw)?;

    if let Ok(canonical_data) = data_dir.canonicalize() {
        if target.starts_with(&canonical_data) {
            return Ok(target);
        }
    }

    let home = home
        .canonicalize()
        .map_err(|e| format!("Could not resolve home directory: {e}"))?;

    let rest = target.strip_prefix(&home).map_err(|_| {
        format!("{raw} is outside your home directory, which plugins may not access")
    })?;

    let hidden = rest
        .components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'));
    if hidden {
        return Err(format!(
            "{raw} is hidden or inside a hidden directory; plugins may not access dotfiles"
        ));
    }

    Ok(target)
}

#[tauri::command]
pub fn plugin_read_file(plugin_id: String, path: String) -> Result<String, String> {
    let target = check_allowed(&plugin_id, &path)?;
    std::fs::read_to_string(&target).map_err(|e| format!("{}: {e}", target.display()))
}

#[tauri::command]
pub fn plugin_write_file(
    plugin_id: String,
    path: String,
    text: String,
) -> Result<(), String> {
    let target = check_allowed(&plugin_id, &path)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    std::fs::write(&target, text).map_err(|e| format!("{}: {e}", target.display()))
}

#[cfg(test)]
mod fs_scope_tests {
    use super::check_allowed_in;
    use std::path::{Path, PathBuf};

    /// A scratch "home" with a data dir inside it, unique per test so the
    /// suite can run in parallel.
    struct Scratch {
        root: PathBuf,
    }

    impl Scratch {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!("peekaboo-fs-scope-{name}"));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join("Documents")).unwrap();
            std::fs::create_dir_all(root.join(".ssh")).unwrap();
            std::fs::create_dir_all(root.join("data")).unwrap();
            Self { root }
        }
        fn home(&self) -> &Path {
            &self.root
        }
        fn data(&self) -> PathBuf {
            self.root.join("data")
        }
        fn path(&self, rel: &str) -> String {
            self.root.join(rel).to_string_lossy().into_owned()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn allows_an_ordinary_file_in_home() {
        let s = Scratch::new("ordinary");
        std::fs::write(s.root.join("Documents/notes.txt"), "hi").unwrap();
        assert!(check_allowed_in(s.home(), &s.data(), &s.path("Documents/notes.txt")).is_ok());
    }

    #[test]
    fn allows_a_file_that_does_not_exist_yet() {
        let s = Scratch::new("newfile");
        assert!(check_allowed_in(s.home(), &s.data(), &s.path("Documents/new.txt")).is_ok());
    }

    #[test]
    fn refuses_dotfiles_and_dot_directories() {
        let s = Scratch::new("dotfiles");
        std::fs::write(s.root.join(".ssh/id_ed25519"), "key").unwrap();
        std::fs::write(s.root.join(".bashrc"), "export").unwrap();

        for p in [".ssh/id_ed25519", ".bashrc"] {
            let err = check_allowed_in(s.home(), &s.data(), &s.path(p))
                .expect_err("dot-paths must be refused");
            assert!(err.contains("hidden"), "unexpected message: {err}");
        }
    }

    #[test]
    fn refuses_paths_outside_home() {
        let s = Scratch::new("outside");
        // A sibling of the scratch home rather than /etc/passwd: /etc does
        // not exist on Windows, where the path would fail to resolve before
        // the rule under test ever ran.
        let outside = s.root.with_file_name("not-in-home.txt");
        let err = check_allowed_in(s.home(), &s.data(), &outside.to_string_lossy())
            .expect_err("paths outside home must be refused");
        assert!(err.contains("outside your home"), "unexpected message: {err}");
    }

    #[test]
    fn refuses_traversal_out_of_home() {
        let s = Scratch::new("traversal");
        assert!(check_allowed_in(s.home(), &s.data(), &s.path("Documents/../../../etc/passwd"))
            .is_err());
    }

    #[test]
    fn allows_the_plugins_own_data_directory() {
        let s = Scratch::new("datadir");
        let target = s.data().join("cache.json").to_string_lossy().into_owned();
        assert!(check_allowed_in(s.home(), &s.data(), &target).is_ok());
    }

    /// The reason canonicalisation happens before the allowlist check: a
    /// link sitting in an allowed directory must not become a way out.
    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_pointing_out_of_home() {
        let s = Scratch::new("symlink");
        let link = s.root.join("Documents/escape");
        std::os::unix::fs::symlink("/etc", &link).unwrap();

        let err = check_allowed_in(s.home(), &s.data(), &s.path("Documents/escape/passwd"))
            .expect_err("symlink escape must be refused");
        assert!(err.contains("outside your home"), "unexpected message: {err}");
    }

    /// The dot-rule applies to the resolved path, so a plain-looking link
    /// into a hidden directory is refused too.
    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_into_a_hidden_directory() {
        let s = Scratch::new("hiddenlink");
        std::fs::write(s.root.join(".ssh/id_ed25519"), "key").unwrap();
        std::os::unix::fs::symlink(s.root.join(".ssh"), s.root.join("Documents/keys")).unwrap();

        assert!(
            check_allowed_in(s.home(), &s.data(), &s.path("Documents/keys/id_ed25519")).is_err()
        );
    }
}
