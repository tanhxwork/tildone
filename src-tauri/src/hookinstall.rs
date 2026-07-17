//! Installing (and removing) the Claude Code heartbeat hook.
//!
//! This module edits a file that is **not ours**: `~/.claude/settings.json`. It may be
//! version-controlled, shared across machines, hand-written, and full of hooks the
//! user cares about far more than ours. Every rule below follows from that:
//!
//! - **Additive.** Append to an event's hook array; never replace one.
//! - **Idempotent.** Installing twice leaves one entry.
//! - **Reversible.** Uninstall removes exactly what we added and nothing else.
//! - **Never corrupts.** Malformed JSON → refuse and change nothing. Writes go to a
//!   temp file and are renamed, so a crash mid-write cannot truncate the file.
//! - **Backed up** before the first write.
//!
//! The counter-example is on this very machine: Herdr's installed hook announces
//! "managed by herdr; reinstalling or updating the integration overwrites this file",
//! and its dead entries still sit in the user's settings long after they stopped using
//! it. An uninstall that works is part of the feature, not a nicety.

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// The hook script's stable home.
///
/// Copied out of the app bundle rather than referenced inside it: `/Applications`
/// contents are replaced wholesale on upgrade, and a settings entry pointing into a
/// bundle path would silently rot.
fn script_path(home: &Path) -> PathBuf {
    home.join(".claude").join("tildone-heartbeat.sh")
}

fn settings_path(home: &Path) -> PathBuf {
    home.join(".claude").join("settings.json")
}

/// (event, action) pairs. `PreToolUse` fires on every tool call — that is the pulse.
///
/// There is no "release" event here, and there cannot be: SessionEnd does not fire on
/// a crash, a kill -9, or a closed terminal. `Stop`/`SessionEnd` only make a card go
/// quiet *promptly*; the PID check is what makes it go quiet *correctly*.
const HOOKS: [(&str, &str); 4] = [
    ("PreToolUse", "working"),
    ("PermissionRequest", "blocked"),
    ("Stop", "idle"),
    ("SessionEnd", "idle"),
];

#[derive(serde::Serialize)]
pub struct HookStatus {
    installed: bool,
    script: String,
    settings: String,
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "cannot locate your home directory".to_string())
}

/// The command string for one action. Quoted: a home directory may contain spaces.
fn command_for(home: &Path, action: &str) -> String {
    format!("sh '{}' {}", script_path(home).display(), action)
}

/// Ours iff the command mentions our script path. This is the ONLY predicate used to
/// decide what to remove, which is what keeps uninstall from touching anyone else's
/// hooks — including another tool that happens to run on the same events.
fn is_ours(entry: &Value, home: &Path) -> bool {
    let needle = script_path(home).display().to_string();
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .map(|hooks| {
            hooks.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| c.contains(&needle))
            })
        })
        .unwrap_or(false)
}

fn read_settings(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let raw = std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    // Refuse rather than repair. A settings file we cannot parse is one we must not
    // rewrite: whatever is in there is the user's, and our best guess at their intent
    // is worth less than their file.
    serde_json::from_str(&raw).map_err(|e| {
        format!(
            "{} is not valid JSON ({e}). Tildone has changed nothing — fix the file and try again.",
            path.display()
        )
    })
}

