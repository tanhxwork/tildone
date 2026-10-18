//! Putting the bundled `tildone-axi` CLI on the user's PATH.
//!
//! The release bundle ships the CLI next to the app executable. Settings → Agent access
//! links it into `~/.local/bin` so agents can call `tildone-axi` from any shell. The link
//! is a symlink, not a copy: an app upgrade replaces the binary in place and the link
//! follows. We only ever replace a symlink; a regular file at the link path is the
//! user's, and we refuse to touch it.
//!
//! In an AppImage the executable lives under `/tmp/.mount_*`, which vanishes when the
//! app quits. There we first copy the binary to a folder we own and link to the copy.

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
    /// `link_path` is a symlink to the binary we would link to now.
    pub linked: bool,
    /// This platform can link at all. False on Windows: the user adds the app folder to PATH.
    pub can_link: bool,
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

/// Where an AppImage's binary is copied to: a path that outlives the mount.
fn stable_copy_path(home: &Path) -> PathBuf {
    home.join(".local").join("share").join("tildone").join("bin").join(BIN)
}

/// What the link should point at: the bundled binary, or our copy of it in an AppImage.
fn link_target(bundled: &Path, home: &Path, appimage: bool) -> PathBuf {
    if appimage {
        stable_copy_path(home)
    } else {
        bundled.to_path_buf()
    }
}

fn bundled_binary() -> Option<PathBuf> {
    bundled_beside(&std::env::current_exe().ok()?)
}

/// Pure status: every input is an argument so tests can use temp dirs. `target` is what
/// a link should point at right now (see `link_target`); a link to anything else is stale.
fn status_for(
    bundled: Option<&Path>,
    target: Option<&Path>,
    link: &Path,
    path_env: Option<&std::ffi::OsStr>,
) -> CliStatus {
    let linked = match target {
        Some(t) => std::fs::read_link(link).map(|l| l == t).unwrap_or(false),
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
        can_link: cfg!(unix),
        link_path: link.display().to_string(),
        on_path,
    }
}

/// Symlink `link` to `bundled`, creating the folder and replacing an older symlink.
/// A regular file or folder at `link` is refused, never replaced.
#[cfg(unix)]
fn link_into(bundled: &Path, link: &Path) -> Result<(), String> {
    check_slot(link)?;
    if let Some(dir) = link.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    if std::fs::symlink_metadata(link).is_ok() {
        std::fs::remove_file(link).map_err(|e| format!("cannot replace {}: {e}", link.display()))?;
    }
    std::os::unix::fs::symlink(bundled, link)
        .map_err(|e| format!("cannot link {}: {e}", link.display()))
}

