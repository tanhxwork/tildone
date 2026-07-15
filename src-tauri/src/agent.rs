// MCP server exposing task/project management to external AI agents.
// Streamable HTTP on 127.0.0.1:AGENT_PORT, opt-in via the settings dialog.
// Opens its own SQLite connection to the same tildone.db the frontend uses;
// after every write it emits `agent-db-changed` so the UI reloads.

use std::sync::{Arc, Mutex};

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, ContentBlock, ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ErrorData, ServerHandler,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

pub const AGENT_PORT: u16 = 11502;

const STATUSES: [&str; 3] = ["todo", "doing", "done"];

// Mirrors COLOR_CHOICES in src/types.ts.
const COLOR_CHOICES: [&str; 8] = [
    "#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#64748b",
];

#[derive(Default)]
pub struct AgentServer(Mutex<Option<CancellationToken>>);

type Db = Arc<Mutex<Connection>>;

/// Called after every successful write so the app UI can refresh.
type Notify = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone)]
struct TildoneAgent {
    #[allow(dead_code)] // read by the tool_handler macro
    tool_router: ToolRouter<Self>,
    db: Db,
    on_change: Notify,
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
    fn new(db: Db, on_change: Notify) -> Self {
        Self {
            tool_router: Self::tool_router(),
            db,
            on_change,
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

    fn next_position(
        conn: &Connection,
        project_id: Option<i64>,
        status: &str,
    ) -> Result<i64, rusqlite::Error> {
        conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM tasks
             WHERE deleted_at IS NULL AND status = ?1
               AND (project_id IS ?2 OR project_id = ?2)",
            rusqlite::params![status, project_id],
            |r| r.get(0),
        )
    }

    fn record_activity(conn: &Connection, task_id: i64, label: &str) {
        let _ = conn.execute(
            "INSERT INTO task_activity (task_id, label, created_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![task_id, label, now_iso()],
        );
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
                "SELECT t.id, t.title, t.notes, t.status, t.priority, t.due_date,
                        t.created_at, t.completed_at, t.deleted_at, t.project_id, p.name
                 FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
                 WHERE t.id = ?1",
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
        let current: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT status, deleted_at FROM tasks WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map_err(db_err)?;
        let Some((old_status, deleted_at)) = current else {
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
        if let Some(status) = &status {
            if !STATUSES.contains(&status.as_str()) {
                return Ok(err("status must be one of: todo, doing, done."));
            }
            if *status != old_status {
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
                }
                Err(msg) => return Ok(err(msg)),
            }
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

        let sql = format!(
            "SELECT t.id, t.title, t.status, t.priority, t.due_date, t.completed_at, p.name,
                    (SELECT GROUP_CONCAT(tg.name, ', ') FROM tags tg
                     JOIN task_tags tt ON tt.tag_id = tg.id WHERE tt.task_id = t.id)
             FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
             WHERE {}
             ORDER BY t.due_date IS NULL, t.due_date, p.position, t.position, t.id",
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
        let position = Self::next_position(&conn, project_id, &status).map_err(db_err)?;
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
}

#[tool_handler]
impl ServerHandler for TildoneAgent {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::new(ServerCapabilities::builder().enable_tools().build());
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
}

// ---------------------------------------------------------------------------
// Lifecycle commands

/// Loopback Host validation is rmcp's default (blocks DNS rebinding); on top
/// of that, reject any browser-originated request outright: web pages always
/// send an Origin header and can never legitimately talk to this server, while
/// real MCP clients (CLIs, desktop apps) send none and pass.
fn server_config() -> StreamableHttpServerConfig {
    StreamableHttpServerConfig::default().with_allowed_origins([
        format!("http://127.0.0.1:{AGENT_PORT}"),
        format!("http://localhost:{AGENT_PORT}"),
    ])
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
    let endpoint = format!("http://127.0.0.1:{AGENT_PORT}/mcp");
    {
        let guard = state.0.lock().unwrap();
        if let Some(ct) = guard.as_ref() {
            if !ct.is_cancelled() {
                return Ok(endpoint);
            }
        }
    }

    let db: Db = Arc::new(Mutex::new(open_db(&app)?));
    let ct = CancellationToken::new();
    let config = server_config().with_cancellation_token(ct.child_token());
    let emitter = app.clone();
    let on_change: Notify = Arc::new(move || {
        let _ = emitter.emit("agent-db-changed", ());
    });
    let service: StreamableHttpService<TildoneAgent, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(TildoneAgent::new(db.clone(), on_change.clone())),
            Default::default(),
            config,
        );
    let router = axum::Router::new().nest_service("/mcp", service);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", AGENT_PORT))
        .await
        .map_err(|e| format!("cannot listen on port {AGENT_PORT}: {e}"))?;

    let serve_ct = ct.clone();
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move { serve_ct.cancelled_owned().await })
            .await;
    });

    *state.0.lock().unwrap() = Some(ct);
    Ok(endpoint)
}

#[tauri::command]
pub fn agent_server_stop(state: State<'_, AgentServer>) {
    if let Some(ct) = state.0.lock().unwrap().take() {
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
        .is_some_and(|ct| !ct.is_cancelled())
}

/// Called from the app exit hook.
pub fn shutdown(app: &AppHandle) {
    if let Some(server) = app.try_state::<AgentServer>() {
        if let Some(ct) = server.0.lock().unwrap().take() {
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
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn
    }

    fn test_agent() -> TildoneAgent {
        TildoneAgent::new(Arc::new(Mutex::new(migrated_conn())), Arc::new(|| {}))
    }

    fn test_agent_with_db() -> (TildoneAgent, Db) {
        let db: Db = Arc::new(Mutex::new(migrated_conn()));
        (TildoneAgent::new(db.clone(), Arc::new(|| {})), db)
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

    /// Drives the real streamable-HTTP endpoint the way an MCP client does:
    /// initialize → initialized → tools/list → tools/call.
    #[tokio::test(flavor = "multi_thread")]
    async fn mcp_over_streamable_http() {
        let agent = test_agent();
        let ct = CancellationToken::new();
        // Same config as agent_server_start so origin/host validation is
        // exercised too.
        let config = server_config().with_cancellation_token(ct.child_token());
        let service: StreamableHttpService<TildoneAgent, LocalSessionManager> =
            StreamableHttpService::new(move || Ok(agent.clone()), Default::default(), config);
        let router = axum::Router::new().nest_service("/mcp", service);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
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
}
