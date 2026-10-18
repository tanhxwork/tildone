//! The hub: routes another Tildone uses when this machine holds its board.
//!
//! Mounted on the agent server beside /mcp (same port, same lifetime as Agent
//! access). A client (Settings → Board → hub URL + token) sends every db.ts query
//! here instead of opening its own tildone.db, and follows /events to stay live.
//!
//! Every route below requires all three guards, in this order:
//! - Host in the agent server's allow-list (`server_config` in agent.rs) or one of
//!   this machine's tailnet names (`agent::tailnet_hosts`), else 403;
//! - no `Origin` header (a browser page must never reach SQL), else 403;
//! - `Authorization: Bearer <token>` matching `hub-token`, else 401.
//!
//! Errors are `{"error": "<message>"}` with that status. /mcp is unchanged.
//!
//! Routes (wire contract shared with hubclient.rs):
//! - `POST /sql` body [`SqlRequest`]. `select` → 200 JSON array of rows, each an
//!   object keyed by column name (the shape tauri-plugin-sql returns: integers,
//!   reals, text, null). `execute` → 200 [`ExecuteResult`], and fires the same
//!   change notification as an MCP write. Params written `$1`, `$2`… bind by their
//!   number (`parameter_name`), not by position. A SQL error → 400.
//! - `GET /events` → SSE. First event `schema` with data `{"version": SCHEMA_VERSION}`,
//!   then one `change` event (data `{}`) per change notification, from MCP, /sql,
//!   /git-event, the secretary or forge alike.
//! - `GET /presence` → the JSON `agent_presence` returns.
//! - `GET /claim-cwds` → the JSON array `recent_claim_cwds` returns.
//! - `GET /git-remote?cwd=<path>` → JSON string or null, as `git_remote_url`.
//! - `GET /file?path=<path>` → the file's bytes (`application/octet-stream`).
//!   The path is absolute, relative to the hub's `<app data>` (as attachments are
//!   recorded: `attachments/<task_id>/<file>`), or starts with `~/` (expanded with
//!   the hub's home). Only paths `read_evidence_image` allows, or files under the
//!   hub's `<app data>/attachments/`, are served; anything else → 403.
//! - `POST /image?task_id=<n>&name=<file name>` raw body bytes → `{"path": "<rel>"}`.
//!   Stores the image as `<app data>/attachments/<task_id>/<name>`, as the window's
//!   saveImageFile does locally (src/utils/images.ts), and returns that path
//!   relative to `<app data>` (`attachments/<task_id>/<name>`), the form
//!   db.insertImage records through /sql.
//! - `/sql` refuses `ATTACH`, `DETACH` and `VACUUM`, and a `select` that is not
//!   read-only, with 400 "statement not allowed".

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Json;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;
use tokio_util::sync::CancellationToken;

use crate::agent::{Beats, Db, Notify};

/// The migration number this build's tildone.db is at: the last `version` in
/// lib.rs `migrations`. A client refuses a hub whose number differs.
pub const SCHEMA_VERSION: i64 = 30;

/// File in the app config dir holding the hub token. Generated once (random,
/// at least 32 url-safe characters) the first time Agent access starts.
pub const TOKEN_FILE: &str = "hub-token";

/// How long `hub_op_log` remembers an op key. A queued write retries within hours.
const OP_KEEP_SECS: i64 = 30 * 24 * 60 * 60;
/// Largest request body /sql accepts.
const SQL_BODY_LIMIT: usize = 10 * 1024 * 1024;
/// Largest image /image accepts.
const IMAGE_BODY_LIMIT: usize = 25 * 1024 * 1024;
/// How often /events sends a comment, so an idle proxy keeps the stream open.
const KEEP_ALIVE: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlRequest {
    /// "select" or "execute".
    pub kind: String,
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
    /// Idempotency key for an `execute`: a queued offline write sends the same key
    /// on every retry, and the hub runs it once (`hub_op_log`). Ignored by `select`.
    #[serde(default)]
    pub op: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResult {
    pub rows_affected: u64,
    pub last_insert_id: i64,
}

/// Everything the hub routes need, as plain values so tests can build the router
/// without a Tauri app.
#[derive(Clone)]
pub struct HubConfig {
    pub db: Db,
    /// The MCP tools' change signal (emits agent-db-changed). /sql calls it after a write.
    pub on_change: Notify,
    /// Live heartbeat state, for /presence.
    pub beats: Beats,
    /// One `()` per agent-db-changed app event; /events turns each into a `change`.
    pub events: tokio::sync::broadcast::Sender<()>,
    pub token: String,
    /// Host names the hub answers to (`agent::allowed_hosts` plus `agent::tailnet_hosts`).
    pub allowed_hosts: Vec<String>,
    /// The app data dir; attachments live in `<data_dir>/attachments/`.
    pub data_dir: PathBuf,
    /// The home dir that bounds evidence images (`read_evidence_image`).
    pub evidence_home: Option<PathBuf>,
    /// Cancelled when the server stops; open /events streams end with it.
    pub shutdown: CancellationToken,
}

/// The hub routes, to be merged into the agent server's router.
pub fn router(cfg: HubConfig) -> axum::Router {
    // No database can be attached on this connection, so ATTACH and VACUUM INTO
    // fail in SQLite itself whatever text gets past `refused_statement`. The app
    // never attaches a database. Plain VACUUM needs one too, so it also fails on
    // this connection (the MCP server's as well).
    {
        let conn = cfg.db.lock().unwrap_or_else(|e| e.into_inner());
        conn.set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_ATTACHED, 0);
        // The ledger of `execute` results by op key, so a retried write lands once.
        if let Err(e) = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS hub_op_log (key TEXT PRIMARY KEY, stmt TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL)",
        ) {
            eprintln!("hub: cannot create hub_op_log: {e}");
        } else if let Err(e) = prune_op_log(&conn) {
            eprintln!("hub: cannot prune hub_op_log: {e}");
        }
    }
    axum::Router::new()
        .route("/sql", post(sql))
        .route("/events", get(events))
        .route("/presence", get(presence))
        .route("/claim-cwds", get(claim_cwds))
        .route("/git-remote", get(git_remote))
        .route("/file", get(file))
        .route("/image", post(image))
        .with_state(cfg)
}

