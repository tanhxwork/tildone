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
use std::sync::{Arc, Mutex, Once, OnceLock};
use std::time::{Duration, Instant};

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
    /// The session's virtual screen (spec anycli-workspace-v2, F2): the same
    /// bytes the ring buffer keeps, parsed into a grid the waiting classifier
    /// can inspect. Pixels for the pane, state for the board.
    screen: vt100::Parser,
    /// When the last output byte arrived — waiting-detect classifies only
    /// after the stream quiesces, never mid-repaint.
    last_byte: Option<Instant>,
    /// The classifier's current verdict. Inference, not fact: any new output
    /// clears it instantly.
    waiting: bool,
    /// One notification per waiting episode; new bytes re-arm.
    notified: bool,
}

struct HostedSession {
    task_id: i64,
    task_ref: Option<String>,
    adapter_id: &'static str,
    /// This session's row in `hosted_sessions` (F3) — the persistence that
    /// makes it resumable after an app restart. -1 when the insert failed
    /// (the session still runs; it just won't survive a restart).
    row_id: i64,
    /// Where the CLI runs; the bind watchers key transcript lookups on it.
    cwd: String,
    /// ISO start stamp; binding only accepts artifacts younger than this.
    started_at: String,
    /// The CLI's own session id, once an artifact reveals it (F3's resume
    /// key). Set-once — racing bind sources are benign.
    cli_session_id: Option<String>,
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
        s.shared.lock().unwrap().screen.set_size(rows, cols);
    }
    Ok(())
}

// -- restart survival (F3) ----------------------------------------------------

fn now_iso() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    crate::agent::iso_from_epoch_millis(millis)
}

/// Best-effort write to the app database. Persistence failures cost restart
/// survival, never the live session — hence no Result.
fn db_exec(app: &tauri::AppHandle, sql: &str, params: &[&dyn rusqlite::ToSql]) {
    if let Ok(conn) = crate::agent::open_db(app) {
        let _ = conn.execute(sql, params);
    }
}

fn db_insert_session(
    app: &tauri::AppHandle,
    task_id: i64,
    task_ref: Option<&str>,
    adapter_id: &str,
    cwd: &str,
    started_at: &str,
) -> i64 {
    let Ok(conn) = crate::agent::open_db(app) else { return -1 };
    match conn.execute(
        "INSERT INTO hosted_sessions (task_id, task_ref, adapter_id, cwd, started_at, live) \
         VALUES (?1, ?2, ?3, ?4, ?5, 1)",
        rusqlite::params![task_id, task_ref, adapter_id, cwd, started_at],
    ) {
        Ok(_) => conn.last_insert_rowid(),
        Err(_) => -1,
    }
}

/// A hosted session whose CLI session id is still unknown — what the bind
/// watchers in artifacts.rs scan for.
pub(crate) struct UnboundHosted {
    pub session_id: u64,
    pub task_id: i64,
    pub adapter_id: &'static str,
    pub cwd: String,
    /// ISO — binding only accepts artifacts stamped at or after this.
    pub started_at: String,
}

pub(crate) fn unbound_hosted() -> Vec<UnboundHosted> {
    sessions()
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, s)| s.cli_session_id.is_none() && matches!(s.adapter_id, "claude" | "codex"))
        .map(|(id, s)| UnboundHosted {
            session_id: *id,
            task_id: s.task_id,
            adapter_id: s.adapter_id,
            cwd: s.cwd.clone(),
            started_at: s.started_at.clone(),
        })
        .collect()
}

/// Set-once binding of the CLI's own session id (the resume key). Racing
/// sources (transcript file vs MCP claim) are benign — first writer wins.
pub(crate) fn bind_cli_session(app: &tauri::AppHandle, session_id: u64, cli_session_id: &str) {
    let row_id = {
        let mut table = sessions().lock().unwrap();
        let Some(s) = table.get_mut(&session_id) else { return };
        if s.cli_session_id.is_some() {
            return;
        }
        s.cli_session_id = Some(cli_session_id.to_string());
        s.row_id
    };
    db_exec(
        app,
        "UPDATE hosted_sessions SET cli_session_id = ?1 WHERE id = ?2",
        &[&cli_session_id, &row_id],
    );
}

/// A dead-but-resumable session from a previous app run.
#[derive(serde::Serialize, Clone)]
pub struct ResumableInfo {
    pub row_id: i64,
    pub task_id: i64,
    pub task_ref: Option<String>,
    pub adapter_id: String,
    pub adapter_name: String,
    #[serde(skip)]
    cli_session_id: String,
    #[serde(skip)]
    cwd: String,
}

