//! Hosted agent sessions (spec 2026-07-19-hosted-agent-sessions): the board
//! as PTY host. A "start session" on a task spawns an agent CLI — claude,
//! codex, opencode — on an app-owned PTY in the task's directory, with the
//! task ref as its opening prompt. The pane renders it; closing the pane
//! detaches and the session keeps running here, its output ring-buffered for
//! replay on the next jump. Kill is a separate, explicit command.
//!
//! This module owns the session table. The pane slot itself — which session
//! (hosted or foreign attach) the single visible terminal is showing — stays
//! in `pty.rs`; its write/resize/close commands route here for hosted panes.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::Emitter;

use crate::pty;

/// Bytes of raw PTY output kept per session for replay. Enough for a TUI's
/// full alt-screen history at agent output rates; small enough that a dozen
/// sessions cost a few MB.
const RING_CAP: usize = 512 * 1024;

// ---------------------------------------------------------------------------
// Adapters — the CLI as data, not a code fork.

fn claude_resume(sid: &str) -> Vec<String> {
    vec!["--resume".into(), sid.into()]
}
fn codex_resume(sid: &str) -> Vec<String> {
    vec!["resume".into(), sid.into()]
}

pub struct Adapter {
    pub id: &'static str,
    pub name: &'static str,
    bin: &'static str,
    /// Install locations to try before asking a login shell, relative to $HOME.
    home_candidates: &'static [&'static str],
    /// Whether the CLI takes the opening prompt as a positional argument.
    /// opencode's argv contract is unverified (its --help renders only in a
    /// TUI), so it launches bare — the gap is deliberate, not an oversight.
    prompt_arg: bool,
    /// The resume half of the adapter contract. Spec'd now, first consumed
    /// when restart-survival lands (out of v1 scope) — exercised by tests so
    /// the argv shapes don't rot meanwhile.
    #[allow(dead_code)]
    resume_args: Option<fn(&str) -> Vec<String>>,
}

const ADAPTERS: &[Adapter] = &[
    Adapter {
        id: "claude",
        name: "Claude Code",
        bin: "claude",
        home_candidates: &[".local/bin/claude"],
        prompt_arg: true,
        resume_args: Some(claude_resume),
    },
    Adapter {
        id: "codex",
        name: "Codex",
        bin: "codex",
        home_candidates: &[".local/bin/codex"],
        prompt_arg: true,
        resume_args: Some(codex_resume),
    },
    Adapter {
        id: "opencode",
        name: "opencode",
        bin: "opencode",
        home_candidates: &[".opencode/bin/opencode"],
        prompt_arg: false,
        resume_args: None,
    },
];

fn adapter(id: &str) -> Option<&'static Adapter> {
    ADAPTERS.iter().find(|a| a.id == id)
}

/// Resolve an adapter's binary. Same discipline as `pty::claude_bin`: a GUI
/// app's PATH is minimal, so try known install spots, then a login shell —
/// and cache only successes, so "install it, then click again" works without
/// an app restart.
fn resolve_bin(adapter: &Adapter) -> Option<String> {
    static CACHE: Mutex<Option<HashMap<&'static str, String>>> = Mutex::new(None);
    if let Some(hit) = CACHE
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|m| m.get(adapter.id).cloned())
    {
        return Some(hit);
    }
    let found = lookup_bin(adapter);
    if let Some(ref path) = found {
        CACHE
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(adapter.id, path.clone());
    }
    found
}

fn lookup_bin(adapter: &Adapter) -> Option<String> {
    if let Ok(home) = std::env::var("HOME") {
        for rel in adapter.home_candidates {
            let path = format!("{home}/{rel}");
            if std::path::Path::new(&path).exists() {
                return Some(path);
            }
        }
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let path = format!("{dir}/{}", adapter.bin);
        if std::path::Path::new(&path).exists() {
            return Some(path);
        }
    }
    let out = std::process::Command::new("/bin/sh")
        .args(["-lc", &format!("command -v {}", adapter.bin)])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

// ---------------------------------------------------------------------------
// The session table.

/// State the reader thread and the commands both touch. One mutex for the
/// buffer AND the attached generation, because replay correctness depends on
/// them changing together: an attach snapshots the buffer and flips
/// `attached` in one critical section, so every chunk is either in the
/// snapshot or emitted live after it — never both, never neither.
struct Shared {
    buf: Vec<u8>,
    /// The pane generation currently rendering this session, if any.
    attached: Option<u64>,
    exited: bool,
}

struct HostedSession {
    task_id: i64,
    task_ref: Option<String>,
    adapter_id: &'static str,
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    shared: Arc<Mutex<Shared>>,
}

fn sessions() -> &'static Mutex<HashMap<u64, HostedSession>> {
    static TABLE: OnceLock<Mutex<HashMap<u64, HostedSession>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_session_id() -> u64 {
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed) + 1
}

