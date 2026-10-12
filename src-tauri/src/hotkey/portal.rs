//! The summon key through the XDG GlobalShortcuts portal
//! (`org.freedesktop.portal.GlobalShortcuts`), Linux only.
//!
//! The portal is asked in the background, after the OS grab is in place, and
//! reports back through `hotkey::apply_portal_event`; nothing here blocks the
//! app. The steps, with what was learnt about each:
//!
//! 1. The desktop needs to know who is asking. A sandboxed app is identified
//!    by its sandbox; a host app like Peekaboo has to register its app id on
//!    the connection first (`org.freedesktop.host.portal.Registry`, portal
//!    1.20+), **before any other portal call**, and xdg-desktop-portal 1.21
//!    rejects `CreateSession` outright without one ("An app id is required").
//!    The id must name an installed `<id>.desktop` file, so a hidden one is
//!    written to the user's applications directory when none exists (a
//!    packaged install ships its own).
//! 2. `CreateSession`, then `ListShortcuts`: a binding the desktop remembers
//!    from an earlier run is listed here, which tells us whether a dialog is
//!    coming. There is no restore token; the desktop keys what it remembers
//!    by app id and shortcut id, so `SHORTCUT_ID` must never change.
//! 3. `BindShortcuts` with the configured chord as the *preferred* trigger.
//!    Allowed once per session. The first time, the desktop shows a consent
//!    dialog (GNOME, KDE); a remembered binding comes back without one. The
//!    answer is what was actually bound, which may differ from what was asked.
//! 4. `Activated` is the summon. `ShortcutsChanged` follows the user editing
//!    the key in the system settings. `Closed` on the session means the
//!    desktop took the binding away.
//!
//! Timeouts guard every step that should be quick; the bind itself is not
//! timed, because the dialog waits for a human and the grab covers the wait.

use super::status::{Bound, PortalEvent};
use super::{trigger, SHORTCUT_ID};
use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut, Shortcut};
use ashpd::desktop::{ResponseError, Session};
use futures_util::StreamExt;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Tauri's `identifier`; also the basename of the desktop entry.
pub const APP_ID: &str = "com.peekaboo.app";
const DESCRIPTION: &str = "Summon Peekaboo";
const QUICK: Duration = Duration::from_secs(10);

/// The open session, kept so `ConfigureShortcuts` has something to point at
/// and so the proxies (and their signal streams) stay alive.
pub struct Link {
    proxy: GlobalShortcuts,
    session: Session<GlobalShortcuts>,
}

impl Link {
    pub async fn configure(&self) -> Result<(), String> {
        tokio::time::timeout(QUICK, self.proxy.configure_shortcuts(&self.session, None, Default::default()))
            .await
            .map_err(|_| "The desktop did not answer the request to open its shortcut editor.".to_string())?
            .map_err(|e| format!("The desktop could not open its shortcut editor ({e})."))
    }
}

/// The session's object path, for matching the portal's signals (they carry
/// the path and are broadcast to every session of ours).
fn session_path(session: &Session<GlobalShortcuts>) -> String {
    serde_json::to_value(session)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn bound(list: &[Shortcut]) -> Vec<Bound> {
    list.iter()
        .map(|s| Bound { id: s.id().to_string(), trigger_description: s.trigger_description().to_string() })
        .collect()
}

pub fn start(app: AppHandle, chord: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(reason) = run(app.clone(), chord).await {
            super::apply_portal_event(&app, PortalEvent::Failed(reason));
        }
    });
}

