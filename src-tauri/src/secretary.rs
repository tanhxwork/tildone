//! The board secretary: derives board progress from claimed sessions'
//! transcripts so cloud agents stop paying API turns to restate facts the
//! transcript already holds (spec 2026-07-21-local-ai-board-secretary).
//!
//! Two lanes over one poll loop, tracked by two cursors per session
//! (migration 022):
//!
//! - the **scan lane** (deterministic, no model) extracts candidate events
//!   from appended transcript lines and auto-links evidence — repo docs at
//!   their main-checkout path, scratch artifacts copied into the app's
//!   attachments store. It always advances.
//! - the **decide lane** hands narration/command candidates to the local AI
//!   engine, which replies with `tick <n>` / `log <line>` / `nothing`. Its
//!   cursor freezes while the engine is unavailable and drains the backlog
//!   when it returns — catch-up is a re-read of the transcript file, never a
//!   queue of stored text.
//!
//! Every write is low-stakes by construction: attributed to `tildone-ai`,
//! regenerable from the transcript, and incapable of ticking a `verify:`
//! step (the same guard the MCP surface enforces).

use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

/// The actor_name every secretary write carries. Distinct from any MCP
/// client's name so the Activity feed shows exactly which lines the local
/// model wrote, and a mistake is auditable to its author.
const ACTOR: &str = "tildone-ai";

/// Poll cadence with live claims; the idle cadence when disabled or unclaimed.
const TICK: Duration = Duration::from_secs(2);
const IDLE_TICK: Duration = Duration::from_secs(6);

/// Per-cycle read cap per session and lane. Bounds one loop iteration; a
/// bigger backlog simply takes several cycles.
const READ_CAP: u64 = 256 * 1024;

/// One engine probe answer is trusted this long before re-asking.
const ENGINE_PROBE_TTL: Duration = Duration::from_secs(5);

/// Length caps for what reaches the model and the Activity feed.
const NARRATION_CAP: usize = 400;
const COMMAND_CAP: usize = 200;
const LOG_CAP: usize = 200;

/// A scratch artifact bigger than this is not copied into attachments.
const COPY_CAP: u64 = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Config + status — the frontend's two handles on the loop.

/// What the AI store pushed down: whether the secretary is on, and where the
/// engine lane should send completions. The loop reads this every cycle, so a
/// settings change takes effect without restarting anything.
#[derive(Clone, Default)]
pub struct SecretaryConfig {
    pub enabled: bool,
    pub base_url: String,
    pub model: String,
    pub disable_thinking: bool,
}

fn config_cell() -> &'static Mutex<SecretaryConfig> {
    static CELL: OnceLock<Mutex<SecretaryConfig>> = OnceLock::new();
    CELL.get_or_init(Default::default)
}

/// What the UI shows: the settings status row and the card indicator.
#[derive(Serialize, Clone, Default)]
pub struct SecretaryStatus {
    pub enabled: bool,
    pub engine_ready: bool,
    /// Task ids with a watched live transcript.
    pub watching: Vec<i64>,
    /// Task ids whose decide lane is behind the scan lane — the "catching
    /// up" pulse on the card while the engine is off or draining.
    pub behind: Vec<i64>,
}

fn status_cell() -> &'static Mutex<SecretaryStatus> {
    static CELL: OnceLock<Mutex<SecretaryStatus>> = OnceLock::new();
    CELL.get_or_init(Default::default)
}

#[tauri::command]
pub fn secretary_configure(enabled: bool, base_url: String, model: String, disable_thinking: bool) {
    *config_cell().lock().unwrap() = SecretaryConfig {
        enabled,
        base_url,
        model,
        disable_thinking,
    };
}

#[tauri::command]
pub fn secretary_status() -> SecretaryStatus {
    status_cell().lock().unwrap().clone()
}

// ---------------------------------------------------------------------------
// Candidate extraction (pure) — the pre-filter both lanes share.

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Candidate {
    /// Assistant text between tool calls — checkpoint narration.
    Narration(String),
    /// A Bash tool call's command line.
    Command(String),
    /// The tail of a tool result that reads like a verification outcome
    /// ("259 passed", "build failed") — the pass/fail signal the spec names,
    /// which commands and narration alone don't reliably carry.
    Outcome(String),
    /// A file the session wrote (Write/Edit tools) — the evidence lane's input.
    FileWrite(String),
}

/// A tool-result excerpt is only a candidate when it smells like an outcome —
/// anything else (file dumps, listings) is bulk the model doesn't need.
fn is_outcome_signal(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    ["pass", "fail", "error", "warning", "test result", "exit code", "✓", "✗", "ok."]
        .iter()
        .any(|m| lower.contains(m))
}

/// Tool-result lines bigger than this are not parsed for outcomes. Equal to
/// READ_CAP deliberately: lines beyond the read cap never reach the parser
/// at all (the oversized-line skip consumes them unreturned), so a larger
/// value here would be dead letter. Accepted limitation: a tool result
/// bigger than the read cap loses its outcome tail — bounded processing
/// wins, and the agent's narration usually carries the same signal.
const RESULT_PARSE_CAP: usize = READ_CAP as usize;
const OUTCOME_CAP: usize = 200;

