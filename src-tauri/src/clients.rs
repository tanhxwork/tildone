//! Hub clients: the Tildone apps that use this one as their board hub, and the
//! fixed actions the hub machine can run on them (TIL-248). A client is reached only
//! over its own hub connection, never directly:
//!
//! ```text
//! client (hubclient.rs)                          hub (hub.rs, memory only)
//!  GET /events + CLIENT_HEADER (ClientHello) ──► registers it; connected while
//!                                                the stream is open
//!  POST STATUS_ROUTE (ClientReport) ──────────► every STATUS_EVERY and on change
//!  /events ◄── `COMMAND_EVENT` (Command) ─────── only on that client's stream
//!  POST RESULT_ROUTE (CommandResult) ─────────► resolves the waiting caller
//! ```
//!
//! The hub machine drives it through the MCP tools `list_clients` and
//! `client_command` (agent.rs) on its own 127.0.0.1 server. The client runs only
//! the names in ACTIONS and never a shell command it was sent.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

/// Header on GET /events: the ClientHello as percent-encoded JSON.
pub const CLIENT_HEADER: &str = "x-tildone-client";
/// SSE event name the hub uses to push a Command to one client.
pub const COMMAND_EVENT: &str = "command";
pub const STATUS_ROUTE: &str = "/client-status";
pub const RESULT_ROUTE: &str = "/client-result";
/// How often a connected client posts its ClientReport unasked.
pub const STATUS_EVERY: Duration = Duration::from_secs(60);
/// How long `client_command` waits for a CommandResult before it gives up.
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
/// How many errors of each kind a ClientReport keeps, newest last.
pub const ERRORS_KEPT: usize = 20;

/// The commit this binary was built from (build.rs).
pub const BUILD_COMMIT: &str = env!("TILDONE_COMMIT");
/// The checkout this binary was built from; `update` rebuilds from it.
pub const SOURCE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

/// Every action a client accepts, with its args:
/// - `status`: a fresh ClientReport.
/// - `restart`: replies, then relaunches the app.
/// - `settings`: every setting, tokens as (set)/(empty).
/// - `settings-set <key> <value>`: as update_settings; refuses board_hub_url and
///   board_hub_token, since changing them cuts the link the command came over.
/// - `hook connect|disconnect|status`: the Claude hook on the client machine.
/// - `engine status|start|stop`: the client's local AI engine.
/// - `update`: starts scripts/self-update.sh from SOURCE_DIR detached and replies
///   with its log path; refuses a missing, dirty or non-main checkout.
/// - `log [n]`: the last n (default 100) lines of that log.
pub const ACTIONS: &[&str] = &[
    "status",
    "restart",
    "settings",
    "settings-set",
    "hook",
    "engine",
    "update",
    "log",
];

/// The one id shape a client makes: 32 lowercase hex characters. The hub refuses
/// any other, so no client can pose as another client's host name.
pub fn is_client_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Who a client is. Sent once per /events connection.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ClientHello {
    /// Stable per install (a random id kept in the client's app data), so two
    /// machines with the same hostname stay apart.
    pub id: String,
    pub host: String,
    /// `std::env::consts::OS`.
    pub os: String,
    /// CARGO_PKG_VERSION.
    pub version: String,
    /// BUILD_COMMIT.
    pub commit: String,
    /// hub::SCHEMA_VERSION of the client build.
    pub schema: i64,
    pub exe: String,
    /// agent::is_installed_path on `exe`.
    pub installed: bool,
    pub source_dir: String,
    /// Unix seconds the client app started.
    pub started_at: i64,
}

/// One remembered error.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Logged {
    /// Unix seconds.
    pub at: i64,
    pub message: String,
}

/// What a client says about itself now. Never carries a token in clear.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ClientReport {
    pub id: String,
    /// The last HUB_STATUS state: connected | error | schema-mismatch.
    pub hub_state: String,
    /// The last HUB_STATUS message, empty when connected.
    pub hub_message: String,
    /// Failed hub calls, newest last, at most ERRORS_KEPT.
    pub hub_errors: Vec<Logged>,
    /// Uncaught window errors and rejections, newest last, at most ERRORS_KEPT.
    pub window_errors: Vec<Logged>,
    /// Every setting through agent::hide_tokens.
    pub settings: Value,
    /// The Claude hook's status JSON, null when it could not be read.
    pub hook: Value,
}

/// One action for one client, pushed as the data of a COMMAND_EVENT.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Command {
    /// Unique per call; the CommandResult echoes it.
    pub id: String,
    /// One of ACTIONS.
    pub action: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// A client's answer to one Command. `output` is the action's JSON when `ok`, else
/// a string naming what failed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CommandResult {
    pub id: String,
    /// The ClientHello id of the client that ran it.
    pub client: String,
    pub ok: bool,
    pub output: Value,
}

/// One row of `list_clients`: the hub's view of a client.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ClientEntry {
    pub hello: ClientHello,
    /// Null until the first report arrives.
    pub report: Option<ClientReport>,
    pub connected: bool,
    /// Unix seconds of the current (or last) /events connection.
    pub connected_since: i64,
    /// Unix seconds of the last thing heard: connect, report, result or stream end.
    pub last_seen: i64,
}
