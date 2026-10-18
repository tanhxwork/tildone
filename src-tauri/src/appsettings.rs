//! The user's settings, owned by Rust in `settings.json` beside `tildone.db`.
//!
//! Every writer goes through here: the Settings dialog (`settings_set`), MCP's
//! `update_settings`, and `tildone-axi settings set`, which writes the file directly
//! when the app's server is off. Each change emits `settings-changed` with the full
//! settings, and the window applies its side effects (theme, Agent access, secretary).
//! UI layout state (collapsed groups, pane widths) is not a setting and stays in
//! the webview's localStorage.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};

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
                            _ => {
                                return Err(format!(
                                    "{key} must be a project id, or null to clear it"
                                ))
                            }
                        },
                        _ => {
                            return Err(format!("{key} must be a project id, or null to clear it"))
                        }
                    }
                }
                _ => {
                    return Err(format!(
                        "unknown setting {key:?}; known: {}",
                        KEYS.join(", ")
                    ))
                }
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
    value
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("{key} must be text"))
}

fn flag(key: &str, value: &Value) -> Result<bool, String> {
    value
        .as_bool()
        .ok_or_else(|| format!("{key} must be true or false"))
}

// ---------------------------------------------------------------------------
// File and state

/// `settings.json` in the app config dir, beside `tildone.db`.
pub fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(FILE_NAME))
}

/// Strict read: `Ok(None)` when the file is missing, `Err` when it cannot be read or
/// parsed. A value outside its allowed set falls back to the default, so a hand edit
/// cannot push the window into a state `apply_patch` would refuse.
fn read(path: &Path) -> Result<Option<Settings>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let mut s: Settings =
        serde_json::from_str(&text).map_err(|e| format!("cannot parse {}: {e}", path.display()))?;
    let d = Settings::default();
    if !THEMES.contains(&s.theme.as_str()) {
        s.theme = d.theme;
    }
    if !WEEK_STARTS.contains(&s.week_start.as_str()) {
        s.week_start = d.week_start;
    }
    if !AI_MODES.contains(&s.ai_mode.as_str()) {
        s.ai_mode = d.ai_mode;
    }
    if !ENGINE_MODELS.contains(&s.ai_engine_model.as_str()) {
        s.ai_engine_model = d.ai_engine_model;
    }
    Ok(Some(s))
}

/// Missing file: defaults. Unreadable or bad JSON: defaults, logged, and the bad file
/// is copied to `settings.json.bad` so the next save does not destroy it.
pub fn load(path: &Path) -> Settings {
    match read(path) {
        Ok(s) => s.unwrap_or_default(),
        Err(e) => {
            eprintln!("[settings] {e}; using defaults");
            let _ = std::fs::copy(path, path.with_extension("json.bad"));
            Settings::default()
        }
    }
}

/// Atomic: write a temp file in the same directory, then rename over the target, so a
/// reader (the CLI, the poll) never sees half a file.
pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    let dir = path.parent().ok_or("settings path has no directory")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let written = std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, path));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("cannot write {}: {e}", path.display()));
    }
    Ok(())
}

fn mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

struct Inner {
    settings: Settings,
    /// The file's mtime as of our last read or write. A different mtime means someone
    /// else wrote it.
    seen: Option<SystemTime>,
}

/// Managed state: the settings in memory and the file they came from. Every method
/// holds the lock across its file write, so the poll never reads our own half-done save.
pub struct Store {
    path: PathBuf,
    inner: Mutex<Inner>,
}

impl Store {
    pub fn open(path: PathBuf) -> Self {
        let settings = load(&path);
        let seen = mtime(&path);
        Self {
            path,
            inner: Mutex::new(Inner { settings, seen }),
        }
    }

    pub fn get(&self) -> Settings {
        self.inner.lock().unwrap().settings.clone()
    }

    /// Apply a patch and save. Returns the settings after it and the keys that changed;
    /// nothing is written when none did.
    pub fn set(&self, patch: &Map<String, Value>) -> Result<(Settings, Vec<String>), String> {
        let mut inner = self.inner.lock().unwrap();
        let mut next = inner.settings.clone();
        let changed = next.apply_patch(patch)?;
        if !changed.is_empty() {
            save(&self.path, &next)?;
            inner.seen = mtime(&self.path);
            inner.settings = next.clone();
        }
        Ok((next, changed))
    }