/// Candidate events in a chunk of transcript JSONL. Assistant records carry
/// narration, commands and file writes; tool-result records contribute only
/// a capped outcome tail, and only when it reads like a verification signal
/// (results are otherwise unbounded bulk — whole file dumps). Unparseable
/// lines are skipped, not errors: the transcript is another program's append
/// log and owes us nothing.
pub(crate) fn extract_candidates(chunk: &str) -> Vec<Candidate> {
    let mut out = Vec::new();
    for line in chunk.lines() {
        if line.contains("\"type\":\"tool_result\"") && line.len() <= RESULT_PARSE_CAP {
            extract_outcome(&mut out, line);
            continue;
        }
        if !line.contains("\"type\":\"assistant\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
            continue;
        };
        match content {
            Value::String(s) => push_narration(&mut out, s),
            Value::Array(blocks) => {
                for b in blocks {
                    match b.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                                push_narration(&mut out, t);
                            }
                        }
                        Some("tool_use") => {
                            let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("");
                            let input = b.get("input");
                            match name {
                                "Bash" => {
                                    if let Some(cmd) = input
                                        .and_then(|i| i.get("command"))
                                        .and_then(|c| c.as_str())
                                    {
                                        let cmd = cmd.trim();
                                        if !cmd.is_empty() {
                                            out.push(Candidate::Command(cap(cmd, COMMAND_CAP)));
                                        }
                                    }
                                }
                                "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => {
                                    if let Some(p) = input
                                        .and_then(|i| i.get("file_path"))
                                        .and_then(|p| p.as_str())
                                    {
                                        out.push(Candidate::FileWrite(p.to_string()));
                                    }
                                }
                                _ => {}
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Pull the outcome tail out of a user-side tool_result line. The result
/// body may be a plain string or text blocks; either way only the last
/// OUTCOME_CAP chars are kept, and only when they carry an outcome marker.
fn extract_outcome(out: &mut Vec<Candidate>, line: &str) {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let Some(blocks) = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return;
    };
    for b in blocks {
        if b.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
            continue;
        }
        let text = match b.get("content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(inner)) => inner
                .iter()
                .filter(|x| x.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|x| x.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => continue,
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let tail: String = {
            let chars: Vec<char> = text.chars().collect();
            chars[chars.len().saturating_sub(OUTCOME_CAP)..].iter().collect()
        };
        if is_outcome_signal(&tail) {
            out.push(Candidate::Outcome(tail.trim().to_string()));
        }
    }
}

fn push_narration(out: &mut Vec<Candidate>, text: &str) {
    let text = text.trim();
    if !text.is_empty() {
        out.push(Candidate::Narration(cap(text, NARRATION_CAP)));
    }
}

fn cap(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let mut out: String = s.chars().take(n).collect();
    out.push('…');
    out
}

// ---------------------------------------------------------------------------
// Evidence lane (pure decision) — durable links for a future agent to follow.

#[derive(Debug, PartialEq)]
pub(crate) enum EvidenceAction {
    /// A repo doc, linked at its durable (main-checkout) path.
    LinkDoc { path: String },
    /// A scratch artifact, copied into the app's attachments store first —
    /// the board owns the copy, so it outlives worktree/scratchpad cleanup.
    CopyAttach { source: String },
}

/// The main checkout a worktree cwd belongs to, per this repo's layout
/// convention (`<root>/.claude/worktrees/<name>`). Worktree paths die at
/// landing; the main-checkout path is where the doc will actually live.
pub(crate) fn main_checkout_root(cwd: &str) -> Option<String> {
    let (root, rest) = cwd.split_once("/.claude/worktrees/")?;
    (!root.is_empty() && !rest.is_empty()).then(|| root.to_string())
}

/// Scratch roots whose artifacts are worth owning a copy of. An allowlist,
/// like every other trust decision at this boundary: "some file somewhere"
/// is not evidence, a report the session just generated in its scratchpad is.
const SCRATCH_ROOTS: &[&str] = &["/tmp/", "/private/tmp/", "/var/folders/"];

/// Doc dirs whose files get a durable chip. Matches the repo's layout
/// (CLAUDE.md): specs, plans and decision records are the documents a future
/// agent needs to "grab through the real docs and go".
const DOC_DIRS: &[&str] = &["docs/specs/", "docs/plans/", "docs/decisions/"];

/// What, if anything, to do about a file the session wrote. Pure — the
/// filesystem is only consulted at apply time. `root` is the durable
/// (main-checkout) root when `cwd` is a worktree of any layout — resolved by
/// the caller (`durable_root`), so this stays a pure decision.
pub(crate) fn evidence_action(
    path: &str,
    cwd: &str,
    home: &str,
    root: Option<&str>,
) -> Option<EvidenceAction> {
    if !path.starts_with('/') {
        return None;
    }
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;
    // In-repo writes: docs are evidence at their durable path; everything
    // else in the repo is code, not evidence. Checked against both the
    // claim's cwd (usually a worktree) and the main checkout, since sessions
    // legitimately write docs to either.
    for base in [Some(cwd), root].into_iter().flatten() {
        if let Some(rel) = path.strip_prefix(&format!("{base}/")) {
            if ext == "md" && DOC_DIRS.iter().any(|d| rel.starts_with(d)) {
                let durable = root.unwrap_or(cwd);
                return Some(EvidenceAction::LinkDoc {
                    path: format!("{durable}/{rel}"),
                });
            }
            return None;
        }
    }
    // Harness bookkeeping (memory files, hook state) is not evidence.
    if path.starts_with(&format!("{home}/.claude/")) {
        return None;
    }
    if SCRATCH_ROOTS.iter().any(|r| path.starts_with(r))
        && crate::agent::EVIDENCE_EXTENSIONS.contains(&ext.as_str())
    {
        return Some(EvidenceAction::CopyAttach {
            source: path.to_string(),
        });
    }
    None
}

/// FNV-1a — a stable name for a source path's attachment copy, so the same
/// artifact re-written re-uses the same copy (and therefore the same chip).
fn path_hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// The absolute destination for a scratch artifact's board-owned copy.
fn attachment_dest(attachments_root: &Path, task_id: i64, source: &str) -> PathBuf {
    let name = Path::new(source)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("artifact");
    attachments_root
        .join(task_id.to_string())
        .join(format!("sec-{:08x}-{name}", path_hash(source) as u32))
}

/// One evidence application's outcome. `FileMissing` is the retryable case:
/// the transcript records the Write tool call before the file exists on
/// disk, so the first sighting can legitimately be too early.
#[derive(Debug, PartialEq)]
enum EvidenceOutcome {
    Applied,
    Skipped,
    FileMissing,
}

/// Attach one evidence action to a card. Deduped by stored URL — the same
/// doc saved twice is one chip.
fn apply_evidence(
    conn: &Connection,
    attachments_root: &Path,
    task_id: i64,
    action: &EvidenceAction,
) -> EvidenceOutcome {
    let stored = match action {
        EvidenceAction::LinkDoc { path } => path.clone(),
        EvidenceAction::CopyAttach { source } => {
            let src = Path::new(source);
            let Ok(meta) = std::fs::metadata(src) else {
                return EvidenceOutcome::FileMissing; // not on disk (yet)
            };
            if meta.len() > COPY_CAP {
                return EvidenceOutcome::Skipped;
            }
            let dest = attachment_dest(attachments_root, task_id, source);
            if let Some(dir) = dest.parent() {
                if std::fs::create_dir_all(dir).is_err() {
                    return EvidenceOutcome::Skipped;
                }
            }
            if std::fs::copy(src, &dest).is_err() {
                return EvidenceOutcome::Skipped;
            }
            dest.to_string_lossy().into_owned()
        }
    };
    let dup: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM task_links WHERE task_id = ?1 AND url = ?2)",
            rusqlite::params![task_id, stored],
            |r| r.get(0),
        )
        .unwrap_or(true);
    if dup {
        return EvidenceOutcome::Skipped;
    }
    let label = Path::new(&stored)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("evidence")
        .to_string();
    // Attachment copies carry their original name in the label, not the
    // hashed filename the store uses. Capped like every other secretary
    // string that reaches the DB.
    let label = match action {
        EvidenceAction::CopyAttach { source } => Path::new(source)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&label)
            .to_string(),
        EvidenceAction::LinkDoc { .. } => label,
    };
    let label = cap(&label, 120);
    if conn
        .execute(
            "INSERT INTO task_links (task_id, url, label, kind, created_at)
             VALUES (?1, ?2, ?3, 'file', ?4)",
            rusqlite::params![task_id, stored, label, crate::agent::now_iso()],
        )
        .is_err()
    {
        return EvidenceOutcome::Skipped;
    }
    record_activity(conn, task_id, &format!("Evidence attached: {label}"));
    EvidenceOutcome::Applied
}

// ---------------------------------------------------------------------------
// Decide lane — prompt, reply parsing, application.

/// One unticked, tickable checklist item as shown to the model: `n` is the
/// 1-based number the model replies with, `id` the subtask row it maps to.
pub(crate) struct Tickable {
    pub id: i64,
    pub title: String,
}

/// Unticked, non-verify subtasks of a task — the only things the model may
/// tick. `verify:` steps are the user's checklist and are excluded at the
/// source, then re-checked at the write (same belt as the MCP surface).
fn tickables(conn: &Connection, task_id: i64) -> Vec<Tickable> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, title FROM subtasks WHERE task_id = ?1 AND done = 0 ORDER BY position, id",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([task_id], |r| {
        Ok(Tickable {
            id: r.get(0)?,
            title: r.get(1)?,
        })
    });
    match rows {
        Ok(rows) => rows
            .flatten()
            .filter(|t| !crate::agent::is_verify_title(&t.title))
            .collect(),
        Err(_) => Vec::new(),
    }
}

pub(crate) const DECIDE_SYSTEM: &str = "You maintain a task card for a coding agent by reading its \
recent work log. Decide whether any numbered checklist item has clearly just been completed, and \
optionally record one short progress note. Reply ONLY with lines in these exact forms:\n\
tick <number>\n\
log <one short line, present tense>\n\
nothing\n\
Rules: tick a number only when the log clearly shows that exact item is finished — never guess, \
never tick for partial progress. At most 2 ticks and 1 log per reply. When unsure, reply nothing.";