fn resumables() -> &'static Mutex<Vec<ResumableInfo>> {
    static LIST: OnceLock<Mutex<Vec<ResumableInfo>>> = OnceLock::new();
    LIST.get_or_init(|| Mutex::new(Vec::new()))
}

/// Boot sweep, pure over the connection for testability: leftover live rows
/// with a bound session id and a resume-capable adapter become resumables;
/// every other leftover row is deleted (self-exited, unbound, unsupported).
fn sweep_hosted_rows(conn: &rusqlite::Connection) -> Vec<ResumableInfo> {
    let mut keep = Vec::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, task_id, task_ref, adapter_id, cwd, cli_session_id, live FROM hosted_sessions",
    ) else {
        return keep;
    };
    let rows: Vec<(i64, i64, Option<String>, String, String, Option<String>, i64)> = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })
        .map(|it| it.flatten().collect())
        .unwrap_or_default();
    drop(stmt);
    for (id, task_id, task_ref, adapter_id, cwd, cli, live) in rows {
        let resumable = live == 1
            && cli.is_some()
            && adapter(&adapter_id).is_some_and(|a| a.resume_args.is_some());
        if resumable {
            let adapter_name =
                adapter(&adapter_id).map(|a| a.name.to_string()).unwrap_or_else(|| adapter_id.clone());
            keep.push(ResumableInfo {
                row_id: id,
                task_id,
                task_ref,
                adapter_id,
                adapter_name,
                cli_session_id: cli.unwrap(),
                cwd,
            });
        } else {
            let _ = conn.execute("DELETE FROM hosted_sessions WHERE id = ?1", [id]);
        }
    }
    keep
}

/// App boot (lib.rs setup): load what the previous run left behind.
pub fn boot(app: &tauri::AppHandle) {
    if let Ok(conn) = crate::agent::open_db(app) {
        let found = sweep_hosted_rows(&conn);
        *resumables().lock().unwrap() = found;
    }
}

#[tauri::command]
pub fn host_resumables() -> Vec<ResumableInfo> {
    resumables().lock().unwrap().clone()
}

/// Resume a dead session on a fresh PTY via the adapter's pinned resume argv.
/// Manual, per card — never automatic (spec: no surprise spawns or token
/// spend at launch). The old row is replaced by the fresh spawn's row; the
/// bind watchers capture the NEW session id the resumed CLI mints.
#[tauri::command]
pub async fn host_resume(
    app: tauri::AppHandle,
    row_id: i64,
    cols: u16,
    rows: u16,
) -> Result<u64, String> {
    let info = {
        let list = resumables().lock().unwrap();
        list.iter()
            .find(|r| r.row_id == row_id)
            .cloned()
            .ok_or("session is no longer resumable")?
    };
    let adapter = adapter(&info.adapter_id)
        .ok_or_else(|| format!("unknown adapter {}", info.adapter_id))?;
    let resume_args =
        adapter.resume_args.ok_or_else(|| format!("{} cannot resume", adapter.name))?;
    ensure_ticker(&app);

    let argv_tail = resume_args(&info.cli_session_id);
    let spawn_app = app.clone();
    let session_id = tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var("HOME").map_err(|_| "no $HOME".to_string())?;
        let cwd = if std::path::Path::new(&info.cwd).is_dir() { info.cwd.clone() } else { home };
        spawn_hosted(spawn_app, info.task_id, info.task_ref, adapter, argv_tail, cwd, cols, rows)
    })
    .await
    .map_err(|e| format!("spawn task failed: {e}"))??;

    // Consumed: drop from the offer list and delete the old row (the spawn
    // inserted a fresh one).
    resumables().lock().unwrap().retain(|r| r.row_id != row_id);
    db_exec(&app, "DELETE FROM hosted_sessions WHERE id = ?1", &[&row_id]);
    let _ = app.emit("host-changed", ());
    Ok(session_id)
}

// -- waiting-detect (F2) ------------------------------------------------------

/// How long the stream must be silent before the grid is worth classifying.
const QUIESCE: Duration = Duration::from_millis(500);

