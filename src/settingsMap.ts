import type { AppSettings } from "./settingsFile";

// The window keeps camelCase fields (useSettings, useAI.config) that many
// components read; Rust's settings.json uses the snake_case AppSettings keys.
// Everything that converts between the two lives here, so the names are spelled
// once and stay testable without Tauri.

export type Theme = AppSettings["theme"];
export type WeekStart = AppSettings["week_start"];
export type AIMode = AppSettings["ai_mode"];
export type EngineModelId = AppSettings["ai_engine_model"];

/** The synced slice of the settings store. */
export interface SyncedSettings {
  theme: Theme;
  weekStart: WeekStart;
  defaultProjectId: number | null;
  agentServer: boolean;
  agentNotify: boolean;
  wsHubUrl: string;
}

/** The synced slice of the AI store (`useAI.config`). */
export interface SyncedAIConfig {
  mode: AIMode;
  baseUrl: string;
  model: string;
  engineModel: EngineModelId;
  autoStart: boolean;
  secretaryEnabled: boolean;
}

export const settingsFromApp = (a: AppSettings): SyncedSettings => ({
  theme: a.theme,
  weekStart: a.week_start,
  defaultProjectId: a.default_project_id,
  agentServer: a.agent_server,
  agentNotify: a.agent_notify,
  wsHubUrl: a.ws_hub_url,
});

export const aiFromApp = (a: AppSettings): SyncedAIConfig => ({
  mode: a.ai_mode,
  baseUrl: a.ai_base_url,
  model: a.ai_model,
  engineModel: a.ai_engine_model,
  autoStart: a.ai_auto_start,
  secretaryEnabled: a.ai_secretary,
});

// One table per side: window field -> AppSettings key.
const SETTINGS_KEYS: { [K in keyof SyncedSettings]: keyof AppSettings } = {
  theme: "theme",
  weekStart: "week_start",
  defaultProjectId: "default_project_id",
  agentServer: "agent_server",
  agentNotify: "agent_notify",
  wsHubUrl: "ws_hub_url",
};

const AI_KEYS: { [K in keyof SyncedAIConfig]: keyof AppSettings } = {
  mode: "ai_mode",
  baseUrl: "ai_base_url",
  model: "ai_model",
  engineModel: "ai_engine_model",
  autoStart: "ai_auto_start",
  secretaryEnabled: "ai_secretary",
};

function toApp<T extends object>(
  patch: Partial<T>,
  keys: { [K in keyof T]: keyof AppSettings },
): Partial<AppSettings> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(patch) as (keyof T)[]) {
    if (patch[k] !== undefined) out[keys[k]] = patch[k];
  }
  return out as Partial<AppSettings>;
}

export const settingsPatchToApp = (patch: Partial<SyncedSettings>) =>
  toApp(patch, SETTINGS_KEYS);
export const aiPatchToApp = (patch: Partial<SyncedAIConfig>) => toApp(patch, AI_KEYS);

const oneOf = <T extends string>(allowed: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v);

function parseObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The settings the old build kept in localStorage (`tildone-settings` and
 * `tildone-ai-config`), as an AppSettings patch for settings_migrate. Only keys
 * that are present and valid come back: Rust fills what the file lacks, and a
 * bad value would make it reject the whole patch.
 */
export function legacyToApp(
  settingsRaw: string | null,
  aiRaw: string | null,
): Partial<AppSettings> {
  const s = parseObject(settingsRaw);
  const a = parseObject(aiRaw);
  const out: Partial<AppSettings> = {};
  if (oneOf(["auto", "light", "dark"], s.theme)) out.theme = s.theme;
  if (oneOf(["monday", "sunday"], s.weekStart)) out.week_start = s.weekStart;
  if (typeof s.defaultProjectId === "number") out.default_project_id = s.defaultProjectId;
  if (typeof s.agentServer === "boolean") out.agent_server = s.agentServer;
  if (typeof s.agentNotify === "boolean") out.agent_notify = s.agentNotify;
  if (typeof s.wsHubUrl === "string") out.ws_hub_url = s.wsHubUrl;
  if (oneOf(["off", "external", "builtin"], a.mode)) out.ai_mode = a.mode;
  if (typeof a.baseUrl === "string") out.ai_base_url = a.baseUrl;
  if (typeof a.model === "string") out.ai_model = a.model;
  if (oneOf(["small", "default", "better"], a.engineModel)) out.ai_engine_model = a.engineModel;
  if (typeof a.autoStart === "boolean") out.ai_auto_start = a.autoStart;
  if (typeof a.secretaryEnabled === "boolean") out.ai_secretary = a.secretaryEnabled;
  return out;
}

/** The six keys of `tildone-settings` that moved to settings.json (the rest is UI state). */
export const LEGACY_SETTINGS_KEYS = [
  "theme",
  "weekStart",
  "defaultProjectId",
  "agentServer",
  "agentNotify",
  "wsHubUrl",
] as const;

/**
 * The theme setting as last applied, kept in localStorage so the next launch can
 * paint the right theme on the loading screen, before Rust's settings.json has
 * been read. A hint only: settings.json stays the source of truth and replaces it
 * the moment it loads.
 */
export const THEME_HINT_KEY = "tildone-theme-hint";

/** The theme for the first paint: the hint, else the pre-upgrade `tildone-settings` theme, else auto. */
export const readThemeHint = (raw: string | null, legacyRaw: string | null = null): Theme => {
  if (oneOf(["auto", "light", "dark"], raw)) return raw;
  try {
    const legacy = (JSON.parse(legacyRaw ?? "null") as { theme?: unknown } | null)?.theme;
    if (oneOf(["auto", "light", "dark"], legacy)) return legacy;
  } catch {
    // A corrupt blob is no hint.
  }
  return "auto";
};
