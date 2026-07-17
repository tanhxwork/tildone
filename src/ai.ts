import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

export type AIMode = "off" | "external" | "builtin";
export type EngineModelId = "small" | "default" | "better";

export interface ModelTier {
  id: EngineModelId;
  label: string;
  detail: string;
  sizeGB: number;
  minRamGB: number;
}

export const MODEL_TIERS: ModelTier[] = [
  { id: "small", label: "Small", detail: "Qwen3.5 0.8B — fastest", sizeGB: 0.5, minRamGB: 0 },
  { id: "default", label: "Default", detail: "Qwen3.5 2B — balanced", sizeGB: 1.3, minRamGB: 8 },
  { id: "better", label: "Better", detail: "Qwen3.5 4B — best quality", sizeGB: 2.7, minRamGB: 16 },
];

/** Highest tier whose RAM floor this machine clears. */
export function recommendedTier(ramBytes: number): EngineModelId {
  const ramGB = ramBytes / 1024 ** 3;
  let pick: EngineModelId = "small";
  for (const t of MODEL_TIERS) {
    if (ramGB >= t.minRamGB) pick = t.id;
  }
  return pick;
}

export interface AIConfig {
  mode: AIMode;
  baseUrl: string;
  model: string;
  engineModel: EngineModelId;
  autoStart: boolean;
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

/** One model `.gguf` on disk, as reported by the `engine_models` command. */
export interface DiskModel {
  file: string;
  size_bytes: number;
  /** Tier this file backs, or null for a stray (e.g. an older version's model). */
  tier: EngineModelId | null;
  running: boolean;
}

export interface DiskUsage {
  models_bytes: number;
  free_bytes: number;
}

const CONFIG_KEY = "tildone-ai-config";

const CONFIG_DEFAULTS: AIConfig = {
  mode: "off",
  baseUrl: "",
  model: "",
  engineModel: "default",
  autoStart: false,
};

function loadConfig(): AIConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return { ...CONFIG_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // fall through to defaults
  }
  return { ...CONFIG_DEFAULTS };
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
  ramBytes: number | null;
  installing: boolean;
  starting: boolean;
  progress: EngineProgress | null;
  settingsOpen: boolean;
  diskModels: DiskModel[];
  disk: DiskUsage | null;

  openSettings: () => void;
  closeSettings: () => void;
  setConfig: (patch: Partial<AIConfig>) => void;
  probe: () => Promise<void>;
  identify: (baseUrl: string) => Promise<DetectedServer>;
  fetchRam: () => Promise<void>;
  refreshEngine: () => Promise<void>;
  installEngine: () => Promise<void>;
  startEngine: () => Promise<void>;
  stopEngine: () => Promise<void>;
  refreshModels: () => Promise<void>;
  deleteModel: (file: string) => Promise<void>;
  useModel: (id: EngineModelId) => Promise<void>;
  chat: (system: string, prompt: string) => Promise<string>;
}

export const useAI = create<AIStore>()((set, get) => ({
  config: loadConfig(),
  detected: [],
  probing: false,
  engine: null,
  ramBytes: null,
  installing: false,
  starting: false,
  progress: null,
  settingsOpen: false,
  diskModels: [],
  disk: null,

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  setConfig: (patch) => {
    const prevModel = get().config.engineModel;
    set((s) => {
      const config = { ...s.config, ...patch };
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      return { config };
    });
    // Installed/running state is per-tier; re-check when the tier changes.
    if (patch.engineModel && patch.engineModel !== prevModel) {
      void get().refreshEngine();
    }
  },

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

  fetchRam: async () => {
    if (get().ramBytes !== null) return;
    try {
      set({ ramBytes: await invoke<number>("system_ram") });
    } catch {
      // RAM badge is a nicety; the picker works without it
    }
  },

  refreshEngine: async () => {
    try {
      const model = get().config.engineModel;
      set({ engine: await invoke<EngineStatus>("engine_status", { model }) });
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
      await invoke("engine_install", { model: get().config.engineModel });
      await get().refreshEngine();
    } finally {
      unlisten();
      set({ installing: false, progress: null });
    }
  },

  startEngine: async () => {
    set({ starting: true });
    try {
      await invoke("engine_start", { model: get().config.engineModel });
      await get().refreshEngine();
    } finally {
      set({ starting: false });
    }
  },

  stopEngine: async () => {
    await invoke("engine_stop");
    await get().refreshEngine();
    await get().refreshModels();
  },

  refreshModels: async () => {
    try {
      const [models, disk] = await Promise.all([
        invoke<DiskModel[]>("engine_models"),
        invoke<DiskUsage>("engine_disk"),
      ]);
      set({ diskModels: models, disk });
    } catch {
      // the manager is a convenience; leave last-known state on failure
    }
  },

  deleteModel: async (file) => {
    await invoke("engine_delete", { file });
    await get().refreshModels();
    await get().refreshEngine();
  },

  useModel: async (id) => {
    get().setConfig({ engineModel: id });
    await get().startEngine();
    await get().refreshModels();
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
        // Built-in Qwen3.5 defaults to thinking mode, which leaves the reply
        // empty; turn it off so answers land in `content`.
        disableThinking: true,
      });
    }
    if (config.mode === "external" && config.baseUrl && config.model) {
      return invoke<string>("ai_chat", {
        baseUrl: config.baseUrl,
        model: config.model,
        system,
        prompt,
        // Leave the user's own server on its default behavior.
        disableThinking: false,
      });
    }
    throw new Error("AI is not set up — open AI Assistant in the sidebar");
  },
}));
