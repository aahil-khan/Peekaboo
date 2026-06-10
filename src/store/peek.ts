import { create } from 'zustand';
import type { Message } from '../providers/types';

export interface BackgroundTask {
  id: string;
  question: string;
  startedAt: number;
  status: 'running' | 'complete' | 'error';
  result?: string;
  sessionId: string;
}

interface PeekState {
  // Visibility
  visible: boolean;
  setVisible: (v: boolean) => void;

  // Input
  input: string;
  setInput: (v: string) => void;

  // Current conversation
  messages: Message[];
  activeSessionId: string | null;
  addMessage: (m: Message) => void;
  setMessages: (msgs: Message[]) => void;
  setActiveSessionId: (id: string | null) => void;

  // Streaming state
  streamingContent: string;
  isStreaming: boolean;
  setStreamingContent: (v: string) => void;
  setIsStreaming: (v: boolean) => void;

  // Background tasks
  backgroundTasks: BackgroundTask[];
  addBackgroundTask: (t: BackgroundTask) => void;
  updateBackgroundTask: (id: string, update: Partial<BackgroundTask>) => void;
  removeBackgroundTask: (id: string) => void;

  // Legend
  isLegendOpen: boolean;
  setLegendOpen: (v: boolean) => void;

  // Reset
  clear: () => void;

  // Memory Overlay
  memoryOverlay: { isOpen: boolean; title: string; initialSearchQuery?: string; items: import('../db/database').Memory[] };
  setMemoryOverlay: (update: Partial<{ isOpen: boolean; title: string; initialSearchQuery?: string; items: import('../db/database').Memory[] }>) => void;
}

export const usePeekStore = create<PeekState>((set) => ({
  visible: false,
  setVisible: (v) => set({ visible: v }),

  input: '',
  setInput: (v) => set({ input: v }),

  messages: [],
  activeSessionId: null,
  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  setMessages: (msgs) => set({ messages: msgs }),
  setActiveSessionId: (id) => set({ activeSessionId: id }),

  streamingContent: '',
  isStreaming: false,
  setStreamingContent: (v) => set({ streamingContent: v }),
  setIsStreaming: (v) => set({ isStreaming: v }),

  backgroundTasks: [],
  addBackgroundTask: (t) =>
    set((s) => ({ backgroundTasks: [...s.backgroundTasks, t] })),
  updateBackgroundTask: (id, update) =>
    set((s) => ({
      backgroundTasks: s.backgroundTasks.map((t) =>
        t.id === id ? { ...t, ...update } : t
      ),
    })),
  removeBackgroundTask: (id) =>
    set((s) => ({
      backgroundTasks: s.backgroundTasks.filter((t) => t.id !== id),
    })),

  isLegendOpen: false,
  setLegendOpen: (v) => set({ isLegendOpen: v }),

  memoryOverlay: { isOpen: false, title: '', items: [] },
  setMemoryOverlay: (update) => set((s) => ({ memoryOverlay: { ...s.memoryOverlay, ...update } })),

  clear: () =>
    set({
      input: '',
      messages: [],
      activeSessionId: null,
      streamingContent: '',
      isStreaming: false,
    }),
}));