/// What a `pty-data` / `pty-exit` event carries — same shape `pty.rs` emits,
/// so the pane consumes both kinds of session through one listener.
#[derive(serde::Serialize, Clone)]
struct PtyEvent {
    generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Vec<u8>>,
}

// -- hooks pty.rs routes through for hosted panes ---------------------------

/// Pane closed: stop rendering, keep running. The reader keeps buffering.
/// Generation-guarded like every pane mutation: a re-attach may already have
/// claimed this session under a newer generation, and the old pane's release
/// must not silence its successor.
pub(crate) fn detach(session_id: u64, generation: u64) {
    if let Some(s) = sessions().lock().unwrap().get(&session_id) {
        let mut shared = s.shared.lock().unwrap();
        if shared.attached == Some(generation) {
            shared.attached = None;
        }
    }
}

pub(crate) fn write_bytes(session_id: u64, data: &[u8]) -> Result<(), String> {
    let mut table = sessions().lock().unwrap();
    let Some(s) = table.get_mut(&session_id) else {
        return Ok(()); // killed while the keystroke was in flight — a no-op, not an error
    };
    s.writer
        .write_all(data)
        .and_then(|()| s.writer.flush())
        .map_err(|e| format!("write failed: {e}"))
}

pub(crate) fn resize(session_id: u64, cols: u16, rows: u16) -> Result<(), String> {
    if let Some(s) = sessions().lock().unwrap().get(&session_id) {
        s.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("resize failed: {e}"))?;
    }
    Ok(())
}

// -- commands ---------------------------------------------------------------

#[derive(serde::Serialize, Clone)]
pub struct AdapterInfo {
    id: &'static str,
    name: &'static str,
    available: bool,
}

/// The picker's data: which CLIs exist on this machine right now. Misses are
/// never cached (see `resolve_bin`), so installing a CLI fixes the picker on
/// the next editor open.
#[tauri::command]
pub async fn host_adapters() -> Result<Vec<AdapterInfo>, String> {
    Ok(tauri::async_runtime::spawn_blocking(|| {
        ADAPTERS
            .iter()
            .map(|a| AdapterInfo { id: a.id, name: a.name, available: resolve_bin(a).is_some() })
            .collect()
    })
    .await
    .map_err(|e| format!("adapter probe failed: {e}"))?)
}

#[derive(serde::Serialize, Clone)]
pub struct HostInfo {
    pub id: u64,
    pub task_id: i64,
    pub task_ref: Option<String>,
    pub adapter_id: &'static str,
    pub adapter_name: &'static str,
    pub exited: bool,
}

#[tauri::command]
pub fn host_list() -> Vec<HostInfo> {
    sessions()
        .lock()
        .unwrap()
        .iter()
        .map(|(id, s)| HostInfo {
            id: *id,
            task_id: s.task_id,
            task_ref: s.task_ref.clone(),
            adapter_id: s.adapter_id,
            adapter_name: adapter(s.adapter_id).map(|a| a.name).unwrap_or(s.adapter_id),
            exited: s.shared.lock().unwrap().exited,
        })
        .collect()
}

/// Launch working directory, resolved spec-side: the claim's cwd if it still
/// exists, else the project's conventional checkout, else $HOME. Pure for
/// testability; existence is the injected part.
fn resolve_cwd(
    claim_cwd: Option<&str>,
    project_name: Option<&str>,
    home: &str,
    exists: impl Fn(&str) -> bool,
) -> String {
    if let Some(cwd) = claim_cwd {
        if exists(cwd) {
            return cwd.to_string();
        }
    }
    if let Some(project) = project_name {
        let conventional = format!("{home}/projects/{project}");
        if exists(&conventional) {
            return conventional;
        }
    }
    home.to_string()
}

