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
    /// Args every spawn gets before any prompt — the shell's `-l`, so it
    /// reads the user's login rc files like a terminal emulator would.
    base_args: &'static [&'static str],
}

const ADAPTERS: &[Adapter] = &[
    Adapter {
        id: "claude",
        name: "Claude Code",
        bin: "claude",
        home_candidates: &[".local/bin/claude"],
        prompt_arg: true,
        resume_args: Some(claude_resume),
        base_args: &[],
    },
    Adapter {
        id: "codex",
        name: "Codex",
        bin: "codex",
        home_candidates: &[".local/bin/codex"],
        prompt_arg: true,
        resume_args: Some(codex_resume),
        base_args: &[],
    },
    Adapter {
        id: "opencode",
        name: "opencode",
        bin: "opencode",
        home_candidates: &[".opencode/bin/opencode"],
        prompt_arg: false,
        resume_args: None,
        base_args: &[],
    },
    // The escape hatch (spec 2026-07-20-shell-escape-hatch-session-first-
    // intake): a plain shell on the same PTY plumbing. No resume contract —
    // a shell has no session id — so it is excluded from restart survival by
    // construction. `bin` is the fallback; `lookup_bin` prefers $SHELL.
    Adapter {
        id: "shell",
        name: "Shell",
        bin: "zsh",
        home_candidates: &[],
        prompt_arg: false,
        resume_args: None,
        base_args: &["-l"],
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
    // The shell adapter runs the user's own shell, not a fixed binary.
    if adapter.id == "shell" {
        if let Ok(sh) = std::env::var("SHELL") {
            if std::path::Path::new(&sh).exists() {
                return Some(sh);
            }
        }
    }
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

/// The user's real PATH, asked of their own shell. A GUI app inherits
/// launchd's minimal PATH, and the spawned CLI passes that on to everything
/// *it* execs — codex's npm wrapper dies on `#!/usr/bin/env node` even after
/// `resolve_bin` found the wrapper itself (TIL-108). A login shell is not
/// enough: zsh users routinely export PATH from ~/.zshrc, which only an
/// interactive shell reads — so ask `$SHELL -ilc`, sentinel-wrapped so
/// rc-file noise (banners, prompts) can't corrupt the answer, and killed on
/// a deadline so a hung rc file can't wedge every spawn. Cache only
/// successes, same discipline as `resolve_bin`.
fn shell_path() -> Option<String> {
    static CACHE: Mutex<Option<String>> = Mutex::new(None);
    if let Some(hit) = CACHE.lock().unwrap().clone() {
        return Some(hit);
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = run_with_timeout(
        std::process::Command::new(shell).args(["-ilc", r#"printf '\037%s\037' "$PATH""#]),
        Duration::from_secs(5),
    )?;
    let path = path_between_sentinels(&String::from_utf8_lossy(&out))?;
    CACHE.lock().unwrap().replace(path.clone());
    Some(path)
}

/// The text between the first and last 0x1f sentinel — the only bytes of the
/// shell's output we trust.
fn path_between_sentinels(out: &str) -> Option<String> {
    let start = out.find('\u{1f}')? + 1;
    let end = out.rfind('\u{1f}')?;
    (start < end).then(|| out[start..end].to_string())
}

/// Run a command, killing it once `timeout` elapses. Interactive shells run
/// arbitrary rc files; a plain `output()` would let one hung rc block a
/// spawn forever.
fn run_with_timeout(
    cmd: &mut std::process::Command,
    timeout: Duration,
) -> Option<Vec<u8>> {
    use std::process::Stdio;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // Drain concurrently with the wait loop: a chatty rc file can emit more
    // than the pipe holds, and an undrained pipe blocks the child mid-write —
    // turning every such spawn into a full-deadline stall (codex verify
    // finding, 2026-07-20).
    let mut stdout = child.stdout.take()?;
    let drain = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + timeout;
    while child.try_wait().ok()?.is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            // The kill closed the pipe's write end; the drain hits EOF.
            let _ = drain.join();
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let status = child.wait().ok()?;
    let buf = drain.join().ok()?;
    status.success().then_some(buf)
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
    /// When the session became continuously idle-at-prompt (agents: waiting
    /// flipped; shells: output quiesced). Cleared by any output. The unbound
    /// lifecycle (remind → expiry chip → expire) is measured from here;
    /// "keep" resets it to now.
    idle_since: Option<Instant>,
    /// Last unbound-lifecycle stage the ticker saw — a change emits
    /// `host-changed` exactly once per transition.
    unbound_stage: UnboundStage,
}

struct HostedSession {
    /// None = unbound: no card yet (session-first intake). Bind-on-claim or
    /// the expiry chip's "make it a task" fills it in.
    task_id: Option<i64>,
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
    /// The CLI's own session id, once an artifact *proves* it (F3's resume
    /// key, and only that). Set-once — racing bind sources are benign. Stays
    /// None for a shell running a bare `claude`, which can prove nothing:
    /// unresumable is the honest state, and never wrong.
    cli_session_id: Option<String>,
    /// Which agent session owns this pane, learned from the claim that pid
    /// ancestry matched to it. Split from `cli_session_id` (TIL-130) because
    /// the two answer different questions and only one is artifact-provable —
    /// a session may own a card and still have no resume key.
    claim_session_id: Option<String>,
    /// The first line typed into an unbound session, accumulated until Enter —
    /// the "make it a task" title hint. Never collected once bound.
    first_input: String,
    first_input_done: bool,
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
    // Unbound sessions collect their first typed line as the "make it a
    // task" title hint. Bound sessions never do.
    if s.task_id.is_none() && !s.first_input_done {
        let mut done = s.first_input_done;
        accumulate_first_input(&mut s.first_input, &mut done, data);
        s.first_input_done = done;
    }
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
    task_id: Option<i64>,
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
    /// None for a session-first (task-less) session — the claims fallback in
    /// artifacts.rs needs a task to look up, so it skips these.
    pub task_id: Option<i64>,
    pub adapter_id: &'static str,
    /// The cwd the session was spawned in.
    pub cwd: String,
    /// The PTY child's pid, when the OS still reports one. A shell's own cwd
    /// follows the user's `cd`s, so it — not `cwd` — names the directory an
    /// agent CLI launched at the prompt will file its transcript under.
    pub pid: Option<u32>,
    /// ISO — binding only accepts artifacts stamped at or after this.
    pub started_at: String,
}

/// Which adapters can reveal a CLI session id through an artifact. Agent
/// adapters write one themselves; a shell writes none, but the user may run
/// `claude` or `codex` at its prompt, and that CLI's artifacts are what bind
/// the shell's pane to a card (TIL-128). Adapters that produce nothing we can
/// watch (opencode) stay out.
fn bindable(adapter_id: &str) -> bool {
    matches!(adapter_id, "claude" | "codex" | "shell")
}

pub(crate) fn unbound_hosted() -> Vec<UnboundHosted> {
    sessions()
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, s)| s.cli_session_id.is_none() && bindable(s.adapter_id))
        .map(|(id, s)| UnboundHosted {
            session_id: *id,
            task_id: s.task_id,
            adapter_id: s.adapter_id,
            cwd: s.cwd.clone(),
            pid: s.child.process_id(),
            started_at: s.started_at.clone(),
        })
        .collect()
}

/// Set-once binding of the CLI's own session id (the resume key). Racing
/// sources (transcript file vs MCP claim) are benign — first writer wins.
pub(crate) fn bind_cli_session(app: &tauri::AppHandle, session_id: u64, cli_session_id: &str) {
    let (row_id, unbound) = {
        let mut table = sessions().lock().unwrap();
        let Some(s) = table.get_mut(&session_id) else { return };
        if s.cli_session_id.is_some() {
            return;
        }
        s.cli_session_id = Some(cli_session_id.to_string());
        (s.row_id, s.task_id.is_none())
    };
    db_exec(
        app,
        "UPDATE hosted_sessions SET cli_session_id = ?1 WHERE id = ?2",
        &[&cli_session_id, &row_id],
    );
    // Bind-on-claim, late-capture direction: the agent may have claimed its
    // card over MCP before any transcript revealed this id. Now that the id
    // is known, an existing claim under it names this session's card.
    if unbound {
        if let Ok(conn) = crate::agent::open_db(app) {
            if let Ok(task_id) = conn.query_row(
                "SELECT task_id FROM agent_claims WHERE session_id = ?1",
                [cli_session_id],
                |r| r.get::<_, i64>(0),
            ) {
                let task_ref = task_ref_for(app, task_id);
                adopt_task(app, session_id, task_id, task_ref, Some(cli_session_id));
            }
        }
    }
}

/// The bind-on-claim decision, pure for tests: an unbound session whose
/// captured CLI id equals the claim's session id adopts the claimed card.
fn adoptable(cli_session_id: Option<&str>, task_id: Option<i64>, claim_sid: &str) -> bool {
    task_id.is_none() && cli_session_id == Some(claim_sid)
}

fn task_ref_for(app: &tauri::AppHandle, task_id: i64) -> Option<String> {
    let conn = crate::agent::open_db(app).ok()?;
    conn.query_row("SELECT \"ref\" FROM tasks WHERE id = ?1", [task_id], |r| {
        r.get::<_, Option<String>>(0)
    })
    .ok()
    .flatten()
}

/// Adopt a card onto an unbound hosted session: set task_id/ref, persist,
/// announce. The shared tail of bind-on-claim and "make it a task". A bound
/// session never rebinds.
fn adopt_task(
    app: &tauri::AppHandle,
    session_id: u64,
    task_id: i64,
    task_ref: Option<String>,
    claim_sid: Option<&str>,
) {
    let (row_id, claim_sid) = {
        let mut table = sessions().lock().unwrap();
        let Some(s) = table.get_mut(&session_id) else { return };
        if s.task_id.is_some() {
            return;
        }
        s.task_id = Some(task_id);
        s.task_ref = task_ref.clone();
        // Who owns the pane, recorded alongside the card it earned. Kept
        // distinct from `cli_session_id`, which stays the resume key.
        if let Some(sid) = claim_sid {
            s.claim_session_id = Some(sid.to_string());
        }
        (s.row_id, s.claim_session_id.clone())
    };
    db_exec(
        app,
        "UPDATE hosted_sessions SET task_id = ?1, task_ref = ?2, claim_session_id = ?3 \
         WHERE id = ?4",
        &[&task_id, &task_ref, &claim_sid, &row_id],
    );
    let _ = app.emit("host-changed", ());
}

/// `(session_id, PTY child pid)` for every hosted session that still has no
/// card — the candidate set pid-ancestry adoption resolves against.
fn unbound_pty_pids() -> Vec<(u64, u32)> {
    sessions()
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, s)| s.task_id.is_none())
        .filter_map(|(id, s)| s.child.process_id().map(|pid| (*id, pid)))
        .collect()
}

/// Bind-on-claim, claim-first direction (spec 2026-07-20-shell-escape-hatch-
/// session-first-intake): an MCP `doing`-claim just landed. If an unbound
/// hosted session already captured that CLI session id, the claimed card is
/// its card — no new protocol, the claim the agent already sends is the
/// signal. Called from the agent server on every recorded claim.
pub(crate) fn try_adopt_claim(claim_sid: &str, task_id: i64, last_pid: Option<u32>) {
    let Some(app) = app_handle_slot().get().cloned() else { return };
    // Preferred: process ancestry. `last_pid` comes from the claiming
    // session's own heartbeat hook, so it names a process in *that* session's
    // tree and no stranger can donate it. This is what makes a bare `claude`
    // at a shell prompt bindable at all — it publishes no artifact we can
    // attribute (TIL-130).
    let by_pid = last_pid.and_then(|pid| {
        let candidates = unbound_pty_pids();
        if candidates.is_empty() {
            return None;
        }
        crate::artifacts::session_for_claim(&crate::artifacts::ps_snapshot(), &candidates, pid)
    });
    // Fallback: id equality, for an adapter session whose `cli_session_id`
    // Tildone assigned itself (and for a shell that argv-proved one). Sound
    // now that a shell can no longer hold an unproven value.
    let found = by_pid.or_else(|| {
        sessions()
            .lock()
            .unwrap()
            .iter()
            .find(|(_, s)| adoptable(s.cli_session_id.as_deref(), s.task_id, claim_sid))
            .map(|(id, _)| *id)
    });
    if let Some(session_id) = found {
        let task_ref = task_ref_for(&app, task_id);
        adopt_task(&app, session_id, task_id, task_ref, Some(claim_sid));
    }
}

/// The expiry chip's "make it a task": the frontend created the card; bind
/// it here. Also the manual bind path for shells (no MCP, no self-claim).
#[tauri::command]
pub fn host_bind_task(
    app: tauri::AppHandle,
    session_id: u64,
    task_id: i64,
    task_ref: Option<String>,
) {
    adopt_task(&app, session_id, task_id, task_ref, None);
}

/// The expiry chip's "keep": restart the unbound idle clock — a snooze, not
/// a setting.
#[tauri::command]
pub fn host_keep(app: tauri::AppHandle, session_id: u64) {
    if let Some(s) = sessions().lock().unwrap().get(&session_id) {
        let mut shared = s.shared.lock().unwrap();
        shared.idle_since = Some(Instant::now());
        shared.unbound_stage = UnboundStage::Quiet;
    }
    let _ = app.emit("host-changed", ());
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
    let rows: Vec<(i64, Option<i64>, Option<String>, String, String, Option<String>, i64)> = stmt
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
        // Binding earns persistence: an unbound (task-less) row never becomes
        // a resumable, whatever else it has going for it.
        let resumable = live == 1
            && task_id.is_some()
            && cli.is_some()
            && adapter(&adapter_id).is_some_and(|a| a.resume_args.is_some());
        if resumable {
            let adapter_name =
                adapter(&adapter_id).map(|a| a.name.to_string()).unwrap_or_else(|| adapter_id.clone());
            keep.push(ResumableInfo {
                row_id: id,
                task_id: task_id.unwrap(),
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
    // Bind-on-claim needs a handle before any session ever starts a ticker.
    let _ = app_handle_slot().set(app.clone());
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
        spawn_hosted(spawn_app, Some(info.task_id), info.task_ref, adapter, argv_tail, cwd, cols, rows)
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

/// One ticker visit to one session: decide the waiting flag and whether the
/// user notification fires now. Pure over `Shared` so the lifecycle —
/// including the deferred-notify path — is unit-testable.
///
/// The deferred path exists because the flip can happen while a pane is
/// attached (the user is watching; notifying would be noise). If that pane
/// later detaches with the session still waiting, the notification must
/// still fire — computing notify only at the flip starves it forever
/// (codex verify finding, 2026-07-19). Returns (chip_changed, notify).
fn tick_session(shared: &mut Shared, adapter_id: &str) -> (bool, bool) {
    if shared.exited {
        return (false, false);
    }
    if !shared
        .last_byte
        .is_some_and(|last| last.elapsed() >= QUIESCE)
    {
        return (false, false);
    }
    if shared.waiting {
        // Already waiting: fire the deferred notification the first tick the
        // session is both unattended and un-notified.
        if shared.attached.is_none() && !shared.notified {
            shared.notified = true;
            return (false, true);
        }
        return (false, false);
    }
    let tail = screen_tail(&shared.screen.screen().contents());
    if screen_waiting(adapter_id, &tail) != Some(true) {
        return (false, false);
    }
    shared.waiting = true;
    let notify = shared.attached.is_none() && !shared.notified;
    if notify {
        shared.notified = true;
    }
    (true, notify)
}

/// One ticker visit to one session's unbound lifecycle: anchor `idle_since`
/// (agents are idle when the classifier says waiting; shells once output has
/// quiesced — they have no classifier), then derive the stage. Pure over
/// `Shared` for unit tests. Returns (stage_changed, expire_now).
fn lifecycle_tick(shared: &mut Shared, adapter_id: &str, unbound: bool) -> (bool, bool) {
    if shared.exited {
        return (false, false);
    }
    let quiesced = shared.last_byte.is_some_and(|l| l.elapsed() >= QUIESCE);
    let idle = if adapter_id == "shell" { quiesced } else { shared.waiting };
    if idle {
        if shared.idle_since.is_none() {
            shared.idle_since = Some(Instant::now());
        }
    } else {
        shared.idle_since = None;
    }
    if !unbound {
        let changed = shared.unbound_stage != UnboundStage::Quiet;
        shared.unbound_stage = UnboundStage::Quiet;
        return (changed, false);
    }
    let stage = unbound_stage(shared.idle_since.map(|s| s.elapsed()));
    let changed = stage != shared.unbound_stage;
    shared.unbound_stage = stage;
    (changed, changed && stage == UnboundStage::Expired)
}

/// The expiry action: terminate the CLI but keep the table entry — the
/// reader thread sees EOF and degrades it to the dismissible exited state,
/// scrollback intact. Never `host_kill` (that would vanish the session).
fn expire_session(session_id: u64) {
    if let Some(s) = sessions().lock().unwrap().get_mut(&session_id) {
        let _ = s.child.kill();
    }
}

// -- unbound lifecycle (spec 2026-07-20-shell-escape-hatch-session-first-intake)

/// After this long continuously idle, an unbound session's row shows the
/// quiet "no card yet" hint.
const UNBOUND_REMIND: Duration = Duration::from_secs(30 * 60);
/// From here the hint escalates to the expiry chip (make it a task / keep).
const UNBOUND_EXPIRE_SOON: Duration = Duration::from_secs(105 * 60);
/// At two hours unbound + idle the session is expired: the CLI is terminated
/// and the entry degrades to the dismissible exited state — scrollback
/// intact, never a silent vanish. Constants, not settings, by design.
const UNBOUND_EXPIRE: Duration = Duration::from_secs(120 * 60);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum UnboundStage {
    Quiet,
    Remind,
    ExpireSoon,
    Expired,
}

/// The lifecycle state machine, pure over the idle duration. `None` idle
/// (output still streaming, or never quiesced) is always Quiet — a session
/// mid-work is never reminded, expired, or killed.
fn unbound_stage(idle_for: Option<Duration>) -> UnboundStage {
    match idle_for {
        None => UnboundStage::Quiet,
        Some(d) if d >= UNBOUND_EXPIRE => UnboundStage::Expired,
        Some(d) if d >= UNBOUND_EXPIRE_SOON => UnboundStage::ExpireSoon,
        Some(d) if d >= UNBOUND_REMIND => UnboundStage::Remind,
        Some(_) => UnboundStage::Quiet,
    }
}

/// Accumulate the first typed line of an unbound session — the "make it a
/// task" title hint. Printable bytes only (arrow keys and other escape
/// sequences would smuggle garbage into a card title); Enter finishes the
/// line, and only a non-empty line counts as finished.
fn accumulate_first_input(buf: &mut String, done: &mut bool, data: &[u8]) {
    if *done {
        return;
    }
    let mut i = 0;
    while i < data.len() {
        match data[i] {
            0x1b => {
                // Skip the whole sequence: CSI (ESC [ … final 0x40–0x7e), or
                // ESC + one byte (Alt+key sends ESC f — the f is part of the
                // sequence, not title text). A keystroke arrives as one
                // write, so sequences don't split across calls in practice.
                i += 1;
                if data.get(i) == Some(&b'[') {
                    i += 1;
                    while i < data.len() && !(0x40..=0x7e).contains(&data[i]) {
                        i += 1;
                    }
                }
            }
            b'\r' | b'\n' => {
                if !buf.trim().is_empty() {
                    *done = true;
                    return;
                }
            }
            0x7f | 0x08 => {
                buf.pop();
            }
            b @ 0x20..=0x7e => {
                if buf.len() < 200 {
                    buf.push(b as char);
                }
            }
            _ => {}
        }
        i += 1;
    }
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
            let snapshot: Vec<(u64, &'static str, Option<String>, bool, Arc<Mutex<Shared>>)> =
                sessions()
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|(id, s)| {
                        (
                            *id,
                            s.adapter_id,
                            s.task_ref.clone(),
                            s.task_id.is_none(),
                            Arc::clone(&s.shared),
                        )
                    })
                    .collect();
            for (session_id, adapter_id, task_ref, unbound, shared) in snapshot {
                let (flipped, notify, stage_changed, expire_now) = {
                    let mut shared = shared.lock().unwrap();
                    let (flipped, notify) = tick_session(&mut shared, adapter_id);
                    let (stage_changed, expire_now) =
                        lifecycle_tick(&mut shared, adapter_id, unbound);
                    (flipped, notify, stage_changed, expire_now)
                };
                if expire_now {
                    expire_session(session_id);
                }
                if flipped || stage_changed {
                    let _ = app.emit("host-changed", ());
                }
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
    /// None = unbound (no card yet).
    pub task_id: Option<i64>,
    pub task_ref: Option<String>,
    pub adapter_id: &'static str,
    pub adapter_name: &'static str,
    pub cwd: String,
    pub exited: bool,
    /// Waiting-detect's verdict (F2): the session looks idle at a prompt.
    /// Heuristic — the UI must say so, never claim it as fact.
    pub waiting: bool,
    /// The CLI's session id is captured and the adapter can resume (F3) —
    /// what the quit dialog uses to promise "resumable next launch".
    pub bound: bool,
    /// Unbound lifecycle stage for the sidebar row: "remind" (quiet "no card
    /// yet" hint) or "expire-soon" (the make-it-a-task / keep chip). Absent
    /// while quiet or bound.
    pub unbound_stage: Option<&'static str>,
    /// Seconds until expiry, present in the expire-soon stage — the chip's
    /// countdown.
    pub expires_in_secs: Option<u64>,
    /// The first line typed into an unbound session — "make it a task"'s
    /// title suggestion.
    pub title_hint: Option<String>,
}

#[tauri::command]
pub fn host_list() -> Vec<HostInfo> {
    sessions()
        .lock()
        .unwrap()
        .iter()
        .map(|(id, s)| {
            let shared = s.shared.lock().unwrap();
            let (unbound_stage, expires_in_secs) = if s.task_id.is_none() && !shared.exited {
                match shared.unbound_stage {
                    UnboundStage::Remind => (Some("remind"), None),
                    UnboundStage::ExpireSoon => (
                        Some("expire-soon"),
                        shared.idle_since.map(|since| {
                            UNBOUND_EXPIRE.saturating_sub(since.elapsed()).as_secs()
                        }),
                    ),
                    _ => (None, None),
                }
            } else {
                (None, None)
            };
            let title_hint = (s.task_id.is_none() && s.first_input_done)
                .then(|| s.first_input.trim().chars().take(60).collect::<String>())
                .filter(|t: &String| !t.is_empty());
            HostInfo {
                id: *id,
                task_id: s.task_id,
                task_ref: s.task_ref.clone(),
                adapter_id: s.adapter_id,
                adapter_name: adapter(s.adapter_id).map(|a| a.name).unwrap_or(s.adapter_id),
                cwd: s.cwd.clone(),
                exited: shared.exited,
                waiting: shared.waiting && !shared.exited,
                bound: s.cli_session_id.is_some()
                    && adapter(s.adapter_id).is_some_and(|a| a.resume_args.is_some()),
                unbound_stage,
                expires_in_secs,
                title_hint,
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

/// Start a session — for a task, or unbound (task_id None: session-first
/// intake; bind-on-claim or "make it a task" cards it later). Spawn only —
/// the caller opens the pane, whose mount runs the one shared attach path
/// (`host_attach`). Returns the session id that names it for jumps and kill.
#[tauri::command]
pub async fn host_start(
    app: tauri::AppHandle,
    task_id: Option<i64>,
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
    task_id: Option<i64>,
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
        for arg in adapter.base_args {
            cmd.arg(arg);
        }
        for arg in &argv_tail {
            cmd.arg(arg);
        }
        cmd.env("TERM", "xterm-256color");
        // The user's shell PATH, not launchd's: the CLI execs tools at
        // runtime, and codex's wrapper re-execs through `#!/usr/bin/env
        // node` before it can print a byte (TIL-108).
        if let Some(path) = shell_path() {
            cmd.env("PATH", path);
        }
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
            idle_since: None,
            unbound_stage: UnboundStage::Quiet,
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
                claim_session_id: None,
                first_input: String::new(),
                first_input_done: false,
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
                            // Output refutes idleness — the unbound clock
                            // restarts from the next quiesce.
                            shared.idle_since = None;
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
    fn adapter_table_has_the_three_v1_clis_and_the_shell() {
        let ids: Vec<_> = ADAPTERS.iter().map(|a| a.id).collect();
        assert_eq!(ids, vec!["claude", "codex", "opencode", "shell"]);
    }

    #[test]
    fn shell_adapter_is_a_login_shell_with_no_resume_contract() {
        let sh = adapter("shell").unwrap();
        // No resume args → excluded from resumables by construction
        // (binding earns persistence, and a shell has no session id at all).
        assert!(sh.resume_args.is_none());
        assert!(!sh.prompt_arg, "a shell takes no positional prompt");
        assert_eq!(sh.base_args, &["-l"], "spawn as a login shell, like a terminal");
        // And the waiting classifier never has a verdict for it — a shell
        // prompt is not "waiting for you".
        assert_eq!(screen_waiting("shell", "~/projects %"), None);
    }

    #[test]
    fn shells_are_watched_for_binding_because_a_cli_may_run_at_the_prompt() {
        assert!(bindable("shell"), "TIL-128: a shell-hosted claude must be able to bind");
        assert!(bindable("claude"));
        assert!(bindable("codex"));
        assert!(!bindable("opencode"), "no artifact we know how to watch");
    }

    #[test]
    fn unbound_stage_boundaries() {
        use UnboundStage::*;
        let m = |mins: u64| Some(Duration::from_secs(mins * 60));
        assert_eq!(unbound_stage(None), Quiet, "mid-work is never staged");
        assert_eq!(unbound_stage(m(29)), Quiet);
        assert_eq!(unbound_stage(m(30)), Remind);
        assert_eq!(unbound_stage(m(104)), Remind);
        assert_eq!(unbound_stage(m(105)), ExpireSoon);
        assert_eq!(unbound_stage(m(119)), ExpireSoon);
        assert_eq!(unbound_stage(m(120)), Expired);
    }

    #[test]
    fn first_input_accumulates_printables_until_enter() {
        let mut buf = String::new();
        let mut done = false;
        // Escape sequences (arrows) and control bytes never land in a title.
        accumulate_first_input(&mut buf, &mut done, b"\x1b[Afix th");
        accumulate_first_input(&mut buf, &mut done, b"e\x7f\x7fhe bug\r");
        assert!(done);
        assert_eq!(buf, "fix the bug");
        // Post-Enter bytes are ignored — the hint is the FIRST line.
        accumulate_first_input(&mut buf, &mut done, b"second line\r");
        assert_eq!(buf, "fix the bug");
        // A bare Enter on an empty buffer does not finish the line.
        let mut buf = String::new();
        let mut done = false;
        accumulate_first_input(&mut buf, &mut done, b"\r\r\n");
        assert!(!done);
        assert!(buf.is_empty());
        // Alt+key arrives as ESC + byte — the byte belongs to the sequence
        // and must not leak into the title (codex-verify finding check,
        // 2026-07-20: pinned here because the loop's trailing increment is
        // what consumes it, which is easy to misread).
        let mut buf = String::new();
        let mut done = false;
        accumulate_first_input(&mut buf, &mut done, b"\x1bfhi\r");
        assert!(done);
        assert_eq!(buf, "hi");
    }

    #[test]
    fn adoption_needs_an_unbound_session_with_the_exact_cli_id() {
        let sid = "019ebaed-7e23-7e53-8fd5-08fafab4e104";
        assert!(adoptable(Some(sid), None, sid));
        assert!(!adoptable(Some(sid), Some(7), sid), "bound sessions never rebind");
        assert!(!adoptable(None, None, sid), "no captured id, nothing to match");
        assert!(!adoptable(Some("other"), None, sid));
    }

    /// Migration 021: shell rows captured their id under a guard that never
    /// proved ownership, so every stored value is unproven and one is known to
    /// have come from a stranger. Adapter rows assigned their own id and keep
    /// it. A wrong resume key would open someone else's conversation; a null
    /// one only costs an offer.
    #[test]
    fn the_split_clears_every_unproven_shell_resume_key() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        // 018 touches task_links; the sweep test above stubs it the same way.
        conn.execute_batch(
            "CREATE TABLE task_links (id INTEGER PRIMARY KEY AUTOINCREMENT, \
             task_id INTEGER, kind TEXT, url TEXT);",
        )
        .unwrap();
        conn.execute_batch(include_str!("../migrations/018_hosted_sessions.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/020_unbound_sessions.sql")).unwrap();
        conn.execute_batch(
            "INSERT INTO hosted_sessions \
             (task_id, task_ref, adapter_id, cwd, cli_session_id, started_at, live) VALUES \
             (1, 'TIL-1', 'claude', '/w', 'assigned-by-tildone', '2026-07-20T00:00:00.000Z', 1), \
             (NULL, NULL, 'shell', '/w', 'donated-by-a-stranger', '2026-07-20T00:00:00.000Z', 1);",
        )
        .unwrap();
        conn.execute_batch(include_str!("../migrations/021_shell_bind_identity.sql")).unwrap();

        let shell: Option<String> = conn
            .query_row(
                "SELECT cli_session_id FROM hosted_sessions WHERE adapter_id = 'shell'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(shell, None, "an unproven shell key must not survive the upgrade");
        let adapter: Option<String> = conn
            .query_row(
                "SELECT cli_session_id FROM hosted_sessions WHERE adapter_id = 'claude'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(adapter.as_deref(), Some("assigned-by-tildone"));
        // The new ownership column exists and starts empty for every row.
        let unowned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM hosted_sessions WHERE claim_session_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(unowned, 2);
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
    fn sentinel_parse_survives_rc_noise() {
        // Banners before, prompt junk after — only the sentinel span counts.
        assert_eq!(
            path_between_sentinels("welcome!\n\u{1f}/a/bin:/b/bin\u{1f}\n% "),
            Some("/a/bin:/b/bin".to_string())
        );
        // No sentinels (shell died mid-rc), one sentinel, empty span: all misses.
        assert_eq!(path_between_sentinels("/a/bin:/b/bin"), None);
        assert_eq!(path_between_sentinels("noise\u{1f}truncated"), None);
        assert_eq!(path_between_sentinels("\u{1f}\u{1f}"), None);
    }

    #[test]
    fn run_with_timeout_completes_and_kills() {
        let out = run_with_timeout(
            std::process::Command::new("/bin/sh").args(["-c", "printf ok"]),
            Duration::from_secs(5),
        );
        assert_eq!(out.as_deref(), Some(b"ok".as_ref()));
        // A command that outlives the deadline comes back None, not hung.
        let hung = run_with_timeout(
            std::process::Command::new("/bin/sh").args(["-c", "sleep 30"]),
            Duration::from_millis(100),
        );
        assert!(hung.is_none());
    }

    #[test]
    fn run_with_timeout_drains_more_than_a_pipe_holds() {
        // A chatty rc emits more than the ~64KB pipe buffer before the
        // sentinel. Without a concurrent drain the child blocks mid-write,
        // never exits, and burns the whole deadline — this returned None
        // before the drain thread existed.
        let out = run_with_timeout(
            std::process::Command::new("/bin/sh")
                .args(["-c", "head -c 200000 /dev/zero | tr '\\0' x; printf done"]),
            Duration::from_secs(5),
        )
        .expect("large output must complete, not stall to the deadline");
        assert_eq!(out.len(), 200_000 + 4);
        assert!(out.ends_with(b"done"));
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

    /// A session already quiesced on the claude idle screen, with the pane
    /// state under test.
    fn idle_shared(attached: Option<u64>) -> Shared {
        let mut screen = vt100::Parser::new(24, 80, 0);
        screen.process(CLAUDE_IDLE.as_bytes());
        Shared {
            buf: Vec::new(),
            attached,
            exited: false,
            screen,
            last_byte: Some(Instant::now() - QUIESCE),
            waiting: false,
            notified: false,
            idle_since: None,
            unbound_stage: UnboundStage::Quiet,
        }
    }

    #[test]
    fn lifecycle_anchors_idle_on_waiting_for_agents_and_quiesce_for_shells() {
        // Agent, quiesced but not waiting: no idle anchor.
        let mut s = idle_shared(None);
        lifecycle_tick(&mut s, "claude", true);
        assert!(s.idle_since.is_none());
        // Waiting flips → the anchor sets.
        s.waiting = true;
        lifecycle_tick(&mut s, "claude", true);
        assert!(s.idle_since.is_some());
        // A shell anchors on quiescence alone (it has no classifier).
        let mut s = idle_shared(None);
        lifecycle_tick(&mut s, "shell", true);
        assert!(s.idle_since.is_some());
        // Still-streaming output means no anchor, whatever the adapter.
        let mut s = idle_shared(None);
        s.last_byte = Some(Instant::now());
        lifecycle_tick(&mut s, "shell", true);
        assert!(s.idle_since.is_none());
        // Bound sessions never accumulate a stage.
        let mut s = idle_shared(None);
        s.waiting = true;
        s.idle_since = Some(Instant::now() - UNBOUND_EXPIRE);
        let (_, expire) = lifecycle_tick(&mut s, "claude", false);
        assert!(!expire);
        assert_eq!(s.unbound_stage, UnboundStage::Quiet);
        // An unbound one at the expiry threshold expires exactly once.
        let mut s = idle_shared(None);
        s.waiting = true;
        s.idle_since = Some(Instant::now() - UNBOUND_EXPIRE);
        let (changed, expire) = lifecycle_tick(&mut s, "claude", true);
        assert!(changed && expire);
        let (changed, expire) = lifecycle_tick(&mut s, "claude", true);
        assert!(!changed && !expire, "the expire action must not repeat");
    }

    #[test]
    fn unattended_flip_notifies_exactly_once() {
        let mut s = idle_shared(None);
        assert_eq!(tick_session(&mut s, "claude"), (true, true));
        assert_eq!(tick_session(&mut s, "claude"), (false, false));
    }

    #[test]
    fn deferred_notification_fires_when_the_pane_later_detaches() {
        // Flip while a pane is attached: chip changes, no notification —
        // the user is watching.
        let mut s = idle_shared(Some(7));
        assert_eq!(tick_session(&mut s, "claude"), (true, false));
        assert_eq!(tick_session(&mut s, "claude"), (false, false));
        // Pane closes with the session still waiting: the notification must
        // fire now, once — the starvation codex verify caught (2026-07-19).
        s.attached = None;
        assert_eq!(tick_session(&mut s, "claude"), (false, true));
        assert_eq!(tick_session(&mut s, "claude"), (false, false));
    }

    #[test]
    fn exited_and_busy_sessions_never_tick() {
        let mut s = idle_shared(None);
        s.exited = true;
        assert_eq!(tick_session(&mut s, "claude"), (false, false));
        let mut s = idle_shared(None);
        s.last_byte = Some(Instant::now()); // still streaming
        assert_eq!(tick_session(&mut s, "claude"), (false, false));
    }

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
        // 020 relaxes task_id to nullable — production schema is 018 + 020.
        conn.execute_batch(include_str!("../migrations/020_unbound_sessions.sql")).unwrap();
        conn.execute_batch(
            "INSERT INTO hosted_sessions \
             (task_id, task_ref, adapter_id, cwd, cli_session_id, started_at, live) VALUES \
             (1, 'TIL-1', 'claude',   '/w', 'abc', '2026-07-19T00:00:00.000Z', 1), \
             (2, 'TIL-2', 'claude',   '/w', NULL,  '2026-07-19T00:00:00.000Z', 1), \
             (3, 'TIL-3', 'opencode', '/w', 'zzz', '2026-07-19T00:00:00.000Z', 1), \
             (4, 'TIL-4', 'codex',    '/w', 'ddd', '2026-07-19T00:00:00.000Z', 0), \
             (NULL, NULL, 'claude',   '/w', 'eee', '2026-07-19T00:00:00.000Z', 1), \
             (NULL, NULL, 'shell',    '/w', NULL,  '2026-07-19T00:00:00.000Z', 1);",
        )
        .unwrap();
        let keep = sweep_hosted_rows(&conn);
        // Only the live, bound, resume-capable, TASK-BOUND row survives;
        // unbound-cli, no-resume-adapter, self-exited, and task-less rows
        // (binding earns persistence) are all swept.
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
