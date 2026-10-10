/**
 * The summon hotkey as Rust stores it ("Ctrl+Alt+Space": modifiers in a fixed
 * order, then the key's W3C `KeyboardEvent.code`), turned into something to
 * show, and a KeyboardEvent turned back into that spelling for the recorder.
 */

export type HotkeyPlatform = 'linux' | 'windows' | 'macos';

export function detectPlatform(): HotkeyPlatform {
  if (typeof navigator === 'undefined') return 'linux';
  const ua = `${navigator.platform} ${navigator.userAgent}`;
  if (/Mac|iPhone|iPad/i.test(ua)) return 'macos';
  if (/Win/i.test(ua)) return 'windows';
  return 'linux';
}

/** Mirrors `hotkey::default_for` in lib.rs; used only until Rust has answered. */
export function defaultHotkeyFor(platform: HotkeyPlatform): string {
  return platform === 'macos' ? 'Alt+Space' : 'Ctrl+Alt+Space';
}

const MODIFIER_LABELS: Record<HotkeyPlatform, Record<string, string>> = {
  linux: { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Super: 'Super' },
  windows: { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Super: 'Win' },
  macos: { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Super: '⌘' },
};

const KEY_LABELS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Del',
  Insert: 'Ins',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  CapsLock: 'Caps Lock',
  PrintScreen: 'PrtSc',
  ScrollLock: 'Scroll Lock',
  NumLock: 'Num Lock',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
  NumpadEnter: 'Num Enter',
  NumpadEqual: 'Num =',
};

function keyLabel(code: string): string {
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  const numpad = /^Numpad(\d)$/.exec(code);
  if (numpad) return `Num ${numpad[1]}`;
  return code;
}

/** Each part of the chord as the user should read it, modifiers first. */
export function hotkeyParts(hotkey: string, platform: HotkeyPlatform = detectPlatform()): string[] {
  const tokens = hotkey.split('+').map((t) => t.trim()).filter(Boolean);
  const labels = MODIFIER_LABELS[platform];
  return tokens.map((token) => labels[token] ?? keyLabel(token));
}

/** "Ctrl+Alt+Space" on Linux and Windows, "⌥Space" on a Mac. */
export function formatHotkey(hotkey: string, platform: HotkeyPlatform = detectPlatform()): string {
  return hotkeyParts(hotkey, platform).join(platform === 'macos' ? '' : '+');
}

/**
 * Quit is the one overlay binding that is not Alt+letter, because every
 * letter that reads as "quit" is taken (Alt+Q stops the response). Ctrl+Q is
 * the desktop convention on Linux and Windows, ⌘Q on a Mac.
 */
export function quitHotkey(platform: HotkeyPlatform = detectPlatform()): string {
  return platform === 'macos' ? 'Super+Q' : 'Ctrl+Q';
}

export function isQuitChord(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return e.key.toLowerCase() === 'q' && (e.ctrlKey || e.metaKey) && !e.altKey;
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

export type RecordedChord =
  /** Only modifiers are down so far; keep waiting for the main key. */
  | { kind: 'pending'; mods: string[] }
  /** A key without any modifier, which the backend would refuse anyway. */
  | { kind: 'unmodified' }
  | { kind: 'chord'; chord: string };

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'AltGraph', 'Shift', 'Meta', 'OS', 'Super', 'Hyper', 'Fn']);

/** What one keydown means to the recorder. Pure, so it is testable without a DOM. */
export function chordFromKeyboardEvent(e: KeyLike): RecordedChord {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');

  if (MODIFIER_KEYS.has(e.key) || /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(e.code)) {
    return { kind: 'pending', mods };
  }
  if (mods.length === 0) return { kind: 'unmodified' };
  return { kind: 'chord', chord: [...mods, e.code].join('+') };
}