    /// Copy the window's old localStorage values in, once. Only keys the file itself
    /// lacks are filled, so a write made before the first upgraded launch (the CLI's)
    /// wins. A bad value is skipped. Returns `None` when `_migrated` was already set.
    pub fn migrate(&self, values: &Map<String, Value>) -> Result<Option<Settings>, String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.settings.migrated {
            return Ok(None);
        }
        let raw: Map<String, Value> = std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let mut next = inner.settings.clone();
        for (key, value) in values {
            if !KEYS.contains(&key.as_str()) || raw.contains_key(key) {
                continue;
            }
            let mut one = Map::new();
            one.insert(key.clone(), value.clone());
            let _ = next.apply_patch(&one);
        }
        next.migrated = true;
        save(&self.path, &next)?;
        inner.seen = mtime(&self.path);
        inner.settings = next.clone();
        Ok(Some(next))
    }

    /// One tick of the outside-write watch: `Some(settings)` when another process
    /// changed the file's content since we last looked. A file that does not parse
    /// (caught mid-write, or hand-edited badly) is ignored until it changes again.
    pub fn poll(&self) -> Option<Settings> {
        let mut inner = self.inner.lock().unwrap();
        let now = mtime(&self.path);
        if now == inner.seen {
            return None;
        }
        inner.seen = now;
        match read(&self.path) {
            Ok(Some(next)) if next != inner.settings => {
                inner.settings = next.clone();
                Some(next)
            }
            Ok(_) => None,
            Err(e) => {
                eprintln!("[settings] {e}; keeping the current settings");
                None
            }
        }
    }
}

fn store(app: &AppHandle) -> tauri::State<'_, Store> {
    app.state::<Store>()
}

fn emit(app: &AppHandle, settings: &Settings) {
    let _ = app.emit(SETTINGS_CHANGED, settings.public());
}

/// Public view of the current settings, for the commands and MCP.
pub fn get(app: &AppHandle) -> Map<String, Value> {
    store(app).get().public()
}

/// Apply a patch, save, and tell the window. Returns the public settings and the keys
/// that changed. The shared path for `settings_set` and MCP's `update_settings`.
pub fn set(
    app: &AppHandle,
    patch: &Map<String, Value>,
) -> Result<(Map<String, Value>, Vec<String>), String> {
    let (settings, changed) = store(app).set(patch)?;
    if !changed.is_empty() {
        emit(app, &settings);
    }
    Ok((settings.public(), changed))
}

#[tauri::command]
pub fn settings_get(app: AppHandle) -> Map<String, Value> {
    get(&app)
}

#[tauri::command]
pub fn settings_set(
    app: AppHandle,
    patch: Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    set(&app, &patch).map(|(settings, _)| settings)
}

#[tauri::command]
pub fn settings_migrate(
    app: AppHandle,
    values: Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    match store(&app).migrate(&values)? {
        Some(settings) => {
            emit(&app, &settings);
            Ok(settings.public())
        }
        None => Ok(get(&app)),
    }
}