/// Layer-2 inference (spec anycli-workspace-v2, F2): inspect the grid's tail
/// once output quiesces. `Some(true)` = waiting at a prompt, `Some(false)` =
/// visibly working, `None` = unrecognized — never guess. Markers pinned from
/// real captured screens (claude v2.1.215, codex v0.144.4 — see tests);
/// update the fixtures when a CLI redesigns its TUI.
///
/// claude dropped "esc to interrupt" in v2.1.215; its working tell is the
/// live token counter ("(3s · ↓12 tokens)"). The interrupt hint stays as a
/// second marker for older/newer versions. Prompt chars: claude '❯',
/// codex '›' — both also front their permission/trust dialogs, which are
/// exactly "waiting for the user" and classify correctly for free.
fn screen_waiting(adapter_id: &str, tail: &str) -> Option<bool> {
    match adapter_id {
        "claude" => {
            if tail.contains("esc to interrupt")
                || (tail.contains("· ↓") && tail.contains("tokens"))
            {
                return Some(false);
            }
            tail.contains('❯').then_some(true)
        }
        "codex" => {
            if tail.contains("esc to interrupt") {
                return Some(false);
            }
            tail.contains('›').then_some(true)
        }
        _ => None,
    }
}

/// The classifier's viewport: the grid's last rows carry the status line and
/// input box; everything above is content and would only add false matches.
fn screen_tail(contents: &str) -> String {
    let rows: Vec<&str> = contents
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect();
    let start = rows.len().saturating_sub(8);
    rows[start..].join("\n").to_lowercase()
}

fn app_handle_slot() -> &'static OnceLock<tauri::AppHandle> {
    static SLOT: OnceLock<tauri::AppHandle> = OnceLock::new();
    &SLOT
}

/// One global quiesce ticker for all hosted sessions, started with the first
/// one. 2 Hz over a handful of small grids is noise; per-session timers are
/// bookkeeping with no payoff.
fn ensure_ticker(app: &tauri::AppHandle) {
    let _ = app_handle_slot().set(app.clone());
    static TICKER: Once = Once::new();
    TICKER.call_once(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(QUIESCE);
            let Some(app) = app_handle_slot().get() else { continue };
            // Snapshot under the table lock, classify outside it — the
            // classifier allocates the grid text and must not block writes.
            let snapshot: Vec<(&'static str, Option<String>, Arc<Mutex<Shared>>)> = sessions()
                .lock()
                .unwrap()
                .values()
                .map(|s| (s.adapter_id, s.task_ref.clone(), Arc::clone(&s.shared)))
                .collect();
            for (adapter_id, task_ref, shared) in snapshot {
                let notify = {
                    let mut shared = shared.lock().unwrap();
                    if shared.exited || shared.waiting {
                        continue;
                    }
                    let Some(last) = shared.last_byte else { continue };
                    if last.elapsed() < QUIESCE {
                        continue;
                    }
                    let tail = screen_tail(&shared.screen.screen().contents());
                    if screen_waiting(adapter_id, &tail) != Some(true) {
                        continue;
                    }
                    shared.waiting = true;
                    let notify = shared.attached.is_none() && !shared.notified;
                    if notify {
                        shared.notified = true;
                    }
                    notify
                };
                let _ = app.emit("host-changed", ());
                if notify {
                    let adapter_name =
                        adapter(adapter_id).map(|a| a.name).unwrap_or(adapter_id);
                    crate::agent::send_user_notification(
                        app,
                        "Waiting for input",
                        &format!(
                            "{} on {} looks idle at a prompt",
                            adapter_name,
                            task_ref.as_deref().unwrap_or("its task")
                        ),
                        task_ref.as_deref(),
                    );
                }
            }
        });
    });
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
    /// Waiting-detect's verdict (F2): the session looks idle at a prompt.
    /// Heuristic — the UI must say so, never claim it as fact.
    pub waiting: bool,
    /// The CLI's session id is captured and the adapter can resume (F3) —
    /// what the quit dialog uses to promise "resumable next launch".
    pub bound: bool,
}

