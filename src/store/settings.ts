import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  llamaBaseUrl: string;
  llamaProfiles: LlamaProfile[];
  activeLlamaProfileId: string | null;
  historyRetentionDays: number;
  isModelsOpen: boolean;
  systemPrompt: string;
  autoCaptureSelection: boolean;

  setSetupCompleted: (v: boolean) => void;
  setActiveProvider: (v: string) => void;
  setActiveModel: (v: string) => void;
  setOllamaBaseUrl: (v: string) => void;
  setLlamaBaseUrl: (v: string) => void;
  addLlamaProfile: (p: LlamaProfile) => void;
  updateLlamaProfile: (p: LlamaProfile) => void;
  deleteLlamaProfile: (id: string) => void;
  setActiveLlamaProfileId: (id: string | null) => void;
  setModelsOpen: (v: boolean) => void;
  setSystemPrompt: (v: string) => void;
  setAutoCaptureSelection: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      setupCompleted: false,
      activeProvider: 'ollama',
      activeModel: '',
      ollamaBaseUrl: 'http://localhost:11434',
      llamaBaseUrl: 'http://127.0.0.1:8080',
      llamaProfiles: [],
      activeLlamaProfileId: null,
      historyRetentionDays: 90,
      isModelsOpen: false,
      systemPrompt: 'You are Peekaboo, a highly capable, concise, and helpful AI desktop assistant. Do not use conversational filler. Provide direct, accurate answers.',
      autoCaptureSelection: true,

      setSetupCompleted: (v) => set({ setupCompleted: v }),
      setActiveProvider: (v) => set({ activeProvider: v }),
      setActiveModel: (v) => set({ activeModel: v }),
      setOllamaBaseUrl: (v) => set({ ollamaBaseUrl: v }),
      setLlamaBaseUrl: (v) => set({ llamaBaseUrl: v }),
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
      setAutoCaptureSelection: (v) => set({ autoCaptureSelection: v }),
    }),
    { name: 'peekaboo-settings' }
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
