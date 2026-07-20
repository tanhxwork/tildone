//! Artifact watching (spec 2026-07-19-anycli-workspace-v2, F1): durable
//! on-disk traces — claude transcripts, git refs — become card facts that
//! outlive the process. The kernel wakes us (FSEvents via the notify crate);
//! facts live in memory and are re-derived on watcher events, never persisted
//! (derived data — the artifacts themselves are the storage).
//!
//! One thread owns everything: it enumerates watch targets from the claims
//! table, re-enumerates when the board changes (`agent-db-changed`), debounces
//! bursts per task, recomputes facts, and emits `artifacts-changed` for the
//! frontend store to re-pull.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use notify::{RecursiveMode, Watcher};
use tauri::{Emitter, Listener};

/// Transcript turn scans are capped here; a pathological multi-GB file must
/// not stall the watcher thread. The tail window still yields useful counts.
const SCAN_CAP: u64 = 20 * 1024 * 1024;
/// How much of the file's tail is searched for the last assistant message.
const TAIL_CAP: u64 = 256 * 1024;
/// Burst debounce: a busy session appends many chunks per second; facts are
/// glanceable, not real-time — recompute at most every 2 s per task.
const DEBOUNCE: Duration = Duration::from_secs(2);

#[derive(serde::Serialize, Clone, Default)]
pub struct ArtifactFacts {
    pub task_id: i64,
    /// ISO timestamp of the newest transcript write, if any transcript exists.
    pub last_active: Option<String>,
    /// Assistant turns in the newest transcript (newest-mtime claim wins).
    pub turns: u32,
    /// Commits on the task's branch not on the default branch.
    pub commits_ahead: u32,
    /// Subjects of the newest of those commits (at most 3).
    pub commit_subjects: Vec<String>,
    /// The last assistant message's text, truncated — "what did it just say".
    pub last_message: Option<String>,
}

fn facts_map() -> &'static Mutex<HashMap<i64, ArtifactFacts>> {
    static FACTS: OnceLock<Mutex<HashMap<i64, ArtifactFacts>>> = OnceLock::new();
    FACTS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub fn artifact_facts() -> Vec<ArtifactFacts> {
    facts_map().lock().unwrap().values().cloned().collect()
}

// ---------------------------------------------------------------------------
// Watch targets

/// cwd → claude transcript dir slug: every non-alphanumeric byte becomes '-'.
/// Observed: /Users/hongxuan/projects/tildone → -Users-hongxuan-projects-tildone
/// and /Users/…/.claude/jobs/x/tmp/y → -Users-…--claude-jobs-x-tmp-y ('.' and
/// '/' both map to '-'). '_' is unobserved and pinned to '-' by test — verify
/// against a real session if a claimed cwd ever contains one.
fn transcript_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

#[derive(Clone)]
enum Target {
    Transcript { task_id: i64, path: PathBuf },
    Branch { task_id: i64, cwd: String, branch: String, refs_dir: PathBuf, common_dir: PathBuf },
}

/// Everything worth watching right now, per the claims table: transcripts for
/// claimed sessions of not-done tasks, git refs for claimed branches.
fn enumerate(app: &tauri::AppHandle, home: &str) -> Vec<Target> {
    let Ok(conn) = crate::agent::open_db(app) else {
        return Vec::new();
    };
    let mut targets = Vec::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT c.task_id, c.session_id, c.cwd, c.branch FROM agent_claims c \
         JOIN tasks t ON t.id = c.task_id \
         WHERE t.status != 'done' AND t.deleted_at IS NULL AND c.cwd IS NOT NULL",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    });
    let Ok(rows) = rows else { return Vec::new() };
    for row in rows.flatten() {
        let (task_id, session_id, cwd, branch) = row;
        targets.push(Target::Transcript {
            task_id,
            path: PathBuf::from(format!(
                "{home}/.claude/projects/{}/{session_id}.jsonl",
                transcript_slug(&cwd)
            )),
        });
        if let Some(branch) = branch.filter(|b| !b.is_empty()) {
            if let Some(common) = git_common_dir(&cwd) {
                targets.push(Target::Branch {
                    task_id,
                    cwd,
                    branch,
                    refs_dir: common.join("refs/heads"),
                    common_dir: common,
                });
            }
        }
    }
    targets
}

