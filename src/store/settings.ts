import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_THEME_ID, type ThemeAccent } from '../lib/themes';

export interface LlamaProfile {
  id: string;
  name: string;
  binaryPath: string;
  modelPath: string;
  mmprojPath: string;
  host: string;
  port: number;
  contextSize: number;
  nGpuLayers: number;
  flashAttn: boolean;
  batchSize: number;
  ubatchSize: number;
  parallel: number;
  temperature: number;
}

export const DEFAULT_LLAMA_PROFILE: Omit<LlamaProfile, 'id' | 'name' | 'binaryPath' | 'modelPath'> = {
  mmprojPath: '',
  host: '127.0.0.1',
  port: 8080,
  contextSize: 4096,
  nGpuLayers: 999,
  flashAttn: false,
  batchSize: 512,
  ubatchSize: 512,
  parallel: 1,
  temperature: 0.8,
};

interface SettingsState {
  setupCompleted: boolean;
  activeProvider: string;
  activeModel: string;
  ollamaBaseUrl: string;
  /** Ollama `keep_alive`: a duration ("5m"), "0" to unload at once, "-1" to never unload. */
  ollamaKeepAlive: string;
  llamaBaseUrl: string;
  llamaProfiles: LlamaProfile[];
  activeLlamaProfileId: string | null;
  historyRetentionDays: number;
  isModelsOpen: boolean;
  systemPrompt: string;
  /** Send pinned memories with every question (they leave the machine on cloud providers). */
  includePinnedMemories: boolean;
  autoCopyOnHide: boolean;
  /**
   * Attach the selected text when Peekaboo is summoned. `null` follows the
   * platform default (on where reading the selection has no side effects).
   */
  captureSelectionOnSummon: boolean | null;
  /** Palette id from src/lib/themes.ts. */
  themeId: string;
  /** Swap to the palette's light/dark counterpart to match the OS. */
  followSystem: boolean;
  /** 'auto' keeps the palette's own accent. */
  themeAccent: ThemeAccent;
  /** Whether the first-run orientation strip in the overlay has been dismissed. */
  overlayTourSeen: boolean;
  openaiApiKey: string;
  openaiBaseUrl: string;
  anthropicApiKey: string;
  geminiApiKey: string;

  setSetupCompleted: (v: boolean) => void;
  setHistoryRetentionDays: (v: number) => void;
  setThemeId: (v: string) => void;
  setFollowSystem: (v: boolean) => void;
  setThemeAccent: (v: ThemeAccent) => void;
  setOverlayTourSeen: (v: boolean) => void;
  setActiveProvider: (v: string) => void;
  setActiveModel: (v: string) => void;
  setOllamaBaseUrl: (v: string) => void;
  setOllamaKeepAlive: (v: string) => void;
  setLlamaBaseUrl: (v: string) => void;
  setOpenaiApiKey: (v: string) => void;
  setOpenaiBaseUrl: (v: string) => void;
  setAnthropicApiKey: (v: string) => void;
  setGeminiApiKey: (v: string) => void;
  addLlamaProfile: (p: LlamaProfile) => void;
  updateLlamaProfile: (p: LlamaProfile) => void;
  deleteLlamaProfile: (id: string) => void;
  setActiveLlamaProfileId: (id: string | null) => void;
  setModelsOpen: (v: boolean) => void;
  setSystemPrompt: (v: string) => void;
  setIncludePinnedMemories: (v: boolean) => void;
  setAutoCopyOnHide: (v: boolean) => void;
  setCaptureSelectionOnSummon: (v: boolean | null) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      setupCompleted: false,
      activeProvider: 'ollama',
      activeModel: '',
      ollamaBaseUrl: 'http://localhost:11434',
      // Ollama's own default. Anything shorter makes the next question wait
      // for the model to load again.
      ollamaKeepAlive: '5m',
      llamaBaseUrl: 'http://127.0.0.1:8080',
      llamaProfiles: [],
      activeLlamaProfileId: null,
      historyRetentionDays: 90,
      isModelsOpen: false,
      systemPrompt: 'You are Peekaboo, a highly capable, concise, and helpful AI desktop assistant. Do not use conversational filler. Provide direct, accurate answers.',
      // On by default: a pin is the user's own request that the model know
      // this. The toggle exists because cloud providers then see it too.
      includePinnedMemories: true,
      // Off by default on purpose: copying on every dismiss would silently
      // destroy whatever the user already had on their clipboard.
      autoCopyOnHide: false,
      captureSelectionOnSummon: null,
      // The designed default, and what an existing install already looks like.
      // Following the OS is opt-in.
      themeId: DEFAULT_THEME_ID,
      followSystem: false,
      themeAccent: 'auto',
      overlayTourSeen: false,
      openaiApiKey: '',
      openaiBaseUrl: 'https://api.openai.com/v1',
      anthropicApiKey: '',
      geminiApiKey: '',