async fn run(app: AppHandle, chord: String) -> Result<(), String> {
    let preferred = trigger::preferred_trigger(&chord);
    if preferred.is_none() {
        eprintln!("hotkey: {chord} has no portal trigger; asking the desktop to pick one");
    }

    match ensure_desktop_entry(&app) {
        Ok(Some(path)) => eprintln!("hotkey: wrote {} so the portal can identify Peekaboo", path.display()),
        Ok(None) => {}
        Err(e) => eprintln!("hotkey: could not write a desktop entry for the portal ({e}); the desktop may refuse the request"),
    }

    // Registering is what lets the desktop remember the binding across runs.
    // Older portals have no Registry (and derive an id, or accept none), so
    // a failure here is logged and the request still goes out.
    let app_id = ashpd::AppID::try_from(APP_ID).map_err(|e| format!("bad app id {APP_ID}: {e}"))?;
    match tokio::time::timeout(QUICK, ashpd::register_host_app(app_id)).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => eprintln!("hotkey: the portal did not register the app id {APP_ID} ({e}); continuing without"),
        Err(_) => eprintln!("hotkey: the portal did not answer the app id registration; continuing without"),
    }

    let proxy = tokio::time::timeout(QUICK, GlobalShortcuts::new())
        .await
        .map_err(|_| "the portal did not answer".to_string())?
        .map_err(|e| format!("no GlobalShortcuts portal on this desktop: {e}"))?;
    let version = proxy.version();
    super::set_portal_version(&app, version);

    let session = tokio::time::timeout(QUICK, proxy.create_session(Default::default()))
        .await
        .map_err(|_| "the portal did not answer the session request".to_string())?
        .map_err(|e| format!("the portal refused a session: {e}"))?;
    let path = session_path(&session);

    // Remembered bindings. Informational: the bind below is what counts.
    let remembered = match tokio::time::timeout(QUICK, proxy.list_shortcuts(&session, Default::default())).await {
        Ok(Ok(request)) => match request.response() {
            Ok(list) => list.shortcuts().iter().any(|s| s.id() == SHORTCUT_ID),
            Err(e) => {
                eprintln!("hotkey: ListShortcuts failed ({e}); assuming nothing is remembered");
                false
            }
        },
        Ok(Err(e)) => {
            eprintln!("hotkey: ListShortcuts failed ({e}); assuming nothing is remembered");
            false
        }
        Err(_) => {
            eprintln!("hotkey: ListShortcuts did not answer; assuming nothing is remembered");
            false
        }
    };

    // Subscribe before binding: a fast desktop may fire ShortcutsChanged or
    // the first Activated before the bind response is read.
    let activated = proxy.receive_activated().await.map_err(|e| format!("cannot listen for activations: {e}"))?;
    let changed = proxy.receive_shortcuts_changed().await.map_err(|e| format!("cannot listen for shortcut changes: {e}"))?;

    let link = Arc::new(Link { proxy, session });
    if let Ok(mut slot) = app.state::<super::HotkeyState>().link.lock() {
        *slot = Some(link.clone());
    }

    {
        let app = app.clone();
        let path = path.clone();
        tauri::async_runtime::spawn(async move {
            let mut activated = activated;
            while let Some(event) = activated.next().await {
                if event.session_handle().as_str() != path || event.shortcut_id() != SHORTCUT_ID {
                    continue;
                }
                let state = app.state::<crate::window::AppState>();
                crate::window::summon(app.clone(), state);
            }
        });
    }
    {
        let app = app.clone();
        let path = path.clone();
        tauri::async_runtime::spawn(async move {
            let mut changed = changed;
            while let Some(event) = changed.next().await {
                if event.session_handle().as_str() != path {
                    continue;
                }
                super::apply_portal_event(&app, PortalEvent::Changed(bound(event.shortcuts())));
            }
        });
    }
    {
        // The Closed stream borrows the session, so it is opened by the task
        // that owns a handle to it.
        let app = app.clone();
        let link = link.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(mut closed) = link.session.receive_closed().await else { return };
            if closed.next().await.is_some() {
                super::apply_portal_event(&app, PortalEvent::Closed("the desktop closed the session".into()));
            }
        });
    }

    super::apply_portal_event(&app, PortalEvent::Requested { remembered });
    let shortcut = NewShortcut::new(SHORTCUT_ID, DESCRIPTION).preferred_trigger(preferred.as_deref());
    let request = link
        .proxy
        .bind_shortcuts(&link.session, &[shortcut], None, Default::default())
        .await
        .map_err(|e| format!("BindShortcuts failed: {e}"))?;
    match request.response() {
        Ok(response) => super::apply_portal_event(&app, PortalEvent::Bound(bound(response.shortcuts()))),
        Err(ashpd::Error::Response(ResponseError::Cancelled)) => super::apply_portal_event(&app, PortalEvent::Cancelled),
        Err(e) => return Err(format!("BindShortcuts was refused: {e}")),
    }
    Ok(())
}

/// The portal identifies a host app by a `<app id>.desktop` file. Packaged
/// installs ship one; a build run from the tree has none, so a hidden entry
/// is written to the user's applications directory. `Ok(Some(path))` when
/// one was written, `Ok(None)` when one already exists anywhere XDG looks.
fn ensure_desktop_entry(app: &AppHandle) -> Result<Option<std::path::PathBuf>, String> {
    let name = format!("{APP_ID}.desktop");
    let user_dir = app.path().data_dir().map_err(|e| e.to_string())?.join("applications");
    let mut dirs = vec![user_dir.clone()];
    let system = std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
    dirs.extend(system.split(':').filter(|d| !d.is_empty()).map(|d| std::path::PathBuf::from(d).join("applications")));
    if dirs.iter().any(|d| d.join(&name).is_file()) {
        return Ok(None);
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let entry = desktop_entry(&exe.display().to_string());
    std::fs::create_dir_all(&user_dir).map_err(|e| e.to_string())?;
    let path = user_dir.join(name);
    std::fs::write(&path, entry).map_err(|e| e.to_string())?;
    Ok(Some(path))
}

fn desktop_entry(exec: &str) -> String {
    // NoDisplay: this entry exists for the portal's lookup, not for the app
    // grid. Exec is still filled in, because the desktop may show or launch
    // the app from its shortcut settings.
    format!(
        "[Desktop Entry]\nType=Application\nName=Peekaboo\nComment=Keyboard-summoned AI overlay\nExec={exec}\nNoDisplay=true\nStartupNotify=false\nX-Peekaboo-Generated=true\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_desktop_entry_is_hidden_and_launches_this_binary() {
        let entry = desktop_entry("/opt/peekaboo/peekaboo-app");
        assert!(entry.starts_with("[Desktop Entry]\n"));
        assert!(entry.contains("Exec=/opt/peekaboo/peekaboo-app\n"));
        assert!(entry.contains("NoDisplay=true\n"));
        assert!(entry.contains("Name=Peekaboo\n"));
    }

    #[test]
    fn the_app_id_is_a_valid_portal_app_id() {
        assert!(ashpd::AppID::try_from(APP_ID).is_ok());
    }
}
