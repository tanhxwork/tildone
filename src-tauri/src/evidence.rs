//! Serving the evidence an agent named in prose.
//!
//! Notes and progress lines are agent-writable over MCP, and the UI now turns
//! the paths in them into clicks. Previewing a screenshot inline therefore must
//! not become a general read primitive: widening `assetProtocol.scope` to
//! `$HOME/**` would let anything running in the webview — including content an
//! agent wrote — fetch `~/.ssh/id_rsa` and read the bytes back.
//!
//! So the grant follows the file type, not the directory (the same shape
//! `drops.rs` uses for dragged-in images): this command reads *only* a raster
//! image, *only* under `$HOME`, *only* up to a size a viewer can plausibly
//! want, and the path is canonicalised first so a symlink cannot point out.

use std::path::{Path, PathBuf};

/// Formats the lightbox can display. `svg` is deliberately absent: it is a
/// script-bearing document, and the UI reveals those in Finder instead of
/// rendering them (REVEAL_ONLY_EXTENSIONS in src/utils/links.ts).
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];

/// Generous for a screenshot, far below anything that would wedge the webview.
const MAX_BYTES: u64 = 25 * 1024 * 1024;

/// The user's home, canonicalised. Every readable path must be inside it —
/// which is also the scope `opener:allow-open-path` grants, so the click that
/// opens a file and the click that previews it obey the same boundary.
fn home_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    std::fs::canonicalize(PathBuf::from(home)).ok()
}

/// Open an already-canonical path without ever following a symlink — at *any*
/// component, not just the last.
///
/// This is the fourth attempt at one problem, and the first that doesn't rest on
/// a name. Canonicalising and then opening is two resolutions, and everything in
/// between is the attacker's: swap the file (defeated `O_NOFOLLOW` alone), swap a
/// parent directory (defeated the descriptor's path), or race the canonicalise
/// against the `metadata` call so the identity recorded is already the wrong
/// file's (defeated device+inode — sixth Codex verify pass on TIL-203).
///
/// Walking the path component by component with `O_NOFOLLOW` closes it, and
/// costs nothing honest: `canonicalize` returns a symlink-free path by
/// definition, so the only way a component can be a symlink here is that someone
/// made it one after the check — which is exactly the case to refuse.
#[cfg(unix)]
fn open_beneath(canonical: &Path) -> Result<std::fs::File, String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::FromRawFd;

    let names: Vec<&std::ffi::OsStr> = canonical
        .components()
        .skip(1) // the leading "/", opened below as the walk's root
        .map(|c| c.as_os_str())
        .collect();
    if names.is_empty() {
        return Err("not a file".into());
    }

    let root = CString::new("/").unwrap();
    let mut dir = unsafe { libc::open(root.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY) };
    if dir < 0 {
        return Err("cannot open the root directory".into());
    }

    for (i, name) in names.iter().enumerate() {
        let last = i + 1 == names.len();
        let c = match CString::new(name.as_bytes()) {
            Ok(c) => c,
            Err(_) => {
                unsafe { libc::close(dir) };
                return Err("not a usable path".into());
            }
        };
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | if last { libc::O_NONBLOCK } else { libc::O_DIRECTORY };
        let next = unsafe { libc::openat(dir, c.as_ptr(), flags) };
        unsafe { libc::close(dir) };
        if next < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        dir = next;
    }
    Ok(unsafe { std::fs::File::from_raw_fd(dir) })
}

/// Windows has neither `openat` nor `O_NOFOLLOW` on stable Rust; it opens by
/// name and re-checks it. Weaker, and recorded as such in the spec — creating a
/// symlink there needs privilege by default.
#[cfg(not(unix))]
fn open_beneath(canonical: &Path) -> Result<std::fs::File, String> {
    std::fs::File::open(canonical).map_err(|e| e.to_string())
}

/// Vet one evidence path and hand back an open handle to the file it named.
///
/// One function, because the gap between checking and opening is where every
/// previous version of this guard was defeated. The name is resolved once
/// (`canonicalize`, which settles `..` and symlinks), judged for containment and
/// type, and then opened by walking that canonical path with `O_NOFOLLOW` at
/// every component — so anything that changes underneath fails the open rather
/// than redirecting it. Size and bytes come from the handle, never from a second
/// look at the name.
fn open_vetted(path: &Path, home: &Path) -> Result<std::fs::File, String> {
    let real = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !real.starts_with(home) {
        return Err("outside the home directory".into());
    }
    let ext = real
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err("not a previewable image".into());
    }
    let file = open_beneath(&real)?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_BYTES {
        return Err("too large to preview".into());
    }
    Ok(file)
}

/// The bytes of a vetted handle, bounded regardless of what it turns out to
/// hold — `take` caps the allocation rather than trusting the size just read.
fn read_vetted(mut file: std::fs::File) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("too large to preview".into());
    }
    Ok(bytes)
}

/// Read one image named as evidence in a task's notes, for the lightbox.
#[tauri::command]
pub fn read_evidence_image(path: String) -> Result<tauri::ipc::Response, String> {
    let home = home_dir().ok_or("no home directory")?;
    let file = open_vetted(Path::new(&path), &home)?;
    Ok(tauri::ipc::Response::new(read_vetted(file)?))
}

