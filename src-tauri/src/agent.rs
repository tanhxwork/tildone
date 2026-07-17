// MCP server exposing task/project management to external AI agents.
// Streamable HTTP on 127.0.0.1:AGENT_PORT, opt-in via the settings dialog.
// Opens its own SQLite connection to the same tildone.db the frontend uses;
// after every write it emits `agent-db-changed` so the UI reloads.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, ContentBlock, ServerCapabilities, ServerInfo},
    schemars,
    service::{NotificationContext, RequestContext},
    tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ErrorData, RoleServer, ServerHandler,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

pub const AGENT_PORT: u16 = 11502;

const STATUSES: [&str; 3] = ["todo", "doing", "done"];

/// Whether an agent's complete / blocked / needs-review write raises a native
/// notification. Written by `agent_set_notify` (the Settings toggle, which the
/// frontend also replays on startup), read by the notify_user closure per send.
/// Defaults on. Agent access being off means no server and no closure at all, so
/// this only gates the case where the server IS up but the user muted alerts.
static NOTIFY_USER_ENABLED: AtomicBool = AtomicBool::new(true);

/// Dense 0-based ordinal within (project, status), ordered exactly as the Kanban
/// column sorts: `position`, then `id`. Expressed as "count the tasks that sort
/// before this one" so it stays the *board* rank even when the caller filters by
/// tag or search — a window function over the result set would renumber from 0.
///
/// `x.project_id IS t.project_id` (not `=`) so the Inbox, where project_id is
/// NULL, forms one group per status instead of vanishing on NULL comparison.
///
/// Only meaningful within one (project, status) group: positions are not
/// comparable across projects. Requires the outer query to alias tasks as `t`.
const RANK_SQL: &str = "(SELECT COUNT(*) FROM tasks x
      WHERE x.deleted_at IS NULL
        AND x.status = t.status
        AND x.project_id IS t.project_id
        AND (x.position < t.position
             OR (x.position = t.position AND x.id < t.id)))";

// Mirrors COLOR_CHOICES in src/types.ts.
const COLOR_CHOICES: [&str; 8] = [
    "#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#64748b",
];

/// The endpoint is stored alongside the token because the port is not known
/// until bind time: a dev build asks the OS for a free one (see `requested_port`),
/// so nothing may assume it is `AGENT_PORT`.
#[derive(Default)]
pub struct AgentServer(Mutex<Option<(CancellationToken, String)>>);

/// Holds the menu-bar tray icon while the agent server is running. Dropping the
/// `TrayIcon` un-installs it from the menu bar, so `agent_server_stop` just clears
/// this. The tray is the only way back to the window once a close has hidden it,
/// so it lives exactly as long as the server does.
#[derive(Default)]
pub struct TrayHandle(Mutex<Option<tauri::tray::TrayIcon>>);

/// The live half of presence: who is beating right now, and a handle to read the
/// claims that give those beats a task.
///
/// Separate managed state rather than fields on `AgentServer` because it outlives a
/// stop/start cycle harmlessly — stale beats resolve to quiet on their own via the
/// PID check, so there is nothing to tear down.
#[derive(Default)]
pub struct AgentLive {
    beats: Beats,
    /// Set when the server starts. `None` → the server never ran, so there is no
    /// presence to report (not an error: the board simply shows none).
    db: Mutex<Option<Db>>,
}

type Db = Arc<Mutex<Connection>>;

/// Live heartbeat state, keyed by agent session id.
///
/// **Deliberately in memory, never SQLite.** A heartbeat fires on *every tool call
/// of every agent*. Persisting them would write to disk several times a second, and
/// — because the UI refreshes by answering `agent-db-changed` with a full
/// `fetchAll()` re-read of the whole database (App.tsx) — it would drag the entire
/// board through a reload just as often, getting worse with each agent added. The
/// feature would make the board slower the more agents you ran, which is backwards.
///
/// Presence is ambient status, not a record. Losing it on restart costs one beat's
/// latency; the `agent_claims` row that gives it meaning is the durable half.
pub type Beats = Arc<Mutex<HashMap<String, Beat>>>;

/// One session's last reported state.
#[derive(Clone, Debug)]
pub struct Beat {
    /// "working" | "blocked" | "idle" — as *reported* by the agent's hook, never
    /// inferred from silence. That inference is the bug: a five-minute build emits
    /// no tool calls, and guessing from the gap made a busy agent look departed.
    state: String,
    /// Monotonic, for the TTL. Never for display: a wall clock that jumps (NTP,
    /// sleep) must not be able to expire a live agent.
    at: std::time::Instant,
    /// Wall clock, for display only ("quiet 25m").
    at_iso: String,
    /// The session's OS process id (`$PPID` from the hook).
    ///
    /// Liveness has an exact answer when the agent runs on this machine, so we ask
    /// the OS rather than time out. `None` → we fall back to `LIVE_TTL`, which is
    /// the only reason that constant still exists.
    pid: Option<u32>,
}

/// One row of `agent_claims`, joined with the agent's latest log line.
#[derive(Clone, Debug)]
pub struct ClaimRow {
    session_id: String,
    task_id: i64,
    cwd: Option<String>,
    branch: Option<String>,
    agent_name: Option<String>,
    claimed_at: String,
    last_log: Option<String>,
}

/// What the card shows for one task.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct PresenceEntry {
    task_id: i64,
    agent_name: Option<String>,
    /// Already resolved to what the UI renders: "working" | "blocked" | "quiet".
    ///
    /// Resolved here rather than in the UI because the deciding fact — does that
    /// process still exist — is a question only the OS can answer. "idle" is a wire
    /// value from the hook and never reaches the UI; it resolves to "quiet".
    state: String,
    /// ISO timestamp behind "quiet 25m": the last beat if there was one, else the
    /// claim itself.
    at: String,
    branch: Option<String>,
    cwd: Option<String>,
    last_log: Option<String>,
}

/// Resolve claims + beats into one entry per task.
///
/// Pure, with process liveness injected, so the whole table below is testable
/// without spawning or killing anything.
///
/// | condition                       | card    |
/// |---------------------------------|---------|
/// | no beat for the session         | quiet   |
/// | beat has a pid, process is gone | quiet   | ← exact
/// | beat older than LIVE_TTL        | quiet   | ← backstop only
/// | beat says idle                  | quiet   |
/// | otherwise                       | working / blocked, as reported |
///
/// Several sessions may claim one task (pairing is legitimate), so a task shows the
/// liveliest state among them: working beats blocked beats quiet.
pub fn resolve_presence(
    claims: &[ClaimRow],
    beats: &HashMap<String, Beat>,
    now: std::time::Instant,
    alive: &dyn Fn(u32) -> bool,
) -> Vec<PresenceEntry> {
    fn rank(state: &str) -> u8 {
        match state {
            "working" => 2,
            "blocked" => 1,
            _ => 0,
        }
    }

    let mut by_task: HashMap<i64, PresenceEntry> = HashMap::new();
    for claim in claims {
        let beat = beats.get(&claim.session_id);
        let state = match beat {
            None => "quiet",
            Some(b) => {
                let dead = b.pid.map(|pid| !alive(pid)).unwrap_or(false);
                let stale = now.saturating_duration_since(b.at) > LIVE_TTL;
                if dead || stale || b.state == "idle" {
                    "quiet"
                } else {
                    b.state.as_str()
                }
            }
        };
        let entry = PresenceEntry {
            task_id: claim.task_id,
            agent_name: claim.agent_name.clone(),
            state: state.to_string(),
            at: beat
                .map(|b| b.at_iso.clone())
                .unwrap_or_else(|| claim.claimed_at.clone()),
            branch: claim.branch.clone(),
            cwd: claim.cwd.clone(),
            last_log: claim.last_log.clone(),
        };
        by_task
            .entry(claim.task_id)
            .and_modify(|existing| {
                if rank(&entry.state) > rank(&existing.state) {
                    *existing = entry.clone();
                }
            })
            .or_insert(entry);
    }
    let mut out: Vec<PresenceEntry> = by_task.into_values().collect();
    // Stable order so the UI never sees a task hop about between polls.
    out.sort_by_key(|e| e.task_id);
    out
}

/// Does that process still exist?
///
/// The exact answer to the question a timeout was only ever approximating. A
/// `kill -9`'d session has no process, so its card goes quiet at once rather than
/// claiming "working" until an arbitrary timer runs out.
fn pid_alive(pid: u32) -> bool {
    let pid = sysinfo::Pid::from_u32(pid);
    let mut sys = sysinfo::System::new();
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[pid]),
        true,
        sysinfo::ProcessRefreshKind::nothing(),
    );
    sys.process(pid).is_some()
}

/// Backstop for what the PID check cannot cover: PID reuse, or a beat with no pid.
///
/// Deliberately long, and deliberately not load-bearing. An earlier design made a
/// freshness timeout *the* liveness mechanism and had to be tuned against the user's
/// build times — a guess masquerading as a measurement. State is reported and death
/// is PID-checked; this is only a safety net.
const LIVE_TTL: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// Called after every successful write so the app UI can refresh.
type Notify = Arc<dyn Fn() + Send + Sync>;

/// Raise a native OS notification (title, body, task ref). A sibling of `Notify`,
/// built the same way in `agent_server_start`, but this one reaches the *user*, not
/// the UI. It lives on agent.rs and nowhere else on purpose: this write path is the
/// one place that knows — by construction, not inspection — that a change came from
/// an agent, so it is the only place that can alert without pinging the user for
/// their own edits. The ref (e.g. "TIL-42", None on legacy rows the backfill missed)
/// is what a click on the notification opens — see `send_user_notification`.
type NotifyUser = Arc<dyn Fn(&str, &str, Option<&str>) + Send + Sync>;

#[derive(Clone)]
struct TildoneAgent {
    #[allow(dead_code)] // read by the tool_handler macro
    tool_router: ToolRouter<Self>,
    db: Db,
    on_change: Notify,
    /// Raise a native notification to the user. See `NotifyUser`.
    notify_user: NotifyUser,
    /// Cancelled when the server stops. A parked `list_changes` selects on this,
    /// so stopping the server (or quitting the app) never has to wait out a
    /// 60-second long-poll.
    shutdown: CancellationToken,
}

// ---------------------------------------------------------------------------
// Helpers

fn now_iso() -> String {
    // Matches the JS side's new Date().toISOString() closely enough for
    // display/sorting (UTC, ISO 8601).
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let days = secs / 86400;
    let (y, m, d) = civil_from_days(days as i64);
    let rem = secs % 86400;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

// Howard Hinnant's civil-from-days algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Mirrors colorForName in src/store.ts (hash over UTF-16 code units).
fn color_for_name(name: &str) -> &'static str {
    let mut hash: i32 = 0;
    for unit in name.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    COLOR_CHOICES[hash.unsigned_abs() as usize % COLOR_CHOICES.len()]
}

fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

const LINK_KINDS: [&str; 5] = ["pr", "branch", "commit", "worktree", "other"];

/// Only http(s) links are clickable. The app opens a link with
/// tauri-plugin-opener, which hands the string to the OS to open with whatever
/// handles its scheme — so `file://`, `javascript:`, `mailto:` and custom app
/// schemes are a local-code-execution surface dressed as a convenience. Refuse
/// everything but http/https at the write boundary, so a bad link can never reach
/// the UI. The agent is trusted; "trusted" is not a reason to accept `file:///`.
fn valid_http_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    ["http://", "https://"]
        .iter()
        .any(|scheme| lower.strip_prefix(scheme).is_some_and(|rest| !rest.is_empty()))
}

/// The URL's last non-empty path segment — the default label when the caller
/// gives none (".../pull/12" -> "12", ".../tree/fix/x" -> "x").
fn link_label_from_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    trimmed
        .rsplit('/')
        .find(|s| !s.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

fn err(msg: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(msg.into())])
}

/// Drop object members whose value is null, recursively. Absent and null mean
/// the same thing to an MCP caller, and the nulls were pure token cost on
/// every response an agent reads.
fn strip_nulls(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|_, v| !v.is_null());
            for v in map.values_mut() {
                strip_nulls(v);
            }
        }
        Value::Array(items) => {
            for v in items {
                strip_nulls(v);
            }
        }
        _ => {}
    }
}

/// Serialized compact and null-stripped: pretty-printing plus null members
/// cost agents ~40% extra tokens on every read, measured on a live board.
fn ok_json(value: &Value) -> Result<CallToolResult, ErrorData> {
    let mut value = value.clone();
    strip_nulls(&mut value);
    let text = serde_json::to_string(&value).map_err(|e| {
        ErrorData::internal_error(format!("failed to serialize result: {e}"), None)
    })?;
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

fn ok_text(msg: impl Into<String>) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::success(vec![ContentBlock::text(msg.into())]))
}

/// Integer `format` tags schemars emits for Rust int types (i64 → "int64", …).
/// They are advisory only: no MCP client needs them, and serde parses the
/// concrete Rust param type regardless of what the advertised schema claims.
const INT_FORMATS: &[&str] = &[
    "int8", "int16", "int32", "int64", "int128", "uint", "uint8", "uint16", "uint32", "uint64",
    "uint128",
];

/// Strip wire-noise from a generated tool input schema that no MCP client uses:
/// the `$schema` dialect URL (~52 bytes per tool) and the advisory integer
/// `format` tags above. Recursive, so it reaches `$defs` and nested properties.
///
/// Purely cosmetic — it changes what a schema *advertises*, never how arguments
/// are parsed (that is serde over the Rust param type). The tool list is fixed
/// context every connected session carries verbatim for the whole session, so
/// this ~1.3KB of boilerplate is a token tax on every agent; trimming it once at
/// build hands that context back. Only integer formats are dropped — a semantic
/// string format like "date" or "uri" would be a real hint and is kept.
fn slim_tool_schema(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.remove("$schema");
            let drop_format = matches!(
                map.get("format"),
                Some(Value::String(f)) if INT_FORMATS.contains(&f.as_str())
            );
            if drop_format {
                map.remove("format");
            }
            for v in map.values_mut() {
                slim_tool_schema(v);
            }
        }
        Value::Array(items) => {
            for v in items {
                slim_tool_schema(v);
            }
        }
        _ => {}
    }
}

fn db_err(e: rusqlite::Error) -> ErrorData {
    ErrorData::internal_error(format!("database error: {e}"), None)
}

impl TildoneAgent {
    fn new(
        db: Db,
        on_change: Notify,
        notify_user: NotifyUser,
        shutdown: CancellationToken,
    ) -> Self {
        // The macro-generated tool list is fixed context every connected session
        // carries all session. Trim its wire-noise ($schema URLs, integer format
        // tags) once, here at build — see slim_tool_schema.
        let mut tool_router = Self::tool_router();
        for route in tool_router.map.values_mut() {
            let obj = Arc::make_mut(&mut route.attr.input_schema);
            let mut schema = Value::Object(std::mem::take(obj));
            slim_tool_schema(&mut schema);
            if let Value::Object(map) = schema {
                *obj = map;
            }
        }
        Self {
            tool_router,
            db,
            on_change,
            notify_user,
            shutdown,
        }
    }

    fn notify(&self) {
        (self.on_change)();
    }

