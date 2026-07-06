import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

export type AIMode = "off" | "external" | "builtin";

export interface AIConfig {
  mode: AIMode;
  baseUrl: string;
  model: string;
}

export interface DetectedServer {
  name: string;
  base_url: string;
  kind: string;
  models: string[];
}

export interface EngineStatus {
  installed: boolean;
  running: boolean;
  port: number;
  model: string;
}

export interface EngineProgress {
  phase: "runtime" | "model";
  downloaded: number;
  total: number;
}

const CONFIG_KEY = "tildone-ai-config";

function loadConfig(): AIConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return { mode: "off", baseUrl: "", model: "", ...JSON.parse(raw) };
  } catch {
    // fall through to defaults
  }
  return { mode: "off", baseUrl: "", model: "" };
}

export function aiReady(config: AIConfig): boolean {
  if (config.mode === "builtin") return true;
  return config.mode === "external" && !!config.baseUrl && !!config.model;
}

interface AIStore {
  config: AIConfig;
  detected: DetectedServer[];
  probing: boolean;
  engine: EngineStatus | null;
  installing: boolean;
  starting: boolean;
  progress: EngineProgress | null;
  settingsOpen: boolean;

  openSettings: () => void;
  closeSettings: () => void;
  setConfig: (patch: Partial<AIConfig>) => void;
  probe: () => Promise<void>;
  identify: (baseUrl: string) => Promise<DetectedServer>;
  refreshEngine: () => Promise<void>;
  installEngine: () => Promise<void>;
  startEngine: () => Promise<void>;
  stopEngine: () => Promise<void>;
  chat: (system: string, prompt: string) => Promise<string>;
}

export const useAI = create<AIStore>()((set, get) => ({
  config: loadConfig(),
  detected: [],
  probing: false,
  engine: null,
  installing: false,
  starting: false,
  progress: null,
  settingsOpen: false,

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  setConfig: (patch) =>
    set((s) => {
      const config = { ...s.config, ...patch };
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      return { config };
    }),

  probe: async () => {
    set({ probing: true });
    try {
      const detected = await invoke<DetectedServer[]>("ai_probe");
      set({ detected });
    } finally {
      set({ probing: false });
    }
  },

  identify: async (baseUrl) => {
    const server = await invoke<DetectedServer>("ai_identify", { baseUrl });
    set((s) => {
      const rest = s.detected.filter((d) => d.base_url !== server.base_url);
      return { detected: [...rest, server] };
    });
    return server;
  },

  refreshEngine: async () => {
    try {
      set({ engine: await invoke<EngineStatus>("engine_status") });
    } catch {
      // status probe failing is not fatal; leave last known state
    }
  },

  installEngine: async () => {
    set({ installing: true, progress: null });
    const unlisten = await listen<EngineProgress>("engine-progress", (e) =>
      set({ progress: e.payload }),
    );
    try {
      await invoke("engine_install");
      await get().refreshEngine();
    } finally {
      unlisten();
      set({ installing: false, progress: null });
    }
  },

  startEngine: async () => {
    set({ starting: true });
    try {
      await invoke("engine_start");
      await get().refreshEngine();
    } finally {
      set({ starting: false });
    }
  },

  stopEngine: async () => {
    await invoke("engine_stop");
    await get().refreshEngine();
  },

  chat: async (system, prompt) => {
    const { config } = get();
    if (config.mode === "builtin") {
      await get().startEngine();
      const port = get().engine?.port ?? 11500;
      return invoke<string>("ai_chat", {
        baseUrl: `http://127.0.0.1:${port}`,
        model: "local",
        system,
        prompt,
      });
    }
    if (config.mode === "external" && config.baseUrl && config.model) {
      return invoke<string>("ai_chat", {
        baseUrl: config.baseUrl,
        model: config.model,
        system,
        prompt,
      });
    }
    throw new Error("AI is not set up — open AI Assistant in the sidebar");
  },
}));
