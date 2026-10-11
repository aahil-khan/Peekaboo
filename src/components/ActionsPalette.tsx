import React, { useEffect, useRef, useState } from 'react';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import {
  KIND_LABELS,
  clampSelection,
  groupActions,
  moveSelection,
  previewText,
  type Action,
} from '../lib/actions';

/**
 * The actions palette: the list of things Peekaboo can do to the text in
 * front of the user.
 *
 * It renders in flow under the attachment chips, in the same row idiom as the
 * `/` menu, so the window grows to fit it. The text box above stays focused
 * and doubles as the filter: the parent passes the already-filtered list and
 * hides the palette when nothing matches, which is what keeps Enter free for
 * a typed question. Keys are taken in the capture phase, the way the History
 * panel does it, so they never reach the textarea or the global bindings.
 */

/** The text an action will run on, and where it came from. */
export interface ActionSource {
  origin: 'attachment' | 'clipboard';
  label: string;
  text: string;
}

interface ActionsPaletteProps {
  /** Whether to render at all. */
  open: boolean;
  /** Opened by Alt+A or the footer rather than by attached text: show empty
   *  states instead of vanishing, and fall back to the clipboard. */
  explicit: boolean;
  /** Already filtered by the parent against the typed query. */
  actions: Action[];
  /** The typed filter, for resetting the selection when it changes. */
  query: string;
  /** Text attached to the message, if any. Null means "try the clipboard". */
  attachedText: ActionSource | null;
  onRun: (action: Action, source: ActionSource) => void;
  onClose: () => void;
}

type ClipboardState =
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'empty' };

function sourceIcon(origin: ActionSource['origin'], label: string): string {
  if (origin === 'clipboard') return '⎘';
  if (/clip/i.test(label)) return '⎘';
  if (/file|\.[a-z0-9]{1,5}$/i.test(label)) return '⊞';
  return '▤';
}

export const ActionsPalette: React.FC<ActionsPaletteProps> = ({
  open,
  explicit,
  actions,
  query,
  attachedText,
  onRun,
  onClose,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [clipboard, setClipboard] = useState<ClipboardState>({ status: 'loading' });

  // Without attached text the palette acts on the clipboard. Read it each
  // time the palette opens, never while it is open: the preview must describe
  // what Enter will act on, and must not change under the user's hands.
  //
  // This goes straight to the Tauri clipboard plugin, not through the
  // /clipboard context plugin, so it works in a built app where JS plugins
  // may not load. The plugin rejects when the clipboard holds no text (an
  // image, or nothing), which to the user is the same as empty.
  const needsClipboard = open && !attachedText;
  useEffect(() => {
    if (!needsClipboard) return;
    let live = true;
    setClipboard({ status: 'loading' });
    readText()
      .then((text) => {
        if (!live) return;
        setClipboard(typeof text === 'string' && text.trim() ? { status: 'ready', text } : { status: 'empty' });
      })
      .catch((err) => {
        console.warn('Could not read the clipboard:', err);
        if (live) setClipboard({ status: 'empty' });
      });
    return () => {
      live = false;
    };
  }, [needsClipboard]);

  const source: ActionSource | null = attachedText
    ? attachedText
    : clipboard.status === 'ready'
      ? { origin: 'clipboard', label: 'Clipboard', text: clipboard.text }
      : null;

  const groups = groupActions(actions);
  // Flattened in display order so the arrow keys walk the groups as one list.
  const flat = groups.flatMap((g) => g.actions);
  const runnable = !!source && flat.length > 0;

  // A new filter or a fresh open starts at the top; a shrinking list keeps
  // the selection inside it.
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, open]);
  useEffect(() => {
    setSelectedIndex((i) => clampSelection(i, flat.length));
  }, [flat.length]);

  useEffect(() => {
    if (!open) return;
    const selected = listRef.current?.querySelector('[aria-selected="true"]');
    selected?.scrollIntoView({ block: 'nearest' });
  }, [open, selectedIndex, flat.length]);

  // Keyboard, in the capture phase so the textarea never sees these keys.
  // Only the four keys the palette owns are taken; typing still reaches the
  // input, which is how the filter works.
  const stateRef = useRef({ runnable, flat, selectedIndex, source, onRun, onClose });
  stateRef.current = { runnable, flat, selectedIndex, source, onRun, onClose };
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const s = stateRef.current;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        s.onClose();
        return;
      }
      if (!s.runnable) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((i) => moveSelection(i, e.key === 'ArrowDown' ? 1 : -1, s.flat.length));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const action = s.flat[s.selectedIndex];
        if (action && s.source) {
          e.preventDefault();
          e.stopPropagation();
          s.onRun(action, s.source);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open]);

  if (!open) return null;

  const sourceRow = (() => {
    if (source) {
      const chars = source.text.length;
      return (
        <>
          <span className="peek-actions-source-label">Act on</span>
          <span className="peek-actions-source-name">
            <span aria-hidden="true">{sourceIcon(source.origin, source.label)}</span> {source.label}
          </span>
          <span className="peek-actions-source-preview" title={previewText(source.text, 400)}>
            {previewText(source.text)}
          </span>
          <span className="peek-actions-source-meta">{chars.toLocaleString()} chars</span>
        </>
      );
    }
    if (clipboard.status === 'loading') {
      return <span className="peek-actions-source-label">Reading the clipboard…</span>;
    }
    return (
      <span className="peek-actions-source-empty">
        Nothing to act on. Select text before summoning Peekaboo, or copy some first.
      </span>
    );
  })();

  let flatIndex = -1;

  return (
    <div className="peek-actions" ref={listRef}>
      <div className="peek-actions-source">
        {sourceRow}
        <span className="peek-panel-spacer" />
        <span className="peek-panel-esc">{runnable ? '↑↓ ↵ · esc' : 'esc'}</span>
      </div>

      {flat.length === 0 ? (
        <div className="peek-slash-empty">
          {explicit && query.trim()
            ? 'No matching action. Enter sends your question as typed.'
            : 'No actions. Add some in Settings → Actions.'}
        </div>
      ) : (
        <div className="peek-actions-list" role="listbox" aria-label="Actions" aria-disabled={!runnable || undefined}>
          {groups.map((group) => (
            <React.Fragment key={group.kind}>
              <div className="peek-slash-group">{group.label}</div>
              {group.actions.map((action) => {
                flatIndex += 1;
                const idx = flatIndex;
                return (
                  <button
                    key={action.id}
                    type="button"
                    role="option"
                    aria-selected={runnable && idx === selectedIndex}
                    disabled={!runnable}
                    className="peek-slash-item peek-actions-item"
                    onMouseEnter={() => setSelectedIndex(idx)}
                    onClick={() => {
                      if (source) onRun(action, source);
                    }}
                  >
                    <span className="peek-slash-item-title">{action.name}</span>
                    {!action.builtIn && <span className="peek-actions-yours">yours</span>}
                    <span className="peek-slash-item-subtitle">{KIND_LABELS[action.kind]}</span>
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
};