/// The hub's token, for Settings → Agent access (shown with a copy button).
/// Creates the token file if it does not exist yet.
#[tauri::command]
pub fn hub_token(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve app config dir: {e}"))?;
    ensure_token(&dir)
}

/// Read `<dir>/hub-token`, making it first if it is missing or empty. 32 random
/// bytes, url-safe base64 (43 characters), mode 0600 on unix.
pub fn ensure_token(dir: &Path) -> Result<String, String> {
    let path = dir.join(TOKEN_FILE);
    if let Some(token) = read_token(&path) {
        return Ok(token);
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let token = random_token()?;
    // An empty leftover file is replaced; a racing writer wins by create_new.
    let _ = std::fs::remove_file(&path);
    match write_new_private(&path, token.as_bytes()) {
        Ok(()) => Ok(token),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            read_token(&path).ok_or_else(|| "hub token file is empty".to_string())
        }
        Err(e) => Err(format!("cannot write {}: {e}", path.display())),
    }
}

fn read_token(path: &Path) -> Option<String> {
    let token = std::fs::read_to_string(path).ok()?.trim().to_string();
    (!token.is_empty()).then_some(token)
}

#[cfg(unix)]
fn random_token() -> Result<String, String> {
    use base64::Engine;
    use std::io::Read;
    // No rand/getrandom/uuid dependency here, so read the OS source directly.
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("cannot read random bytes: {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

#[cfg(not(unix))]
fn random_token() -> Result<String, String> {
    Err("no random source on this platform".into())
}

fn write_new_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)
}

// ---- guards ----

fn err(status: StatusCode, msg: impl std::fmt::Display) -> Response {
    (status, Json(json!({ "error": msg.to_string() }))).into_response()
}

/// Compare without stopping at the first differing byte.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The host name of a Host header: no port, no IPv6 brackets, lowercased.
fn host_name(host: &str) -> String {
    let name = match host.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or_default(),
        None => host.rsplit_once(':').map_or(host, |(n, _)| n),
    };
    name.to_ascii_lowercase()
}

/// Host, then Origin, then token. `Err` is the response to send.
#[allow(clippy::result_large_err)]
fn guard(cfg: &HubConfig, headers: &HeaderMap) -> Result<(), Response> {
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(host_name);
    if !host.is_some_and(|h| cfg.allowed_hosts.iter().any(|a| a.eq_ignore_ascii_case(&h))) {
        return Err(err(StatusCode::FORBIDDEN, "host not allowed"));
    }
    if headers.contains_key(header::ORIGIN) {
        return Err(err(StatusCode::FORBIDDEN, "browser requests are refused"));
    }
    let given = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match given {
        Some(t)
            if !cfg.token.is_empty() && constant_time_eq(t.as_bytes(), cfg.token.as_bytes()) =>
        {
            Ok(())
        }
        _ => Err(err(StatusCode::UNAUTHORIZED, "missing or wrong hub token")),
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len()
                && b[i + 1].is_ascii_hexdigit()
                && b[i + 2].is_ascii_hexdigit() =>
            {
                let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("00");
                out.push(u8::from_str_radix(hex, 16).unwrap_or(0));
                i += 2;
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_params(uri: &Uri) -> HashMap<String, String> {
    uri.query()
        .unwrap_or_default()
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (percent_decode(k), percent_decode(v))
        })
        .collect()
}

/// Run blocking work (rusqlite, files, git) off the async runtime.
#[allow(clippy::result_large_err)]
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Response> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))
}

// ---- /sql ----

fn bind_value(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        // SQLite has no bool, and the schema keeps flags as 0/1 integers. plugin-sql
        // would bind a JSON bool as the text "true" (wrapper.rs falls through to
        // sqlx's JSON encoding), which `WHERE flag = 1` never matches, so the hub
        // binds the integer instead.
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().unwrap_or(f64::NAN)),
        },
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Array(_) | Value::Object(_) => SqlValue::Text(v.to_string()),
    }
}

fn column_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        // plugin-sql returns a blob as an array of numbers.
        ValueRef::Blob(b) => Value::Array(b.iter().map(|n| Value::from(*n)).collect()),
    }
}

const NOT_ALLOWED: &str = "statement not allowed";

