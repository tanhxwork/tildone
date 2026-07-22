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
  /** The board secretary: derive card progress from claimed sessions'
   *  transcripts via the local engine. On by default — it only acts when
   *  AI is set up (`aiReady`) and a claimed session is live. */
  secretaryEnabled: boolean;
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

/** Mirror of `SecretaryStatus` in secretary.rs — the loop's live answer. */
export interface SecretaryStatus {
  enabled: boolean;
  engine_ready: boolean;
  /** Task ids with a watched live transcript. */
  watching: number[];
  /** Task ids whose engine lane is behind (catching up / waiting on engine). */
  behind: number[];
}

const CONFIG_KEY = "tildone-ai-config";

const CONFIG_DEFAULTS: AIConfig = {
  mode: "off",
  baseUrl: "",
  model: "",
  engineModel: "default",
  autoStart: false,
  secretaryEnabled: true,
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
  secretary: SecretaryStatus | null;

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
  /** Push the current config down to the Rust secretary loop. */
  syncSecretary: () => Promise<void>;
  refreshSecretary: () => Promise<void>;
}

// Monotonic generation for syncSecretary: each call claims the next number,
// and only the latest-numbered call may write the loop's config. syncSecretary
// awaits an engine probe (and can await a ~60s engine start), so without this
// an older, slower call could resume and clobber a newer intent — e.g. re-enable
// the secretary after the user has just switched AI mode off (TIL-153 codex).
let secretarySyncSeq = 0;

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
  secretary: null,

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
    // Any config change may change where (or whether) the secretary runs.
    void get().syncSecretary();
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
      // Installing the engine flips the secretary's routing from fallback to
      // pinned — re-sync so it repoints (and starts the engine) now, not on
      // the next unrelated config change or relaunch.
      await get().syncSecretary();
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
    // Deleting the selected tier's model flips routing from pinned back to
    // fallback — re-sync so the secretary stops pointing at an engine that is
    // no longer installed.
    await get().syncSecretary();
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

  syncSecretary: async () => {
    const seq = ++secretarySyncSeq;
    const { config } = get();
    const enabled = config.secretaryEnabled && aiReady(config);
    // The secretary defaults to the built-in engine whenever it is installed
    // for the selected tier — a near-multiple-choice task should not ride a
    // heavy external model just because chat points at one (TIL-153). It
    // follows the external server only as a fallback, when no engine is
    // installed (preserves the zero-engine path and the e2e stub).
    //
    // Always probe fresh: `engine` may be null (never probed) OR stale from a
    // previously-selected tier — setConfig kicks off refreshEngine and this
    // sync without ordering them, so a cached hit for the *old* tier could
    // otherwise pin a new, uninstalled tier to a dead port. engine_status is a
    // cheap local probe against the tier in config.
    await get().refreshEngine();
    let engine = get().engine;
    const pinBuiltin = !!engine?.installed;
    // Liveness: the secretary's need overrides `autoStart` — when it is
    // enabled and pinned to the engine, make sure the engine is running.
    // engine_start is idempotent against a healthy server on the port.
    if (enabled && pinBuiltin && !engine?.running) {
      // A newer sync may have superseded this one during the probe above
      // (e.g. the user just switched AI mode off) — don't start an engine the
      // latest intent no longer wants.
      if (seq !== secretarySyncSeq) return;
      try {
        await get().startEngine();
        engine = get().engine;
      } catch {
        // Frozen-lane degraded state: the badge breathes, the backlog drains
        // when the engine returns. Never silently fall back to a different
        // model — configure the pinned endpoint anyway below.
      }
    }
    // startEngine can await the native loader for up to a minute; a later sync
    // (mode off, tier change) may have run to completion meanwhile. The latest
    // intent wins — a stale sync must never overwrite it.
    if (seq !== secretarySyncSeq) return;
    const port = engine?.port ?? 11500;
    try {
      await invoke("secretary_configure", {
        enabled,
        baseUrl: pinBuiltin ? `http://127.0.0.1:${port}` : config.baseUrl,
        model: pinBuiltin ? "local" : config.model,
        disableThinking: pinBuiltin,
      });
    } catch {
      // The loop keeps its previous config; the next sync retries.
    }
  },

  refreshSecretary: async () => {
    try {
      set({ secretary: await invoke<SecretaryStatus>("secretary_status") });
    } catch {
      // Status is ambient UI; keep last known.
    }
  },
}));
