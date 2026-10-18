//! The hub: routes another Tildone uses when this machine holds its board.
//!
//! Mounted on the agent server beside /mcp (same port, same lifetime as Agent
//! access). A client (Settings → Board → hub URL + token) sends every db.ts query
//! here instead of opening its own tildone.db, and follows /events to stay live.
//!
//! Every route below requires all three guards, in this order:
//! - Host in the agent server's allow-list (`server_config` in agent.rs), else 403;
//! - no `Origin` header (a browser page must never reach SQL), else 403;
//! - `Authorization: Bearer <token>` matching `hub-token`, else 401.
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
//! - `GET /file?path=<abs path>` → the file's bytes (`application/octet-stream`).
//!   Only paths `read_evidence_image` allows, or files under the hub's
//!   `<app data>/attachments/`; anything else → 403.
//! - `POST /image?task_id=<n>&name=<file name>` raw body bytes → `{"path": "<abs>"}`.
//!   Stores the image as `<app data>/attachments/<task_id>/<name>`, as the window's
//!   saveImageFile does locally (src/utils/images.ts), and returns the absolute
//!   path the client then records with db.insertImage through /sql.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The migration number this build's tildone.db is at: the last `version` in
/// lib.rs `migrations`. A client refuses a hub whose number differs.
pub const SCHEMA_VERSION: i64 = 30;

/// File in the app config dir holding the hub token. Generated once (random,
/// at least 32 url-safe characters) the first time Agent access starts.
pub const TOKEN_FILE: &str = "hub-token";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlRequest {
    /// "select" or "execute".
    pub kind: String,
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResult {
    pub rows_affected: u64,
    pub last_insert_id: i64,
}

/// The hub's token, for Settings → Agent access (shown with a copy button).
/// Creates the token file if it does not exist yet.
#[tauri::command]
pub fn hub_token(app: tauri::AppHandle) -> Result<String, String> {
    let _ = app;
    Err("hub_token: not built yet".into())
}
