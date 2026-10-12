//! What the hotkey is doing right now, as one pure state machine, and the
//! report Settings gets from it.
//!
//! Two things are tracked side by side: the OS grab (`Native`) and the
//! GlobalShortcuts portal (`PortalPhase`). The portal has the last word when
//! it granted a binding; otherwise the grab is what the user has, and the
//! report says what the portal said and what to do about it.

use super::trigger;

/// One shortcut the portal reported as bound.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bound {
    pub id: String,
    pub trigger_description: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortalPhase {
    /// Not asked on this session (an X11 session, Windows, macOS).
    NotApplicable(String),
    /// A session is open and `BindShortcuts` has been sent. The desktop may
    /// be showing its consent dialog; `remembered` says it already listed
    /// our shortcut from an earlier run, so no dialog is expected.
    Requested { remembered: bool },
    /// The desktop bound a key and delivers activations.
    Granted { trigger_description: String },
    /// The desktop or the user bound nothing for Peekaboo.
    Declined(String),
    /// The portal is missing, or failed before the question was asked.
    Unavailable(String),
    /// Was granted, then the portal closed the session.
    Lost(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortalEvent {
    Requested { remembered: bool },
    /// `BindShortcuts` answered: the shortcuts the desktop bound (maybe none).
    Bound(Vec<Bound>),
    /// The request was cancelled in the system dialog.
    Cancelled,
    /// Anything that stopped the portal path with an error.
    Failed(String),
    /// `ShortcutsChanged`: the desktop changed or removed the binding.
    Changed(Vec<Bound>),
    /// The session was closed by the portal.
    Closed(String),
}

impl PortalPhase {
    pub fn apply(self, event: PortalEvent, shortcut_id: &str) -> PortalPhase {
        let ours = |list: &[Bound]| list.iter().find(|b| b.id == shortcut_id).map(|b| b.trigger_description.clone());
        match event {
            PortalEvent::Requested { remembered } => PortalPhase::Requested { remembered },
            PortalEvent::Bound(list) => match ours(&list) {
                Some(trigger_description) => PortalPhase::Granted { trigger_description },
                None => PortalPhase::Declined("the desktop bound no key for Peekaboo".into()),
            },
            PortalEvent::Cancelled => PortalPhase::Declined("the request was cancelled in the system dialog".into()),
            PortalEvent::Failed(reason) | PortalEvent::Closed(reason) => match self {
                PortalPhase::Granted { .. } => PortalPhase::Lost(reason),
                _ => PortalPhase::Unavailable(reason),
            },
            PortalEvent::Changed(list) => match (self, ours(&list)) {
                (PortalPhase::Granted { .. } | PortalPhase::Requested { .. }, Some(trigger_description)) => {
                    PortalPhase::Granted { trigger_description }
                }
                (PortalPhase::Granted { .. }, None) => PortalPhase::Declined("the key was removed in the system settings".into()),
                (other, _) => other,
            },
        }
    }

    pub fn is_granted(&self) -> bool {
        matches!(self, PortalPhase::Granted { .. })
    }

    pub fn name(&self) -> &'static str {
        match self {
            PortalPhase::NotApplicable(_) => "not-applicable",
            PortalPhase::Requested { .. } => "requested",
            PortalPhase::Granted { .. } => "granted",
            PortalPhase::Declined(_) => "declined",
            PortalPhase::Unavailable(_) => "unavailable",
            PortalPhase::Lost(_) => "lost",
        }
    }
}

/// The OS grab: what is grabbed right now (canonical chord), or why not.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Native {
    pub active: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// The chord the user configured (saved, or the default).
    pub configured: String,
    pub default: String,
    pub native: Native,
    pub portal: PortalPhase,
    /// The portal interface version; `ConfigureShortcuts` needs 2.
    pub portal_version: u32,
    /// Whether the X11 grab, when it holds, fires from every app: true on an
    /// X11 session, false on Wayland (X11 apps only).
    pub grab_is_global: bool,
}

/// What the frontend gets from `get_hotkey`. `hotkey`, `default` and `error`
/// predate the portal and keep their meaning; the rest says who owns the key.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyInfo {
    /// The chord in effect, canonical: the desktop's binding when the portal
    /// granted one and it reads as a chord, otherwise the grabbed chord.
    pub hotkey: String,
    pub default: String,
    /// Why the grab is not the user's chord (or not there at all). Null when
    /// the portal owns the key.
    pub error: Option<String>,
    /// "portal", "native" or "none".
    pub backend: &'static str,
    /// Whether pressing `hotkey` summons Peekaboo right now.
    pub registered: bool,
    /// The desktop owns the binding: no recorder, the system decides.
    pub managed_by_system: bool,
    /// The desktop's own words for the binding, when the portal owns it.
    pub trigger_description: Option<String>,
    pub phase: &'static str,
    /// The desktop offers a configuration UI (`ConfigureShortcuts`).
    pub can_configure: bool,
    /// One or two sentences for Settings about the portal's state.
    pub note: Option<String>,
}

