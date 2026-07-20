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
    /// The hosted session's adapter. `"shell"` means the CLI is not the
    /// session itself but something the user typed at its prompt, which is
    /// why those targets carry the extra ownership proof below.
    adapter_id: &'static str,
    /// Which kind of artifact this dir holds — `"claude"` or `"codex"`. For
    /// agent adapters it equals `adapter_id`; a shell gets one target of
    /// each, since either CLI may be run at its prompt.
    kind: &'static str,
    /// claude: the cwd's transcript slug dir (exact-parent match).
    /// codex: `$HOME/.codex/sessions` (prefix match, watched recursively).
    dir: PathBuf,
    /// The PTY child's pid — Some only for shell targets, where binding must
    /// prove the CLI really runs inside *this* shell.
    pid: Option<u32>,
    /// ISO — only artifacts stamped at or after the spawn may bind.
    started_at: String,
}

/// Every directory an unbound session could reveal its CLI session id in,
/// paired with the artifact kind that dir holds. A shell yields both kinds
/// and, for claude, one dir per candidate cwd (TIL-128).
fn bind_dirs(adapter_id: &str, cwds: &[String], home: &str) -> Vec<(&'static str, PathBuf)> {
    let codex = ("codex", PathBuf::from(format!("{home}/.codex/sessions")));
    let claude = |cwd: &String| {
        (
            "claude",
            PathBuf::from(format!("{home}/.claude/projects/{}", transcript_slug(cwd))),
        )
    };
    match adapter_id {
        "codex" => vec![codex],
        "shell" => cwds.iter().map(claude).chain(std::iter::once(codex)).collect(),
        _ => cwds.iter().map(claude).collect(),
    }
}

fn bind_targets(home: &str) -> Vec<BindTarget> {
    let mut out = Vec::new();
    for u in crate::host::unbound_hosted() {
        // A shell's user may `cd` before launching the CLI, and the CLI files
        // its transcript under the directory it was launched in — so watch
        // the shell's current cwd as well as the one it was spawned in.
        let mut cwds = vec![u.cwd.clone()];
        if u.adapter_id == "shell" {
            if let Some(live) = u.pid.and_then(live_cwd) {
                if !cwds.contains(&live) {
                    cwds.push(live);
                }
            }
        }
        for (kind, dir) in bind_dirs(u.adapter_id, &cwds, home) {
            out.push(BindTarget {
                session_id: u.session_id,
                task_id: u.task_id,
                adapter_id: u.adapter_id,
                kind,
                dir,
                pid: (u.adapter_id == "shell").then_some(u.pid).flatten(),
                started_at: u.started_at.clone(),
            });
        }
    }
    out
}

/// A hosted shell's current working directory, read from the PTY child. macOS
/// has no `/proc`; `lsof` on a single pid costs ~50ms and this runs at most
/// once per watch-set rebuild.
fn live_cwd(pid: u32) -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/lsof")
        .args(["-a", "-w", "-d", "cwd", "-Fn", "-p", &pid.to_string()])
        .output()
        .ok()?;
    lsof_cwd(&String::from_utf8_lossy(&out.stdout))
}

/// `lsof -Fn` prints one tagged field per line; the cwd is the first `n`.
fn lsof_cwd(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .find_map(|l| l.strip_prefix('n'))
        .filter(|p| p.starts_with('/'))
        .map(str::to_string)
}

/// One row of the process snapshot: pid, parent, and the command line.
pub(crate) struct Proc {
    pid: u32,
    ppid: u32,
    cmd: String,
}

fn parse_ps(stdout: &str) -> Vec<Proc> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let ppid = it.next()?.parse().ok()?;
            let cmd = it.collect::<Vec<_>>().join(" ");
            (!cmd.is_empty()).then_some(Proc { pid, ppid, cmd })
        })
        .collect()
}