/// `git remote get-url origin` for a claim's working directory — the fallback
/// that gives a bare sha or `#NN` in notes somewhere to point when the task
/// carries no repo link of its own. Absent remote, missing dir, no git: None,
/// and the token simply stays prose.
#[tauri::command]
pub fn git_remote_url(cwd: String) -> Option<String> {
    let dir = PathBuf::from(&cwd);
    if !dir.is_dir() {
        return None;
    }
    let out = std::process::Command::new("git")
        .args(["-C", &cwd, "remote", "get-url", "origin"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let url = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!url.is_empty()).then_some(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch dir standing in for $HOME, unique per test.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tildone-evidence-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    fn write(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn reads_an_image_inside_home() {
        let home = scratch("ok");
        let shot = home.join("work/shot.png");
        write(&shot, b"x");
        assert!(open_vetted(&shot, &home).is_ok());
    }

    #[test]
    fn refuses_a_path_outside_home() {
        let home = scratch("outside");
        let other = scratch("elsewhere");
        let shot = other.join("shot.png");
        write(&shot, b"x");
        assert!(open_vetted(&shot, &home).is_err());
    }

    #[test]
    fn refuses_a_symlink_that_escapes_home() {
        let home = scratch("symlink-home");
        let other = scratch("symlink-target");
        let target = other.join("secret.png");
        write(&target, b"x");
        let link = home.join("shot.png");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        // Canonicalisation resolves the link before containment is judged, so
        // the escape is visible rather than hidden behind an in-home name.
        assert!(open_vetted(&link, &home).is_err());
    }

    #[test]
    fn refuses_a_dotdot_climb() {
        let home = scratch("climb");
        let outside = scratch("climb-outside");
        write(&outside.join("secret.png"), b"x");
        let climbing = home.join("..").join(
            outside.file_name().unwrap(),
        ).join("secret.png");
        assert!(open_vetted(&climbing, &home).is_err());
    }

    #[test]
    fn refuses_a_non_image() {
        let home = scratch("ext");
        for name in ["notes.md", "run.sh", "diagram.svg", "noext"] {
            let file = home.join(name);
            write(&file, b"x");
            assert!(open_vetted(&file, &home).is_err(), "{name} should be refused");
        }
    }

    #[test]
    fn refuses_an_oversized_file() {
        let home = scratch("big");
        let shot = home.join("huge.png");
        write(&shot, &vec![0u8; (MAX_BYTES + 1) as usize]);
        assert!(open_vetted(&shot, &home).is_err());
    }

    #[test]
    fn refuses_a_missing_file() {
        let home = scratch("missing");
        assert!(open_vetted(&home.join("gone.png"), &home).is_err());
    }

    /// A symlink at the final component, planted before the click: the
    /// canonicalise resolves it, so the escape is judged rather than hidden
    /// behind an in-home name.
    #[test]
    fn refuses_a_symlink_pointing_outside_home() {
        let home = scratch("toctou");
        let outside = scratch("toctou-outside");
        let secret = outside.join("secret.png");
        write(&secret, b"secret");
        let shot = home.join("shot.png");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&secret, &shot).unwrap();
        assert!(open_vetted(&shot, &home).is_err());
    }

    /// The race itself, at the primitive that exists to lose it: canonicalise
    /// an honest path, then swap a *parent* for a symlink out of home — as an
    /// attacker would between the check and the open — and the walk must refuse
    /// to follow it rather than quietly redirect (sixth verify pass).
    #[test]
    #[cfg(unix)]
    fn the_walk_refuses_a_parent_swapped_for_a_symlink_after_canonicalising() {
        let home = scratch("parent-swap");
        let outside = scratch("parent-swap-outside");
        write(&outside.join("shot.png"), b"secret");
        let dir = home.join("d");
        let shot = dir.join("shot.png");
        write(&shot, b"real");

        let canonical = std::fs::canonicalize(&shot).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(&outside, &dir).unwrap();

        // The name still resolves — to a regular, correctly-named png outside
        // the home directory. Only refusing to walk symlinks catches it.
        assert!(
            open_beneath(&canonical).is_err(),
            "the walk followed a swapped parent directory"
        );
        // And the same path opened normally *would* have succeeded, which is
        // what makes the walk worth having.
        assert!(std::fs::File::open(&canonical).is_ok());
    }

    /// A FIFO named like a screenshot: refused for what it is, and O_NONBLOCK
    /// means the open cannot park forever waiting for a writer.
    #[test]
    #[cfg(unix)]
    fn refuses_a_fifo() {
        let home = scratch("fifo");
        let shot = home.join("shot.png");
        let c = std::ffi::CString::new(shot.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert!(open_vetted(&shot, &home).is_err());
    }

    /// A directory cannot masquerade as an image.
    #[test]
    fn refuses_a_directory_named_like_an_image() {
        let home = scratch("dir");
        let shot = home.join("shot.png");
        std::fs::create_dir_all(&shot).unwrap();
        assert!(open_vetted(&shot, &home).is_err());
    }

    #[test]
    fn the_read_returns_the_bytes_of_an_honest_file() {
        let home = scratch("read-ok");
        let shot = home.join("shot.png");
        write(&shot, b"pixels");
        let file = open_vetted(&shot, &home).unwrap();
        assert_eq!(read_vetted(file).unwrap(), b"pixels");
    }

    /// The read is capped on its own, not on the size seen a moment earlier —
    /// a file that grows while the handle is open cannot slip past.
    #[test]
    fn the_read_caps_a_file_that_grew_after_it_was_opened() {
        let home = scratch("grew");
        let shot = home.join("shot.png");
        write(&shot, b"small");
        let file = open_vetted(&shot, &home).unwrap();
        write(&shot, &vec![0u8; (MAX_BYTES + 1) as usize]);
        assert!(read_vetted(file).is_err());
    }
}
