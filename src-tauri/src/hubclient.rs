//! Client mode: this window's board lives on another Tildone (the hub).
//!
//! Active when the `board_hub_url` setting is non-empty. Every call reads the URL
//! and `board_hub_token` from the settings store (appsettings.rs), sends
//! `Authorization: Bearer <token>`, and never an Origin header. Routes and shapes
//! are in hub.rs. Errors name the hub URL and what failed ("hub ws:11502: bad
//! token", "... unreachable: <reason>").

use serde::Serialize;
use serde_json::Value;

/// Event the window gets about the hub connection:
/// `{"state": "connected" | "error" | "schema-mismatch", "message": string}`.
pub const HUB_STATUS: &str = "hub-status";

#[derive(Debug, Clone, Serialize)]
pub struct HubInfo {
    /// The hub's SCHEMA_VERSION, equal to ours when connect succeeds.
    pub version: i64,
}

/// Connect to the hub's /events: check its `schema` event against our
/// SCHEMA_VERSION (a mismatch is an error naming both numbers), then keep a
/// background subscriber that re-emits each `change` as `agent-db-changed` and
/// reconnects with backoff, emitting HUB_STATUS on each state change. Calling it
/// again replaces the subscriber (e.g. after the URL or token changed).
#[tauri::command]
pub async fn hub_connect(app: tauri::AppHandle) -> Result<HubInfo, String> {
    let _ = app;
    Err("hub_connect: not built yet".into())
}

/// One db.ts query on the hub (`POST /sql`). `kind` is "select" (→ array of row
/// objects) or "execute" (→ `{rowsAffected, lastInsertId}`).
#[tauri::command]
pub async fn hub_sql(
    app: tauri::AppHandle,
    kind: String,
    sql: String,
    params: Vec<Value>,
) -> Result<Value, String> {
    let _ = (app, kind, sql, params);
    Err("hub_sql: not built yet".into())
}

/// `agent_presence` on the hub (`GET /presence`), same JSON.
#[tauri::command]
pub async fn hub_presence(app: tauri::AppHandle) -> Result<Value, String> {
    let _ = app;
    Err("hub_presence: not built yet".into())
}

/// `recent_claim_cwds` on the hub (`GET /claim-cwds`).
#[tauri::command]
pub async fn hub_claim_cwds(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let _ = app;
    Err("hub_claim_cwds: not built yet".into())
}

/// `git_remote_url` on the hub (`GET /git-remote`).
#[tauri::command]
pub async fn hub_git_remote(app: tauri::AppHandle, cwd: String) -> Result<Option<String>, String> {
    let _ = (app, cwd);
    Err("hub_git_remote: not built yet".into())
}

/// A file's bytes from the hub (`GET /file`): evidence images and task attachments.
#[tauri::command]
pub async fn hub_file(app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let _ = (app, path);
    Err("hub_file: not built yet".into())
}

/// Store a pasted or dropped image on the hub (`POST /image`); returns the hub's
/// absolute path, which the window records with db.insertImage.
#[tauri::command]
pub async fn hub_image_put(
    app: tauri::AppHandle,
    task_id: i64,
    name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let _ = (app, task_id, name, bytes);
    Err("hub_image_put: not built yet".into())
}