/// Write via temp file + rename, so an interrupted write cannot leave the user with a
/// truncated settings file.
fn write_settings(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("settings path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    let body = serde_json::to_string_pretty(value).map_err(|e| format!("cannot serialise settings: {e}"))?;
    let tmp = path.with_extension("json.tildone-tmp");
    std::fs::write(&tmp, body + "\n").map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
}

fn hooks_map(settings: &mut Value) -> &mut Map<String, Value> {
    if !settings.is_object() {
        *settings = json!({});
    }
    let obj = settings.as_object_mut().expect("settings is an object");
    obj.entry("hooks").or_insert_with(|| json!({}));
    if !obj["hooks"].is_object() {
        obj["hooks"] = json!({});
    }
    obj["hooks"].as_object_mut().expect("hooks is an object")
}

/// Add our entries to `settings`, leaving every other hook untouched. Returns the
/// number of entries added (0 when already installed).
fn add_hooks(settings: &mut Value, home: &Path) -> usize {
    let hooks = hooks_map(settings);
    let mut added = 0;
    for (event, action) in HOOKS {
        let list = hooks.entry(event).or_insert_with(|| json!([]));
        if !list.is_array() {
            *list = json!([]);
        }
        let arr = list.as_array_mut().expect("event list is an array");
        // Idempotent: our entry for this event may already be here.
        if arr.iter().any(|e| is_ours(e, home)) {
            continue;
        }
        arr.push(json!({
            "matcher": "*",
            "hooks": [{
                "type": "command",
                "command": command_for(home, action),
                // Short: this runs before every tool call, and a hook that hangs
                // stalls Claude's loop. The script bails on its own well inside this.
                "timeout": 5,
            }],
        }));
        added += 1;
    }
    added
}

/// Remove our entries, and only ours. Returns the number removed.
fn remove_hooks(settings: &mut Value, home: &Path) -> usize {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return 0;
    };
    let mut removed = 0;
    for (_event, list) in hooks.iter_mut() {
        let Some(arr) = list.as_array_mut() else { continue };
        let before = arr.len();
        arr.retain(|e| !is_ours(e, home));
        removed += before - arr.len();
    }
    // Prune event keys we emptied.
    //
    // Installing creates `PermissionRequest: []` / `SessionEnd: []` on a settings file
    // that had no such events. Leaving those behind on uninstall would be Tildone
    // littering a file it does not own — the exact habit that leaves dead hooks in
    // people's settings long after they drop a tool.
    //
    // The honest caveat: a user who had an explicitly empty `PreToolUse: []` before
    // installing loses that empty key. It is semantically identical (no hooks either
    // way) and is the better trade — leaving our own debris to preserve someone's
    // empty array is the wrong way round.
    hooks.retain(|_event, list| !matches!(list.as_array(), Some(a) if a.is_empty()));
    if hooks.is_empty() {
        if let Some(obj) = settings.as_object_mut() {
            obj.remove("hooks");
        }
    }
    removed
}

// ---------------------------------------------------------------------------
// Commands

#[tauri::command]
pub fn hook_status() -> Result<HookStatus, String> {
    let home = home_dir()?;
    let settings = read_settings(&settings_path(&home)).unwrap_or_else(|_| json!({}));
    let installed = settings
        .get("hooks")
        .and_then(Value::as_object)
        .map(|hooks| {
            hooks
                .values()
                .filter_map(Value::as_array)
                .any(|arr| arr.iter().any(|e| is_ours(e, &home)))
        })
        .unwrap_or(false);
    Ok(HookStatus {
        installed,
        script: script_path(&home).display().to_string(),
        settings: settings_path(&home).display().to_string(),
    })
}

/// Install the hook: copy the script out of the bundle, then add the settings entries.
#[tauri::command]
pub fn hook_install(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let home = home_dir()?;
    let script = script_path(&home);

    let src = app
        .path()
        .resolve("resources/tildone-heartbeat.sh", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("cannot find the bundled hook script: {e}"))?;
    let body = std::fs::read(&src).map_err(|e| format!("cannot read {}: {e}", src.display()))?;
    if let Some(parent) = script.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    std::fs::write(&script, body).map_err(|e| format!("cannot write {}: {e}", script.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("cannot make {} executable: {e}", script.display()))?;
    }

    let path = settings_path(&home);
    let mut settings = read_settings(&path)?;
    // Back up before the first write. Their file, their safety net.
    if path.exists() {
        let backup = path.with_extension("json.tildone-backup");
        let _ = std::fs::copy(&path, &backup);
    }
    let added = add_hooks(&mut settings, &home);
    write_settings(&path, &settings)?;
    Ok(if added == 0 {
        "Already connected — no changes made.".to_string()
    } else {
        format!("Connected. Added {added} hook(s) to {}.", path.display())
    })
}