/// True for ATTACH, DETACH and VACUUM (which includes VACUUM INTO): they reach
/// files outside the board. Judged by the first keyword, after whitespace, comments,
/// `;` (SQLite skips an empty statement and compiles the next one) and a BOM,
/// because a statement that starts with one of them is that statement. The real
/// stop is SQLITE_LIMIT_ATTACHED = 0 (`router`); this gives the clear error.
fn refused_statement(sql: &str) -> bool {
    let mut rest = sql;
    loop {
        rest = rest.trim_start();
        if let Some(r) = rest.strip_prefix("--") {
            rest = r.split_once('\n').map_or("", |(_, tail)| tail);
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r.split_once("*/").map_or("", |(_, tail)| tail);
        } else if let Some(r) = rest.strip_prefix([';', '\u{feff}']) {
            rest = r;
        } else {
            break;
        }
    }
    let word: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_lowercase();
    matches!(word.as_str(), "attach" | "detach" | "vacuum")
}

fn prune_op_log(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM hub_op_log WHERE at < ?1",
        [unix_now() - OP_KEEP_SECS],
    )
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// `run_sql`, and for an `execute` carrying an op key, once per key: a key already
/// in `hub_op_log` returns the stored result without running the statement, or 409
/// when the stored statement (sql and params) is not this one; otherwise the
/// statement and its ledger row commit together, and a failure stores nothing.
/// The bool is whether the statement ran (false on a ledger hit).
fn run_sql_once(
    conn: &Connection,
    req: &SqlRequest,
) -> Result<(Value, bool), (StatusCode, String)> {
    let bad = |e: String| (StatusCode::BAD_REQUEST, e);
    let Some(key) = req.op.as_deref().filter(|_| req.kind == "execute") else {
        return run_sql(conn, req).map(|v| (v, true)).map_err(bad);
    };
    if refused_statement(&req.sql) {
        return Err(bad(NOT_ALLOWED.into()));
    }
    let stmt = json!([req.sql, req.params]).to_string();
    let tx = conn.unchecked_transaction().map_err(|e| bad(e.to_string()))?;
    let stored: Option<(String, String)> = tx
        .query_row(
            "SELECT stmt, result FROM hub_op_log WHERE key = ?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            e => Err(bad(e.to_string())),
        })?;
    if let Some((stored_stmt, result)) = stored {
        if stored_stmt != stmt {
            return Err((
                StatusCode::CONFLICT,
                format!("op key {key} was used for a different statement"),
            ));
        }
        let v = serde_json::from_str(&result).map_err(|e| bad(e.to_string()))?;
        return Ok((v, false));
    }
    let v = run_sql(&tx, req).map_err(bad)?;
    // Prune here too, so a hub that stays up for weeks does.
    if let Err(e) = prune_op_log(&tx) {
        eprintln!("hub: cannot prune hub_op_log: {e}");
    }
    tx.execute(
        "INSERT INTO hub_op_log (key, stmt, result, at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![key, stmt, v.to_string(), unix_now()],
    )
    .map_err(|e| bad(e.to_string()))?;
    tx.commit().map_err(|e| bad(e.to_string()))?;
    Ok((v, true))
}

/// Run one statement. Parameters named `$N` bind by their number, so `$2` before
/// `$1` and a repeated `$1` work; `?` parameters bind by position.
fn run_sql(conn: &Connection, req: &SqlRequest) -> Result<Value, String> {
    if refused_statement(&req.sql) {
        return Err(NOT_ALLOWED.into());
    }
    let mut stmt = conn.prepare(&req.sql).map_err(|e| e.to_string())?;
    if req.kind == "select" && !stmt.readonly() {
        return Err(NOT_ALLOWED.into());
    }
    for i in 1..=stmt.parameter_count() {
        let n = match stmt.parameter_name(i) {
            Some(name) => name
                .trim_start_matches(['$', '?'])
                .parse::<usize>()
                .map_err(|_| format!("unsupported parameter name {name}"))?,
            None => i,
        };
        let value = n
            .checked_sub(1)
            .and_then(|k| req.params.get(k))
            .ok_or_else(|| format!("no value for parameter ${n}"))?;
        stmt.raw_bind_parameter(i, bind_value(value))
            .map_err(|e| e.to_string())?;
    }
    match req.kind.as_str() {
        "select" => {
            let cols: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
            let mut rows = stmt.raw_query();
            let mut out = Vec::new();
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let mut obj = serde_json::Map::new();
                for (i, name) in cols.iter().enumerate() {
                    let v = row.get_ref(i).map_err(|e| e.to_string())?;
                    obj.insert(name.clone(), column_json(v));
                }
                out.push(Value::Object(obj));
            }
            Ok(Value::Array(out))
        }
        "execute" => {
            let affected = if stmt.column_count() == 0 {
                stmt.raw_execute().map_err(|e| e.to_string())?
            } else {
                // INSERT … RETURNING: run it to completion, drop the rows.
                let mut rows = stmt.raw_query();
                while rows.next().map_err(|e| e.to_string())?.is_some() {}
                drop(rows);
                conn.changes() as usize
            };
            let result = ExecuteResult {
                rows_affected: affected as u64,
                last_insert_id: conn.last_insert_rowid(),
            };
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        other => Err(format!("unknown kind {other:?}")),
    }
}

