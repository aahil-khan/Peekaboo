//! The chord as Peekaboo stores it ("Ctrl+Alt+Space": fixed modifier order,
//! then the key's W3C code name) to and from the GlobalShortcuts portal's
//! trigger strings.
//!
//! Outgoing, the portal takes a *preferred trigger* in the freedesktop
//! "shortcuts" format: modifiers `CTRL`, `ALT`, `SHIFT`, `LOGO`, then an xkb
//! keysym name, joined with `+` (`CTRL+ALT+space`). The desktop may honour it,
//! change it, or ignore it.
//!
//! Incoming, the portal reports what was actually bound only as a
//! `trigger_description`: free text "for the client to render". Desktops
//! differ: the shortcuts format again, GTK accelerator syntax
//! (`<Control><Alt>space`), or a human label (`Ctrl+Alt+Space`, `Meta+Space`
//! on KDE). `chord_from_description` recognises all three so the legend can
//! show the real binding; when it cannot, the caller shows the text as is.

/// W3C code name, xkb keysym name, extra spellings a description may use.
/// Letters, digits, function keys and the numpad digits are generated.
const KEYS: &[(&str, &str, &[&str])] = &[
    ("Space", "space", &["Space", "Spacebar"]),
    ("Enter", "Return", &["Enter", "Ret"]),
    ("Tab", "Tab", &[]),
    ("Escape", "Escape", &["Esc"]),
    ("Backspace", "BackSpace", &["Backspace"]),
    ("Delete", "Delete", &["Del"]),
    ("Insert", "Insert", &["Ins"]),
    ("Home", "Home", &[]),
    ("End", "End", &[]),
    ("PageUp", "Prior", &["Page_Up", "PgUp", "PageUp"]),
    ("PageDown", "Next", &["Page_Down", "PgDn", "PageDown"]),
    ("ArrowUp", "Up", &["ArrowUp"]),
    ("ArrowDown", "Down", &["ArrowDown"]),
    ("ArrowLeft", "Left", &["ArrowLeft"]),
    ("ArrowRight", "Right", &["ArrowRight"]),
    ("Comma", "comma", &[","]),
    ("Period", "period", &["."]),
    ("Slash", "slash", &["/"]),
    ("Backslash", "backslash", &["\\"]),
    ("Semicolon", "semicolon", &[";"]),
    ("Quote", "apostrophe", &["'"]),
    ("Backquote", "grave", &["`"]),
    ("Minus", "minus", &["-"]),
    ("Equal", "equal", &["="]),
    ("BracketLeft", "bracketleft", &["["]),
    ("BracketRight", "bracketright", &["]"]),
    ("CapsLock", "Caps_Lock", &["CapsLock"]),
    ("PrintScreen", "Print", &["PrintScreen", "PrtSc"]),
    ("ScrollLock", "Scroll_Lock", &["ScrollLock"]),
    ("NumLock", "Num_Lock", &["NumLock"]),
    ("Pause", "Pause", &[]),
    ("ContextMenu", "Menu", &["ContextMenu"]),
    ("NumpadAdd", "KP_Add", &["NumpadAdd"]),
    ("NumpadSubtract", "KP_Subtract", &["NumpadSubtract"]),
    ("NumpadMultiply", "KP_Multiply", &["NumpadMultiply"]),
    ("NumpadDivide", "KP_Divide", &["NumpadDivide"]),
    ("NumpadDecimal", "KP_Decimal", &["NumpadDecimal"]),
    ("NumpadEnter", "KP_Enter", &["NumpadEnter"]),
    ("NumpadEqual", "KP_Equal", &["NumpadEqual"]),
    ("AudioVolumeDown", "XF86AudioLowerVolume", &[]),
    ("AudioVolumeUp", "XF86AudioRaiseVolume", &[]),
    ("AudioVolumeMute", "XF86AudioMute", &[]),
    ("MediaPlayPause", "XF86AudioPlay", &[]),
];

/// The keysym name for one W3C code, or `None` if the key has none.
pub fn keysym_for_code(code: &str) -> Option<String> {
    if let Some(letter) = code.strip_prefix("Key").filter(|l| l.len() == 1 && l.chars().all(|c| c.is_ascii_uppercase())) {
        // Base layer, as the spec asks: unshifted letters are lower case.
        return Some(letter.to_ascii_lowercase());
    }
    if let Some(digit) = code.strip_prefix("Digit").filter(|d| d.len() == 1 && d.chars().all(|c| c.is_ascii_digit())) {
        return Some(digit.to_string());
    }
    if let Some(digit) = code.strip_prefix("Numpad").filter(|d| d.len() == 1 && d.chars().all(|c| c.is_ascii_digit())) {
        return Some(format!("KP_{digit}"));
    }
    if let Some(n) = code.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()).filter(|n| (1..=24).contains(n)) {
        return Some(format!("F{n}"));
    }
    KEYS.iter().find(|(c, _, _)| *c == code).map(|(_, k, _)| (*k).to_string())
}

