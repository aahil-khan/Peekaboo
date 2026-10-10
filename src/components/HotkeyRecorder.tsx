import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useHotkeyStore } from '../store/hotkey';
import { chordFromKeyboardEvent, formatHotkey, hotkeyParts } from '../lib/hotkey';

/**
 * The "Summon hotkey" control in Settings. Click (or press Enter on) the chord
 * to start recording, press a combination, and it is sent to Rust, which
 * re-registers it with the OS and reports back. The old chord keeps working
 * if the new one is refused, and the reason is shown underneath.
 */
export const HotkeyRecorder: React.FC = () => {
  const { hotkey, defaultHotkey, error: startupError, set, reset } = useHotkeyStore();
  const [recording, setRecording] = useState(false);
  const [pendingMods, setPendingMods] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const stopRecording = useCallback(() => {
    setRecording(false);
    setPendingMods([]);
  }, []);

  const commit = useCallback(async (chord: string) => {
    stopRecording();
    setBusy(true);
    setFailure(await set(chord));
    setBusy(false);
  }, [set, stopRecording]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    // Stop here: Enter and Space would re-click the button, and Escape would
    // close the whole Settings window.
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      stopRecording();
      return;
    }
    const result = chordFromKeyboardEvent(e);
    if (result.kind === 'pending') {
      setPendingMods(result.mods);
      return;
    }
    if (result.kind === 'unmodified') {
      setFailure('Add at least one modifier (Ctrl, Alt, Shift or Super).');
      return;
    }
    void commit(result.chord);
  };

  // Leaving the control mid-recording should not leave it armed.
  useEffect(() => {
    if (!recording) return;
    const onBlur = () => stopRecording();
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [recording, stopRecording]);

  const showing = recording
    ? pendingMods.length > 0
      ? `${hotkeyParts(pendingMods.join('+')).join(' + ')} + …`
      : 'Press a key combination'
    : formatHotkey(hotkey);

  return (
    <>
      <div className="peek-settings-row">
        <span className="peek-settings-rowtext">
          <span className="peek-settings-label">Summon hotkey</span>
          <span className="peek-settings-desc">
            Works from any app. Click the key, then press the combination you want.
            {recording && ' Esc cancels.'}
          </span>
        </span>
        <span className="peek-hotkey-controls">
          {hotkey !== defaultHotkey && !recording && (
            <button
              className="peek-btn peek-btn--sm"
              disabled={busy}
              onClick={async () => { setBusy(true); setFailure(await reset()); setBusy(false); }}
            >
              Reset to {formatHotkey(defaultHotkey)}
            </button>
          )}
          <button
            ref={buttonRef}
            type="button"
            className="peek-hotkey-recorder"
            data-recording={recording ? 'true' : undefined}
            aria-live="polite"
            aria-label={recording ? 'Recording. Press the new summon hotkey, or Escape to cancel.' : `Summon hotkey is ${formatHotkey(hotkey)}. Activate to change it.`}
            disabled={busy}
            onClick={() => {
              if (recording) return;
              setFailure(null);
              setRecording(true);
            }}
            onKeyDown={handleKeyDown}
            onBlur={stopRecording}
          >
            {showing}
          </button>
        </span>
      </div>
      {(failure || startupError) && (
        <span className={failure ? 'peek-settings-desc peek-tone-error' : 'peek-settings-desc peek-tone-warn'} role="status">
          {failure ?? startupError}
        </span>
      )}
    </>
  );
};