async fn sql(State(cfg): State<HubConfig>, headers: HeaderMap, body: Body) -> Response {
    if let Err(r) = guard(&cfg, &headers) {
        return r;
    }
    let Ok(bytes) = axum::body::to_bytes(body, SQL_BODY_LIMIT).await else {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "request body too large");
    };
    let req: SqlRequest = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => return err(StatusCode::BAD_REQUEST, format!("bad request: {e}")),
    };
    let is_write = req.kind == "execute";
    let db = cfg.db.clone();
    let result = match blocking(move || {
        let conn = db.lock().unwrap_or_else(|e| e.into_inner());
        run_sql_once(&conn, &req)
    })
    .await
    {
        Ok(r) => r,
        Err(r) => return r,
    };
    match result {
        Ok((v, ran)) => {
            if is_write && ran {
                (cfg.on_change)();
            }
            Json(v).into_response()
        }
        Err((status, e)) => err(status, e),
    }
}

// ---- /events ----

async fn events(State(cfg): State<HubConfig>, headers: HeaderMap) -> Response {
    if let Err(r) = guard(&cfg, &headers) {
        return r;
    }
    use futures_util::future::{select, Either};
    use tokio::sync::broadcast::error::RecvError;
    let first = format!("event: schema\ndata: {{\"version\":{SCHEMA_VERSION}}}\n\n");
    let rx = cfg.events.subscribe();
    let tick = tokio::time::interval_at(tokio::time::Instant::now() + KEEP_ALIVE, KEEP_ALIVE);
    let shutdown = cfg.shutdown.clone();
    let stream = futures_util::stream::unfold(
        (Some(first), rx, tick, shutdown),
        |(first, mut rx, mut tick, shutdown)| async move {
            if let Some(f) = first {
                let item = Ok::<_, std::convert::Infallible>(Bytes::from(f));
                return Some((item, (None, rx, tick, shutdown)));
            }
            let next = shutdown
                .run_until_cancelled(async {
                    match select(Box::pin(rx.recv()), Box::pin(tick.tick())).await {
                        // A lagged receiver missed changes: one more tells the client to reload.
                        Either::Left((Ok(()) | Err(RecvError::Lagged(_)), _)) => {
                            Some("event: change\ndata: {}\n\n")
                        }
                        Either::Left((Err(RecvError::Closed), _)) => None,
                        Either::Right(_) => Some(": keep-alive\n\n"),
                    }
                })
                .await
                .flatten()?;
            Some((Ok(Bytes::from(next)), (None, rx, tick, shutdown)))
        },
    );
    Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))
}

// ---- presence, claim cwds, git remote ----

async fn presence(State(cfg): State<HubConfig>, headers: HeaderMap) -> Response {
    if let Err(r) = guard(&cfg, &headers) {
        return r;
    }
    match blocking(move || crate::agent::presence_snapshot(&cfg.db, &cfg.beats)).await {
        Ok(entries) => Json(entries).into_response(),
        Err(r) => r,
    }
}

async fn claim_cwds(State(cfg): State<HubConfig>, headers: HeaderMap) -> Response {
    if let Err(r) = guard(&cfg, &headers) {
        return r;
    }
    let db = cfg.db.clone();
    let cwds = blocking(move || {
        let conn = db.lock().unwrap_or_else(|e| e.into_inner());
        crate::agent::claim_cwds(&conn)
    })
    .await;
    match cwds {
        Ok(c) => Json(c).into_response(),
        Err(r) => r,
    }
}

async fn git_remote(State(cfg): State<HubConfig>, headers: HeaderMap, uri: Uri) -> Response {
    if let Err(r) = guard(&cfg, &headers) {
        return r;
    }
    let Some(cwd) = query_params(&uri).remove("cwd") else {
        return err(StatusCode::BAD_REQUEST, "missing cwd");
    };
    match blocking(move || crate::evidence::git_remote_url(cwd)).await {
        Ok(url) => Json(url).into_response(),
        Err(r) => r,
    }
}

// ---- /file and /image ----

fn attachments_dir(cfg: &HubConfig) -> PathBuf {
    cfg.data_dir.join("attachments")
}

/// The bytes at `path` if it is an attachment of this hub, or evidence
/// `read_evidence_image` would serve. Otherwise `Err`: the caller answers 403.
fn read_allowed(cfg: &HubConfig, path: &Path) -> Result<Vec<u8>, String> {
    // `~/x` is the hub's own home (its agents write evidence paths that way); a
    // relative path is relative to the app data dir, as attachments are recorded.
    let resolved = match path.strip_prefix("~") {
        Ok(rest) if !rest.as_os_str().is_empty() => cfg
            .evidence_home
            .as_deref()
            .ok_or("no home directory")?
            .join(rest),
        _ if path.is_relative() => cfg.data_dir.join(path),
        _ => path.to_path_buf(),
    };
    let path = resolved.as_path();
    if let (Ok(real), Ok(root)) = (
        std::fs::canonicalize(path),
        std::fs::canonicalize(attachments_dir(cfg)),
    ) {
        if real.starts_with(&root) {
            if !real.is_file() {
                return Err("not a file".into());
            }
            return std::fs::read(&real).map_err(|e| e.to_string());
        }
    }
    let home = cfg.evidence_home.as_deref().ok_or("no home directory")?;
    crate::evidence::read_vetted(crate::evidence::open_vetted(path, home)?)
}