/// The W3C code for one key as a description may spell it: a keysym name, a
/// code name, a human label or the character itself. Case-insensitive.
pub fn code_for_key(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphabetic() {
            return Some(format!("Key{}", c.to_ascii_uppercase()));
        }
        if c.is_ascii_digit() {
            return Some(format!("Digit{c}"));
        }
    }
    if let Some(d) = name.strip_prefix("KP_").filter(|d| d.len() == 1 && d.chars().all(|c| c.is_ascii_digit())) {
        return Some(format!("Numpad{d}"));
    }
    if let Some(n) = name.strip_prefix(['F', 'f']).and_then(|n| n.parse::<u8>().ok()).filter(|n| (1..=24).contains(n)) {
        return Some(format!("F{n}"));
    }
    let lower = name.to_ascii_lowercase();
    KEYS.iter()
        .find(|(code, keysym, extra)| {
            code.eq_ignore_ascii_case(name)
                || keysym.eq_ignore_ascii_case(name)
                || extra.iter().any(|e| e.to_ascii_lowercase() == lower)
        })
        .map(|(code, _, _)| (*code).to_string())
}

/// `Ctrl+Alt+Space` -> `CTRL+ALT+space`. `None` when the key has no keysym
/// the portal could be asked for.
pub fn preferred_trigger(chord: &str) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut key: Option<String> = None;
    for token in chord.split('+').map(str::trim).filter(|t| !t.is_empty()) {
        match token {
            "Ctrl" => parts.push("CTRL".into()),
            "Alt" => parts.push("ALT".into()),
            "Shift" => parts.push("SHIFT".into()),
            "Super" => parts.push("LOGO".into()),
            other => key = Some(keysym_for_code(other)?),
        }
    }
    parts.push(key?);
    Some(parts.join("+"))
}

fn modifier(token: &str) -> Option<&'static str> {
    match token.to_ascii_lowercase().as_str() {
        "ctrl" | "control" | "primary" | "ctl" => Some("Ctrl"),
        "alt" | "mod1" | "option" => Some("Alt"),
        "shift" | "shft" => Some("Shift"),
        "logo" | "super" | "meta" | "win" | "mod4" | "cmd" | "command" => Some("Super"),
        _ => None,
    }
}

