//! Putting a result back into the application the user came from.
//!
//! The portable way is paste: put the text on the clipboard, hide the
//! overlay so focus returns to the previous app, press the platform's paste
//! chord, and put the old clipboard back afterwards. Typing character by
//! character is not used: the spikes in `examples/` measured on GNOME that
//! the RemoteDesktop portal silently drops every character above U+00FF.
//!
//! Safety comes first. Before any key is sent, the window that has focus is
//! compared with the one recorded at summon time (`focus.rs`), and a
//! mismatch is refused. Whatever stops the paste, the result is left on the
//! clipboard and the caller is told "copied instead, and why"; it is never
//! silent.
//!
//! Backends:
//! - X11, and X11 apps under Xwayland: XTest, with the focus verified.
//! - Wayland-native apps: the RemoteDesktop portal (consent dialog on first
//!   use, restore token re-saved after every start). Focus cannot be
//!   verified there; the outcome says so.
//! - Windows: `SendInput`, foreground window verified.
//! - macOS: `CGEvent`, which needs the Accessibility permission.

use super::clipboard::{self, Clipboard, Snapshot, SystemClipboard};
use super::focus::{self, Target, Verdict};
use super::keys::{self, Chord};
#[cfg(not(target_os = "linux"))]
use super::keys::KeyEvent;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum PasteOutcome {
    /// The paste chord was delivered. `method` names the backend, and
    /// whether focus was verified.
    Pasted { method: String },
    /// The text is on the clipboard and nothing was pasted, for `reason`.
    Copied { reason: String },
}

/// How long the old clipboard stays replaced after the paste chord. The
/// target reads the clipboard asynchronously; restoring too early would
/// paste the old contents instead.
const RESTORE_AFTER: Duration = Duration::from_millis(700);

enum Plan {
    Refuse(String),
    /// Verified focus; inject with the native backend.
    Native(String),
    /// Wayland-native target; go through the portal.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Portal(String),
}

struct Prepared {
    snapshot: Snapshot,
    count_after_set: Option<u64>,
    text: String,
    was_visible: bool,
    plan: Plan,
}

/// Hide the overlay, verify focus and deliver `text` as a paste. Always
/// leaves `text` on the clipboard when it cannot paste.
pub async fn paste_result(app: AppHandle, text: String) -> Result<PasteOutcome, String> {
    let app_for_prepare = app.clone();
    let text_for_prepare = text.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || prepare(&app_for_prepare, text_for_prepare))
        .await
        .map_err(|e| e.to_string())??;

    let delivery: Result<String, String> = match &prepared.plan {
        Plan::Refuse(reason) => Err(reason.clone()),
        Plan::Native(method) => {
            let method = method.clone();
            tauri::async_runtime::spawn_blocking(move || inject_paste().map(|()| method))
                .await
                .map_err(|e| e.to_string())?
        }
        Plan::Portal(note) => portal_paste(&app).await.map(|()| format!("RemoteDesktop portal; {note}")),
    };

    match delivery {
        Ok(method) => {
            schedule_restore(prepared.snapshot, prepared.count_after_set, prepared.text);
            focus::clear_at_summon();
            // The overlay was already faded out and unmapped in `prepare`.
            Ok(PasteOutcome::Pasted { method })
        }
        Err(reason) => {
            eprintln!("paste-back: copied instead: {reason}");
            if prepared.was_visible {
                // Bring the overlay back through the normal path, so the page
                // is told and can show the result and why it was copied.
                crate::window::show_peek(app.clone());
            }
            Ok(PasteOutcome::Copied { reason })
        }
    }
}

