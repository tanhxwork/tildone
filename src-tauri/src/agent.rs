// MCP server exposing task/project management to external AI agents.
// Streamable HTTP on 127.0.0.1:AGENT_PORT, opt-in via the settings dialog.
// Opens its own SQLite connection to the same tildone.db the frontend uses;
// after every write it emits `agent-db-changed` so the UI reloads.

use std::sync::{Arc, Mutex};

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, ContentBlock, ServerCapabilities, ServerInfo},
    schemars,
    service::NotificationContext,
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

type Db = Arc<Mutex<Connection>>;

/// Called after every successful write so the app UI can refresh.
type Notify = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone)]
struct TildoneAgent {
    #[allow(dead_code)] // read by the tool_handler macro
    tool_router: ToolRouter<Self>,
    db: Db,
    on_change: Notify,
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

fn ok_json(value: &Value) -> Result<CallToolResult, ErrorData> {
    let text = serde_json::to_string_pretty(value).map_err(|e| {
        ErrorData::internal_error(format!("failed to serialize result: {e}"), None)
    })?;
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

fn ok_text(msg: impl Into<String>) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::success(vec![ContentBlock::text(msg.into())]))
}

fn db_err(e: rusqlite::Error) -> ErrorData {
    ErrorData::internal_error(format!("database error: {e}"), None)
}