/// The user prompt for one decide-lane call, or None when there is nothing
/// worth asking about (no narration/command candidates).
pub(crate) fn build_prompt(tickables: &[Tickable], candidates: &[Candidate]) -> Option<String> {
    let mut log = String::new();
    for c in candidates {
        match c {
            Candidate::Narration(t) => {
                for line in t.lines().filter(|l| !l.trim().is_empty()) {
                    log.push_str("- ");
                    log.push_str(line.trim());
                    log.push('\n');
                }
            }
            Candidate::Command(cmd) => {
                log.push_str("- ran: ");
                log.push_str(cmd);
                log.push('\n');
            }
            Candidate::Outcome(tail) => {
                log.push_str("- result: ");
                for line in tail.lines().filter(|l| !l.trim().is_empty()) {
                    log.push_str(line.trim());
                    log.push(' ');
                }
                log.push('\n');
            }
            Candidate::FileWrite(_) => {}
        }
    }
    if log.trim().is_empty() {
        return None;
    }
    let mut out = String::from("Checklist (unfinished items):\n");
    if tickables.is_empty() {
        out.push_str("(none)\n");
    }
    for (i, t) in tickables.iter().enumerate() {
        out.push_str(&format!("{}. {}\n", i + 1, t.title));
    }
    out.push_str("\nAgent work log (newest last):\n");
    out.push_str(&log);
    out.push_str("\nReply:");
    Some(out)
}

#[derive(Debug, PartialEq)]
pub(crate) enum Action {
    Tick(i64),
    Log(String),
}

/// Engine reply → actions. Strict by design: anything that does not match
/// the two allowed line shapes degrades to nothing — a malformed reply from
/// a small model must never become a write. Caps mirror the prompt's rules
/// so even a rule-breaking reply is bounded.
pub(crate) fn parse_reply(reply: &str, tickables: &[Tickable]) -> Vec<Action> {
    let mut ticks = 0usize;
    let mut logs = 0usize;
    let mut out = Vec::new();
    for line in reply.lines() {
        let line = line.trim().trim_start_matches(['-', '*']).trim();
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("tick") {
            let rest = rest.trim().trim_start_matches('#');
            if let Ok(n) = rest.trim_end_matches('.').trim().parse::<usize>() {
                if n >= 1 && n <= tickables.len() && ticks < 2 {
                    let id = tickables[n - 1].id;
                    if !out.contains(&Action::Tick(id)) {
                        out.push(Action::Tick(id));
                        ticks += 1;
                    }
                }
            }
        } else if lower.starts_with("log ") {
            // Take the text from the original line, not the lowercased copy.
            let text = line[4..].trim();
            if !text.is_empty() && logs < 1 {
                out.push(Action::Log(cap(text, LOG_CAP)));
                logs += 1;
            }
        }
    }
    out
}

/// Every secretary-authored activity label is capped, universally — criterion
/// 5's "derived, length-capped lines" must hold for evidence labels and
/// subtask-title echoes too, not only model log lines (round-2 codex finding).
const LABEL_CAP: usize = 300;

/// Record one activity row as the secretary. Mirrors the MCP surface's
/// attribution stamp (`actor_kind='agent'`), with the secretary's own name.
fn record_activity(conn: &Connection, task_id: i64, label: &str) {
    let _ = conn.execute(
        "INSERT INTO task_activity (task_id, label, created_at, actor_kind, actor_name)
         VALUES (?1, ?2, ?3, 'agent', ?4)",
        rusqlite::params![task_id, cap(label, LABEL_CAP), crate::agent::now_iso(), ACTOR],
    );
}

/// Run one write batch atomically against every other connection (the MCP
/// server writes on its own connection): BEGIN IMMEDIATE takes the write
/// lock, the claim/enabled guards run INSIDE it, and the writes commit or
/// nothing does. Closes the round-2 "check-then-write is not a barrier"
/// window — a claim released between guard and write now rolls back.
fn guarded_write<T>(
    conn: &Connection,
    session_id: &str,
    task_id: i64,
    write: impl FnOnce(&Connection) -> T,
) -> Option<T> {
    if conn.execute_batch("BEGIN IMMEDIATE").is_err() {
        return None;
    }
    let out = if still_enabled() && claim_intact(conn, session_id, task_id) {
        Some(write(conn))
    } else {
        None
    };
    let _ = conn.execute_batch(if out.is_some() { "COMMIT" } else { "ROLLBACK" });
    out
}

/// Apply parsed actions to a card. Returns whether the DB changed.
///
/// Guards, in order: a tick must name a subtask of THIS task, still open,
/// and not a `verify:` step (re-checked here even though tickables already
/// excluded them — the id travelled through a model reply); a log line is
/// dropped when it repeats the newest agent line on the card.
fn apply_actions(conn: &Connection, task_id: i64, actions: &[Action]) -> bool {
    let mut changed = false;
    for a in actions {
        match a {
            Action::Tick(id) => {
                let row: Option<(String, bool)> = conn
                    .query_row(
                        "SELECT title, done FROM subtasks WHERE id = ?1 AND task_id = ?2",
                        rusqlite::params![id, task_id],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0)),
                    )
                    .ok();
                let Some((title, done)) = row else { continue };
                if done || crate::agent::is_verify_title(&title) {
                    continue;
                }
                if conn
                    .execute("UPDATE subtasks SET done = 1 WHERE id = ?1", [id])
                    .is_err()
                {
                    continue;
                }
                record_activity(conn, task_id, &format!("Subtask completed: {title}"));
                changed = true;
            }
            Action::Log(text) => {
                let last: Option<String> = conn
                    .query_row(
                        "SELECT label FROM task_activity WHERE task_id = ?1 AND actor_kind = 'agent'
                         ORDER BY id DESC LIMIT 1",
                        [task_id],
                        |r| r.get(0),
                    )
                    .ok();
                if last.as_deref() == Some(text.as_str()) {
                    continue;
                }
                record_activity(conn, task_id, text);
                changed = true;
            }
        }
    }
    changed
}

// ---------------------------------------------------------------------------
// Cursors.

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Offsets {
    pub scan: u64,
    pub decide: u64,
}

fn load_offsets(conn: &Connection, session_id: &str) -> Option<Offsets> {
    conn.query_row(
        "SELECT scan_offset, decide_offset FROM secretary_offsets WHERE session_id = ?1",
        [session_id],
        |r| {
            Ok(Offsets {
                scan: r.get::<_, i64>(0)? as u64,
                decide: r.get::<_, i64>(1)? as u64,
            })
        },
    )
    .ok()
}

fn save_offsets(conn: &Connection, session_id: &str, off: Offsets) {
    let _ = conn.execute(
        "INSERT INTO secretary_offsets (session_id, scan_offset, decide_offset, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(session_id) DO UPDATE SET
           scan_offset = excluded.scan_offset,
           decide_offset = excluded.decide_offset,
           updated_at = excluded.updated_at",
        rusqlite::params![session_id, off.scan as i64, off.decide as i64, crate::agent::now_iso()],
    );
}

/// Where the cursors stand against the file right now. First sight starts at
/// the END of the file — a claim usually arrives mid-session and replaying a
/// long transcript's history onto a card that was maintained by hand would
/// be noise, not signal. (Engine-off catch-up is different: the cursors
/// exist, they are just behind.) A shrunken file (rotation, deletion) resets
/// both cursors — the old positions name bytes that no longer exist.
pub(crate) fn reconcile_offsets(stored: Option<Offsets>, file_len: u64) -> Offsets {
    match stored {
        None => Offsets {
            scan: file_len,
            decide: file_len,
        },
        Some(mut off) => {
            if off.scan > file_len || off.decide > file_len {
                off = Offsets {
                    scan: file_len,
                    decide: file_len,
                };
            }
            off
        }
    }
}

/// How far past the cap a single oversized line is scanned for its newline
/// before giving up and consuming mid-line (progress beats completeness — a
/// consumed fragment parses as garbage and is skipped, never misread).
const OVERSIZE_SCAN_CAP: u64 = 8 * 1024 * 1024;