#[tauri::command]
pub fn host_list() -> Vec<HostInfo> {
    sessions()
        .lock()
        .unwrap()
        .iter()
        .map(|(id, s)| {
            let shared = s.shared.lock().unwrap();
            HostInfo {
                id: *id,
                task_id: s.task_id,
                task_ref: s.task_ref.clone(),
                adapter_id: s.adapter_id,
                adapter_name: adapter(s.adapter_id).map(|a| a.name).unwrap_or(s.adapter_id),
                exited: shared.exited,
                waiting: shared.waiting && !shared.exited,
                bound: s.cli_session_id.is_some()
                    && adapter(s.adapter_id).is_some_and(|a| a.resume_args.is_some()),
            }
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
    ensure_ticker(&app);

    // The prompt is a positional arg; a value starting with '-' would be
    // parsed as a flag by the CLI (argv smuggling). Refs never legitimately
    // start with '-', and `--` end-of-options support is unverified across
    // the three CLIs — reject.
    let mut argv_tail = Vec::new();
    if adapter.prompt_arg {
        if let Some(prompt) = prompt {
            if prompt.starts_with('-') {
                return Err("prompt must not start with '-'".into());
            }
            argv_tail.push(prompt);
        }
    }

    let spawn_app = app.clone();
    let session_id = tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var("HOME").map_err(|_| "no $HOME".to_string())?;
        let cwd = resolve_cwd(claim_cwd.as_deref(), project_name.as_deref(), &home, |p| {
            std::path::Path::new(p).is_dir()
        });
        spawn_hosted(spawn_app, task_id, task_ref, adapter, argv_tail, cwd, cols, rows)
    })
    .await
    .map_err(|e| format!("spawn task failed: {e}"))??;

    let _ = app.emit("host-changed", ());
    Ok(session_id)
}

