//! The clipboard as the capture and paste paths need it: save it, put our
//! text on it, tell whether another app changed it, and put it back.
//!
//! The decisions ("did a synthesised copy actually copy anything?", "is it
//! still our text, so restoring is safe?") are pure functions over counts
//! and text so they can be tested without a display. `SystemClipboard` is
//! the one implementation of the [`Clipboard`] trait that talks to the OS.
//!
//! Change counts: Windows has `GetClipboardSequenceNumber`, macOS has
//! `NSPasteboard.changeCount`. X11 and Wayland have nothing of the kind, so
//! on Linux the count is `None` and callers compare text instead.

/// What the clipboard held before Peekaboo touched it.
#[derive(Clone, Debug, PartialEq)]
// `Empty` and `Raw` come from the Windows raw-format reader only; arboard
// cannot tell "empty" from "a format it does not read".
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub enum Snapshot {
    Empty,
    Text(String),
    Image {
        width: usize,
        height: usize,
        rgba: Vec<u8>,
    },
    /// Windows only: every HGLOBAL-backed format, verbatim.
    Raw(Vec<(u32, Vec<u8>)>),
    /// Something this platform cannot read back (files, rich content on
    /// Linux and macOS). A restore leaves the clipboard as it is.
    Unknown,
}

pub trait Clipboard {
    /// A number that changes whenever any app writes the clipboard, where the
    /// platform has one.
    fn change_count(&mut self) -> Option<u64>;
    fn text(&mut self) -> Option<String>;
    fn set_text(&mut self, text: &str) -> Result<(), String>;
    fn snapshot(&mut self) -> Snapshot;
    fn restore(&mut self, snapshot: &Snapshot) -> Result<(), String>;
}

/// Whether the clipboard still holds what Peekaboo put there, so restoring
/// the old contents cannot destroy something the user copied since.
pub fn still_ours(
    count_now: Option<u64>,
    count_after_set: Option<u64>,
    text_now: Option<&str>,
    ours: &str,
) -> bool {
    match (count_now, count_after_set) {
        (Some(now), Some(then)) => now == then,
        _ => text_now == Some(ours),
    }
}

// ─── The real clipboard ─────────────────────────────────────────────

pub struct SystemClipboard {
    inner: arboard::Clipboard,
}

impl SystemClipboard {
    pub fn new() -> Result<Self, String> {
        arboard::Clipboard::new()
            .map(|inner| Self { inner })
            .map_err(|e| format!("The clipboard is not available: {e}"))
    }
}

impl Clipboard for SystemClipboard {
    fn change_count(&mut self) -> Option<u64> {
        platform_change_count()
    }

    fn text(&mut self) -> Option<String> {
        self.inner.get_text().ok()
    }

    fn set_text(&mut self, text: &str) -> Result<(), String> {
        self.inner.set_text(text).map_err(|e| format!("Could not write the clipboard: {e}"))
    }

    fn snapshot(&mut self) -> Snapshot {
        #[cfg(target_os = "windows")]
        {
            match windows::snapshot() {
                Ok(formats) if formats.is_empty() => return Snapshot::Empty,
                Ok(formats) => return Snapshot::Raw(formats),
                Err(e) => eprintln!("clipboard snapshot fell back to text: {e}"),
            }
        }
        if let Ok(text) = self.inner.get_text() {
            return Snapshot::Text(text);
        }
        if let Ok(image) = self.inner.get_image() {
            return Snapshot::Image {
                width: image.width,
                height: image.height,
                rgba: image.bytes.into_owned(),
            };
        }
        // arboard reports "empty" and "a format we do not read" the same way
        // on every platform, so this is the best it can say.
        Snapshot::Unknown
    }

    fn restore(&mut self, snapshot: &Snapshot) -> Result<(), String> {
        match snapshot {
            Snapshot::Empty => self.inner.clear().map_err(|e| e.to_string()),
            Snapshot::Text(text) => self.inner.set_text(text).map_err(|e| e.to_string()),
            Snapshot::Image { width, height, rgba } => self
                .inner
                .set_image(arboard::ImageData {
                    width: *width,
                    height: *height,
                    bytes: std::borrow::Cow::Borrowed(rgba),
                })
                .map_err(|e| e.to_string()),
            #[cfg(target_os = "windows")]
            Snapshot::Raw(formats) => windows::restore(formats),
            #[cfg(not(target_os = "windows"))]
            Snapshot::Raw(_) => Err("raw clipboard formats are a Windows snapshot".into()),
            Snapshot::Unknown => Ok(()),
        }
    }
}

#[cfg(target_os = "windows")]
fn platform_change_count() -> Option<u64> {
    // SAFETY: a plain query with no arguments.
    Some(unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() } as u64)
}