#[tauri::command]
pub fn hook_uninstall() -> Result<String, String> {
    let home = home_dir()?;
    let path = settings_path(&home);
    let mut settings = read_settings(&path)?;
    let removed = remove_hooks(&mut settings, &home);
    if removed > 0 {
        write_settings(&path, &settings)?;
    }
    let _ = std::fs::remove_file(script_path(&home));
    Ok(if removed == 0 {
        "Not connected — no changes made.".to_string()
    } else {
        format!("Disconnected. Removed {removed} hook(s).")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/Users/test")
    }

    /// Hooks belonging to someone else, on the very events we also want.
    fn foreign_settings() -> Value {
        json!({
            "hooks": {
                "PreToolUse": [
                    { "matcher": "AskUserQuestion",
                      "hooks": [{ "type": "command", "command": "afplay /System/Library/Sounds/Glass.aiff" }] },
                    { "matcher": "*",
                      "hooks": [{ "type": "command", "command": "bash '/Users/test/.claude/hooks/herdr-agent-state.sh' working", "timeout": 10 }] }
                ],
                "Stop": [
                    { "matcher": "", "hooks": [{ "type": "command", "command": "afplay /System/Library/Sounds/Sosumi.aiff" }] }
                ]
            },
            "env": { "SOMETHING": "else" }
        })
    }

    #[test]
    fn install_appends_and_leaves_every_other_hook_untouched() {
        let mut s = foreign_settings();
        let before = s.clone();
        assert_eq!(add_hooks(&mut s, &home()), 4);

        let pre = s["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 3, "our entry is appended, theirs are kept");
        assert_eq!(pre[0], before["hooks"]["PreToolUse"][0], "the sound hook is byte-identical");
        assert_eq!(pre[1], before["hooks"]["PreToolUse"][1], "herdr's hook is byte-identical");
        assert!(is_ours(&pre[2], &home()));

        let stop = s["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0], before["hooks"]["Stop"][0]);

        assert_eq!(s["env"], before["env"], "unrelated settings are untouched");
    }

    #[test]
    fn installing_twice_adds_nothing_the_second_time() {
        let mut s = foreign_settings();
        assert_eq!(add_hooks(&mut s, &home()), 4);
        let after_first = s.clone();
        assert_eq!(add_hooks(&mut s, &home()), 0, "idempotent");
        assert_eq!(s, after_first, "a second install is a no-op, byte for byte");
    }

    #[test]
    fn uninstall_restores_the_file_exactly() {
        // The property Herdr's installer does not have, and the reason its dead hooks
        // are still sitting in this user's settings.
        let original = foreign_settings();
        let mut s = original.clone();
        add_hooks(&mut s, &home());
        assert_ne!(s, original);
        let removed = remove_hooks(&mut s, &home());
        assert_eq!(removed, 4);
        assert_eq!(s, original, "uninstall must restore the file exactly");
    }

    #[test]
    fn uninstall_touches_nothing_when_we_were_never_installed() {
        let mut s = foreign_settings();
        assert_eq!(remove_hooks(&mut s, &home()), 0);
        assert_eq!(s, foreign_settings());
    }

    #[test]
    fn install_works_on_a_settings_file_with_no_hooks_at_all() {
        let mut s = json!({ "model": "opus" });
        assert_eq!(add_hooks(&mut s, &home()), 4);
        assert_eq!(s["model"], "opus");
        assert_eq!(s["hooks"]["PreToolUse"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn install_works_from_nothing() {
        let mut s = json!({});
        assert_eq!(add_hooks(&mut s, &home()), 4);
        for (event, _) in HOOKS {
            assert!(s["hooks"][event].is_array(), "{event} must exist");
        }
    }

    #[test]
    fn malformed_settings_are_refused_not_repaired() {
        let dir = std::env::temp_dir().join(format!("tildone-hooktest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, "{ this is not json ").unwrap();
        let err = read_settings(&path).unwrap_err();
        assert!(err.contains("not valid JSON"));
        assert!(err.contains("changed nothing"), "the error must say the file is untouched");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{ this is not json ",
            "the user's file must be exactly as they left it"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_settings_file_is_treated_as_empty_settings() {
        let dir = std::env::temp_dir().join(format!("tildone-hookempty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, "\n  \n").unwrap();
        assert_eq!(read_settings(&path).unwrap(), json!({}));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_home_with_spaces_is_quoted() {
        let weird = PathBuf::from("/Users/my name");
        let cmd = command_for(&weird, "working");
        assert!(cmd.contains("'/Users/my name/.claude/tildone-heartbeat.sh'"), "got: {cmd}");
    }

    #[test]
    fn every_hook_event_maps_to_a_valid_action() {
        // The script exits 0 on anything else, so a typo here would silently disable
        // presence rather than fail loudly.
        for (_event, action) in HOOKS {
            assert!(matches!(action, "working" | "idle" | "blocked"), "bad action: {action}");
        }
    }

    #[test]
    fn write_is_atomic_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("tildone-hookwrite-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        write_settings(&path, &json!({"a": 1})).unwrap();
        assert_eq!(read_settings(&path).unwrap(), json!({"a": 1}));
        assert!(!path.with_extension("json.tildone-tmp").exists(), "the temp file must be renamed away");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
