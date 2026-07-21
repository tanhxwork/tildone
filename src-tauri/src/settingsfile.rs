//! Settings import/export file I/O.
//!
//! These two commands exist so the webview never needs `fs:allow-read-text-file`
//! / `fs:allow-write-text-file`, which were the last unscoped filesystem grants
//! in the capability file. Unscoped mattered because Tauri core adds every path
//! the user drops onto the window to the fs plugin's runtime scope — with no
//! expiry, and recursively for a directory — so after one folder drop the
//! renderer could read and write text files anywhere under that tree for the
//! rest of the process (TIL-141).
//!
//! The dialog is driven from Rust rather than from JS, which is the part that
//! actually removes the capability: the renderer supplies only *content*, never
//! a path, so there is no path for it to forge. The only files reachable are
//! ones the user picked in a native panel during this call.

use tauri::Runtime;
use tauri_plugin_dialog::DialogExt;

/// Ask for a destination and write `content` there. Returns the chosen path, or
/// `None` when the user cancelled.
#[tauri::command]
pub async fn export_settings_file<R: Runtime>(
    app: tauri::AppHandle<R>,
    default_name: String,
    extension: String,
    content: String,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter(extension.to_uppercase(), &[extension.as_str()])
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    let Some(path) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;

    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Ask for a file and return its path and contents, or `None` when cancelled.
#[tauri::command]
pub async fn import_settings_file<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<(String, String)>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Tildone import", &["json", "csv"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });

    let Some(path) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;

    // An import file is a hand-sized document; refusing something absurd beats
    // reading a multi-gigabyte file into the webview as a string.
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    const MAX_BYTES: u64 = 64 * 1024 * 1024;
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "file is {} MB — imports are limited to {} MB",
            meta.len() / (1024 * 1024),
            MAX_BYTES / (1024 * 1024)
        ));
    }

    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(Some((path.to_string_lossy().into_owned(), text)))
}
