import { invoke } from "@tauri-apps/api/core";

/**
 * The user's settings as Rust keeps them in settings.json. Mirrors `Settings` in
 * src-tauri/src/appsettings.rs; the same keys are what MCP's update_settings and
 * `tildone-axi settings set` take.
 */
export interface AppSettings {
  theme: "auto" | "light" | "dark";
  week_start: "monday" | "sunday";
  default_project_id: number | null;
  ws_hub_url: string;
  /** Another Tildone's agent server URL to use as the board; "" = this machine. */
  board_hub_url: string;
  board_hub_token: string;
  agent_server: boolean;
  agent_notify: boolean;
  ai_mode: "off" | "external" | "builtin";
  ai_base_url: string;
  ai_model: string;
  ai_engine_model: "small" | "default" | "better";
  ai_auto_start: boolean;
  ai_secretary: boolean;
}

/** Emitted by Rust with the full AppSettings after any change, from any writer. */
export const SETTINGS_CHANGED = "settings-changed";

export const getSettings = () => invoke<AppSettings>("settings_get");

/** Apply a patch; resolves to the settings after it. Rejects with a message naming the allowed values. */
export const setSettings = (patch: Partial<AppSettings>) =>
  invoke<AppSettings>("settings_set", { patch });

/** Once per install: hand Rust the old localStorage values; keys already in settings.json win. */
export const migrateSettings = (values: Partial<AppSettings>) =>
  invoke<AppSettings>("settings_migrate", { values });