impl TildoneAgent {
    fn new(db: Db, on_change: Notify, shutdown: CancellationToken) -> Self {
        Self {
            tool_router: Self::tool_router(),
            db,
            on_change,
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

    fn record_activity(conn: &Connection, task_id: i64, label: &str) {
        let _ = conn.execute(
            "INSERT INTO task_activity (task_id, label, created_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![task_id, label, now_iso()],
        );
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
    fn set_tags(conn: &Connection, task_id: i64, tags: &[String]) -> Result<(), rusqlite::Error> {
        conn.execute("DELETE FROM task_tags WHERE task_id = ?1", [task_id])?;
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
            conn.execute(
                "INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?1, ?2)",
                rusqlite::params![task_id, tag_id],
            )?;
        }
        Ok(())
    }

    /// Receipt for a write: the id, plus the fields the caller could not have
    /// known before the write landed. Deliberately *not* the whole task —
    /// echoing back the notes blob the caller just sent doubled the cost of
    /// every update (one session: 46 writes sent 59KB and got 108KB back).
    /// `get_task` is the escape hatch when the full row is genuinely wanted.
    fn task_ack(conn: &Connection, id: i64) -> Result<Value, rusqlite::Error> {
        conn.query_row(
            "SELECT id, title, status, completed_at FROM tasks WHERE id = ?1",
            [id],
            |r| {
                let mut ack = json!({
                    "id": r.get::<_, i64>(0)?,
                    "title": r.get::<_, String>(1)?,
                    "status": r.get::<_, String>(2)?,
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
                            CASE WHEN t.deleted_at IS NULL THEN {RANK_SQL} END
                     FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
                     WHERE t.id = ?1"
                ),
                [id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
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
        id: i64,
        title: Option<String>,
        notes: Option<String>,
        status: Option<String>,
        priority: Option<i64>,
        due_date: Option<String>,
        project: Option<String>,
        tags: Option<Vec<String>>,
    ) -> Result<CallToolResult, ErrorData> {
        let conn = self.db.lock().unwrap();
        let current: Option<(String, Option<i64>, Option<String>)> = conn
            .query_row(
                "SELECT status, project_id, deleted_at FROM tasks WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map_err(db_err)?;
        let Some((old_status, old_project_id, deleted_at)) = current else {
            return Ok(err(format!("No task with id {id}.")));
        };
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
        if let Some(tags) = tags {
            Self::set_tags(&conn, id, &tags).map_err(db_err)?;
        }
        for label in &activity {
            Self::record_activity(&conn, id, label);
        }
        let ack = Self::task_ack(&conn, id).map_err(db_err)?;
        drop(conn);
        self.notify();
        ok_json(&ack)
    }
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

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct AppendNoteParams {
    id: i64,
    #[schemars(description = "Text to append. A newline is inserted first when the notes are not already empty or newline-terminated.")]
    text: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct AddSubtaskParams {
    #[schemars(description = "Id of the parent task")]
    task_id: i64,
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
    #[schemars(description = "Id of the task")]
    task_id: i64,
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
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct UpdateTaskParams {
    id: i64,
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
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct AddLinkParams {
    #[schemars(description = "Id of the task to attach the link to")]
    task_id: i64,
    #[schemars(description = "The URL to open. Must be http(s) — other schemes are refused.")]
    url: String,
    #[schemars(
        description = "What to show on the chip (e.g. \"PR #12\", a branch name, a short SHA). Defaults to the URL's last path segment."
    )]
    label: Option<String>,
    #[schemars(description = "One of: pr, branch, commit, worktree, other. Defaults to other.")]
    kind: Option<String>,
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
        conn.execute(
            "INSERT INTO projects (name, color, position, created_at)
             VALUES (?1, ?2, (SELECT COALESCE(MAX(position), -1) + 1 FROM projects), ?3)",
            rusqlite::params![name, color, now_iso()],
        )
        .map_err(db_err)?;
        let id = conn.last_insert_rowid();
        drop(conn);
        self.notify();
        ok_json(&json!({"id": id, "name": name, "color": color}))
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
                    {RANK_SQL}
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
        Parameters(IdParams { id }): Parameters<IdParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let conn = self.db.lock().unwrap();
        let Some(mut task) = Self::task_json(&conn, id).map_err(db_err)? else {
            return Ok(err(format!("No task with id {id}.")));
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
        ok_json(&task)
    }

    #[tool(description = "Create a task. Without a project it goes to the Inbox.")]
    fn create_task(
        &self,
        Parameters(p): Parameters<CreateTaskParams>,
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
        conn.execute(
            "INSERT INTO tasks (project_id, title, notes, status, priority, due_date, position, completed_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                project_id,
                title,
                p.notes.unwrap_or_default(),
                status,
                priority,
                due_date,
                position,
                completed_at,
                now_iso()
            ],
        )
        .map_err(db_err)?;
        let id = conn.last_insert_rowid();
        if let Some(tags) = &p.tags {
            Self::set_tags(&conn, id, tags).map_err(db_err)?;
        }
        Self::record_activity(&conn, id, "Task created");
        let ack = Self::task_ack(&conn, id).map_err(db_err)?;
        drop(conn);
        self.notify();
        ok_json(&ack)
    }

    #[tool(description = "Update fields of a task. Only the provided fields change.")]
    fn update_task(
        &self,
        Parameters(p): Parameters<UpdateTaskParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.apply_task_update(
            p.id, p.title, p.notes, p.status, p.priority, p.due_date, p.project, p.tags,
        )
    }

    #[tool(
        description = "Append text to a task's notes. Prefer this over update_task for progress logs: it cannot destroy existing notes, and it costs the same no matter how long the notes already are."
    )]
    fn append_note(
        &self,
        Parameters(AppendNoteParams { id, text }): Parameters<AppendNoteParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let conn = self.db.lock().unwrap();
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
            return Ok(err(format!("No task with id {id}.")));
        };
        if deleted_at.is_some() {
            return Ok(err(format!(
                "Task {id} is in the trash; it can only be restored from the app."
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
        description = "Add a subtask to a task. Subtasks are the task's checklist and the board card renders them as a live progress bar, so prefer these over a checklist written inside notes."
    )]
    fn add_subtask(
        &self,
        Parameters(AddSubtaskParams { task_id, title }): Parameters<AddSubtaskParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let title = title.trim().to_string();
        if title.is_empty() {
            return Ok(err("Subtask title cannot be empty."));
        }
        let conn = self.db.lock().unwrap();
        match Self::task_trashed(&conn, task_id).map_err(db_err)? {
            None => return Ok(err(format!("No task with id {task_id}."))),
            Some(true) => {
                return Ok(err(format!(
                    "Task {task_id} is in the trash; it can only be restored from the app."
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
        Self::record_activity(&conn, task_id, &format!("Subtask added: {title}"));
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

    #[tool(description = "Tick, untick or rename a subtask. Only the provided fields change.")]
    fn set_subtask(
        &self,
        Parameters(SetSubtaskParams { id, done, title }): Parameters<SetSubtaskParams>,
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
            Self::record_activity(&conn, task_id, &format!("Subtask renamed: {title}"));
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
        Parameters(IdParams { id }): Parameters<IdParams>,
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
        Self::record_activity(&conn, task_id, &format!("Subtask removed: {title}"));
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
        description = "Log one line of narrative progress on a task — what you just did, found or decided. It lands in the task's Activity feed in the app, timestamped, so the user can watch the work happen. Prefer this over keeping a `## Log` section inside `notes`: it costs the same however long the history gets, it cannot clobber anything, and it leaves notes as prose. Use subtasks for the plan checklist and this for the running commentary."
    )]
    fn log_progress(
        &self,
        Parameters(LogProgressParams { task_id, text }): Parameters<LogProgressParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Ok(err("Log text cannot be empty."));
        }
        let conn = self.db.lock().unwrap();
        match Self::task_trashed(&conn, task_id).map_err(db_err)? {
            None => return Ok(err(format!("No task with id {task_id}."))),
            Some(true) => {
                return Ok(err(format!(
                    "Task {task_id} is in the trash; it can only be restored from the app."
                )))
            }
            Some(false) => {}
        }
        Self::record_activity(&conn, task_id, &text);
        drop(conn);
        self.notify();
        // A receipt, like every other write: the entry is on screen, echoing it back
        // would only pay for the same bytes twice.
        ok_json(&json!({ "task_id": task_id, "logged": text }))
    }

    #[tool(description = "Mark a task as done.")]
    fn complete_task(
        &self,
        Parameters(IdParams { id }): Parameters<IdParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.apply_task_update(
            id,
            None,
            None,
            Some("done".to_string()),
            None,
            None,
            None,
            None,
        )
    }

    #[tool(description = "Move a task to the trash (restorable in the app for 30 days).")]
    fn delete_task(
        &self,
        Parameters(IdParams { id }): Parameters<IdParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let conn = self.db.lock().unwrap();
        let changed = conn
            .execute(
                "UPDATE tasks SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                rusqlite::params![now_iso(), id],
            )
            .map_err(db_err)?;
        drop(conn);
        if changed == 0 {
            return Ok(err(format!("No active task with id {id}.")));
        }
        self.notify();
        ok_text(format!("Task {id} moved to trash."))
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
        description = "Attach a repo link to a task — a branch, PR, commit or worktree URL — rendered as a clickable chip on the card. You supply the url and label: the app never guesses one, since only you (standing in the checkout) know the remote, the host convention and the repo. Only http(s) URLs are accepted."
    )]
    fn add_link(
        &self,
        Parameters(AddLinkParams {
            task_id,
            url,
            label,
            kind,
        }): Parameters<AddLinkParams>,
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
        match Self::task_trashed(&conn, task_id).map_err(db_err)? {
            None => return Ok(err(format!("No task with id {task_id}."))),
            Some(true) => {
                return Ok(err(format!(
                    "Task {task_id} is in the trash; it can only be restored from the app."
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
        Self::record_activity(&conn, task_id, &format!("Link added: {label}"));
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
        Parameters(IdParams { id }): Parameters<IdParams>,
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
        Self::record_activity(&conn, task_id, &format!("Link removed: {label}"));
        drop(conn);
        self.notify();
        ok_json(&json!({ "deleted": id, "task_id": task_id }))
    }

    #[tool(
        description = "What changed on the board since a cursor. Call once with no arguments to get the current cursor, then pass it back as `since`. With `wait_ms` the call blocks until something changes — so an agent can park here and wake when the user moves a card, instead of polling list_tasks. Returns {cursor, changes:[{id, entity, entity_id, kind, created_at}]}; kind is created/status/moved/trashed/restored/edited/link. A change says THAT a task changed, not what it now is — follow up with get_task."
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
        info.with_instructions(
            "Tildone is the user's personal task manager. Tasks have a status (todo/doing/done), \
             an optional project (otherwise they sit in the Inbox), optional tags, a priority \
             (0 none – 3 high) and an optional due date (YYYY-MM-DD). Refer to projects and tags \
             by name. Start with list_projects/list_tasks to see what exists; deleting a project \
             is irreversible, deleted tasks go to a restorable trash.",
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

fn requested_port() -> u16 {
    let env_override = std::env::var("TILDONE_AGENT_PORT").ok();
    resolve_port(env_override.as_deref(), cfg!(debug_assertions))
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
) -> Result<String, String> {
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
    let ct = CancellationToken::new();
    let config = server_config(port).with_cancellation_token(ct.child_token());
    let emitter = app.clone();
    let on_change: Notify = Arc::new(move || {
        let _ = emitter.emit("agent-db-changed", ());
    });
    // The same token the server shuts down on, so a parked list_changes is
    // released by agent_server_stop / app exit instead of holding them up.
    let agent_ct = ct.clone();
    let service: StreamableHttpService<TildoneAgent, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(TildoneAgent::new(db.clone(), on_change.clone(), agent_ct.clone())),
            Default::default(),
            config,
        );
    let router = axum::Router::new().nest_service("/mcp", service);

    let serve_ct = ct.clone();
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move { serve_ct.cancelled_owned().await })
            .await;
    });

    *state.0.lock().unwrap() = Some((ct, endpoint.clone()));
    Ok(endpoint)
}

#[tauri::command]
pub fn agent_server_stop(state: State<'_, AgentServer>) {
    if let Some((ct, _)) = state.0.lock().unwrap().take() {
        ct.cancel();
    }
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
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn
    }

    fn test_agent() -> TildoneAgent {
        TildoneAgent::new(
            Arc::new(Mutex::new(migrated_conn())),
            Arc::new(|| {}),
            CancellationToken::new(),
        )
    }

    fn test_agent_with_db() -> (TildoneAgent, Db) {
        let db: Db = Arc::new(Mutex::new(migrated_conn()));
        (
            TildoneAgent::new(db.clone(), Arc::new(|| {}), CancellationToken::new()),
            db,
        )
    }

    // ---- item 7: task <-> repo links ----

    fn a_task(agent: &TildoneAgent, title: &str) -> i64 {
        let (is_err, task) = extract(
            &agent
                .create_task(Parameters(CreateTaskParams {
                    title: title.into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    status: None,
                }))
                .unwrap(),
        );
        assert!(!is_err, "create_task failed: {task}");
        task["id"].as_i64().unwrap()
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
                .add_link(Parameters(AddLinkParams {
                    task_id,
                    url: url.into(),
                    label: label.map(Into::into),
                    kind: kind.map(Into::into),
                }))
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

        let (_, task) = extract(&agent.get_task(Parameters(IdParams { id })).unwrap());
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
        extract(&agent.delete_task(Parameters(IdParams { id })).unwrap());
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
            extract(&agent.delete_link(Parameters(IdParams { id: link_id })).unwrap());
        assert!(!is_err);
        let (_, task) = extract(&agent.get_task(Parameters(IdParams { id })).unwrap());
        assert_eq!(task["links"].as_array().unwrap().len(), 0);
        let (missing, _) = extract(&agent.delete_link(Parameters(IdParams { id: 9999 })).unwrap());
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
                .create_task(Parameters(CreateTaskParams {
                    title: "Ship it".into(),
                    project: Some("Work".into()),
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    status: None,
                }))
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
                .create_task(Parameters(CreateTaskParams {
                    title: "Logged work".into(),
                    project: None,
                    notes: Some("Goal: ship it".into()),
                    due_date: None,
                    priority: None,
                    tags: None,
                    status: None,
                }))
                .unwrap(),
        );
        let id = task["id"].as_i64().unwrap();

        let (is_err, ack) = extract(
            &agent
                .append_note(Parameters(AppendNoteParams {
                    id,
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
                    id,
                    text: "- 00:02 done".into(),
                }))
                .unwrap(),
        );

        let (_, full) = extract(&agent.get_task(Parameters(IdParams { id })).unwrap());
        assert_eq!(
            full["notes"], "Goal: ship it\n- 00:01 started\n- 00:02 done",
            "earlier notes must survive verbatim"
        );

        // Unknown and trashed ids are tool errors, not silent no-ops.
        let (is_err, msg) = extract(
            &agent
                .append_note(Parameters(AppendNoteParams {
                    id: 9999,
                    text: "x".into(),
                }))
                .unwrap(),
        );
        assert!(is_err, "unknown id must error: {msg}");

        extract(&agent.delete_task(Parameters(IdParams { id })).unwrap());
        let (is_err, msg) = extract(
            &agent
                .append_note(Parameters(AppendNoteParams { id, text: "x".into() }))
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
                .create_task(Parameters(CreateTaskParams {
                    title: "Ship it".into(),
                    project: Some("Work".into()),
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    status: None,
                }))
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
                .create_task(Parameters(CreateTaskParams {
                    title: "Ship it".into(),
                    project: Some("work".into()), // case-insensitive
                    notes: Some("the big one".into()),
                    due_date: Some("2026-07-10".into()),
                    priority: Some(3),
                    tags: Some(vec!["release".into()]),
                    status: None,
                }))
                .unwrap(),
        );
        assert!(!is_err, "create_task failed: {task}");
        assert_eq!(task["title"], "Ship it");
        assert_eq!(task["status"], "todo");
        let id = task["id"].as_i64().unwrap();

        // The write returns a receipt, not the row — so verify what actually
        // persisted via get_task rather than trusting the response echo.
        let (_, full) = extract(&agent.get_task(Parameters(IdParams { id })).unwrap());
        assert_eq!(full["project"]["name"], "Work");
        assert_eq!(full["tags"][0], "release");
        assert_eq!(full["priority"], 3);
        assert_eq!(full["notes"], "the big one");

        // Inbox task (no project) gets position 0 in its own group.
        let (_, inbox_task) = extract(
            &agent
                .create_task(Parameters(CreateTaskParams {
                    title: "Loose end".into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    status: None,
                }))
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
            &agent.complete_task(Parameters(IdParams { id })).unwrap(),
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
                .update_task(Parameters(UpdateTaskParams {
                    id,
                    title: None,
                    notes: None,
                    status: Some("todo".into()),
                    priority: Some(0),
                    due_date: Some("".into()),
                    project: Some("inbox".into()),
                    tags: None,
                }))
                .unwrap(),
        );
        assert_eq!(updated["status"], "todo");
        assert_eq!(updated["completed_at"], Value::Null);
        assert_eq!(updated["due_date"], Value::Null);
        assert_eq!(updated["project"], Value::Null);

        // delete_task is a soft delete; further updates are refused.
        let (is_err, msg) = extract(&agent.delete_task(Parameters(IdParams { id })).unwrap());
        assert!(!is_err, "{msg}");
        let (is_err, msg) = extract(
            &agent.complete_task(Parameters(IdParams { id })).unwrap(),
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
                .create_task(Parameters(CreateTaskParams {
                    title: "Logged work".into(),
                    project: None,
                    notes: Some(CANONICAL_NOTES.into()),
                    due_date: None,
                    priority: None,
                    tags: None,
                    status: None,
                }))
                .unwrap(),
        );
        let id = task["id"].as_i64().unwrap();

        extract(
            &agent
                .append_note(Parameters(AppendNoteParams {
                    id,
                    text: "- 14:32 tests written (RED, 5 failing)".into(),
                }))
                .unwrap(),
        );

        let (_, full) = extract(&agent.get_task(Parameters(IdParams { id })).unwrap());
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
                .create_task(Parameters(CreateTaskParams {
                    title: "Build it".into(),
                    project: None,
                    notes: Some(CANONICAL_NOTES.into()),
                    due_date: None,
                    priority: None,
                    tags: None,
                    status: None,
                }))
                .unwrap(),
        );
        let id = task["id"].as_i64().unwrap();

        let (is_err, ack) = extract(
            &agent
                .log_progress(Parameters(LogProgressParams {
                    task_id: id,
                    text: "  tests written (RED, 5 failing)  ".into(),
                }))
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
        let (_, full) = extract(&agent.get_task(Parameters(IdParams { id })).unwrap());
        assert_eq!(full["notes"].as_str().unwrap(), CANONICAL_NOTES);
    }

    #[test]
    fn log_progress_rejects_empty_unknown_and_trashed() {
        let agent = test_agent();
        let (_, task) = extract(
            &agent
                .create_task(Parameters(CreateTaskParams {
                    title: "Build it".into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    status: None,
                }))
                .unwrap(),
        );
        let id = task["id"].as_i64().unwrap();

        let (is_err, _) = extract(
            &agent
                .log_progress(Parameters(LogProgressParams {
                    task_id: id,
                    text: "   ".into(),
                }))
                .unwrap(),
        );
        assert!(is_err, "empty log text must be refused");

        let (is_err, _) = extract(
            &agent
                .log_progress(Parameters(LogProgressParams {
                    task_id: 999_999,
                    text: "ghost".into(),
                }))
                .unwrap(),
        );
        assert!(is_err, "unknown task must be refused");

        // Same rule the subtask writes follow: a trashed task takes no writes.
        extract(&agent.delete_task(Parameters(IdParams { id })).unwrap());
        let (is_err, out) = extract(
            &agent
                .log_progress(Parameters(LogProgressParams {
                    task_id: id,
                    text: "still going".into(),
                }))
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
                .create_task(Parameters(CreateTaskParams {
                    title: "Build it".into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    status: None,
                }))
                .unwrap(),
        );
        let task_id = task["id"].as_i64().unwrap();

        let mut ids = Vec::new();
        for title in ["write test", "implement", "verify"] {
            let (is_err, out) = extract(
                &agent
                    .add_subtask(Parameters(AddSubtaskParams {
                        task_id,
                        title: title.into(),
                    }))
                    .unwrap(),
            );
            assert!(!is_err, "add_subtask failed: {out}");
            ids.push(out["id"].as_i64().unwrap());
        }

        let (_, out) = extract(
            &agent
                .set_subtask(Parameters(SetSubtaskParams {
                    id: ids[0],
                    done: Some(true),
                    title: None,
                }))
                .unwrap(),
        );
        assert_eq!(out["progress"]["done"], 1);
        assert_eq!(out["progress"]["total"], 3);

        // Order is insertion order, and the tick is visible to the next reader.
        let (_, full) = extract(&agent.get_task(Parameters(IdParams { id: task_id })).unwrap());
        let subs = full["subtasks"].as_array().unwrap();
        assert_eq!(subs.len(), 3);
        assert_eq!(subs[0]["title"], "write test");
        assert_eq!(subs[0]["done"], true);
        assert_eq!(subs[2]["title"], "verify");

        let (_, out) = extract(
            &agent
                .delete_subtask(Parameters(IdParams { id: ids[2] }))
                .unwrap(),
        );
        assert_eq!(out["progress"]["total"], 2);

        // Untick walks progress back down.
        let (_, out) = extract(
            &agent
                .set_subtask(Parameters(SetSubtaskParams {
                    id: ids[0],
                    done: Some(false),
                    title: None,
                }))
                .unwrap(),
        );
        assert_eq!(out["progress"]["done"], 0);

        agent
            .delete_task(Parameters(IdParams { id: task_id }))
            .unwrap();
        let (is_err, _) = extract(
            &agent
                .set_subtask(Parameters(SetSubtaskParams {
                    id: ids[1],
                    done: Some(true),
                    title: None,
                }))
                .unwrap(),
        );
        assert!(is_err, "a trashed parent must refuse subtask writes");
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
                .create_task(Parameters(CreateTaskParams {
                    title: title.into(),
                    project: None,
                    notes: None,
                    due_date: Some(due.into()),
                    priority: None,
                    tags: None,
                    status: None,
                }))
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
                .create_task(Parameters(CreateTaskParams {
                    title: title.into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: (title == "c").then(|| vec!["find-me".to_string()]),
                    status: None,
                }))
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
                .create_task(Parameters(CreateTaskParams {
                    title: title.into(),
                    project: project.map(Into::into),
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    status: status.map(Into::into),
                }))
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
                .create_task(Parameters(CreateTaskParams {
                    title: title.into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    status: None,
                }))
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
                .create_task(Parameters(CreateTaskParams {
                    title: title.into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    status: None,
                }))
                .unwrap(),
        );
        assert!(!is_err, "{v}");
        v["id"].as_i64().unwrap()
    }

    fn set_status(agent: &TildoneAgent, id: i64, status: &str) {
        let (is_err, v) = extract(
            &agent
                .update_task(Parameters(UpdateTaskParams {
                    id,
                    title: None,
                    notes: None,
                    status: Some(status.into()),
                    priority: None,
                    due_date: None,
                    project: None,
                    tags: None,
                }))
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
            let (is_err, v) = extract(&agent.complete_task(Parameters(IdParams { id })).unwrap());
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
            agent.complete_task(Parameters(IdParams { id: *id })).unwrap();
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

        agent.complete_task(Parameters(IdParams { id: ids[4] })).unwrap();

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
                .create_task(Parameters(CreateTaskParams {
                    title: "already in work".into(),
                    project: Some("work".into()),
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    status: None,
                }))
                .unwrap(),
        );
        let work_task = v["id"].as_i64().unwrap();

        let (is_err, v) = extract(
            &agent
                .update_task(Parameters(UpdateTaskParams {
                    id: inbox_task,
                    title: None,
                    notes: None,
                    status: None,
                    priority: None,
                    due_date: None,
                    project: Some("work".into()),
                    tags: None,
                }))
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
            .update_task(Parameters(UpdateTaskParams {
                id: a,
                title: Some("renamed".into()),
                notes: None,
                status: None,
                priority: Some(3),
                due_date: None,
                project: None,
                tags: None,
            }))
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
                .create_task(Parameters(CreateTaskParams {
                    title: "Work".into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    status: None,
                }))
                .unwrap(),
        );
        let id = created["id"].as_i64().unwrap();

        let (_, base_v) = extract(&agent.list_changes(no_wait(None)).await.unwrap());
        let base = base_v["cursor"].as_i64().unwrap();

        agent
            .update_task(Parameters(UpdateTaskParams {
                id,
                title: None,
                notes: None,
                status: Some("doing".into()),
                priority: None,
                due_date: None,
                project: None,
                tags: None,
            }))
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
        let agent = TildoneAgent::new(db, Arc::new(|| {}), token.clone());

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
                .create_task(Parameters(CreateTaskParams {
                    title: "while you were waiting".into(),
                    project: None,
                    notes: None,
                    due_date: None,
                    priority: None,
                    tags: None,
                    status: None,
                }))
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
}
