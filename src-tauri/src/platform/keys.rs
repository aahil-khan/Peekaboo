//! Key-event sequencing for the paste chord (`Ctrl+V` / `Cmd+V`) Peekaboo
//! synthesises to put a result back.
//!
//! Pure: the OS backends map these events onto XTest, `SendInput` or
//! `CGEvent`. The trap this module exists for is that a chord's modifiers
//! may still be physically held (a user pressing Enter with Ctrl down, a
//! modifier latched after a dialog), so a naive `Ctrl+V` arrives as
//! `Ctrl+Alt+V`. Every held modifier the chord does not want is released
//! first.

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Modifier {
    Shift,
    Control,
    Alt,
    Super,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum KeyEvent<K> {
    Press(K),
    Release(K),
}

/// A modifier-plus-letter chord. `letter` is the unshifted key.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Chord {
    pub modifier: Modifier,
    pub letter: char,
}

impl Chord {
    pub const fn new(modifier: Modifier, letter: char) -> Self {
        Self { modifier, letter }
    }
}

/// The platform's paste chord.
pub fn paste_chord() -> Chord {
    if cfg!(target_os = "macos") {
        Chord::new(Modifier::Super, 'v')
    } else {
        Chord::new(Modifier::Control, 'v')
    }
}

/// The events that make `chord` arrive as itself.
///
/// `held` lists the modifier keys currently down, each with the modifier it
/// stands for (there may be two keys per modifier, left and right).
/// `chord_key` is the key to use for the chord's modifier and `letter_key`
/// the key for its letter.
///
/// - Every held key whose modifier is not the chord's is released first and
///   never pressed again: the physical release will follow on its own, and
///   re-pressing would re-arm whatever shortcut the user was holding.
/// - If the chord's modifier is already held it is neither pressed nor
///   released: the user is holding it and the OS state must stay truthful.
/// - Otherwise it brackets the letter press and release.
pub fn chord_sequence<K: Copy + Eq>(
    held: &[(K, Modifier)],
    chord: Chord,
    chord_key: K,
    letter_key: K,
) -> Vec<KeyEvent<K>> {
    let mut events = Vec::new();
    let mut chord_modifier_held = false;
    for &(key, modifier) in held {
        if modifier == chord.modifier {
            chord_modifier_held = true;
        } else {
            events.push(KeyEvent::Release(key));
        }
    }
    if !chord_modifier_held {
        events.push(KeyEvent::Press(chord_key));
    }
    events.push(KeyEvent::Press(letter_key));
    events.push(KeyEvent::Release(letter_key));
    if !chord_modifier_held {
        events.push(KeyEvent::Release(chord_key));
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use KeyEvent::*;

    const CTRL_C: Chord = Chord::new(Modifier::Control, 'c');

    #[test]
    fn nothing_held_is_the_plain_chord() {
        let seq = chord_sequence::<char>(&[], CTRL_C, 'C', 'c');
        assert_eq!(seq, vec![Press('C'), Press('c'), Release('c'), Release('C')]);
    }

    #[test]
    fn other_held_modifiers_are_released_first() {
        // Ctrl+Alt still down, as after the summon chord.
        let held = [('C', Modifier::Control), ('A', Modifier::Alt)];
        let seq = chord_sequence(&held, CTRL_C, 'C', 'c');
        assert_eq!(seq, vec![Release('A'), Press('c'), Release('c')]);
    }

    #[test]
    fn a_held_chord_modifier_is_left_alone() {
        let held = [('C', Modifier::Control)];
        let seq = chord_sequence(&held, CTRL_C, 'C', 'c');
        assert_eq!(seq, vec![Press('c'), Release('c')], "no press and no release of a key the user holds");
    }

    #[test]
    fn both_shift_keys_and_super_are_released() {
        let held = [('L', Modifier::Shift), ('R', Modifier::Shift), ('S', Modifier::Super)];
        let seq = chord_sequence(&held, Chord::new(Modifier::Super, 'v'), 'S', 'v');
        assert_eq!(seq, vec![Release('L'), Release('R'), Press('v'), Release('v')]);
    }

    #[test]
    fn released_modifiers_are_never_pressed_again() {
        let held = [('A', Modifier::Alt)];
        let seq = chord_sequence(&held, paste_chord(), 'M', 'v');
        assert!(!seq.contains(&Press('A')));
        assert_eq!(seq.first(), Some(&Release('A')));
    }

    #[test]
    fn the_paste_chord_follows_the_platform() {
        if cfg!(target_os = "macos") {
            assert_eq!(paste_chord(), Chord::new(Modifier::Super, 'v'));
        } else {
            assert_eq!(paste_chord(), Chord::new(Modifier::Control, 'v'));
        }
    }
}