/// Load the file into managed state, then watch it: every 2 s a changed mtime makes
/// the store re-read, and a real content change replaces the state and emits.
pub fn init(app: &AppHandle) {
    match path(app) {
        Ok(p) => {
            app.manage(Store::open(p));
        }
        Err(e) => {
            eprintln!("[settings] no config dir: {e}");
            // Keep the commands working (in memory only) rather than panicking.
            app.manage(Store::open(
                std::env::temp_dir()
                    .join("tildone-settings")
                    .join(FILE_NAME),
            ));
        }
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        if let Some(settings) = store(&app).poll() {
            emit(&app, &settings);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dir(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("tildone-appsettings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn patch(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    /// Stamp the file as written at `secs` so a test never depends on clock granularity.
    fn touch(path: &Path, secs: u64) {
        let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(secs))
            .unwrap();
    }

    #[test]
    fn missing_or_broken_file_loads_defaults_and_unknown_keys_survive() {
        let d = dir("load");
        let p = d.join(FILE_NAME);
        assert_eq!(load(&p), Settings::default());

        std::fs::write(&p, "{not json").unwrap();
        assert_eq!(load(&p), Settings::default());
        assert!(
            d.join("settings.json.bad").exists(),
            "the broken file is kept aside"
        );

        std::fs::write(&p, r#"{"theme":"dark","from_the_future":{"a":1}}"#).unwrap();
        let s = load(&p);
        assert_eq!(s.theme, "dark");
        assert_eq!(s.week_start, "monday", "a missing key takes its default");
        save(&p, &s).unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(saved["from_the_future"], json!({"a": 1}));
        let left: Vec<_> = std::fs::read_dir(&d)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert!(
            !left.iter().any(|n| n.to_string_lossy().ends_with(".tmp")),
            "no temp left: {left:?}"
        );
    }

    #[test]
    fn a_hand_edited_value_outside_its_set_falls_back_to_the_default() {
        let d = dir("sanitize");
        let p = d.join(FILE_NAME);
        std::fs::write(&p, r#"{"theme":"purple","ai_mode":"builtin"}"#).unwrap();
        let s = load(&p);
        assert_eq!(s.theme, "auto");
        assert_eq!(s.ai_mode, "builtin");
    }

    #[test]
    fn apply_patch_errors_name_the_allowed_values_and_apply_nothing() {
        let mut s = Settings::default();
        let e = s
            .apply_patch(&patch(json!({"agent_notify": false, "theme": "neon"})))
            .unwrap_err();
        assert!(e.contains("auto, light, dark"), "{e}");
        assert_eq!(
            s,
            Settings::default(),
            "the valid half of a bad patch is not applied"
        );
        let e = s.apply_patch(&patch(json!({"nope": 1}))).unwrap_err();
        assert!(
            e.contains("week_start"),
            "an unknown key lists the known ones: {e}"
        );
        let e = s
            .apply_patch(&patch(json!({"agent_server": "yes"})))
            .unwrap_err();
        assert!(e.contains("true or false"), "{e}");
    }

    #[test]
    fn default_project_id_zero_or_null_clears_it() {
        let mut s = Settings::default();
        assert_eq!(
            s.apply_patch(&patch(json!({"default_project_id": 7})))
                .unwrap(),
            ["default_project_id"]
        );
        assert_eq!(s.default_project_id, Some(7));
        assert_eq!(
            s.apply_patch(&patch(json!({"default_project_id": 0})))
                .unwrap(),
            ["default_project_id"]
        );
        assert_eq!(s.default_project_id, None);
        s.default_project_id = Some(3);
        s.apply_patch(&patch(json!({"default_project_id": null})))
            .unwrap();
        assert_eq!(s.default_project_id, None);
        assert!(s
            .apply_patch(&patch(json!({"default_project_id": -2})))
            .is_err());
    }

    #[test]
    fn set_saves_and_reports_changed_keys_only() {
        let d = dir("set");
        let store = Store::open(d.join(FILE_NAME));
        let (s, changed) = store
            .set(&patch(json!({"theme": "dark", "week_start": "monday"})))
            .unwrap();
        assert_eq!(changed, ["theme"], "week_start was already monday");
        assert_eq!(s.theme, "dark");
        assert_eq!(load(&d.join(FILE_NAME)).theme, "dark");
        let (_, changed) = store.set(&patch(json!({"theme": "dark"}))).unwrap();
        assert!(changed.is_empty());
    }

    #[test]
    fn migrate_fills_only_keys_absent_from_the_file_then_is_a_no_op() {
        let d = dir("migrate");
        let p = d.join(FILE_NAME);
        // The CLI wrote theme before the first upgraded launch; no _migrated.
        std::fs::write(&p, r#"{"theme":"dark"}"#).unwrap();
        let store = Store::open(p.clone());
        let old = patch(json!({
            "theme": "light",
            "week_start": "sunday",
            "ai_mode": "bogus",
            "agent_notify": false,
            "_migrated": false,
        }));
        let s = store.migrate(&old).unwrap().expect("first migrate runs");
        assert_eq!(s.theme, "dark", "a key the file has wins");
        assert_eq!(s.week_start, "sunday");
        assert!(!s.agent_notify);
        assert_eq!(
            s.ai_mode, "off",
            "an invalid old value is skipped, not an error"
        );
        assert!(load(&p).migrated);

        assert!(store
            .migrate(&patch(json!({"week_start": "monday"})))
            .unwrap()
            .is_none());
        assert_eq!(store.get().week_start, "sunday");
    }

    #[test]
    fn poll_sees_an_outside_write_once_and_ignores_our_own_and_bad_ones() {
        let d = dir("poll");
        let p = d.join(FILE_NAME);
        let store = Store::open(p.clone());
        assert!(store.poll().is_none(), "nothing changed");

        // Our own write does not come back as an outside change.
        store.set(&patch(json!({"theme": "light"}))).unwrap();
        assert!(store.poll().is_none());

        // Another process writes.
        std::fs::write(&p, r#"{"theme":"dark","_migrated":true}"#).unwrap();
        touch(&p, 1_000);
        let s = store.poll().expect("outside write is picked up");
        assert_eq!(s.theme, "dark");
        assert_eq!(store.get().theme, "dark");
        assert!(store.poll().is_none(), "reported once");

        // Same content, new mtime: no event.
        touch(&p, 2_000);
        assert!(store.poll().is_none());

        // A half-written file is ignored and the state is kept.
        std::fs::write(&p, "{\"theme\":").unwrap();
        touch(&p, 3_000);
        assert!(store.poll().is_none());
        assert_eq!(store.get().theme, "dark");
    }
}