/// Is this command line a CLI of `kind`? Both CLIs are real binaries named
/// after their adapter, so the leading token's basename identifies them (a
/// shim execs a vendor binary of the same name).
fn cmd_is_cli(cmd: &str, kind: &str) -> bool {
    cmd.split_whitespace()
        .next()
        .and_then(|t| t.rsplit('/').next())
        .is_some_and(|base| base == kind)
}

/// Does `cmd` prove ownership of `uuid`? A descendant of the shell donates its
/// id only when its own argv names it: `--session-id <uuid>`, or a `--resume`
/// target whose file stem is the uuid. Descendant-ness alone is not proof —
/// every session for one repo writes into the same slug dir, so an unrelated
/// `claude` elsewhere on the machine can touch a transcript there while a
/// perfectly innocent bare-argv `claude` runs inside the pane (the TIL-130
/// regression: a `--fork-session` process outside the shell donated its uuid).
///
/// Matching is token-exact, never a substring: a uuid appearing inside some
/// longer argument is not a claim of ownership.
pub(crate) fn argv_proves_uuid(cmd: &str, uuid: &str) -> bool {
    let mut tokens = cmd.split_whitespace();
    while let Some(tok) = tokens.next() {
        // Everything after a bare `--` is positional — prompt text, not
        // options. `claude -- --session-id <u>` asserts nothing about <u>,
        // and treating it as proof would hand a stranger a way to donate an
        // id just by naming it in a prompt.
        if tok == "--" {
            return false;
        }
        match tok {
            // Only `--resume` takes a transcript path; `--session-id` is
            // always a bare id, so a path there proves nothing.
            "--session-id" => match tokens.next() {
                Some(v) => {
                    if v == uuid {
                        return true;
                    }
                }
                None => return false,
            },
            "--resume" => match tokens.next() {
                Some(v) => {
                    if resume_target_is(v, uuid) {
                        return true;
                    }
                }
                None => return false,
            },
            // The same assertions, spelled joined.
            _ => {
                if tok.strip_prefix("--session-id=").is_some_and(|v| v == uuid) {
                    return true;
                }
                if tok.strip_prefix("--resume=").is_some_and(|v| resume_target_is(v, uuid)) {
                    return true;
                }
            }
        }
    }
    false
}

/// A `--resume` argument names `uuid` when it is the id itself or a transcript
/// path whose file stem is that id.
fn resume_target_is(arg: &str, uuid: &str) -> bool {
    let stem = arg.rsplit('/').next().unwrap_or(arg);
    stem == uuid || stem.strip_suffix(".jsonl") == Some(uuid)
}

/// Is a CLI of `kind` running under `ancestor` that *proves* it owns `uuid`?
/// The tightened shell guard: `has_cli_descendant` answers "is someone home",
/// which a stranger's artifact can ride; this answers "did the process in this
/// pane say this id is his".
fn descendant_proves_uuid(procs: &[Proc], ancestor: u32, kind: &str, uuid: &str) -> bool {
    procs.iter().any(|p| {
        cmd_is_cli(&p.cmd, kind)
            && argv_proves_uuid(&p.cmd, uuid)
            && descends_from(procs, p.pid, ancestor)
    })
}

/// Which hosted session owns a claim, decided by process ancestry rather than
/// by any shared directory. `last_pid` is reported by the session's own
/// heartbeat hook, so it cannot be donated by a stranger: if it descends from
/// a session's PTY child, that session is where the claiming agent runs.
///
/// `candidates` is `(session_id, pty_child_pid)`. The deepest match wins —
/// with nested panes the innermost shell is the one the agent is actually in.
pub(crate) fn session_for_claim(
    procs: &[Proc],
    candidates: &[(u64, u32)],
    last_pid: u32,
) -> Option<u64> {
    candidates
        .iter()
        .filter(|(_, pty)| descends_from(procs, last_pid, *pty))
        .filter(|(_, pty)| cli_on_path(procs, last_pid, *pty))
        .max_by_key(|(_, pty)| depth_of(procs, *pty))
        .map(|(session_id, _)| *session_id)
}

