//! The connection to the Tildone hub: one fresh MCP session per run, plus the one
//! plain HTTP route (`/session/{id}/task`) that tells a session which card it holds.

use std::time::Duration;

use rmcp::{
    model::{CallToolRequestParams, Tool},
    service::RunningService,
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    RoleClient, ServiceExt,
};
use serde_json::{Map, Value};

const DEFAULT_URL: &str = "http://127.0.0.1:11502/mcp";
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// How a run fails. `Tool` exits 1 (the hub answered, or the input was wrong);
/// `Conn` exits 2 (the hub could not be reached).
pub enum Fail {
    Tool { msg: String, help: String },
    Conn { msg: String, help: String },
}

impl Fail {
    pub fn tool(msg: impl Into<String>, help: impl Into<String>) -> Fail {
        Fail::Tool {
            msg: msg.into(),
            help: help.into(),
        }
    }
}

pub type Res<T> = Result<T, Fail>;

pub fn url() -> String {
    std::env::var("TILDONE_URL")
        .ok()
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_URL.to_string())
}

fn token() -> Option<String> {
    std::env::var("TILDONE_TOKEN")
        .ok()
        .filter(|t| !t.is_empty())
}

fn unreachable(detail: impl std::fmt::Display) -> Fail {
    // rmcp wraps the cause in several layers of type names; the last "Client error:" is the useful part.
    let detail = detail.to_string();
    let detail = detail.rsplit("Client error: ").next().unwrap_or(&detail);
    Fail::Conn {
        msg: format!("cannot reach Tildone at {}: {detail}", url()),
        help: "is Tildone running with Settings → Agent access On? Set TILDONE_URL (and TILDONE_TOKEN) for a hub on another machine.".into(),
    }
}

pub struct Hub {
    client: RunningService<RoleClient, ()>,
}

impl Hub {
    pub async fn connect() -> Res<Hub> {
        let mut config = StreamableHttpClientTransportConfig::with_uri(url());
        if let Some(t) = token() {
            // The transport adds the "Bearer " prefix itself.
            config = config.auth_header(t);
        }
        let transport = StreamableHttpClientTransport::from_config(config);
        let client = tokio::time::timeout(CALL_TIMEOUT, ().serve(transport))
            .await
            .map_err(|_| unreachable("timed out"))?
            .map_err(unreachable)?;
        Ok(Hub { client })
    }

    /// The server's name, version and instruction text from the handshake.
    pub fn server(&self) -> (String, String, String) {
        let Some(info) = self.client.peer_info() else {
            return Default::default();
        };
        let (name, version) = info
            .server_info
            .as_ref()
            .map(|s| (s.name.clone(), s.version.clone()))
            .unwrap_or_default();
        (name, version, info.instructions.clone().unwrap_or_default())
    }

    pub async fn tools(&self) -> Res<Vec<Tool>> {
        tokio::time::timeout(CALL_TIMEOUT, self.client.list_all_tools())
            .await
            .map_err(|_| unreachable("tools/list timed out"))?
            .map_err(unreachable)
    }

    /// Calls a tool and returns its text. A tool error becomes `Fail::Tool` with
    /// `help` as the suggested next command; a transport error is `Fail::Conn`.
    pub async fn call(&self, tool: &str, args: Map<String, Value>, help: &str) -> Res<String> {
        self.call_within(tool, args, help, CALL_TIMEOUT).await
    }

    /// Like `call`, with the caller's own deadline (a parked `list_changes`).
    pub async fn call_within(
        &self,
        tool: &str,
        args: Map<String, Value>,
        help: &str,
        limit: Duration,
    ) -> Res<String> {
        let params = CallToolRequestParams::new(tool.to_string()).with_arguments(args);
        let result = tokio::time::timeout(limit, self.client.call_tool(params))
            .await
            .map_err(|_| unreachable(format!("{tool} timed out")))?
            .map_err(unreachable)?;
        let text = result
            .content
            .iter()
            .filter_map(|c| c.as_text().map(|t| t.text.as_str()))
            .collect::<Vec<_>>()
            .join("\n");
        if result.is_error == Some(true) {
            return Err(Fail::tool(text, help));
        }
        Ok(text)
    }

    /// Ends the session (a DELETE to the hub) instead of leaving it to time out.
    pub async fn close(mut self) {
        let _ = self.client.close_with_timeout(Duration::from_secs(2)).await;
    }
}

/// `$TILDONE_URL` without its trailing `/mcp`: the root of the hub's plain routes.
fn base() -> String {
    let url = url();
    let url = url.trim_end_matches('/');
    url.strip_suffix("/mcp").unwrap_or(url).to_string()
}

/// The card this session holds, from the hub's claim table. None when the session
/// holds nothing or `CLAUDE_CODE_SESSION_ID` is unset.
pub async fn claimed_card() -> Res<Option<Value>> {
    let Some(id) = session_id() else {
        return Ok(None);
    };
    let mut req = reqwest::Client::new()
        .get(format!("{}/session/{id}/task", base()))
        .timeout(Duration::from_secs(10));
    if let Some(t) = token() {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.map_err(unreachable)?;
    match resp.status().as_u16() {
        204 => Ok(None),
        200 => {
            let body = resp.text().await.map_err(unreachable)?;
            serde_json::from_str(&body).map(Some).map_err(|e| {
                Fail::tool(
                    format!("the hub sent an unreadable claim: {e}"),
                    "tildone-axi doctor",
                )
            })
        }
        other => Err(Fail::tool(
            format!("the hub answered {other} for this session's claimed card"),
            "tildone-axi doctor",
        )),
    }
}

pub fn session_id() -> Option<String> {
    std::env::var("CLAUDE_CODE_SESSION_ID")
        .ok()
        .filter(|s| !s.trim().is_empty())
}