fn prepare(app: &AppHandle, text: String) -> Result<Prepared, String> {
    let mut cb = SystemClipboard::new()?;
    let snapshot = cb.snapshot();
    cb.set_text(&text)?;
    let count_after_set = cb.change_count();

    // Dismiss through the normal path: the page fades the surface out and
    // then the window unmaps. Unmapping it directly (as this once did) would
    // freeze the surface mid-exit, because a hidden webview gets no animation
    // frames, and the next summon would pop in instead of fading. Wait for the
    // window to be gone before touching focus: the previous app only gets
    // keyboard focus back once our window is unmapped.
    let window = crate::window::get_peek_window(app);
    let was_visible = window.as_ref().and_then(|w| w.is_visible().ok()).unwrap_or(false);
    if was_visible {
        crate::window::hide_peek(app.clone());
        crate::window::wait_until_hidden(app, Duration::from_millis(700));
        // A grace for the X server to process the unmap and revert focus;
        // the GTK visibility flag flips before the X UnmapNotify lands.
        std::thread::sleep(Duration::from_millis(60));
    }

    let at_summon = focus::at_summon();
    let own_pid = std::process::id();
    let mut now = settle_focus(own_pid, Duration::from_millis(500));
    // A server with no window manager (Xvfb in CI), and X11 generally after
    // the focused window unmaps, leaves focus on nobody or lingering on our
    // own overlay. Put it back on the window we were summoned from — never a
    // different real window, so focus is not stolen — and wait for it to take.
    let focus_is_ours_or_nobody = |t: &Option<Target>| t.is_none() || t.as_ref().and_then(|w| w.pid) == Some(own_pid);
    if focus_is_ours_or_nobody(&now) {
        if let Some(Some(target)) = &at_summon {
            focus::restore(target);
            let deadline = Instant::now() + Duration::from_millis(250);
            loop {
                now = focus::current();
                if now.as_ref().map(|t| t.id) == Some(target.id) || Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }

    let plan = match focus::guard(at_summon.as_ref(), &now, own_pid, focus::verifiable()) {
        Verdict::Refused(reason) => Plan::Refuse(reason),
        Verdict::Verified => Plan::Native(format!("{} into {}", native_backend_name(), describe(now.as_ref()))),
        Verdict::Unverifiable(note) => Plan::Portal(note),
    };
    Ok(Prepared { snapshot, count_after_set, text, was_visible, plan })
}

fn describe(target: Option<&Target>) -> String {
    match target.and_then(|t| t.title.as_deref()) {
        Some(title) if !title.is_empty() => format!("“{title}”"),
        _ => "the focused window".into(),
    }
}

/// Wait for keyboard focus to leave this process after the overlay hides.
fn settle_focus(own_pid: u32, timeout: Duration) -> Option<Target> {
    let deadline = Instant::now() + timeout;
    loop {
        let now = focus::current();
        let ours = now.as_ref().and_then(|t| t.pid) == Some(own_pid);
        if !ours || Instant::now() >= deadline {
            return if ours { None } else { now };
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Put the old clipboard back once the target has had time to read ours,
/// unless something else was copied in the meantime.
fn schedule_restore(snapshot: Snapshot, count_after_set: Option<u64>, ours: String) {
    if matches!(snapshot, Snapshot::Unknown) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(RESTORE_AFTER);
        let Ok(mut cb) = SystemClipboard::new() else { return };
        let count_now = cb.change_count();
        let text_now = cb.text();
        if clipboard::still_ours(count_now, count_after_set, text_now.as_deref(), &ours) {
            if let Err(e) = cb.restore(&snapshot) {
                eprintln!("paste-back: could not restore the clipboard: {e}");
            }
        }
    });
}

fn native_backend_name() -> &'static str {
    if cfg!(target_os = "linux") {
        "XTest"
    } else if cfg!(target_os = "windows") {
        "SendInput"
    } else {
        "CGEvent"
    }
}

/// Press the platform's paste chord with the native backend.
fn inject_paste() -> Result<(), String> {
    press_chord(keys::paste_chord())
}

#[cfg(target_os = "linux")]
fn press_chord(chord: Chord) -> Result<(), String> {
    super::x11::Display::open()?.press_chord(chord)
}

#[cfg(target_os = "windows")]
fn press_chord(chord: Chord) -> Result<(), String> {
    use super::keys::Modifier;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_LCONTROL,
        VK_LMENU, VK_LSHIFT, VK_LWIN, VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_RWIN,
    };
    let modifiers = [
        (VK_LSHIFT, Modifier::Shift),
        (VK_RSHIFT, Modifier::Shift),
        (VK_LCONTROL, Modifier::Control),
        (VK_RCONTROL, Modifier::Control),
        (VK_LMENU, Modifier::Alt),
        (VK_RMENU, Modifier::Alt),
        (VK_LWIN, Modifier::Super),
        (VK_RWIN, Modifier::Super),
    ];
    // SAFETY: GetAsyncKeyState is a plain query.
    let held: Vec<(u16, Modifier)> = modifiers
        .iter()
        .filter(|(vk, _)| unsafe { GetAsyncKeyState(i32::from(*vk)) } as u16 & 0x8000 != 0)
        .copied()
        .collect();
    let chord_key = match chord.modifier {
        Modifier::Shift => VK_LSHIFT,
        Modifier::Control => VK_LCONTROL,
        Modifier::Alt => VK_LMENU,
        Modifier::Super => VK_LWIN,
    };
    let letter_key = chord.letter.to_ascii_uppercase() as u16;
    let inputs: Vec<INPUT> = keys::chord_sequence(&held, chord, chord_key, letter_key)
        .into_iter()
        .map(|event| {
            let (vk, flags) = match event {
                KeyEvent::Press(vk) => (vk, 0),
                KeyEvent::Release(vk) => (vk, KEYEVENTF_KEYUP),
            };
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
            }
        })
        .collect();
    // SAFETY: a correctly sized array of INPUT structs.
    let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err(format!("SendInput delivered {sent} of {} key events", inputs.len()));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn press_chord(chord: Chord) -> Result<(), String> {
    use super::keys::Modifier;
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    const PERMISSION: &str = "macOS did not let Peekaboo send keystrokes. Open System Settings → Privacy & Security → Accessibility, switch Peekaboo on, and try again.";

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
    }

    const COMBINED_SESSION_STATE: i32 = 0;
    let modifiers: [(u16, Modifier); 8] = [
        (56, Modifier::Shift),
        (60, Modifier::Shift),
        (59, Modifier::Control),
        (62, Modifier::Control),
        (58, Modifier::Alt),
        (61, Modifier::Alt),
        (55, Modifier::Super),
        (54, Modifier::Super),
    ];
    // SAFETY: a plain query of the session's key state.
    let held: Vec<(u16, Modifier)> = modifiers
        .iter()
        .filter(|(code, _)| unsafe { CGEventSourceKeyState(COMBINED_SESSION_STATE, *code) })
        .copied()
        .collect();
    let (chord_key, flag) = match chord.modifier {
        Modifier::Shift => (56, CGEventFlags::CGEventFlagShift),
        Modifier::Control => (59, CGEventFlags::CGEventFlagControl),
        Modifier::Alt => (58, CGEventFlags::CGEventFlagAlternate),
        Modifier::Super => (55, CGEventFlags::CGEventFlagCommand),
    };
    let letter_key = match chord.letter {
        'v' => 9,
        'c' => 8,
        other => return Err(format!("no keycode for '{other}'")),
    };
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| PERMISSION.to_string())?;
    for event in keys::chord_sequence(&held, chord, chord_key, letter_key) {
        let (code, down) = match event {
            KeyEvent::Press(code) => (code, true),
            KeyEvent::Release(code) => (code, false),
        };
        let cg = CGEvent::new_keyboard_event(source.clone(), code, down).map_err(|_| PERMISSION.to_string())?;
        // The letter carries the chord's modifier flag; a modifier's own
        // press and release carry none.
        cg.set_flags(if code == letter_key { flag } else { CGEventFlags::CGEventFlagNull });
        cg.post(CGEventTapLocation::HID);
        std::thread::sleep(Duration::from_millis(12));
    }
    Ok(())
}

