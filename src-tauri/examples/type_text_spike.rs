//! Phase A spike — can Peekaboo type an answer into whatever window the user
//! was in, on GNOME/Wayland, without root, `ydotool`, or `/dev/uinput`?
//!
//! This deliberately does NOT build the production session lifecycle. It answers
//! three questions and then exits:
//!
//!   1. Does `RemoteDesktop` `CreateSession -> SelectDevices -> Start` succeed
//!      with keyboard-only devices (no paired ScreenCast session)?
//!   2. Does `NotifyKeyboardKeysym` actually land characters in the focused app?
//!   3. Does `persist_mode` + `restore_token` suppress the consent dialog on the
//!      second run? (The token is single-use — each Start returns a NEW one that
//!      must be re-persisted. Getting this wrong is the most common way this
//!      feature ships broken, so the spike exercises it explicitly.)
//!
//! Run it twice — the second run is the one that tells you about the token:
//!
//!     cargo run --example type_text_spike -- "hello from peekaboo"
//!
//! After the consent dialog, you get 4 seconds to click into a text field.
//!
//! NOTE: `get_active_window` is blocked on GNOME 50, so this types blind — into
//! whatever holds focus when the delay expires. That is exactly the safety
//! problem the production version has to design around. Newlines are stripped
//! here on purpose: a newline typed into a terminal is command execution.

use ashpd::{
    desktop::{
        remote_desktop::{DeviceType, KeyState, RemoteDesktop, SelectDevicesOptions},
        PersistMode,
    },
    enumflags2::BitFlags,
};

/// Latin-1 (U+0000..U+00FF) maps 1:1 onto X11 keysyms and injects correctly.
///
/// MEASURED on GNOME 50 / Mutter: the Unicode escape range (0x01000000 + cp)
/// is **silently dropped** — no character appears, no error is returned. So
/// anything at or above U+0100 cannot be typed this way, which matters more
/// than it sounds: LLM answers are full of em-dashes, curly quotes and
/// ellipses, and they would vanish mid-sentence with no failure signal.
///
/// Production therefore has to normalise typographic characters down to ASCII
/// before typing, and fall back to the clipboard for anything that survives.
fn keysym_for(c: char) -> Option<i32> {
    let cp = c as u32;
    if cp < 0x100 { Some(cp as i32) } else { None }
}

/// Fold the characters LLMs actually emit into typeable Latin-1.
fn normalize_for_typing(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\u{2014}' | '\u{2013}' => out.push_str("--"), // em/en dash
            '\u{2018}' | '\u{2019}' => out.push('\''),     // curly single quotes
            '\u{201C}' | '\u{201D}' => out.push('"'),      // curly double quotes
            '\u{2026}' => out.push_str("..."),             // ellipsis
            '\u{00A0}' | '\u{202F}' => out.push(' '),      // non-breaking spaces
            _ => out.push(c),
        }
    }
    out
}

fn token_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    std::path::PathBuf::from(home).join(".cache/peekaboo-spike-restore-token")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let raw = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "hello from peekaboo".into());
    let text: String = normalize_for_typing(&raw)
        .chars()
        .filter(|c| *c != '\n' && *c != '\r')
        .collect();

    let undeliverable: Vec<char> = text.chars().filter(|c| keysym_for(*c).is_none()).collect();
    if !undeliverable.is_empty() {
        println!(
            "[spike] WARNING: {} char(s) above U+00FF cannot be typed and will be skipped: {:?}",
            undeliverable.len(),
            undeliverable
        );
    }

    let saved_token = std::fs::read_to_string(token_path()).ok();
    match &saved_token {
        Some(t) => println!("[spike] found restore token ({} chars) — expecting NO consent dialog", t.len()),
        None => println!("[spike] no restore token — expecting a consent dialog"),
    }

    let started = std::time::Instant::now();

    let proxy = RemoteDesktop::new().await?;
    println!("[spike] portal version: {}", proxy.version());

    let session = proxy.create_session(Default::default()).await?;
    println!("[spike] session created");

    proxy
        .select_devices(
            &session,
            SelectDevicesOptions::default()
                .set_devices(BitFlags::from(DeviceType::Keyboard))
                .set_persist_mode(PersistMode::ExplicitlyRevoked)
                .set_restore_token(saved_token.as_deref()),
        )
        .await?;
    println!("[spike] devices selected (keyboard only, no screencast)");

    let response = proxy.start(&session, None, Default::default()).await?.response()?;
    let consent_elapsed = started.elapsed();

    println!("[spike] session started — granted devices: {:?}", response.devices());
    println!("[spike] time to Start(): {:.1}s", consent_elapsed.as_secs_f32());

    match response.restore_token() {
        Some(tok) => {
            if let Some(parent) = token_path().parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(token_path(), tok)?;
            println!("[spike] restore token persisted -> {}", token_path().display());
        }
        None => println!("[spike] WARNING: no restore token returned — will re-prompt every launch"),
    }

    if !response.devices().contains(DeviceType::Keyboard) {
        eprintln!("[spike] FAIL: keyboard was not granted");
        return Ok(());
    }

    println!("[spike] focus a text field — typing {:?} in 4s...", text);
    tokio::time::sleep(std::time::Duration::from_secs(4)).await;

    let type_start = std::time::Instant::now();
    for c in text.chars() {
        let Some(keysym) = keysym_for(c) else { continue };
        proxy
            .notify_keyboard_keysym(&session, keysym, KeyState::Pressed, Default::default())
            .await?;
        proxy
            .notify_keyboard_keysym(&session, keysym, KeyState::Released, Default::default())
            .await?;
        // Compositors drop events that arrive too fast to be plausible input.
        tokio::time::sleep(std::time::Duration::from_millis(8)).await;
    }

    println!(
        "[spike] typed {} chars in {}ms",
        text.chars().count(),
        type_start.elapsed().as_millis()
    );
    println!("[spike] DONE — if the text appeared where you focused, type_text is viable.");

    let _ = session.close().await;
    Ok(())
}
