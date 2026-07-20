//! Reading files the user dragged in from the OS.
//!
//! The webview cannot be given a filesystem read scope wide enough to cover
//! "wherever the user dragged that image from" — `$HOME/**` would hand every
//! line of renderer code standing read access to SSH keys, `.env` files and
//! `~/Library`, for a capability that is only ever needed for the handful of
//! paths in one drop gesture (found by the TIL-110 review pass).
//!
//! So the grant follows the gesture instead of the directory: Rust watches the
//! window's own drag-drop events, remembers exactly the paths the OS delivered,
//! and `read_dropped_image` serves only those, only briefly.
//!
//! What this does NOT do — do not read the above as "the webview cannot touch
//! the filesystem". Tauri core handles `DragDropEvent::Drop` before any of this
//! runs and adds every dropped path to the fs plugin's *runtime* scope, with no
//! expiry, recursively for a directory. The capability file still grants
//! `fs:allow-read-text-file` / `fs:allow-write-text-file` unscoped (settings
//! import/export uses them), so after the user drags a folder in, renderer code
//! can read and write text files anywhere under that folder for the rest of the
//! process. That is far narrower than the `$HOME/**` standing grant this
//! replaced, but it is not nothing, and closing it means moving settings
//! import/export off the fs plugin too. Tracked as a follow-up.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a dropped path stays readable. Long enough for the webview to
/// decode and downscale a large image, far too short to be a standing grant.
const DROP_TTL: Duration = Duration::from_secs(30);

/// Refuse anything larger than the webview's own per-image ceiling
/// (MAX_IMAGE_BYTES in src/utils/images.ts) before it is ever read into memory.
const MAX_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Default)]
pub struct DroppedPaths(Mutex<HashMap<PathBuf, Instant>>);

impl DroppedPaths {
    /// Record the paths of one drop and forget any that have aged out.
    pub fn remember(&self, paths: &[PathBuf]) {
        let Ok(mut map) = self.0.lock() else { return };
        let now = Instant::now();
        map.retain(|_, at| now.duration_since(*at) < DROP_TTL);
        for path in paths {
            map.insert(path.clone(), now);
        }
    }

    fn is_fresh(&self, path: &PathBuf) -> bool {
        let Ok(map) = self.0.lock() else { return false };
        map.get(path)
            .is_some_and(|at| Instant::now().duration_since(*at) < DROP_TTL)
    }
}

/// Machine-readable marker for the one failure the UI words differently. Matching
/// on prose would break the moment the message is reworded, and every unmatched
/// error is reported to the user as "couldn't read" — so a drifted match silently
/// mislabels an over-size file.
pub const ERR_TOO_LARGE: &str = "E_TOO_LARGE";

/// Read one image the user just dropped. Every other error is a string the UI
/// reports as "couldn't read"; io messages are used as-is and carry no path.
#[tauri::command]
pub fn read_dropped_image(
    state: tauri::State<'_, DroppedPaths>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let path = PathBuf::from(&path);
    if !state.is_fresh(&path) {
        return Err("not a recently dropped path".into());
    }
    // Re-stat here rather than trusting a size the caller checked earlier: the
    // file could have been swapped between the two calls.
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_BYTES {
        return Err(ERR_TOO_LARGE.into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(ERR_TOO_LARGE.into());
    }
    Ok(tauri::ipc::Response::new(bytes))
}
