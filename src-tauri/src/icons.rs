//! Per-project icon discovery.
//!
//! A project can name a source folder (or default to ~/projects/<name>). We scan
//! that folder for the first icon-like asset in a fixed priority order, read it,
//! and hand the webview a `data:` URI it can render directly (the app runs with
//! CSP disabled, so an inline data URI is the simplest safe path — no filesystem
//! scope to widen). Discovery is best-effort: anything missing or unreadable
//! yields no icon, and the UI falls back to the colour dot.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;

/// Files larger than this are skipped — a project icon is a small mark, not a
/// photo, and a data URI this big would bloat every render that shows it.
const MAX_ICON_BYTES: u64 = 512 * 1024;

/// What the frontend needs to render (or fall back from) a project's icon.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIcon {
    /// The folder we actually looked in (the resolved guess, or the override).
    folder: String,
    /// Absolute path of the chosen asset, or null when none matched.
    icon_path: Option<String>,
    /// `data:<mime>;base64,...` for the chosen asset, or null.
    data_uri: Option<String>,
}

/// Concrete relative paths tried first, in order. Cheap exact hits before any
/// directory walking.
const EXACT_CANDIDATES: &[&str] = &[
    "public/favicon.svg",
    "public/apple-touch-icon.png",
    "public/favicon.png",
    "public/icon.svg",
    "favicon.svg",
    "favicon.png",
    "src-tauri/icons/128x128.png",
    "src-tauri/icons/icon.png",
];

/// Directories shallow-scanned (in order) for a `*logo*` / `*icon*` asset when no
/// exact candidate matched. Keeps discovery bounded — no recursive walk.
const SCAN_DIRS: &[&str] = &[
    "public/images",
    "public/icons",
    "resources/brand",
    "src/assets",
    "assets",
    "public",
    ".",
];

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// Resolve the folder to scan: an explicit override wins; otherwise
/// ~/projects/<name>. Returns None only when there is no override and no HOME.
fn resolve_folder(name: &str, folder: Option<&str>) -> Option<PathBuf> {
    match folder {
        Some(f) if !f.trim().is_empty() => Some(expand_tilde(f.trim())),
        _ => home_dir().map(|h| h.join("projects").join(name)),
    }
}

fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn mime_for(path: &Path) -> Option<&'static str> {
    match path.extension().and_then(|e| e.to_str())?.to_ascii_lowercase().as_str() {
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "ico" => Some("image/x-icon"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// True for a shallow-scan hit: a small image whose stem hints it's a logo/icon.
fn looks_like_icon(path: &Path) -> bool {
    if mime_for(path).is_none() {
        return false;
    }
    let stem = match path.file_stem().and_then(|s| s.to_str()) {
        Some(s) => s.to_ascii_lowercase(),
        None => return false,
    };
    stem.contains("logo") || stem.contains("icon") || stem == "mark" || stem.contains("-mark")
}

fn read_as_data_uri(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_ICON_BYTES {
        return None;
    }
    let mime = mime_for(path)?;
    let bytes = std::fs::read(path).ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

fn find_icon(folder: &Path) -> Option<PathBuf> {
    for rel in EXACT_CANDIDATES {
        let p = folder.join(rel);
        if p.is_file() {
            return Some(p);
        }
    }
    for dir in SCAN_DIRS {
        let d = folder.join(dir);
        let entries = match std::fs::read_dir(&d) {
            Ok(e) => e,
            Err(_) => continue,
        };
        // Collect + sort so the pick is stable across runs (read_dir order isn't).
        let mut hits: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file() && looks_like_icon(p))
            .collect();
        hits.sort();
        // Prefer SVG over raster within a directory — it scales to any dot size.
        if let Some(svg) = hits.iter().find(|p| mime_for(p) == Some("image/svg+xml")) {
            return Some(svg.clone());
        }
        if let Some(first) = hits.into_iter().next() {
            return Some(first);
        }
    }
    None
}

/// Discover a project's icon. `folder` mirrors the DB column: `None`/`null` and
/// empty are handled by the caller/JS (empty means "disabled" and never calls
/// here); a non-empty override is used verbatim.
#[tauri::command]
pub fn discover_project_icon(name: String, folder: Option<String>) -> ProjectIcon {
    let resolved = resolve_folder(&name, folder.as_deref());
    let folder_str = resolved
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (icon_path, data_uri) = match resolved.as_ref().and_then(|f| find_icon(f)) {
        Some(p) => {
            let uri = read_as_data_uri(&p);
            (Some(p.to_string_lossy().into_owned()), uri)
        }
        None => (None, None),
    };
    // If we found a path but couldn't read it (too big, race), drop the path too —
    // the frontend keys off data_uri, and a path with no data is just noise.
    let icon_path = if data_uri.is_some() { icon_path } else { None };
    ProjectIcon { folder: folder_str, icon_path, data_uri }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_folder_yields_no_icon_but_still_reports_the_path() {
        let r = discover_project_icon("definitely-not-a-real-project-xyz".into(), None);
        assert!(r.icon_path.is_none());
        assert!(r.data_uri.is_none());
        assert!(r.folder.ends_with("projects/definitely-not-a-real-project-xyz"));
    }

    #[test]
    fn override_folder_is_used_verbatim() {
        let r = discover_project_icon("anything".into(), Some("/tmp/no-such-dir-123".into()));
        assert_eq!(r.folder, "/tmp/no-such-dir-123");
    }

    #[test]
    fn found_icons_are_readable_data_uris() {
        // Best-effort against the developer's real ~/projects layout: if the folder
        // and an asset exist, discovery must return a well-formed data URI. Skips
        // (does not fail) when the layout isn't present, so CI stays green.
        for name in ["tildone", "zeno-logistics"] {
            let r = discover_project_icon(name.into(), None);
            if let Some(uri) = &r.data_uri {
                assert!(uri.starts_with("data:image/"), "{name}: {uri:.40}");
                assert!(uri.contains(";base64,"), "{name}: not base64");
                assert!(r.icon_path.is_some(), "{name}: uri without a path");
                eprintln!("{name}: {}", r.icon_path.as_deref().unwrap_or(""));
            } else {
                eprintln!("{name}: no icon (folder {})", r.folder);
            }
        }
    }
}