/// A complete-lines chunk of the transcript from `from`, capped. Returns the
/// chunk and how many bytes it consumed (up to and including the last
/// newline) — a partial trailing line stays unconsumed for the next cycle.
///
/// A single line longer than the cap must not wedge the cursor forever
/// (tool-result lines are unbounded): when a cap-full read holds no newline,
/// the line's end is searched for beyond the cap and the whole line is
/// consumed *without being returned* — it was never going to be parsed at
/// that size. Only a line that genuinely has no newline yet (still being
/// written, EOF reached) consumes nothing and waits.
fn read_chunk(path: &Path, from: u64, cap: u64) -> Option<(String, u64)> {
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = vec![0u8; cap as usize];
    let mut read = 0usize;
    while read < buf.len() {
        match f.read(&mut buf[read..]) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(_) => return None,
        }
    }
    buf.truncate(read);
    let consumed = match buf.iter().rposition(|&b| b == b'\n') {
        Some(i) => i + 1,
        None => {
            if (read as u64) < cap {
                // Short read: the trailing line simply isn't finished yet.
                return Some((String::new(), 0));
            }
            // The cap-full prefix is the head of one oversized line; its
            // remainder is scanned for the terminating newline just ahead.
            return match scan_for_newline(&mut f)? {
                ScanOutcome::Found(k) | ScanOutcome::GaveUp(k) => {
                    Some((String::new(), read as u64 + k))
                }
                ScanOutcome::Eof => Some((String::new(), 0)),
            };
        }
    };
    let chunk = String::from_utf8_lossy(&buf[..consumed]).into_owned();
    Some((chunk, consumed as u64))
}

enum ScanOutcome {
    /// Newline found `k` bytes ahead (inclusive) — consume the whole line.
    Found(u64),
    /// Even OVERSIZE_SCAN_CAP wasn't enough: consume the scanned span
    /// mid-line. Progress is guaranteed; the orphaned tail parses as garbage
    /// on a later cycle and is skipped, never misread.
    GaveUp(u64),
    /// EOF before any newline — the line is still being written; wait.
    Eof,
}

/// Continue reading from the file's current position, looking for the
/// newline that ends an oversized line.
fn scan_for_newline(f: &mut std::fs::File) -> Option<ScanOutcome> {
    let mut scanned = 0u64;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            return Some(ScanOutcome::Eof);
        }
        if let Some(i) = buf[..n].iter().position(|&b| b == b'\n') {
            return Some(ScanOutcome::Found(scanned + i as u64 + 1));
        }
        scanned += n as u64;
        if scanned >= OVERSIZE_SCAN_CAP {
            return Some(ScanOutcome::GaveUp(scanned));
        }
    }
}

// ---------------------------------------------------------------------------
// The loop.

struct WatchedSession {
    session_id: String,
    task_id: i64,
    cwd: String,
}

/// Claimed sessions of live tasks — the same join the artifacts watcher uses.
fn watched_sessions(conn: &Connection) -> Vec<WatchedSession> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT c.session_id, c.task_id, c.cwd FROM agent_claims c
           JOIN tasks t ON t.id = c.task_id
          WHERE t.status != 'done' AND t.deleted_at IS NULL AND c.cwd IS NOT NULL",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok(WatchedSession {
            session_id: r.get(0)?,
            task_id: r.get(1)?,
            cwd: r.get(2)?,
        })
    });
    match rows {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

/// Is this session STILL claiming this task, on a task still on the board?
///
/// Re-checked immediately before every write, because the loop's snapshot
/// goes stale across the blocking engine call: the claim can be released,
/// retargeted, or the card completed while the model thinks. A write on a
/// snapshot alone would land on a card the session no longer owns — the
/// exact thing the secretary must never do.
fn claim_intact(conn: &Connection, session_id: &str, task_id: i64) -> bool {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM agent_claims c JOIN tasks t ON t.id = c.task_id
             WHERE c.session_id = ?1 AND c.task_id = ?2
               AND t.deleted_at IS NULL AND t.status != 'done')",
        rusqlite::params![session_id, task_id],
        |r| r.get(0),
    )
    .unwrap_or(false)
}

/// The write barrier the toggle needs: enabled is re-read at write time, not
/// trusted from the cycle's snapshot — turning the secretary off mid-flight
/// must stop even a write whose engine call was already in the air
/// (acceptance criterion 4).
fn still_enabled() -> bool {
    config_cell().lock().unwrap().enabled
}

/// A transcript this stale is history, not presence: the session may still
/// hold its claim, but "watching" would overclaim. Processing is unaffected —
/// a file that isn't growing produces no work either way.
const WATCH_FRESH: Duration = Duration::from_secs(15 * 60);

/// Where a repo doc's durable path is rooted for this cwd. The pure
/// convention (`<root>/.claude/worktrees/<name>`) answers instantly; any
/// other worktree layout is resolved by asking git for the common dir (a
/// linked worktree's refs live under the MAIN checkout's `.git`), cached per
/// cwd because it shells out.
fn durable_root(cwd: &str, cache: &mut std::collections::HashMap<String, Option<String>>) -> Option<String> {
    if let Some(hit) = cache.get(cwd) {
        return hit.clone();
    }
    // Git is the authority (any worktree layout, and no false positive on a
    // repo that merely *lives* at a .claude/worktrees-shaped path); the pure
    // convention is only the fallback when git can't answer. Cached per cwd
    // because the authority shells out.
    let from_git = crate::artifacts::git_common_dir(cwd).and_then(|common| {
        let root = common.parent()?.to_string_lossy().into_owned();
        // The main checkout resolves to itself — that is "no normalization
        // needed", not a mapping.
        (common.file_name().map(|n| n == ".git").unwrap_or(false) && root != cwd)
            .then_some(root)
    });
    let resolved = from_git.or_else(|| {
        // Fallback only when the cwd is not a resolvable git checkout at
        // all; a plain checkout that DID resolve (to itself) must not be
        // second-guessed by the textual convention.
        crate::artifacts::git_common_dir(cwd)
            .is_none()
            .then(|| main_checkout_root(cwd))
            .flatten()
    });
    cache.insert(cwd.to_string(), resolved.clone());
    resolved
}

/// Evidence whose file wasn't on disk yet — the natural transcript order
/// records the Write tool call before the file exists. Retried for a few
/// cycles instead of being dropped the one time it was seen.
struct PendingEvidence {
    task_id: i64,
    action: EvidenceAction,
    session_id: String,
    attempts: u8,
}

const EVIDENCE_RETRIES: u8 = 5;

/// Rows for sessions no longer claimed — dead bookkeeping, swept in passing.
fn sweep_dead_offsets(conn: &Connection) {
    let _ = conn.execute(
        "DELETE FROM secretary_offsets
          WHERE session_id NOT IN (SELECT session_id FROM agent_claims)",
        [],
    );
}

/// Is anything answering the engine lane's base_url? `/v1/models` because
/// every supported server shape (built-in llama.cpp, LM Studio, Ollama's
/// OpenAI facade) serves it, where `/health` is llama.cpp-only.
async fn probe_engine(base_url: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_millis(900))
        .build()
    else {
        return false;
    };
    client
        .get(format!("{base_url}/v1/models"))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

pub fn init(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || run_loop(&app));
}

