//! The user's settings, owned by Rust in `settings.json` beside `tildone.db`.
//!
//! Every writer goes through here: the Settings dialog (`settings_set`), MCP's
//! `update_settings`, and `tildone-axi settings set`, which writes the file directly
//! when the app's server is off. Each change emits `settings-changed` with the full
//! settings, and the window applies its side effects (theme, Agent access, secretary).
//! UI layout state (collapsed groups, pane widths) is not a setting and stays in
//! the webview's localStorage.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Event emitted with the full `Settings` after any change, from any writer.
pub const SETTINGS_CHANGED: &str = "settings-changed";
/// File name inside the app config dir.
pub const FILE_NAME: &str = "settings.json";

pub const THEMES: &[&str] = &["auto", "light", "dark"];
pub const WEEK_STARTS: &[&str] = &["monday", "sunday"];
pub const AI_MODES: &[&str] = &["off", "external", "builtin"];
pub const ENGINE_MODELS: &[&str] = &["small", "default", "better"];

/// Mirrors `AppSettings` in src/settingsFile.ts. Keys are the names agents and the
/// CLI use. A missing key takes its default; keys this build does not know are kept
/// (`extra`) so an older app never deletes a newer one's settings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub theme: String,
    pub week_start: String,
    pub default_project_id: Option<i64>,
    pub ws_hub_url: String,
    pub agent_server: bool,
    pub agent_notify: bool,
    pub ai_mode: String,
    pub ai_base_url: String,
    pub ai_model: String,
    pub ai_engine_model: String,
    pub ai_auto_start: bool,
    pub ai_secretary: bool,
    /// Set once the window has copied its old localStorage values in (see
    /// `settings_migrate`). A file written by the CLI before that lacks it.
    #[serde(rename = "_migrated")]
    pub migrated: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "auto".into(),
            week_start: "monday".into(),
            default_project_id: None,
            ws_hub_url: String::new(),
            agent_server: false,
            agent_notify: true,
            ai_mode: "off".into(),
            ai_base_url: String::new(),
            ai_model: String::new(),
            ai_engine_model: "default".into(),
            ai_auto_start: false,
            ai_secretary: true,
            migrated: false,
            extra: Map::new(),
        }
    }
}

/// The settings a caller may change, in display order.
pub const KEYS: &[&str] = &[
    "theme",
    "week_start",
    "default_project_id",
    "ws_hub_url",
    "agent_server",
    "agent_notify",
    "ai_mode",
    "ai_base_url",
    "ai_model",
    "ai_engine_model",
    "ai_auto_start",
    "ai_secretary",
];

impl Settings {
    /// Apply a patch of known keys. Returns the keys whose value changed. An unknown
    /// key or a bad value is an error naming what is allowed, and nothing is applied.
    /// `default_project_id`: null or 0 clears it.
    pub fn apply_patch(&mut self, patch: &Map<String, Value>) -> Result<Vec<String>, String> {
        let mut next = self.clone();
        for (key, value) in patch {
            match key.as_str() {
                "theme" => next.theme = one_of(key, value, THEMES)?,
                "week_start" => next.week_start = one_of(key, value, WEEK_STARTS)?,
                "ai_mode" => next.ai_mode = one_of(key, value, AI_MODES)?,
                "ai_engine_model" => next.ai_engine_model = one_of(key, value, ENGINE_MODELS)?,
                "ws_hub_url" => next.ws_hub_url = text(key, value)?.trim().to_string(),
                "ai_base_url" => next.ai_base_url = text(key, value)?.trim().to_string(),
                "ai_model" => next.ai_model = text(key, value)?,
                "agent_server" => next.agent_server = flag(key, value)?,
                "agent_notify" => next.agent_notify = flag(key, value)?,
                "ai_auto_start" => next.ai_auto_start = flag(key, value)?,
                "ai_secretary" => next.ai_secretary = flag(key, value)?,
                "default_project_id" => {
                    next.default_project_id = match value {
                        Value::Null => None,
                        Value::Number(n) => match n.as_i64() {
                            Some(0) => None,
                            Some(id) if id > 0 => Some(id),
                            _ => return Err(format!("{key} must be a project id, or null to clear it")),
                        },
                        _ => return Err(format!("{key} must be a project id, or null to clear it")),
                    }
                }
                _ => return Err(format!("unknown setting {key:?}; known: {}", KEYS.join(", "))),
            }
        }
        let before = serde_json::to_value(&*self).unwrap_or_default();
        let after = serde_json::to_value(&next).unwrap_or_default();
        let changed = KEYS
            .iter()
            .filter(|k| before.get(**k) != after.get(**k))
            .map(|k| k.to_string())
            .collect();
        *self = next;
        Ok(changed)
    }

    /// The public view: every key in `KEYS`, nothing internal.
    pub fn public(&self) -> Map<String, Value> {
        let all = serde_json::to_value(self).unwrap_or_default();
        KEYS.iter()
            .map(|k| (k.to_string(), all.get(*k).cloned().unwrap_or(Value::Null)))
            .collect()
    }
}

fn one_of(key: &str, value: &Value, allowed: &[&str]) -> Result<String, String> {
    match value.as_str() {
        Some(s) if allowed.contains(&s) => Ok(s.to_string()),
        _ => Err(format!("{key} must be one of: {}", allowed.join(", "))),
    }
}

fn text(key: &str, value: &Value) -> Result<String, String> {
    value.as_str().map(str::to_string).ok_or_else(|| format!("{key} must be text"))
}

fn flag(key: &str, value: &Value) -> Result<bool, String> {
    value.as_bool().ok_or_else(|| format!("{key} must be true or false"))
}

// --- Owned by step 1 (Rust builder) ---------------------------------------------
// pub fn path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String>   // app_config_dir/settings.json
// pub fn load(path) -> Settings            // missing file → default; unreadable → default + log
// pub fn save(path, &Settings)             // temp file + rename
// #[tauri::command] settings_get() -> Settings (public view + nothing internal)
// #[tauri::command] settings_set(patch: Map) -> Result<Map, String>   // apply, save, emit
// #[tauri::command] settings_migrate(values: Map) -> Result<Map, String>
//     // once: fill keys absent from the FILE with the window's old localStorage values,
//     // set _migrated, save, emit. No-op when _migrated is already true.
// pub fn init(app)                          // load into managed state; poll mtime every 2 s;
//                                           // on an outside change reload and emit