/// Nothing at `link`, or a symlink we may replace. Anything else is the user's.
#[cfg(unix)]
fn check_slot(link: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(link) {
        Ok(meta) if meta.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(format!(
            "{} already exists and is not a link. Move it aside and try again.",
            link.display()
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot read {}: {e}", link.display())),
    }
}

/// Copy `bundled` to `copy` (overwriting our earlier copy) and make it executable.
#[cfg(unix)]
fn stage_copy(bundled: &Path, copy: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(dir) = copy.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    // Remove first: copying onto a running binary fails with "text file busy".
    let _ = std::fs::remove_file(copy);
    std::fs::copy(bundled, copy).map_err(|e| format!("cannot copy to {}: {e}", copy.display()))?;
    std::fs::set_permissions(copy, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("cannot make {} executable: {e}", copy.display()))
}

/// Install: with a `copy` path, stage the copy and link to it; otherwise link to
/// `bundled`. The link slot is checked first so a refusal leaves no stray copy.
#[cfg(unix)]
fn install_with(bundled: &Path, copy: Option<&Path>, link: &Path) -> Result<(), String> {
    check_slot(link)?;
    match copy {
        Some(copy) => {
            stage_copy(bundled, copy)?;
            link_into(copy, link)
        }
        None => link_into(bundled, link),
    }
}

#[cfg(not(unix))]
fn install_with(_bundled: &Path, _copy: Option<&Path>, _link: &Path) -> Result<(), String> {
    Err("Linking is not supported on Windows. Add the Tildone app folder to PATH instead.".to_string())
}

/// The user's PATH. A Dock or Finder launch hands us launchd's minimal PATH, which never
/// holds ~/.local/bin, so ask their shell (same lookup as the agent spawns).
fn user_path() -> Option<std::ffi::OsString> {
    #[cfg(unix)]
    if let Some(p) = crate::host::shell_path() {
        return Some(p.into());
    }
    std::env::var_os("PATH")
}

fn current_status(home: &Path) -> CliStatus {
    let bundled = bundled_binary();
    let appimage = std::env::var_os("APPIMAGE").is_some();
    let target = bundled.as_deref().map(|b| link_target(b, home, appimage));
    status_for(bundled.as_deref(), target.as_deref(), &link_path(home), user_path().as_deref())
}

// Async so the first shell lookup (up to 5s) never blocks the main thread.
#[tauri::command]
pub async fn cli_status() -> Result<CliStatus, String> {
    Ok(current_status(&home_dir()?))
}

#[tauri::command]
pub async fn cli_install() -> Result<CliStatus, String> {
    let home = home_dir()?;
    let bundled = bundled_binary().ok_or("tildone-axi is not bundled in this build.")?;
    let copy = std::env::var_os("APPIMAGE").is_some().then(|| stable_copy_path(&home));
    install_with(&bundled, copy.as_deref(), &link_path(&home))?;
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
        let s = status_for(Some(&bin), Some(&bin), &link, Some(&path_env));
        assert!(s.bundled && s.linked && s.on_path);
        let s = status_for(Some(&bin), Some(&bin), &link, None);
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
        assert!(!status_for(Some(&bin), Some(&bin), &link, None).linked, "stale link is not linked");

        link_into(&bin, &link).unwrap();

        assert_eq!(fs::read_link(&link).unwrap(), bin);
        assert!(status_for(Some(&bin), Some(&bin), &link, None).linked);
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
    fn appimage_install_copies_to_a_stable_path_and_links_to_the_copy() {
        let root = scratch("appimage");
        let mount = root.join("mount");
        fs::create_dir_all(&mount).unwrap();
        let bin = fake_bin(&mount);
        let home = root.join("home");
        let copy = stable_copy_path(&home);
        let link = link_path(&home);
        assert_eq!(link_target(&bin, &home, true), copy);
        assert_eq!(link_target(&bin, &home, false), bin);

        install_with(&bin, Some(&copy), &link).unwrap();

        assert_eq!(fs::read_link(&link).unwrap(), copy);
        assert_eq!(fs::read_to_string(&copy).unwrap(), "#!/bin/sh\n");
        assert!(status_for(Some(&bin), Some(&copy), &link, None).linked);
        // The mount going away must not break the link.
        fs::remove_dir_all(&mount).unwrap();
        assert!(copy.is_file() && link.exists());

        // Reinstall from a new mount overwrites our copy.
        fs::create_dir_all(&mount).unwrap();
        fs::write(mount.join(BIN), "v2").unwrap();
        install_with(&mount.join(BIN), Some(&copy), &link).unwrap();
        assert_eq!(fs::read_to_string(&copy).unwrap(), "v2");
        assert_eq!(fs::read_link(&link).unwrap(), copy);
    }

    #[test]
    fn appimage_install_refuses_a_regular_file_and_stages_nothing() {
        let root = scratch("appimage-refuse");
        let bin = fake_bin(&root);
        let copy = root.join("share").join(BIN);
        let link = root.join("mine");
        fs::write(&link, "mine").unwrap();

        let err = install_with(&bin, Some(&copy), &link).unwrap_err();

        assert!(err.contains("not a link"), "{err}");
        assert_eq!(fs::read_to_string(&link).unwrap(), "mine");
        assert!(!copy.exists());
    }

    #[test]
    fn status_without_a_bundled_binary_is_unbundled_and_unlinked() {
        let root = scratch("unbundled");
        assert_eq!(bundled_beside(&root.join("tildone")), None);

        let s = status_for(None, None, &root.join("bin").join(BIN), None);

        assert!(!s.bundled && !s.linked && s.bundled_path.is_none());
        let bin = fake_bin(&root);
        assert_eq!(bundled_beside(&root.join("tildone")), Some(bin));
    }
}
