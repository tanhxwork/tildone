//! Client mode, offline: the outbox of queued operations and the copy of the last
//! synced board, kept as JSON files in the app data dir so both survive a restart.
//! The webview names the file but never gives a path, and only these two names exist.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// The files the webview may read and write (`<name>.json` in the app data dir).
const NAMES: [&str; 2] = ["outbox", "board-copy"];

fn file(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if !NAMES.contains(&name) {
        return Err(format!("unknown offline file {name}"));
    }
    Ok(dir.join(format!("{name}.json")))
}

fn read_in(dir: &Path, name: &str) -> Result<Option<String>, String> {
    let path = file(dir, name)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Atomic like appsettings::save: a temp file in the same directory, renamed over the
/// target, so a crash mid-write leaves the old file whole.
fn write_in(dir: &Path, name: &str, json: &str) -> Result<(), String> {
    let path = file(dir, name)?;
    serde_json::from_str::<serde_json::Value>(json).map_err(|e| format!("not JSON: {e}"))?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let written = std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, &path));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("cannot write {}: {e}", path.display()));
    }
    Ok(())
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// The file's JSON text, or null when it was never written.
#[tauri::command]
pub fn offline_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    read_in(&data_dir(&app)?, &name)
}

#[tauri::command]
pub fn offline_write(app: AppHandle, name: String, json: String) -> Result<(), String> {
    write_in(&data_dir(&app)?, &name, &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("tildone-offlinestore-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn a_missing_file_reads_as_null_and_a_write_replaces_it_whole() {
        let d = dir("roundtrip");
        assert_eq!(read_in(&d, "outbox").unwrap(), None);
        write_in(&d, "outbox", r#"{"ops":[1,2,3]}"#).unwrap();
        write_in(&d, "outbox", r#"{"ops":[]}"#).unwrap();
        assert_eq!(read_in(&d, "outbox").unwrap().as_deref(), Some(r#"{"ops":[]}"#));
        // No temp file is left behind.
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1);
    }

    #[test]
    fn only_the_two_names_and_only_json_are_accepted() {
        let d = dir("refused");
        for name in ["settings", "../outbox", "outbox.json", ""] {
            assert!(read_in(&d, name).is_err(), "{name:?}");
            assert!(write_in(&d, name, "{}").is_err(), "{name:?}");
        }
        assert!(write_in(&d, "board-copy", "{half a file").is_err());
        assert_eq!(read_in(&d, "board-copy").unwrap(), None);
    }
}
