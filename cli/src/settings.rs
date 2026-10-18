//! `settings`: read and change the app's settings, and run the Settings actions
//! (Claude hook, local AI engine). Reads and writes go through the hub's
//! `get_settings` / `update_settings`. With the app's server off, a write to a local
//! hub goes straight to `settings.json`, which the app re-reads within 2 s, so
//! turning Agent access on needs no person at the app.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::hub::{self, Fail, Hub, Res};
use crate::toon;

const IDENTIFIER: &str = "com.tildone.desktop";
const FILE_NAME: &str = "settings.json";

/// What a key accepts. Mirrors `appsettings::KEYS` in src-tauri.
enum Kind {
    Enum(&'static [&'static str]),
    Bool,
    /// A project id, or `none` to clear it.
    ProjectId,
    Text,
}

struct Key {
    name: &'static str,
    kind: Kind,
    /// What a missing key reads as; the app's `Settings::default`.
    default: fn() -> Value,
}

const THEMES: &[&str] = &["auto", "light", "dark"];
const WEEK_STARTS: &[&str] = &["monday", "sunday"];
const AI_MODES: &[&str] = &["off", "external", "builtin"];
const ENGINE_MODELS: &[&str] = &["small", "default", "better"];
const HOOK_ACTIONS: [&str; 3] = ["connect", "disconnect", "status"];
const ENGINE_ACTIONS: [&str; 5] = ["status", "install", "start", "stop", "delete"];

/// In display order, the same as `appsettings::KEYS`.
const KEYS: &[Key] = &[
    Key {
        name: "theme",
        kind: Kind::Enum(THEMES),
        default: || json!("auto"),
    },
    Key {
        name: "week_start",
        kind: Kind::Enum(WEEK_STARTS),
        default: || json!("monday"),
    },
    Key {
        name: "default_project_id",
        kind: Kind::ProjectId,
        default: || Value::Null,
    },
    Key {
        name: "ws_hub_url",
        kind: Kind::Text,
        default: || json!(""),
    },
    Key {
        name: "board_hub_url",
        kind: Kind::Text,
        default: || json!(""),
    },
    Key {
        name: "board_hub_token",
        kind: Kind::Text,
        default: || json!(""),
    },
    Key {
        name: "agent_server",
        kind: Kind::Bool,
        default: || json!(false),
    },
    Key {
        name: "agent_notify",
        kind: Kind::Bool,
        default: || json!(true),
    },
    Key {
        name: "ai_mode",
        kind: Kind::Enum(AI_MODES),
        default: || json!("off"),
    },
    Key {
        name: "ai_base_url",
        kind: Kind::Text,
        default: || json!(""),
    },
    Key {
        name: "ai_model",
        kind: Kind::Text,
        default: || json!(""),
    },
    Key {
        name: "ai_engine_model",
        kind: Kind::Enum(ENGINE_MODELS),
        default: || json!("default"),
    },
    Key {
        name: "ai_auto_start",
        kind: Kind::Bool,
        default: || json!(false),
    },
    Key {
        name: "ai_secretary",
        kind: Kind::Bool,
        default: || json!(true),
    },
];

const HELP: &str = "tildone-axi settings";

fn bad(msg: impl Into<String>) -> Fail {
    Fail::tool(msg, HELP)
}

fn find(name: &str) -> Res<&'static Key> {
    KEYS.iter().find(|k| k.name == name).ok_or_else(|| {
        let known: Vec<_> = KEYS.iter().map(|k| k.name).collect();
        bad(format!(
            "unknown setting `{name}`; known: {}",
            known.join(", ")
        ))
    })
}

/// The value as the hub's `update_settings` takes it. `none` becomes 0, which
/// clears `default_project_id`.
fn wire_value(key: &Key, raw: &str) -> Res<Value> {
    let name = key.name;
    match &key.kind {
        Kind::Enum(allowed) => {
            let v = raw.trim().to_lowercase();
            if allowed.contains(&v.as_str()) {
                Ok(json!(v))
            } else {
                Err(bad(format!(
                    "{name} must be one of: {}",
                    allowed.join(", ")
                )))
            }
        }
        Kind::Bool => match raw.trim().to_lowercase().as_str() {
            "true" | "on" => Ok(json!(true)),
            "false" | "off" => Ok(json!(false)),
            _ => Err(bad(format!("{name} must be true or false (or on / off)"))),
        },
        Kind::ProjectId => {
            let v = raw.trim();
            if v.eq_ignore_ascii_case("none") {
                return Ok(json!(0));
            }
            match v.parse::<i64>() {
                Ok(id) if id > 0 => Ok(json!(id)),
                _ => Err(bad(format!(
                    "{name} must be a project id (a whole number above 0), or none to clear it"
                ))),
            }
        }
        Kind::Text => Ok(json!(match name {
            "ws_hub_url" | "ai_base_url" | "board_hub_token" => raw.trim(),
            "board_hub_url" => raw.trim().trim_end_matches('/'),
            _ => raw,
        })),
    }
}

