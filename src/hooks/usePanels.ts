import { usePeekStore } from '../store/peek';
import { useHistoryStore } from '../store/history';
import { useSettingsStore } from '../store/settings';

/**
 * The four overlay panels share one full-bleed surface and are mutually
 * exclusive. That rule used to be spelled out inline at each of the four
 * keyboard bindings, which meant four chances to forget one. The footer buttons
 * need identical behaviour, so it lives here instead.
 *
 * Panel open state is spread across three stores for historical reasons; this
 * module is the seam that hides that.
 */

export type PanelId = 'history' | 'models' | 'memory' | 'legend';

export function getOpenPanel(): PanelId | null {
  if (useHistoryStore.getState().isOpen) return 'history';
  if (useSettingsStore.getState().isModelsOpen) return 'models';
  if (usePeekStore.getState().memoryOverlay.isOpen) return 'memory';
  if (usePeekStore.getState().isLegendOpen) return 'legend';
  return null;
}

export function closePanels(): void {
  useHistoryStore.getState().setOpen(false);
  useSettingsStore.getState().setModelsOpen(false);
  usePeekStore.getState().setLegendOpen(false);
  usePeekStore.getState().setMemoryOverlay({ isOpen: false });
}

/** Memory seeds itself from the current selection and loads recent entries. */
function openMemoryPanel(): void {
  const selectedText = window.getSelection()?.toString().trim();

  usePeekStore.getState().setMemoryOverlay({
    isOpen: true,
    title: selectedText ? 'Remember Selection' : 'Recent Memories',
    initialSearchQuery: selectedText || undefined,
    items: [],
  });

  // Imported lazily to avoid a circular dependency through the store.
  import('../db/database').then(({ searchMemories }) => {
    searchMemories('').then((memories) => {
      // The panel may have been dismissed while this was in flight.
      if (usePeekStore.getState().memoryOverlay.isOpen) {
        usePeekStore.getState().setMemoryOverlay({ items: memories });
      }
    });
  });
}

export function openPanel(id: PanelId): void {
  closePanels();
  switch (id) {
    case 'history':
      useHistoryStore.getState().setOpen(true);
      break;
    case 'models':
      useSettingsStore.getState().setModelsOpen(true);
      break;
    case 'legend':
      usePeekStore.getState().setLegendOpen(true);
      break;
    case 'memory':
      openMemoryPanel();
      break;
  }
}

export function togglePanel(id: PanelId): void {
  if (getOpenPanel() === id) closePanels();
  else openPanel(id);
}

/** Reactive counterpart, for components that render panel state. */
export function useOpenPanel(): PanelId | null {
  const isHistoryOpen = useHistoryStore((s) => s.isOpen);
  const isModelsOpen = useSettingsStore((s) => s.isModelsOpen);
  const isMemoryOpen = usePeekStore((s) => s.memoryOverlay.isOpen);
  const isLegendOpen = usePeekStore((s) => s.isLegendOpen);

  if (isHistoryOpen) return 'history';
  if (isModelsOpen) return 'models';
  if (isMemoryOpen) return 'memory';
  if (isLegendOpen) return 'legend';
  return null;
}