    /// Resolve a project given by name, numeric id, or "inbox" (no project).
    fn resolve_project(
        conn: &Connection,
        spec: &str,
    ) -> Result<Result<Option<i64>, String>, rusqlite::Error> {
        let spec = spec.trim();
        if spec.is_empty() || spec.eq_ignore_ascii_case("inbox") {
            return Ok(Ok(None));
        }
        if spec.chars().all(|c| c.is_ascii_digit()) {
            let id: i64 = spec.parse().unwrap_or(-1);
            let exists: bool =
                conn.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)", [id], |r| {
                    r.get(0)
                })?;
            if exists {
                return Ok(Ok(Some(id)));
            }
        } else {
            let found: Option<i64> = conn
                .query_row(
                    "SELECT id FROM projects WHERE name = ?1 COLLATE NOCASE",
                    [spec],
                    |r| r.get(0),
                )
                .map(Some)
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other),
                })?;
            if let Some(id) = found {
                return Ok(Ok(Some(id)));
            }
        }
        let mut stmt = conn.prepare("SELECT name FROM projects ORDER BY position, id")?;
        let names: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<_, _>>()?;
        Ok(Err(format!(
            "Unknown project \"{spec}\". Existing projects: {}. Use \"inbox\" for no project, or create_project first.",
            if names.is_empty() { "(none)".to_string() } else { names.join(", ") }
        )))
    }

    /// The slot a task takes when it lands in the (project_id, status) group.
    ///
    /// `done` inserts at the TOP (MIN-1), the rest append at the BOTTOM (MAX+1):
    /// a Done column reads newest-first, a To Do column grows downwards.
    ///
    /// Top-insert deliberately does NOT renumber the group. Done grows without
    /// bound, so shifting every card down would cost an UPDATE per card on every
    /// completion and fire `changes_task_moved` for each one — waking every parked
    /// agent with the whole board, and getting slower the longer Done gets.
    /// Nothing requires positions to be a dense 0..N-1 index: they only have to be
    /// distinct and correctly ordered within the group (RANK_SQL counts the rows
    /// that sort before a task, and the Kanban just sorts by them). So the cheap
    /// move is to let `done` drift negative.
    fn group_slot(
        conn: &Connection,
        project_id: Option<i64>,
        status: &str,
    ) -> Result<i64, rusqlite::Error> {
        // COALESCE defaults are chosen so the first card of an empty group is 0.
        let sql = if status == "done" {
            "SELECT COALESCE(MIN(position), 1) - 1 FROM tasks
             WHERE deleted_at IS NULL AND status = ?1
               AND (project_id IS ?2 OR project_id = ?2)"
        } else {
            "SELECT COALESCE(MAX(position), -1) + 1 FROM tasks
             WHERE deleted_at IS NULL AND status = ?1
               AND (project_id IS ?2 OR project_id = ?2)"
        };
        conn.query_row(sql, rusqlite::params![status, project_id], |r| r.get(0))
    }

    /// Record one activity row **as an agent**.
    ///
    /// `actor_kind` is hard-coded `'agent'`, and that is the design rather than a
    /// shortcut: every path that reaches this function arrived over MCP, so this
    /// file *cannot* record a user write even by accident. `insertActivity`
    /// (src/db.ts) is its mirror and hard-codes `'user'` for the same reason.
    ///
    /// This is why attribution needs no trigger. `changes` uses triggers precisely
    /// because they catch writers that do not know the feed exists (that is what
    /// catches the drag). Attribution needs the opposite: a stamp applied by the one
    /// site that cannot be wrong about who it is.
    ///
    /// `agent` is the client's own name for itself and may be `None` when the
    /// handshake carried none — recorded as an unnamed agent, never as the user.
    fn record_activity(conn: &Connection, task_id: i64, label: &str, agent: Option<&str>) {
        let _ = conn.execute(
            "INSERT INTO task_activity (task_id, label, created_at, actor_kind, actor_name)
             VALUES (?1, ?2, ?3, 'agent', ?4)",
            rusqlite::params![task_id, label, now_iso(), agent],
        );
    }

    /// Bind an agent session to the task it is working on.
    ///
    /// There is no `claim_task` tool, and deliberately so: the board protocol already
    /// has the agent announce its task by moving it to Doing. A separate call would
    /// be a second declaration of the same fact at the same moment — and the second
    /// one is the one agents forget. So the claim rides the `doing` write.
    ///
    /// `session_id` is the PRIMARY KEY, so one session claims at most one task and a
    /// session moving on rebinds rather than duplicating. Several sessions may claim
    /// the same task: pairing is legitimate, and presence resolves to the liveliest.
    ///
    /// Recorded on every `doing` write carrying a session, not only on a *transition*
    /// to doing — an agent re-asserting the task it is on must refresh its claim, and
    /// a re-claim after an app restart is exactly how a card recovers.
    fn record_claim(
        conn: &Connection,
        session_id: &str,
        task_id: i64,
        cwd: Option<&str>,
        branch: Option<&str>,
        agent: Option<&str>,
    ) {
        // A claim is a nicety layered on the write; the status change is the user's
        // actual intent. Never let a claim failure fail the move — hence no `?`.
        let _ = conn.execute(
            "INSERT INTO agent_claims (session_id, task_id, cwd, branch, agent_name, claimed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(session_id) DO UPDATE SET
               task_id = excluded.task_id,
               cwd = excluded.cwd,
               branch = excluded.branch,
               agent_name = excluded.agent_name,
               claimed_at = excluded.claimed_at",
            rusqlite::params![session_id, task_id, cwd, branch, agent, now_iso()],
        );
    }

    /// Completing a task releases every claim on it.
    ///
    /// The one release signal worth trusting. Process-lifecycle events are not:
    /// `SessionEnd` does not fire on a crash, a `kill -9`, or a closed terminal, and
    /// background sessions outlive their terminal anyway. This is an explicit board
    /// write, so it means what it says.
    fn release_claims_for_task(conn: &Connection, task_id: i64) {
        let _ = conn.execute(
            "DELETE FROM agent_claims WHERE task_id = ?1",
            rusqlite::params![task_id],
        );
    }

    /// The calling MCP client's own name for itself (e.g. `claude-code`), from the
    /// `initialize` handshake.
    ///
    /// Only trustworthy because this server runs in rmcp's **stateful** mode:
    /// `StreamableHttpServerConfig::default()` sets `stateful_mode: true` and
    /// `server_config` does not override it. In stateless mode rmcp keeps no
    /// handshake and synthesises `client_info` from `Implementation::default()`,
    /// which is `from_build_env()` — *Tildone's own* name and version. That would
    /// not read as "unknown", it would read as a confident lie. So if this server
    /// ever moves to stateless, attribution must be switched off rather than left
    /// to fall back.
    fn client_name(ctx: &RequestContext<RoleServer>) -> Option<String> {
        let info = ctx.peer.peer_info()?;
        let name = info.client_info.name.trim();
        (!name.is_empty()).then(|| name.to_string())
    }

    /// Highest change id ever issued.
    ///
    /// Read from `sqlite_sequence`, **not** `MAX(id)`: the retention sweep deletes
    /// rows, and `MAX(id)` would then move *backwards* and hand out a cursor that
    /// replays history the agent already saw. AUTOINCREMENT keeps `seq` as a
    /// high-water mark that never decreases. The row is absent until the first
    /// insert, hence the COALESCE.
    fn changes_cursor(conn: &Connection) -> Result<i64, rusqlite::Error> {
        conn.query_row(
            "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'changes'), 0)",
            [],
            |r| r.get(0),
        )
    }

    /// One read of the feed: the cursor, plus everything after `since`.
    fn read_changes(conn: &Connection, since: Option<i64>) -> Result<Value, rusqlite::Error> {
        let cursor = Self::changes_cursor(conn)?;
        let Some(since) = since else {
            // Baseline: the agent gets a cursor to come back with, not a flood.
            return Ok(json!({"cursor": cursor, "changes": []}));
        };

        let rows: Vec<Value> = conn
            .prepare(
                "SELECT id, entity, entity_id, kind, created_at FROM changes
                 WHERE id > ?1 ORDER BY id",
            )?
            .query_map([since], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "entity": r.get::<_, String>(1)?,
                    "entity_id": r.get::<_, i64>(2)?,
                    "kind": r.get::<_, String>(3)?,
                    "created_at": r.get::<_, String>(4)?,
                }))
            })?
            .collect::<Result<_, _>>()?;

        // A cursor older than the retention horizon must not look like "nothing
        // happened". That failure is silent and shaped exactly like success: the
        // agent would trust a board it never re-read. Say so instead.
        let oldest: Option<i64> = conn.query_row("SELECT MIN(id) FROM changes", [], |r| r.get(0))?;
        let truncated = match oldest {
            Some(min) => since < min - 1,
            None => since < cursor,
        };

        let mut out = json!({"cursor": cursor, "changes": rows});
        if truncated {
            out["truncated"] = json!(true);
            out["note"] = json!(
                "Your cursor is older than the 30-day retention horizon, so some changes \
                 are gone. This list is incomplete — re-sync with list_tasks and continue \
                 from the returned cursor."
            );
        }
        Ok(out)
    }

    /// Retention: 30 days. ISO-8601 UTC sorts lexicographically, so a string
    /// compare is a date compare. Runs on call — no scheduler to own.
    fn prune_changes(conn: &Connection) -> Result<(), rusqlite::Error> {
        conn.execute(
            "DELETE FROM changes
             WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')",
            [],
        )?;
        Ok(())
    }

    /// `Some(trashed)` for an existing task, `None` when there is no such task.
    fn task_trashed(conn: &Connection, task_id: i64) -> Result<Option<bool>, rusqlite::Error> {
        conn.query_row(
            "SELECT deleted_at IS NOT NULL FROM tasks WHERE id = ?1",
            [task_id],
            |r| r.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
    }

    /// `(done, total)` for a task's subtasks — returned by every subtask write so
    /// the caller gets the new progress without a follow-up `get_task`.
    fn subtask_progress(conn: &Connection, task_id: i64) -> Result<(i64, i64), rusqlite::Error> {
        conn.query_row(
            "SELECT COALESCE(SUM(done), 0), COUNT(*) FROM subtasks WHERE task_id = ?1",
            [task_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
    }

    /// Subtasks titled "verify: …" (case-insensitive, whitespace after the colon)
    /// are the task's review checklist: proposed by the agent that flags
    /// needs-review, walked and ticked by the USER. The prefix IS the storage —
    /// keep this rule in step with VERIFY_PREFIX in src/types.ts.
    fn is_verify_title(title: &str) -> bool {
        let t = title.trim_start();
        match t.get(..7) {
            Some(p) if p.eq_ignore_ascii_case("verify:") => {
                t[7..].starts_with(char::is_whitespace)
            }
            _ => false,
        }
    }

    /// Resolve a subtask to `(parent task id, parent is trashed)`, or None when the
    /// subtask does not exist. Subtask writes refuse a trashed parent for the same
    /// reason `append_note` does: the task is not on the board to be worked.
    fn parent_task_of(
        conn: &Connection,
        subtask_id: i64,
    ) -> Result<Option<(i64, bool)>, rusqlite::Error> {
        conn.query_row(
            "SELECT t.id, t.deleted_at IS NOT NULL FROM subtasks s
             JOIN tasks t ON t.id = s.task_id WHERE s.id = ?1",
            [subtask_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
    }

    /// Find-or-create tags by name (case-insensitive) and link them to a task.
    ///
    /// Diff-aware, not rewrite-the-set: task_tags rows feed the change feed
    /// (migration 015), and row-level triggers fire per row actually touched.
    /// A DELETE-all + re-INSERT of an identical tag set would emit 2N phantom
    /// 'tag' changes; deleting only removed rows and INSERT OR IGNORE-ing
    /// additions makes an unchanged set touch zero rows and emit nothing.
    fn set_tags(conn: &Connection, task_id: i64, tags: &[String]) -> Result<(), rusqlite::Error> {
        let mut keep_ids: Vec<i64> = Vec::new();
        for raw in tags {
            let name = raw.trim();
            if name.is_empty() {
                continue;
            }
            let existing: Option<i64> = conn
                .query_row(
                    "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
                    [name],
                    |r| r.get(0),
                )
                .map(Some)
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other),
                })?;
            let tag_id = match existing {
                Some(id) => id,
                None => {
                    conn.execute(
                        "INSERT INTO tags (name, color) VALUES (?1, ?2)",
                        rusqlite::params![name, color_for_name(name)],
                    )?;
                    conn.last_insert_rowid()
                }
            };
            keep_ids.push(tag_id);
            conn.execute(
                "INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?1, ?2)",
                rusqlite::params![task_id, tag_id],
            )?;
        }
        if keep_ids.is_empty() {
            conn.execute("DELETE FROM task_tags WHERE task_id = ?1", [task_id])?;
            return Ok(());
        }
        let placeholders = keep_ids
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 2))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "DELETE FROM task_tags WHERE task_id = ?1 AND tag_id NOT IN ({placeholders})"
        );
        let mut params: Vec<&dyn rusqlite::ToSql> = vec![&task_id];
        params.extend(keep_ids.iter().map(|id| id as &dyn rusqlite::ToSql));
        conn.execute(&sql, params.as_slice())?;
        Ok(())
    }

    /// Receipt for a write: the id, plus the fields the caller could not have
    /// known before the write landed. Deliberately *not* the whole task —
    /// echoing back the notes blob the caller just sent doubled the cost of
    /// every update (one session: 46 writes sent 59KB and got 108KB back).
    /// `get_task` is the escape hatch when the full row is genuinely wanted.
    fn task_ack(conn: &Connection, id: i64) -> Result<Value, rusqlite::Error> {
        conn.query_row(
            "SELECT id, title, status, completed_at, ref FROM tasks WHERE id = ?1",
            [id],
            |r| {
                let mut ack = json!({
                    "id": r.get::<_, i64>(0)?,
                    "title": r.get::<_, String>(1)?,
                    "status": r.get::<_, String>(2)?,
                    "ref": r.get::<_, Option<String>>(4)?,
                });
                if let Some(completed) = r.get::<_, Option<String>>(3)? {
                    ack["completed_at"] = json!(completed);
                }
                Ok(ack)
            },
        )
    }

    fn task_json(conn: &Connection, id: i64) -> Result<Option<Value>, rusqlite::Error> {
        let row = conn
            .query_row(
                &format!(
                    "SELECT t.id, t.title, t.notes, t.status, t.priority, t.due_date,
                            t.created_at, t.completed_at, t.deleted_at, t.project_id, p.name,
                            CASE WHEN t.deleted_at IS NULL THEN {RANK_SQL} END, t.ref
                     FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
                     WHERE t.id = ?1"
                ),
                [id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "ref": r.get::<_, Option<String>>(12)?,
                        "title": r.get::<_, String>(1)?,
                        "notes": r.get::<_, String>(2)?,
                        "status": r.get::<_, String>(3)?,
                        "priority": r.get::<_, i64>(4)?,
                        "due_date": r.get::<_, Option<String>>(5)?,
                        "created_at": r.get::<_, String>(6)?,
                        "completed_at": r.get::<_, Option<String>>(7)?,
                        "in_trash": r.get::<_, Option<String>>(8)?.is_some(),
                        "project": match (r.get::<_, Option<i64>>(9)?, r.get::<_, Option<String>>(10)?) {
                            (Some(pid), Some(pname)) => json!({"id": pid, "name": pname}),
                            _ => Value::Null,
                        },
                        // null for a trashed task — it has no place on the board.
                        "rank": r.get::<_, Option<i64>>(11)?,
                    }))
                },
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        let Some(mut task) = row else { return Ok(None) };
        let mut stmt = conn.prepare(
            "SELECT tg.name FROM tags tg
             JOIN task_tags tt ON tt.tag_id = tg.id
             WHERE tt.task_id = ?1 ORDER BY tg.name",
        )?;
        let tags: Vec<String> = stmt
            .query_map([id], |r| r.get::<_, String>(0))?
            .collect::<Result<_, _>>()?;
        task["tags"] = json!(tags);
        Ok(Some(task))
    }

    /// Shared implementation for update_task / complete_task.
    #[allow(clippy::too_many_arguments)]
    fn apply_task_update(
        &self,
        task_ref: TaskRef,
        title: Option<String>,
        notes: Option<String>,
        status: Option<String>,
        priority: Option<i64>,
        due_date: Option<String>,
        project: Option<String>,
        tags: Option<Vec<String>>,
        agent: Option<&str>,
        claim: ClaimInfo,
    ) -> Result<CallToolResult, ErrorData> {
        let conn = self.db.lock().unwrap();
        let Some(id) = resolve_task_ref(&conn, &task_ref).map_err(db_err)? else {
            return Ok(err(format!("No task with reference {task_ref}.")));
        };
        let current: Option<(String, Option<i64>, Option<String>, String, Option<String>)> = conn
            .query_row(
                "SELECT status, project_id, deleted_at, title, ref FROM tasks WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map_err(db_err)?;
        let Some((old_status, old_project_id, deleted_at, db_title, db_ref)) = current else {
            return Ok(err(format!("No task with id {id}.")));
        };
        // The title a notification should name: the new one if this call changes it,
        // otherwise what's on the row.
        let mut notify_title = db_title;
        if deleted_at.is_some() {
            return Ok(err(format!(
                "Task {id} is in the trash; it can only be restored from the app."
            )));
        }

        let mut sets: Vec<String> = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut activity: Vec<String> = Vec::new();
        let push = |sets: &mut Vec<String>,
                        params: &mut Vec<Box<dyn rusqlite::types::ToSql>>,
                        col: &str,
                        v: Box<dyn rusqlite::types::ToSql>| {
            params.push(v);
            sets.push(format!("{col} = ?{}", params.len()));
        };

        if let Some(title) = title {
            let title = title.trim().to_string();
            if title.is_empty() {
                return Ok(err("title cannot be empty."));
            }
            notify_title = title.clone();
            push(&mut sets, &mut params, "title", Box::new(title));
        }
        if let Some(notes) = notes {
            push(&mut sets, &mut params, "notes", Box::new(notes));
        }
        // The destination group, when the task is changing group. `None` means
        // that axis is unchanged.
        let mut dest_status: Option<String> = None;
        let mut dest_project: Option<Option<i64>> = None;

        if let Some(status) = &status {
            if !STATUSES.contains(&status.as_str()) {
                return Ok(err("status must be one of: todo, doing, done."));
            }
            if *status != old_status {
                dest_status = Some(status.clone());
                push(&mut sets, &mut params, "status", Box::new(status.clone()));
                let completed: Option<String> =
                    (status == "done").then(now_iso);
                push(&mut sets, &mut params, "completed_at", Box::new(completed));
                activity.push(format!(
                    "Status changed to {}",
                    match status.as_str() {
                        "todo" => "To Do",
                        "doing" => "In Progress",
                        _ => "Done",
                    }
                ));
            }
        }
        if let Some(priority) = priority {
            if !(0..=3).contains(&priority) {
                return Ok(err("priority must be 0 (none), 1 (low), 2 (medium) or 3 (high)."));
            }
            push(&mut sets, &mut params, "priority", Box::new(priority));
            activity.push(if priority > 0 {
                format!(
                    "Priority set to {}",
                    ["", "Low", "Medium", "High"][priority as usize]
                )
            } else {
                "Priority cleared".to_string()
            });
        }
        if let Some(due) = due_date {
            let due = due.trim().to_string();
            if due.is_empty() {
                push(&mut sets, &mut params, "due_date", Box::new(None::<String>));
                activity.push("Due date cleared".to_string());
            } else if valid_date(&due) {
                activity.push(format!("Due date set to {due}"));
                push(&mut sets, &mut params, "due_date", Box::new(due));
            } else {
                return Ok(err("due_date must be YYYY-MM-DD (or \"\" to clear)."));
            }
        }
        if let Some(project) = project {
            let resolved = Self::resolve_project(&conn, &project).map_err(db_err)?;
            match resolved {
                Ok(pid) => {
                    activity.push(match pid {
                        Some(_) => format!("Moved to {}", project.trim()),
                        None => "Moved to Inbox".to_string(),
                    });
                    push(&mut sets, &mut params, "project_id", Box::new(pid));
                    if pid != old_project_id {
                        dest_project = Some(pid);
                    }
                }
                Err(msg) => return Ok(err(msg)),
            }
        }

        // A task that changes (project, status) group would otherwise carry its old
        // position into the new one, where it collides with whatever already holds
        // that slot — the column then falls back to sorting by id and the user's
        // manual order is silently lost. `create_task` has always asked for a slot;
        // nothing else did. Only recompute when the group actually changed: a Kanban
        // drag supplies its own positions and never comes through here.
        if dest_status.is_some() || dest_project.is_some() {
            let slot = Self::group_slot(
                &conn,
                dest_project.unwrap_or(old_project_id),
                dest_status.as_deref().unwrap_or(&old_status),
            )
            .map_err(db_err)?;
            push(&mut sets, &mut params, "position", Box::new(slot));
        }

        if !sets.is_empty() {
            let sql = format!(
                "UPDATE tasks SET {} WHERE id = ?{}",
                sets.join(", "),
                params.len() + 1
            );
            params.push(Box::new(id));
            conn.execute(&sql, rusqlite::params_from_iter(params.iter()))
                .map_err(db_err)?;
        }
        // Reserved-tag transitions, for notifications. Capture the pre-write tag set
        // so we alert only when blocked / needs-review is newly ADDED — never on a
        // rewrite of a task that already carried it. Same WHEN-guard lesson as the
        // change feed: a notification for a no-op is worse than a change row for one.
        let mut newly_blocked = false;
        let mut newly_needs_review = false;
        if let Some(tags) = &tags {
            let old_lower: std::collections::HashSet<String> = conn
                .prepare(
                    "SELECT LOWER(t.name) FROM tags t \
                     JOIN task_tags tt ON tt.tag_id = t.id WHERE tt.task_id = ?1",
                )
                .and_then(|mut s| {
                    s.query_map([id], |r| r.get::<_, String>(0))?
                        .collect::<Result<_, _>>()
                })
                .unwrap_or_default();
            let has = |name: &str| tags.iter().any(|t| t.trim().eq_ignore_ascii_case(name));
            newly_blocked = has("blocked") && !old_lower.contains("blocked");
            newly_needs_review = has("needs-review") && !old_lower.contains("needs-review");
        }
        // When this write blocks or flags the task, surface the freshest comment in the
        // notification body — an agent's flow is *comment the question, then tag blocked*,
        // so the newest comment is the ask itself. Read it while the connection is still
        // held (it is dropped just below). No comment → None, and the body falls back to
        // the bare task title. `.ok()` maps QueryReturnedNoRows to None.
        let latest_comment: Option<String> = if newly_blocked || newly_needs_review {
            conn.query_row(
                "SELECT body FROM comments WHERE task_id = ?1 ORDER BY id DESC LIMIT 1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .ok()
        } else {
            None
        };
        if let Some(tags) = tags {
            Self::set_tags(&conn, id, &tags).map_err(db_err)?;
        }
        // Mark the card unseen: an agent changed something the user needs to know
        // and has not looked at yet. The board renders it as the tilde held before
        // its check settles, and opening the card clears it.
        //
        // Agent-only for free, by the same construction the notifications below
        // rely on: this function is reachable only through the MCP server, so a
        // user's own drag (which writes SQLite directly) can never land here and
        // can never mark its own card. That is the whole point — if you moved it,
        // you saw it, and a mark you caused yourself is noise.
        //
        // Only a status change or a newly-added needs-review earns it. Not notes,
        // not log_progress, not subtask ticks: those are progress, not a question,
        // and the card already carries a progress bar for them.
        //
        // Safe for the changes feed by column, not by luck: no trigger in
        // 005_changes.sql watches `unseen_at`, and this SET touches nothing else,
        // so an agent parked in list_changes(wait_ms) is not woken by a mark.
        if dest_status.is_some() || newly_needs_review {
            conn.execute(
                "UPDATE tasks SET unseen_at = ?1 WHERE id = ?2",
                rusqlite::params![now_iso(), id],
            )
            .map_err(db_err)?;
        }
        // The claim rides this write. Keyed on `status`, not `dest_status`: the latter
        // is only set when the status *changes*, but an agent re-asserting the task it
        // is already on must still refresh its claim — that re-claim is how a card
        // recovers after Tildone restarts.
        match status.as_deref() {
            Some("doing") => {
                if let Some(session) = claim.session() {
                    Self::record_claim(
                        &conn,
                        session,
                        id,
                        claim.cwd.as_deref(),
                        claim.branch.as_deref(),
                        agent,
                    );
                }
            }
            Some("done") => Self::release_claims_for_task(&conn, id),
            _ => {}
        }
        for label in &activity {
            Self::record_activity(&conn, id, label, agent);
        }
        let ack = Self::task_ack(&conn, id).map_err(db_err)?;
        drop(conn);
        self.notify();

        // Notify the user of the three moments an agent needs them and they don't
        // know it yet. Agent-only by construction: apply_task_update is reachable
        // only through the MCP server (the UI writes SQLite directly), so a write
        // here always came from an agent — the user's own drag to Done never lands
        // here and never notifies. Only transitions, computed above.
        // Every body leads with the task ref ("TIL-42 · {task}") — the name the user
        // and their agents call the card everywhere else, so the banner is quotable
        // even unclicked. Blocked / needs-review append the newest comment
        // ("… — {question}") so the banner holds the ask itself; without one they
        // fall back to the titled ref. Done raises no question to read.
        let titled = match db_ref.as_deref() {
            Some(r) => format!("{r} · {notify_title}"),
            None => notify_title.clone(),
        };
        let flagged_body = || match latest_comment.as_deref().map(str::trim) {
            Some(c) if !c.is_empty() => {
                // Cap the comment so a long reply can't turn the banner into a wall of
                // text; the OS truncates too, but a clean ellipsis reads better.
                let snippet = if c.chars().count() > 140 {
                    format!("{}…", c.chars().take(139).collect::<String>().trim_end())
                } else {
                    c.to_string()
                };
                format!("{titled} — {snippet}")
            }
            _ => titled.clone(),
        };
        let mut notifications: Vec<(&str, String)> = Vec::new();
        if dest_status.as_deref() == Some("done") {
            notifications.push(("Task done", titled.clone()));
        }
        if newly_blocked {
            notifications.push(("Blocked", flagged_body()));
        }
        if newly_needs_review {
            notifications.push(("Needs review", flagged_body()));
        }
        for (title, body) in notifications {
            (self.notify_user)(title, &body, db_ref.as_deref());
        }
        ok_json(&ack)
    }
}

// ---------------------------------------------------------------------------
// Task references — CODE-N (e.g. "TIL-3"). See docs/specs/2026-07-16-per-project-task-ref.md.
//
// The code-derivation here mirrors src/utils/ref.ts byte-for-byte: the frontend
// store and this MCP server both create projects/tasks straight into SQLite, so an
// identical code must come out either way. Keep the two in lockstep.

/// Reserved code for tasks with no project (the Inbox).
const INBOX_CODE: &str = "INBOX";

/// A task identifier from an MCP client: the numeric DB id (back-compat) or the
/// frozen "CODE-N" reference string. Untagged so a JSON number deserialises to
/// `Id` and a JSON string to `Ref`; the derived JsonSchema advertises both.
/// The schemars description overrides this doc comment on the wire — the doc
/// is for Rust readers, and shipping it in every tool's $defs cost each
/// connected session ~2KB of schema.
#[derive(Debug, Clone, serde::Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
#[schemars(description = "Task id (number) or ref string like \"TIL-3\"")]
enum TaskRef {
    Id(i64),
    Ref(String),
}

impl std::fmt::Display for TaskRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TaskRef::Id(n) => write!(f, "{n}"),
            TaskRef::Ref(s) => write!(f, "{s}"),
        }
    }
}

impl From<i64> for TaskRef {
    fn from(n: i64) -> Self {
        TaskRef::Id(n)
    }
}

/// One row-id lookup that maps QueryReturnedNoRows to None (the codebase's
/// established pattern, avoiding an OptionalExtension import).
fn task_id_by(
    conn: &Connection,
    sql: &str,
    param: &dyn rusqlite::types::ToSql,
) -> Result<Option<i64>, rusqlite::Error> {
    conn.query_row(sql, [param], |row| row.get::<_, i64>(0))
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
}

/// Resolve a client identifier to a task row id (None when nothing matches). A
/// string of pure digits is still treated as an id, so a client that quotes the
/// numeric id as a string keeps working.
fn resolve_task_ref(conn: &Connection, r: &TaskRef) -> Result<Option<i64>, rusqlite::Error> {
    match r {
        TaskRef::Id(n) => task_id_by(conn, "SELECT id FROM tasks WHERE id = ?1", n),
        TaskRef::Ref(s) => {
            let t = s.trim();
            match t.parse::<i64>() {
                Ok(n) => task_id_by(conn, "SELECT id FROM tasks WHERE id = ?1", &n),
                Err(_) => task_id_by(conn, "SELECT id FROM tasks WHERE ref = ?1 COLLATE NOCASE", &t),
            }
        }
    }
}