/// Tokens of a description in any of the three syntaxes, modifiers and key
/// alike, in order.
fn tokens(description: &str) -> Vec<String> {
    let text = description.trim();
    // GTK accelerator syntax: "<Control><Alt>space".
    if text.starts_with('<') {
        let mut out = Vec::new();
        let mut rest = text;
        while let Some(stripped) = rest.strip_prefix('<') {
            let Some(end) = stripped.find('>') else { break };
            out.push(stripped[..end].to_string());
            rest = &stripped[end + 1..];
        }
        if !rest.is_empty() {
            out.push(rest.to_string());
        }
        return out;
    }
    // "+" joins both the shortcuts format and human labels. A trailing "+"
    // or "++" means the key itself is "+".
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '+' && (!current.is_empty() || i + 1 == chars.len()) {
            if current.is_empty() {
                current.push('+');
            }
            out.push(std::mem::take(&mut current));
        } else if c == '+' {
            current.push('+');
            i += 1;
            continue;
        } else if !c.is_whitespace() {
            current.push(c);
        }
        i += 1;
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// The canonical chord a `trigger_description` denotes, if it is one
/// Peekaboo's parser would accept (a modifier plus a known key).
pub fn chord_from_description(description: &str) -> Option<String> {
    let text = description.trim();
    // Some desktops prefix a verb ("Press Ctrl+Alt+Space").
    let text = text.strip_prefix("Press ").unwrap_or(text).trim();
    let parts = tokens(text);
    if parts.len() < 2 {
        return None;
    }
    let (mods, key) = parts.split_at(parts.len() - 1);
    let mut ctrl = false;
    let mut alt = false;
    let mut shift = false;
    let mut sup = false;
    for m in mods {
        match modifier(m)? {
            "Ctrl" => ctrl = true,
            "Alt" => alt = true,
            "Shift" => shift = true,
            _ => sup = true,
        }
    }
    let code = code_for_key(&key[0])?;
    let mut out: Vec<&str> = Vec::new();
    if ctrl {
        out.push("Ctrl");
    }
    if alt {
        out.push("Alt");
    }
    if shift {
        out.push("Shift");
    }
    if sup {
        out.push("Super");
    }
    out.push(&code);
    Some(out.join("+"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chords_become_spec_triggers() {
        assert_eq!(preferred_trigger("Ctrl+Alt+Space").as_deref(), Some("CTRL+ALT+space"));
        assert_eq!(preferred_trigger("Alt+Space").as_deref(), Some("ALT+space"));
        assert_eq!(preferred_trigger("Shift+Super+KeyK").as_deref(), Some("SHIFT+LOGO+k"));
        assert_eq!(preferred_trigger("Ctrl+Shift+Digit1").as_deref(), Some("CTRL+SHIFT+1"));
        assert_eq!(preferred_trigger("Ctrl+F12").as_deref(), Some("CTRL+F12"));
        assert_eq!(preferred_trigger("Ctrl+Numpad5").as_deref(), Some("CTRL+KP_5"));
        assert_eq!(preferred_trigger("Ctrl+Alt+Enter").as_deref(), Some("CTRL+ALT+Return"));
        assert_eq!(preferred_trigger("Ctrl+Backquote").as_deref(), Some("CTRL+grave"));
        assert_eq!(preferred_trigger("Ctrl+PageUp").as_deref(), Some("CTRL+Prior"));
    }

    #[test]
    fn unknown_keys_have_no_trigger() {
        assert_eq!(preferred_trigger("Ctrl+Nope"), None);
        assert_eq!(preferred_trigger("Ctrl+Alt"), None);
        assert_eq!(preferred_trigger(""), None);
    }

    #[test]
    fn every_stored_chord_round_trips_through_the_spec_format() {
        for chord in ["Ctrl+Alt+Space", "Alt+Space", "Shift+Super+KeyK", "Ctrl+Shift+Digit1", "Ctrl+F9", "Ctrl+Alt+ArrowUp", "Ctrl+Numpad0", "Ctrl+Alt+Comma"] {
            let trigger = preferred_trigger(chord).unwrap();
            assert_eq!(chord_from_description(&trigger).as_deref(), Some(chord), "{chord} via {trigger}");
        }
    }

    #[test]
    fn gtk_accelerator_descriptions_parse() {
        assert_eq!(chord_from_description("<Control><Alt>space").as_deref(), Some("Ctrl+Alt+Space"));
        assert_eq!(chord_from_description("<Super><Shift>k").as_deref(), Some("Shift+Super+KeyK"));
        assert_eq!(chord_from_description("<Primary>F9").as_deref(), Some("Ctrl+F9"));
        assert_eq!(chord_from_description("Press <Control><Alt>space").as_deref(), Some("Ctrl+Alt+Space"));
        assert_eq!(chord_from_description("<Alt>Return").as_deref(), Some("Alt+Enter"));
    }

    #[test]
    fn human_descriptions_parse() {
        assert_eq!(chord_from_description("Ctrl+Alt+Space").as_deref(), Some("Ctrl+Alt+Space"));
        assert_eq!(chord_from_description("Meta+Space").as_deref(), Some("Super+Space"));
        assert_eq!(chord_from_description("Ctrl + Shift + K").as_deref(), Some("Ctrl+Shift+KeyK"));
        assert_eq!(chord_from_description("Alt+Esc").as_deref(), Some("Alt+Escape"));
        assert_eq!(chord_from_description("Ctrl+Alt+1").as_deref(), Some("Ctrl+Alt+Digit1"));
        assert_eq!(chord_from_description("Ctrl+PgUp").as_deref(), Some("Ctrl+PageUp"));
        assert_eq!(chord_from_description("Ctrl+Alt++").as_deref(), None, "a bare plus is not a key Peekaboo knows");
    }

    #[test]
    fn modifier_order_is_canonical_whatever_the_desktop_said() {
        assert_eq!(chord_from_description("ALT+CTRL+space").as_deref(), Some("Ctrl+Alt+Space"));
        assert_eq!(chord_from_description("<Shift><Super>k").as_deref(), Some("Shift+Super+KeyK"));
    }

    #[test]
    fn descriptions_that_are_not_chords_are_left_alone() {
        for text in ["", "Not bound", "space", "Ctrl+", "Hyper+space", "<Control>", "Ctrl+Alt+NoSuchKey", "Press the thing"] {
            assert_eq!(chord_from_description(text), None, "{text:?}");
        }
    }
}