/// Wayland: the RemoteDesktop portal, keyboard only. The consent dialog
/// appears on first use; its restore token is single-use and re-saved after
/// every start, or the dialog would come back every time.
#[cfg(target_os = "linux")]
async fn portal_paste(app: &AppHandle) -> Result<(), String> {
    use ashpd::desktop::remote_desktop::{DeviceType, KeyState, RemoteDesktop, SelectDevicesOptions};
    use ashpd::desktop::PersistMode;
    use ashpd::enumflags2::BitFlags;

    const TOKEN_FILE: &str = "remote-desktop-token";
    const XK_V: i32 = 0x76;
    const MODIFIER_KEYSYMS: [i32; 9] = [0xFFE1, 0xFFE2, 0xFFE3, 0xFFE4, 0xFFE7, 0xFFE9, 0xFFEA, 0xFFEB, 0xFFEC];

    let token_path = app.path().app_config_dir().map_err(|e| e.to_string())?.join(TOKEN_FILE);
    let saved_token = std::fs::read_to_string(&token_path).ok();

    let proxy = RemoteDesktop::new()
        .await
        .map_err(|e| format!("The RemoteDesktop portal is not available on this desktop ({e})"))?;
    let session = proxy
        .create_session(Default::default())
        .await
        .map_err(|e| format!("The RemoteDesktop portal refused a session ({e})"))?;
    proxy
        .select_devices(
            &session,
            SelectDevicesOptions::default()
                .set_devices(BitFlags::from(DeviceType::Keyboard))
                .set_persist_mode(PersistMode::ExplicitlyRevoked)
                .set_restore_token(saved_token.as_deref()),
        )
        .await
        .map_err(|e| format!("The RemoteDesktop portal refused keyboard access ({e})"))?;

    let started = Instant::now();
    let response = tokio::time::timeout(Duration::from_secs(120), proxy.start(&session, None, Default::default()))
        .await
        .map_err(|_| "Timed out waiting for the keyboard-control consent dialog".to_string())?
        .map_err(|e| format!("The RemoteDesktop portal could not start ({e})"))?
        .response()
        .map_err(|e| format!("Keyboard control was not granted ({e})"))?;

    if let Some(token) = response.restore_token() {
        if let Some(dir) = token_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(e) = std::fs::write(&token_path, token) {
            eprintln!("paste-back: could not save the portal restore token: {e}");
        }
    }
    if !response.devices().contains(DeviceType::Keyboard) {
        let _ = session.close().await;
        return Err("The RemoteDesktop portal granted no keyboard".into());
    }
    // A consent dialog took focus; let the compositor hand it back.
    if started.elapsed() > Duration::from_secs(1) {
        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    let send = |keysym: i32, state: KeyState| proxy.notify_keyboard_keysym(&session, keysym, state, Default::default());
    // Measured in the spikes: the dialog leaves a modifier latched, so every
    // session releases them all before typing.
    for keysym in MODIFIER_KEYSYMS {
        send(keysym, KeyState::Released).await.map_err(|e| e.to_string())?;
    }
    let paste = keys::paste_chord();
    let modifier = MODIFIER_KEYSYMS[2]; // Control_L; the chord is Ctrl+V off macOS
    debug_assert_eq!(paste.modifier, keys::Modifier::Control);
    for (keysym, state) in [
        (modifier, KeyState::Pressed),
        (XK_V, KeyState::Pressed),
        (XK_V, KeyState::Released),
        (modifier, KeyState::Released),
    ] {
        send(keysym, state).await.map_err(|e| format!("The portal rejected a key event ({e})"))?;
        tokio::time::sleep(Duration::from_millis(12)).await;
    }
    let _ = session.close().await;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
async fn portal_paste(_app: &AppHandle) -> Result<(), String> {
    Err("no portal backend on this platform".into())
}

/// The plugin-facing entry point: the same paste, same guarantees.
pub async fn type_text(app: AppHandle, text: String) -> Result<PasteOutcome, String> {
    paste_result(app, text).await
}