/// Is there an agent CLI somewhere on the chain from `pid` up to `pty`?
///
/// Ancestry alone is a *number* test, and pid numbers are recycled: a claim's
/// durable `last_pid` outlives its process, so a long-dead session's pid could
/// be reissued to something running under a pane and adopt that pane's card.
/// Requiring a `claude`/`codex` on the path restores the ownership proof —
/// a recycled pid under a shell that is merely sitting at its prompt no longer
/// qualifies. (A dead pid is already safe: `descends_from` finds no such row.)
fn cli_on_path(procs: &[Proc], pid: u32, pty: u32) -> bool {
    let mut cur = pid;
    for _ in 0..procs.len() {
        if cur == pty {
            return false;
        }
        let Some(p) = procs.iter().find(|p| p.pid == cur) else { return false };
        if cmd_is_cli(&p.cmd, "claude") || cmd_is_cli(&p.cmd, "codex") {
            return true;
        }
        if p.ppid == 0 {
            return false;
        }
        cur = p.ppid;
    }
    false
}

/// How far `pid` sits from the process tree's root, for picking the innermost
/// of several matching ancestors. Bounded like every other walk here.
fn depth_of(procs: &[Proc], pid: u32) -> usize {
    let mut cur = pid;
    for d in 0..procs.len() {
        match procs.iter().find(|p| p.pid == cur) {
            Some(p) if p.ppid != 0 => cur = p.ppid,
            _ => return d,
        }
    }
    procs.len()
}

/// Walk the ppid chain up from `pid`. Bounded by the snapshot length so a
/// cycle in a stale snapshot cannot hang the watcher thread.
pub(crate) fn descends_from(procs: &[Proc], pid: u32, ancestor: u32) -> bool {
    let mut cur = pid;
    for _ in 0..procs.len() {
        if cur == ancestor {
            return true;
        }
        match procs.iter().find(|p| p.pid == cur) {
            Some(p) if p.ppid != 0 => cur = p.ppid,
            _ => return false,
        }
    }
    false
}

/// How long the watcher may coast before re-enumerating its targets.
///
/// An unbound shell makes the watch set volatile in ways no filesystem event
/// can announce: the user may `cd` (changing which slug dir to watch, and the
/// live cwd is only read at enumeration), or run a CLI in a directory whose
/// transcript dir does not exist yet — and `init` can only watch a dir that
/// already exists, so there is nothing to fire until the next sweep. Both
/// would otherwise leave the pane saying "no card yet" for up to a minute.
///
/// Getting a *card* ends the fast sweep — not getting a resume key. Since
/// TIL-130 split the two, a shell may legitimately keep a null
/// `cli_session_id` for its whole life (a bare `claude` can never prove one),
/// so keying the fast sweep on "still in `unbound_hosted`" would leave every
/// such pane paying `lsof` every 5s forever. Once the card is bound there is
/// nothing urgent left to discover.
fn sweep_interval(binds: &[BindTarget]) -> Duration {
    if binds.iter().any(|b| b.adapter_id == "shell" && b.task_id.is_none()) {
        Duration::from_secs(5)
    } else {
        Duration::from_secs(60)
    }
}