/// Uppercase alphanumeric words of a project name. Mirrors `words` in ref.ts.
fn code_words(name: &str) -> Vec<String> {
    name.to_uppercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// Base (pre-uniqueness) code: initials for a multi-word name, the first three
/// characters for a single word, "PRJ" for a name with no alphanumerics. Mirrors
/// `baseProjectCode` in ref.ts.
fn base_project_code(name: &str) -> String {
    let ws = code_words(name);
    if ws.is_empty() {
        return "PRJ".to_string();
    }
    if ws.len() == 1 {
        return ws[0].chars().take(3).collect();
    }
    ws.iter().filter_map(|w| w.chars().next()).take(4).collect()
}

/// A unique code for `name` given the codes already taken (uppercase). On collision,
/// append the smallest integer suffix that is free. Mirrors `deriveProjectCode`.
fn derive_project_code(name: &str, taken: &std::collections::HashSet<String>) -> String {
    let base = base_project_code(name);
    if !taken.contains(&base) {
        return base;
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base}{n}");
        if !taken.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Codes already in use (plus the reserved INBOX_CODE) — the authoritative set the
/// UNIQUE index on projects.code backs up.
fn taken_project_codes(
    conn: &Connection,
) -> Result<std::collections::HashSet<String>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT code FROM projects WHERE code IS NOT NULL")?;
    let mut set: std::collections::HashSet<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<_, _>>()?;
    set.insert(INBOX_CODE.to_string());
    Ok(set)
}

/// The code that mints refs for a task in `project_id` (INBOX_CODE for the Inbox).
/// A project still lacking a code — a race ahead of the frontend backfill — gets one
/// minted and persisted here so its tasks never fall back to the raw id.
fn code_for_project(conn: &Connection, project_id: Option<i64>) -> Result<String, rusqlite::Error> {
    let Some(pid) = project_id else {
        return Ok(INBOX_CODE.to_string());
    };
    let row: Option<(String, Option<String>)> = conn
        .query_row("SELECT name, code FROM projects WHERE id = ?1", [pid], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    let Some((name, code)) = row else {
        return Ok(INBOX_CODE.to_string());
    };
    if let Some(code) = code {
        return Ok(code);
    }
    let taken = taken_project_codes(conn)?;
    let code = derive_project_code(&name, &taken);
    conn.execute("UPDATE projects SET code = ?1 WHERE id = ?2", rusqlite::params![code, pid])?;
    Ok(code)
}

/// Next per-code counter: one past the highest `number` any task with this code's
/// ref prefix has ever held (trashed rows included). Scoped by the frozen ref, not
/// project_id, so a task moved between projects keeps counting against its birth code.
fn next_task_number(conn: &Connection, code: &str) -> Result<i64, rusqlite::Error> {
    let max: Option<i64> = conn.query_row(
        "SELECT MAX(number) FROM tasks WHERE ref LIKE ?1",
        [format!("{code}-%")],
        |r| r.get(0),
    )?;
    Ok(max.unwrap_or(0) + 1)
}

// ---------------------------------------------------------------------------
// Tool parameter types

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct CreateProjectParams {
    #[schemars(description = "Project name (must not already exist)")]
    name: String,
    #[schemars(description = "Hex color like #6366f1; a color is picked automatically if omitted")]
    color: Option<String>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct UpdateProjectParams {
    id: i64,
    #[schemars(description = "New project name")]
    name: Option<String>,
    #[schemars(description = "New hex color like #6366f1")]
    color: Option<String>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct IdParams {
    id: i64,
}

/// A task identifier for a task-scoped tool: the numeric id or a "CODE-N" ref.
#[derive(serde::Deserialize, schemars::JsonSchema)]
struct TaskIdParams {
    id: TaskRef,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct AppendNoteParams {
    id: TaskRef,
    #[schemars(description = "Text to append. A newline is inserted first when the notes are not already empty or newline-terminated.")]
    text: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct AddSubtaskParams {
    task_id: TaskRef,
    title: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct ListChangesParams {
    #[schemars(
        description = "Return changes newer than this cursor. Omit on the first call to get the current cursor and an empty list — a baseline, not the whole history."
    )]
    since: Option<i64>,
    #[schemars(
        description = "Block up to this many milliseconds waiting for a change before returning (max 60000). Omit or 0 to return immediately. Ignored when `since` is omitted."
    )]
    wait_ms: Option<i64>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct LogProgressParams {
    task_id: TaskRef,
    #[schemars(
        description = "One short, factual line in the present tense — e.g. \"tests written (RED, 5 failing)\""
    )]
    text: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct SetSubtaskParams {
    #[schemars(description = "Id of the subtask itself, not of its parent task")]
    id: i64,
    #[schemars(description = "Tick (true) or untick (false) the subtask")]
    done: Option<bool>,
    #[schemars(description = "Rename the subtask")]
    title: Option<String>,
}

#[derive(serde::Deserialize, schemars::JsonSchema, Default)]
struct ListTasksParams {
    #[schemars(description = "Filter by project name or id, or \"inbox\" for tasks with no project. Omit for all tasks.")]
    project: Option<String>,
    #[schemars(description = "Filter by status: todo, doing or done")]
    status: Option<String>,
    #[schemars(description = "Only tasks due on or before this date (YYYY-MM-DD)")]
    due_before: Option<String>,
    #[schemars(description = "Filter by tag name")]
    tag: Option<String>,
    #[schemars(description = "Case-insensitive substring match on title and notes")]
    search: Option<String>,
    #[schemars(description = "Include completed tasks (default false; ignored when status is \"done\")")]
    include_done: Option<bool>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct CreateTaskParams {
    title: String,
    #[schemars(description = "Project name or id; omit or \"inbox\" for no project. Must already exist — use create_project first for a new one.")]
    project: Option<String>,
    #[schemars(description = "Free-form notes / description")]
    notes: Option<String>,
    #[schemars(description = "Due date YYYY-MM-DD")]
    due_date: Option<String>,
    #[schemars(description = "0 none (default), 1 low, 2 medium, 3 high")]
    priority: Option<i64>,
    #[schemars(description = "Tag names; unknown tags are created automatically")]
    tags: Option<Vec<String>>,
    #[schemars(description = "todo (default), doing or done")]
    status: Option<String>,
    #[schemars(
        description = "Your CLAUDE_CODE_SESSION_ID env var; send with status \"doing\" to claim the task. Omit if not a live session."
    )]
    session_id: Option<String>,
    #[schemars(description = "Checkout/worktree path, shown as a chip; only with session_id")]
    cwd: Option<String>,
    #[schemars(description = "Git branch, shown as a chip; only with session_id")]
    branch: Option<String>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct UpdateTaskParams {
    id: TaskRef,
    title: Option<String>,
    notes: Option<String>,
    #[schemars(description = "todo, doing or done")]
    status: Option<String>,
    #[schemars(description = "0 none, 1 low, 2 medium, 3 high")]
    priority: Option<i64>,
    #[schemars(description = "Due date YYYY-MM-DD, or \"\" to clear it")]
    due_date: Option<String>,
    #[schemars(description = "Project name or id, or \"inbox\" to move out of any project")]
    project: Option<String>,
    #[schemars(description = "Replaces the full tag list; unknown tags are created automatically")]
    tags: Option<Vec<String>>,
    #[schemars(
        description = "Your CLAUDE_CODE_SESSION_ID env var; send with status \"doing\" to claim the task. Omit if not a live session."
    )]
    session_id: Option<String>,
    #[schemars(description = "Checkout/worktree path, shown as a chip; only with session_id")]
    cwd: Option<String>,
    #[schemars(description = "Git branch, shown as a chip; only with session_id")]
    branch: Option<String>,
}

/// Who is working on a task, sent by a live agent alongside a `doing` write.
///
/// Grouped rather than passed as three more positional arguments: `apply_task_update`
/// already takes nine, and three more anonymous `Option<String>`s in a row is a
/// swap-two-and-nobody-notices bug waiting to happen.
#[derive(Default)]
struct ClaimInfo {
    /// The agent's session id. Without it there is no claim: this is the identity.
    session_id: Option<String>,
    /// Label only — never identity. cwd is not unique per session (read-only
    /// sessions share the main checkout), which is why it cannot be the key.
    cwd: Option<String>,
    branch: Option<String>,
}

impl ClaimInfo {
    /// The claim to record, if this write carries one at all.
    fn session(&self) -> Option<&str> {
        self.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct AddLinkParams {
    #[schemars(description = "Task to attach the link to")]
    task_id: TaskRef,
    #[schemars(description = "The URL to open. Must be http(s) — other schemes are refused.")]
    url: String,
    #[schemars(
        description = "What to show on the chip (e.g. \"PR #12\", a branch name, a short SHA). Defaults to the URL's last path segment."
    )]
    label: Option<String>,
    #[schemars(description = "One of: pr, branch, commit, worktree, other. Defaults to other.")]
    kind: Option<String>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct AddCommentParams {
    #[schemars(description = "Task to comment on")]
    task_id: TaskRef,
    #[schemars(description = "The comment text. Ask a question here when blocked; the user answers with another comment and you wake via list_changes.")]
    body: String,
}

// ---------------------------------------------------------------------------
// Tools

#[tool_router]
impl TildoneAgent {
    #[tool(description = "List all projects with open/done task counts. Tasks can also live outside any project (the Inbox).")]
    fn list_projects(&self) -> Result<CallToolResult, ErrorData> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT p.id, p.name, p.color,
                    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status <> 'done'),
                    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status = 'done')
                 FROM projects p ORDER BY p.position, p.id",
            )
            .map_err(db_err)?;
        let projects: Vec<Value> = stmt
            .query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "color": r.get::<_, String>(2)?,
                    "open_tasks": r.get::<_, i64>(3)?,
                    "done_tasks": r.get::<_, i64>(4)?,
                }))
            })
            .map_err(db_err)?
            .collect::<Result<_, _>>()
            .map_err(db_err)?;
        ok_json(&json!(projects))
    }

    #[tool(description = "Create a new project.")]
    fn create_project(
        &self,
        Parameters(CreateProjectParams { name, color }): Parameters<CreateProjectParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Ok(err("name cannot be empty."));
        }
        let conn = self.db.lock().unwrap();
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE name = ?1 COLLATE NOCASE)",
                [&name],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if exists {
            return Ok(err(format!("A project named \"{name}\" already exists.")));
        }
        let color = color.unwrap_or_else(|| color_for_name(&name).to_string());
        let taken = taken_project_codes(&conn).map_err(db_err)?;
        let code = derive_project_code(&name, &taken);
        conn.execute(
            "INSERT INTO projects (name, color, position, created_at, code)
             VALUES (?1, ?2, (SELECT COALESCE(MAX(position), -1) + 1 FROM projects), ?3, ?4)",
            rusqlite::params![name, color, now_iso(), code],
        )
        .map_err(db_err)?;
        let id = conn.last_insert_rowid();
        drop(conn);
        self.notify();
        ok_json(&json!({"id": id, "name": name, "color": color, "code": code}))
    }

    #[tool(description = "Rename a project or change its color.")]
    fn update_project(
        &self,
        Parameters(UpdateProjectParams { id, name, color }): Parameters<UpdateProjectParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let conn = self.db.lock().unwrap();
        let exists: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)", [id], |r| r.get(0))
            .map_err(db_err)?;
        if !exists {
            return Ok(err(format!("No project with id {id}. Use list_projects.")));
        }
        if let Some(name) = &name {
            if name.trim().is_empty() {
                return Ok(err("name cannot be empty."));
            }
            conn.execute(
                "UPDATE projects SET name = ?1 WHERE id = ?2",
                rusqlite::params![name.trim(), id],
            )
            .map_err(db_err)?;
        }
        if let Some(color) = &color {
            conn.execute(
                "UPDATE projects SET color = ?1 WHERE id = ?2",
                rusqlite::params![color, id],
            )
            .map_err(db_err)?;
        }
        drop(conn);
        self.notify();
        ok_text(format!("Project {id} updated."))
    }

    #[tool(description = "Permanently delete a project AND all tasks inside it. Destructive and irreversible — confirm with the user first.")]
    fn delete_project(
        &self,
        Parameters(IdParams { id }): Parameters<IdParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let conn = self.db.lock().unwrap();
        let name: Option<String> = conn
            .query_row("SELECT name FROM projects WHERE id = ?1", [id], |r| r.get(0))
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map_err(db_err)?;
        let Some(name) = name else {
            return Ok(err(format!("No project with id {id}.")));
        };
        conn.execute("DELETE FROM projects WHERE id = ?1", [id])
            .map_err(db_err)?;
        drop(conn);
        self.notify();
        ok_text(format!("Project \"{name}\" and its tasks were deleted."))
    }

    #[tool(description = "List tasks, optionally filtered. By default completed and trashed tasks are excluded.")]
    fn list_tasks(
        &self,
        Parameters(p): Parameters<ListTasksParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let conn = self.db.lock().unwrap();
        let mut wheres = vec!["t.deleted_at IS NULL".to_string()];
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(project) = &p.project {
            match Self::resolve_project(&conn, project).map_err(db_err)? {
                Ok(Some(pid)) => {
                    params.push(Box::new(pid));
                    wheres.push(format!("t.project_id = ?{}", params.len()));
                }
                Ok(None) => wheres.push("t.project_id IS NULL".to_string()),
                Err(msg) => return Ok(err(msg)),
            }
        }
        match &p.status {
            Some(status) => {
                if !STATUSES.contains(&status.as_str()) {
                    return Ok(err("status must be one of: todo, doing, done."));
                }
                params.push(Box::new(status.clone()));
                wheres.push(format!("t.status = ?{}", params.len()));
            }
            None => {
                if !p.include_done.unwrap_or(false) {
                    wheres.push("t.status <> 'done'".to_string());
                }
            }
        }
        if let Some(due) = &p.due_before {
            if !valid_date(due) {
                return Ok(err("due_before must be YYYY-MM-DD."));
            }
            params.push(Box::new(due.clone()));
            wheres.push(format!("t.due_date IS NOT NULL AND t.due_date <= ?{}", params.len()));
        }
        if let Some(tag) = &p.tag {
            params.push(Box::new(tag.trim().to_string()));
            wheres.push(format!(
                "EXISTS (SELECT 1 FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id
                         WHERE tt.task_id = t.id AND tg.name = ?{} COLLATE NOCASE)",
                params.len()
            ));
        }
        if let Some(q) = &p.search {
            params.push(Box::new(format!("%{}%", q.trim())));
            let n = params.len();
            wheres.push(format!("(t.title LIKE ?{n} OR t.notes LIKE ?{n})"));
        }

        // Board order, not due order: the first task an agent sees is the top
        // card of its column, so "work the top task first" means rank 0. Due
        // date used to lead here, which made the first result the most overdue
        // task instead — `due_before` is how a caller asks for that now.
        let sql = format!(
            "SELECT t.id, t.title, t.status, t.priority, t.due_date, t.completed_at, p.name,
                    (SELECT GROUP_CONCAT(tg.name, ', ') FROM tags tg
                     JOIN task_tags tt ON tt.tag_id = tg.id WHERE tt.task_id = t.id),
                    {RANK_SQL}, t.ref
             FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
             WHERE {}
             ORDER BY p.position, t.position, t.id",
            wheres.join(" AND ")
        );
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let tasks: Vec<Value> = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "ref": r.get::<_, Option<String>>(9)?,
                    "title": r.get::<_, String>(1)?,
                    "status": r.get::<_, String>(2)?,
                    "priority": r.get::<_, i64>(3)?,
                    "due_date": r.get::<_, Option<String>>(4)?,
                    "completed_at": r.get::<_, Option<String>>(5)?,
                    "project": r.get::<_, Option<String>>(6)?,
                    "tags": r.get::<_, Option<String>>(7)?,
                    "rank": r.get::<_, i64>(8)?,
                }))
            })
            .map_err(db_err)?
            .collect::<Result<_, _>>()
            .map_err(db_err)?;
        ok_json(&json!({"count": tasks.len(), "tasks": tasks}))
    }

    #[tool(description = "Get one task with full details (notes, tags, subtasks).")]
    fn get_task(
        &self,
        Parameters(TaskIdParams { id: task_ref }): Parameters<TaskIdParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let conn = self.db.lock().unwrap();
        let Some(id) = resolve_task_ref(&conn, &task_ref).map_err(db_err)? else {
            return Ok(err(format!("No task with reference {task_ref}.")));
        };
        let Some(mut task) = Self::task_json(&conn, id).map_err(db_err)? else {
            return Ok(err(format!("No task with reference {task_ref}.")));
        };
        let mut stmt = conn
            .prepare("SELECT id, title, done FROM subtasks WHERE task_id = ?1 ORDER BY position, id")
            .map_err(db_err)?;
        let subtasks: Vec<Value> = stmt
            .query_map([id], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "title": r.get::<_, String>(1)?,
                    "done": r.get::<_, i64>(2)? != 0,
                }))
            })
            .map_err(db_err)?
            .collect::<Result<_, _>>()
            .map_err(db_err)?;
        task["subtasks"] = json!(subtasks);
        let mut link_stmt = conn
            .prepare("SELECT id, url, label, kind FROM task_links WHERE task_id = ?1 ORDER BY id")
            .map_err(db_err)?;
        let links: Vec<Value> = link_stmt
            .query_map([id], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "url": r.get::<_, String>(1)?,
                    "label": r.get::<_, String>(2)?,
                    "kind": r.get::<_, String>(3)?,
                }))
            })
            .map_err(db_err)?
            .collect::<Result<_, _>>()
            .map_err(db_err)?;
        task["links"] = json!(links);
        let mut comment_stmt = conn
            .prepare(
                "SELECT id, body, actor_kind, actor_name, created_at FROM comments WHERE task_id = ?1 ORDER BY id",
            )
            .map_err(db_err)?;
        let comments: Vec<Value> = comment_stmt
            .query_map([id], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "body": r.get::<_, String>(1)?,
                    "actor_kind": r.get::<_, String>(2)?,
                    "actor_name": r.get::<_, Option<String>>(3)?,
                    "created_at": r.get::<_, String>(4)?,
                }))
            })
            .map_err(db_err)?
            .collect::<Result<_, _>>()
            .map_err(db_err)?;
        task["comments"] = json!(comments);
        ok_json(&task)
    }

    #[tool(description = "Create a task. Without a project it goes to the Inbox.")]
    fn create_task(
        &self,
        Parameters(p): Parameters<CreateTaskParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.create_task_as(p, Self::client_name(&ctx).as_deref())
    }

    fn create_task_as(
        &self,
        p: CreateTaskParams,
        agent: Option<&str>,
    ) -> Result<CallToolResult, ErrorData> {
        let title = p.title.trim().to_string();
        if title.is_empty() {
            return Ok(err("title cannot be empty."));
        }
        let status = p.status.unwrap_or_else(|| "todo".to_string());
        if !STATUSES.contains(&status.as_str()) {
            return Ok(err("status must be one of: todo, doing, done."));
        }
        let priority = p.priority.unwrap_or(0);
        if !(0..=3).contains(&priority) {
            return Ok(err("priority must be 0 (none), 1 (low), 2 (medium) or 3 (high)."));
        }
        let due_date = match p.due_date.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(d) if valid_date(d) => Some(d.to_string()),
            Some(_) => return Ok(err("due_date must be YYYY-MM-DD.")),
        };

        let conn = self.db.lock().unwrap();
        let project_id = match &p.project {
            None => None,
            Some(spec) => match Self::resolve_project(&conn, spec).map_err(db_err)? {
                Ok(pid) => pid,
                Err(msg) => return Ok(err(msg)),
            },
        };
        let position = Self::group_slot(&conn, project_id, &status).map_err(db_err)?;
        let completed_at: Option<String> = (status == "done").then(now_iso);
        // Mint the frozen ref from the task's project code; the counter is scoped to
        // that code, so numbers stay small and per-project. See code_for_project.
        let code = code_for_project(&conn, project_id).map_err(db_err)?;
        let number = next_task_number(&conn, &code).map_err(db_err)?;
        let task_ref = format!("{code}-{number}");
        conn.execute(
            "INSERT INTO tasks (project_id, title, notes, status, priority, due_date, position, completed_at, created_at, number, ref)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![
                project_id,
                title,
                p.notes.unwrap_or_default(),
                status,
                priority,
                due_date,
                position,
                completed_at,
                now_iso(),
                number,
                task_ref
            ],
        )
        .map_err(db_err)?;
        let id = conn.last_insert_rowid();
        if let Some(tags) = &p.tags {
            Self::set_tags(&conn, id, tags).map_err(db_err)?;
        }
        // A task created straight into Doing is an agent starting work in one call;
        // the claim rides it exactly as it rides an update.
        if status == "doing" {
            let claim = ClaimInfo {
                session_id: p.session_id,
                cwd: p.cwd,
                branch: p.branch,
            };
            if let Some(session) = claim.session() {
                Self::record_claim(
                    &conn,
                    session,
                    id,
                    claim.cwd.as_deref(),
                    claim.branch.as_deref(),
                    agent,
                );
            }
        }
        Self::record_activity(&conn, id, "Task created", agent);
        let ack = Self::task_ack(&conn, id).map_err(db_err)?;
        drop(conn);
        self.notify();
        ok_json(&ack)
    }

    #[tool(description = "Update fields of a task. Only the provided fields change.")]
    fn update_task(
        &self,
        Parameters(p): Parameters<UpdateTaskParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.update_task_as(p, Self::client_name(&ctx).as_deref())
    }

    fn update_task_as(
        &self,
        p: UpdateTaskParams,
        agent: Option<&str>,
    ) -> Result<CallToolResult, ErrorData> {
        let claim = ClaimInfo { session_id: p.session_id, cwd: p.cwd, branch: p.branch };
        self.apply_task_update(
            p.id, p.title, p.notes, p.status, p.priority, p.due_date, p.project, p.tags, agent,
            claim,
        )
    }

    #[tool(
        description = "Append text to a task's notes. Prefer this over update_task for progress logs: it cannot destroy existing notes, and it costs the same no matter how long the notes already are."
    )]
    fn append_note(
        &self,
        Parameters(AppendNoteParams { id: task_ref, text }): Parameters<AppendNoteParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let conn = self.db.lock().unwrap();
        let Some(id) = resolve_task_ref(&conn, &task_ref).map_err(db_err)? else {
            return Ok(err(format!("No task with reference {task_ref}.")));
        };
        let current = conn
            .query_row(
                "SELECT notes, deleted_at FROM tasks WHERE id = ?1",
                [id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map_err(db_err)?;
        let Some((notes, deleted_at)) = current else {
            return Ok(err(format!("No task with reference {task_ref}.")));
        };
        if deleted_at.is_some() {
            return Ok(err(format!(
                "Task {task_ref} is in the trash; it can only be restored from the app."
            )));
        }
        let separator = if notes.is_empty() || notes.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        let updated = format!("{notes}{separator}{text}");
        conn.execute(
            "UPDATE tasks SET notes = ?1 WHERE id = ?2",
            rusqlite::params![updated, id],
        )
        .map_err(db_err)?;
        let mut ack = Self::task_ack(&conn, id).map_err(db_err)?;
        // Size hint instead of the notes themselves — confirms the append
        // landed without shipping the blob back.
        ack["notes_chars"] = json!(updated.chars().count());
        drop(conn);
        self.notify();
        ok_json(&ack)
    }

    #[tool(
        description = "Add a subtask to a task. Subtasks are the task's checklist and the board card renders them as a live progress bar, so prefer these over a checklist written inside notes. Title one \"verify: <step>\" to make it a review step: when the task is tagged needs-review these render as the user's verify checklist instead of build progress, and only the user can tick them — add them whenever you flag a task for review."
    )]
    fn add_subtask(
        &self,
        Parameters(p): Parameters<AddSubtaskParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.add_subtask_as(p, Self::client_name(&ctx).as_deref())
    }

    fn add_subtask_as(
        &self,
        AddSubtaskParams { task_id: task_ref, title }: AddSubtaskParams,
        agent: Option<&str>,
    ) -> Result<CallToolResult, ErrorData> {
        let title = title.trim().to_string();
        if title.is_empty() {
            return Ok(err("Subtask title cannot be empty."));
        }
        let conn = self.db.lock().unwrap();
        let Some(task_id) = resolve_task_ref(&conn, &task_ref).map_err(db_err)? else {
            return Ok(err(format!("No task with reference {task_ref}.")));
        };
        match Self::task_trashed(&conn, task_id).map_err(db_err)? {
            None => return Ok(err(format!("No task with reference {task_ref}."))),
            Some(true) => {
                return Ok(err(format!(
                    "Task {task_ref} is in the trash; it can only be restored from the app."
                )))
            }
            Some(false) => {}
        }
        let position: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM subtasks WHERE task_id = ?1",
                [task_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        conn.execute(
            "INSERT INTO subtasks (task_id, title, position) VALUES (?1, ?2, ?3)",
            rusqlite::params![task_id, title, position],
        )
        .map_err(db_err)?;
        let id = conn.last_insert_rowid();
        Self::record_activity(&conn, task_id, &format!("Subtask added: {title}"), agent);
        let (done, total) = Self::subtask_progress(&conn, task_id).map_err(db_err)?;
        drop(conn);
        self.notify();
        ok_json(&json!({
            "id": id,
            "task_id": task_id,
            "title": title,
            "done": false,
            "progress": {"done": done, "total": total},
        }))
    }

    #[tool(
        description = "Tick, untick or rename a subtask. Only the provided fields change. Ticking a \"verify: …\" step is refused — verify steps are the user's review checklist; you can add, rename, untick or delete them, never tick them."
    )]
    fn set_subtask(
        &self,
        Parameters(p): Parameters<SetSubtaskParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.set_subtask_as(p, Self::client_name(&ctx).as_deref())
    }

    fn set_subtask_as(
        &self,
        SetSubtaskParams { id, done, title }: SetSubtaskParams,
        agent: Option<&str>,
    ) -> Result<CallToolResult, ErrorData> {
        if done.is_none() && title.is_none() {
            return Ok(err("Nothing to change — pass done and/or title."));
        }
        let conn = self.db.lock().unwrap();
        let Some((task_id, trashed)) = Self::parent_task_of(&conn, id).map_err(db_err)? else {
            return Ok(err(format!("No subtask with id {id}.")));
        };
        if trashed {
            return Ok(err(format!(
                "Subtask {id} belongs to a task in the trash; it can only be restored from the app."
            )));
        }
        // Verify steps are the user's checklist: an agent proposes them when it
        // flags review, but a tick asserts "I checked this on my machine" — a
        // claim only the person at the machine can make. Everything else stays
        // open (add, rename, untick, delete). The tick is refused when EITHER
        // the stored title or the requested one is a verify title — checking
        // only the result would let one call rename the step off the prefix and
        // tick it in the same breath — and it is refused before any write, so a
        // refused call leaves nothing half-applied.
        if done == Some(true) {
            let stored_title: String = conn
                .query_row("SELECT title FROM subtasks WHERE id = ?1", [id], |r| {
                    r.get(0)
                })
                .map_err(db_err)?;
            let requested_is_verify = title
                .as_deref()
                .is_some_and(|t| Self::is_verify_title(t.trim()));
            if Self::is_verify_title(&stored_title) || requested_is_verify {
                return Ok(err(format!(
                    "Subtask {id} is a verify step — verify steps are checked by the user \
                     in the app. An agent can add, rename, untick or delete them, but not \
                     tick them."
                )));
            }
        }
        if let Some(title) = &title {
            let title = title.trim();
            if title.is_empty() {
                return Ok(err("Subtask title cannot be empty."));
            }
            conn.execute(
                "UPDATE subtasks SET title = ?1 WHERE id = ?2",
                rusqlite::params![title, id],
            )
            .map_err(db_err)?;
            Self::record_activity(&conn, task_id, &format!("Subtask renamed: {title}"), agent);
        }
        if let Some(done) = done {
            conn.execute(
                "UPDATE subtasks SET done = ?1 WHERE id = ?2",
                rusqlite::params![done as i64, id],
            )
            .map_err(db_err)?;
            let current: String = conn
                .query_row("SELECT title FROM subtasks WHERE id = ?1", [id], |r| {
                    r.get(0)
                })
                .map_err(db_err)?;
            Self::record_activity(
                &conn,
                task_id,
                &format!(
                    "Subtask {}: {current}",
                    if done { "completed" } else { "reopened" }
                ),
                agent,
            );
        }
        let (done_count, total) = Self::subtask_progress(&conn, task_id).map_err(db_err)?;
        drop(conn);
        self.notify();
        ok_json(&json!({
            "id": id,
            "task_id": task_id,
            "progress": {"done": done_count, "total": total},
        }))
    }

    #[tool(
        description = "Remove a subtask. This is a hard delete — unlike delete_task there is no trash for subtasks."
    )]
    fn delete_subtask(
        &self,
        Parameters(p): Parameters<IdParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.delete_subtask_as(p, Self::client_name(&ctx).as_deref())
    }

    fn delete_subtask_as(
        &self,
        IdParams { id }: IdParams,
        agent: Option<&str>,
    ) -> Result<CallToolResult, ErrorData> {
        let conn = self.db.lock().unwrap();
        let Some((task_id, trashed)) = Self::parent_task_of(&conn, id).map_err(db_err)? else {
            return Ok(err(format!("No subtask with id {id}.")));
        };
        if trashed {
            return Ok(err(format!(
                "Subtask {id} belongs to a task in the trash; it can only be restored from the app."
            )));
        }
        let title: String = conn
            .query_row("SELECT title FROM subtasks WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .map_err(db_err)?;
        conn.execute("DELETE FROM subtasks WHERE id = ?1", [id])
            .map_err(db_err)?;
        Self::record_activity(&conn, task_id, &format!("Subtask removed: {title}"), agent);
        let (done, total) = Self::subtask_progress(&conn, task_id).map_err(db_err)?;
        drop(conn);
        self.notify();
        ok_json(&json!({
            "task_id": task_id,
            "deleted": id,
            "progress": {"done": done, "total": total},
        }))
    }

    #[tool(
        description = "Log one line of narrative progress — what you just did, found or decided. Lands timestamped in the task's Activity feed; prefer this over a `## Log` section in notes."
    )]
    fn log_progress(
        &self,
        Parameters(p): Parameters<LogProgressParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.log_progress_as(p, Self::client_name(&ctx).as_deref())
    }

    fn log_progress_as(
        &self,
        LogProgressParams { task_id: task_ref, text }: LogProgressParams,
        agent: Option<&str>,
    ) -> Result<CallToolResult, ErrorData> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Ok(err("Log text cannot be empty."));
        }
        let conn = self.db.lock().unwrap();
        let Some(task_id) = resolve_task_ref(&conn, &task_ref).map_err(db_err)? else {
            return Ok(err(format!("No task with reference {task_ref}.")));
        };
        match Self::task_trashed(&conn, task_id).map_err(db_err)? {
            None => return Ok(err(format!("No task with reference {task_ref}."))),
            Some(true) => {
                return Ok(err(format!(
                    "Task {task_ref} is in the trash; it can only be restored from the app."
                )))
            }
            Some(false) => {}
        }
        Self::record_activity(&conn, task_id, &text, agent);
        drop(conn);
        self.notify();
        // A receipt, like every other write: the entry is on screen, echoing it back
        // would only pay for the same bytes twice.
        ok_json(&json!({ "task_id": task_id, "logged": text }))
    }

    #[tool(description = "Mark a task as done.")]
    fn complete_task(
        &self,
        Parameters(p): Parameters<TaskIdParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.complete_task_as(p, Self::client_name(&ctx).as_deref())
    }

    fn complete_task_as(
        &self,
        TaskIdParams { id }: TaskIdParams,
        agent: Option<&str>,
    ) -> Result<CallToolResult, ErrorData> {
        // Routes through the same status write, so completing a task releases its
        // claims here too — no separate teardown to keep in sync.
        self.apply_task_update(
            id,
            None,
            None,
            Some("done".to_string()),
            None,
            None,
            None,
            None,
            agent,
            ClaimInfo::default(),
        )
    }

    #[tool(description = "Move a task to the trash (restorable in the app for 30 days).")]
    fn delete_task(
        &self,
        Parameters(TaskIdParams { id: task_ref }): Parameters<TaskIdParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let conn = self.db.lock().unwrap();
        let Some(id) = resolve_task_ref(&conn, &task_ref).map_err(db_err)? else {
            return Ok(err(format!("No task with reference {task_ref}.")));
        };
        let changed = conn
            .execute(
                "UPDATE tasks SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                rusqlite::params![now_iso(), id],
            )
            .map_err(db_err)?;
        drop(conn);
        if changed == 0 {
            return Ok(err(format!("Task {task_ref} is already in the trash.")));
        }
        self.notify();
        ok_text(format!("Task {task_ref} moved to trash."))
    }

    #[tool(description = "List all tags with the number of active tasks using each.")]
    fn list_tags(&self) -> Result<CallToolResult, ErrorData> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT tg.id, tg.name, tg.color,
                    (SELECT COUNT(*) FROM task_tags tt JOIN tasks t ON t.id = tt.task_id
                     WHERE tt.tag_id = tg.id AND t.deleted_at IS NULL)
                 FROM tags tg ORDER BY tg.name",
            )
            .map_err(db_err)?;
        let tags: Vec<Value> = stmt
            .query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "color": r.get::<_, String>(2)?,
                    "task_count": r.get::<_, i64>(3)?,
                }))
            })
            .map_err(db_err)?
            .collect::<Result<_, _>>()
            .map_err(db_err)?;
        ok_json(&json!(tags))
    }

    #[tool(
        description = "Attach a repo link to a task — a branch, PR, commit or worktree URL — rendered as a clickable chip on the card. Only http(s) URLs are accepted."
    )]
    fn add_link(
        &self,
        Parameters(p): Parameters<AddLinkParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.add_link_as(p, Self::client_name(&ctx).as_deref())
    }

    fn add_link_as(
        &self,
        AddLinkParams {
            task_id: task_ref,
            url,
            label,
            kind,
        }: AddLinkParams,
        agent: Option<&str>,
    ) -> Result<CallToolResult, ErrorData> {
        let url = url.trim().to_string();
        if !valid_http_url(&url) {
            return Ok(err(
                "url must be an http(s) link; other schemes (file, javascript, mailto, custom app schemes) are refused.",
            ));
        }
        let kind = kind
            .map(|k| k.trim().to_ascii_lowercase())
            .filter(|k| !k.is_empty())
            .unwrap_or_else(|| "other".to_string());
        if !LINK_KINDS.contains(&kind.as_str()) {
            return Ok(err("kind must be one of: pr, branch, commit, worktree, other."));
        }
        let label = label
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| link_label_from_url(&url));

        let conn = self.db.lock().unwrap();
        let Some(task_id) = resolve_task_ref(&conn, &task_ref).map_err(db_err)? else {
            return Ok(err(format!("No task with reference {task_ref}.")));
        };
        match Self::task_trashed(&conn, task_id).map_err(db_err)? {
            None => return Ok(err(format!("No task with reference {task_ref}."))),
            Some(true) => {
                return Ok(err(format!(
                    "Task {task_ref} is in the trash; it can only be restored from the app."
                )))
            }
            Some(false) => {}
        }
        conn.execute(
            "INSERT INTO task_links (task_id, url, label, kind, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![task_id, url, label, kind, now_iso()],
        )
        .map_err(db_err)?;
        let id = conn.last_insert_rowid();
        Self::record_activity(&conn, task_id, &format!("Link added: {label}"), agent);
        drop(conn);
        self.notify();
        ok_json(&json!({
            "id": id,
            "task_id": task_id,
            "url": url,
            "label": label,
            "kind": kind,
        }))
    }

    #[tool(
        description = "Remove a repo link from a task by its link id (from get_task's `links`). Hard delete — there is no trash for links."
    )]
    fn delete_link(
        &self,
        Parameters(p): Parameters<IdParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.delete_link_as(p, Self::client_name(&ctx).as_deref())
    }

    fn delete_link_as(
        &self,
        IdParams { id }: IdParams,
        agent: Option<&str>,
    ) -> Result<CallToolResult, ErrorData> {
        let conn = self.db.lock().unwrap();
        let found: Option<(i64, String)> = conn
            .query_row(
                "SELECT task_id, label FROM task_links WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map_err(db_err)?;
        let Some((task_id, label)) = found else {
            return Ok(err(format!("No link with id {id}.")));
        };
        conn.execute("DELETE FROM task_links WHERE id = ?1", [id])
            .map_err(db_err)?;
        Self::record_activity(&conn, task_id, &format!("Link removed: {label}"), agent);
        drop(conn);
        self.notify();
        ok_json(&json!({ "deleted": id, "task_id": task_id }))
    }

    #[tool(
        description = "Add a comment to a task — a message on the card the user can read and reply to. Ask here when blocked, then park list_changes on the task; the user's reply wakes you."
    )]
    fn add_comment(
        &self,
        Parameters(p): Parameters<AddCommentParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.add_comment_as(p, Self::client_name(&ctx).as_deref())
    }

    // A comment written through the MCP server is always an agent's — the UI writes
    // its own with actor_kind='user' (db.ts). `agent` is the client's own name from
    // the handshake, or None when it sent none; the row is still kind='agent'.
    // Deliberately no record_activity call: a comment is its own surface, and the
    // spec keeps task_activity out of scope. The change feed is fed by the trigger
    // (migration 012), so a parked list_changes still wakes.
    fn add_comment_as(
        &self,
        AddCommentParams { task_id: task_ref, body }: AddCommentParams,
        agent: Option<&str>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = body.trim().to_string();
        if body.is_empty() {
            return Ok(err("body cannot be empty."));
        }
        let conn = self.db.lock().unwrap();
        let Some(task_id) = resolve_task_ref(&conn, &task_ref).map_err(db_err)? else {
            return Ok(err(format!("No task with reference {task_ref}.")));
        };
        match Self::task_trashed(&conn, task_id).map_err(db_err)? {
            None => return Ok(err(format!("No task with reference {task_ref}."))),
            Some(true) => {
                return Ok(err(format!(
                    "Task {task_ref} is in the trash; it can only be restored from the app."
                )))
            }
            Some(false) => {}
        }
        let created_at = now_iso();
        conn.execute(
            "INSERT INTO comments (task_id, body, actor_kind, actor_name, created_at)
             VALUES (?1, ?2, 'agent', ?3, ?4)",
            rusqlite::params![task_id, body, agent, created_at],
        )
        .map_err(db_err)?;
        let id = conn.last_insert_rowid();
        drop(conn);
        self.notify();
        ok_json(&json!({
            "id": id,
            "task_id": task_id,
            "body": body,
            "actor_kind": "agent",
            "actor_name": agent,
            "created_at": created_at,
        }))
    }

    #[tool(
        description = "What changed on the board since a cursor. Call once with no arguments for the current cursor, then pass it back as `since`; with `wait_ms` the call blocks until something changes — park here instead of polling. kind is created/status/moved/trashed/restored/edited/link/comment/tag. A change says THAT a task changed, not what it now is — follow up with get_task."
    )]
    async fn list_changes(
        &self,
        Parameters(ListChangesParams { since, wait_ms }): Parameters<ListChangesParams>,
    ) -> Result<CallToolResult, ErrorData> {
        // Every db read below is inside a closing scope. `db` is a
        // std::sync::Mutex over the server's ONE connection: a guard alive across
        // the await would make this future non-Send (a compile error) and would
        // block every other tool for the whole park.
        let first = {
            let conn = self.db.lock().unwrap();
            Self::prune_changes(&conn).map_err(db_err)?;
            Self::read_changes(&conn, since).map_err(db_err)?
        };

        let wait_ms = wait_ms.unwrap_or(0).clamp(0, 60_000);
        let nothing_yet = first["changes"].as_array().is_some_and(|c| c.is_empty());
        // No `since` is a baseline request — there is nothing to wait for.
        if since.is_none() || wait_ms == 0 || !nothing_yet {
            return ok_json(&first);
        }

        // Park. The agent experiences push: it called a tool, and the call simply
        // does not return until the board moves. Inside, we tick — SQLite's
        // update_hook only fires for the connection that wrote, so this connection
        // cannot be told about the UI's writes. The tick is a lookup on an indexed
        // integer and only runs while someone is actually parked.
        let deadline =
            tokio::time::Instant::now() + std::time::Duration::from_millis(wait_ms as u64);
        loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => break,
                _ = tokio::time::sleep_until(deadline) => break,
                _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {}
            }
            let out = {
                let conn = self.db.lock().unwrap();
                Self::read_changes(&conn, since).map_err(db_err)?
            };
            if out["changes"].as_array().is_some_and(|c| !c.is_empty()) {
                return ok_json(&out);
            }
        }

        // Timed out, or the server is stopping: success with an empty list and the
        // cursor, never an error. "Nothing happened" is a real answer.
        // No self.notify() anywhere here — this is a read tool, and notifying would
        // reload the app's whole store on every poll.
        ok_json(&first)
    }
}