      setSetupCompleted: (v) => set({ setupCompleted: v }),
      setHistoryRetentionDays: (v) => set({ historyRetentionDays: v }),
      setThemeId: (v) => set({ themeId: v }),
      setFollowSystem: (v) => set({ followSystem: v }),
      setThemeAccent: (v) => set({ themeAccent: v }),
      setOverlayTourSeen: (v) => set({ overlayTourSeen: v }),
      setActiveProvider: (v) => set({ activeProvider: v }),
      setActiveModel: (v) => set({ activeModel: v }),
      setOllamaBaseUrl: (v) => set({ ollamaBaseUrl: v }),
      setOllamaKeepAlive: (v) => set({ ollamaKeepAlive: v }),
      setLlamaBaseUrl: (v) => set({ llamaBaseUrl: v }),
      setOpenaiApiKey: (v) => set({ openaiApiKey: v }),
      setOpenaiBaseUrl: (v) => set({ openaiBaseUrl: v }),
      setAnthropicApiKey: (v) => set({ anthropicApiKey: v }),
      setGeminiApiKey: (v) => set({ geminiApiKey: v }),
      addLlamaProfile: (p) => set((s) => ({ llamaProfiles: [...s.llamaProfiles, p] })),
      updateLlamaProfile: (p) => set((s) => ({
        llamaProfiles: s.llamaProfiles.map((x) => x.id === p.id ? p : x),
      })),
      deleteLlamaProfile: (id) => set((s) => ({
        llamaProfiles: s.llamaProfiles.filter((x) => x.id !== id),
        activeLlamaProfileId: s.activeLlamaProfileId === id ? null : s.activeLlamaProfileId,
      })),
      setActiveLlamaProfileId: (id) => set((s) => {
        const profile = s.llamaProfiles.find((p) => p.id === id);
        if (profile) {
          return {
            activeLlamaProfileId: id,
            llamaBaseUrl: `http://${profile.host}:${profile.port}`,
          };
        }
        return { activeLlamaProfileId: id };
      }),
      setModelsOpen: (v) => set({ isModelsOpen: v }),
      setSystemPrompt: (v) => set({ systemPrompt: v }),
      setIncludePinnedMemories: (v) => set({ includePinnedMemories: v }),
      setAutoCopyOnHide: (v) => set({ autoCopyOnHide: v }),
      setCaptureSelectionOnSummon: (v) => set({ captureSelectionOnSummon: v }),
    }),
    {
      name: 'peekaboo-settings',
      version: 1,
      // No field has changed shape yet, so this is a pass-through. It exists so
      // the next schema change is a migration rather than a data-loss event —
      // without a version, zustand cannot tell an old blob from a current one.
      migrate: (persisted) => persisted as SettingsState,
      /*
       * isModelsOpen is transient UI state that was being written to
       * localStorage and, because every window rehydrates on the storage
       * event, replicated into the other windows. Keep it out of the
       * persisted blob.
       */
      partialize: (state) => {
        const { isModelsOpen: _isModelsOpen, ...rest } = state;
        return rest as SettingsState;
      },
    }
  )
);

// Synchronize state across Webview instances (Settings window -> Main window)
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'peekaboo-settings' || e.key === null) {
      useSettingsStore.persist.rehydrate();
    }
  });
}
