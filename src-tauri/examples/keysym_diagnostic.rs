//! Diagnostic for the case bug found by `type_text_spike`: asking for
//! "hello from peekaboo" produced "HELLO FROM PEEKABOO".
//!
//! Mutter turns a keysym into a (keycode, shift-level) pair before injecting it.
//! Something in that reverse lookup is landing on the shifted level for every
//! letter. This types the word "Hello" three different ways so we can see which
//! strategy preserves case:
//!
//!   1-  raw keysym            (what the spike did; ASCII codepoint == X11 keysym)
//!   2-  Unicode-range keysym  (0x01000000 + codepoint, even for ASCII)
//!   3-  evdev keycode + explicit Shift press/release
//!
//! Expected correct output:   1-Hello 2-Hello 3-Hello
//! The spike's bug would show: 1-HELLO ...
//!
//! Run:
//!     cargo run --example keysym_diagnostic
//!
//! !! FOCUS A TEXT EDITOR, NOT A TERMINAL !!
//! You get 5 seconds. Nothing here sends Return, but typing into a shell is a
//! bad habit to build for exactly the reason this whole feature is risky.
//!
//! This run should ALSO tell us whether the restore token saved by the spike
//! suppresses the consent dialog — if a dialog appears, the token isn't working.

use ashpd::{
    desktop::{
        remote_desktop::{DeviceType, KeyState, RemoteDesktop, SelectDevicesOptions},
        PersistMode,
    },
    enumflags2::BitFlags,
};

fn token_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    std::path::PathBuf::from(home).join(".cache/peekaboo-spike-restore-token")
}

/// evdev keycodes (linux/input-event-codes.h) for the characters used here.
fn evdev_for(c: char) -> Option<(i32, bool)> {
    let lower = c.to_ascii_lowercase();
    let needs_shift = c.is_ascii_uppercase();
    let code = match lower {
        '1' => 2, '2' => 3, '3' => 4, '4' => 5, '5' => 6,
        '6' => 7, '7' => 8, '8' => 9, '9' => 10, '0' => 11,
        '-' => 12,
        'q' => 16, 'w' => 17, 'e' => 18, 'r' => 19, 't' => 20,
        'y' => 21, 'u' => 22, 'i' => 23, 'o' => 24, 'p' => 25,
        'a' => 30, 's' => 31, 'd' => 32, 'f' => 33, 'g' => 34,
        'h' => 35, 'j' => 36, 'k' => 37, 'l' => 38,
        'z' => 44, 'x' => 45, 'c' => 46, 'v' => 47, 'b' => 48,
        'n' => 49, 'm' => 50,
        ' ' => 57,
        _ => return None,
    };
    Some((code, needs_shift))
}

const KEY_LEFTSHIFT: i32 = 42;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let saved_token = std::fs::read_to_string(token_path()).ok();
    println!(
        "[diag] restore token: {}",
        if saved_token.is_some() { "present — expect NO consent dialog" } else { "MISSING" }
    );

    let proxy = RemoteDesktop::new().await?;
    let session = proxy.create_session(Default::default()).await?;

    proxy
        .select_devices(
            &session,
            SelectDevicesOptions::default()
                .set_devices(BitFlags::from(DeviceType::Keyboard))
                .set_persist_mode(PersistMode::ExplicitlyRevoked)
                .set_restore_token(saved_token.as_deref()),
        )
        .await?;

    let started = std::time::Instant::now();
    let response = proxy.start(&session, None, Default::default()).await?.response()?;
    let elapsed = started.elapsed();

    println!("[diag] Start() took {:.1}s", elapsed.as_secs_f32());
    if elapsed.as_secs_f32() < 1.0 {
        println!("[diag] -> fast: restore token WAS honoured, no dialog shown");
    } else {
        println!("[diag] -> slow: looks like a dialog appeared; token NOT honoured");
    }

    // The token is single-use: Start() hands back a fresh one that must replace
    // the old file, or the next run re-prompts.
    if let Some(tok) = response.restore_token() {
        std::fs::write(token_path(), tok)?;
        println!("[diag] rotated restore token");
    } else {
        println!("[diag] WARNING: no new restore token returned");
    }

    println!("[diag] FOCUS A TEXT EDITOR — typing in 5s");
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;

    let word = "Hello";

    // --- Strategy 1: raw keysym (ASCII codepoint doubles as the X11 keysym) ---
    for c in "1-".chars().chain(word.chars()).chain(" ".chars()) {
        let ks = c as i32;
        proxy.notify_keyboard_keysym(&session, ks, KeyState::Pressed, Default::default()).await?;
        proxy.notify_keyboard_keysym(&session, ks, KeyState::Released, Default::default()).await?;
        tokio::time::sleep(std::time::Duration::from_millis(12)).await;
    }

    // --- Strategy 2: Unicode-range keysym for every character ---
    for c in "2-".chars().chain(word.chars()).chain(" ".chars()) {
        let ks = (0x0100_0000u32 + c as u32) as i32;
        proxy.notify_keyboard_keysym(&session, ks, KeyState::Pressed, Default::default()).await?;
        proxy.notify_keyboard_keysym(&session, ks, KeyState::Released, Default::default()).await?;
        tokio::time::sleep(std::time::Duration::from_millis(12)).await;
    }

    // --- Strategy 3: evdev keycode with explicit Shift ---
    for c in "3-".chars().chain(word.chars()).chain(" ".chars()) {
        let Some((code, shift)) = evdev_for(c) else { continue };
        if shift {
            proxy.notify_keyboard_keycode(&session, KEY_LEFTSHIFT, KeyState::Pressed, Default::default()).await?;
        }
        proxy.notify_keyboard_keycode(&session, code, KeyState::Pressed, Default::default()).await?;
        proxy.notify_keyboard_keycode(&session, code, KeyState::Released, Default::default()).await?;
        if shift {
            proxy.notify_keyboard_keycode(&session, KEY_LEFTSHIFT, KeyState::Released, Default::default()).await?;
        }
        tokio::time::sleep(std::time::Duration::from_millis(12)).await;
    }

    println!("[diag] done. Expected: 1-Hello 2-Hello 3-Hello");
    println!("[diag] Report exactly what landed in the editor.");

    let _ = session.close().await;
    Ok(())
}
