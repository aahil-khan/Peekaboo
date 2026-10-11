import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { BUILTIN_ACTIONS, type Action, type ActionKind } from '../lib/actions';

/**
 * The user's view of the actions: which built-ins are hidden, and their own.
 *
 * Built-ins are not stored, only their hidden ids, so a later release can
 * improve a built-in prompt and every install picks it up. A user who wants a
 * different prompt duplicates the built-in into their own list.
 */

export interface CustomActionInput {
  name: string;
  prompt: string;
  kind: ActionKind;
}

export interface ActionsPersisted {
  hiddenBuiltIns: string[];
  customActions: Action[];
}

interface ActionsState extends ActionsPersisted {
  hideBuiltIn: (id: string) => void;
  showBuiltIn: (id: string) => void;
  addAction: (input: CustomActionInput) => Action;
  updateAction: (id: string, input: CustomActionInput) => void;
  deleteAction: (id: string) => void;
}

export const ACTIONS_STORE_VERSION = 1;

/**
 * Bring a persisted blob of any earlier shape (including none at all) up to
 * the current one. Exported so it can be tested without a storage backend.
 */
export function migrateActions(persisted: unknown, _version: number): ActionsPersisted {
  const blob = (persisted && typeof persisted === 'object' ? persisted : {}) as Partial<ActionsPersisted>;
  const hiddenBuiltIns = Array.isArray(blob.hiddenBuiltIns)
    ? blob.hiddenBuiltIns.filter((id): id is string => typeof id === 'string')
    : [];
  const customActions = Array.isArray(blob.customActions)
    ? blob.customActions
        .filter(
          (a): a is Action =>
            !!a &&
            typeof a === 'object' &&
            typeof (a as Action).id === 'string' &&
            typeof (a as Action).name === 'string' &&
            typeof (a as Action).prompt === 'string' &&
            ((a as Action).kind === 'transform' || (a as Action).kind === 'answer')
        )
        .map((a) => ({ ...a, builtIn: false }))
    : [];
  return { hiddenBuiltIns, customActions };
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const useActionsStore = create<ActionsState>()(
  persist(
    (set) => ({
      hiddenBuiltIns: [],
      customActions: [],

      hideBuiltIn: (id) =>
        set((s) => ({ hiddenBuiltIns: [...s.hiddenBuiltIns.filter((x) => x !== id), id] })),
      showBuiltIn: (id) =>
        set((s) => ({ hiddenBuiltIns: s.hiddenBuiltIns.filter((x) => x !== id) })),

      addAction: (input) => {
        const action: Action = {
          id: newId(),
          name: input.name.trim(),
          prompt: input.prompt,
          kind: input.kind,
          builtIn: false,
        };
        set((s) => ({ customActions: [...s.customActions, action] }));
        return action;
      },
      updateAction: (id, input) =>
        set((s) => ({
          customActions: s.customActions.map((a) =>
            a.id === id ? { ...a, name: input.name.trim(), prompt: input.prompt, kind: input.kind } : a
          ),
        })),
      deleteAction: (id) =>
        set((s) => ({ customActions: s.customActions.filter((a) => a.id !== id) })),
    }),
    {
      name: 'peekaboo-actions',
      version: ACTIONS_STORE_VERSION,
      migrate: (persisted, version) => migrateActions(persisted, version) as ActionsState,
      partialize: (state) => ({
        hiddenBuiltIns: state.hiddenBuiltIns,
        customActions: state.customActions,
      }) as ActionsState,
    }
  )
);

/** Every action the palette should offer, in palette order. */
export function selectVisibleActions(state: ActionsPersisted): Action[] {
  const hidden = new Set(state.hiddenBuiltIns);
  return [...BUILTIN_ACTIONS.filter((a) => !hidden.has(a.id)), ...state.customActions];
}

// The Settings window edits actions; the overlay runs them. Same pattern as
// the other persisted stores: a storage event means another window wrote.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'peekaboo-actions' || e.key === null) {
      useActionsStore.persist.rehydrate();
    }
  });
}