fn run_loop(app: &AppHandle) {
    let Ok(home) = std::env::var("HOME") else { return };
    let attachments_root = tauri::Manager::path(app)
        .app_data_dir()
        .ok()
        .map(|d| d.join("attachments"));
    let mut conn: Option<Connection> = None;
    let mut was_enabled = false;
    let mut probe: Option<(Instant, bool)> = None;
    let mut swept = Instant::now();
    let mut root_cache: std::collections::HashMap<String, Option<String>> = Default::default();
    let mut pending: Vec<PendingEvidence> = Vec::new();
    loop {
        let cfg = config_cell().lock().unwrap().clone();
        if !cfg.enabled {
            was_enabled = false;
            // Pending evidence must not survive a disable: re-enable starts
            // from the current end of every file, and a retry queue that
            // outlived the gap would backfill exactly the work the user
            // switched off (round-2 codex finding).
            pending.clear();
            *status_cell().lock().unwrap() = SecretaryStatus::default();
            std::thread::sleep(IDLE_TICK);
            continue;
        }
        if conn.is_none() {
            conn = crate::agent::open_db(app).ok().inspect(|c| {
                // Belt over the migration: on a first launch this thread can
                // reach the DB before the frontend has run migration 022.
                let _ = c.execute_batch(include_str!("../migrations/022_secretary.sql"));
            });
        }
        let Some(c) = conn.as_ref() else {
            std::thread::sleep(IDLE_TICK);
            continue;
        };
        let sessions = watched_sessions(c);
        // Re-enable starts from the current end of every file: work done
        // while deliberately off is not backfilled (user decision, spec).
        let just_enabled = !was_enabled;
        was_enabled = true;

        let engine_ready = match probe {
            Some((at, ok)) if at.elapsed() < ENGINE_PROBE_TTL => ok,
            _ => {
                let ok = !cfg.base_url.is_empty()
                    && tauri::async_runtime::block_on(probe_engine(&cfg.base_url));
                probe = Some((Instant::now(), ok));
                ok
            }
        };

        let mut watching = Vec::new();
        let mut behind = Vec::new();
        let mut ui_changed = false;
        for s in &sessions {
            let path = PathBuf::from(format!(
                "{home}/.claude/projects/{}/{}.jsonl",
                crate::artifacts::transcript_slug(&s.cwd),
                s.session_id
            ));
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            let len = meta.len();
            // "Watching" is presence, and presence must not overclaim: a
            // claimed-but-dead session's transcript stops moving, and after
            // WATCH_FRESH it is history. Processing is unaffected — a file
            // that isn't growing produces no work either way.
            let fresh = meta
                .modified()
                .ok()
                .and_then(|m| m.elapsed().ok())
                .map(|age| age < WATCH_FRESH)
                .unwrap_or(false);
            if fresh && !watching.contains(&s.task_id) {
                watching.push(s.task_id);
            }
            let mut off = if just_enabled {
                Offsets { scan: len, decide: len }
            } else {
                reconcile_offsets(load_offsets(c, &s.session_id), len)
            };

            // Scan lane: pre-filter + the deterministic evidence lane.
            if len > off.scan {
                if let Some((chunk, consumed)) = read_chunk(&path, off.scan, READ_CAP) {
                    if consumed > 0 {
                        let repo_root = durable_root(&s.cwd, &mut root_cache);
                        for cand in extract_candidates(&chunk) {
                            if let Candidate::FileWrite(p) = &cand {
                                let action =
                                    evidence_action(p, &s.cwd, &home, repo_root.as_deref());
                                let Some(action) = action else { continue };
                                let Some(store) = attachments_root.as_deref() else { continue };
                                // The write barrier: enabled + claim checked
                                // INSIDE the write transaction, atomically.
                                match guarded_write(c, &s.session_id, s.task_id, |c| {
                                    apply_evidence(c, store, s.task_id, &action)
                                }) {
                                    Some(EvidenceOutcome::Applied) => ui_changed = true,
                                    Some(EvidenceOutcome::Skipped) | None => {}
                                    // The transcript records the Write call
                                    // before the file exists — retry.
                                    Some(EvidenceOutcome::FileMissing) => {
                                        pending.push(PendingEvidence {
                                            task_id: s.task_id,
                                            action,
                                            session_id: s.session_id.clone(),
                                            attempts: 0,
                                        })
                                    }
                                }
                            }
                        }
                        off.scan += consumed;
                    }
                }
            }

            // Decide lane: frozen without an engine; drains when it returns.
            if off.decide < off.scan {
                if engine_ready {
                    if let Some((chunk, consumed)) = read_chunk(&path, off.decide, READ_CAP) {
                        // The chunk must not outrun the scan cursor — evidence
                        // for those bytes hasn't been handled yet.
                        let usable = consumed.min(off.scan - off.decide);
                        if let DecideStep::SkipAhead(n) = decide_step(&chunk, usable) {
                            // Two shapes of the same wedge (round-2 codex
                            // finding): the oversized-line skip returned an
                            // empty chunk, or a mid-line boundary left no
                            // newline inside `usable`. Either way the scan
                            // cursor already crossed these bytes — advance;
                            // an orphaned fragment parses as garbage later
                            // and is skipped, never misread.
                            off.decide += n;
                        } else if usable > 0 {
                            let end = byte_floor_at_newline(&chunk, usable as usize);
                            let cands: Vec<Candidate> = extract_candidates(&chunk[..end])
                                .into_iter()
                                .filter(|cand| !matches!(cand, Candidate::FileWrite(_)))
                                .collect();
                            let ticks = tickables(c, s.task_id);
                            match build_prompt(&ticks, &cands) {
                                None => off.decide += end as u64,
                                Some(prompt) => {
                                    let reply = tauri::async_runtime::block_on(crate::ai::ai_chat(
                                        cfg.base_url.clone(),
                                        cfg.model.clone(),
                                        DECIDE_SYSTEM.to_string(),
                                        prompt,
                                        cfg.disable_thinking,
                                    ));
                                    match reply {
                                        Ok(reply) => {
                                            let actions = parse_reply(&reply, &ticks);
                                            // The engine call blocked for up to
                                            // minutes; the world may have moved.
                                            // Enabled and the claim are checked
                                            // inside the write transaction, never
                                            // trusted from the cycle's snapshot.
                                            // The cursor still advances — dropped
                                            // work is irrelevant work, and
                                            // re-enable restarts at the end
                                            // anyway.
                                            if guarded_write(c, &s.session_id, s.task_id, |c| {
                                                apply_actions(c, s.task_id, &actions)
                                            })
                                            .unwrap_or(false)
                                            {
                                                ui_changed = true;
                                            }
                                            off.decide += end as u64;
                                        }
                                        Err(_) => {
                                            // Engine dropped mid-cycle: freeze the
                                            // cursor and re-probe next cycle.
                                            probe = Some((Instant::now(), false));
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else if fresh && !behind.contains(&s.task_id) {
                    // Same freshness gate as `watching`: a claimed-but-dead
                    // session's backlog still drains when the engine returns,
                    // but its card must not render a live-looking badge.
                    behind.push(s.task_id);
                }
            }
            save_offsets(c, &s.session_id, off);
        }
        // Evidence whose file wasn't on disk yet: retry a few cycles, then
        // let it go — scratch artifacts are ephemeral by nature.
        if let Some(store) = attachments_root.as_deref() {
            pending.retain_mut(|p| {
                match guarded_write(c, &p.session_id, p.task_id, |c| {
                    apply_evidence(c, store, p.task_id, &p.action)
                }) {
                    Some(EvidenceOutcome::Applied) => {
                        ui_changed = true;
                        false
                    }
                    // Guard failed (claim gone / disabled) or refused: the
                    // retry is pointless either way.
                    Some(EvidenceOutcome::Skipped) | None => false,
                    Some(EvidenceOutcome::FileMissing) => {
                        p.attempts += 1;
                        p.attempts <= EVIDENCE_RETRIES
                    }
                }
            });
        }
        if ui_changed {
            let _ = app.emit("agent-db-changed", ());
        }
        if swept.elapsed() > Duration::from_secs(300) {
            sweep_dead_offsets(c);
            swept = Instant::now();
        }
        *status_cell().lock().unwrap() = SecretaryStatus {
            enabled: true,
            engine_ready,
            watching,
            behind,
        };
        std::thread::sleep(if sessions.is_empty() { IDLE_TICK } else { TICK });
    }
}

/// How the decide cursor treats one read against the scan boundary.
#[derive(Debug, PartialEq)]
enum DecideStep {
    /// Bytes to cross WITHOUT parsing: the oversized-line skip returned an
    /// empty chunk, or a mid-line boundary left no newline inside the usable
    /// span. Not advancing here is the round-2 wedge.
    SkipAhead(u64),
    /// Parse the chunk normally (or there is nothing usable yet).
    Parse,
}

fn decide_step(chunk: &str, usable: u64) -> DecideStep {
    if usable > 0 && (chunk.is_empty() || byte_floor_at_newline(chunk, usable as usize) == 0) {
        DecideStep::SkipAhead(usable)
    } else {
        DecideStep::Parse
    }
}

/// Largest prefix of `chunk` ending on a newline within `limit` bytes.
fn byte_floor_at_newline(chunk: &str, limit: usize) -> usize {
    let limit = limit.min(chunk.len());
    match chunk.as_bytes()[..limit].iter().rposition(|&b| b == b'\n') {
        Some(i) => i + 1,
        None => 0,
    }
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for sql in [
            include_str!("../migrations/001_init.sql"),
            include_str!("../migrations/002_trash.sql"),
            include_str!("../migrations/003_subtasks_activity.sql"),
            include_str!("../migrations/004_iso_timestamps.sql"),
            include_str!("../migrations/005_changes.sql"),
            include_str!("../migrations/006_repair_positions.sql"),
            include_str!("../migrations/007_archived_at.sql"),
            include_str!("../migrations/008_task_links.sql"),
            include_str!("../migrations/009_activity_actor.sql"),
            include_str!("../migrations/013_agent_claims.sql"),
            include_str!("../migrations/022_secretary.sql"),
        ] {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn seed_task(conn: &Connection) -> i64 {
        conn.execute(
            "INSERT INTO tasks (title, status, position, created_at) VALUES ('t', 'doing', 0, '2026-01-01')",
            [],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn seed_subtask(conn: &Connection, task_id: i64, title: &str) -> i64 {
        conn.execute(
            "INSERT INTO subtasks (task_id, title, position) VALUES (?1, ?2, 0)",
            rusqlite::params![task_id, title],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn assistant_line(blocks: &str) -> String {
        format!(r#"{{"type":"assistant","message":{{"content":[{blocks}]}}}}"#)
    }

    // --- pre-filter ---

    #[test]
    fn extracts_narration_commands_and_file_writes() {
        let chunk = [
            assistant_line(r#"{"type":"text","text":"tests are green now"}"#),
            assistant_line(
                r#"{"type":"tool_use","name":"Bash","input":{"command":"cargo test"}}"#,
            ),
            assistant_line(
                r#"{"type":"tool_use","name":"Write","input":{"file_path":"/w/docs/specs/x.md","content":"..."}}"#,
            ),
            // tool results and user lines never become candidates
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"huge"}]}}"#
                .to_string(),
            // garbage lines are skipped, not fatal
            "not json at all".to_string(),
        ]
        .join("\n");
        let got = extract_candidates(&chunk);
        assert_eq!(
            got,
            vec![
                Candidate::Narration("tests are green now".into()),
                Candidate::Command("cargo test".into()),
                Candidate::FileWrite("/w/docs/specs/x.md".into()),
            ]
        );
    }

    #[test]
    fn narration_is_capped() {
        let long = "x".repeat(NARRATION_CAP + 50);
        let chunk = assistant_line(&format!(r#"{{"type":"text","text":"{long}"}}"#));
        let got = extract_candidates(&chunk);
        match &got[0] {
            Candidate::Narration(t) => {
                assert!(t.chars().count() <= NARRATION_CAP + 1); // + ellipsis
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    // --- evidence lane (pure) ---

    #[test]
    fn worktree_doc_links_at_main_checkout_path() {
        let cwd = "/Users/u/projects/app/.claude/worktrees/feature";
        let got = evidence_action(
            "/Users/u/projects/app/.claude/worktrees/feature/docs/specs/2026-01-01-x.md",
            cwd,
            "/Users/u",
            main_checkout_root(cwd).as_deref(),
        );
        assert_eq!(
            got,
            Some(EvidenceAction::LinkDoc {
                path: "/Users/u/projects/app/docs/specs/2026-01-01-x.md".into()
            })
        );
    }

    #[test]
    fn main_checkout_doc_links_as_is_and_code_files_are_ignored() {
        let cwd = "/Users/u/projects/app";
        assert_eq!(
            evidence_action("/Users/u/projects/app/docs/plans/p.md", cwd, "/Users/u", None),
            Some(EvidenceAction::LinkDoc {
                path: "/Users/u/projects/app/docs/plans/p.md".into()
            })
        );
        // In-repo, not docs → code, never evidence.
        assert_eq!(
            evidence_action("/Users/u/projects/app/src/main.rs", cwd, "/Users/u", None),
            None
        );
        // In-repo markdown outside the doc dirs is still not evidence.
        assert_eq!(
            evidence_action("/Users/u/projects/app/README.md", cwd, "/Users/u", None),
            None
        );
    }

    #[test]
    fn docs_written_in_main_checkout_from_a_worktree_session_link_durably() {
        let cwd = "/Users/u/projects/app/.claude/worktrees/feature";
        assert_eq!(
            evidence_action("/Users/u/projects/app/docs/decisions/d.md", cwd, "/Users/u", main_checkout_root(cwd).as_deref()),
            Some(EvidenceAction::LinkDoc {
                path: "/Users/u/projects/app/docs/decisions/d.md".into()
            })
        );
    }

    #[test]
    fn scratch_artifacts_copy_and_the_rest_is_refused() {
        let cwd = "/Users/u/projects/app";
        assert_eq!(
            evidence_action("/private/tmp/scratch/report.html", cwd, "/Users/u", None),
            Some(EvidenceAction::CopyAttach {
                source: "/private/tmp/scratch/report.html".into()
            })
        );
        // Harness bookkeeping is not evidence.
        assert_eq!(
            evidence_action("/Users/u/.claude/projects/x/memory/note.md", cwd, "/Users/u", None),
            None
        );
        // Executables/scripts have no evidence extension.
        assert_eq!(evidence_action("/private/tmp/run.sh", cwd, "/Users/u", None), None);
        // Files elsewhere on disk are not scratch output.
        assert_eq!(
            evidence_action("/Users/u/Documents/other.md", cwd, "/Users/u", None),
            None
        );
        // Relative paths are refused outright.
        assert_eq!(evidence_action("docs/specs/x.md", cwd, "/Users/u", None), None);
    }

    #[test]
    fn evidence_links_dedupe_by_path() {
        let conn = migrated_conn();
        let task = seed_task(&conn);
        let tmp = std::env::temp_dir().join("sec-test-attach");
        let action = EvidenceAction::LinkDoc {
            path: "/Users/u/projects/app/docs/specs/x.md".into(),
        };
        assert_eq!(apply_evidence(&conn, &tmp, task, &action), EvidenceOutcome::Applied);
        assert_eq!(apply_evidence(&conn, &tmp, task, &action), EvidenceOutcome::Skipped, "second attach must dedupe");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_links WHERE task_id = ?1", [task], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        let kind: String = conn
            .query_row("SELECT kind FROM task_links WHERE task_id = ?1", [task], |r| r.get(0))
            .unwrap();
        assert_eq!(kind, "file");
    }

    #[test]
    fn scratch_copy_lands_in_attachments_and_links_the_copy() {
        let conn = migrated_conn();
        let task = seed_task(&conn);
        let scratch = std::env::temp_dir().join("sec-test-src");
        std::fs::create_dir_all(&scratch).unwrap();
        let src = scratch.join("report.html");
        std::fs::write(&src, "<h1>hi</h1>").unwrap();
        let store = std::env::temp_dir().join("sec-test-store");
        let action = EvidenceAction::CopyAttach {
            source: src.to_string_lossy().into_owned(),
        };
        assert_eq!(apply_evidence(&conn, &store, task, &action), EvidenceOutcome::Applied);
        let url: String = conn
            .query_row("SELECT url FROM task_links WHERE task_id = ?1", [task], |r| r.get(0))
            .unwrap();
        assert!(url.starts_with(store.to_string_lossy().as_ref()), "links the copy: {url}");
        assert_eq!(std::fs::read_to_string(&url).unwrap(), "<h1>hi</h1>");
        // The source dying does not kill the evidence.
        std::fs::remove_file(&src).unwrap();
        assert!(Path::new(&url).exists());
        // Label carries the original name, not the hashed store name.
        let label: String = conn
            .query_row("SELECT label FROM task_links WHERE task_id = ?1", [task], |r| r.get(0))
            .unwrap();
        assert_eq!(label, "report.html");
    }

    // --- decide lane: parsing ---

    fn ticks(titles: &[(&str, i64)]) -> Vec<Tickable> {
        titles
            .iter()
            .map(|(t, id)| Tickable {
                id: *id,
                title: (*t).to_string(),
            })
            .collect()
    }

    #[test]
    fn parses_ticks_and_logs_strictly() {
        let t = ticks(&[("write tests", 11), ("implement", 12), ("docs", 13)]);
        let got = parse_reply("tick 2\nlog tests written (5 failing as expected)\n", &t);
        assert_eq!(
            got,
            vec![
                Action::Tick(12),
                Action::Log("tests written (5 failing as expected)".into())
            ]
        );
    }

    #[test]
    fn malformed_replies_degrade_to_nothing() {
        let t = ticks(&[("a", 1)]);
        assert!(parse_reply("nothing", &t).is_empty());
        assert!(parse_reply("I think item 1 might be done?", &t).is_empty());
        assert!(parse_reply("tick zero\ntick 99\ntick -1\ntick", &t).is_empty());
        assert!(parse_reply("", &t).is_empty());
    }

    #[test]
    fn reply_caps_hold_even_when_the_model_breaks_the_rules() {
        let t = ticks(&[("a", 1), ("b", 2), ("c", 3), ("d", 4)]);
        let got = parse_reply("tick 1\ntick 2\ntick 3\ntick 4\nlog x\nlog y\nlog z", &t);
        let tick_count = got.iter().filter(|a| matches!(a, Action::Tick(_))).count();
        let log_count = got.iter().filter(|a| matches!(a, Action::Log(_))).count();
        assert_eq!(tick_count, 2);
        assert_eq!(log_count, 1);
    }

    #[test]
    fn bulleted_and_numbered_variants_still_parse() {
        let t = ticks(&[("a", 7)]);
        assert_eq!(parse_reply("- tick 1", &t), vec![Action::Tick(7)]);
        assert_eq!(parse_reply("Tick #1.", &t), vec![Action::Tick(7)]);
    }

    // --- decide lane: application ---

    #[test]
    fn tick_applies_and_is_attributed_to_the_secretary() {
        let conn = migrated_conn();
        let task = seed_task(&conn);
        let sub = seed_subtask(&conn, task, "write tests");
        assert!(apply_actions(&conn, task, &[Action::Tick(sub)]));
        let done: i64 = conn
            .query_row("SELECT done FROM subtasks WHERE id = ?1", [sub], |r| r.get(0))
            .unwrap();
        assert_eq!(done, 1);
        let (kind, name): (String, String) = conn
            .query_row(
                "SELECT actor_kind, actor_name FROM task_activity WHERE task_id = ?1
                 ORDER BY id DESC LIMIT 1",
                [task],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((kind.as_str(), name.as_str()), ("agent", ACTOR));
    }

    #[test]
    fn verify_steps_are_never_ticked_even_by_id() {
        let conn = migrated_conn();
        let task = seed_task(&conn);
        let sub = seed_subtask(&conn, task, "verify: click the thing in the app");
        // Excluded from the tickable list…
        assert!(tickables(&conn, task).is_empty());
        // …and refused at the write even if an id sneaks through.
        assert!(!apply_actions(&conn, task, &[Action::Tick(sub)]));
        let done: i64 = conn
            .query_row("SELECT done FROM subtasks WHERE id = ?1", [sub], |r| r.get(0))
            .unwrap();
        assert_eq!(done, 0);
    }

    #[test]
    fn tick_refuses_foreign_and_already_done_subtasks() {
        let conn = migrated_conn();
        let task = seed_task(&conn);
        let other = seed_task(&conn);
        let foreign = seed_subtask(&conn, other, "not yours");
        assert!(!apply_actions(&conn, task, &[Action::Tick(foreign)]));
        let sub = seed_subtask(&conn, task, "mine");
        conn.execute("UPDATE subtasks SET done = 1 WHERE id = ?1", [sub]).unwrap();
        assert!(!apply_actions(&conn, task, &[Action::Tick(sub)]), "already done → no change");
    }

    #[test]
    fn repeated_log_lines_dedupe() {
        let conn = migrated_conn();
        let task = seed_task(&conn);
        assert!(apply_actions(&conn, task, &[Action::Log("tests green".into())]));
        assert!(!apply_actions(&conn, task, &[Action::Log("tests green".into())]));
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_activity WHERE task_id = ?1", [task], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 1);
    }

    // --- prompt ---

    #[test]
    fn prompt_numbers_tickables_and_skips_when_log_is_empty() {
        let t = ticks(&[("write tests", 1), ("implement", 2)]);
        let cands = vec![
            Candidate::Narration("tests pass".into()),
            Candidate::Command("cargo test".into()),
            Candidate::FileWrite("/x/y.md".into()),
        ];
        let p = build_prompt(&t, &cands).unwrap();
        assert!(p.contains("1. write tests"));
        assert!(p.contains("2. implement"));
        assert!(p.contains("- tests pass"));
        assert!(p.contains("- ran: cargo test"));
        assert!(!p.contains("/x/y.md"), "file writes are the evidence lane's, not the model's");
        // Only file writes → nothing to decide.
        assert!(build_prompt(&t, &[Candidate::FileWrite("/x/y.md".into())]).is_none());
        assert!(build_prompt(&t, &[]).is_none());
    }

    // --- cursors ---

    #[test]
    fn first_sight_starts_at_end_and_truncation_resets() {
        assert_eq!(
            reconcile_offsets(None, 500),
            Offsets { scan: 500, decide: 500 }
        );
        let stored = Offsets { scan: 300, decide: 100 };
        assert_eq!(reconcile_offsets(Some(stored), 500), stored);
        // File shrank under the cursors → both reset to the new end.
        assert_eq!(
            reconcile_offsets(Some(stored), 50),
            Offsets { scan: 50, decide: 50 }
        );
    }

    #[test]
    fn offsets_roundtrip_and_dead_rows_sweep() {
        let conn = migrated_conn();
        save_offsets(&conn, "s-1", Offsets { scan: 10, decide: 4 });
        assert_eq!(load_offsets(&conn, "s-1"), Some(Offsets { scan: 10, decide: 4 }));
        save_offsets(&conn, "s-1", Offsets { scan: 20, decide: 20 });
        assert_eq!(load_offsets(&conn, "s-1"), Some(Offsets { scan: 20, decide: 20 }));
        // No claim names s-1 → the sweep removes its row.
        sweep_dead_offsets(&conn);
        assert_eq!(load_offsets(&conn, "s-1"), None);
    }

    #[test]
    fn chunks_stop_at_line_boundaries() {
        let dir = std::env::temp_dir().join("sec-test-chunks");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.jsonl");
        std::fs::write(&p, "aaa\nbbb\nccc").unwrap(); // trailing line incomplete
        let (chunk, consumed) = read_chunk(&p, 0, 1024).unwrap();
        assert_eq!(chunk, "aaa\nbbb\n");
        assert_eq!(consumed, 8);
        // Nothing complete yet past the last newline.
        let (chunk, consumed) = read_chunk(&p, 8, 1024).unwrap();
        assert_eq!(chunk, "");
        assert_eq!(consumed, 0);
    }

    #[test]
    fn byte_floor_respects_newlines() {
        assert_eq!(byte_floor_at_newline("ab\ncd\nef", 8), 6);
        assert_eq!(byte_floor_at_newline("ab\ncd\nef", 6), 6);
        assert_eq!(byte_floor_at_newline("abcdef", 6), 0);
        assert_eq!(byte_floor_at_newline("ab\n", 99), 3);
    }

    // --- codex fix-forward coverage (verdict on 548b6bf) ---

    #[test]
    fn oversized_line_is_skipped_not_wedging_the_cursor() {
        let dir = std::env::temp_dir().join("sec-test-oversize");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.jsonl");
        // One 50-byte line with its newline, then a normal line: with a
        // 10-byte cap the first read window holds no newline at all.
        let long = "x".repeat(50);
        std::fs::write(&p, format!("{long}\nnormal\n")).unwrap();
        let (chunk, consumed) = read_chunk(&p, 0, 10).unwrap();
        assert_eq!(chunk, "", "an oversized line is consumed but never returned");
        assert_eq!(consumed, 51, "consumed through the oversized line's newline");
        let (chunk, consumed) = read_chunk(&p, 51, 10).unwrap();
        assert_eq!(chunk, "normal\n");
        assert_eq!(consumed, 7);
        // An oversized line with NO newline yet (still being written) waits.
        let p2 = dir.join("t2.jsonl");
        std::fs::write(&p2, "y".repeat(50)).unwrap();
        let (_, consumed) = read_chunk(&p2, 0, 10).unwrap();
        assert_eq!(consumed, 0, "an unterminated line is waited on, not consumed");
    }

    #[test]
    fn claim_intact_detects_release_retarget_and_completion() {
        let conn = migrated_conn();
        let task = seed_task(&conn);
        conn.execute(
            "INSERT INTO agent_claims (session_id, task_id, claimed_at) VALUES ('s-1', ?1, 'now')",
            [task],
        )
        .unwrap();
        assert!(claim_intact(&conn, "s-1", task));
        // Retarget: the session moved to another card mid-engine-call.
        let other = seed_task(&conn);
        conn.execute("UPDATE agent_claims SET task_id = ?1 WHERE session_id = 's-1'", [other])
            .unwrap();
        assert!(!claim_intact(&conn, "s-1", task), "retargeted claim must not write the old card");
        // Completion: done cards are never written.
        conn.execute("UPDATE agent_claims SET task_id = ?1 WHERE session_id = 's-1'", [task])
            .unwrap();
        conn.execute("UPDATE tasks SET status = 'done' WHERE id = ?1", [task]).unwrap();
        assert!(!claim_intact(&conn, "s-1", task));
        // Release: no claim row, no writes.
        conn.execute("DELETE FROM agent_claims WHERE session_id = 's-1'", []).unwrap();
        conn.execute("UPDATE tasks SET status = 'doing' WHERE id = ?1", [task]).unwrap();
        assert!(!claim_intact(&conn, "s-1", task));
    }

    #[test]
    fn tool_result_tails_become_outcome_candidates_only_with_signal() {
        let result_line = |text: &str| {
            format!(
                r#"{{"type":"user","message":{{"content":[{{"type":"tool_result","content":"{text}"}}]}}}}"#
            )
        };
        // A test summary tail is a candidate…
        let got = extract_candidates(&result_line("test result: ok. 259 passed; 0 failed"));
        assert_eq!(
            got,
            vec![Candidate::Outcome("test result: ok. 259 passed; 0 failed".into())]
        );
        // …a plain file dump is not.
        assert!(extract_candidates(&result_line("fn main() {} // just code")).is_empty());
        // Block-shaped result content also parses.
        let block_line = r#"{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":"BUILD FAILED: 2 errors"}]}]}}"#;
        assert_eq!(
            extract_candidates(block_line),
            vec![Candidate::Outcome("BUILD FAILED: 2 errors".into())]
        );
    }

    #[test]
    fn outcome_reaches_the_prompt() {
        let t = ticks(&[("write tests", 1)]);
        let p = build_prompt(&t, &[Candidate::Outcome("259 passed; 0 failed".into())]).unwrap();
        assert!(p.contains("- result: 259 passed; 0 failed"));
    }

    #[test]
    fn missing_scratch_file_is_retryable_not_dropped() {
        let conn = migrated_conn();
        let task = seed_task(&conn);
        let store = std::env::temp_dir().join("sec-test-retry-store");
        let src = std::env::temp_dir().join("sec-test-retry").join("late.html");
        // The temp path is shared across runs — a previous run's file would
        // fake an instant Applied and mask the retry path under test.
        let _ = std::fs::remove_file(&src);
        let action = EvidenceAction::CopyAttach {
            source: src.to_string_lossy().into_owned(),
        };
        // File not there yet: retryable, and nothing was linked.
        assert_eq!(apply_evidence(&conn, &store, task, &action), EvidenceOutcome::FileMissing);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_links WHERE task_id = ?1", [task], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        // The file appears (the transcript's natural order) — the retry lands.
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::fs::write(&src, "<h1>late</h1>").unwrap();
        assert_eq!(apply_evidence(&conn, &store, task, &action), EvidenceOutcome::Applied);
    }

    #[test]
    fn decide_cursor_crosses_skipped_bytes_instead_of_wedging() {
        // The oversized-line skip returns an empty chunk with consumed > 0.
        assert_eq!(decide_step("", 51), DecideStep::SkipAhead(51));
        // A mid-line boundary (give-up path) leaves no newline in the span.
        assert_eq!(decide_step("no newline here", 15), DecideStep::SkipAhead(15));
        // Normal chunks parse; nothing usable also parses (a no-op).
        assert_eq!(decide_step("a\nb\n", 4), DecideStep::Parse);
        assert_eq!(decide_step("", 0), DecideStep::Parse);
    }

    #[test]
    fn guarded_write_is_a_real_barrier() {
        let conn = migrated_conn();
        let task = seed_task(&conn);
        // The guard also checks the process-wide enabled flag (default off).
        config_cell().lock().unwrap().enabled = true;
        // No claim → the guard refuses and the write rolls back.
        let ran = guarded_write(&conn, "s-1", task, |c| {
            record_activity(c, task, "must not persist");
            true
        });
        assert_eq!(ran, None);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_activity WHERE task_id = ?1", [task], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 0, "a refused guard must leave no trace");
        // With an intact claim the same write commits.
        conn.execute(
            "INSERT INTO agent_claims (session_id, task_id, claimed_at) VALUES ('s-1', ?1, 'now')",
            [task],
        )
        .unwrap();
        assert_eq!(
            guarded_write(&conn, "s-1", task, |c| {
                record_activity(c, task, "persists");
                true
            }),
            Some(true)
        );
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_activity WHERE task_id = ?1", [task], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn secretary_activity_labels_are_always_capped() {
        let conn = migrated_conn();
        let task = seed_task(&conn);
        record_activity(&conn, task, &"x".repeat(LABEL_CAP + 500));
        let stored: String = conn
            .query_row("SELECT label FROM task_activity WHERE task_id = ?1", [task], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(stored.chars().count() <= LABEL_CAP + 1); // + ellipsis
    }

    #[test]
    fn nonconventional_worktree_root_normalizes_docs_durably() {
        // A worktree living OUTSIDE <root>/.claude/worktrees — the resolved
        // root arrives from git via durable_root; the pure decision must use
        // it for both the match and the durable path.
        let cwd = "/Users/u/scratch/wt-feature";
        let root = Some("/Users/u/projects/app");
        assert_eq!(
            evidence_action("/Users/u/scratch/wt-feature/docs/specs/s.md", cwd, "/Users/u", root),
            Some(EvidenceAction::LinkDoc {
                path: "/Users/u/projects/app/docs/specs/s.md".into()
            })
        );
    }

    #[test]
    fn main_checkout_root_only_matches_the_worktree_convention() {
        assert_eq!(
            main_checkout_root("/a/b/.claude/worktrees/x"),
            Some("/a/b".to_string())
        );
        assert_eq!(main_checkout_root("/a/b"), None);
        assert_eq!(main_checkout_root("/.claude/worktrees/x"), None);
    }
}