/// Start a session for a task. Spawn only — the caller opens the pane, whose
/// mount runs the one shared attach path (`host_attach`). Returns the session
/// id that names it for jumps and kill.
#[tauri::command]
pub async fn host_start(
    app: tauri::AppHandle,
    task_id: i64,
    task_ref: Option<String>,
    adapter_id: String,
    claim_cwd: Option<String>,
    project_name: Option<String>,
    prompt: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u64, String> {
    let adapter = adapter(&adapter_id).ok_or_else(|| format!("unknown adapter {adapter_id}"))?;

    let spawn_app = app.clone();
    let session_id = tauri::async_runtime::spawn_blocking(move || {
        let bin = resolve_bin(adapter)
            .ok_or_else(|| format!("{} CLI not found — install it first", adapter.name))?;
        let home = std::env::var("HOME").map_err(|_| "no $HOME".to_string())?;
        let cwd = resolve_cwd(claim_cwd.as_deref(), project_name.as_deref(), &home, |p| {
            std::path::Path::new(p).is_dir()
        });

        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("openpty failed: {e}"))?;
        let mut cmd = CommandBuilder::new(bin);
        if adapter.prompt_arg {
            if let Some(ref prompt) = prompt {
                // The prompt is a positional arg; a value starting with '-'
                // would be parsed as a flag by the CLI (argv smuggling). Refs
                // never legitimately start with '-', and `--` end-of-options
                // support is unverified across the three CLIs — reject.
                if prompt.starts_with('-') {
                    return Err("prompt must not start with '-'".into());
                }
                cmd.arg(prompt);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.cwd(&cwd);
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn failed: {e}"))?;
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("reader failed: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("writer failed: {e}"))?;

        let session_id = next_session_id();
        let shared = Arc::new(Mutex::new(Shared { buf: Vec::new(), attached: None, exited: false }));
        sessions().lock().unwrap().insert(
            session_id,
            HostedSession {
                task_id,
                task_ref,
                adapter_id: adapter.id,
                writer,
                master: pair.master,
                child,
                shared: Arc::clone(&shared),
            },
        );

        // The reader outlives every pane: it buffers always, and forwards to
        // the webview only while a pane is attached. Emitting inside the
        // critical section is deliberate — it is what makes "snapshot, then
        // live chunks" an exact partition (see `Shared`).
        let reader_app = spawn_app.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut shared = shared.lock().unwrap();
                        shared.buf.extend_from_slice(&chunk[..n]);
                        if shared.buf.len() > RING_CAP {
                            let excess = shared.buf.len() - RING_CAP;
                            shared.buf.drain(..excess);
                        }
                        if let Some(generation) = shared.attached {
                            let _ = reader_app.emit(
                                "pty-data",
                                PtyEvent { generation, data: Some(chunk[..n].to_vec()) },
                            );
                        }
                    }
                }
            }
            // EOF: the CLI exited (on its own, or killed). The entry stays in
            // the table as *exited* until dismissed — a crash must be visible
            // on the board, not a silent vanish.
            let generation = {
                let mut shared = shared.lock().unwrap();
                shared.exited = true;
                shared.attached.take()
            };
            if let Some(generation) = generation {
                let _ = reader_app.emit("pty-exit", PtyEvent { generation, data: None });
            }
            let _ = reader_app.emit("host-changed", ());
        });

        Ok::<_, String>(session_id)
    })
    .await
    .map_err(|e| format!("spawn task failed: {e}"))??;

    let _ = app.emit("host-changed", ());
    Ok(session_id)
}

/// What an attach hands the pane. The replay travels in the *return value*,
/// never as a `pty-data` event: the pane learns its generation only when this
/// command resolves, so an event emitted mid-command would race the listener
/// and the whole replayed screen could be dropped on the floor.
#[derive(serde::Serialize)]
pub struct AttachResult {
    generation: u64,
    replay: Vec<u8>,
    exited: bool,
}

/// Put a hosted session on the pane (the start's first attach and every
/// re-jump alike): claim the pane slot, snapshot the buffer and flip
/// `attached` in one critical section — every chunk is either in the snapshot
/// or emitted live after it — then nudge the PTY size so the TUI repaints a
/// fresh frame on top of the replayed history (a same-size resize is a no-op,
/// hence the +1-row bounce; the second resize restores the true size and
/// delivers SIGWINCH).
#[tauri::command]
pub fn host_attach(
    live: tauri::State<'_, pty::PtyLive>,
    session_id: u64,
    cols: u16,
    rows: u16,
) -> Result<AttachResult, String> {
    // Existence first, claim second — never the other way around: the claim
    // must not run while the table lock is held (releasing the evicted pane
    // re-enters `detach`, which takes the same lock), and a dead session must
    // not evict a live pane.
    if !sessions().lock().unwrap().contains_key(&session_id) {
        return Err("session no longer exists".into());
    }
    let generation = pty::next_generation();
    pty::claim_pane_for_hosted(&live, generation, session_id);
    let table = sessions().lock().unwrap();
    let s = table.get(&session_id).ok_or("session no longer exists")?;
    let (replay, exited) = {
        let mut shared = s.shared.lock().unwrap();
        shared.attached = (!shared.exited).then_some(generation);
        (shared.buf.clone(), shared.exited)
    };
    let _ = s.master.resize(PtySize { rows: rows + 1, cols, pixel_width: 0, pixel_height: 0 });
    let _ = s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    Ok(AttachResult { generation, replay, exited })
}

