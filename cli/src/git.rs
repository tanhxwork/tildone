//! What the CLI asks git: the checkout, the branch, and the project a folder maps to.

use std::path::{Path, PathBuf};
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// The checkout this command runs in: git's toplevel, else the current directory.
pub fn checkout() -> String {
    git(&["rev-parse", "--show-toplevel"])
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|p| p.display().to_string())
        })
        .unwrap_or_default()
}

/// The checked-out branch; None outside a repo or on a detached HEAD.
pub fn branch() -> Option<String> {
    git(&["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| b != "HEAD")
}

/// The board project this folder maps to: the repo folder's name. A linked
/// worktree (`repo-wt/slug`) maps to the repo it belongs to, not to its slug.
pub fn default_project() -> String {
    let Some(top) = git(&["rev-parse", "--show-toplevel"]) else {
        return base_name(&std::env::current_dir().unwrap_or_default());
    };
    if let (Some(dir), Some(common)) = (
        git(&["rev-parse", "--absolute-git-dir"]),
        git(&["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ) {
        if dir != common {
            if let Some(parent) = PathBuf::from(&common).parent() {
                return base_name(parent);
            }
        }
    }
    base_name(Path::new(&top))
}

fn base_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}