/// A value as shown to the agent: an unset project id reads `none`.
/// A token never reaches the terminal (and so an agent's transcript): it shows as
/// `(set)` or `(empty)`.
fn show(name: &str, v: &Value) -> String {
    if name == "default_project_id" && (v.is_null() || v == &json!(0)) {
        return toon::kv(name, &json!("none"));
    }
    if name.ends_with("_token") {
        let set = v.as_str().is_some_and(|s| !s.is_empty());
        return toon::kv(name, &json!(if set { "(set)" } else { "(empty)" }));
    }
    toon::kv(name, v)
}

fn say(text: &str) {
    println!("{}", text.trim_end());
}

/// `settings`: every setting as `key: value`.
pub async fn list() -> Res<()> {
    match Hub::connect().await {
        Ok(hub) => {
            let out = hub
                .call("get_settings", Map::new(), "tildone-axi doctor")
                .await;
            hub.close().await;
            let parsed: Value = serde_json::from_str(&out?).unwrap_or(Value::Null);
            let Some(all) = parsed.as_object() else {
                return Err(Fail::tool(
                    "the hub sent unreadable settings",
                    "tildone-axi doctor",
                ));
            };
            for (k, v) in all {
                say(&show(k, v));
            }
            Ok(())
        }
        Err(conn) => {
            if !local_hub() {
                return Err(conn);
            }
            let dir = config_dir()?;
            let file = read_file(&dir)?;
            let existed = dir.join(FILE_NAME).exists();
            for key in KEYS {
                let v = file.get(key.name).cloned().unwrap_or_else(key.default);
                say(&show(key.name, &v));
            }
            say(&format!(
                "note: Tildone is not running; read from {}{}",
                dir.join(FILE_NAME).display(),
                if existed {
                    " (missing keys show their defaults)"
                } else {
                    " (no file yet, so these are the defaults)"
                }
            ));
            Ok(())
        }
    }
}

/// `settings set <key> <value>`. Checks the key and value before any network call.
pub async fn set(name: &str, raw: &str) -> Res<()> {
    let key = find(name)?;
    let value = wire_value(key, raw)?;
    match Hub::connect().await {
        Ok(hub) => {
            let mut a = Map::new();
            a.insert(name.to_string(), value);
            let out = hub.call("update_settings", a, "tildone-axi settings").await;
            hub.close().await;
            let parsed: Value = serde_json::from_str(&out?).unwrap_or(Value::Null);
            let now = parsed
                .get("settings")
                .and_then(|s| s.get(name))
                .cloned()
                .unwrap_or(Value::Null);
            say(&show(name, &now));
            Ok(())
        }
        Err(conn) => {
            if !local_hub() {
                return Err(conn);
            }
            let dir = config_dir()?;
            // The file holds `null` for a cleared project; the hub takes 0.
            let stored = if key.name == "default_project_id" && value == json!(0) {
                Value::Null
            } else {
                value
            };
            write_file(&dir, name, stored.clone())?;
            say(&show(name, &stored));
            say(&format!(
                "note: wrote {}; it applies when Tildone starts, or within 2 s if it is running",
                dir.join(FILE_NAME).display()
            ));
            Ok(())
        }
    }
}

/// `settings hook <action>`: needs the running app.
pub async fn hook(action: &str) -> Res<()> {
    debug_assert!(HOOK_ACTIONS.contains(&action));
    run_action("claude_hook", "hook", json!({"action": action})).await
}

/// `settings engine <action> [model|file]`: needs the running app. install and
/// start take a model, delete takes a file name.
pub async fn engine(action: &str, arg: Option<&str>) -> Res<()> {
    debug_assert!(ENGINE_ACTIONS.contains(&action));
    let mut a = json!({"action": action});
    match (action, arg) {
        ("install" | "start", Some(model)) => {
            if !ENGINE_MODELS.contains(&model) {
                return Err(bad(format!(
                    "engine model must be one of: {}",
                    ENGINE_MODELS.join(", ")
                )));
            }
            a["model"] = json!(model);
        }
        ("delete", Some(file)) => a["file"] = json!(file),
        ("delete", None) => return Err(bad("engine delete needs a file name")),
        (_, None) => {}
        (_, Some(_)) => return Err(bad(format!("engine {action} takes no extra argument"))),
    }
    run_action("engine", "engine", a).await
}

/// How long an app action may run before the CLI stops waiting. Install downloads
/// the runtime and a model (about 1.3 GB for "default") inside the call; start waits
/// up to 60 s for the engine to be ready. Everything else answers at once.
fn action_limit(tool: &str, args: &Value) -> Duration {
    match (tool, args["action"].as_str()) {
        ("engine", Some("install")) => Duration::from_secs(60 * 60),
        ("engine", Some("start")) => Duration::from_secs(120),
        _ => Duration::from_secs(30),
    }
}