/// The explicit kill: terminate the CLI and drop the session entirely. Also
/// how an *exited* entry is dismissed (its child is already gone; kill is a
/// no-op then).
#[tauri::command]
pub fn host_kill(app: tauri::AppHandle, session_id: u64) -> Result<(), String> {
    let removed = sessions().lock().unwrap().remove(&session_id);
    if let Some(mut s) = removed {
        let _ = s.child.kill();
    }
    let _ = app.emit("host-changed", ());
    Ok(())
}

// -- quit guard -------------------------------------------------------------

/// Menu id of the guarded Quit item (see `install_quit_menu`).
pub const QUIT_MENU_ID: &str = "tildone-quit";

/// macOS: the default menu's Quit is muda's predefined item, which is the
/// native `terminate:` selector — it kills the process without ever emitting
/// `RunEvent::ExitRequested`, so the hosted-session quit guard never runs
/// (verified live 2026-07-19: ⌘Q dropped straight past the guard). Swap it
/// for a plain item with the same accelerator whose handler calls
/// `app.exit(0)` — that path does emit a preventable ExitRequested.
#[cfg(target_os = "macos")]
pub fn install_quit_menu(app: &tauri::AppHandle) {
    use tauri::menu::{MenuItem, MenuItemKind};
    let Some(menu) = app.menu() else { return };
    let Ok(items) = menu.items() else { return };
    let Some(MenuItemKind::Submenu(app_menu)) = items.into_iter().next() else {
        return;
    };
    let Ok(sub_items) = app_menu.items() else { return };
    // The default app submenu ends with the predefined Quit.
    let Some(native_quit) = sub_items.last() else { return };
    let _ = app_menu.remove(native_quit);
    if let Ok(quit) =
        MenuItem::with_id(app, QUIT_MENU_ID, "Quit Tildone", true, Some("CmdOrCtrl+Q"))
    {
        let _ = app_menu.append(&quit);
    }
}

fn quit_flag() -> &'static AtomicBool {
    static CONFIRMED: AtomicBool = AtomicBool::new(false);
    &CONFIRMED
}

/// Are any hosted CLIs still running? (Exited-but-listed entries don't count.)
pub fn any_live() -> bool {
    sessions()
        .lock()
        .unwrap()
        .values()
        .any(|s| !s.shared.lock().unwrap().exited)
}

pub fn quit_confirmed() -> bool {
    quit_flag().load(Ordering::Relaxed)
}

/// The warning dialog's "quit anyway": stop everything, then exit for real.
#[tauri::command]
pub fn host_confirm_quit(app: tauri::AppHandle) {
    quit_flag().store(true, Ordering::Relaxed);
    kill_all();
    app.exit(0);
}

/// Last-breath cleanup (RunEvent::Exit): hosted CLIs are children of this
/// process and must not be orphaned onto dead PTYs.
pub fn kill_all() {
    for (_, mut s) in sessions().lock().unwrap().drain() {
        let _ = s.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_table_has_the_three_v1_clis() {
        let ids: Vec<_> = ADAPTERS.iter().map(|a| a.id).collect();
        assert_eq!(ids, vec!["claude", "codex", "opencode"]);
    }

    #[test]
    fn resume_argv_shapes_hold() {
        // The spec'd contract, pinned until restart-survival consumes it.
        let claude = adapter("claude").unwrap().resume_args.unwrap()("abc");
        assert_eq!(claude, vec!["--resume", "abc"]);
        let codex = adapter("codex").unwrap().resume_args.unwrap()("abc");
        assert_eq!(codex, vec!["resume", "abc"]);
        assert!(adapter("opencode").unwrap().resume_args.is_none());
    }

    #[test]
    fn opencode_launches_bare() {
        // Its argv contract is unverified (TUI-only --help); a guessed prompt
        // arg could be misread as a directory. Bare launch is the decision.
        assert!(!adapter("opencode").unwrap().prompt_arg);
    }

    #[test]
    fn cwd_prefers_claim_then_project_then_home() {
        let exists = |p: &str| p == "/w" || p == "/home/projects/til";
        assert_eq!(resolve_cwd(Some("/w"), Some("til"), "/home", exists), "/w");
        assert_eq!(resolve_cwd(Some("/gone"), Some("til"), "/home", exists), "/home/projects/til");
        assert_eq!(resolve_cwd(None, Some("til"), "/home", exists), "/home/projects/til");
        assert_eq!(resolve_cwd(None, Some("nope"), "/home", exists), "/home");
        assert_eq!(resolve_cwd(None, None, "/home", exists), "/home");
    }
}
