use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Bakes `TILDONE_COMMIT` (short hash, `-dirty` when tracked files differ, or
/// `unknown` outside git) into the binary, so a hub can tell which build each of
/// its client apps runs (clients.rs). Rebuilt when HEAD, a branch or the index moves.
fn main() {
    let commit = match git(&["rev-parse", "--short", "HEAD"]) {
        Some(hash) => {
            let dirty = git(&["status", "--porcelain", "--untracked-files=no"])
                .is_some_and(|s| !s.is_empty());
            if dirty {
                format!("{hash}-dirty")
            } else {
                hash
            }
        }
        None => "unknown".into(),
    };
    println!("cargo:rustc-env=TILDONE_COMMIT={commit}");
    if let Some(dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        println!("cargo:rerun-if-changed={dir}/HEAD");
        println!("cargo:rerun-if-changed={dir}/index");
    }
    if let Some(common) = git(&["rev-parse", "--path-format=absolute", "--git-common-dir"]) {
        println!("cargo:rerun-if-changed={common}/refs/heads");
        println!("cargo:rerun-if-changed={common}/packed-refs");
    }
    tauri_build::build()
}