/// Where this checkout's refs actually live. `--git-common-dir` (not
/// `--git-dir`) because worktree checkouts keep branch refs in the main
/// repo's gitdir; watching the worktree's private gitdir would miss commits.
fn git_common_dir(cwd: &str) -> Option<PathBuf> {
    let out = std::process::Command::new("git")
        .args(["-C", cwd, "rev-parse", "--git-common-dir"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if dir.is_empty() {
        return None;
    }
    let path = PathBuf::from(&dir);
    let abs = if path.is_absolute() { path } else { Path::new(cwd).join(path) };
    abs.canonicalize().ok().or(Some(abs))
}

// ---------------------------------------------------------------------------
// Facts computation

/// Assistant turns: occurrences of the record-type marker in the (capped)
/// file. A byte scan, not a JSON parse — transcripts reach many MB.
fn count_turns(bytes: &[u8]) -> u32 {
    const NEEDLE: &[u8] = b"\"type\":\"assistant\"";
    let mut n = 0u32;
    let mut i = 0;
    while i + NEEDLE.len() <= bytes.len() {
        if &bytes[i..i + NEEDLE.len()] == NEEDLE {
            n += 1;
            i += NEEDLE.len();
        } else {
            i += 1;
        }
    }
    n
}

/// The last assistant message's text from a chunk of transcript tail:
/// newest line containing an assistant record whose content has text blocks.
fn last_assistant_message(tail: &str) -> Option<String> {
    for line in tail.lines().rev() {
        if !line.contains("\"type\":\"assistant\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let content = v.get("message").and_then(|m| m.get("content"))?;
        let text = match content {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Array(blocks) => blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => continue,
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let mut out: String = text.chars().take(500).collect();
        if text.chars().count() > 500 {
            out.push('…');
        }
        return Some(out);
    }
    None
}

struct TranscriptFacts {
    mtime: SystemTime,
    last_active: String,
    turns: u32,
    last_message: Option<String>,
}

fn read_transcript(path: &Path) -> Option<TranscriptFacts> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?;
    let len = meta.len();
    let mut f = std::fs::File::open(path).ok()?;

    let scan_from = len.saturating_sub(SCAN_CAP);
    f.seek(SeekFrom::Start(scan_from)).ok()?;
    let mut bytes = Vec::with_capacity((len - scan_from) as usize);
    f.read_to_end(&mut bytes).ok()?;
    let turns = count_turns(&bytes);

    let tail_start = bytes.len().saturating_sub(TAIL_CAP as usize);
    let tail = String::from_utf8_lossy(&bytes[tail_start..]);
    let last_message = last_assistant_message(&tail);

    let millis = mtime
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    Some(TranscriptFacts {
        mtime,
        last_active: crate::agent::iso_from_epoch_millis(millis),
        turns,
        last_message,
    })
}

/// Commits on `branch` that the default branch doesn't have (count + up to 3
/// newest subjects). Default branch from origin/HEAD, falling back to main.
fn git_ahead(cwd: &str, branch: &str) -> (u32, Vec<String>) {
    let default = std::process::Command::new("git")
        .args(["-C", cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .and_then(|s| s.strip_prefix("origin/").map(str::to_string).or(Some(s)))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "main".to_string());
    if default == *branch {
        return (0, Vec::new());
    }
    let Ok(out) = std::process::Command::new("git")
        .args(["-C", cwd, "log", "--format=%s", &format!("{default}..{branch}")])
        .output()
    else {
        return (0, Vec::new());
    };
    if !out.status.success() {
        return (0, Vec::new());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let subjects: Vec<&str> = text.lines().filter(|l| !l.is_empty()).collect();
    (
        subjects.len() as u32,
        subjects.iter().take(3).map(|s| s.to_string()).collect(),
    )
}

/// Re-derive one task's facts from its current targets. Several claims can
/// point at one task; the newest-mtime transcript wins for the transcript
/// half. Returns None when no target yields anything (facts entry removed).
fn compute(task_id: i64, targets: &[Target]) -> Option<ArtifactFacts> {
    let mut facts = ArtifactFacts { task_id, ..Default::default() };
    let mut newest: Option<SystemTime> = None;
    let mut any = false;
    for t in targets {
        match t {
            Target::Transcript { task_id: tid, path } if *tid == task_id => {
                if let Some(tf) = read_transcript(path) {
                    any = true;
                    if newest.is_none_or(|n| tf.mtime > n) {
                        newest = Some(tf.mtime);
                        facts.last_active = Some(tf.last_active);
                        facts.turns = tf.turns;
                        facts.last_message = tf.last_message;
                    }
                }
            }
            Target::Branch { task_id: tid, cwd, branch, .. } if *tid == task_id => {
                let (ahead, subjects) = git_ahead(cwd, branch);
                if ahead > 0 {
                    any = true;
                    facts.commits_ahead = ahead;
                    facts.commit_subjects = subjects;
                }
            }
            _ => {}
        }
    }
    any.then_some(facts)
}

// ---------------------------------------------------------------------------
// The watcher thread

/// Which tasks does a filesystem event touch?
fn affected_tasks(targets: &[Target], event_path: &Path) -> Vec<i64> {
    let mut out = Vec::new();
    for t in targets {
        match t {
            Target::Transcript { task_id, path } => {
                if event_path == path {
                    out.push(*task_id);
                }
            }
            Target::Branch { task_id, refs_dir, common_dir, .. } => {
                // A ref update touches refs/heads/<branch> or rewrites
                // packed-refs at the top of the common dir.
                if event_path.starts_with(refs_dir)
                    || event_path == common_dir.join("packed-refs")
                {
                    out.push(*task_id);
                }
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// Directories to hand the watcher. Parent dirs, not files: a transcript may
/// not exist yet when the claim lands, and notify tracks dirs more reliably.
fn watch_dirs(targets: &[Target]) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for t in targets {
        match t {
            Target::Transcript { path, .. } => {
                if let Some(parent) = path.parent() {
                    dirs.push(parent.to_path_buf());
                }
            }
            Target::Branch { refs_dir, common_dir, .. } => {
                dirs.push(refs_dir.clone());
                dirs.push(common_dir.clone());
            }
        }
    }
    dirs.sort();
    dirs.dedup();
    dirs.retain(|d| d.is_dir());
    dirs
}

// ---------------------------------------------------------------------------
// CLI-session binding (F3): hosted sessions reveal their own session id
// through the artifacts they create — a fresh transcript in the cwd's slug
// dir (claude), a fresh rollout file (codex). artifacts.rs owns the watchers,
// host.rs owns the sessions; this is the seam between them.

struct BindTarget {
    session_id: u64,
    /// None for a session-first (unbound) session: the task-first claims
    /// fallback below has nothing to look up then — those sessions bind the
    /// other way around (host::try_adopt_claim, bind-on-claim).
    task_id: Option<i64>,
    adapter_id: &'static str,
    /// claude: the cwd's transcript slug dir (exact-parent match).
    /// codex: `$HOME/.codex/sessions` (prefix match, watched recursively).
    dir: PathBuf,
    /// ISO — only artifacts stamped at or after the spawn may bind.
    started_at: String,
}

fn bind_targets(home: &str) -> Vec<BindTarget> {
    crate::host::unbound_hosted()
        .into_iter()
        .map(|u| {
            let dir = match u.adapter_id {
                "codex" => PathBuf::from(format!("{home}/.codex/sessions")),
                _ => PathBuf::from(format!(
                    "{home}/.claude/projects/{}",
                    transcript_slug(&u.cwd)
                )),
            };
            BindTarget {
                session_id: u.session_id,
                task_id: u.task_id,
                adapter_id: u.adapter_id,
                dir,
                started_at: u.started_at,
            }
        })
        .collect()
}

/// Strict UUID shape: hex digits with dashes at 8/13/18/23. Every bound
/// session id passes through this before it can ever become resume argv
/// (`claude --resume <id>` / `codex resume <id>`) — a filename is untrusted
/// input, and a validated UUID can't smuggle a flag (codex verify
/// hardening, 2026-07-19).
pub(crate) fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.chars().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() }
        })
}

/// The UUID at the end of a codex rollout filename
/// (`rollout-2026-06-12T16-23-07-<uuid>.jsonl`), if it looks like one.
fn rollout_uuid(file_name: &str) -> Option<String> {
    let stem = file_name.strip_suffix(".jsonl")?;
    if !file_name.starts_with("rollout-") || stem.len() < 36 {
        return None;
    }
    let uuid = &stem[stem.len() - 36..];
    is_uuid(uuid).then(|| uuid.to_string())
}

fn mtime_iso(path: &Path) -> Option<String> {
    let mtime = std::fs::metadata(path).ok()?.modified().ok()?;
    let millis = mtime.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
    Some(crate::agent::iso_from_epoch_millis(millis))
}

/// A filesystem event landed — does it reveal an unbound session's id?
/// Returns true when something bound (the caller rebuilds the watch set).
fn try_bind(app: &tauri::AppHandle, binds: &[BindTarget], event_path: &Path) -> bool {
    let Some(name) = event_path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    for b in binds {
        let (matched, uuid) = match b.adapter_id {
            "codex" => {
                if !event_path.starts_with(&b.dir) {
                    continue;
                }
                match rollout_uuid(name) {
                    Some(u) => (true, u),
                    None => continue,
                }
            }
            _ => {
                // claude: `<slug-dir>/<uuid>.jsonl`, exact parent.
                if event_path.parent() != Some(b.dir.as_path()) {
                    continue;
                }
                let Some(stem) = name.strip_suffix(".jsonl") else { continue };
                // Same rigor as the codex branch: only a real UUID may bind
                // (and later ride resume argv).
                if !is_uuid(stem) {
                    continue;
                }
                (true, stem.to_string())
            }
        };
        if !matched {
            continue;
        }
        // Only artifacts younger than the spawn: an old transcript sitting in
        // the same dir (another session, same cwd) must not bind. ISO strings
        // compare lexicographically.
        match mtime_iso(event_path) {
            Some(m) if m >= b.started_at => {
                crate::host::bind_cli_session(app, b.session_id, &uuid);
                return true;
            }
            _ => continue,
        }
    }
    false
}

/// Bind fallback for claude sessions that claim their task over MCP before
/// (or instead of) the transcript watcher firing: the claim carries the
/// session id directly. Returns true when something bound.
fn try_bind_from_claims(app: &tauri::AppHandle, binds: &[BindTarget]) -> bool {
    let claude_targets: Vec<&BindTarget> =
        binds.iter().filter(|b| b.adapter_id == "claude").collect();
    if claude_targets.is_empty() {
        return false;
    }
    let Ok(conn) = crate::agent::open_db(app) else { return false };
    let mut bound = false;
    for b in claude_targets {
        let Some(task_id) = b.task_id else { continue };
        let found: Option<String> = conn
            .query_row(
                "SELECT session_id FROM agent_claims \
                 WHERE task_id = ?1 AND claimed_at >= ?2 \
                 ORDER BY claimed_at ASC LIMIT 1",
                rusqlite::params![task_id, b.started_at],
                |r| r.get(0),
            )
            .ok();
        if let Some(sid) = found {
            crate::host::bind_cli_session(app, b.session_id, &sid);
            bound = true;
        }
    }
    bound
}

pub fn init(app: &tauri::AppHandle) {
    let dirty = Arc::new(AtomicBool::new(true));
    // Claims change → the watch set changes. The agent server emits this on
    // every board write; over-triggering is fine, enumeration is one query.
    let flag = Arc::clone(&dirty);
    app.listen("agent-db-changed", move |_| {
        flag.store(true, Ordering::Relaxed);
    });
    // Hosted sessions starting/stopping change the bind targets too.
    let flag = Arc::clone(&dirty);
    app.listen("host-changed", move |_| {
        flag.store(true, Ordering::Relaxed);
    });

    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(home) = std::env::var("HOME") else { return };
        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        // Underscore: the binding's job is keeping the watcher alive across
        // iterations; each re-enumeration overwrites it before reading.
        let mut _watcher: Option<notify::RecommendedWatcher> = None;
        let mut targets: Vec<Target> = Vec::new();
        let mut binds: Vec<BindTarget> = Vec::new();
        // task_id → deadline for its pending recompute (burst debounce).
        let mut pending: HashMap<i64, Instant> = HashMap::new();
        let mut last_enumerate = Instant::now();

        loop {
            if dirty.swap(false, Ordering::Relaxed)
                || last_enumerate.elapsed() > Duration::from_secs(60)
            {
                last_enumerate = Instant::now();
                targets = enumerate(&app, &home);
                binds = bind_targets(&home);
                // Claims can carry a bind directly (agent adopted the card
                // before its transcript file surfaced).
                if try_bind_from_claims(&app, &binds) {
                    binds = bind_targets(&home);
                }
                // Rebuild the watcher wholesale: unwatching piecemeal earns
                // nothing at this scale and drop-and-recreate cannot leak.
                _watcher = notify::recommended_watcher(tx.clone()).ok();
                if let Some(w) = _watcher.as_mut() {
                    for dir in watch_dirs(&targets) {
                        let _ = w.watch(&dir, RecursiveMode::NonRecursive);
                    }
                    for b in &binds {
                        // codex nests rollouts in Y/M/D dirs — recursive; the
                        // claude slug dir is flat.
                        let mode = if b.adapter_id == "codex" {
                            RecursiveMode::Recursive
                        } else {
                            RecursiveMode::NonRecursive
                        };
                        if b.dir.is_dir() {
                            let _ = w.watch(&b.dir, mode);
                        }
                    }
                }
                let ids: Vec<i64> = targets
                    .iter()
                    .map(|t| match t {
                        Target::Transcript { task_id, .. } => *task_id,
                        Target::Branch { task_id, .. } => *task_id,
                    })
                    .collect();
                let now = Instant::now();
                for id in ids {
                    pending.entry(id).or_insert(now);
                }
                // Tasks that fell out of the watch set lose their facts.
                let live: std::collections::HashSet<i64> = targets
                    .iter()
                    .map(|t| match t {
                        Target::Transcript { task_id, .. } => *task_id,
                        Target::Branch { task_id, .. } => *task_id,
                    })
                    .collect();
                let mut map = facts_map().lock().unwrap();
                let before = map.len();
                map.retain(|id, _| live.contains(id));
                if map.len() != before {
                    drop(map);
                    let _ = app.emit("artifacts-changed", ());
                }
            }

            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(Ok(event)) => {
                    let deadline = Instant::now() + DEBOUNCE;
                    for path in &event.paths {
                        if try_bind(&app, &binds, path) {
                            // Bound: the target list changed; re-enumerate on
                            // the next spin rather than mutating in place.
                            dirty.store(true, Ordering::Relaxed);
                        }
                        for id in affected_tasks(&targets, path) {
                            pending.entry(id).or_insert(deadline);
                        }
                    }
                }
                Ok(Err(_)) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }

            let now = Instant::now();
            let due: Vec<i64> = pending
                .iter()
                .filter(|(_, dl)| **dl <= now)
                .map(|(id, _)| *id)
                .collect();
            if !due.is_empty() {
                let mut changed = false;
                for id in due {
                    pending.remove(&id);
                    let fresh = compute(id, &targets);
                    let mut map = facts_map().lock().unwrap();
                    match fresh {
                        Some(f) => {
                            map.insert(id, f);
                            changed = true;
                        }
                        None => {
                            changed |= map.remove(&id).is_some();
                        }
                    }
                }
                if changed {
                    let _ = app.emit("artifacts-changed", ());
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_maps_every_non_alphanumeric_to_dash() {
        assert_eq!(
            transcript_slug("/Users/hongxuan/projects/tildone"),
            "-Users-hongxuan-projects-tildone"
        );
        // '.' maps too — observed as the double dash in .claude.
        assert_eq!(
            transcript_slug("/Users/hongxuan/.claude/jobs/x/tmp"),
            "-Users-hongxuan--claude-jobs-x-tmp"
        );
        // '_' unobserved in the wild; pinned to '-' until proven otherwise.
        assert_eq!(transcript_slug("/a/b_c"), "-a-b-c");
    }

    const FIXTURE: &str = concat!(
        r#"{"type":"user","message":{"content":"do the thing"}}"#,
        "\n",
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Working on it."},{"type":"text","text":"Done: 3 files changed."}]}}"#,
        "\n",
        r#"{"type":"progress","data":{"pct":100}}"#,
        "\n",
    );

    #[test]
    fn last_message_joins_text_blocks_of_newest_assistant_line() {
        assert_eq!(
            last_assistant_message(FIXTURE).as_deref(),
            Some("Working on it.\nDone: 3 files changed.")
        );
        assert_eq!(last_assistant_message("not json\n"), None);
    }

    #[test]
    fn turn_count_sees_only_assistant_records() {
        assert_eq!(count_turns(FIXTURE.as_bytes()), 1);
        assert_eq!(count_turns(b""), 0);
    }

    #[test]
    fn bind_ids_must_be_real_uuids() {
        // The bound id later rides resume argv — only strict UUIDs pass
        // (codex verify hardening, 2026-07-19).
        assert!(is_uuid("019ebaed-7e23-7e53-8fd5-08fafab4e104"));
        assert!(!is_uuid("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"));
        assert!(!is_uuid("------------------------------------"));
        // Exactly 36 chars, flag-shaped: rejected by content (position 0
        // must be hex), not by the length gate.
        assert!(!is_uuid("-0123456-789a-bcde-f012-3456789abcde"));
        assert!(!is_uuid("019ebaed7e237e538fd508fafab4e104"));
    }

    #[test]
    fn rollout_uuid_parses_the_trailing_uuid() {
        // Real filename shape from ~/.codex/sessions on this machine.
        assert_eq!(
            rollout_uuid("rollout-2026-06-12T16-23-07-019ebaed-7e23-7e53-8fd5-08fafab4e104.jsonl")
                .as_deref(),
            Some("019ebaed-7e23-7e53-8fd5-08fafab4e104")
        );
        assert_eq!(rollout_uuid("rollout-bad.jsonl"), None);
        assert_eq!(
            rollout_uuid("other-019ebaed-7e23-7e53-8fd5-08fafab4e104.jsonl"),
            None,
            "non-rollout files must not bind"
        );
        assert_eq!(rollout_uuid("rollout-2026.txt"), None);
    }

    #[test]
    fn long_last_message_is_truncated_with_ellipsis() {
        let long = "x".repeat(600);
        let line = format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"{long}"}}]}}}}"#
        );
        let got = last_assistant_message(&line).unwrap();
        assert_eq!(got.chars().count(), 501);
        assert!(got.ends_with('…'));
    }
}