pub(crate) fn ps_snapshot() -> Vec<Proc> {
    std::process::Command::new("/bin/ps")
        .args(["-Ao", "pid=,ppid=,command="])
        .output()
        .ok()
        .map(|o| parse_ps(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
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
    // Lazily taken, and only for shell targets: most events never need it.
    let mut procs: Option<Vec<Proc>> = None;
    for b in binds {
        let (matched, uuid) = match b.kind {
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
        // A shell owns this artifact only if a CLI running inside it *names
        // this uuid in its own argv*. "Some CLI is running beneath me" was the
        // old test and it was not ownership: every session for one repo writes
        // into the same slug dir, so a stranger's transcript passed the guard
        // on an innocent descendant's credentials and donated its id (TIL-130).
        //
        // A bare `claude` at the prompt therefore yields no resume key, which
        // is the honest answer — we cannot tell which transcript is his. The
        // card does not depend on this: it arrives via pid ancestry on the
        // claim (`host::try_adopt_claim`).
        if b.adapter_id == "shell" {
            let Some(pid) = b.pid else { continue };
            let snapshot = procs.get_or_insert_with(ps_snapshot);
            if !descendant_proves_uuid(snapshot, pid, b.kind, &uuid) {
                continue;
            }
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
    // Adapter sessions only: for those the session *is* the CLI, so a claim on
    // its task names its session id. A shell's prompt could be running anyone's
    // CLI, so it must earn its bind from an artifact it demonstrably owns.
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
            let due_sweep = last_enumerate.elapsed() > sweep_interval(&binds);
            if dirty.swap(false, Ordering::Relaxed) || due_sweep {
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
                        let mode = if b.kind == "codex" {
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

    // -- shell sessions running an agent CLI at the prompt (TIL-128) --------

    fn dirs(adapter: &str, cwds: &[&str]) -> Vec<(String, String)> {
        let owned: Vec<String> = cwds.iter().map(|c| c.to_string()).collect();
        bind_dirs(adapter, &owned, "/home")
            .into_iter()
            .map(|(k, d)| (k.to_string(), d.to_string_lossy().into_owned()))
            .collect()
    }

    #[test]
    fn agent_adapters_watch_exactly_their_own_artifact_dir() {
        assert_eq!(
            dirs("claude", &["/w/proj"]),
            vec![("claude".into(), "/home/.claude/projects/-w-proj".into())]
        );
        assert_eq!(
            dirs("codex", &["/w/proj"]),
            vec![("codex".into(), "/home/.codex/sessions".into())]
        );
    }

    #[test]
    fn a_shell_watches_both_clis_and_every_candidate_cwd() {
        // The user may `cd` before typing `claude`, so the shell's live cwd
        // is watched alongside the one it was spawned in.
        assert_eq!(
            dirs("shell", &["/w/proj", "/w/other"]),
            vec![
                ("claude".into(), "/home/.claude/projects/-w-proj".into()),
                ("claude".into(), "/home/.claude/projects/-w-other".into()),
                ("codex".into(), "/home/.codex/sessions".into()),
            ]
        );
    }

    #[test]
    fn lsof_reads_the_cwd_field_and_ignores_the_rest() {
        assert_eq!(lsof_cwd("p54751\nfcwd\nn/private/tmp\n").as_deref(), Some("/private/tmp"));
        assert_eq!(lsof_cwd("p54751\nfcwd\n"), None);
        assert_eq!(lsof_cwd(""), None);
        assert_eq!(lsof_cwd("nnot-a-path\n"), None, "only absolute paths are cwds");
    }

    fn procs(rows: &[(u32, u32, &str)]) -> Vec<Proc> {
        rows.iter().map(|(pid, ppid, cmd)| Proc { pid: *pid, ppid: *ppid, cmd: cmd.to_string() }).collect()
    }

    #[test]
    fn ps_rows_split_into_pid_ppid_and_the_whole_command_line() {
        let got = parse_ps("  9351  9350 /usr/local/bin/codex --foo\n33807 99381 claude bg-pty-host\nnoise\n");
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].pid, got[0].ppid), (9351, 9350));
        assert_eq!(got[0].cmd, "/usr/local/bin/codex --foo");
        assert_eq!(got[1].cmd, "claude bg-pty-host");
    }

    #[test]
    fn a_cli_binds_a_shell_only_when_it_runs_underneath_that_shell() {
        const U: &str = "16eefe1f-d5a2-469a-ae38-769ae79f175c";
        let owned = format!("/usr/local/bin/claude --session-id {U}");
        let table = procs(&[
            (100, 1, "/bin/zsh -l"),  // our hosted shell
            (101, 100, &owned),       // …running a claude that names the id
            (200, 1, "/bin/zsh -l"),  // a stranger's shell
            (201, 200, &owned),       // …with a claude naming the same id
        ]);
        assert!(descendant_proves_uuid(&table, 100, "claude", U));
        assert!(descendant_proves_uuid(&table, 200, "claude", U));
        assert!(!descendant_proves_uuid(&table, 100, "codex", U), "wrong CLI must not bind");
        assert!(!descendant_proves_uuid(&table, 300, "claude", U), "unknown shell owns nothing");
    }

    /// The TIL-130 regression, verbatim from the installed app: a foreign
    /// `--fork-session` process outside the shell wrote into the shared slug
    /// dir while an innocent bare-argv `claude` ran *inside* the pane. The old
    /// guard ("is some claude running beneath me?") said yes and bound the
    /// stranger's uuid — permanently, since binding is set-once.
    #[test]
    fn a_strangers_uuid_cannot_bind_even_while_an_innocent_cli_runs_inside() {
        const U: &str = "16eefe1f-d5a2-469a-ae38-769ae79f175c";
        let stranger = format!("claude --session-id {U} --fork-session --resume /p/1d76953e.jsonl");
        let table = procs(&[
            (82600, 1, "/Applications/Tildone.app/Contents/MacOS/tildone"),
            (15634, 82600, "/bin/zsh -l"), // the hosted shell (PTY child)
            (16078, 15634, "claude"),      // the real inner CLI — bare argv, proves nothing
            (24027, 1, &stranger),         // the donor, outside the shell entirely
        ]);
        assert!(
            !descendant_proves_uuid(&table, 15634, "claude", U),
            "a non-descendant naming the uuid must never donate it"
        );
        // And the honest consequence: the inner CLI yields no resume key.
        assert!(!argv_proves_uuid("claude", U), "bare argv proves no id");
    }

    #[test]
    fn argv_proof_accepts_only_an_explicit_claim_of_the_id() {
        const U: &str = "16eefe1f-d5a2-469a-ae38-769ae79f175c";
        assert!(argv_proves_uuid(&format!("claude --session-id {U}"), U));
        assert!(argv_proves_uuid(&format!("claude --session-id={U}"), U));
        assert!(argv_proves_uuid(&format!("claude --resume {U}"), U));
        assert!(argv_proves_uuid(&format!("claude --resume /a/b/{U}.jsonl"), U));
        assert!(!argv_proves_uuid("claude", U));
        assert!(!argv_proves_uuid("claude --session-id", U), "a dangling flag proves nothing");
        assert!(
            !argv_proves_uuid(&format!("claude --session-id 00000000-0000-4000-8000-{U}"), U),
            "a uuid must be the whole token, never a substring"
        );
        assert!(
            !argv_proves_uuid(&format!("claude --add-dir /logs/{U}-notes"), U),
            "the id must be claimed by an identity flag, not merely appear"
        );
        assert!(
            !argv_proves_uuid(&format!("claude -- --session-id {U}"), U),
            "after `--` the tokens are prompt text, not an assertion of ownership"
        );
        assert!(
            !argv_proves_uuid(&format!("claude --session-id /p/{U}.jsonl"), U),
            "--session-id takes a bare id; a path there proves nothing"
        );
    }

    /// Pid numbers are recycled. A claim's durable `last_pid` outlives its
    /// process, so ancestry alone — a test on a *number* — could hand a card to
    /// whichever pane happened to inherit that number.
    #[test]
    fn a_recycled_pid_under_a_pane_does_not_adopt_its_card() {
        let idle = procs(&[
            (100, 1, "/bin/zsh -l"),      // the pane, sitting at its prompt
            (777, 100, "/usr/bin/vim notes.md"), // …reusing a dead session's pid
        ]);
        let panes = [(7u64, 100u32)];
        assert_eq!(
            session_for_claim(&idle, &panes, 777),
            None,
            "no agent CLI on the path — the pid is a coincidence, not ownership"
        );

        // The same pid, this time genuinely beneath a claude in that pane.
        let real = procs(&[
            (100, 1, "/bin/zsh -l"),
            (500, 100, "claude"),
            (777, 500, "/bin/zsh -c ..."),
        ]);
        assert_eq!(session_for_claim(&real, &panes, 777), Some(7));
    }

    #[test]
    fn a_claim_binds_the_pane_its_process_actually_runs_inside() {
        let table = procs(&[
            (82600, 1, "tildone"),
            (15634, 82600, "/bin/zsh -l"), // hosted shell A (session 7)
            (16078, 15634, "claude"),
            (21264, 16078, "/bin/zsh -c ..."), // the tool shell the hook beats from
            (40000, 82600, "/bin/zsh -l"),     // hosted shell B (session 8)
            (40002, 40000, "claude"),          // …with its own agent
            (40001, 1, "claude"),              // an agent in no pane at all
        ]);
        let panes = [(7u64, 15634u32), (8, 40000)];
        assert_eq!(session_for_claim(&table, &panes, 21264), Some(7), "deep descendant binds");
        assert_eq!(session_for_claim(&table, &panes, 16078), Some(7));
        assert_eq!(session_for_claim(&table, &panes, 40002), Some(8));
        assert_eq!(session_for_claim(&table, &panes, 40001), None, "outsider binds nothing");
        assert_eq!(
            session_for_claim(&table, &panes, 40000),
            None,
            "the pane's own shell is not an agent — a claim never originates there"
        );
        assert_eq!(session_for_claim(&table, &[], 21264), None);
    }

    #[test]
    fn nested_panes_bind_the_innermost_one() {
        // A hosted shell whose agent opened another hosted shell: both are
        // ancestors of the claim, and the card belongs to the pane it is in.
        let table = procs(&[
            (100, 1, "/bin/zsh -l"),   // outer pane (session 1)
            (101, 100, "claude"),
            (102, 101, "/bin/zsh -l"), // inner pane (session 2)
            (103, 102, "claude"),
        ]);
        let panes = [(1u64, 100u32), (2, 102)];
        assert_eq!(session_for_claim(&table, &panes, 103), Some(2));
    }

    fn target(adapter_id: &'static str) -> BindTarget {
        BindTarget {
            session_id: 1,
            task_id: None,
            adapter_id,
            kind: "claude",
            dir: PathBuf::from("/home/.claude/projects/-w-proj"),
            pid: None,
            started_at: "2026-07-20T00:00:00Z".into(),
        }
    }

    #[test]
    fn an_unbound_shell_shortens_the_sweep_because_nothing_announces_a_cd() {
        let slow = sweep_interval(&[target("claude"), target("codex")]);
        let fast = sweep_interval(&[target("claude"), target("shell")]);
        assert!(fast < slow, "a shell must not wait a full slow sweep to bind");
        assert_eq!(fast, Duration::from_secs(5));
        // No targets at all is the idle case — coast.
        assert_eq!(sweep_interval(&[]), slow);
    }

    #[test]
    fn a_shell_that_already_has_its_card_stops_paying_the_fast_sweep() {
        // Since the card and the resume key were split, a shell can stay in the
        // watch set for life (a bare `claude` never proves a key). Only the
        // still-cardless one is urgent.
        let mut carded = target("shell");
        carded.task_id = Some(1);
        assert_eq!(sweep_interval(&[carded]), Duration::from_secs(60));
    }

    #[test]
    fn descent_reaches_grandchildren_and_survives_a_cyclic_snapshot() {
        let table = procs(&[(100, 1, "sh"), (101, 100, "sh"), (102, 101, "claude")]);
        assert!(descends_from(&table, 102, 100));
        assert!(!descends_from(&table, 100, 102));

        let cycle = procs(&[(1, 2, "a"), (2, 1, "b")]);
        assert!(!descends_from(&cycle, 1, 99));
    }
}
