//! Files for attachment: loading one by type (image, PDF, text) and finding
//! them by name under the home directory, inside the search budget.

use super::fs::{check_allowed, home_dir};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};

const MAX_TEXT_BYTES: usize = 512 * 1024;
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

fn image_media_type(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

/// pdf-extract parses documents Peekaboo did not produce, and panics rather
/// than erroring on some malformed ones. An unwind here would take the whole
/// app down over a bad file the user merely pointed at, so it is contained.
fn extract_pdf_text(path: &Path) -> Result<String, String> {
    let owned = path.to_path_buf();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        pdf_extract::extract_text(&owned)
    }));
    match result {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(e)) => Err(format!("Could not read this PDF: {e}")),
        Err(_) => Err("Could not read this PDF — the parser failed on it".into()),
    }
}

fn truncate_text(mut text: String) -> (String, bool) {
    if text.len() <= MAX_TEXT_BYTES {
        return (text, false);
    }
    // Cut on a character boundary; slicing mid-codepoint would panic.
    let mut cut = MAX_TEXT_BYTES;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    (text, true)
}

fn load_file_inner(path: &Path) -> Result<Value, String> {
    use base64::Engine;

    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let size = std::fs::metadata(path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .len();

    if let Some(media_type) = image_media_type(&ext) {
        if size > MAX_IMAGE_BYTES {
            return Err(format!(
                "That image is {:.1} MB; the limit is {} MB",
                size as f64 / 1024.0 / 1024.0,
                MAX_IMAGE_BYTES / 1024 / 1024
            ));
        }
        let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        return Ok(json!({
            "media_type": media_type,
            "encoding": "base64",
            "content": base64::engine::general_purpose::STANDARD.encode(&bytes),
            "truncated": false,
        }));
    }

    if ext == "pdf" {
        let (text, truncated) = truncate_text(extract_pdf_text(path)?);
        if text.trim().is_empty() {
            return Err(
                "That PDF has no extractable text — it is probably a scan of a page".into(),
            );
        }
        return Ok(json!({
            "media_type": "text/plain",
            "encoding": "utf8",
            "content": text,
            "truncated": truncated,
            "extracted_from": "pdf",
        }));
    }

    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let text = String::from_utf8(bytes).map_err(|_| {
        format!(
            "{} is not a text file, and .{} is not a format Peekaboo can attach",
            path.file_name().unwrap_or_default().to_string_lossy(),
            if ext.is_empty() { "—".into() } else { ext.clone() }
        )
    })?;
    let (text, truncated) = truncate_text(text);

    Ok(json!({
        "media_type": "text/plain",
        "encoding": "utf8",
        "content": text,
        "truncated": truncated,
    }))
}

/// Load a file for attachment, deciding representation by type: images come
/// back base64 for vision models, PDFs as extracted text, everything else as
/// UTF-8 text or a refusal explaining why not.
///
/// Distinct from `plugin_read_file`, which stays a plain UTF-8 read for
/// plugins that want exactly that.
#[tauri::command]
pub async fn plugin_load_file(plugin_id: String, path: String) -> Result<Value, String> {
    let target = check_allowed(&plugin_id, &path)?;
    // Both PDF parsing and multi-megabyte base64 are slow enough to stall
    // the UI thread noticeably.
    tauri::async_runtime::spawn_blocking(move || load_file_inner(&target))
        .await
        .map_err(|e| format!("File load task failed: {e}"))?
}

const SEARCH_RESULT_LIMIT: usize = 40;
const SEARCH_VISIT_LIMIT: usize = 40_000;
const SEARCH_MAX_DEPTH: usize = 6;

/// Never worth walking: large, generated, and never what someone means when
/// they say "attach a file".
const SKIP_DIRS: [&str; 7] = [
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    "venv",
    ".git",
];

#[tauri::command]
pub fn plugin_search_files(query: String) -> Result<Vec<Value>, String> {
    let needle = query.trim().to_lowercase();
    if needle.len() < 2 {
        return Ok(Vec::new());
    }

    let mut results: Vec<Value> = Vec::new();
    let mut visited = 0usize;
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::from([(home_dir()?, 0usize)]);

    // Breadth-first, so shallow matches — the ones a person is most likely
    // to mean — surface ahead of anything buried in a source tree. Both
    // caps exist to keep this inside the 800ms search budget on a large
    // home directory; hitting one truncates rather than hangs.
    while let Some((dir, depth)) = queue.pop_front() {
        if results.len() >= SEARCH_RESULT_LIMIT || visited >= SEARCH_VISIT_LIMIT {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };

        for entry in entries.flatten() {
            visited += 1;
            if visited >= SEARCH_VISIT_LIMIT {
                break;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            // The same rule check_allowed enforces, applied during the walk
            // so hidden files never reach the menu in the first place.
            if name.starts_with('.') {
                continue;
            }

            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if depth < SEARCH_MAX_DEPTH && !SKIP_DIRS.contains(&name.as_str()) {
                    queue.push_back((entry.path(), depth + 1));
                }
                continue;
            }

            if name.to_lowercase().contains(&needle) {
                if results.len() >= SEARCH_RESULT_LIMIT {
                    break;
                }
                results.push(json!({
                    "path": entry.path().to_string_lossy(),
                    "name": name,
                }));
            }
        }
    }

    Ok(results)
}

#[cfg(test)]
mod load_file_tests {
    use super::{load_file_inner, truncate_text, MAX_TEXT_BYTES};

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("peekaboo-load-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_utf8_text() {
        let dir = scratch("text");
        let path = dir.join("notes.txt");
        std::fs::write(&path, "hello").unwrap();

        let v = load_file_inner(&path).unwrap();
        assert_eq!(v["media_type"], "text/plain");
        assert_eq!(v["encoding"], "utf8");
        assert_eq!(v["content"], "hello");
        assert_eq!(v["truncated"], false);
    }

    #[test]
    fn base64_encodes_images_rather_than_reading_them_as_text() {
        let dir = scratch("image");
        let path = dir.join("pixel.png");
        // Not a valid PNG, but non-UTF-8 — which is the point: the old
        // read_to_string path would have failed on exactly this.
        std::fs::write(&path, [0x89u8, 0x50, 0x4E, 0x47, 0xFF, 0xD8]).unwrap();

        let v = load_file_inner(&path).unwrap();
        assert_eq!(v["media_type"], "image/png");
        assert_eq!(v["encoding"], "base64");
        assert_eq!(v["content"], "iVBOR//Y");
    }

    #[test]
    fn refuses_binary_with_a_reason_naming_the_file() {
        let dir = scratch("binary");
        let path = dir.join("thing.bin");
        std::fs::write(&path, [0xFFu8, 0xFE, 0x00, 0x01]).unwrap();

        let err = load_file_inner(&path).expect_err("binary must be refused");
        assert!(err.contains("thing.bin"), "unhelpful message: {err}");
        assert!(err.contains("bin"), "message should name the format: {err}");
    }

    #[test]
    fn truncation_lands_on_a_character_boundary() {
        // A multi-byte character straddling the cut would panic a naive
        // slice, so the boundary walk is the whole point of this.
        let text = "é".repeat(MAX_TEXT_BYTES);
        let (out, truncated) = truncate_text(text);
        assert!(truncated);
        assert!(out.len() <= MAX_TEXT_BYTES);
        assert!(out.chars().all(|c| c == 'é'));
    }

    #[test]
    fn short_text_is_not_marked_truncated() {
        let (out, truncated) = truncate_text("short".into());
        assert_eq!(out, "short");
        assert!(!truncated);
    }

    /// pdf-extract is the one dependency here that parses hostile input.
    /// Run against a real PDF with
    /// `PEEKABOO_TEST_PDF=/path/to.pdf cargo test --lib pdf -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn extracts_text_from_a_real_pdf() {
        let Ok(path) = std::env::var("PEEKABOO_TEST_PDF") else {
            eprintln!("set PEEKABOO_TEST_PDF to run this");
            return;
        };
        match load_file_inner(std::path::Path::new(&path)) {
            Ok(v) => {
                let text = v["content"].as_str().unwrap_or_default();
                println!("extracted {} chars, truncated={}", text.len(), v["truncated"]);
                println!("--- first 300 ---\n{}", &text[..text.len().min(300)]);
                assert_eq!(v["extracted_from"], "pdf");
            }
            Err(e) => println!("refused (this is a valid outcome for a scan): {e}"),
        }
    }

    /// A malformed PDF must come back as an error, never as a panic that
    /// unwinds through the command and kills the app.
    #[test]
    fn a_corrupt_pdf_errors_instead_of_panicking() {
        let dir = scratch("badpdf");
        let path = dir.join("broken.pdf");
        std::fs::write(&path, b"%PDF-1.4\nthis is not really a pdf at all").unwrap();

        let err = load_file_inner(&path).expect_err("a corrupt PDF must not succeed");
        assert!(err.contains("PDF"), "unexpected message: {err}");
    }
}

#[cfg(test)]
mod search_tests {
    /// Not part of the normal suite: it walks the real home directory, so
    /// the result depends on the machine. Run it with
    /// `cargo test --lib search_budget -- --ignored --nocapture` when
    /// changing the traversal caps.
    #[test]
    #[ignore]
    fn search_budget() {
        // A query that matches nothing is the worst case: it never fills
        // the result cap, so the walk runs until the visit cap instead.
        for query in ["zzqxnomatch", "config"] {
            let start = std::time::Instant::now();
            let hits = super::plugin_search_files(query.into()).unwrap();
            let elapsed = start.elapsed();
            println!("searchFiles({query:?}): {} hits in {elapsed:?} (budget 800ms)", hits.len());
            assert!(elapsed.as_millis() < 800, "{query:?} exceeded its budget: {elapsed:?}");
        }
    }
}
