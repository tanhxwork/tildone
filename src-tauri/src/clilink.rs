//! Putting the bundled `tildone-axi` CLI on the user's PATH.
//!
//! The release bundle ships the CLI next to the app executable. Settings → Agent access
//! links it into `~/.local/bin` so agents can call `tildone-axi` from any shell. The link
//! is a symlink, not a copy: an app upgrade replaces the binary in place and the link
//! follows. We only ever replace a symlink; a regular file at the link path is the
//! user's, and we refuse to touch it.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[cfg(windows)]
const BIN: &str = "tildone-axi.exe";
#[cfg(not(windows))]
const BIN: &str = "tildone-axi";

/// Mirrors `CliStatus` in src/components/SettingsDialog.tsx.
#[derive(Serialize, Debug, PartialEq)]
pub struct CliStatus {
    /// The CLI sits next to this app's executable. False in dev and e2e builds.
    pub bundled: bool,
    pub bundled_path: Option<String>,
    /// `link_path` is a symlink to the bundled binary.
    pub linked: bool,
    pub link_path: String,
    /// The link's folder is on `$PATH`, so a new shell finds the command.
    pub on_path: bool,
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "cannot locate your home directory".to_string())
}

fn link_path(home: &Path) -> PathBuf {
    home.join(".local").join("bin").join(BIN)
}

/// The CLI beside the app executable, if the build shipped one.
fn bundled_beside(exe: &Path) -> Option<PathBuf> {
    let candidate = exe.parent()?.join(BIN);
    candidate.is_file().then_some(candidate)
}

fn bundled_binary() -> Option<PathBuf> {
    bundled_beside(&std::env::current_exe().ok()?)
}

/// Pure status: every input is an argument so tests can use temp dirs.
fn status_for(bundled: Option<&Path>, link: &Path, path_env: Option<&std::ffi::OsStr>) -> CliStatus {
    let linked = match bundled {
        Some(b) => std::fs::read_link(link).map(|t| t == b).unwrap_or(false),
        None => false,
    };
    let on_path = match (link.parent(), path_env) {
        (Some(dir), Some(p)) => std::env::split_paths(p).any(|e| e == dir),
        _ => false,
    };
    CliStatus {
        bundled: bundled.is_some(),
        bundled_path: bundled.map(|b| b.display().to_string()),
        linked,
        link_path: link.display().to_string(),
        on_path,
    }
}

/// Symlink `link` to `bundled`, creating the folder and replacing an older symlink.
/// A regular file or folder at `link` is refused, never replaced.
#[cfg(unix)]
fn link_into(bundled: &Path, link: &Path) -> Result<(), String> {
    if let Some(dir) = link.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    match std::fs::symlink_metadata(link) {
        Ok(meta) if meta.file_type().is_symlink() => std::fs::remove_file(link)
            .map_err(|e| format!("cannot replace {}: {e}", link.display()))?,
        Ok(_) => {
            return Err(format!(
                "{} already exists and is not a link. Move it aside and try again.",
                link.display()
            ))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("cannot read {}: {e}", link.display())),
    }
    std::os::unix::fs::symlink(bundled, link)
        .map_err(|e| format!("cannot link {}: {e}", link.display()))
}

#[cfg(not(unix))]
fn link_into(_bundled: &Path, _link: &Path) -> Result<(), String> {
    Err("Linking is not supported on Windows. Add the Tildone app folder to PATH instead.".to_string())
}

fn current_status(home: &Path) -> CliStatus {
    let bundled = bundled_binary();
    status_for(bundled.as_deref(), &link_path(home), std::env::var_os("PATH").as_deref())
}

#[tauri::command]
pub fn cli_status() -> Result<CliStatus, String> {
    Ok(current_status(&home_dir()?))
}

#[tauri::command]
pub fn cli_install() -> Result<CliStatus, String> {
    let home = home_dir()?;
    let bundled = bundled_binary().ok_or("tildone-axi is not bundled in this build.")?;
    link_into(&bundled, &link_path(&home))?;
    Ok(current_status(&home))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;

    /// A fresh empty dir per test; the OS temp dir cleans up after us eventually.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tildone-clilink-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fake_bin(dir: &Path) -> PathBuf {
        let p = dir.join(BIN);
        fs::write(&p, "#!/bin/sh\n").unwrap();
        p
    }

    #[test]
    fn links_into_a_missing_folder_and_reports_linked() {
        let root = scratch("link");
        let bin = fake_bin(&root);
        let link = root.join("home/.local/bin").join(BIN);

        link_into(&bin, &link).unwrap();

        assert_eq!(fs::read_link(&link).unwrap(), bin);
        let path_env = std::env::join_paths([root.join("home/.local/bin")]).unwrap();
        let s = status_for(Some(&bin), &link, Some(&path_env));
        assert!(s.bundled && s.linked && s.on_path);
        let s = status_for(Some(&bin), &link, None);
        assert!(!s.on_path);
    }

    #[test]
    fn relinks_over_a_link_to_an_old_binary() {
        let root = scratch("relink");
        let old = root.join("old-tildone-axi");
        fs::write(&old, "").unwrap();
        let bin = fake_bin(&root);
        let link = root.join("bin").join(BIN);
        link_into(&old, &link).unwrap();
        assert!(!status_for(Some(&bin), &link, None).linked, "stale link is not linked");

        link_into(&bin, &link).unwrap();

        assert_eq!(fs::read_link(&link).unwrap(), bin);
        assert!(status_for(Some(&bin), &link, None).linked);
    }

    #[test]
    fn refuses_to_overwrite_a_regular_file() {
        let root = scratch("refuse");
        let bin = fake_bin(&root);
        let link = root.join(BIN.to_string() + "-user");
        fs::write(&link, "mine").unwrap();

        let err = link_into(&bin, &link).unwrap_err();

        assert!(err.contains("not a link"), "{err}");
        assert_eq!(fs::read_to_string(&link).unwrap(), "mine");
    }

    #[test]
    fn status_without_a_bundled_binary_is_unbundled_and_unlinked() {
        let root = scratch("unbundled");
        assert_eq!(bundled_beside(&root.join("tildone")), None);

        let s = status_for(None, &root.join("bin").join(BIN), None);

        assert!(!s.bundled && !s.linked && s.bundled_path.is_none());
        let bin = fake_bin(&root);
        assert_eq!(bundled_beside(&root.join("tildone")), Some(bin));
    }
}
