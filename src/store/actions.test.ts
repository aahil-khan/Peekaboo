import { describe, it, expect, beforeAll } from 'vitest';
import { BUILTIN_ACTIONS } from '../lib/actions';

/**
 * zustand's persist middleware reads `window.localStorage`. The tests run in
 * Node, so a minimal window with an in-memory Storage is installed before the
 * store module loads (the store also registers a `storage` listener on it).
 */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(key: string) { return this.map.get(key) ?? null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(key: string) { this.map.delete(key); }
  setItem(key: string, value: string) { this.map.set(key, value); }
}

type StoreModule = typeof import('./actions');
let store: StoreModule;

const localStorage = new MemoryStorage();

beforeAll(async () => {
  (globalThis as { window?: unknown }).window = { localStorage, addEventListener: () => {} };
  store = await import('./actions');
});

const fresh = () => store.useActionsStore.setState({ hiddenBuiltIns: [], customActions: [] });

describe('migrateActions', () => {
  it('turns an empty or missing blob into the defaults', () => {
    expect(store.migrateActions(undefined, 0)).toEqual({ hiddenBuiltIns: [], customActions: [] });
    expect(store.migrateActions({}, 0)).toEqual({ hiddenBuiltIns: [], customActions: [] });
    expect(store.migrateActions(null, 0)).toEqual({ hiddenBuiltIns: [], customActions: [] });
    expect(store.migrateActions('garbage', 0)).toEqual({ hiddenBuiltIns: [], customActions: [] });
  });

  it('keeps well-formed data and drops malformed entries', () => {
    const out = store.migrateActions(
      {
        hiddenBuiltIns: ['explain', 42, null],
        customActions: [
          { id: 'a', name: 'Shout', prompt: 'SHOUT {{text}}', kind: 'transform', builtIn: true },
          { id: 'b', name: 'bad kind', prompt: 'x', kind: 'other' },
          { name: 'no id', prompt: 'x', kind: 'answer' },
          null,
        ],
      },
      0
    );
    expect(out.hiddenBuiltIns).toEqual(['explain']);
    expect(out.customActions).toEqual([
      // A custom action is never a built-in, whatever the blob claimed.
      { id: 'a', name: 'Shout', prompt: 'SHOUT {{text}}', kind: 'transform', builtIn: false },
    ]);
  });
});

describe('useActionsStore', () => {
  it('hides and shows a built-in', () => {
    fresh();
    const s = store.useActionsStore.getState();
    const total = BUILTIN_ACTIONS.length;
    expect(store.selectVisibleActions(s)).toHaveLength(total);

    s.hideBuiltIn('explain');
    s.hideBuiltIn('explain'); // idempotent
    let visible = store.selectVisibleActions(store.useActionsStore.getState());
    expect(visible).toHaveLength(total - 1);
    expect(visible.some((a) => a.id === 'explain')).toBe(false);

    s.showBuiltIn('explain');
    visible = store.selectVisibleActions(store.useActionsStore.getState());
    expect(visible).toHaveLength(total);
  });

  it('adds, edits and deletes a custom action', () => {
    fresh();
    const s = store.useActionsStore.getState();
    const added = s.addAction({ name: '  Shout  ', prompt: 'SHOUT: {{text}}', kind: 'transform' });
    expect(added.name).toBe('Shout');
    expect(added.builtIn).toBe(false);
    expect(added.id).toBeTruthy();

    let visible = store.selectVisibleActions(store.useActionsStore.getState());
    expect(visible[visible.length - 1]).toEqual(added);

    s.updateAction(added.id, { name: 'Whisper', prompt: 'whisper: {{text}}', kind: 'answer' });
    const edited = store.useActionsStore.getState().customActions[0];
    expect(edited).toEqual({ ...added, name: 'Whisper', prompt: 'whisper: {{text}}', kind: 'answer' });

    s.deleteAction(added.id);
    expect(store.useActionsStore.getState().customActions).toEqual([]);
    visible = store.selectVisibleActions(store.useActionsStore.getState());
    expect(visible).toHaveLength(BUILTIN_ACTIONS.length);
  });

  it('persists only the user data, under a versioned key', () => {
    fresh();
    store.useActionsStore.getState().hideBuiltIn('summarise');
    const raw = localStorage.getItem('peekaboo-actions');
    expect(raw).toBeTruthy();
    const blob = JSON.parse(raw!);
    expect(blob.version).toBe(store.ACTIONS_STORE_VERSION);
    expect(Object.keys(blob.state).sort()).toEqual(['customActions', 'hiddenBuiltIns']);
  });
});
