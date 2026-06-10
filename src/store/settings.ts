import { create } from 'zustand';

import { persist } from 'zustand/middleware';

interface SettingsState {
  hotkey: string;
  activeProvider: string;
  activeModel: string;
  ollamaBaseUrl: string;
  historyRetentionDays: number;
  isModelsOpen: boolean;
  systemPrompt: string;

  setHotkey: (v: string) => void;
  setActiveModel: (v: string) => void;
  setOllamaBaseUrl: (v: string) => void;
  setModelsOpen: (v: boolean) => void;
  setSystemPrompt: (v: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      hotkey: 'Alt+Space',
      activeProvider: 'ollama',
      activeModel: '',
      ollamaBaseUrl: 'http://localhost:11434',
      historyRetentionDays: 90,
      isModelsOpen: false,
      systemPrompt: 'You are Peekaboo, a highly capable, concise, and helpful AI desktop assistant. Do not use conversational filler. Provide direct, accurate answers.',

      setHotkey: (v) => set({ hotkey: v }),
      setActiveModel: (v) => set({ activeModel: v }),
      setOllamaBaseUrl: (v) => set({ ollamaBaseUrl: v }),
      setModelsOpen: (v) => set({ isModelsOpen: v }),
      setSystemPrompt: (v) => set({ systemPrompt: v }),
    }),
    {
      name: 'peekaboo-settings',
    }
  )
);

// Synchronize state across Webview instances (Settings window -> Main window)
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'peekaboo-settings') {
      useSettingsStore.persist.rehydrate();
    }
  });
}