async fn run_action(tool: &str, verb: &str, args: Value) -> Res<()> {
    let hub = Hub::connect().await.map_err(|e| match e {
        Fail::Conn { msg, .. } => Fail::Conn {
            msg: format!("settings {verb} needs the running Tildone app, with Agent access On: {msg}"),
            help: "tildone-axi settings set agent_server true (works with the app closed or its server off)".into(),
        },
        other => other,
    })?;
    // TILDONE_ACTION_TIMEOUT_MS replaces every limit; the tests use it.
    let limit = std::env::var("TILDONE_ACTION_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .map(Duration::from_millis)
        .unwrap_or_else(|| action_limit(tool, &args));
    let Value::Object(a) = args else {
        unreachable!()
    };
    let out = hub.call_within(tool, a, HELP, limit).await;
    hub.close().await;
    match out {
        Ok(text) => {
            say(&text);
            Ok(())
        }
        // The hub answered earlier, so a timeout means the action is still going in
        // the app, not that the app is gone.
        Err(Fail::Conn { msg, .. }) if msg.ends_with(hub::TIMED_OUT) => Err(Fail::tool(
            format!(
                "settings {verb}: no answer within {} s, but the action is still running in Tildone",
                limit.as_secs().max(1)
            ),
            "tildone-axi settings engine status",
        )),
        Err(e) => Err(e),
    }
}

// ---- the local file ---------------------------------------------------------

/// True when `TILDONE_URL` is unset or points at this machine.
fn local_hub() -> bool {
    let url = hub::url();
    if std::env::var("TILDONE_URL").map_or(true, |u| u.trim().is_empty()) {
        return true;
    }
    let rest = url.split_once("://").map_or(url.as_str(), |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host_port = authority.rsplit('@').next().unwrap_or_default();
    let host = match host_port.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or_default(),
        None => host_port.split(':').next().unwrap_or_default(),
    };
    matches!(
        host.to_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1"
    )
}

/// The app's config dir: `TILDONE_CONFIG_DIR`, else the per-OS dir for the app's
/// identifier (where Tauri keeps `tildone.db` and `settings.json`).
fn config_dir() -> Res<PathBuf> {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    if let Some(d) = env("TILDONE_CONFIG_DIR") {
        return Ok(PathBuf::from(d));
    }
    let missing = |var: &str| {
        Fail::tool(
            format!("cannot find the Tildone config folder: {var} is not set"),
            "set TILDONE_CONFIG_DIR to the folder that holds tildone.db",
        )
    };
    let base = if cfg!(target_os = "macos") {
        PathBuf::from(env("HOME").ok_or_else(|| missing("HOME"))?)
            .join("Library")
            .join("Application Support")
    } else if cfg!(windows) {
        PathBuf::from(env("APPDATA").ok_or_else(|| missing("APPDATA"))?)
    } else {
        match env("XDG_CONFIG_HOME") {
            Some(x) => PathBuf::from(x),
            None => PathBuf::from(env("HOME").ok_or_else(|| missing("HOME"))?).join(".config"),
        }
    };
    Ok(base.join(IDENTIFIER))
}

/// The file as a JSON map. A missing file is empty; a file that is not a JSON
/// object is an error, so a write never replaces what it cannot read.
fn read_file(dir: &std::path::Path) -> Res<Map<String, Value>> {
    let path = dir.join(FILE_NAME);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => {
            return Err(bad(format!("cannot read {}: {e}", path.display())));
        }
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(bad(format!(
            "{} is not a JSON object; fix or remove it first",
            path.display()
        ))),
    }
}

/// Sets one key and keeps every other key, known or not. Writes a temp file in the
/// same folder, then renames it over `settings.json`, so the app never reads half a file.
fn write_file(dir: &std::path::Path, name: &str, value: Value) -> Res<()> {
    let mut map = read_file(dir)?;
    map.insert(name.to_string(), value);
    let text = serde_json::to_string_pretty(&Value::Object(map))
        .map_err(|e| bad(format!("cannot encode settings: {e}")))?;
    let path = dir.join(FILE_NAME);
    let tmp = dir.join(format!(".{FILE_NAME}.{}.tmp", std::process::id()));
    let io = |what: &str, e: std::io::Error| bad(format!("cannot {what}: {e}"));
    std::fs::create_dir_all(dir).map_err(|e| io(&format!("create {}", dir.display()), e))?;
    let written = std::fs::write(&tmp, text + "\n").and_then(|_| std::fs::rename(&tmp, &path));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(io(&format!("write {}", path.display()), e));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_install_and_start_get_a_long_limit() {
        let limit = |tool, action| action_limit(tool, &json!({ "action": action }));
        assert_eq!(limit("engine", "install"), Duration::from_secs(3600));
        assert_eq!(limit("engine", "start"), Duration::from_secs(120));
        for action in ["status", "stop", "delete"] {
            assert_eq!(limit("engine", action), Duration::from_secs(30));
        }
        assert_eq!(limit("claude_hook", "connect"), Duration::from_secs(30));
    }
}