#[tool_handler]
impl ServerHandler for TildoneAgent {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_tool_list_changed()
                .build(),
        );
        info.server_info.name = "tildone".into();
        info.server_info.version = env!("CARGO_PKG_VERSION").into();
        // The shared conventions live HERE, once, instead of being repeated in
        // per-tool schema descriptions — the tool list is fixed context every
        // connected session pays for, this string is paid for once.
        info.with_instructions(
            "Tildone is the user's personal task manager — a kanban board they watch live. \
             Tasks: status todo/doing/done, optional project (otherwise the Inbox), tags \
             (unknown names auto-created), priority 0 none – 3 high, due date YYYY-MM-DD. \
             Refer to projects and tags by name; task ids are numbers or refs like \"TIL-3\". \
             On update, \"\" clears the due date, 0 clears priority, \"inbox\" clears the \
             project; provided fields replace wholesale (notes and tags included — prefer \
             append_note over rewriting notes). A task has three surfaces: subtasks are the \
             plan (a live progress bar on the card), log_progress is the running log (the \
             Activity feed), notes is prose that rarely changes. When you start work, claim \
             the task: send session_id (+ cwd, branch) with status \"doing\". Writes return \
             a receipt {id, ref, status}, not the row — get_task when you need full state. \
             Null fields are omitted from all responses. When blocked: add_comment your \
             question, tag the task blocked, park list_changes — the user's reply wakes you. \
             Start with list_projects/list_tasks to see what exists; deleting a project is \
             irreversible, deleted tasks go to a restorable trash.",
        )
    }

    /// Tildone's tool set is fixed at compile time, so it never changes *within*
    /// a process — but it does change across an app upgrade, and a client that
    /// reconnects after one restores its cached tool list without re-listing.
    /// That is how `append_note` stayed invisible to a live session while the
    /// server was already serving it. There is no peer to notify at the moment
    /// the set actually changes (the app is restarting), so the notification
    /// goes out here instead: once a client is back, tell it to re-list.
    fn on_initialized(
        &self,
        context: NotificationContext<RoleServer>,
    ) -> impl std::future::Future<Output = ()> + Send + '_ {
        async move {
            if let Err(e) = context.peer.notify_tool_list_changed().await {
                eprintln!("tildone: tools/list_changed notify failed: {e}");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Lifecycle commands

/// Loopback Host validation is rmcp's default (blocks DNS rebinding); on top
/// of that, reject any browser-originated request outright: web pages always
/// send an Origin header and can never legitimately talk to this server, while
/// real MCP clients (CLIs, desktop apps) send none and pass.
fn server_config(port: u16) -> StreamableHttpServerConfig {
    StreamableHttpServerConfig::default().with_allowed_origins([
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
    ])
}

#[derive(serde::Deserialize)]
pub struct HeartbeatBody {
    /// The agent's session id — the same value it sent when it claimed a task.
    session_id: String,
    /// "working" | "blocked" | "idle".
    state: String,
    /// The session's OS process ($PPID from the hook). Optional: without it we fall
    /// back to LIVE_TTL, which is the only reason that constant still exists.
    pid: Option<u32>,
    /// Set when the beat came from a subagent's tool call.
    agent_id: Option<String>,
}

/// Liveness, reported by a local agent's hook.
///
/// Deliberately **not** an MCP tool: a shell hook fires this on every tool call, and
/// an MCP handshake per beat would be absurd. That makes it a plain axum route — and
/// therefore something the `/mcp` service's protections do NOT cover, see below.
///
/// Three properties this must keep:
///
/// 1. **Never calls `notify()`.** Emitting `agent-db-changed` here would send the UI
///    through a full `fetchAll()` of the whole database on every beat of every agent.
///    Presence is polled instead, precisely so this can stay cheap.
/// 2. **Never blocks.** It only takes a lock and inserts. A hook that waits on this
///    starves Claude's agentic loop.
/// 3. **Never writes to disk.** Beats are volatile by design; the durable half is
///    the claim.
async fn heartbeat_handler(
    axum::extract::State(beats): axum::extract::State<Beats>,
    headers: axum::http::HeaderMap,
    body: Option<axum::Json<HeartbeatBody>>,
) -> axum::http::StatusCode {
    // rmcp applies server_config's origin rejection to the /mcp service only; a
    // sibling axum route inherits none of it. Same rule, same reasoning as up there:
    // a web page always sends Origin and can never legitimately talk to this server,
    // while a shell hook sends none. Without this, any page you visited could POST
    // fake "working" states into the one feature whose whole point is not lying.
    if headers.contains_key(axum::http::header::ORIGIN) {
        return axum::http::StatusCode::FORBIDDEN;
    }
    let Some(axum::Json(body)) = body else {
        return axum::http::StatusCode::BAD_REQUEST;
    };
    if !matches!(body.state.as_str(), "working" | "blocked" | "idle") {
        return axum::http::StatusCode::BAD_REQUEST;
    }
    // A subagent finishing is not the parent finishing. Its `working` beats are the
    // parent's too (the parent genuinely is working), but its `idle` must never
    // settle the parent's card.
    if body.agent_id.is_some() && body.state == "idle" {
        return axum::http::StatusCode::OK;
    }
    let session = body.session_id.trim();
    if session.is_empty() {
        return axum::http::StatusCode::BAD_REQUEST;
    }
    beats.lock().unwrap().insert(
        session.to_string(),
        Beat {
            state: body.state,
            at: std::time::Instant::now(),
            at_iso: now_iso(),
            pid: body.pid,
        },
    );
    // 200 even when this session claimed nothing: most sessions are not working a
    // board task, and their beats must be free and harmless. That is the common
    // case, not an error — resolve_presence simply never joins them to a card.
    axum::http::StatusCode::OK
}

/// Every claimed task, with the liveliest state among the sessions claiming it.
///
/// Polled by the UI (see App.tsx) rather than pushed: a beat per tool call per agent
/// is far too chatty to hang the board's reload on.
#[tauri::command]
pub fn agent_presence(live: State<'_, AgentLive>) -> Vec<PresenceEntry> {
    let db = { live.db.lock().unwrap().clone() };
    let Some(db) = db else { return Vec::new() };
    let claims = {
        let conn = db.lock().unwrap();
        match read_claims(&conn) {
            Ok(claims) => claims,
            Err(e) => {
                eprintln!("tildone: presence query failed: {e}");
                return Vec::new();
            }
        }
    };
    let beats = live.beats.lock().unwrap().clone();
    resolve_presence(&claims, &beats, std::time::Instant::now(), &pid_alive)
}

/// Every claim, joined with the agent's latest word on that task.
///
/// The log line is joined here rather than fetched per card: the board renders many
/// cards, and `fetchAll` deliberately carries no activity bodies.
fn read_claims(conn: &Connection) -> rusqlite::Result<Vec<ClaimRow>> {
    let mut stmt = conn.prepare(
        "SELECT c.session_id, c.task_id, c.cwd, c.branch, c.agent_name, c.claimed_at,
                (SELECT a.label FROM task_activity a
                  WHERE a.task_id = c.task_id AND a.actor_kind = 'agent'
                  ORDER BY a.id DESC LIMIT 1)
           FROM agent_claims c",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ClaimRow {
            session_id: r.get(0)?,
            task_id: r.get(1)?,
            cwd: r.get(2)?,
            branch: r.get(3)?,
            agent_name: r.get(4)?,
            claimed_at: r.get(5)?,
            last_log: r.get(6)?,
        })
    })?;
    rows.collect()
}

/// The port to *request* at bind time.
///
/// `AGENT_PORT` is the contract: an agent's MCP config points at a fixed URL, so
/// the installed app must always own it. Every other instance has to get out of
/// the way — `tauri dev` and each git worktree would otherwise all grab the same
/// port, and only the first would win. Worse, that loss is silent (the frontend
/// discards the bind error), so a dev build looks healthy with no board at all.
///
/// Hence: a debug build asks for port 0 and lets the OS hand out a free one, so
/// any number of dev instances coexist. `TILDONE_AGENT_PORT` overrides both, for
/// when a dev genuinely needs a known port (e.g. pointing an agent at a dev build).
fn resolve_port(env_override: Option<&str>, is_dev_build: bool) -> u16 {
    if let Some(raw) = env_override {
        if let Ok(port) = raw.trim().parse::<u16>() {
            return port;
        }
        eprintln!("tildone: ignoring unparseable TILDONE_AGENT_PORT={raw:?}");
    }
    if is_dev_build {
        0
    } else {
        AGENT_PORT
    }
}

/// A release build claims `AGENT_PORT` by contract — it is *meant* to be the
/// installed app. But `cfg!(debug_assertions)` cannot tell an installed bundle
/// from a `tauri build` run out of a worktree, so a worktree release build binds
/// 11502 and silently steals the installed app's board. We still bind (a
/// legitimately relocated install must keep working), but warn when the running
/// bundle is not under an `/Applications/` dir — the one cheap signal that this
/// might be a squatter. Pure so the decision is unit-testable without a binary.
fn should_warn_port_squat(
    is_dev: bool,
    port: u16,
    explicit: Option<u16>,
    in_applications: bool,
) -> bool {
    // Only when a RELEASE build DEFAULTED onto 11502 (not asked for it explicitly)
    // and is running from outside /Applications.
    !is_dev && port == AGENT_PORT && explicit != Some(AGENT_PORT) && !in_applications
}

fn requested_port() -> u16 {
    let env_override = std::env::var("TILDONE_AGENT_PORT").ok();
    let is_dev = cfg!(debug_assertions);
    let explicit = env_override
        .as_deref()
        .and_then(|s| s.trim().parse::<u16>().ok());
    let port = resolve_port(env_override.as_deref(), is_dev);
    if let Ok(exe) = std::env::current_exe() {
        // Covers both /Applications and ~/Applications; a worktree target dir has
        // neither, so it is the honest discriminator here.
        let in_applications = exe.to_string_lossy().contains("/Applications/");
        if should_warn_port_squat(is_dev, port, explicit, in_applications) {
            eprintln!(
                "tildone: WARNING — this release build ({}) is claiming port {AGENT_PORT} \
                 but is not installed under /Applications. If the installed Tildone is \
                 running, this steals its agent board. Quit this build, or set \
                 TILDONE_AGENT_PORT to point it elsewhere.",
                exe.display()
            );
        }
    }
    port
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    // Same resolution as tauri-plugin-sql: "sqlite:tildone.db" lives in the
    // app config dir.
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve app config dir: {e}"))?;
    let path = dir.join("tildone.db");
    if !path.exists() {
        return Err("tildone.db not found — the app must run once before enabling agent access".into());
    }
    let conn = Connection::open(&path).map_err(|e| format!("cannot open database: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

#[tauri::command]
pub async fn agent_server_start(
    app: AppHandle,
    state: State<'_, AgentServer>,
    live: State<'_, AgentLive>,
) -> Result<String, String> {
    // React StrictMode (dev) fires the startup effect twice, so two of these
    // commands can run concurrently. Both used to pass the state check below
    // before either stored anything — each bound its own listener and each
    // installed a tray icon (seen live: one app, two menu-bar tildes on
    // consecutive ports). Serialize the whole start; the loser of the race
    // then sees the winner's state and returns its endpoint.
    static START_GATE: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    let _start_gate = START_GATE.get_or_init(Default::default).lock().await;
    {
        let guard = state.0.lock().unwrap();
        if let Some((ct, endpoint)) = guard.as_ref() {
            if !ct.is_cancelled() {
                return Ok(endpoint.clone());
            }
        }
    }

    // Bind before configuring: with a requested port of 0 the real port only
    // exists once the OS has assigned it, and both the endpoint we hand back and
    // the allowed-origins list have to name that port, not AGENT_PORT.
    let requested = requested_port();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", requested))
        .await
        .map_err(|e| format!("cannot listen on port {requested}: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("cannot resolve the bound address: {e}"))?
        .port();
    let endpoint = format!("http://127.0.0.1:{port}/mcp");

    let db: Db = Arc::new(Mutex::new(open_db(&app)?));
    // Presence reads claims through this same connection. Cloned before `db` is moved
    // into the MCP service closure below — the Arc is the point, so both share one
    // connection and one mutex rather than opening a second handle to the file.
    *live.db.lock().unwrap() = Some(db.clone());
    let ct = CancellationToken::new();
    let config = server_config(port).with_cancellation_token(ct.child_token());
    let emitter = app.clone();
    let on_change: Notify = Arc::new(move || {
        let _ = emitter.emit("agent-db-changed", ());
    });
    // Native notifications for agent complete / blocked / needs-review writes. Built
    // here for the same reason as on_change — it captures the AppHandle — but it
    // reaches the user, not the UI. Gated by NOTIFY_USER_ENABLED so the Settings
    // toggle can mute it without restarting the server.
    let notifier = app.clone();
    let notify_user: NotifyUser = Arc::new(move |title: &str, body: &str, task_ref: Option<&str>| {
        if !NOTIFY_USER_ENABLED.load(Ordering::Relaxed) {
            return;
        }
        send_user_notification(&notifier, title, body, task_ref);
    });
    // The same token the server shuts down on, so a parked list_changes is
    // released by agent_server_stop / app exit instead of holding them up.
    let agent_ct = ct.clone();
    let service: StreamableHttpService<TildoneAgent, LocalSessionManager> =
        StreamableHttpService::new(
            move || {
                Ok(TildoneAgent::new(
                    db.clone(),
                    on_change.clone(),
                    notify_user.clone(),
                    agent_ct.clone(),
                ))
            },
            Default::default(),
            config,
        );
    // /heartbeat sits beside /mcp rather than inside it: a shell hook fires it on
    // every tool call, where an MCP handshake per beat would be absurd. It carries
    // its own origin guard, because rmcp's covers the nested service only.
    let router = axum::Router::new().nest_service("/mcp", service).route(
        "/heartbeat",
        axum::routing::post(heartbeat_handler).with_state(live.beats.clone()),
    );

    let serve_ct = ct.clone();
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move { serve_ct.cancelled_owned().await })
            .await;
    });

    *state.0.lock().unwrap() = Some((ct, endpoint.clone()));

    // Background mode: while the server is up, closing the window hides it instead
    // of quitting, so the tray becomes the way back to the window and to Quit. A
    // tray build failure must not fail the server (the board is the point), but it
    // does mean a later close would hide with no way back — logged, not fatal.
    if let Err(e) = install_tray(&app, port) {
        eprintln!("tildone: could not install the menu-bar tray: {e}");
    }

    Ok(endpoint)
}

#[tauri::command]
pub fn agent_server_stop(app: AppHandle, state: State<'_, AgentServer>) {
    if let Some((ct, _)) = state.0.lock().unwrap().take() {
        ct.cancel();
    }
    // Leaving background mode: drop the tray and make sure the window is visible,
    // so turning Agent access off while the window is hidden can't orphan the app
    // with no window and no tray.
    remove_tray(&app);
    show_main_window(&app);
}

/// Mute or unmute native notifications for agent complete / blocked / needs-review
/// writes. The frontend calls this on startup with the persisted setting and again
/// whenever the Settings toggle changes; the running server's closure reads the flag
/// per send, so it takes effect without restarting the server.
#[tauri::command]
pub fn agent_set_notify(enabled: bool) {
    NOTIFY_USER_ENABLED.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
pub fn agent_server_status(state: State<'_, AgentServer>) -> bool {
    state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|(ct, _)| !ct.is_cancelled())
}

/// The live endpoint, or None when the server is not running. The UI must ask
/// rather than assume: the port is only fixed for a release build.
#[tauri::command]
pub fn agent_server_endpoint(state: State<'_, AgentServer>) -> Option<String> {
    state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .filter(|(ct, _)| !ct.is_cancelled())
        .map(|(_, endpoint)| endpoint.clone())
}

/// Called from the app exit hook.
pub fn shutdown(app: &AppHandle) {
    if let Some(server) = app.try_state::<AgentServer>() {
        if let Some((ct, _)) = server.0.lock().unwrap().take() {
            ct.cancel();
        }
    }
}

/// True while the agent MCP server is bound and serving. The window-close handler
/// reads this to decide "hide to the tray" (server up) vs "quit" (server down).
pub fn server_running(app: &AppHandle) -> bool {
    app.try_state::<AgentServer>()
        .and_then(|s| s.0.lock().unwrap().as_ref().map(|(ct, _)| !ct.is_cancelled()))
        .unwrap_or(false)
}

/// Show and focus the main window — from the tray, a Dock re-open, or leaving
/// background mode.
pub fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// The task ref inside a `tildone://task/<REF>` deep link, if the URL is one.
/// Deliberately tolerant on the way in (trailing slash is fine, `task` host is
/// case-insensitive) and strict on the way out (exactly one non-empty path
/// segment). Anything else is None — a deep link must never error at the user,
/// so the caller just shows the window for URLs this doesn't recognise.
pub fn deep_link_task_ref(url: &str) -> Option<String> {
    let rest = url.strip_prefix("tildone://")?;
    let mut parts = rest.trim_end_matches('/').splitn(2, '/');
    if !parts.next()?.eq_ignore_ascii_case("task") {
        return None;
    }
    let task_ref = parts.next()?.trim();
    if task_ref.is_empty() || task_ref.contains('/') {
        return None;
    }
    Some(task_ref.to_string())
}

/// Raise one agent notification. macOS bypasses the notification plugin and drives
/// mac-notification-sys — the same crate the plugin uses underneath, so identity and
/// the ObjC delegate are shared, not fought over — because the plugin's click API is
/// mobile-only, and a click on an agent banner should open the task it names, not
/// bounce off a tray-hidden window. Failures (denied permission, anything) stay
/// silent no-ops: the notification is a courtesy, never part of the write's contract.
#[cfg(target_os = "macos")]
fn send_user_notification(app: &AppHandle, title: &str, body: &str, task_ref: Option<&str>) {
    // Identity first, with the plugin's exact dev/prod logic: no bundle of our own
    // in dev, so borrow Terminal's. set_application is call-once per process; a
    // second call (ours or the plugin's first-hide hint) erroring is fine.
    let bundle_id = if tauri::is_dev() {
        "com.apple.Terminal".to_string()
    } else {
        app.config().identifier.clone()
    };
    let app = app.clone();
    let title = title.to_string();
    let body = body.to_string();
    let task_ref = task_ref.map(str::to_string);
    // One detached thread per notification: with wait_for_click, send() parks on a
    // condvar until the banner is clicked or dismissed (auto-dismiss resolves it —
    // verified in mac-notification-sys 0.6 bridge.rs), and the MCP write path must
    // never wait on a human. A handful of parked waiters is condvars, not spins.
    std::thread::spawn(move || {
        let _ = mac_notification_sys::set_application(&bundle_id);
        let response = mac_notification_sys::Notification::new()
            .title(&title)
            .message(&body)
            .wait_for_click(true)
            .send();
        if let Ok(mac_notification_sys::NotificationResponse::Click) = response {
            // The same landing action as a tildone://task/<REF> deep link: show the
            // window (fixes the tray-mode dead click), then open the named card.
            show_main_window(&app);
            if let Some(r) = task_ref {
                let _ = app.emit("open-task-ref", r);
            }
        }
    });
}

/// Non-macOS: the plugin path, unchanged. No desktop click reporting exists here;
/// the ref already rides in the body so the banner stays quotable.
#[cfg(not(target_os = "macos"))]
fn send_user_notification(app: &AppHandle, title: &str, body: &str, _task_ref: Option<&str>) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Fire the "still running in the menu bar" hint exactly once, ever. Guarded by a
/// marker file in the app config dir: the user is told the first time a close
/// hides the window to the tray, and never nagged again. If the marker can't be
/// written we stay silent rather than risk hinting on every close.
pub fn maybe_first_hide_hint(app: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;

    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let marker = dir.join(".bg-hint-shown");
    if marker.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(&dir);
    if std::fs::write(&marker, b"1").is_err() {
        return;
    }
    let _ = app
        .notification()
        .builder()
        .title("Tildone is still running")
        .body("The board stays live in the menu bar. Quit Tildone from there.")
        .show();
}

/// Build the menu-bar tray (Show / status / Quit) and keep it alive in `TrayHandle`.
/// Called when the agent server starts. Idempotent: a second start (e.g. the window
/// re-opening and re-invoking `agent_server_start`) leaves the existing tray in place.
fn install_tray(app: &AppHandle, port: u16) -> Result<(), String> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let Some(tray_state) = app.try_state::<TrayHandle>() else {
        return Err("tray state missing".into());
    };
    // Hold the lock from the emptiness check through the store: with two
    // racing installers, check-then-store left both building and one tray
    // orphaned in the menu bar.
    let mut tray_guard = tray_state.0.lock().unwrap();
    if tray_guard.is_some() {
        return Ok(());
    }

    // Dev instances carry their worktree in the product name
    // ("Tildone Dev — <slug>", set by scripts/tauri.sh) — surface it on the
    // tray so the user can tell which menu-bar tilde belongs to which task.
    let product = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "Tildone".into());
    let dev_slug = product.strip_prefix("Tildone Dev — ").map(str::to_string);

    let show = MenuItemBuilder::with_id("show", format!("Show {product}"))
        .build(app)
        .map_err(|e| e.to_string())?;
    // A disabled line that names the live endpoint — the port is only known after
    // bind, so it is passed in, never assumed to be AGENT_PORT.
    let status = MenuItemBuilder::with_id("status", format!("Server · :{port}"))
        .enabled(false)
        .build(app)
        .map_err(|e| e.to_string())?;
    let quit = MenuItemBuilder::with_id("quit", format!("Quit {product}"))
        .build(app)
        .map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(app)
        .items(&[&show, &status, &quit])
        .build()
        .map_err(|e| e.to_string())?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("no default window icon to use for the tray")?;

    let mut builder = TrayIconBuilder::new()
        .icon(icon)
        .tooltip(&product)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(slug) = &dev_slug {
        // Text label next to the icon (macOS): the worktree name in the
        // menu bar itself, so parallel dev instances are tellable apart.
        builder = builder.title(slug);
    }
    let tray = builder.build(app).map_err(|e| e.to_string())?;

    *tray_guard = Some(tray);
    Ok(())
}