async fn file(State(cfg): State<HubConfig>, headers: HeaderMap, uri: Uri) -> Response {
    if let Err(r) = guard(&cfg, &headers) {
        return r;
    }
    let Some(path) = query_params(&uri).remove("path") else {
        return err(StatusCode::BAD_REQUEST, "missing path");
    };
    match blocking(move || read_allowed(&cfg, Path::new(&path))).await {
        Ok(Ok(bytes)) => {
            ([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response()
        }
        Ok(Err(e)) => err(StatusCode::FORBIDDEN, e),
        Err(r) => r,
    }
}

/// A file name that stays inside its task folder.
fn safe_name(name: &str) -> bool {
    !name.is_empty() && name != "." && !name.contains(['/', '\\', '\0']) && !name.contains("..")
}

async fn image(State(cfg): State<HubConfig>, headers: HeaderMap, uri: Uri, body: Body) -> Response {
    if let Err(r) = guard(&cfg, &headers) {
        return r;
    }
    let q = query_params(&uri);
    let Some(task_id) = q
        .get("task_id")
        .and_then(|t| t.parse::<i64>().ok())
        .filter(|t| *t > 0)
    else {
        return err(StatusCode::BAD_REQUEST, "task_id must be a positive number");
    };
    let Some(name) = q.get("name").filter(|n| safe_name(n)).cloned() else {
        return err(StatusCode::BAD_REQUEST, "bad image name");
    };
    let Ok(bytes) = axum::body::to_bytes(body, IMAGE_BODY_LIMIT).await else {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "image too large");
    };
    let dir = attachments_dir(&cfg).join(task_id.to_string());
    let stored = dir.join(&name);
    let written = blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(&stored, &bytes).map_err(|e| e.to_string())
    })
    .await;
    match written {
        Ok(Ok(())) => {
            Json(json!({ "path": format!("attachments/{task_id}/{name}") })).into_response()
        }
        Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
        Err(r) => r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    const TOKEN: &str = "test-token-0123456789-abcdefghijklmnop";

    struct Hub {
        base: String,
        client: reqwest::Client,
        changes: Arc<AtomicUsize>,
        events: tokio::sync::broadcast::Sender<()>,
        shutdown: CancellationToken,
        dir: PathBuf,
        db: Db,
    }

    impl Hub {
        fn get(&self, path: &str) -> reqwest::RequestBuilder {
            self.client
                .get(format!("{}{path}", self.base))
                .bearer_auth(TOKEN)
        }
        fn post(&self, path: &str) -> reqwest::RequestBuilder {
            self.client
                .post(format!("{}{path}", self.base))
                .bearer_auth(TOKEN)
        }
        async fn sql(&self, kind: &str, sql: &str, params: Value) -> reqwest::Response {
            self.post("/sql")
                .json(&json!({ "kind": kind, "sql": sql, "params": params }))
                .send()
                .await
                .unwrap()
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tildone-hub-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    async fn start(name: &str) -> Hub {
        let dir = scratch(name);
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, a, b);
             CREATE TABLE agent_claims (cwd TEXT, claimed_at TEXT);",
        )
        .unwrap();
        let changes = Arc::new(AtomicUsize::new(0));
        let counter = changes.clone();
        let (events, _) = tokio::sync::broadcast::channel(16);
        let shutdown = CancellationToken::new();
        let db: Db = Arc::new(Mutex::new(conn));
        let cfg = HubConfig {
            db: db.clone(),
            on_change: Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
            beats: Default::default(),
            events: events.clone(),
            token: TOKEN.into(),
            allowed_hosts: vec!["localhost".into(), "127.0.0.1".into(), "myhost".into()],
            data_dir: dir.join("data"),
            evidence_home: Some(dir.join("home")),
            shutdown: shutdown.clone(),
        };
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::create_dir_all(dir.join("home")).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let serve_ct = shutdown.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router(cfg))
                .with_graceful_shutdown(async move { serve_ct.cancelled_owned().await })
                .await;
        });
        Hub {
            base: format!("http://127.0.0.1:{port}"),
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            changes,
            events,
            shutdown,
            dir,
            db,
        }
    }

    async fn error_of(r: reqwest::Response) -> (u16, String) {
        let status = r.status().as_u16();
        let body: Value = r.json().await.unwrap();
        (
            status,
            body["error"].as_str().unwrap_or_default().to_string(),
        )
    }

    #[tokio::test]
    async fn every_route_refuses_a_missing_or_wrong_token_an_origin_and_a_bad_host() {
        let hub = start("guards").await;
        let routes: [(&str, &str); 7] = [
            ("POST", "/sql"),
            ("GET", "/events"),
            ("GET", "/presence"),
            ("GET", "/claim-cwds"),
            ("GET", "/git-remote?cwd=/"),
            ("GET", "/file?path=/x"),
            ("POST", "/image?task_id=1&name=a.png"),
        ];
        for (method, path) in routes {
            let url = format!("{}{path}", hub.base);
            let req = |m: &str| {
                if m == "POST" {
                    hub.client.post(&url).body("{}")
                } else {
                    hub.client.get(&url)
                }
            };
            let none = req(method).send().await.unwrap();
            assert_eq!(none.status().as_u16(), 401, "{path} without a token");
            let wrong = req(method).bearer_auth("nope").send().await.unwrap();
            assert_eq!(wrong.status().as_u16(), 401, "{path} with a wrong token");
            let origin = req(method)
                .bearer_auth(TOKEN)
                .header("origin", "http://evil.example")
                .send()
                .await
                .unwrap();
            assert_eq!(origin.status().as_u16(), 403, "{path} with an Origin");
            let host = req(method)
                .bearer_auth(TOKEN)
                .header("host", "evil.example")
                .send()
                .await
                .unwrap();
            assert_eq!(host.status().as_u16(), 403, "{path} with a bad Host");
        }
        // The error body is {"error": msg}; a bad Host wins over a missing token.
        let r = hub
            .client
            .get(format!("{}/presence", hub.base))
            .header("host", "evil.example")
            .send()
            .await
            .unwrap();
        let (status, msg) = error_of(r).await;
        assert_eq!(status, 403);
        assert!(!msg.is_empty());
        // The machine's own name, with a port, passes the Host guard.
        let ok = hub
            .get("/claim-cwds")
            .header("host", "myhost:11502")
            .send()
            .await
            .unwrap();
        assert_eq!(ok.status().as_u16(), 200);
    }

    #[test]
    fn host_names_drop_the_port_and_brackets() {
        assert_eq!(host_name("Example.local:11502"), "example.local");
        assert_eq!(host_name("[::1]:11502"), "::1");
        assert_eq!(host_name("localhost"), "localhost");
    }

    #[tokio::test]
    async fn sql_round_trips_and_execute_fires_the_change_signal() {
        let hub = start("sql").await;
        let r = hub
            .sql(
                "execute",
                "INSERT INTO t (a, b) VALUES ($1, $2)",
                json!(["x", 2.5]),
            )
            .await;
        assert_eq!(r.status().as_u16(), 200);
        let done: ExecuteResult = r.json().await.unwrap();
        assert_eq!(
            done,
            ExecuteResult {
                rows_affected: 1,
                last_insert_id: 1
            }
        );
        assert_eq!(hub.changes.load(Ordering::SeqCst), 1);

        hub.sql(
            "execute",
            "INSERT INTO t (a, b) VALUES (NULL, X'0102')",
            json!([]),
        )
        .await;
        let rows: Value = hub
            .sql("select", "SELECT id, a, b FROM t ORDER BY id", json!([]))
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(
            rows,
            json!([{"id": 1, "a": "x", "b": 2.5}, {"id": 2, "a": null, "b": [1, 2]}])
        );
        // A select is not a change.
        assert_eq!(hub.changes.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn sql_execute_with_op_key_runs_once() {
        let hub = start("op").await;
        let run = |op: Option<&'static str>| {
            let hub = &hub;
            async move {
                let mut body = json!({"kind": "execute", "sql": "INSERT INTO t (a) VALUES ($1)", "params": ["x"]});
                if let Some(op) = op {
                    body["op"] = op.into();
                }
                let r = hub.post("/sql").json(&body).send().await.unwrap();
                assert_eq!(r.status().as_u16(), 200);
                r.json::<Value>().await.unwrap()
            }
        };
        let count = || async {
            let rows: Value = hub
                .sql("select", "SELECT COUNT(*) AS n FROM t", json!([]))
                .await
                .json()
                .await
                .unwrap();
            rows[0]["n"].as_i64().unwrap()
        };

        let first = run(Some("K")).await;
        assert_eq!(hub.changes.load(Ordering::SeqCst), 1);
        // The retry gets the stored reply and does not run or signal a change.
        let second = run(Some("K")).await;
        assert_eq!(second, first);
        assert_eq!(count().await, 1);
        assert_eq!(hub.changes.load(Ordering::SeqCst), 1);

        // Another key runs again, and so does a write with no key, every time.
        let other = run(Some("K2")).await;
        assert_ne!(other["lastInsertId"], first["lastInsertId"]);
        run(None).await;
        run(None).await;
        assert_eq!(count().await, 4);
        assert_eq!(hub.changes.load(Ordering::SeqCst), 4);

        // A failed statement stores nothing, so the key can run once it succeeds.
        let failed = hub
            .post("/sql")
            .json(&json!({"kind": "execute", "sql": "INSERT INTO nope VALUES (1)", "params": [], "op": "K3"}))
            .send()
            .await
            .unwrap();
        assert_eq!(failed.status().as_u16(), 400);
        let again = hub
            .post("/sql")
            .json(&json!({"kind": "execute", "sql": "INSERT INTO t (a) VALUES (1)", "params": [], "op": "K3"}))
            .send()
            .await
            .unwrap();
        assert_eq!(again.status().as_u16(), 200);
        assert_eq!(count().await, 5);

        // A key taken by another statement, or the same sql with other params, is
        // a 409 and runs nothing.
        for (sql, params) in [
            ("INSERT INTO t (a) VALUES (2)", json!([])),
            ("INSERT INTO t (a) VALUES ($1)", json!(["y"])),
        ] {
            let taken = hub
                .post("/sql")
                .json(&json!({"kind": "execute", "sql": sql, "params": params, "op": "K"}))
                .send()
                .await
                .unwrap();
            let (status, msg) = error_of(taken).await;
            assert_eq!(status, 409);
            assert_eq!(msg, "op key K was used for a different statement");
        }
        assert_eq!(count().await, 5);
        assert_eq!(hub.changes.load(Ordering::SeqCst), 5);
    }

    #[tokio::test]
    async fn sql_binds_dollar_n_by_number() {
        let hub = start("bind").await;
        // $2 appears before $1.
        let rows: Value = hub
            .sql(
                "select",
                "SELECT $2 AS second, $1 AS first",
                json!(["one", "two"]),
            )
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(rows, json!([{"second": "two", "first": "one"}]));
        // $1 repeated.
        let rows: Value = hub
            .sql("select", "SELECT $1 AS a, $1 AS b", json!([7]))
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(rows, json!([{"a": 7, "b": 7}]));
    }

    #[tokio::test]
    async fn sql_binds_a_bool_as_0_or_1_and_reports_errors_as_400() {
        let hub = start("params").await;
        hub.sql(
            "execute",
            "INSERT INTO t (a, b) VALUES ($1, $2)",
            json!([true, {"k": [1]}]),
        )
        .await;
        let rows: Value = hub
            .sql("select", "SELECT a, b, typeof(a) AS ta FROM t", json!([]))
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(rows, json!([{"a": 1, "b": "{\"k\":[1]}", "ta": "integer"}]));
        hub.sql("execute", "INSERT INTO t (a) VALUES ($1)", json!([false]))
            .await;
        let off: Value = hub
            .sql("select", "SELECT a FROM t WHERE id = 2", json!([]))
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(off, json!([{"a": 0}]));

        let before = hub.changes.load(Ordering::SeqCst);
        let bad = hub
            .sql("execute", "INSERT INTO nope VALUES (1)", json!([]))
            .await;
        let (status, msg) = error_of(bad).await;
        assert_eq!(status, 400);
        assert!(msg.contains("nope"), "{msg}");
        let missing = hub.sql("select", "SELECT $1", json!([])).await;
        assert_eq!(missing.status().as_u16(), 400);
        // A failed write is not a change.
        assert_eq!(hub.changes.load(Ordering::SeqCst), before);
    }

    #[tokio::test]
    async fn sql_refuses_attach_detach_vacuum_and_a_write_under_select() {
        let hub = start("refuse").await;
        let other = hub.dir.join("other.db");
        let attach = format!("ATTACH DATABASE '{}' AS o", other.display());
        let vacuum = format!("VACUUM INTO '{}'", hub.dir.join("copy.db").display());
        let empty_first = format!(";{attach}");
        let spaced_vacuum = format!(" ; /* x */ ;{vacuum}");
        let bom_vacuum = format!("\u{feff}{vacuum}");
        let bom_attach = format!(";\u{feff}{attach}");
        for (kind, sql) in [
            ("execute", attach.as_str()),
            ("execute", empty_first.as_str()),
            ("select", empty_first.as_str()),
            ("execute", spaced_vacuum.as_str()),
            ("execute", bom_vacuum.as_str()),
            ("select", bom_attach.as_str()),
            ("execute", "  -- note\n /* x */ detach database o"),
            ("execute", vacuum.as_str()),
            ("select", "INSERT INTO t (a) VALUES (1)"),
            ("select", "DELETE FROM t"),
        ] {
            let (status, msg) = error_of(hub.sql(kind, sql, json!([])).await).await;
            assert_eq!(
                (status, msg.as_str()),
                (400, "statement not allowed"),
                "{sql}"
            );
        }
        assert!(!other.exists() && !hub.dir.join("copy.db").exists());
        assert_eq!(hub.changes.load(Ordering::SeqCst), 0);
        // Past the keyword check (a prefix it does not know), SQLite still attaches nothing.
        let conn = hub.db.lock().unwrap();
        assert!(conn.execute_batch(&attach).is_err());
        assert!(conn.execute_batch(&vacuum).is_err());
        assert!(!other.exists() && !hub.dir.join("copy.db").exists());
        drop(conn);
        // A WITH … SELECT is still a select.
        let ok = hub
            .sql(
                "select",
                "WITH x AS (SELECT 1 AS n) SELECT n FROM x",
                json!([]),
            )
            .await;
        assert_eq!(ok.status().as_u16(), 200);
    }

    #[tokio::test]
    async fn claim_cwds_lists_distinct_recent_directories() {
        let hub = start("cwds").await;
        for (cwd, at) in [("/a", "1"), ("/b", "3"), ("/a", "2")] {
            hub.sql(
                "execute",
                "INSERT INTO agent_claims VALUES ($1, $2)",
                json!([cwd, at]),
            )
            .await;
        }
        let cwds: Value = hub
            .get("/claim-cwds")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(cwds, json!(["/b", "/a"]));
    }

    #[tokio::test]
    async fn git_remote_is_null_outside_a_repository() {
        let hub = start("git").await;
        let dir = hub.dir.to_string_lossy().into_owned();
        let r = hub
            .get("/git-remote")
            .query(&[("cwd", dir.as_str())])
            .send()
            .await
            .unwrap();
        assert_eq!(r.json::<Value>().await.unwrap(), Value::Null);
    }

    /// Next chunk of an SSE body, as text.
    async fn chunk(
        s: &mut (impl futures_util::Stream<Item = reqwest::Result<Bytes>> + Unpin),
    ) -> String {
        let next = tokio::time::timeout(Duration::from_secs(5), s.next())
            .await
            .expect("event within 5s")
            .expect("stream open")
            .unwrap();
        String::from_utf8(next.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn events_send_the_schema_first_then_a_change_per_notification_and_end_on_shutdown() {
        let hub = start("events").await;
        let resp = hub.get("/events").send().await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let mut stream = resp.bytes_stream();
        assert_eq!(
            chunk(&mut stream).await,
            format!("event: schema\ndata: {{\"version\":{SCHEMA_VERSION}}}\n\n")
        );
        hub.events.send(()).unwrap();
        assert_eq!(chunk(&mut stream).await, "event: change\ndata: {}\n\n");
        hub.events.send(()).unwrap();
        assert_eq!(chunk(&mut stream).await, "event: change\ndata: {}\n\n");
        // Server shutdown ends the stream instead of hanging graceful shutdown.
        hub.shutdown.cancel();
        let end = tokio::time::timeout(Duration::from_secs(5), stream.next()).await;
        assert!(
            matches!(end, Ok(None) | Ok(Some(Err(_)))),
            "stream did not end"
        );
    }

    #[tokio::test]
    async fn file_serves_attachments_and_refuses_everything_else() {
        let hub = start("file").await;
        let att = hub.dir.join("data/attachments/7");
        std::fs::create_dir_all(&att).unwrap();
        std::fs::write(att.join("a.png"), b"PNGDATA").unwrap();
        std::fs::write(hub.dir.join("secret.txt"), b"secret").unwrap();
        let path = att.join("a.png");
        let ok = hub
            .get("/file")
            .query(&[("path", path.to_str().unwrap())])
            .send()
            .await
            .unwrap();
        assert_eq!(ok.status().as_u16(), 200);
        assert_eq!(ok.bytes().await.unwrap().as_ref(), b"PNGDATA");

        let climb = att.join("../../../secret.txt");
        for bad in [
            climb.to_str().unwrap(),
            hub.dir.join("secret.txt").to_str().unwrap(),
            "/etc/passwd",
        ] {
            let r = hub
                .get("/file")
                .query(&[("path", bad)])
                .send()
                .await
                .unwrap();
            assert_eq!(r.status().as_u16(), 403, "{bad}");
        }
        // An evidence image under the configured home is served too.
        let shot = hub.dir.join("home/shot.png");
        std::fs::write(&shot, b"EVIDENCE").unwrap();
        let ev = hub
            .get("/file")
            .query(&[("path", shot.to_str().unwrap())])
            .send()
            .await
            .unwrap();
        assert_eq!(ev.bytes().await.unwrap().as_ref(), b"EVIDENCE");

        // A relative path is an attachment as /image records it; `~/` is the hub's home.
        for (rel, want) in [
            ("attachments/7/a.png", b"PNGDATA".as_slice()),
            ("~/shot.png", b"EVIDENCE".as_slice()),
        ] {
            let r = hub.get("/file").query(&[("path", rel)]).send().await.unwrap();
            assert_eq!(r.status().as_u16(), 200, "{rel}");
            assert_eq!(r.bytes().await.unwrap().as_ref(), want, "{rel}");
        }
        let r = hub
            .get("/file")
            .query(&[("path", "../secret.txt")])
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 403);
    }

    #[tokio::test]
    async fn image_is_stored_under_the_task_folder_and_bad_names_are_refused() {
        let hub = start("image").await;
        let r = hub
            .post("/image?task_id=12&name=img-1.png")
            .body(b"BYTES".to_vec())
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 200);
        let body: Value = r.json().await.unwrap();
        let expected = hub.dir.join("data/attachments/12/img-1.png");
        assert_eq!(body["path"], json!("attachments/12/img-1.png"));
        assert_eq!(std::fs::read(&expected).unwrap(), b"BYTES");

        for q in [
            "task_id=12&name=..%2Fx.png",
            "task_id=12&name=a%2Fb.png",
            "task_id=12&name=..",
            "task_id=12&name=",
            "task_id=0&name=a.png",
            "task_id=-3&name=a.png",
            "name=a.png",
        ] {
            let r = hub
                .post(&format!("/image?{q}"))
                .body("x")
                .send()
                .await
                .unwrap();
            assert_eq!(r.status().as_u16(), 400, "{q}");
        }
        assert!(!hub.dir.join("data/attachments/x.png").exists());
    }

    #[test]
    fn the_token_is_made_once_and_kept() {
        let dir = scratch("token").join("config");
        let first = ensure_token(&dir).unwrap();
        assert!(first.len() >= 32);
        assert!(first
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_eq!(ensure_token(&dir).unwrap(), first);
        assert_eq!(
            std::fs::read_to_string(dir.join(TOKEN_FILE)).unwrap(),
            first
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(TOKEN_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn schema_version_is_the_highest_migration_number() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let highest = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| {
                let name = e.ok()?.file_name().into_string().ok()?;
                name.split('_').next()?.parse::<i64>().ok()
            })
            .max()
            .unwrap();
        assert_eq!(SCHEMA_VERSION, highest);
    }
}