/// The shared spawn body behind both `host_start` and `host_resume`: PTY,
/// child, session-table entry, persistence row, reader thread. Blocking —
/// callers wrap it in `spawn_blocking`.
#[allow(clippy::too_many_arguments)]
fn spawn_hosted(
    spawn_app: tauri::AppHandle,
    task_id: i64,
    task_ref: Option<String>,
    adapter: &'static Adapter,
    argv_tail: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<u64, String> {
    {
        let bin = resolve_bin(adapter)
            .ok_or_else(|| format!("{} CLI not found — install it first", adapter.name))?;

        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("openpty failed: {e}"))?;
        let mut cmd = CommandBuilder::new(bin);
        for arg in &argv_tail {
            cmd.arg(arg);
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
        let started_at = now_iso();
        // Persistence (F3): the row is what makes this session offerable for
        // resume after a restart. Best-effort — a failed insert (-1) costs
        // only restart survival, never the live session.
        let row_id = db_insert_session(
            &spawn_app,
            task_id,
            task_ref.as_deref(),
            adapter.id,
            &cwd,
            &started_at,
        );
        let shared = Arc::new(Mutex::new(Shared {
            buf: Vec::new(),
            attached: None,
            exited: false,
            screen: vt100::Parser::new(rows, cols, 0),
            last_byte: None,
            waiting: false,
            notified: false,
        }));
        sessions().lock().unwrap().insert(
            session_id,
            HostedSession {
                task_id,
                task_ref: task_ref.clone(),
                adapter_id: adapter.id,
                row_id,
                cwd,
                started_at,
                cli_session_id: None,
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
                        // Output arriving refutes "waiting" instantly — the
                        // verdict clears here, in the same critical section
                        // that feeds the grid, so classifier and buffer can
                        // never disagree about which bytes they saw.
                        let waiting_cleared = {
                            let mut shared = shared.lock().unwrap();
                            shared.buf.extend_from_slice(&chunk[..n]);
                            if shared.buf.len() > RING_CAP {
                                let excess = shared.buf.len() - RING_CAP;
                                shared.buf.drain(..excess);
                            }
                            shared.screen.process(&chunk[..n]);
                            shared.last_byte = Some(Instant::now());
                            let cleared = shared.waiting;
                            shared.waiting = false;
                            shared.notified = false;
                            if let Some(generation) = shared.attached {
                                let _ = reader_app.emit(
                                    "pty-data",
                                    PtyEvent { generation, data: Some(chunk[..n].to_vec()) },
                                );
                            }
                            cleared
                        };
                        if waiting_cleared {
                            let _ = reader_app.emit("host-changed", ());
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
            // A self-exited session is dead for good — its row must not
            // come back as "resumable" on the next launch.
            db_exec(&reader_app, "UPDATE hosted_sessions SET live = 0 WHERE id = ?1", &[&row_id]);
            let _ = reader_app.emit("host-changed", ());
        });

        Ok(session_id)
    }
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
        shared.screen.set_size(rows, cols);
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
        // An explicit kill (or dismiss) is a decision: this session is never
        // offered back as resumable.
        db_exec(&app, "DELETE FROM hosted_sessions WHERE id = ?1", &[&s.row_id]);
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

    // Waiting-detect fixtures: rows lifted from real PTY captures on this
    // machine, 2026-07-19 (claude v2.1.215, codex v0.144.4). Lowercased as
    // `screen_tail` delivers them.
    const CLAUDE_WORKING: &str =
        "✻ dilly-dallying… (1s · ↓1 tokens)\n❯ \n⏵⏵ auto mode on (shift+tab to cycle)";
    const CLAUDE_IDLE: &str =
        "● high · /effort\n❯ try \"edit <filepath> to...\"\n⏵⏵ auto mode on (shift+tab to cycle)";
    const CLAUDE_TRUST: &str =
        "❯ 1. yes, i trust this folder\n2. no, exit\nenter to confirm · esc to cancel";
    const CODEX_WORKING: &str =
        "• starting mcp servers (1/4): codex_apps, node_repl, tildone (0s • esc to interrupt)\n› find and fix a bug in @filename";
    const CODEX_IDLE: &str =
        "› find and fix a bug in @filename\ngpt-5.6-sol high · ~/.claude/jobs/scratch";

    #[test]
    fn claude_classifier_reads_the_token_counter_not_the_old_hint() {
        // v2.1.215 dropped "esc to interrupt"; the live counter is the tell.
        assert_eq!(screen_waiting("claude", CLAUDE_WORKING), Some(false));
        assert_eq!(screen_waiting("claude", CLAUDE_IDLE), Some(true));
        // A trust/permission dialog IS waiting for the user.
        assert_eq!(screen_waiting("claude", CLAUDE_TRUST), Some(true));
        // Older CLIs that still print the hint stay classified as working.
        assert_eq!(screen_waiting("claude", "✽ thinking… esc to interrupt\n❯"), Some(false));
    }

    #[test]
    fn codex_classifier_keys_on_interrupt_hint_then_prompt_char() {
        assert_eq!(screen_waiting("codex", CODEX_WORKING), Some(false));
        assert_eq!(screen_waiting("codex", CODEX_IDLE), Some(true));
    }

    #[test]
    fn unrecognized_screens_and_adapters_answer_none() {
        assert_eq!(screen_waiting("claude", "compiling tildone v0.1.0"), None);
        assert_eq!(screen_waiting("codex", ""), None);
        assert_eq!(screen_waiting("opencode", CODEX_IDLE), None);
    }

    #[test]
    fn screen_tail_keeps_the_last_rows_and_lowercases() {
        let grid = "Row1\n\n  \nRow2\nRow3\nRow4\nRow5\nRow6\nRow7\nRow8\nRow9\nPROMPT ❯";
        let tail = screen_tail(grid);
        assert!(!tail.contains("row1"), "row beyond the 8-row window leaked in");
        assert!(tail.contains("row3"));
        assert!(tail.ends_with("prompt ❯"));
    }

    #[test]
    fn boot_sweep_keeps_only_bound_resumable_live_rows() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        // Minimal task_links so 018's ALTER succeeds — the real migration
        // file is what's under test.
        conn.execute_batch(
            "CREATE TABLE task_links (id INTEGER PRIMARY KEY AUTOINCREMENT, \
             task_id INTEGER, kind TEXT, url TEXT);",
        )
        .unwrap();
        conn.execute_batch(include_str!("../migrations/018_hosted_sessions.sql")).unwrap();
        conn.execute_batch(
            "INSERT INTO hosted_sessions \
             (task_id, task_ref, adapter_id, cwd, cli_session_id, started_at, live) VALUES \
             (1, 'TIL-1', 'claude',   '/w', 'abc', '2026-07-19T00:00:00.000Z', 1), \
             (2, 'TIL-2', 'claude',   '/w', NULL,  '2026-07-19T00:00:00.000Z', 1), \
             (3, 'TIL-3', 'opencode', '/w', 'zzz', '2026-07-19T00:00:00.000Z', 1), \
             (4, 'TIL-4', 'codex',    '/w', 'ddd', '2026-07-19T00:00:00.000Z', 0);",
        )
        .unwrap();
        let keep = sweep_hosted_rows(&conn);
        // Only the live, bound, resume-capable row survives; unbound,
        // no-resume-adapter and self-exited rows are swept.
        assert_eq!(keep.len(), 1);
        assert_eq!(keep[0].task_ref.as_deref(), Some("TIL-1"));
        assert_eq!(keep[0].adapter_id, "claude");
        let left: i64 =
            conn.query_row("SELECT COUNT(*) FROM hosted_sessions", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 1, "swept rows must be deleted, not just skipped");
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