#[cfg(target_os = "macos")]
fn platform_change_count() -> Option<u64> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    // SAFETY: NSPasteboard.generalPasteboard and changeCount are plain
    // AppKit calls with no arguments; the pasteboard object is owned by
    // AppKit and outlives this call.
    unsafe {
        let pasteboard: *mut AnyObject = msg_send![objc2::class!(NSPasteboard), generalPasteboard];
        if pasteboard.is_null() {
            return None;
        }
        let count: isize = msg_send![pasteboard, changeCount];
        Some(count as u64)
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn platform_change_count() -> Option<u64> {
    None
}

/// Raw Win32 clipboard access, so a save and restore keeps every format an
/// app put there rather than only the text arboard knows. Formats that are
/// handles rather than memory (bitmaps, metafiles, palettes, private and
/// owner-display formats) cannot be copied this way and are left out.
#[cfg(target_os = "windows")]
mod windows {
    use windows_sys::Win32::Foundation::{GlobalFree, HGLOBAL};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData, OpenClipboard,
        SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
    use windows_sys::Win32::System::Ole::{
        CF_BITMAP, CF_DSPBITMAP, CF_DSPENHMETAFILE, CF_DSPMETAFILEPICT, CF_DSPTEXT, CF_ENHMETAFILE,
        CF_GDIOBJFIRST, CF_METAFILEPICT, CF_OWNERDISPLAY, CF_PALETTE, CF_PRIVATEFIRST, CF_PRIVATELAST,
    };

    /// Anything bigger is not worth holding in memory for a paste.
    const MAX_FORMAT_BYTES: usize = 32 * 1024 * 1024;

    fn is_handle_format(format: u32) -> bool {
        let f = format as u16;
        matches!(
            f,
            CF_BITMAP | CF_METAFILEPICT | CF_ENHMETAFILE | CF_PALETTE | CF_OWNERDISPLAY | CF_DSPTEXT
                | CF_DSPBITMAP | CF_DSPMETAFILEPICT | CF_DSPENHMETAFILE
        ) || (CF_PRIVATEFIRST..=CF_PRIVATELAST).contains(&f)
            || (CF_GDIOBJFIRST..=CF_GDIOBJFIRST + 0xFF).contains(&f)
    }

    /// Another process may hold the clipboard open for a moment; retry briefly.
    struct Open;
    impl Open {
        fn new() -> Result<Self, String> {
            for _ in 0..10 {
                // SAFETY: null owner means the current task; closed by Drop.
                if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                    return Ok(Self);
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err("the clipboard is held open by another application".into())
        }
    }
    impl Drop for Open {
        fn drop(&mut self) {
            // SAFETY: paired with the successful OpenClipboard in `new`.
            unsafe { CloseClipboard() };
        }
    }

    pub fn snapshot() -> Result<Vec<(u32, Vec<u8>)>, String> {
        let _open = Open::new()?;
        let mut out = Vec::new();
        let mut format = 0u32;
        loop {
            // SAFETY: clipboard is open; 0 means "first format".
            format = unsafe { EnumClipboardFormats(format) };
            if format == 0 {
                break;
            }
            if is_handle_format(format) {
                continue;
            }
            // SAFETY: clipboard is open. The handle stays valid until the
            // clipboard is closed, and we copy out of it before that.
            let handle = unsafe { GetClipboardData(format) } as HGLOBAL;
            if handle.is_null() {
                continue;
            }
            let size = unsafe { GlobalSize(handle) };
            if size == 0 || size > MAX_FORMAT_BYTES {
                continue;
            }
            let ptr = unsafe { GlobalLock(handle) };
            if ptr.is_null() {
                continue;
            }
            // SAFETY: GlobalSize bytes are readable from a locked HGLOBAL.
            let bytes = unsafe { std::slice::from_raw_parts(ptr as *const u8, size) }.to_vec();
            unsafe { GlobalUnlock(handle) };
            out.push((format, bytes));
        }
        Ok(out)
    }

    pub fn restore(formats: &[(u32, Vec<u8>)]) -> Result<(), String> {
        let _open = Open::new()?;
        // SAFETY: clipboard is open.
        if unsafe { EmptyClipboard() } == 0 {
            return Err("EmptyClipboard failed".into());
        }
        for (format, bytes) in formats {
            // SAFETY: a fresh moveable block of the right size, filled and
            // unlocked before the clipboard takes ownership of it.
            unsafe {
                let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
                if handle.is_null() {
                    continue;
                }
                let ptr = GlobalLock(handle);
                if ptr.is_null() {
                    GlobalFree(handle);
                    continue;
                }
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
                GlobalUnlock(handle);
                if SetClipboardData(*format, handle as _).is_null() {
                    GlobalFree(handle);
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_only_when_the_clipboard_is_still_ours() {
        assert!(still_ours(Some(4), Some(4), None, "ours"));
        assert!(!still_ours(Some(5), Some(4), Some("ours"), "ours"), "a newer count means someone copied");
        assert!(still_ours(None, None, Some("ours"), "ours"));
        assert!(!still_ours(None, None, Some("theirs"), "ours"));
        assert!(!still_ours(None, None, None, "ours"));
    }
}
