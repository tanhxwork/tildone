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

/// Canonicalise and vet one evidence path. Split from the command so the guard
/// is unit-testable without a Tauri runtime.
fn vet(path: &Path, home: &Path) -> Result<PathBuf, String> {
    // Canonicalise first: it resolves `..` and follows symlinks, so the
    // containment check below sees where the read would actually land.
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
    let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_BYTES {
        return Err("too large to preview".into());
    }
    Ok(real)
}

/// Read the file the vetted path named — the *same* file, not whatever now
/// answers to that name.
///
/// Checking a path and then reading it by name is two resolutions with a gap
/// between them, and the gap is enough: swap the file for a symlink after the
/// check and the read follows it out of `$HOME`, or swap in a huge file and the
/// size cap is judged on a file that no longer exists (TOCTOU, found by the
/// third Codex verify pass on TIL-203). So the read opens once, refuses to
/// follow a symlink at the final component, and takes its size and its bytes
/// from that one open handle.
fn read_vetted(real: &Path, home: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // O_NOFOLLOW: no symlink at the final component. O_NONBLOCK: a FIFO
        // swapped in for the file would otherwise park `open` forever, waiting
        // for a writer that never comes.
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = opts.open(real).map_err(|e| e.to_string())?;

    // Ask the *descriptor* where it landed, and judge that. O_NOFOLLOW guards
    // only the last component, so swapping a parent directory for a symlink
    // between the check and the open still redirected the read out of $HOME —
    // the path was vetted, but a different file was opened (fourth Codex verify
    // pass on TIL-203). What we opened is the only thing worth checking.
    #[cfg(target_os = "macos")]
    {
        let opened = path_of(&file).ok_or("cannot identify the opened file")?;
        if !opened.starts_with(home) {
            return Err("outside the home directory".into());
        }
        let ext = opened
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
            return Err("not a previewable image".into());
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = home;

    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_BYTES {
        return Err("too large to preview".into());
    }
    // Bounded regardless of what the handle turns out to hold: `take` caps the
    // allocation instead of trusting the size we just read.
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("too large to preview".into());
    }
    Ok(bytes)
}

/// Where an open descriptor actually points, straight from the kernel — the one
/// answer a racing rename cannot change out from under us.
#[cfg(target_os = "macos")]
fn path_of(file: &std::fs::File) -> Option<PathBuf> {
    use std::os::unix::io::AsRawFd;
    let mut buf = [0u8; libc::PATH_MAX as usize];
    let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) };
    if rc == -1 {
        return None;
    }
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    Some(PathBuf::from(String::from_utf8_lossy(&buf[..end]).into_owned()))
}

/// Read one image named as evidence in a task's notes, for the lightbox.
#[tauri::command]
pub fn read_evidence_image(path: String) -> Result<tauri::ipc::Response, String> {
    let home = home_dir().ok_or("no home directory")?;
    let real = vet(Path::new(&path), &home)?;
    Ok(tauri::ipc::Response::new(read_vetted(&real, &home)?))
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
        assert_eq!(vet(&shot, &home).unwrap(), std::fs::canonicalize(&shot).unwrap());
    }

    #[test]
    fn refuses_a_path_outside_home() {
        let home = scratch("outside");
        let other = scratch("elsewhere");
        let shot = other.join("shot.png");
        write(&shot, b"x");
        assert!(vet(&shot, &home).is_err());
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
        assert!(vet(&link, &home).is_err());
    }

    #[test]
    fn refuses_a_dotdot_climb() {
        let home = scratch("climb");
        let outside = scratch("climb-outside");
        write(&outside.join("secret.png"), b"x");
        let climbing = home.join("..").join(
            outside.file_name().unwrap(),
        ).join("secret.png");
        assert!(vet(&climbing, &home).is_err());
    }

    #[test]
    fn refuses_a_non_image() {
        let home = scratch("ext");
        for name in ["notes.md", "run.sh", "diagram.svg", "noext"] {
            let file = home.join(name);
            write(&file, b"x");
            assert!(vet(&file, &home).is_err(), "{name} should be refused");
        }
    }

    #[test]
    fn refuses_an_oversized_file() {
        let home = scratch("big");
        let shot = home.join("huge.png");
        write(&shot, &vec![0u8; (MAX_BYTES + 1) as usize]);
        assert!(vet(&shot, &home).is_err());
    }

    #[test]
    fn refuses_a_missing_file() {
        let home = scratch("missing");
        assert!(vet(&home.join("gone.png"), &home).is_err());
    }

    /// The read must not follow a symlink swapped in after the check — the
    /// TOCTOU the third verify pass found.
    #[test]
    fn the_read_refuses_a_symlink_swapped_in_after_the_check() {
        let home = scratch("toctou");
        let outside = scratch("toctou-outside");
        let secret = outside.join("secret.png");
        write(&secret, b"secret");
        let shot = home.join("shot.png");
        write(&shot, b"real");

        // Vet the honest file, then swap it for a link to the secret one.
        let vetted = vet(&shot, &home).unwrap();
        std::fs::remove_file(&shot).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&secret, &shot).unwrap();

        assert!(read_vetted(&vetted, &home).is_err(), "the read followed the swap");
    }

    /// O_NOFOLLOW guards only the last component, so the parent has to be
    /// judged too — from the descriptor, after the open (fourth verify pass).
    #[test]
    fn the_read_refuses_a_parent_directory_swapped_for_a_link_outside_home() {
        let home = scratch("parent-swap");
        let outside = scratch("parent-swap-outside");
        write(&outside.join("shot.png"), b"secret");
        let dir = home.join("d");
        let shot = dir.join("shot.png");
        write(&shot, b"real");

        let vetted = vet(&shot, &home).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &dir).unwrap();

        // The name still resolves — to a regular, correctly-named png outside
        // the home directory. Only the descriptor's own path catches it.
        assert!(
            read_vetted(&vetted, &home).is_err(),
            "the read followed a swapped parent directory"
        );
    }

    /// A FIFO in place of the file would park `open` forever without O_NONBLOCK.
    #[test]
    fn the_read_refuses_a_fifo_swapped_in_after_the_check() {
        let home = scratch("fifo");
        let shot = home.join("shot.png");
        write(&shot, b"real");
        let vetted = vet(&shot, &home).unwrap();
        std::fs::remove_file(&shot).unwrap();
        #[cfg(unix)]
        {
            let c = std::ffi::CString::new(shot.to_str().unwrap()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        }
        assert!(read_vetted(&vetted, &home).is_err());
    }

    #[test]
    fn the_read_returns_the_bytes_of_an_honest_file() {
        let home = scratch("read-ok");
        let shot = home.join("shot.png");
        write(&shot, b"pixels");
        let vetted = vet(&shot, &home).unwrap();
        assert_eq!(read_vetted(&vetted, &home).unwrap(), b"pixels");
    }

    /// Size is judged on the handle that is actually read, and the read itself
    /// is capped — a file that grows between check and read cannot slip past.
    #[test]
    fn the_read_caps_a_file_that_grew_after_the_check() {
        let home = scratch("grew");
        let shot = home.join("shot.png");
        write(&shot, b"small");
        let vetted = vet(&shot, &home).unwrap();
        write(&shot, &vec![0u8; (MAX_BYTES + 1) as usize]);
        assert!(read_vetted(&vetted, &home).is_err());
    }
}