/// Remove the tray icon. Taking it out of the `Mutex<Option<..>>` drops it, which
/// un-installs it from the menu bar.
fn remove_tray(app: &AppHandle) {
    if let Some(tray_state) = app.try_state::<TrayHandle>() {
        let _ = tray_state.0.lock().unwrap().take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extract(result: &CallToolResult) -> (bool, Value) {
        let text = match &result.content[0] {
            ContentBlock::Text(t) => t.text.clone(),
            other => panic!("expected text content, got {other:?}"),
        };
        let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
        (result.is_error.unwrap_or(false), value)
    }

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/001_init.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/002_trash.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/003_subtasks_activity.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/004_iso_timestamps.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/005_changes.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/006_repair_positions.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/007_archived_at.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/008_task_links.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/009_activity_actor.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/010_project_folder.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/011_task_ref.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/012_comments.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/013_agent_claims.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/014_unseen_at.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/015_task_tags_changes.sql")).unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn
    }

    /// A no-op notify_user for tests that don't assert on notifications.
    fn no_notify() -> NotifyUser {
        Arc::new(|_: &str, _: &str, _: Option<&str>| {})
    }

    fn test_agent() -> TildoneAgent {
        TildoneAgent::new(
            Arc::new(Mutex::new(migrated_conn())),
            Arc::new(|| {}),
            no_notify(),
            CancellationToken::new(),
        )
    }

    fn test_agent_with_db() -> (TildoneAgent, Db) {
        let db: Db = Arc::new(Mutex::new(migrated_conn()));
        (
            TildoneAgent::new(db.clone(), Arc::new(|| {}), no_notify(), CancellationToken::new()),
            db,
        )
    }

    type NotifySink = Arc<Mutex<Vec<(String, String, Option<String>)>>>;

    /// An agent whose notify_user records every (title, body, ref) it fires, so a test
    /// can assert exactly which notifications a write raised — and which it didn't.
    fn test_agent_with_notifications() -> (TildoneAgent, NotifySink) {
        let sink: NotifySink = Arc::new(Mutex::new(Vec::new()));
        let recorder = sink.clone();
        let notify_user: NotifyUser = Arc::new(move |title: &str, body: &str, r: Option<&str>| {
            recorder
                .lock()
                .unwrap()
                .push((title.to_string(), body.to_string(), r.map(str::to_string)));
        });
        let agent = TildoneAgent::new(
            Arc::new(Mutex::new(migrated_conn())),
            Arc::new(|| {}),
            notify_user,
            CancellationToken::new(),
        );
        (agent, sink)
    }

    // ---- tool-schema wire-noise (TIL-85) ----

    #[test]
    fn tool_schemas_carry_no_wire_noise() {
        // The `$schema` dialect URL and integer `format` tags (int64, …) are pure
        // boilerplate no MCP client uses — but the tool list is fixed context every
        // connected session carries all session, so shipping them is a token tax on
        // every agent. slim_tool_schema strips them at build; guard that here.
        let agent = test_agent();
        for tool in agent.tool_router.list_all() {
            let schema = serde_json::to_string(&tool.input_schema).unwrap();
            assert!(
                !schema.contains("$schema"),
                "tool {} still advertises a $schema dialect URL: {schema}",
                tool.name
            );
            for fmt in INT_FORMATS {
                assert!(
                    !schema.contains(&format!("\"format\":\"{fmt}\"")),
                    "tool {} still advertises integer format {fmt}: {schema}",
                    tool.name
                );
            }
        }
    }

    #[test]
    fn slimming_preserves_schema_structure() {
        // The trim is cosmetic: it must not damage the parts a client relies on.
        // update_task is the richest schema (object root, a $ref to the shared
        // TaskRef $defs, many typed properties) — if the trim left it intact, it
        // left every schema intact.
        let agent = test_agent();
        let update = agent.tool_router.get("update_task").expect("update_task exists");
        let s = &*update.input_schema;
        assert_eq!(s.get("type").and_then(|v| v.as_str()), Some("object"));
        assert!(
            s.get("properties").and_then(|p| p.get("id")).is_some(),
            "id property survived the trim"
        );
        assert!(
            s.get("$defs").and_then(|d| d.get("TaskRef")).is_some(),
            "shared TaskRef $defs survived the trim"
        );
        // The int|string union that makes ids accept "TIL-3" or a number is intact.
        let taskref = s.get("$defs").unwrap().get("TaskRef").unwrap();
        assert!(taskref.get("anyOf").and_then(|a| a.as_array()).is_some_and(|a| a.len() == 2));
    }

    #[test]
    fn slimming_shrinks_the_served_tool_list() {
        // Prove the trim removes real bytes, robustly to future tool additions:
        // compare the raw macro output against the slimmed router the server
        // actually serves. Measuring the delta (not an absolute cap) means adding
        // a tool later never breaks this guard.
        fn schema_bytes(router: &ToolRouter<TildoneAgent>) -> usize {
            router
                .list_all()
                .iter()
                .map(|t| serde_json::to_string(&t.input_schema).unwrap().len())
                .sum()
        }
        let raw = schema_bytes(&TildoneAgent::tool_router());
        let slim = schema_bytes(&test_agent().tool_router);
        eprintln!("tool-defs input_schema bytes: raw={raw} slim={slim} saved={}", raw - slim);
        assert!(slim < raw, "slimmed {slim} is not smaller than raw {raw}");
        // Observed on the current tool set: $schema ×18 + integer format ×18.
        assert!(raw - slim >= 1000, "expected >=1KB trimmed, got {}", raw - slim);
    }

    // ---- item 7: task <-> repo links ----

    fn a_task(agent: &TildoneAgent, title: &str) -> i64 {
        let (is_err, task) = extract(
            &agent
                .create_task_as(CreateTaskParams {
                    title: title.into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: None,
                }, None)
                .unwrap(),
        );
        assert!(!is_err, "create_task failed: {task}");
        task["id"].as_i64().unwrap()
    }

    /// Move a task to a status as a live agent session would: the claim rides this
    /// write, so this helper is how the claim tests start work.
    fn work_on(
        agent: &TildoneAgent,
        id: i64,
        status: &str,
        session_id: Option<&str>,
        cwd: Option<&str>,
        branch: Option<&str>,
    ) -> (bool, Value) {
        extract(
            &agent
                .update_task_as(
                    UpdateTaskParams {
                        id: id.into(),
                        title: None,
                        notes: None,
                        status: Some(status.into()),
                        priority: None,
                        due_date: None,
                        project: None,
                        tags: None,
                        session_id: session_id.map(Into::into),
                        cwd: cwd.map(Into::into),
                        branch: branch.map(Into::into),
                    },
                    Some("claude"),
                )
                .unwrap(),
        )
    }

    fn claim_count(db: &Db) -> i64 {
        db.lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM agent_claims", [], |r| r.get(0))
            .unwrap()
    }

    // -----------------------------------------------------------------------
    // Presence resolution. Pure, with liveness injected, so the whole table is
    // testable without spawning or killing a process.

    fn a_claim(session: &str, task_id: i64) -> ClaimRow {
        ClaimRow {
            session_id: session.into(),
            task_id,
            cwd: None,
            branch: Some("wt-1".into()),
            agent_name: Some("claude".into()),
            claimed_at: "2026-07-17T10:00:00.000Z".into(),
            last_log: None,
        }
    }

    fn a_beat(state: &str, age: std::time::Duration, pid: Option<u32>) -> Beat {
        Beat {
            state: state.into(),
            at: std::time::Instant::now() - age,
            at_iso: "2026-07-17T10:05:00.000Z".into(),
            pid,
        }
    }

    const ALIVE: &dyn Fn(u32) -> bool = &|_| true;
    const DEAD: &dyn Fn(u32) -> bool = &|_| false;

    fn resolve_one(claims: &[ClaimRow], beats: &[(&str, Beat)], alive: &dyn Fn(u32) -> bool) -> Vec<PresenceEntry> {
        let map: HashMap<String, Beat> =
            beats.iter().map(|(s, b)| ((*s).to_string(), b.clone())).collect();
        resolve_presence(claims, &map, std::time::Instant::now(), alive)
    }

    #[test]
    fn pid_alive_answers_truthfully_about_real_processes() {
        // The whole liveness design rests on this one call, and `cargo check` only
        // proves it compiles — not that the sysinfo refresh flags are the ones that
        // actually populate the process list. A wrong-but-compiling version here
        // would make every card read quiet forever (or never), and every other test
        // injects liveness and so would never notice.
        assert!(pid_alive(std::process::id()), "this very process must read as alive");

        // A pid that cannot exist. Above the default pid_max on macOS/Linux.
        assert!(!pid_alive(4_294_967_294), "a nonexistent pid must read as dead");
    }

    #[test]
    fn pid_alive_sees_a_process_die() {
        // The kill -9 case, end to end, against the real OS.
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        assert!(pid_alive(pid), "a just-spawned process must read as alive");
        child.kill().expect("kill");
        child.wait().expect("reap");
        assert!(!pid_alive(pid), "a killed and reaped process must read as dead");
    }

    #[test]
    fn a_working_beat_from_a_live_process_is_working() {
        let out = resolve_one(
            &[a_claim("s1", 7)],
            &[("s1", a_beat("working", std::time::Duration::from_secs(1), Some(123)))],
            ALIVE,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].state, "working");
        assert_eq!(out[0].task_id, 7);
        assert_eq!(out[0].branch.as_deref(), Some("wt-1"));
    }

    #[test]
    fn a_working_beat_from_a_dead_process_is_quiet_at_once() {
        // The kill -9 case. This is why liveness is PID-checked rather than timed
        // out: the card must not claim "working" until an arbitrary timer expires.
        let out = resolve_one(
            &[a_claim("s1", 7)],
            &[("s1", a_beat("working", std::time::Duration::from_secs(1), Some(123)))],
            DEAD,
        );
        assert_eq!(out[0].state, "quiet");
    }

    #[test]
    fn a_long_silent_stretch_is_still_working_while_the_process_lives() {
        // THE regression this design exists for. A five-minute `bun run build` inside
        // one Bash call emits no tool calls, so no beat arrives — but nothing said
        // idle and the process is alive, so the agent is obviously still working.
        // The freshness-based draft would have flickered this card to quiet.
        let out = resolve_one(
            &[a_claim("s1", 7)],
            &[("s1", a_beat("working", std::time::Duration::from_secs(5 * 60), Some(123)))],
            ALIVE,
        );
        assert_eq!(out[0].state, "working", "a long tool call must not read as quiet");
    }

    #[test]
    fn a_beat_past_the_ttl_is_quiet_even_if_the_pid_looks_alive() {
        // The backstop, for PID reuse: a recycled pid can look alive forever.
        let out = resolve_one(
            &[a_claim("s1", 7)],
            &[("s1", a_beat("working", LIVE_TTL + std::time::Duration::from_secs(1), Some(123)))],
            ALIVE,
        );
        assert_eq!(out[0].state, "quiet");
    }

    #[test]
    fn a_beat_without_a_pid_falls_back_to_the_ttl() {
        let fresh = resolve_one(
            &[a_claim("s1", 7)],
            &[("s1", a_beat("working", std::time::Duration::from_secs(1), None))],
            DEAD, // never consulted: there is no pid to check
        );
        assert_eq!(fresh[0].state, "working");
        let stale = resolve_one(
            &[a_claim("s1", 7)],
            &[("s1", a_beat("working", LIVE_TTL + std::time::Duration::from_secs(1), None))],
            ALIVE,
        );
        assert_eq!(stale[0].state, "quiet");
    }

    #[test]
    fn an_idle_beat_renders_as_quiet_and_idle_never_reaches_the_ui() {
        let out = resolve_one(
            &[a_claim("s1", 7)],
            &[("s1", a_beat("idle", std::time::Duration::from_secs(1), Some(123)))],
            ALIVE,
        );
        assert_eq!(out[0].state, "quiet", "idle is a wire value, not a card state");
    }

    #[test]
    fn a_blocked_beat_is_blocked() {
        let out = resolve_one(
            &[a_claim("s1", 7)],
            &[("s1", a_beat("blocked", std::time::Duration::from_secs(1), Some(123)))],
            ALIVE,
        );
        assert_eq!(out[0].state, "blocked");
    }

    #[test]
    fn a_claim_with_no_beat_at_all_is_quiet() {
        let out = resolve_one(&[a_claim("s1", 7)], &[], ALIVE);
        assert_eq!(out[0].state, "quiet");
        assert_eq!(out[0].at, "2026-07-17T10:00:00.000Z", "falls back to the claim time");
    }

    #[test]
    fn a_task_claimed_by_two_sessions_shows_the_liveliest() {
        // Pairing is legitimate. One agent working and one quiet means the task is
        // being worked on.
        let out = resolve_one(
            &[a_claim("s1", 7), a_claim("s2", 7)],
            &[
                ("s1", a_beat("idle", std::time::Duration::from_secs(1), Some(1))),
                ("s2", a_beat("working", std::time::Duration::from_secs(1), Some(2))),
            ],
            ALIVE,
        );
        assert_eq!(out.len(), 1, "one entry per task, not per session");
        assert_eq!(out[0].state, "working");
    }

    #[test]
    fn working_outranks_blocked_which_outranks_quiet() {
        let out = resolve_one(
            &[a_claim("s1", 7), a_claim("s2", 7)],
            &[
                ("s1", a_beat("blocked", std::time::Duration::from_secs(1), Some(1))),
                ("s2", a_beat("working", std::time::Duration::from_secs(1), Some(2))),
            ],
            ALIVE,
        );
        assert_eq!(out[0].state, "working");
    }

    #[test]
    fn an_unclaimed_sessions_beat_joins_no_card() {
        // The shared-cwd bug, at the resolution layer: sess-2 beats hard but claimed
        // nothing, so it lights up nothing. Keyed on cwd it would have lit up s1's.
        let out = resolve_one(
            &[a_claim("s1", 7)],
            &[
                ("s1", a_beat("idle", std::time::Duration::from_secs(1), Some(1))),
                ("s2", a_beat("working", std::time::Duration::from_secs(1), Some(2))),
            ],
            ALIVE,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].task_id, 7);
        assert_eq!(out[0].state, "quiet", "s2's beats must not touch s1's card");
    }

    #[test]
    fn presence_is_ordered_by_task_so_the_board_never_hops() {
        let out = resolve_one(&[a_claim("s1", 9), a_claim("s2", 3)], &[], ALIVE);
        assert_eq!(out.iter().map(|e| e.task_id).collect::<Vec<_>>(), vec![3, 9]);
    }

    #[test]
    fn the_latest_agent_log_line_rides_the_presence_read() {
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "Rebase it");
        work_on(&agent, id, "doing", Some("sess-1"), None, Some("wt-1"));
        {
            let conn = db.lock().unwrap();
            TildoneAgent::record_activity(&conn, id, "rebasing onto main, 2 conflicts", Some("claude"));
        }
        let conn = db.lock().unwrap();
        let claims = read_claims(&conn).unwrap();
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].last_log.as_deref(), Some("rebasing onto main, 2 conflicts"));
    }

    #[test]
    fn a_doing_write_with_a_session_id_claims_the_task() {
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "Ship item 7");
        let (is_err, _) = work_on(&agent, id, "doing", Some("sess-1"), Some("/w/foo"), Some("worktree-foo"));
        assert!(!is_err);
        let conn = db.lock().unwrap();
        let (task_id, branch, agent_name): (i64, String, String) = conn
            .query_row(
                "SELECT task_id, branch, agent_name FROM agent_claims WHERE session_id = 'sess-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(task_id, id);
        assert_eq!(branch, "worktree-foo");
        assert_eq!(agent_name, "claude");
    }

    #[test]
    fn a_doing_write_without_a_session_id_claims_nothing() {
        // A human dragging a card to Doing in the app is not a live session. So is an
        // agent that simply did not send one: no session, no claim, no presence.
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "Moved by hand");
        work_on(&agent, id, "doing", None, None, None);
        assert_eq!(claim_count(&db), 0);
    }

    #[test]
    fn an_empty_session_id_is_not_a_claim() {
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "Blank session");
        work_on(&agent, id, "doing", Some("   "), None, None);
        assert_eq!(claim_count(&db), 0, "a blank session id must not claim");
    }

    #[test]
    fn a_session_claiming_a_second_task_rebinds_rather_than_duplicating() {
        let (agent, db) = test_agent_with_db();
        let first = a_task(&agent, "First");
        let second = a_task(&agent, "Second");
        work_on(&agent, first, "doing", Some("sess-1"), None, None);
        work_on(&agent, second, "doing", Some("sess-1"), None, None);
        assert_eq!(claim_count(&db), 1, "a session claims at most one task");
        let task_id: i64 = db
            .lock()
            .unwrap()
            .query_row("SELECT task_id FROM agent_claims WHERE session_id = 'sess-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(task_id, second, "the newer claim wins");
    }

    #[test]
    fn re_asserting_the_same_task_refreshes_the_claim_rather_than_failing() {
        // dest_status is only set when the status CHANGES, so a second `doing` write
        // is a no-op for the task row. The claim must still refresh: that re-claim is
        // how a card recovers after the app restarts.
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "Long job");
        work_on(&agent, id, "doing", Some("sess-1"), None, Some("old-branch"));
        work_on(&agent, id, "doing", Some("sess-1"), None, Some("new-branch"));
        assert_eq!(claim_count(&db), 1);
        let branch: String = db
            .lock()
            .unwrap()
            .query_row("SELECT branch FROM agent_claims WHERE session_id = 'sess-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(branch, "new-branch");
    }

    #[test]
    fn two_sessions_may_claim_the_same_task() {
        // Pairing is legitimate; presence resolves to the liveliest of them.
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "Paired work");
        work_on(&agent, id, "doing", Some("sess-1"), None, None);
        work_on(&agent, id, "doing", Some("sess-2"), None, None);
        assert_eq!(claim_count(&db), 2);
    }

    #[test]
    fn completing_a_task_releases_its_claims() {
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "Ship item 7");
        work_on(&agent, id, "doing", Some("sess-1"), None, None);
        work_on(&agent, id, "doing", Some("sess-2"), None, None);
        work_on(&agent, id, "done", None, None, None);
        assert_eq!(claim_count(&db), 0, "done releases every claim on the task");
    }

    #[test]
    fn complete_task_also_releases_claims() {
        // complete_task routes through apply_task_update, so the release must come
        // for free rather than needing its own teardown.
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "Ship item 7");
        work_on(&agent, id, "doing", Some("sess-1"), None, None);
        let _ = agent.complete_task_as(TaskIdParams { id: id.into() }, Some("claude")).unwrap();
        assert_eq!(claim_count(&db), 0);
    }

    #[test]
    fn a_session_in_a_shared_cwd_that_claimed_nothing_owns_no_task() {
        // The bug the cwd-keyed draft would have shipped. Two sessions in the SAME
        // directory — the shared checkout, because read-only sessions are told not to
        // isolate — only one of which claimed. Keyed on cwd, the unclaimed session's
        // heartbeat would light up the other's card: a false "working", which is the
        // exact lie this feature exists to remove.
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "Claimed by sess-1");
        let shared = "/Users/x/projects/tildone";
        work_on(&agent, id, "doing", Some("sess-1"), Some(shared), None);

        let conn = db.lock().unwrap();
        // sess-2 lives in the very same cwd and claimed nothing.
        let owned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_claims WHERE session_id = 'sess-2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(owned, 0, "sess-2 claimed nothing, so it owns no card");
        // And the cwd alone resolves to more than one session, which is precisely why
        // it cannot be the key.
        let by_cwd: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_claims WHERE cwd = ?1", [shared], |r| r.get(0))
            .unwrap();
        assert_eq!(by_cwd, 1, "only the session that actually claimed is bound");
    }

    #[test]
    fn a_task_created_straight_into_doing_claims_it() {
        let (agent, db) = test_agent_with_db();
        let (is_err, task) = extract(
            &agent
                .create_task_as(
                    CreateTaskParams {
                        title: "Start immediately".into(),
                        project: None,
                        notes: None,
                        due_date: None,
                        priority: None,
                        tags: None,
                        session_id: Some("sess-9".into()),
                        cwd: None,
                        branch: Some("wt-9".into()),
                        status: Some("doing".into()),
                    },
                    Some("claude"),
                )
                .unwrap(),
        );
        assert!(!is_err, "create_task failed: {task}");
        let id = task["id"].as_i64().unwrap();
        let task_id: i64 = db
            .lock()
            .unwrap()
            .query_row("SELECT task_id FROM agent_claims WHERE session_id = 'sess-9'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(task_id, id);
    }

    #[test]
    fn a_task_created_as_todo_claims_nothing_even_with_a_session() {
        let (agent, db) = test_agent_with_db();
        let (is_err, _) = extract(
            &agent
                .create_task_as(
                    CreateTaskParams {
                        title: "Queued, not started".into(),
                        project: None,
                        notes: None,
                        due_date: None,
                        priority: None,
                        tags: None,
                        session_id: Some("sess-9".into()),
                        cwd: None,
                        branch: None,
                        status: None,
                    },
                    Some("claude"),
                )
                .unwrap(),
        );
        assert!(!is_err);
        assert_eq!(claim_count(&db), 0, "filing a task is not working on it");
    }

    #[test]
    fn deleting_a_task_cascades_its_claims_away() {
        // ON DELETE CASCADE, with foreign_keys ON — a claim must not outlive its task.
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "Doomed");
        work_on(&agent, id, "doing", Some("sess-1"), None, None);
        assert_eq!(claim_count(&db), 1);
        db.lock().unwrap().execute("DELETE FROM tasks WHERE id = ?1", [id]).unwrap();
        assert_eq!(claim_count(&db), 0);
    }

    fn attach(
        agent: &TildoneAgent,
        task_id: i64,
        url: &str,
        label: Option<&str>,
        kind: Option<&str>,
    ) -> (bool, Value) {
        extract(
            &agent
                .add_link_as(AddLinkParams {
                    task_id: task_id.into(),
                    url: url.into(),
                    label: label.map(Into::into),
                    kind: kind.map(Into::into),
                }, None)
                .unwrap(),
        )
    }

    #[test]
    fn add_link_attaches_an_https_url_and_get_task_returns_it() {
        let agent = test_agent();
        let id = a_task(&agent, "Ship item 7");
        let (is_err, link) = attach(
            &agent,
            id,
            "https://github.com/tanhxwork/tildone/pull/12",
            Some("PR #12"),
            Some("pr"),
        );
        assert!(!is_err, "add_link errored: {link}");
        assert_eq!(link["label"], "PR #12");
        assert_eq!(link["kind"], "pr");

        let (_, task) = extract(&agent.get_task(Parameters(TaskIdParams { id: id.into() })).unwrap());
        let links = task["links"].as_array().unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0]["url"], "https://github.com/tanhxwork/tildone/pull/12");
        assert_eq!(links[0]["kind"], "pr");
    }

    /// The whole security surface of the feature: an MCP tool that opens arbitrary
    /// URIs is a local-code-execution primitive. Only http(s) may pass, and a
    /// refusal writes nothing.
    #[test]
    fn add_link_refuses_non_http_schemes_and_writes_nothing() {
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "guard");
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:x@example.com",
            "ftp://example.com/x",
        ] {
            let (is_err, msg) = attach(&agent, id, bad, None, None);
            assert!(is_err, "expected refusal for {bad}, got {msg}");
        }
        let count: i64 = db
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM task_links", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "a refused link must write nothing");
    }

    #[test]
    fn add_link_on_a_trashed_task_is_refused() {
        let agent = test_agent();
        let id = a_task(&agent, "doomed");
        extract(&agent.delete_task(Parameters(TaskIdParams { id: id.into() })).unwrap());
        let (is_err, _) = attach(&agent, id, "https://example.com/x", None, None);
        assert!(is_err, "a link on a trashed task must be refused");
    }

    #[test]
    fn add_link_defaults_label_to_last_path_segment_and_explicit_label_wins() {
        let agent = test_agent();
        let id = a_task(&agent, "labels");
        let (_, defaulted) = attach(&agent, id, "https://github.com/x/y/pull/34", None, Some("pr"));
        assert_eq!(
            defaulted["label"], "34",
            "default label is the URL's last path segment"
        );
        let (_, explicit) = attach(
            &agent,
            id,
            "https://github.com/x/y/pull/35",
            Some("PR #35"),
            Some("pr"),
        );
        assert_eq!(explicit["label"], "PR #35", "an explicit label wins");
    }

    #[test]
    fn a_worktree_kind_is_accepted_and_unknown_kinds_refused() {
        let agent = test_agent();
        let id = a_task(&agent, "kinds");
        let (is_err, link) =
            attach(&agent, id, "https://example.com/wt", Some("item7"), Some("worktree"));
        assert!(!is_err, "worktree must be a valid kind: {link}");
        assert_eq!(link["kind"], "worktree");
        let (bad, _) = attach(&agent, id, "https://example.com/z", None, Some("banana"));
        assert!(bad, "an unknown kind must be refused");
    }

    #[test]
    fn deleting_a_task_cascades_its_links() {
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "cascade");
        attach(&agent, id, "https://example.com/a", None, None);
        attach(&agent, id, "https://example.com/b", None, None);
        let conn = db.lock().unwrap();
        // Hard delete — delete_task only trashes; the FK cascade is what we test.
        conn.execute("DELETE FROM tasks WHERE id = ?1", [id]).unwrap();
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task_links WHERE task_id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0, "links must cascade-delete with their task");
        let violations: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(violations, 0, "foreign_key_check must be clean");
    }

    #[test]
    fn delete_link_removes_it_and_missing_id_errors() {
        let agent = test_agent();
        let id = a_task(&agent, "remove");
        let (_, link) = attach(&agent, id, "https://example.com/a", None, None);
        let link_id = link["id"].as_i64().unwrap();
        let (is_err, _) =
            extract(&agent.delete_link_as(IdParams { id: link_id }, None).unwrap());
        assert!(!is_err);
        let (_, task) = extract(&agent.get_task(Parameters(TaskIdParams { id: id.into() })).unwrap());
        assert_eq!(task["links"].as_array().unwrap().len(), 0);
        let (missing, _) = extract(&agent.delete_link_as(IdParams { id: 9999 }, None).unwrap());
        assert!(missing, "deleting a non-existent link errors, not panics");
    }

    /// The change-feed trigger catches the attach so a parked agent wakes. It
    /// addresses the TASK (kind=link), because an agent parks on a task, not a link.
    #[test]
    fn attaching_a_link_lands_in_the_changes_feed() {
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "wake me");
        let before: i64 = db
            .lock()
            .unwrap()
            .query_row("SELECT COALESCE(MAX(id), 0) FROM changes", [], |r| r.get(0))
            .unwrap();
        attach(&agent, id, "https://github.com/x/y/pull/9", Some("PR #9"), Some("pr"));
        let conn = db.lock().unwrap();
        let row: (String, i64, String) = conn
            .query_row(
                "SELECT entity, entity_id, kind FROM changes WHERE id > ?1 ORDER BY id DESC LIMIT 1",
                [before],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            row,
            ("task".to_string(), id, "link".to_string()),
            "attaching a link must emit a change on the TASK with kind=link"
        );
    }

    // ---- item 5: comments on a card ----

    fn comment(agent: &TildoneAgent, task_id: i64, body: &str, as_agent: Option<&str>) -> (bool, Value) {
        extract(
            &agent
                .add_comment_as(
                    AddCommentParams { task_id: task_id.into(), body: body.into() },
                    as_agent,
                )
                .unwrap(),
        )
    }

    #[test]
    fn add_comment_appends_and_get_task_returns_it_attributed() {
        let agent = test_agent();
        let id = a_task(&agent, "Ship item 5");
        let (is_err, c) = comment(&agent, id, "  Which port should the dev build use?  ", Some("claude-code"));
        assert!(!is_err, "add_comment errored: {c}");
        assert_eq!(c["body"], "Which port should the dev build use?", "body is trimmed");
        assert_eq!(c["actor_kind"], "agent");
        assert_eq!(c["actor_name"], "claude-code");

        let (_, task) = extract(&agent.get_task(Parameters(TaskIdParams { id: id.into() })).unwrap());
        let comments = task["comments"].as_array().unwrap();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0]["body"], "Which port should the dev build use?");
        assert_eq!(comments[0]["actor_kind"], "agent");
        assert_eq!(comments[0]["actor_name"], "claude-code");
        let created = comments[0]["created_at"].as_str().unwrap();
        assert!(created.ends_with('Z'), "created_at must be ISO-UTC with a Z: {created}");
    }

    /// An agent that sent no client name is still an agent — kind='agent', name NULL —
    /// never silently promoted to a user, which the single-`actor` shape would risk.
    #[test]
    fn an_unnamed_agents_comment_is_agent_kind_with_null_name() {
        let agent = test_agent();
        let id = a_task(&agent, "anon");
        let (_, c) = comment(&agent, id, "no name here", None);
        assert_eq!(c["actor_kind"], "agent");
        assert!(c["actor_name"].is_null(), "an unnamed agent has a NULL name, not 'user'");
    }

    #[test]
    fn add_comment_refuses_an_empty_body_and_writes_nothing() {
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "empty");
        let (is_err, _) = comment(&agent, id, "   ", None);
        assert!(is_err, "a whitespace-only body must be refused");
        let count: i64 = db
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM comments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "a refused comment writes nothing");
    }

    #[test]
    fn add_comment_on_a_trashed_task_is_refused() {
        let agent = test_agent();
        let id = a_task(&agent, "doomed");
        agent.db.lock().unwrap().execute("UPDATE tasks SET deleted_at = ?1 WHERE id = ?2", rusqlite::params![now_iso(), id]).unwrap();
        let (is_err, _) = comment(&agent, id, "too late", None);
        assert!(is_err, "commenting on a trashed task is refused like every other write");
    }

    #[test]
    fn deleting_a_task_cascades_its_comments() {
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "cascade");
        comment(&agent, id, "one", None);
        comment(&agent, id, "two", None);
        let conn = db.lock().unwrap();
        conn.execute("DELETE FROM tasks WHERE id = ?1", [id]).unwrap();
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM comments WHERE task_id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0, "comments must cascade-delete with their task");
        let violations: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(violations, 0, "foreign_key_check stays clean");
    }

    /// The whole point of the feature: a comment wakes a parked agent. The trigger
    /// (migration 012) catches the write and addresses the TASK with kind=comment, so
    /// an agent parked on that task in list_changes returns and reads the thread.
    #[test]
    fn a_comment_lands_in_the_changes_feed() {
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "answer me");
        let before: i64 = db
            .lock()
            .unwrap()
            .query_row("SELECT COALESCE(MAX(id), 0) FROM changes", [], |r| r.get(0))
            .unwrap();
        comment(&agent, id, "here is your answer", Some("claude-code"));
        let conn = db.lock().unwrap();
        let row: (String, i64, String) = conn
            .query_row(
                "SELECT entity, entity_id, kind FROM changes WHERE id > ?1 ORDER BY id DESC LIMIT 1",
                [before],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            row,
            ("task".to_string(), id, "comment".to_string()),
            "a comment must emit a change on the TASK with kind=comment"
        );
    }

    // ---- change feed: tag changes (migration 015) ----

    /// Tagging addresses the TASK (kind=tag): an agent watching for needs-review
    /// parks on the board, and the tag arriving is the event it needs to see.
    #[test]
    fn tagging_and_untagging_land_in_the_changes_feed() {
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "review me");
        let cursor = |db: &Arc<Mutex<Connection>>| -> i64 {
            db.lock()
                .unwrap()
                .query_row("SELECT COALESCE(MAX(id), 0) FROM changes", [], |r| r.get(0))
                .unwrap()
        };
        let last_after = |db: &Arc<Mutex<Connection>>, before: i64| -> (String, i64, String) {
            db.lock()
                .unwrap()
                .query_row(
                    "SELECT entity, entity_id, kind FROM changes WHERE id > ?1 ORDER BY id DESC LIMIT 1",
                    [before],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap()
        };

        let before = cursor(&db);
        update(&agent, id, Some(vec!["needs-review"]), None);
        assert_eq!(
            last_after(&db, before),
            ("task".to_string(), id, "tag".to_string()),
            "adding a tag must emit a change on the TASK with kind=tag"
        );

        let before = cursor(&db);
        update(&agent, id, Some(vec![]), None);
        assert_eq!(
            last_after(&db, before),
            ("task".to_string(), id, "tag".to_string()),
            "removing a tag must emit a change on the TASK with kind=tag"
        );
    }

    /// 005's WHEN-guard lesson, applied to tags: set_tags is diff-aware, so a
    /// rewrite of an identical tag set (update_task replaces the full list)
    /// touches no task_tags rows and must not wake a parked agent.
    #[test]
    fn rewriting_an_identical_tag_set_emits_no_change() {
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "steady");
        update(&agent, id, Some(vec!["release", "Urgent"]), None);
        let before: i64 = db
            .lock()
            .unwrap()
            .query_row("SELECT COALESCE(MAX(id), 0) FROM changes", [], |r| r.get(0))
            .unwrap();
        // Same set, different order and case — resolves to the same tag rows.
        update(&agent, id, Some(vec!["urgent", "release"]), None);
        let after: i64 = db
            .lock()
            .unwrap()
            .query_row("SELECT COALESCE(MAX(id), 0) FROM changes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after, before, "an identical tag rewrite must emit no phantom change");
    }

    // ---- item 8: native notifications on complete / blocked / needs-review ----

    fn update(agent: &TildoneAgent, id: i64, tags: Option<Vec<&str>>, status: Option<&str>) {
        let (is_err, v) = extract(
            &agent
                .update_task_as(
                    UpdateTaskParams {
                        id: id.into(),
                        title: None,
                        notes: None,
                        status: status.map(Into::into),
                        priority: None,
                        due_date: None,
                        project: None,
                        tags: tags.map(|t| t.into_iter().map(Into::into).collect()),
                        session_id: None,
                        cwd: None,
                        branch: None,
                    },
                    None,
                )
                .unwrap(),
        );
        assert!(!is_err, "update_task errored: {v}");
    }

    #[test]
    fn completing_a_task_notifies_the_user() {
        let (agent, fired) = test_agent_with_notifications();
        let id = a_task(&agent, "Ship item 8");
        extract(&agent.complete_task_as(TaskIdParams { id: id.into() }, None).unwrap());
        assert_eq!(
            *fired.lock().unwrap(),
            vec![(
                "Task done".to_string(),
                "INBOX-1 · Ship item 8".to_string(),
                Some("INBOX-1".to_string()),
            )],
            "the body leads with the ref and the ref rides along for click-through",
        );
    }

    #[test]
    fn adding_the_blocked_tag_notifies_once_not_on_re_add() {
        let (agent, fired) = test_agent_with_notifications();
        let id = a_task(&agent, "Needs a decision");
        update(&agent, id, Some(vec!["blocked"]), None);
        assert_eq!(
            *fired.lock().unwrap(),
            vec![(
                "Blocked".to_string(),
                "INBOX-1 · Needs a decision".to_string(),
                Some("INBOX-1".to_string()),
            )],
        );
        // Re-applying a tag set that still contains blocked is not a transition — the
        // task was already blocked. No second ping (the WHEN-guard lesson).
        update(&agent, id, Some(vec!["blocked"]), None);
        assert_eq!(
            fired.lock().unwrap().len(),
            1,
            "re-adding an already-present blocked tag must not notify again",
        );
    }

    #[test]
    fn adding_needs_review_notifies() {
        let (agent, fired) = test_agent_with_notifications();
        let id = a_task(&agent, "Review me");
        update(&agent, id, Some(vec!["needs-review"]), None);
        assert_eq!(
            *fired.lock().unwrap(),
            vec![(
                "Needs review".to_string(),
                "INBOX-1 · Review me".to_string(),
                Some("INBOX-1".to_string()),
            )],
        );
    }

    /// The design in one test: the SAME state change (a task reaching Done) notifies
    /// when an agent makes it, and is silent when the user does. The user's drag writes
    /// SQLite directly (store.ts applyPositions), never through apply_task_update — so
    /// it cannot reach the notify path, by construction.
    #[test]
    fn a_users_own_drag_to_done_notifies_nothing() {
        let (agent, fired) = test_agent_with_notifications();
        let id = a_task(&agent, "I dragged this myself");
        agent
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE tasks SET status = 'done', completed_at = ?1 WHERE id = ?2",
                rusqlite::params![now_iso(), id],
            )
            .unwrap();
        assert!(
            fired.lock().unwrap().is_empty(),
            "a write that bypasses the MCP server must not notify the user",
        );
    }

    /// `unseen_at` for a task, straight from the row.
    fn unseen_at(agent: &TildoneAgent, id: i64) -> Option<String> {
        agent
            .db
            .lock()
            .unwrap()
            .query_row("SELECT unseen_at FROM tasks WHERE id = ?1", [id], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn an_agent_status_change_marks_the_card_unseen() {
        let (agent, _) = test_agent_with_notifications();
        let id = a_task(&agent, "Moved while you were out");
        assert!(unseen_at(&agent, id).is_none(), "a fresh task is not unseen");
        update(&agent, id, None, Some("doing"));
        assert!(
            unseen_at(&agent, id).is_some(),
            "an agent moving a task must leave a mark on the card",
        );
    }

    #[test]
    fn an_agent_flagging_needs_review_marks_the_card_unseen() {
        let (agent, _) = test_agent_with_notifications();
        let id = a_task(&agent, "Review me");
        update(&agent, id, Some(vec!["needs-review"]), None);
        assert!(
            unseen_at(&agent, id).is_some(),
            "being asked for review is the whole reason the mark exists",
        );
    }

    /// The mark's reason for existing, as a test: the SAME state change marks the
    /// card when an agent makes it and leaves it clean when the user does. If you
    /// dragged it, you saw it — a mark you caused yourself is noise, and noise is
    /// what makes people stop reading marks.
    ///
    /// Agent-only by construction, not by an actor check: the user's drag writes
    /// SQLite directly (store.ts applyDrag) and never reaches apply_task_update.
    /// Same construction `a_users_own_drag_to_done_notifies_nothing` relies on.
    #[test]
    fn a_users_own_drag_never_marks_its_own_card() {
        let (agent, _) = test_agent_with_notifications();
        let id = a_task(&agent, "I dragged this myself");
        agent
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE tasks SET status = 'done', completed_at = ?1 WHERE id = ?2",
                rusqlite::params![now_iso(), id],
            )
            .unwrap();
        assert!(
            unseen_at(&agent, id).is_none(),
            "a write that bypasses the MCP server must not mark the card",
        );
    }

    #[test]
    fn progress_is_not_a_call_to_action_and_does_not_mark() {
        let (agent, _) = test_agent_with_notifications();
        let id = a_task(&agent, "Just editing");
        // A tag that is not reserved, and a note. Real changes; neither asks
        // anything of the user, and the card already shows its own progress.
        update(&agent, id, Some(vec!["someday"]), None);
        assert!(
            unseen_at(&agent, id).is_none(),
            "only a status change or a needs-review flag earns a mark",
        );
    }

    /// Opening a card must not look like board activity. The UI clears unseen_at
    /// and nothing else; if any trigger ever watched that column, reading your own
    /// board would wake every agent parked in list_changes(wait_ms).
    #[test]
    fn writing_the_unseen_mark_is_invisible_to_the_changes_feed() {
        let (agent, _) = test_agent_with_notifications();
        let id = a_task(&agent, "Flag me");
        update(&agent, id, Some(vec!["needs-review"]), None);
        agent.db.lock().unwrap().execute("DELETE FROM changes", []).unwrap();

        // Byte-for-byte what store.ts markSeen emits when you leave the card.
        agent
            .db
            .lock()
            .unwrap()
            .execute("UPDATE tasks SET unseen_at = NULL WHERE id = ?1", [id])
            .unwrap();

        let rows: i64 = agent
            .db
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM changes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "clearing the mark must append nothing to the feed");
    }

    #[test]
    fn an_ordinary_edit_does_not_notify() {
        let (agent, fired) = test_agent_with_notifications();
        let id = a_task(&agent, "Just editing");
        // Move to In Progress and set a priority — real changes, none notify-worthy.
        update(&agent, id, None, Some("doing"));
        update(&agent, id, Some(vec!["someday"]), None);
        assert!(
            fired.lock().unwrap().is_empty(),
            "only done / blocked / needs-review notify; other edits stay quiet",
        );
    }

    /// The capstone where items 5 and 8 meet: an agent's real flow is to comment its
    /// question and then tag the task blocked, so the block notification carries that
    /// comment — the user reads the actual ask on the banner, not a bare title.
    #[test]
    fn a_flagged_task_notifies_with_its_newest_comment() {
        let (agent, fired) = test_agent_with_notifications();
        let id = a_task(&agent, "Ship the API");
        comment(&agent, id, "Which port should the dev build use?", Some("claude-code"));
        update(&agent, id, Some(vec!["blocked"]), None);
        assert_eq!(
            *fired.lock().unwrap(),
            vec![(
                "Blocked".to_string(),
                "INBOX-1 · Ship the API — Which port should the dev build use?".to_string(),
                Some("INBOX-1".to_string()),
            )],
            "a blocked task with a comment surfaces that comment in the notification body",
        );
    }

    /// A flagged task with no comment falls back to the bare title — the newest-comment
    /// enrichment must never turn an empty thread into a dangling separator.
    #[test]
    fn a_flagged_task_with_no_comment_falls_back_to_the_title() {
        let (agent, fired) = test_agent_with_notifications();
        let id = a_task(&agent, "Review me");
        update(&agent, id, Some(vec!["needs-review"]), None);
        assert_eq!(
            *fired.lock().unwrap(),
            vec![(
                "Needs review".to_string(),
                "INBOX-1 · Review me".to_string(),
                Some("INBOX-1".to_string()),
            )],
            "no comment → the body is the titled ref alone, no trailing separator",
        );
    }

    /// The deep-link parser in one table: exactly `tildone://task/<REF>` (trailing
    /// slash tolerated, host case-insensitive) yields a ref; everything else — other
    /// hosts, extra segments, empty refs, other schemes — is None, because the
    /// handler's contract is "never error at the user, just show the window".
    #[test]
    fn deep_link_parsing_accepts_task_refs_and_nothing_else() {
        assert_eq!(deep_link_task_ref("tildone://task/TIL-3"), Some("TIL-3".into()));
        assert_eq!(deep_link_task_ref("tildone://task/TIL-3/"), Some("TIL-3".into()));
        assert_eq!(deep_link_task_ref("tildone://TASK/INBOX-12"), Some("INBOX-12".into()));
        assert_eq!(deep_link_task_ref("tildone://task/"), None);
        assert_eq!(deep_link_task_ref("tildone://task"), None);
        assert_eq!(deep_link_task_ref("tildone://project/TIL"), None);
        assert_eq!(deep_link_task_ref("tildone://task/TIL-3/extra"), None);
        assert_eq!(deep_link_task_ref("https://task/TIL-3"), None);
    }

    /// AGENT_PORT is a contract: an agent's MCP config points at a fixed URL, so
    /// the installed app must own it and nothing else may squat on it. A dev build
    /// or a worktree that grabbed it first would take the installed app's board
    /// down — silently, since the frontend discards the bind error.
    #[test]
    fn only_a_release_build_asks_for_the_installed_apps_port() {
        assert_eq!(
            resolve_port(None, false),
            AGENT_PORT,
            "a release build IS the installed app and must own 11502"
        );
        assert_eq!(
            resolve_port(None, true),
            0,
            "a dev build must ask the OS for a free port (0), never AGENT_PORT — \
             otherwise two worktrees fight each other and the installed app"
        );
        assert_ne!(resolve_port(None, true), AGENT_PORT);

        // The escape hatch: pointing an agent at a dev build needs a known port.
        assert_eq!(resolve_port(Some("11599"), true), 11599);
        assert_eq!(resolve_port(Some("  11599  "), true), 11599);

        // Junk must not silently become port 0 in a release build; fall through.
        assert_eq!(resolve_port(Some("not-a-port"), false), AGENT_PORT);
        assert_eq!(resolve_port(Some("70000"), true), 0);
    }

    /// The gap resolve_port cannot close: a RELEASE build built in a worktree also
    /// asks for 11502, so it silently steals the installed app's board. We keep
    /// binding (a relocated install is legitimate) but warn — this is exactly when.
    #[test]
    fn warns_when_a_release_build_outside_applications_claims_the_port() {
        // The squatter: release build, defaulted onto 11502, not in /Applications.
        assert!(should_warn_port_squat(false, AGENT_PORT, None, false));

        // The installed app: same port, but under /Applications — no warning.
        assert!(!should_warn_port_squat(false, AGENT_PORT, None, true));

        // A dev build never claims 11502, so it is never the squatter.
        assert!(!should_warn_port_squat(true, 0, None, false));

        // An explicit override to 11502 is a deliberate choice, not an accident.
        assert!(!should_warn_port_squat(false, AGENT_PORT, Some(AGENT_PORT), false));

        // An explicit override to some *other* port means we aren't on 11502 at all.
        assert!(!should_warn_port_squat(false, 11599, Some(11599), false));
    }

    /// We shipped `tools: {}` for months, which tells every client "my tool list
    /// never changes" — so a spec-abiding client may cache it forever. That is
    /// the defect behind `append_note` being invisible to a live session while
    /// the server already served it. Nothing asserted on the declaration, so
    /// nothing caught it; this is that assertion.
    #[test]
    fn declares_tool_list_changed_capability() {
        let caps = test_agent().get_info().capabilities;
        let tools = caps.tools.expect("tools capability must be declared");
        assert_eq!(
            tools.list_changed,
            Some(true),
            "server must advertise tools.listChanged; without it a client is \
             entitled to cache the tool list across a reconnect and never see \
             tools added by an app upgrade"
        );
    }

    /// created_at must match completed_at's format. The column DEFAULT
    /// `datetime('now')` still emits a bare, marker-less UTC string, so every
    /// writer has to pass created_at explicitly — this is the guard for that.
    #[test]
    fn created_at_is_iso_utc_for_every_writer() {
        let (agent, db) = test_agent_with_db();
        extract(
            &agent
                .create_project(Parameters(CreateProjectParams {
                    name: "Work".into(),
                    color: None,
                }))
                .unwrap(),
        );
        extract(
            &agent
                .create_task_as(CreateTaskParams {
                    title: "Ship it".into(),
                    project: Some("Work".into()),
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: None,
                }, None)
                .unwrap(),
        );

        let conn = db.lock().unwrap();
        for table in ["projects", "tasks", "task_activity"] {
            let ts: String = conn
                .query_row(&format!("SELECT created_at FROM {table} LIMIT 1"), [], |r| r.get(0))
                .unwrap_or_else(|e| panic!("{table}: no created_at row ({e})"));
            assert!(
                ts.contains('T') && ts.ends_with('Z'),
                "{table}.created_at is not ISO-8601 UTC: {ts}"
            );
        }
    }

    /// append_note exists so a progress log costs the same whether the notes
    /// are empty or 4KB, and so it *cannot* clobber history the way a blind
    /// update_task can.
    #[test]
    fn append_note_appends_and_never_clobbers() {
        let agent = test_agent();
        let (_, task) = extract(
            &agent
                .create_task_as(CreateTaskParams {
                    title: "Logged work".into(),
                    project: None,
                    notes: Some("Goal: ship it".into()),
                    due_date: None,
                    priority: None,
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: None,
                }, None)
                .unwrap(),
        );
        let id = task["id"].as_i64().unwrap();

        let (is_err, ack) = extract(
            &agent
                .append_note(Parameters(AppendNoteParams {
                    id: id.into(),
                    text: "- 00:01 started".into(),
                }))
                .unwrap(),
        );
        assert!(!is_err, "append_note failed: {ack}");
        // Receipt carries a size hint, never the notes themselves.
        assert!(ack.get("notes").is_none(), "append must not echo notes: {ack}");
        assert_eq!(ack["notes_chars"], "Goal: ship it\n- 00:01 started".chars().count());

        extract(
            &agent
                .append_note(Parameters(AppendNoteParams {
                    id: id.into(),
                    text: "- 00:02 done".into(),
                }))
                .unwrap(),
        );

        let (_, full) = extract(&agent.get_task(Parameters(TaskIdParams { id: id.into() })).unwrap());
        assert_eq!(
            full["notes"], "Goal: ship it\n- 00:01 started\n- 00:02 done",
            "earlier notes must survive verbatim"
        );

        // Unknown and trashed ids are tool errors, not silent no-ops.
        let (is_err, msg) = extract(
            &agent
                .append_note(Parameters(AppendNoteParams {
                    id: 9999_i64.into(),
                    text: "x".into(),
                }))
                .unwrap(),
        );
        assert!(is_err, "unknown id must error: {msg}");

        extract(&agent.delete_task(Parameters(TaskIdParams { id: id.into() })).unwrap());
        let (is_err, msg) = extract(
            &agent
                .append_note(Parameters(AppendNoteParams { id: id.into(), text: "x".into() }))
                .unwrap(),
        );
        assert!(is_err && msg.as_str().unwrap().contains("trash"), "{msg}");
    }

    /// Rows written before 004 carry SQLite's "YYYY-MM-DD HH:MM:SS"; the
    /// migration must rewrite them in place without touching valid rows.
    #[test]
    fn migration_004_backfills_legacy_timestamps() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/001_init.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/002_trash.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/003_subtasks_activity.sql")).unwrap();
        conn.execute(
            "INSERT INTO tasks (title, created_at) VALUES ('legacy', '2026-07-15 16:01:11')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (title, created_at) VALUES ('already-iso', '2026-07-15T16:01:11.500Z')",
            [],
        )
        .unwrap();

        conn.execute_batch(include_str!("../migrations/004_iso_timestamps.sql")).unwrap();

        let legacy: String = conn
            .query_row("SELECT created_at FROM tasks WHERE title='legacy'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(legacy, "2026-07-15T16:01:11.000Z", "legacy row not normalised");

        let untouched: String = conn
            .query_row("SELECT created_at FROM tasks WHERE title='already-iso'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            untouched, "2026-07-15T16:01:11.500Z",
            "already-ISO row must be left alone (millis preserved)"
        );
    }

    #[test]
    fn task_lifecycle_via_tools() {
        let agent = test_agent();

        // Project must exist before tasks can target it.
        let (is_err, v) = extract(
            &agent
                .create_task_as(CreateTaskParams {
                    title: "Ship it".into(),
                    project: Some("Work".into()),
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: None,
                }, None)
                .unwrap(),
        );
        assert!(is_err, "unknown project must be a tool error: {v}");
        assert!(v.as_str().unwrap().contains("Unknown project"));

        let (is_err, project) = extract(
            &agent
                .create_project(Parameters(CreateProjectParams {
                    name: "Work".into(),
                    color: None,
                }))
                .unwrap(),
        );
        assert!(!is_err);
        assert_eq!(project["name"], "Work");

        // Create under the project by name, with tags + due date + priority.
        let (is_err, task) = extract(
            &agent
                .create_task_as(CreateTaskParams {
                    title: "Ship it".into(),
                    project: Some("work".into()), // case-insensitive
                    notes: Some("the big one".into()),
                    due_date: Some("2026-07-10".into()),
                    priority: Some(3),
                    tags: Some(vec!["release".into()]),
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: None,
                }, None)
                .unwrap(),
        );
        assert!(!is_err, "create_task failed: {task}");
        assert_eq!(task["title"], "Ship it");
        assert_eq!(task["status"], "todo");
        let id = task["id"].as_i64().unwrap();

        // The write returns a receipt, not the row — so verify what actually
        // persisted via get_task rather than trusting the response echo.
        let (_, full) = extract(&agent.get_task(Parameters(TaskIdParams { id: id.into() })).unwrap());
        assert_eq!(full["project"]["name"], "Work");
        assert_eq!(full["tags"][0], "release");
        assert_eq!(full["priority"], 3);
        assert_eq!(full["notes"], "the big one");

        // Inbox task (no project) gets position 0 in its own group.
        let (_, inbox_task) = extract(
            &agent
                .create_task_as(CreateTaskParams {
                    title: "Loose end".into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: None,
                }, None)
                .unwrap(),
        );
        assert_eq!(inbox_task["project"], Value::Null);

        // list_tasks project filter: "inbox" vs name.
        let (_, listed) = extract(
            &agent
                .list_tasks(Parameters(ListTasksParams {
                    project: Some("inbox".into()),
                    status: None,
                    due_before: None,
                    tag: None,
                    search: None,
                    include_done: None,
                }))
                .unwrap(),
        );
        assert_eq!(listed["count"], 1);
        assert_eq!(listed["tasks"][0]["title"], "Loose end");

        // complete_task sets completed_at; done tasks drop out of default list.
        let (is_err, done) = extract(
            &agent.complete_task_as(TaskIdParams { id: id.into() }, None).unwrap(),
        );
        assert!(!is_err);
        assert_eq!(done["status"], "done");
        assert!(done["completed_at"].as_str().unwrap().contains('T'));
        let (_, listed) = extract(
            &agent
                .list_tasks(Parameters(ListTasksParams {
                    project: Some("Work".into()),
                    status: None,
                    due_before: None,
                    tag: None,
                    search: None,
                    include_done: None,
                }))
                .unwrap(),
        );
        assert_eq!(listed["count"], 0, "done tasks excluded by default");

        // update_task: back to todo clears completed_at, move to inbox.
        let (_, updated) = extract(
            &agent
                .update_task_as(UpdateTaskParams {
                    id: id.into(),
                    title: None,
                    notes: None,
                    status: Some("todo".into()),
                    priority: Some(0),
                    due_date: Some("".into()),
                    project: Some("inbox".into()),
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                }, None)
                .unwrap(),
        );
        assert_eq!(updated["status"], "todo");
        assert_eq!(updated["completed_at"], Value::Null);
        assert_eq!(updated["due_date"], Value::Null);
        assert_eq!(updated["project"], Value::Null);

        // delete_task is a soft delete; further updates are refused.
        let (is_err, msg) = extract(&agent.delete_task(Parameters(TaskIdParams { id: id.into() })).unwrap());
        assert!(!is_err, "{msg}");
        let (is_err, msg) = extract(
            &agent.complete_task_as(TaskIdParams { id: id.into() }, None).unwrap(),
        );
        assert!(is_err);
        assert!(msg.as_str().unwrap().contains("trash"));

        // Activity got recorded like the app does.
        let conn = agent.db.lock().unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task_activity WHERE task_id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(n >= 2, "expected creation + status activity, got {n}");
    }

    /// The canonical board-protocol skeleton, where `## Evidence` is last.
    const CANONICAL_NOTES: &str = "Goal: ship it\n\n\
         ## Plan\n- [x] write failing test\n- [ ] implement\n\n\
         ## Log\n- 14:20 started\n\n\
         ## Evidence\n- tests: 12 passed\n";

    /// Characterization test: pins WHY `log_progress` exists.
    ///
    /// `append_note` is strict end-concatenation, so against real notes — where
    /// `## Evidence` is the last section — a log line lands under `## Evidence`
    /// rather than `## Log`. The older test appends to notes of "Goal: ship it",
    /// which has no headings at all, so it never exercises this shape.
    ///
    /// This asserts today's behaviour, not desired behaviour. The fix is not to
    /// make `append_note` section-aware — it is to stop keeping a log in `notes`
    /// at all and use `log_progress`, after which appends are only ever prose and
    /// end-concatenation is correct. If someone does make it section-aware, this
    /// test should fail and be deleted deliberately.
    #[test]
    fn append_note_cannot_target_a_section_in_canonical_notes() {
        let agent = test_agent();
        let (_, task) = extract(
            &agent
                .create_task_as(CreateTaskParams {
                    title: "Logged work".into(),
                    project: None,
                    notes: Some(CANONICAL_NOTES.into()),
                    due_date: None,
                    priority: None,
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: None,
                }, None)
                .unwrap(),
        );
        let id = task["id"].as_i64().unwrap();

        extract(
            &agent
                .append_note(Parameters(AppendNoteParams {
                    id: id.into(),
                    text: "- 14:32 tests written (RED, 5 failing)".into(),
                }))
                .unwrap(),
        );

        let (_, full) = extract(&agent.get_task(Parameters(TaskIdParams { id: id.into() })).unwrap());
        let notes = full["notes"].as_str().unwrap();
        let evidence_at = notes.find("## Evidence").unwrap();
        let appended_at = notes.find("- 14:32 tests written").unwrap();
        assert!(
            appended_at > evidence_at,
            "append_note is end-only, so the log line lands under ## Evidence — \
             this is the limitation log_progress removes. notes:\n{notes}"
        );
    }

    /// The log half of a checkpoint: narrative goes to the Activity feed, and
    /// `notes` are left completely alone — that is the whole point, since resending
    /// the notes blob is what a checkpoint used to cost.
    #[test]
    fn log_progress_records_activity_and_never_touches_notes() {
        let agent = test_agent();
        let (_, task) = extract(
            &agent
                .create_task_as(CreateTaskParams {
                    title: "Build it".into(),
                    project: None,
                    notes: Some(CANONICAL_NOTES.into()),
                    due_date: None,
                    priority: None,
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: None,
                }, None)
                .unwrap(),
        );
        let id = task["id"].as_i64().unwrap();

        let (is_err, ack) = extract(
            &agent
                .log_progress_as(LogProgressParams {
                    task_id: id.into(),
                    text: "  tests written (RED, 5 failing)  ".into(),
                }, None)
                .unwrap(),
        );
        assert!(!is_err, "log_progress failed: {ack}");
        assert_eq!(ack["logged"], "tests written (RED, 5 failing)", "text is trimmed");
        assert!(ack.get("notes").is_none(), "a receipt must not echo notes: {ack}");

        // The entry is in the feed the app already renders, verbatim.
        let conn = agent.db.lock().unwrap();
        let logged: String = conn
            .query_row(
                "SELECT label FROM task_activity WHERE task_id = ?1 ORDER BY id DESC LIMIT 1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        drop(conn);
        assert_eq!(logged, "tests written (RED, 5 failing)");

        // notes are byte-identical: the log cost nothing in notes traffic.
        let (_, full) = extract(&agent.get_task(Parameters(TaskIdParams { id: id.into() })).unwrap());
        assert_eq!(full["notes"].as_str().unwrap(), CANONICAL_NOTES);
    }

    #[test]
    fn log_progress_rejects_empty_unknown_and_trashed() {
        let agent = test_agent();
        let (_, task) = extract(
            &agent
                .create_task_as(CreateTaskParams {
                    title: "Build it".into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: None,
                }, None)
                .unwrap(),
        );
        let id = task["id"].as_i64().unwrap();

        let (is_err, _) = extract(
            &agent
                .log_progress_as(LogProgressParams {
                    task_id: id.into(),
                    text: "   ".into(),
                }, None)
                .unwrap(),
        );
        assert!(is_err, "empty log text must be refused");

        let (is_err, _) = extract(
            &agent
                .log_progress_as(LogProgressParams {
                    task_id: 999_999_i64.into(),
                    text: "ghost".into(),
                }, None)
                .unwrap(),
        );
        assert!(is_err, "unknown task must be refused");

        // Same rule the subtask writes follow: a trashed task takes no writes.
        extract(&agent.delete_task(Parameters(TaskIdParams { id: id.into() })).unwrap());
        let (is_err, out) = extract(
            &agent
                .log_progress_as(LogProgressParams {
                    task_id: id.into(),
                    text: "still going".into(),
                }, None)
                .unwrap(),
        );
        assert!(is_err, "trashed task must refuse a log entry: {out}");
    }

    /// The subtask lifecycle an agent drives: add, tick, read back, delete —
    /// and refuse once the parent is trashed, the rule append_note set.
    #[test]
    fn subtask_writes_and_progress() {
        let agent = test_agent();
        let (_, task) = extract(
            &agent
                .create_task_as(CreateTaskParams {
                    title: "Build it".into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: None,
                }, None)
                .unwrap(),
        );
        let task_id = task["id"].as_i64().unwrap();

        let mut ids = Vec::new();
        for title in ["write test", "implement", "verify"] {
            let (is_err, out) = extract(
                &agent
                    .add_subtask_as(AddSubtaskParams {
                        task_id: task_id.into(),
                        title: title.into(),
                    }, None)
                    .unwrap(),
            );
            assert!(!is_err, "add_subtask failed: {out}");
            ids.push(out["id"].as_i64().unwrap());
        }

        let (_, out) = extract(
            &agent
                .set_subtask_as(SetSubtaskParams {
                    id: ids[0],
                    done: Some(true),
                    title: None,
                }, None)
                .unwrap(),
        );
        assert_eq!(out["progress"]["done"], 1);
        assert_eq!(out["progress"]["total"], 3);

        // Order is insertion order, and the tick is visible to the next reader.
        let (_, full) = extract(&agent.get_task(Parameters(TaskIdParams { id: task_id.into() })).unwrap());
        let subs = full["subtasks"].as_array().unwrap();
        assert_eq!(subs.len(), 3);
        assert_eq!(subs[0]["title"], "write test");
        assert_eq!(subs[0]["done"], true);
        assert_eq!(subs[2]["title"], "verify");

        let (_, out) = extract(
            &agent
                .delete_subtask_as(IdParams { id: ids[2] }, None)
                .unwrap(),
        );
        assert_eq!(out["progress"]["total"], 2);

        // Untick walks progress back down.
        let (_, out) = extract(
            &agent
                .set_subtask_as(SetSubtaskParams {
                    id: ids[0],
                    done: Some(false),
                    title: None,
                }, None)
                .unwrap(),
        );
        assert_eq!(out["progress"]["done"], 0);

        agent
            .delete_task(Parameters(TaskIdParams { id: task_id.into() }))
            .unwrap();
        let (is_err, _) = extract(
            &agent
                .set_subtask_as(SetSubtaskParams {
                    id: ids[1],
                    done: Some(true),
                    title: None,
                }, None)
                .unwrap(),
        );
        assert!(is_err, "a trashed parent must refuse subtask writes");
    }

    /// Verify steps ("verify: …" subtasks) are the review checklist the agent
    /// proposes and the USER walks: an MCP tick is refused — a tick asserts
    /// "I checked this on my machine" — while add, rename, untick and delete
    /// stay open, and plain subtasks are untouched by the rule.
    #[test]
    fn verify_steps_refuse_agent_ticks_but_stay_editable() {
        let (agent, db) = test_agent_with_db();
        let id = a_task(&agent, "review me");

        let add = |title: &str| -> i64 {
            let (is_err, out) = extract(
                &agent
                    .add_subtask_as(
                        AddSubtaskParams {
                            task_id: id.into(),
                            title: title.into(),
                        },
                        Some("claude"),
                    )
                    .unwrap(),
            );
            assert!(!is_err, "add_subtask failed: {out}");
            out["id"].as_i64().unwrap()
        };
        let verify = add("verify: paste a long URL — pane must not widen");
        let normal = add("build the thing");

        // The tick is refused, and refused BEFORE any write.
        let (is_err, out) = extract(
            &agent
                .set_subtask_as(
                    SetSubtaskParams {
                        id: verify,
                        done: Some(true),
                        title: None,
                    },
                    Some("claude"),
                )
                .unwrap(),
        );
        assert!(is_err, "an agent tick on a verify step must be refused: {out}");
        let done: i64 = db
            .lock()
            .unwrap()
            .query_row("SELECT done FROM subtasks WHERE id = ?1", [verify], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(done, 0, "the refused tick must not have written");

        // Renaming AWAY from the prefix while ticking is refused too — one call
        // must not both strip the guard and claim the check.
        let (is_err, _) = extract(
            &agent
                .set_subtask_as(
                    SetSubtaskParams {
                        id: verify,
                        done: Some(true),
                        title: Some("just a step now".into()),
                    },
                    Some("claude"),
                )
                .unwrap(),
        );
        assert!(is_err, "rename-away-from-verify + tick in one call must be refused");
        let kept_verify: String = db
            .lock()
            .unwrap()
            .query_row("SELECT title FROM subtasks WHERE id = ?1", [verify], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(
            TildoneAgent::is_verify_title(&kept_verify),
            "the refused rename-away must not have written"
        );

        // The guard also reads the REQUESTED title, so rename-to-verify + tick
        // in one call is refused whole — nothing half-applied.
        let (is_err, _) = extract(
            &agent
                .set_subtask_as(
                    SetSubtaskParams {
                        id: normal,
                        done: Some(true),
                        title: Some("Verify: now it is a step".into()),
                    },
                    Some("claude"),
                )
                .unwrap(),
        );
        assert!(is_err, "rename-to-verify + tick in one call must be refused");
        let kept: String = db
            .lock()
            .unwrap()
            .query_row("SELECT title FROM subtasks WHERE id = ?1", [normal], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(kept, "build the thing", "the refused rename must not have written");

        // Rename and untick stay open.
        let (is_err, _) = extract(
            &agent
                .set_subtask_as(
                    SetSubtaskParams {
                        id: verify,
                        done: None,
                        title: Some("verify: resize to 900px".into()),
                    },
                    Some("claude"),
                )
                .unwrap(),
        );
        assert!(!is_err, "renaming a verify step must stay allowed");
        let (is_err, _) = extract(
            &agent
                .set_subtask_as(
                    SetSubtaskParams {
                        id: verify,
                        done: Some(false),
                        title: None,
                    },
                    Some("claude"),
                )
                .unwrap(),
        );
        assert!(!is_err, "unticking a verify step must stay allowed");

        // A plain subtask still ticks over MCP.
        let (is_err, _) = extract(
            &agent
                .set_subtask_as(
                    SetSubtaskParams {
                        id: normal,
                        done: Some(true),
                        title: None,
                    },
                    Some("claude"),
                )
                .unwrap(),
        );
        assert!(!is_err, "a plain subtask tick must still work");

        // Delete stays open too — the checklist is the agent's to shape, only
        // the ticks are the user's.
        let (is_err, _) = extract(
            &agent
                .delete_subtask_as(IdParams { id: verify }, Some("claude"))
                .unwrap(),
        );
        assert!(!is_err, "deleting a verify step must stay allowed");
    }

    /// The board is the queue: list_tasks must return what the user sees, so a
    /// task ranked top comes first even when a lower one is years overdue. Due
    /// date led this ORDER BY until now, which made "the top task" the most
    /// overdue one instead of the top card.
    #[test]
    fn list_tasks_returns_board_order_not_due_order() {
        let agent = test_agent();
        for (title, due) in [("top", "2099-01-01"), ("bottom", "2000-01-01")] {
            agent
                .create_task_as(CreateTaskParams {
                    title: title.into(),
                    project: None,
                    notes: None,
                    due_date: Some(due.into()),
                    priority: None,
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: None,
                }, None)
                .unwrap();
        }
        let (_, out) = extract(&agent.list_tasks(Parameters(ListTasksParams::default())).unwrap());
        let tasks = out["tasks"].as_array().unwrap();
        assert_eq!(tasks[0]["title"], "top", "board order must beat due date");
        assert_eq!(tasks[0]["rank"], 0);
        assert_eq!(tasks[1]["title"], "bottom");
        assert_eq!(tasks[1]["rank"], 1);

        // due_before is how a caller asks for overdue work now.
        let (_, overdue) = extract(
            &agent
                .list_tasks(Parameters(ListTasksParams {
                    due_before: Some("2026-07-16".into()),
                    ..Default::default()
                }))
                .unwrap(),
        );
        assert_eq!(overdue["count"], 1);
        assert_eq!(overdue["tasks"][0]["title"], "bottom");
    }

    /// Rank is the task's place on the board, not its index in the response.
    /// Filter down to the last card and it must still report rank 2 — an agent
    /// that reads rank 0 there would think it was working the top task.
    #[test]
    fn rank_is_true_rank_under_filtering() {
        let agent = test_agent();
        for title in ["a", "b", "c"] {
            agent
                .create_task_as(CreateTaskParams {
                    title: title.into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: (title == "c").then(|| vec!["find-me".to_string()]),
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: None,
                }, None)
                .unwrap();
        }
        let (_, out) = extract(
            &agent
                .list_tasks(Parameters(ListTasksParams {
                    tag: Some("find-me".into()),
                    ..Default::default()
                }))
                .unwrap(),
        );
        assert_eq!(out["count"], 1);
        assert_eq!(out["tasks"][0]["rank"], 2, "rank must survive filtering");
    }

    /// Rank is scoped per (project, status) — every group starts at 0, and
    /// ranks from different groups are not comparable.
    #[test]
    fn rank_is_scoped_per_project_and_status() {
        let agent = test_agent();
        agent
            .create_project(Parameters(CreateProjectParams {
                name: "Work".into(),
                color: None,
            }))
            .unwrap();
        for (title, project, status) in [
            ("inbox-todo", None, None),
            ("work-todo", Some("Work"), None),
            ("work-doing", Some("Work"), Some("doing")),
        ] {
            agent
                .create_task_as(CreateTaskParams {
                    title: title.into(),
                    project: project.map(Into::into),
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: status.map(Into::into),
                }, None)
                .unwrap();
        }
        let (_, out) = extract(&agent.list_tasks(Parameters(ListTasksParams::default())).unwrap());
        let tasks = out["tasks"].as_array().unwrap();
        assert_eq!(tasks.len(), 3);
        for task in tasks {
            assert_eq!(
                task["rank"], 0,
                "each (project, status) group starts at 0: {task}"
            );
        }
    }

    #[test]
    fn positions_stay_dense_per_group() {
        let agent = test_agent();
        for title in ["a", "b", "c"] {
            agent
                .create_task_as(CreateTaskParams {
                    title: title.into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: None,
                }, None)
                .unwrap();
        }
        let conn = agent.db.lock().unwrap();
        let positions: Vec<i64> = conn
            .prepare("SELECT position FROM tasks WHERE project_id IS NULL AND status='todo' ORDER BY position")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(positions, vec![0, 1, 2]);
    }

    /// Every (project, status) group of live tasks must hold distinct positions.
    /// Duplicates are the whole bug: the Kanban sorts by `position, id`, so a tie
    /// silently falls through to id order and the user's manual order is gone.
    /// Returns the group's task ids in board order.
    fn group_order(conn: &Connection, project_id: Option<i64>, status: &str) -> Vec<i64> {
        let mut stmt = conn
            .prepare(
                "SELECT id, position FROM tasks
                 WHERE deleted_at IS NULL AND status = ?1
                   AND (project_id IS ?2 OR project_id = ?2)
                 ORDER BY position, id",
            )
            .unwrap();
        let rows: Vec<(i64, i64)> = stmt
            .query_map(rusqlite::params![status, project_id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let mut seen = std::collections::HashSet::new();
        for (id, pos) in &rows {
            assert!(
                seen.insert(*pos),
                "duplicate position {pos} in ({project_id:?}, {status}) — task {id} \
                 collides, so the column falls back to sorting by id"
            );
        }
        rows.into_iter().map(|(id, _)| id).collect()
    }

    fn new_task(agent: &TildoneAgent, title: &str) -> i64 {
        let (is_err, v) = extract(
            &agent
                .create_task_as(CreateTaskParams {
                    title: title.into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: None,
                }, None)
                .unwrap(),
        );
        assert!(!is_err, "{v}");
        v["id"].as_i64().unwrap()
    }

    fn set_status(agent: &TildoneAgent, id: i64, status: &str) {
        let (is_err, v) = extract(
            &agent
                .update_task_as(UpdateTaskParams {
                    id: id.into(),
                    title: None,
                    notes: None,
                    status: Some(status.into()),
                    priority: None,
                    due_date: None,
                    project: None,
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                }, None)
                .unwrap(),
        );
        assert!(!is_err, "{v}");
    }

    /// The regression. Before the fix, `next_position` was only ever called by
    /// create_task, so a status change carried the old position into the new group:
    /// three tasks created at todo/0,1,2 and completed all landed on done/0,1,2 —
    /// every one of them colliding with a card already there. On the author's real
    /// board this had reached eight tasks sharing done/position 0.
    #[test]
    fn completing_tasks_does_not_pile_them_onto_the_same_position() {
        let agent = test_agent();
        let a = new_task(&agent, "a");
        let b = new_task(&agent, "b");
        let c = new_task(&agent, "c");

        for id in [a, b, c] {
            let (is_err, v) = extract(&agent.complete_task_as(TaskIdParams { id: id.into() }, None).unwrap());
            assert!(!is_err, "{v}");
        }

        let conn = agent.db.lock().unwrap();
        // group_order panics on any duplicate, which is the assertion that matters.
        let done = group_order(&conn, None, "done");
        assert_eq!(done.len(), 3);
        // Approved behaviour: newest completion first.
        assert_eq!(done, vec![c, b, a], "Done must read newest-first");
        assert!(group_order(&conn, None, "todo").is_empty());
    }

    /// Done inserts at the top without renumbering the cards already there, so a
    /// completion costs one write no matter how long Done has grown.
    #[test]
    fn completing_does_not_renumber_the_rest_of_done() {
        let agent = test_agent();
        let ids: Vec<i64> = (0..5).map(|i| new_task(&agent, &format!("t{i}"))).collect();
        for id in &ids[..4] {
            agent.complete_task_as(TaskIdParams { id: (*id).into() }, None).unwrap();
        }

        let before: Vec<(i64, i64)> = {
            let conn = agent.db.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT id, position FROM tasks WHERE status='done' ORDER BY id")
                .unwrap();
            let v = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            v
        };

        agent.complete_task_as(TaskIdParams { id: ids[4].into() }, None).unwrap();

        let conn = agent.db.lock().unwrap();
        for (id, pos) in before {
            let now: i64 = conn
                .query_row("SELECT position FROM tasks WHERE id = ?1", [id], |r| r.get(0))
                .unwrap();
            assert_eq!(now, pos, "task {id} was renumbered by an unrelated completion");
        }
        assert_eq!(group_order(&conn, None, "done")[0], ids[4]);
    }

    /// Moving a task back out of Done must also get a fresh slot, or it collides in
    /// the group it returns to.
    #[test]
    fn reopening_a_task_gives_it_a_fresh_slot_in_todo() {
        let agent = test_agent();
        let a = new_task(&agent, "a");
        let b = new_task(&agent, "b");
        set_status(&agent, a, "done");
        set_status(&agent, a, "todo");

        let conn = agent.db.lock().unwrap();
        // b is still todo/0; a must not land on top of it.
        assert_eq!(group_order(&conn, None, "todo"), vec![b, a]);
    }

    /// Same bug on the project axis: a task carried its position into the project it
    /// moved to, colliding with that project's card in the same slot.
    #[test]
    fn moving_project_gives_a_fresh_slot() {
        let agent = test_agent();
        agent
            .create_project(Parameters(CreateProjectParams {
                name: "work".into(),
                color: None,
            }))
            .unwrap();
        // Inbox task at todo/0 …
        let inbox_task = new_task(&agent, "from inbox");
        // … and a project task also at todo/0 in its own group.
        let (_, v) = extract(
            &agent
                .create_task_as(CreateTaskParams {
                    title: "already in work".into(),
                    project: Some("work".into()),
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: None,
                }, None)
                .unwrap(),
        );
        let work_task = v["id"].as_i64().unwrap();

        let (is_err, v) = extract(
            &agent
                .update_task_as(UpdateTaskParams {
                    id: inbox_task.into(),
                    title: None,
                    notes: None,
                    status: None,
                    priority: None,
                    due_date: None,
                    project: Some("work".into()),
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                }, None)
                .unwrap(),
        );
        assert!(!is_err, "{v}");

        let conn = agent.db.lock().unwrap();
        let pid: Option<i64> = conn
            .query_row("SELECT id FROM projects WHERE name = 'work'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(group_order(&conn, pid, "todo"), vec![work_task, inbox_task]);
    }

    /// An update that doesn't change group must leave position alone — otherwise
    /// renaming a card would reshuffle the board.
    #[test]
    fn a_non_group_change_leaves_position_untouched() {
        let agent = test_agent();
        let a = new_task(&agent, "a");
        let b = new_task(&agent, "b");
        let before: i64 = {
            let conn = agent.db.lock().unwrap();
            conn.query_row("SELECT position FROM tasks WHERE id = ?1", [a], |r| r.get(0))
                .unwrap()
        };
        agent
            .update_task_as(UpdateTaskParams {
                id: a.into(),
                title: Some("renamed".into()),
                notes: None,
                status: None,
                priority: Some(3),
                due_date: None,
                project: None,
                tags: None,
                session_id: None,
                cwd: None,
                branch: None,
            }, None)
            .unwrap();
        let conn = agent.db.lock().unwrap();
        let after: i64 = conn
            .query_row("SELECT position FROM tasks WHERE id = ?1", [a], |r| r.get(0))
            .unwrap();
        assert_eq!(after, before, "a rename must not move the card");
        assert_eq!(group_order(&conn, None, "todo"), vec![a, b]);
    }

    /// Migration 006 repairs boards that already carry the damage. Mirrors the real
    /// shape found on the author's board: many tasks stacked on done/position 0.
    #[test]
    fn migration_006_repairs_stacked_positions() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/001_init.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/002_trash.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/003_subtasks_activity.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/004_iso_timestamps.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/005_changes.sql")).unwrap();

        // Four done tasks all stacked on position 0, completed at known times.
        for (id, completed) in [
            (1, "2026-07-01T00:00:00.000Z"),
            (2, "2026-07-03T00:00:00.000Z"),
            (3, "2026-07-02T00:00:00.000Z"),
            (4, "2026-07-04T00:00:00.000Z"),
        ] {
            conn.execute(
                "INSERT INTO tasks (id, title, status, position, completed_at, created_at)
                 VALUES (?1, ?2, 'done', 0, ?3, '2026-07-01T00:00:00.000Z')",
                rusqlite::params![id, format!("done {id}"), completed],
            )
            .unwrap();
        }
        // Two todo tasks sharing position 2, whose relative order must be preserved.
        for id in [5, 6] {
            conn.execute(
                "INSERT INTO tasks (id, title, status, position, created_at)
                 VALUES (?1, ?2, 'todo', 2, '2026-07-01T00:00:00.000Z')",
                rusqlite::params![id, format!("todo {id}")],
            )
            .unwrap();
        }

        conn.execute_batch(include_str!("../migrations/006_repair_positions.sql")).unwrap();

        // Done: newest completion first, dense, no duplicates.
        assert_eq!(group_order(&conn, None, "done"), vec![4, 2, 3, 1]);
        // Todo: prior order (position, id) preserved, now distinct.
        assert_eq!(group_order(&conn, None, "todo"), vec![5, 6]);
    }

    /// Drives the real /heartbeat route over HTTP, the way the hook does.
    ///
    /// This route is deliberately outside the MCP service, so it inherits none of
    /// rmcp's protections — the origin guard below is the whole reason this test
    /// exists rather than a unit test of the handler.
    #[tokio::test(flavor = "multi_thread")]
    async fn heartbeat_over_http() {
        let beats: Beats = Arc::new(Mutex::new(HashMap::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = axum::Router::new().route(
            "/heartbeat",
            axum::routing::post(heartbeat_handler).with_state(beats.clone()),
        );
        let url = format!("http://{addr}/heartbeat");
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });

        let client = reqwest::Client::new();
        let beat = |body: &'static str, origin: Option<&'static str>| {
            let client = client.clone();
            let url = url.clone();
            async move {
                let mut req = client
                    .post(&url)
                    .header("Content-Type", "application/json")
                    .body(body);
                if let Some(o) = origin {
                    req = req.header("Origin", o);
                }
                req.send().await.unwrap().status().as_u16()
            }
        };

        // A shell hook sends no Origin and is accepted.
        assert_eq!(
            beat(r#"{"session_id":"s1","state":"working","pid":1}"#, None).await,
            200
        );
        assert_eq!(beats.lock().unwrap().get("s1").unwrap().state, "working");

        // A web page always sends Origin, and can never legitimately reach this
        // server. Without this guard any page you visited could post fake "working"
        // states into the one feature whose whole point is not lying.
        assert_eq!(
            beat(r#"{"session_id":"evil","state":"working"}"#, Some("https://evil.example")).await,
            403
        );
        assert!(
            !beats.lock().unwrap().contains_key("evil"),
            "a browser-originated beat must not be recorded"
        );

        // Even a same-origin-looking page is a page.
        assert_eq!(
            beat(r#"{"session_id":"evil2","state":"working"}"#, Some("http://127.0.0.1:1420")).await,
            403
        );

        // Garbage in.
        assert_eq!(beat(r#"{"session_id":"s1","state":"dancing"}"#, None).await, 400);
        assert_eq!(beat(r#"{"session_id":"  ","state":"working"}"#, None).await, 400);
        assert_eq!(beat(r#"not json"#, None).await, 400);

        // A subagent's idle must not settle the parent's card.
        assert_eq!(
            beat(r#"{"session_id":"s1","state":"idle","agent_id":"sub-1"}"#, None).await,
            200
        );
        assert_eq!(
            beats.lock().unwrap().get("s1").unwrap().state,
            "working",
            "a subagent finishing is not the parent finishing"
        );

        // The parent's own idle does settle it.
        assert_eq!(beat(r#"{"session_id":"s1","state":"idle"}"#, None).await, 200);
        assert_eq!(beats.lock().unwrap().get("s1").unwrap().state, "idle");
    }

    /// Drives the real streamable-HTTP endpoint the way an MCP client does:
    /// initialize → initialized → tools/list → tools/call.
    #[tokio::test(flavor = "multi_thread")]
    async fn mcp_over_streamable_http() {
        let agent = test_agent();
        let ct = CancellationToken::new();
        // Bind first, then configure from the real port — the same order as
        // agent_server_start, so origin/host validation is exercised against the
        // port actually in use rather than against AGENT_PORT.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let config = server_config(addr.port()).with_cancellation_token(ct.child_token());
        let service: StreamableHttpService<TildoneAgent, LocalSessionManager> =
            StreamableHttpService::new(move || Ok(agent.clone()), Default::default(), config);
        let router = axum::Router::new().nest_service("/mcp", service);
        let url = format!("http://{addr}/mcp");
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });

        let client = reqwest::Client::new();
        let post = |body: String, session: Option<String>| {
            let client = client.clone();
            let url = url.clone();
            async move {
                let mut req = client
                    .post(&url)
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json, text/event-stream")
                    .body(body);
                if let Some(s) = session {
                    req = req.header("Mcp-Session-Id", s);
                }
                req.send().await.unwrap()
            }
        };
        // SSE responses frame each JSON-RPC message as a "data:" line.
        fn sse_json(body: &str) -> Value {
            // Skip the empty SSE priming event; take the first data line
            // carrying JSON.
            let data = body
                .lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .map(str::trim)
                .find(|d| !d.is_empty())
                .unwrap_or(body);
            serde_json::from_str(data)
                .unwrap_or_else(|e| panic!("bad JSON ({e}) in body: {body:?}"))
        }

        let init = post(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}"#.into(),
            None,
        )
        .await;
        assert_eq!(init.status(), 200);
        let session = init
            .headers()
            .get("mcp-session-id")
            .map(|v| v.to_str().unwrap().to_string());
        assert!(session.is_some(), "stateful server must issue a session id");
        let init_body = sse_json(&init.text().await.unwrap());
        assert_eq!(init_body["result"]["serverInfo"]["name"], "tildone");
        // What the client actually sees. A live probe of the shipped server
        // returned `"capabilities":{"tools":{}}` — i.e. "my tool list never
        // changes" — which is how a client justifies caching it across a
        // reconnect and never seeing a newly added tool.
        assert_eq!(
            init_body["result"]["capabilities"]["tools"]["listChanged"],
            json!(true),
            "listChanged must reach the wire, not just get_info(): {init_body}"
        );

        let notif = post(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.into(),
            session.clone(),
        )
        .await;
        assert!(notif.status().is_success());

        let tools = post(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#.into(),
            session.clone(),
        )
        .await;
        let tools_body = sse_json(&tools.text().await.unwrap());
        let names: Vec<&str> = tools_body["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        for expected in [
            "list_projects",
            "create_project",
            "update_project",
            "delete_project",
            "list_tasks",
            "get_task",
            "create_task",
            "update_task",
            "complete_task",
            "delete_task",
            "list_tags",
        ] {
            assert!(names.contains(&expected), "missing tool {expected}");
        }

        let call = post(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_task","arguments":{"title":"From MCP","priority":2}}}"#.into(),
            session,
        )
        .await;
        let call_body = sse_json(&call.text().await.unwrap());
        assert_eq!(call_body["result"]["isError"], Value::Bool(false));
        let text = call_body["result"]["content"][0]["text"].as_str().unwrap();
        let task: Value = serde_json::from_str(text).unwrap();
        assert_eq!(task["title"], "From MCP");
        assert_eq!(task["status"], "todo");
        assert!(task["id"].as_i64().is_some(), "ack must carry the new id: {task}");
        // The whole point of the receipt: a write must not ship the notes blob
        // (or the rest of the row) back over the wire.
        assert!(
            task.get("notes").is_none() && task.get("priority").is_none(),
            "write ack must stay minimal, got: {task}"
        );

        // Drive-by hardening: browser-originated requests (Origin header set)
        // must be rejected before reaching the protocol layer.
        let evil = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .header("Origin", "https://evil.example")
            .body(r#"{"jsonrpc":"2.0","id":9,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"evil","version":"1.0"}}}"#)
            .send()
            .await
            .unwrap();
        assert!(
            evil.status().is_client_error(),
            "cross-origin request must be rejected, got {}",
            evil.status()
        );

        ct.cancel();
    }

    // -----------------------------------------------------------------------
    // Change feed — triggers
    //
    // These drive SQL directly rather than the MCP tools, on purpose: the point
    // of the trigger design is that the feed catches writers who never call it.
    // A test that went through agent.rs would only prove agent.rs cooperates.

    /// The case that motivated the whole feature. Kanban drag does NOT go through
    /// patchTask; it goes through applyPositions (store.ts:319), which writes
    /// status+position straight to the row and records no task_activity at all.
    /// This writes the row the way applyPositions does — deliberately not the way
    /// agent.rs does — and asserts the trigger caught it anyway.
    #[test]
    fn a_drag_shaped_write_lands_in_the_changes_feed() {
        let conn = migrated_conn();
        conn.execute(
            "INSERT INTO tasks (title, status, position, created_at)
             VALUES ('Ship it', 'done', 0, ?1)",
            [now_iso()],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        conn.execute("DELETE FROM changes", []).unwrap(); // drop the 'created' row

        // Byte-for-byte what applyPositions emits: status + position + completed_at.
        conn.execute(
            "UPDATE tasks SET status = 'todo', position = 0, completed_at = NULL WHERE id = ?1",
            [id],
        )
        .unwrap();

        let kinds: Vec<String> = conn
            .prepare("SELECT kind FROM changes WHERE entity_id = ?1 ORDER BY id")
            .unwrap()
            .query_map([id], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(
            kinds.contains(&"status".to_string()),
            "a drag from Done to To Do must appear in the feed; got {kinds:?}"
        );
    }

    /// Reordering within a column must not look like a status change: applyPositions
    /// rewrites status for every card it touches, so an unguarded `AFTER UPDATE OF
    /// status` would fire for cards that never left the column and wake an agent
    /// once per card for nothing.
    #[test]
    fn reordering_within_a_column_reports_moved_and_never_status() {
        let conn = migrated_conn();
        for (t, pos) in [("A", 0), ("B", 1)] {
            conn.execute(
                "INSERT INTO tasks (title, status, position, created_at)
                 VALUES (?1, 'todo', ?2, ?3)",
                rusqlite::params![t, pos, now_iso()],
            )
            .unwrap();
        }
        conn.execute("DELETE FROM changes", []).unwrap();

        // Swap them, the way a drag does: status is rewritten to its CURRENT value
        // for every affected card, and both positions genuinely change.
        conn.execute("UPDATE tasks SET status = 'todo', position = 1 WHERE title = 'A'", [])
            .unwrap();
        conn.execute("UPDATE tasks SET status = 'todo', position = 0 WHERE title = 'B'", [])
            .unwrap();

        let kinds: Vec<String> = conn
            .prepare("SELECT kind FROM changes ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(kinds, vec!["moved", "moved"], "a pure reorder must not emit `status`");
    }

    /// A write that changes nothing wakes nobody. applyPositions rewrites status
    /// and position for every card it touches — including cards whose values are
    /// already what it is writing — so without the WHEN guards a single drag would
    /// emit a change per card in the column. Found the honest way: an earlier
    /// version of the reorder test above put both cards at position 0 and expected
    /// two `moved` rows; the trigger emitted one, because the second write really
    /// was a no-op. The trigger was right and the test was wrong. Pin the property.
    #[test]
    fn a_write_that_changes_nothing_emits_nothing() {
        let conn = migrated_conn();
        conn.execute(
            "INSERT INTO tasks (title, status, priority, position, created_at)
             VALUES ('t', 'todo', 2, 7, ?1)",
            [now_iso()],
        )
        .unwrap();
        conn.execute("DELETE FROM changes", []).unwrap();

        // Every column set to the value it already holds.
        conn.execute(
            "UPDATE tasks SET status = 'todo', position = 7, priority = 2, title = 't'",
            [],
        )
        .unwrap();

        let n: i64 = conn.query_row("SELECT COUNT(*) FROM changes", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "a no-op write must not appear in the feed");
    }

    /// The trigger is a new writer of a created_at. datetime('now') would emit the
    /// marker-less format migration 004 existed to erase, which JS reads as local
    /// time and lands hours off. Guard it the way the other writers are guarded.
    #[test]
    fn trigger_timestamps_are_iso_utc_with_a_z() {
        let conn = migrated_conn();
        conn.execute("INSERT INTO tasks (title, created_at) VALUES ('t', ?1)", [now_iso()])
            .unwrap();
        let ts: String = conn
            .query_row("SELECT created_at FROM changes LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let b = ts.as_bytes();
        assert!(
            ts.len() == 24 && ts.ends_with('Z') && b[10] == b'T' && b[19] == b'.',
            "trigger wrote {ts:?}; expected ISO-8601 UTC like 2026-07-16T05:12:33.123Z, \
             the shape now_iso() and JS toISOString() produce"
        );
    }

    #[test]
    fn trash_and_restore_are_distinct_kinds() {
        let conn = migrated_conn();
        conn.execute("INSERT INTO tasks (title, created_at) VALUES ('t', ?1)", [now_iso()])
            .unwrap();
        let id = conn.last_insert_rowid();
        conn.execute("DELETE FROM changes", []).unwrap();
        conn.execute(
            "UPDATE tasks SET deleted_at = ?1 WHERE id = ?2",
            rusqlite::params![now_iso(), id],
        )
        .unwrap();
        conn.execute("UPDATE tasks SET deleted_at = NULL WHERE id = ?1", [id]).unwrap();
        let kinds: Vec<String> = conn
            .prepare("SELECT kind FROM changes ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(kinds, vec!["trashed", "restored"]);
    }

    // -----------------------------------------------------------------------
    // Change feed — the list_changes tool

    fn no_wait(since: Option<i64>) -> Parameters<ListChangesParams> {
        Parameters(ListChangesParams { since, wait_ms: None })
    }

    #[tokio::test]
    async fn list_changes_without_since_returns_a_baseline_not_a_flood() {
        let (agent, db) = test_agent_with_db();
        {
            let conn = db.lock().unwrap();
            for i in 0..3 {
                conn.execute(
                    "INSERT INTO tasks (title, created_at) VALUES (?1, ?2)",
                    rusqlite::params![format!("t{i}"), now_iso()],
                )
                .unwrap();
            }
        }
        let (_, v) = extract(&agent.list_changes(no_wait(None)).await.unwrap());
        assert_eq!(
            v["changes"].as_array().unwrap().len(),
            0,
            "no `since` must mean a baseline, never a replay of history"
        );
        assert_eq!(v["cursor"], 3);
    }

    #[tokio::test]
    async fn list_changes_round_trips_its_cursor() {
        let (agent, db) = test_agent_with_db();
        let (_, base_v) = extract(&agent.list_changes(no_wait(None)).await.unwrap());
        let base = base_v["cursor"].as_i64().unwrap();

        db.lock()
            .unwrap()
            .execute("INSERT INTO tasks (title, created_at) VALUES ('new', ?1)", [now_iso()])
            .unwrap();

        let (_, v) = extract(&agent.list_changes(no_wait(Some(base))).await.unwrap());
        let changes = v["changes"].as_array().unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0]["kind"], "created");
        let next = v["cursor"].as_i64().unwrap();
        assert!(next > base, "the cursor must advance");

        // Passing the new cursor back yields nothing — no duplicate delivery.
        let (_, v2) = extract(&agent.list_changes(no_wait(Some(next))).await.unwrap());
        assert_eq!(v2["changes"].as_array().unwrap().len(), 0);
    }

    /// An agent's own writes go through the same trigger as the user's — there is
    /// no second code path to keep in sync. That is the whole design, so pin it.
    #[tokio::test]
    async fn an_agent_write_shows_up_in_the_feed_too() {
        let (agent, _db) = test_agent_with_db();
        let (_, created) = extract(
            &agent
                .create_task_as(CreateTaskParams {
                    title: "Work".into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: None,
                }, None)
                .unwrap(),
        );
        let id = created["id"].as_i64().unwrap();

        let (_, base_v) = extract(&agent.list_changes(no_wait(None)).await.unwrap());
        let base = base_v["cursor"].as_i64().unwrap();

        agent
            .update_task_as(UpdateTaskParams {
                id: id.into(),
                title: None,
                notes: None,
                status: Some("doing".into()),
                priority: None,
                due_date: None,
                project: None,
                tags: None,
                session_id: None,
                cwd: None,
                branch: None,
            }, None)
            .unwrap();

        let (_, v) = extract(&agent.list_changes(no_wait(Some(base))).await.unwrap());
        let kinds: Vec<&str> = v["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["kind"].as_str().unwrap())
            .collect();
        assert!(
            kinds.contains(&"status"),
            "an agent write must feed the same trigger as a user's; got {kinds:?}"
        );
    }

    /// The silent-success failure: a cursor past the retention horizon must not
    /// return [] as though the board were untouched.
    #[tokio::test]
    async fn a_cursor_older_than_retention_reports_truncation() {
        let (agent, db) = test_agent_with_db();
        {
            let conn = db.lock().unwrap();
            // Changes the reaper will drop: created_at well past the horizon.
            for i in 1..=2 {
                conn.execute(
                    "INSERT INTO changes (entity, entity_id, kind, created_at)
                     VALUES ('task', ?1, 'status', strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 days'))",
                    [i],
                )
                .unwrap();
            }
        }
        let (_, v) = extract(&agent.list_changes(no_wait(Some(0))).await.unwrap());
        assert_eq!(
            v["truncated"], true,
            "a stale cursor must not be answered with a bare [] that reads as 'nothing happened'"
        );
        assert!(v["note"].is_string(), "and it must say what to do about it");
    }

    /// The reaper must not take live rows with it.
    #[tokio::test]
    async fn retention_keeps_recent_changes() {
        let (agent, db) = test_agent_with_db();
        {
            let conn = db.lock().unwrap();
            conn.execute(
                "INSERT INTO changes (entity, entity_id, kind, created_at)
                 VALUES ('task', 1, 'status', strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 days'))",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO changes (entity, entity_id, kind, created_at)
                 VALUES ('task', 2, 'status', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 days'))",
                [],
            )
            .unwrap();
        }
        agent.list_changes(no_wait(None)).await.unwrap(); // triggers the sweep
        let surviving: Vec<i64> = db
            .lock()
            .unwrap()
            .prepare("SELECT entity_id FROM changes ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(surviving, vec![2], "the 40-day-old row goes, the 1-day-old row stays");
    }

    /// The reaper deletes rows, so MAX(id) would walk the cursor backwards and
    /// replay history the agent already processed. sqlite_sequence does not.
    #[tokio::test]
    async fn the_cursor_never_walks_backwards_after_a_prune() {
        let (agent, db) = test_agent_with_db();
        {
            let conn = db.lock().unwrap();
            for i in 1..=3 {
                conn.execute(
                    "INSERT INTO changes (entity, entity_id, kind, created_at)
                     VALUES ('task', ?1, 'status', strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 days'))",
                    [i],
                )
                .unwrap();
            }
        }
        let (_, before) = extract(&agent.list_changes(no_wait(None)).await.unwrap());
        // Everything was over the horizon, so the sweep emptied the table.
        assert_eq!(db.lock().unwrap().query_row("SELECT COUNT(*) FROM changes", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        let (_, after) = extract(&agent.list_changes(no_wait(None)).await.unwrap());
        assert_eq!(
            before["cursor"], after["cursor"],
            "an empty table must not reset the cursor — MAX(id) would, sqlite_sequence must not"
        );
        assert_eq!(after["cursor"], 3);
    }

    // -----------------------------------------------------------------------
    // Change feed — the long-poll

    /// The headline behaviour: the call is parked, the user moves a card, the call
    /// returns. This is what makes a plain tool call behave like push.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_parked_call_returns_the_moment_a_change_lands() {
        let (agent, db) = test_agent_with_db();
        let (_, base_v) = extract(&agent.list_changes(no_wait(None)).await.unwrap());
        let base = base_v["cursor"].as_i64().unwrap();

        let writer = db.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            writer
                .lock()
                .unwrap()
                .execute("INSERT INTO tasks (title, created_at) VALUES ('dropped', ?1)", [now_iso()])
                .unwrap();
        });

        let started = std::time::Instant::now();
        let (_, v) = extract(
            &agent
                .list_changes(Parameters(ListChangesParams {
                    since: Some(base),
                    wait_ms: Some(10_000),
                }))
                .await
                .unwrap(),
        );
        assert_eq!(
            v["changes"].as_array().unwrap().len(),
            1,
            "the park must deliver the change that woke it"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "it must return on the event, not sit out the timeout (took {:?})",
            started.elapsed()
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_park_that_times_out_is_success_not_an_error() {
        let (agent, _db) = test_agent_with_db();
        let r = agent
            .list_changes(Parameters(ListChangesParams { since: Some(0), wait_ms: Some(400) }))
            .await
            .unwrap();
        let (is_err, v) = extract(&r);
        assert!(!is_err, "a quiet board is a normal answer, not a tool error");
        assert_eq!(v["changes"].as_array().unwrap().len(), 0);
        assert!(v["cursor"].is_i64(), "a timeout still returns a usable cursor");
    }

    /// A parked call must not hold the app open. Without the shutdown token in the
    /// select, quitting Tildone would wait out a 60s long-poll.
    #[tokio::test(flavor = "multi_thread")]
    async fn shutdown_releases_a_parked_call() {
        let db: Db = Arc::new(Mutex::new(migrated_conn()));
        let token = CancellationToken::new();
        let agent = TildoneAgent::new(db, Arc::new(|| {}), no_notify(), token.clone());

        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            token.cancel();
        });

        let started = std::time::Instant::now();
        agent
            .list_changes(Parameters(ListChangesParams { since: Some(0), wait_ms: Some(60_000) }))
            .await
            .unwrap();
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "cancelling the server must free a parked call (took {:?})",
            started.elapsed()
        );
    }

    /// A parked call holds no lock, so the rest of the board keeps working while
    /// an agent waits. The whole server shares one connection behind a std Mutex —
    /// holding it across the park would freeze every other tool for 60 seconds.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_parked_call_does_not_block_other_tools() {
        let (agent, _db) = test_agent_with_db();
        let parked = agent.clone();
        let handle = tokio::spawn(async move {
            parked
                .list_changes(Parameters(ListChangesParams {
                    since: Some(0),
                    wait_ms: Some(60_000),
                }))
                .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        // While that call is parked, an ordinary write must go straight through.
        let started = std::time::Instant::now();
        let (is_err, _) = extract(
            &agent
                .create_task_as(CreateTaskParams {
                    title: "while you were waiting".into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    session_id: None,
                    cwd: None,
                    branch: None,
                    status: None,
                }, None)
                .unwrap(),
        );
        assert!(!is_err);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "a parked long-poll must not hold the db lock (write took {:?})",
            started.elapsed()
        );

        // And that write is exactly what wakes the parked call.
        let (_, v) = extract(&handle.await.unwrap().unwrap());
        assert!(!v["changes"].as_array().unwrap().is_empty());
    }

    /// Read the (actor_kind, actor_name) of the most recent activity row on a task.
    fn last_actor(db: &Db, task_id: i64) -> (Option<String>, Option<String>) {
        let conn = db.lock().unwrap();
        conn.query_row(
            "SELECT actor_kind, actor_name FROM task_activity
             WHERE task_id = ?1 ORDER BY id DESC LIMIT 1",
            [task_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    /// Every activity row this file writes is an agent write, by construction — the
    /// only way to reach it is over MCP. So the actor is stamped, and it carries the
    /// client's own name when the handshake gave one.
    #[test]
    fn an_agent_write_is_stamped_agent_with_its_name() {
        let (agent, db) = test_agent_with_db();
        let (_, task) = extract(
            &agent
                .create_task_as(
                    CreateTaskParams {
                        title: "Build it".into(),
                        project: None,
                        notes: None,
                        due_date: None,
                        priority: None,
                        tags: None,
                        session_id: None,
                        cwd: None,
                        branch: None,
                        status: None,
                    },
                    Some("claude-code"),
                )
                .unwrap(),
        );
        let id = task["id"].as_i64().unwrap();

        extract(
            &agent
                .log_progress_as(
                    LogProgressParams { task_id: id.into(), text: "tests green".into() },
                    Some("claude-code"),
                )
                .unwrap(),
        );

        assert_eq!(
            last_actor(&db, id),
            (Some("agent".to_string()), Some("claude-code".to_string())),
        );
    }

    /// A client that sent no usable name is still an agent — recorded as an unnamed
    /// agent, never mislabelled as the user. This is why kind and name are separate
    /// columns: `actor_kind` is known even when `actor_name` is not.
    #[test]
    fn an_unnamed_agent_is_still_agent_kind() {
        let (agent, db) = test_agent_with_db();
        let (_, task) = extract(
            &agent
                .create_task_as(
                    CreateTaskParams {
                        title: "Anon".into(),
                        project: None,
                        notes: None,
                        due_date: None,
                        priority: None,
                        tags: None,
                        session_id: None,
                        cwd: None,
                        branch: None,
                        status: None,
                    },
                    None,
                )
                .unwrap(),
        );
        let id = task["id"].as_i64().unwrap();
        assert_eq!(last_actor(&db, id), (Some("agent".to_string()), None));
    }

    /// The point of the feature: the Rust MCP writer and the TS UI writer emit the
    /// identical label for the same semantic change ("Status changed to Done"). Here
    /// we drive the agent path and simulate the UI path the way db.ts does — same
    /// label, but the actor column now tells them apart. If this ever fails, the feed
    /// is anonymous again.
    #[test]
    fn the_same_label_from_agent_and_user_is_told_apart_by_actor() {
        let (agent, db) = test_agent_with_db();
        let (_, task) = extract(
            &agent
                .create_task_as(
                    CreateTaskParams {
                        title: "Ship".into(),
                        project: None,
                        notes: None,
                        due_date: None,
                        priority: None,
                        tags: None,
                        session_id: None,
                        cwd: None,
                        branch: None,
                        status: None,
                    },
                    Some("codex"),
                )
                .unwrap(),
        );
        let id = task["id"].as_i64().unwrap();

        // Agent completes the task -> "Status changed to Done", actor agent/codex.
        extract(&agent.complete_task_as(TaskIdParams { id: id.into() }, Some("codex")).unwrap());

        // The UI writer (src/db.ts insertActivity) hard-codes 'user' and no name.
        // Simulate its exact INSERT so both rows share the label but not the actor.
        {
            let conn = db.lock().unwrap();
            conn.execute(
                "INSERT INTO task_activity (task_id, label, created_at, actor_kind, actor_name)
                 VALUES (?1, 'Status changed to Done', ?2, 'user', NULL)",
                rusqlite::params![id, now_iso()],
            )
            .unwrap();
        }

        let conn = db.lock().unwrap();
        let mut kinds: Vec<(String, Option<String>)> = conn
            .prepare(
                "SELECT actor_kind, actor_name FROM task_activity
                 WHERE task_id = ?1 AND label = 'Status changed to Done' ORDER BY id",
            )
            .unwrap()
            .query_map([id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        kinds.sort();
        assert_eq!(
            kinds,
            vec![
                ("agent".to_string(), Some("codex".to_string())),
                ("user".to_string(), None),
            ],
            "same label, different actor — the feed can now say who did it"
        );
    }

    /// Migration 006 is additive: pre-existing rows keep NULL actor columns and are
    /// still readable exactly as before. A legacy row must not read as a user or an
    /// agent — it is genuinely unknown, and NULL is how the UI knows to show neither.
    #[test]
    fn legacy_rows_have_null_actor() {
        let conn = migrated_conn();
        // A row written the pre-006 way: no actor columns named at all.
        conn.execute(
            "INSERT INTO tasks (title, status, position, created_at)
             VALUES ('old', 'todo', 0, ?1)",
            rusqlite::params![now_iso()],
        )
        .unwrap();
        let tid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO task_activity (task_id, label, created_at)
             VALUES (?1, 'Task created', ?2)",
            rusqlite::params![tid, now_iso()],
        )
        .unwrap();
        let (kind, name): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT actor_kind, actor_name FROM task_activity WHERE task_id = ?1",
                [tid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((kind, name), (None, None));
    }

    // ---- per-project task reference (CODE-N) ----

    fn new_project(agent: &TildoneAgent, name: &str) -> String {
        let (is_err, p) = extract(
            &agent
                .create_project(Parameters(CreateProjectParams { name: name.into(), color: None }))
                .unwrap(),
        );
        assert!(!is_err, "create_project failed: {p}");
        p["code"].as_str().unwrap().to_string()
    }

    fn ref_task(agent: &TildoneAgent, project: Option<&str>, title: &str) -> Value {
        let (is_err, t) = extract(
            &agent
                .create_task_as(
                    CreateTaskParams {
                        title: title.into(),
                        project: project.map(Into::into),
                        notes: None,
                        due_date: None,
                        priority: None,
                        tags: None,
                        session_id: None,
                        cwd: None,
                        branch: None,
                        status: None,
                    },
                    None,
                )
                .unwrap(),
        );
        assert!(!is_err, "create_task failed: {t}");
        t
    }

    #[test]
    fn task_ref_is_per_project_sequential_and_independent() {
        let agent = test_agent();
        let til = new_project(&agent, "Tildone");
        let zl = new_project(&agent, "Zeno Logistics");
        assert_eq!(til, "TIL");
        assert_eq!(zl, "ZL"); // multi-word → initials

        assert_eq!(ref_task(&agent, Some("Tildone"), "a")["ref"], "TIL-1");
        assert_eq!(ref_task(&agent, Some("Tildone"), "b")["ref"], "TIL-2");
        // A second project counts from its own 1, not continuing TIL's sequence.
        assert_eq!(ref_task(&agent, Some("Zeno Logistics"), "c")["ref"], "ZL-1");
        assert_eq!(ref_task(&agent, Some("Tildone"), "d")["ref"], "TIL-3");
    }

    #[test]
    fn inbox_task_ref_uses_inbox_code() {
        let agent = test_agent();
        assert_eq!(ref_task(&agent, None, "loose")["ref"], "INBOX-1");
        assert_eq!(ref_task(&agent, None, "loose 2")["ref"], "INBOX-2");
    }

    #[test]
    fn task_resolves_by_ref_and_by_numeric_id() {
        let agent = test_agent();
        new_project(&agent, "Tildone");
        let created = ref_task(&agent, Some("Tildone"), "resolve me");
        let id = created["id"].as_i64().unwrap();
        assert_eq!(created["ref"], "TIL-1");

        // By the CODE-N ref (case-insensitive).
        let (err_ref, by_ref) =
            extract(&agent.get_task(Parameters(TaskIdParams { id: TaskRef::Ref("til-1".into()) })).unwrap());
        assert!(!err_ref, "get_task by ref errored: {by_ref}");
        assert_eq!(by_ref["id"].as_i64().unwrap(), id);

        // By the raw numeric id (back-compat).
        let (err_id, by_id) =
            extract(&agent.get_task(Parameters(TaskIdParams { id: id.into() })).unwrap());
        assert!(!err_id, "get_task by id errored: {by_id}");
        assert_eq!(by_id["ref"], "TIL-1");

        // An unknown ref is a clean error, not a panic or wrong task.
        let (missing, msg) =
            extract(&agent.get_task(Parameters(TaskIdParams { id: TaskRef::Ref("TIL-999".into()) })).unwrap());
        assert!(missing, "expected error for unknown ref, got {msg}");
    }

    #[test]
    fn trashed_number_is_not_reused_within_a_code() {
        let agent = test_agent();
        new_project(&agent, "Tildone");
        let _a = ref_task(&agent, Some("Tildone"), "a"); // TIL-1
        let b = ref_task(&agent, Some("Tildone"), "b"); // TIL-2
        let b_id = b["id"].as_i64().unwrap();

        extract(&agent.delete_task(Parameters(TaskIdParams { id: b_id.into() })).unwrap());

        // The next task must not re-mint TIL-2 even though that row is trashed.
        assert_eq!(ref_task(&agent, Some("Tildone"), "c")["ref"], "TIL-3");
    }

    #[test]
    fn moving_a_task_keeps_its_ref_and_leaves_destination_counter_intact() {
        let agent = test_agent();
        new_project(&agent, "Tildone");
        new_project(&agent, "Zeno Logistics");
        let a = ref_task(&agent, Some("Tildone"), "born in tildone"); // TIL-1
        let a_id = a["id"].as_i64().unwrap();
        assert_eq!(ref_task(&agent, Some("Zeno Logistics"), "z1")["ref"], "ZL-1");

        // Move TIL-1 into the Zeno project.
        let (moved_err, _moved) = extract(
            &agent
                .update_task_as(
                    UpdateTaskParams {
                        id: a_id.into(),
                        title: None,
                        notes: None,
                        status: None,
                        priority: None,
                        due_date: None,
                        project: Some("Zeno Logistics".into()),
                        tags: None,
                        session_id: None,
                        cwd: None,
                        branch: None,
                    },
                    None,
                )
                .unwrap(),
        );
        assert!(!moved_err);

        // Ref stays frozen at its birth code, and still resolves.
        let (_e, after) =
            extract(&agent.get_task(Parameters(TaskIdParams { id: TaskRef::Ref("TIL-1".into()) })).unwrap());
        assert_eq!(after["id"].as_i64().unwrap(), a_id);
        assert_eq!(after["ref"], "TIL-1");

        // The destination's counter is owned by its code, unaffected by the move:
        // the next Zeno task is ZL-2 (not skipped, not colliding with the moved-in task).
        assert_eq!(ref_task(&agent, Some("Zeno Logistics"), "z2")["ref"], "ZL-2");
    }

    // ---- wire format: compact, null-stripped responses ----

    /// Absent and null are the same answer to an MCP caller, and pretty-print
    /// indentation plus null members cost agents ~40% extra tokens on every
    /// read — so responses serialize compact with null members dropped.
    #[test]
    fn responses_are_compact_and_null_free() {
        let agent = test_agent();
        a_task(&agent, "Bare task");
        let result = agent.list_tasks(Parameters(ListTasksParams::default())).unwrap();
        let text = match &result.content[0] {
            ContentBlock::Text(t) => t.text.clone(),
            other => panic!("expected text content, got {other:?}"),
        };
        assert!(!text.contains('\n'), "expected compact JSON, got: {text}");
        assert!(!text.contains("null"), "expected null members dropped, got: {text}");
        let row = serde_json::from_str::<Value>(&text).unwrap()["tasks"][0].clone();
        assert_eq!(row["title"], "Bare task");
        assert!(row.get("due_date").is_none(), "unset due_date must be omitted, not null");
        assert_eq!(row["status"], "todo");
    }
}