const BIND_YOURSELF: &str = "For a key that works everywhere, bind the `peekaboo-app` command in your desktop's keyboard settings: launching it while Peekaboo runs toggles the overlay.";

fn fallback(snapshot: &Snapshot) -> String {
    match &snapshot.native.active {
        Some(chord) if snapshot.grab_is_global => format!("{chord} is registered through X11 and works from every app."),
        Some(chord) => format!("{chord} works through X11 while an X11 app has focus. {BIND_YOURSELF}"),
        None => BIND_YOURSELF.to_string(),
    }
}

pub fn describe(snapshot: &Snapshot) -> HotkeyInfo {
    let default = snapshot.default.clone();
    match &snapshot.portal {
        PortalPhase::Granted { trigger_description } => {
            let can_configure = snapshot.portal_version >= 2;
            let hotkey = trigger::chord_from_description(trigger_description).unwrap_or_else(|| snapshot.configured.clone());
            let how = if can_configure {
                "Change it with the button here or in your desktop's keyboard settings."
            } else {
                "Change it in your desktop's keyboard settings."
            };
            HotkeyInfo {
                hotkey,
                default,
                error: None,
                backend: "portal",
                registered: true,
                managed_by_system: true,
                trigger_description: Some(trigger_description.clone()),
                phase: "granted",
                can_configure,
                note: Some(format!("On this desktop the summon key is managed by the system. {how}")),
            }
        }
        phase => {
            let registered = snapshot.native.active.is_some();
            let note = match phase {
                PortalPhase::NotApplicable(_) => None,
                PortalPhase::Requested { remembered: false } => Some(format!(
                    "Peekaboo has asked the desktop to bind {} and is waiting for your answer in the system dialog. Until then: {}",
                    snapshot.configured,
                    fallback(snapshot)
                )),
                PortalPhase::Requested { remembered: true } => Some(format!(
                    "Peekaboo is re-binding the key the desktop remembers for it. Until then: {}",
                    fallback(snapshot)
                )),
                PortalPhase::Declined(reason) => Some(format!("The desktop did not bind a key for Peekaboo ({reason}). {}", fallback(snapshot))),
                PortalPhase::Unavailable(reason) => Some(format!("This desktop's GlobalShortcuts portal could not be used ({reason}). {}", fallback(snapshot))),
                PortalPhase::Lost(reason) => Some(format!("The desktop closed Peekaboo's shortcut session ({reason}). {}", fallback(snapshot))),
                PortalPhase::Granted { .. } => unreachable!(),
            };
            HotkeyInfo {
                hotkey: snapshot.native.active.clone().unwrap_or_else(|| snapshot.configured.clone()),
                default,
                error: snapshot.native.error.clone(),
                backend: if registered { "native" } else { "none" },
                registered,
                managed_by_system: false,
                trigger_description: None,
                phase: phase.name(),
                can_configure: false,
                note,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "summon";

    fn bound(trigger: &str) -> Vec<Bound> {
        vec![Bound { id: ID.into(), trigger_description: trigger.into() }]
    }

    fn snapshot(portal: PortalPhase) -> Snapshot {
        Snapshot {
            configured: "Ctrl+Alt+Space".into(),
            default: "Ctrl+Alt+Space".into(),
            native: Native { active: Some("Ctrl+Alt+Space".into()), error: None },
            portal,
            portal_version: 2,
            grab_is_global: false,
        }
    }

    #[test]
    fn requested_then_granted() {
        let phase = PortalPhase::Unavailable("not asked yet".into())
            .apply(PortalEvent::Requested { remembered: false }, ID)
            .apply(PortalEvent::Bound(bound("CTRL+ALT+space")), ID);
        assert_eq!(phase, PortalPhase::Granted { trigger_description: "CTRL+ALT+space".into() });
    }

    #[test]
    fn a_bind_that_leaves_us_out_is_a_decline() {
        let phase = PortalPhase::Requested { remembered: false }.apply(PortalEvent::Bound(vec![]), ID);
        assert!(matches!(phase, PortalPhase::Declined(_)));
        let other = vec![Bound { id: "other".into(), trigger_description: "x".into() }];
        assert!(matches!(PortalPhase::Requested { remembered: false }.apply(PortalEvent::Bound(other), ID), PortalPhase::Declined(_)));
    }

    #[test]
    fn cancelled_dialog_is_a_decline() {
        let phase = PortalPhase::Requested { remembered: false }.apply(PortalEvent::Cancelled, ID);
        assert!(matches!(phase, PortalPhase::Declined(ref r) if r.contains("cancelled")));
    }

    #[test]
    fn failure_before_grant_is_unavailable_and_after_grant_is_lost() {
        assert!(matches!(PortalPhase::Requested { remembered: true }.apply(PortalEvent::Failed("boom".into()), ID), PortalPhase::Unavailable(_)));
        let granted = PortalPhase::Granted { trigger_description: "x".into() };
        assert_eq!(granted.clone().apply(PortalEvent::Closed("gone".into()), ID), PortalPhase::Lost("gone".into()));
        assert_eq!(granted.apply(PortalEvent::Failed("gone".into()), ID), PortalPhase::Lost("gone".into()));
    }

    #[test]
    fn changes_follow_the_desktop() {
        let granted = PortalPhase::Granted { trigger_description: "CTRL+ALT+space".into() };
        assert_eq!(
            granted.clone().apply(PortalEvent::Changed(bound("<Super>space")), ID),
            PortalPhase::Granted { trigger_description: "<Super>space".into() }
        );
        assert!(matches!(granted.apply(PortalEvent::Changed(vec![]), ID), PortalPhase::Declined(_)));
        // A change can also be the first answer we see, before Bound returns.
        assert!(PortalPhase::Requested { remembered: true }.apply(PortalEvent::Changed(bound("x")), ID).is_granted());
        // Changes about other sessions' shortcuts do not move a declined state.
        let declined = PortalPhase::Declined("no".into());
        assert_eq!(declined.clone().apply(PortalEvent::Changed(vec![]), ID), declined);
    }

    #[test]
    fn granted_report_shows_the_desktops_binding() {
        let info = describe(&snapshot(PortalPhase::Granted { trigger_description: "<Super>space".into() }));
        assert_eq!(info.backend, "portal");
        assert!(info.managed_by_system && info.registered && info.can_configure);
        assert_eq!(info.hotkey, "Super+Space", "the legend follows the desktop, not the saved chord");
        assert_eq!(info.trigger_description.as_deref(), Some("<Super>space"));
        assert_eq!(info.error, None);
        assert!(info.note.as_deref().unwrap().contains("managed by the system"));
    }

    #[test]
    fn an_unreadable_binding_keeps_the_configured_chord_and_the_raw_text() {
        let mut snap = snapshot(PortalPhase::Granted { trigger_description: "the thing you set".into() });
        snap.portal_version = 1;
        let info = describe(&snap);
        assert_eq!(info.hotkey, "Ctrl+Alt+Space");
        assert_eq!(info.trigger_description.as_deref(), Some("the thing you set"));
        assert!(!info.can_configure);
        assert!(info.note.as_deref().unwrap().contains("keyboard settings"));
    }

    #[test]
    fn declined_report_falls_back_to_the_grab_and_says_how_to_fix_it() {
        let info = describe(&snapshot(PortalPhase::Declined("cancelled".into())));
        assert_eq!(info.backend, "native");
        assert!(!info.managed_by_system && info.registered);
        assert_eq!(info.hotkey, "Ctrl+Alt+Space");
        let note = info.note.unwrap();
        assert!(note.contains("cancelled") && note.contains("X11 app has focus") && note.contains("peekaboo-app"), "{note}");
    }

    #[test]
    fn no_grab_and_no_portal_is_backend_none_with_the_error() {
        let mut snap = snapshot(PortalPhase::Unavailable("no portal".into()));
        snap.native = Native { active: None, error: Some("Ctrl+Alt+Space could not be registered (no X11 display)".into()) };
        let info = describe(&snap);
        assert_eq!(info.backend, "none");
        assert!(!info.registered);
        assert_eq!(info.hotkey, "Ctrl+Alt+Space");
        assert!(info.error.as_deref().unwrap().contains("could not be registered"));
        assert!(info.note.as_deref().unwrap().contains("peekaboo-app"));
    }

    #[test]
    fn x11_sessions_report_as_before() {
        let mut snap = snapshot(PortalPhase::NotApplicable("X11".into()));
        snap.grab_is_global = true;
        let info = describe(&snap);
        assert_eq!(info.backend, "native");
        assert_eq!(info.phase, "not-applicable");
        assert_eq!(info.note, None);
        assert_eq!(info.error, None);
    }

    #[test]
    fn requested_report_says_a_dialog_is_pending() {
        let info = describe(&snapshot(PortalPhase::Requested { remembered: false }));
        assert_eq!(info.phase, "requested");
        assert!(info.note.as_deref().unwrap().contains("system dialog"));
        let info = describe(&snapshot(PortalPhase::Requested { remembered: true }));
        assert!(info.note.as_deref().unwrap().contains("remembers"));
    }
}
