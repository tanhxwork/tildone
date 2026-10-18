//! Client mode: this window's board lives on another Tildone (the hub).
//!
//! Active when the `board_hub_url` setting is non-empty. Every call reads the URL
//! and `board_hub_token` from the settings store (appsettings.rs), sends
//! `Authorization: Bearer <token>`, and never an Origin header. Routes and shapes
//! are in hub.rs. Errors name the hub URL and what failed ("hub ws:11502: bad
//! token", "... unreachable: <reason>").
//!
//! The window classifies errors by these shapes, so keep them exactly:
//! - `hub <url>: bad token` (401);
//! - `hub <url> is at schema N, this app is at M: run the same Tildone build on both`;
//! - `hub <url>: unreachable: <reason>` (no connection, a timeout, a dropped body).

use futures_util::{stream::BoxStream, StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::error::Error as _;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

/// Event the window gets about the hub connection:
/// `{"state": "connected" | "error" | "schema-mismatch", "message": string}`.
pub const HUB_STATUS: &str = "hub-status";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Longest silence on a response body: three missed hub keep-alives (every 15 s).
/// A half-open /events connection then drops and reconnects in under a minute.
const READ_TIMEOUT: Duration = Duration::from_secs(45);
/// Waits between reconnect attempts after the event stream drops; the last repeats.
static BACKOFF: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(30),
];

#[derive(Debug, Clone, Serialize)]
pub struct HubInfo {
    /// The hub's SCHEMA_VERSION, equal to ours when connect succeeds.
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
struct HubStatus {
    state: &'static str,
    message: String,
}

impl HubStatus {
    fn new(state: &'static str, message: impl Into<String>) -> Self {
        Self {
            state,
            message: message.into(),
        }
    }
}

/// Why a hub call failed. `Fatal` ones (bad token, other schema) will not fix
/// themselves, so the reconnect loop stops on them and reports `state`.
#[derive(Debug)]
struct HubError {
    message: String,
    fatal_state: Option<&'static str>,
}

impl HubError {
    fn transient(message: String) -> Self {
        Self {
            message,
            fatal_state: None,
        }
    }
    fn fatal(state: &'static str, message: String) -> Self {
        Self {
            message,
            fatal_state: Some(state),
        }
    }
}

impl From<HubError> for String {
    fn from(e: HubError) -> String {
        e.message
    }
}

/// No Origin header (reqwest sends none), a connect timeout, TCP keepalive and a
/// read timeout, so a hub that went silent surfaces as an error on /events.
fn build_client(read_timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(read_timeout)
        .tcp_keepalive(Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

/// The one shared client. The per-request timeout is set on each request,
/// because /events must not have one (only the read timeout).
fn client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| build_client(READ_TIMEOUT)).clone()
}

/// The hub's address and token. Built from the settings on every command, so a
/// changed URL or token applies at once.
#[derive(Clone)]
struct Hub {
    url: String,
    token: String,
    client: reqwest::Client,
}

/// The reason text of a reqwest failure: the innermost causes ("tcp connect
/// error: Connection refused"), without the URL reqwest repeats.
fn cause(e: &reqwest::Error) -> String {
    let mut parts = Vec::new();
    let mut cur = e.source();
    while let Some(c) = cur {
        parts.push(c.to_string());
        cur = c.source();
    }
    if parts.is_empty() {
        e.to_string()
    } else {
        parts.join(": ")
    }
}

/// Percent-encode for a query value: everything but unreserved characters, so a
/// space is `%20` and `&`, `+`, `#` cannot split the value.
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

impl Hub {
    fn new(url: &str, token: &str, client: reqwest::Client) -> Self {
        let url = url.trim().trim_end_matches('/');
        let url = if url.contains("://") {
            url.to_string()
        } else {
            format!("http://{url}")
        };
        Self {
            url,
            token: token.trim().to_string(),
            client,
        }
    }

    fn from_settings(app: &tauri::AppHandle) -> Result<Self, String> {
        let settings = crate::appsettings::get(app);
        let text = |key: &str| {
            settings
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let url = text("board_hub_url");
        if url.is_empty() {
            return Err("no board hub is set".into());
        }
        Ok(Self::new(&url, &text("board_hub_token"), client()))
    }

    /// A request to `target` (a path with an optional query) with the bearer token.
    fn request(&self, method: reqwest::Method, target: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, format!("{}{target}", self.url))
            .bearer_auth(&self.token)
    }

    fn timed(&self, method: reqwest::Method, target: &str) -> reqwest::RequestBuilder {
        self.request(method, target).timeout(REQUEST_TIMEOUT)
    }

    /// Send and map failures to errors that name the hub and the cause.
    async fn send(&self, req: reqwest::RequestBuilder) -> Result<reqwest::Response, HubError> {
        let url = &self.url;
        let resp = req.send().await.map_err(|e| {
            let reason = if e.is_timeout() {
                format!("timed out ({})", cause(&e))
            } else {
                cause(&e)
            };
            HubError::transient(format!("hub {url}: unreachable: {reason}"))
        })?;
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        match status.as_u16() {
            401 => Err(HubError::fatal("error", format!("hub {url}: bad token"))),
            403 => Err(HubError::transient(format!(
                "hub {url}: refused (Origin/Host)"
            ))),
            code => {
                let body = resp.text().await.unwrap_or_default();
                let text = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_else(|| format!("HTTP {code}"));
                Err(HubError::transient(format!("hub {url}: {text}")))
            }
        }
    }

    async fn json(&self, req: reqwest::RequestBuilder) -> Result<Value, String> {
        let resp = self.send(req).await?;
        resp.json::<Value>()
            .await
            .map_err(|e| format!("hub {}: bad response: {}", self.url, cause(&e)))
    }

    /// `POST /sql`; the hub's JSON comes back as is. `op` is the idempotency key of
    /// a queued write: the hub runs a statement with the same key once.
    async fn sql(
        &self,
        kind: &str,
        sql: &str,
        params: &[Value],
        op: Option<&str>,
    ) -> Result<Value, String> {
        if kind != "select" && kind != "execute" {
            return Err(format!("kind must be select or execute, not {kind}"));
        }
        let mut body = serde_json::json!({ "kind": kind, "sql": sql, "params": params });
        if let Some(op) = op {
            body["op"] = op.into();
        }
        self.json(self.timed(reqwest::Method::POST, "/sql").json(&body))
            .await
    }

    async fn get_json(&self, target: &str) -> Result<Value, String> {
        self.json(self.timed(reqwest::Method::GET, target)).await
    }

    async fn file(&self, path: &str) -> Result<Vec<u8>, String> {
        let resp = self
            .send(self.timed(reqwest::Method::GET, &format!("/file?path={}", enc(path))))
            .await?;
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("hub {}: unreachable: {}", self.url, cause(&e)))?;
        Ok(bytes.to_vec())
    }

    async fn image_put(&self, task_id: i64, name: &str, bytes: Vec<u8>) -> Result<String, String> {
        let target = format!("/image?task_id={task_id}&name={}", enc(name));
        let req = self
            .timed(reqwest::Method::POST, &target)
            .header("Content-Type", "application/octet-stream")
            .body(bytes);
        let v = self.json(req).await?;
        v.get("path")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("hub {}: bad response: no path", self.url))
    }

    /// Open `/events` and check its first event: `schema` with our version.
    async fn connect(&self) -> Result<(i64, EventStream), HubError> {
        let url = &self.url;
        let resp = self
            .send(self.request(reqwest::Method::GET, "/events"))
            .await?;
        let mut stream = EventStream::new(resp);
        let first = stream
            .next_event()
            .await
            .map_err(|e| HubError::transient(format!("hub {url}: unreachable: {e}")))?
            .ok_or_else(|| HubError::transient(format!("hub {url}: closed the event stream")))?;
        if first.event != "schema" {
            return Err(HubError::transient(format!(
                "hub {url}: expected a schema event first, got {}",
                first.event
            )));
        }
        let theirs = serde_json::from_str::<Value>(&first.data)
            .ok()
            .and_then(|v| v.get("version").and_then(Value::as_i64))
            .ok_or_else(|| HubError::transient(format!("hub {url}: bad schema event")))?;
        let ours = crate::hub::SCHEMA_VERSION;
        if theirs != ours {
            return Err(HubError::fatal(
                "schema-mismatch",
                format!(
                    "hub {url} is at schema {theirs}, this app is at {ours}: run the same Tildone build on both"
                ),
            ));
        }
        Ok((theirs, stream))
    }
}

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
struct SseEvent {
    event: String,
    data: String,
}

/// Line-based SSE parser: `event:` and `data:` fields, a blank line dispatches,
/// `:` comment lines (keepalives) are ignored.
#[derive(Default)]
struct SseParser {
    buf: Vec<u8>,
    event: String,
    data: Vec<String>,
}

impl SseParser {
    fn feed(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(i) = self.buf.iter().position(|b| *b == b'\n') {
            let raw: Vec<u8> = self.buf.drain(..=i).collect();
            let line = String::from_utf8_lossy(&raw);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.event.is_empty() || !self.data.is_empty() {
                    let event = std::mem::take(&mut self.event);
                    out.push(SseEvent {
                        event: if event.is_empty() {
                            "message".into()
                        } else {
                            event
                        },
                        data: std::mem::take(&mut self.data).join("\n"),
                    });
                }
            } else if line.starts_with(':') {
                // comment
            } else {
                let (field, value) = line.split_once(':').unwrap_or((line, ""));
                let value = value.strip_prefix(' ').unwrap_or(value);
                match field {
                    "event" => self.event = value.to_string(),
                    "data" => self.data.push(value.to_string()),
                    _ => {}
                }
            }
        }
        out
    }
}

struct EventStream {
    body: BoxStream<'static, Result<Vec<u8>, String>>,
    parser: SseParser,
    queue: VecDeque<SseEvent>,
}

impl EventStream {
    fn new(resp: reqwest::Response) -> Self {
        Self {
            body: resp
                .bytes_stream()
                .map(|r| r.map(|b| b.to_vec()).map_err(|e| cause(&e)))
                .boxed(),
            parser: SseParser::default(),
            queue: VecDeque::new(),
        }
    }

    /// The next event; `Ok(None)` when the hub closed the stream.
    async fn next_event(&mut self) -> Result<Option<SseEvent>, String> {
        loop {
            if let Some(ev) = self.queue.pop_front() {
                return Ok(Some(ev));
            }
            match self.body.next().await {
                Some(Ok(chunk)) => self.queue.extend(self.parser.feed(&chunk)),
                Some(Err(e)) => return Err(e),
                None => return Ok(None),
            }
        }
    }
}

/// Follow a connected stream: `on_change` for each `change` event. When the
/// stream drops, report an error and reconnect after each wait in `backoff`
/// (the last repeats); a reconnect reports `connected` and calls `on_change`
/// once, so the window reloads anything it missed. A bad token or a different
/// schema ends the loop with the matching state.
async fn follow(
    hub: Hub,
    mut stream: EventStream,
    backoff: &[Duration],
    on_status: impl Fn(HubStatus),
    on_change: impl Fn(),
) {
    let url = hub.url.clone();
    loop {
        let reason = loop {
            match stream.next_event().await {
                Ok(Some(ev)) if ev.event == "change" => on_change(),
                Ok(Some(_)) => {}
                Ok(None) => break "closed the event stream".to_string(),
                Err(e) => break format!("connection lost: {e}"),
            }
        };
        on_status(HubStatus::new("error", format!("hub {url}: {reason}")));
        let mut attempt = 0;
        stream = loop {
            tokio::time::sleep(backoff[attempt.min(backoff.len() - 1)]).await;
            attempt += 1;
            match hub.connect().await {
                Ok((_, s)) => break s,
                Err(e) => match e.fatal_state {
                    Some(state) => {
                        on_status(HubStatus::new(state, e.message));
                        return;
                    }
                    None => on_status(HubStatus::new("error", e.message)),
                },
            }
        };
        on_status(HubStatus::new("connected", ""));
        on_change();
    }
}

type Subscriber = tauri::async_runtime::JoinHandle<()>;

/// The running subscriber, so a later hub_connect can replace it.
static SUBSCRIBER: Mutex<Option<Subscriber>> = Mutex::new(None);

/// Put `new` in the slot and abort whatever it held, under one lock, so two
/// overlapping hub_connect calls leave exactly one follower.
fn swap_subscriber(slot: &Mutex<Option<Subscriber>>, new: Option<Subscriber>) {
    let old = std::mem::replace(&mut *slot.lock().unwrap_or_else(|e| e.into_inner()), new);
    if let Some(old) = old {
        old.abort();
    }
}

/// Stop following the hub. The window calls it at startup when it is not in
/// client mode, so a follower from an earlier connect cannot outlive the mode.
/// A no-op when none runs.
#[tauri::command]
pub fn hub_disconnect() {
    swap_subscriber(&SUBSCRIBER, None);
}

/// Connect to the hub's /events: check its `schema` event against our
/// SCHEMA_VERSION (a mismatch is an error naming both numbers), then keep a
/// background subscriber that re-emits each `change` as `agent-db-changed` and
/// reconnects with backoff, emitting HUB_STATUS on each state change. Calling it
/// again replaces the subscriber (e.g. after the URL or token changed).
#[tauri::command]
pub async fn hub_connect(app: tauri::AppHandle) -> Result<HubInfo, String> {
    swap_subscriber(&SUBSCRIBER, None);
    let hub = Hub::from_settings(&app)?;
    let (version, stream) = hub.connect().await?;
    let handle = tauri::async_runtime::spawn(async move {
        follow(
            hub,
            stream,
            &BACKOFF,
            |status| {
                let _ = app.emit(HUB_STATUS, status);
            },
            || {
                let _ = app.emit("agent-db-changed", ());
            },
        )
        .await
    });
    swap_subscriber(&SUBSCRIBER, Some(handle));
    Ok(HubInfo { version })
}

/// One db.ts query on the hub (`POST /sql`). `kind` is "select" (→ array of row
/// objects) or "execute" (→ `{rowsAffected, lastInsertId}`).
#[tauri::command]
pub async fn hub_sql(
    app: tauri::AppHandle,
    kind: String,
    sql: String,
    params: Vec<Value>,
    op: Option<String>,
) -> Result<Value, String> {
    Hub::from_settings(&app)?
        .sql(&kind, &sql, &params, op.as_deref())
        .await
}

/// `agent_presence` on the hub (`GET /presence`), same JSON.
#[tauri::command]
pub async fn hub_presence(app: tauri::AppHandle) -> Result<Value, String> {
    Hub::from_settings(&app)?.get_json("/presence").await
}

/// `recent_claim_cwds` on the hub (`GET /claim-cwds`).
#[tauri::command]
pub async fn hub_claim_cwds(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let hub = Hub::from_settings(&app)?;
    let v = hub.get_json("/claim-cwds").await?;
    serde_json::from_value(v).map_err(|e| format!("hub {}: bad response: {e}", hub.url))
}

/// `git_remote_url` on the hub (`GET /git-remote`).
#[tauri::command]
pub async fn hub_git_remote(app: tauri::AppHandle, cwd: String) -> Result<Option<String>, String> {
    let hub = Hub::from_settings(&app)?;
    let v = hub
        .get_json(&format!("/git-remote?cwd={}", enc(&cwd)))
        .await?;
    serde_json::from_value(v).map_err(|e| format!("hub {}: bad response: {e}", hub.url))
}

/// A file's bytes from the hub (`GET /file`): evidence images and task attachments.
#[tauri::command]
pub async fn hub_file(app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = Hub::from_settings(&app)?.file(&path).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Percent-decode a header value (`encodeURIComponent` on the window side).
fn dec(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
                .ok_or("bad x-name header")?;
            out.push(hex);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "bad x-name header".to_string())
}

/// The task id and file name of a hub_image_put call: the `x-task-id` header
/// (a number) and the `x-name` header (percent-encoded, not empty).
fn image_args(headers: &tauri::http::HeaderMap) -> Result<(i64, String), String> {
    let get = |k: &str| {
        headers
            .get(k)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| format!("hub_image_put: missing {k} header"))
    };
    let task_id = get("x-task-id")?
        .parse::<i64>()
        .map_err(|_| "hub_image_put: bad x-task-id header".to_string())?;
    let name = dec(get("x-name")?)?;
    if name.is_empty() {
        return Err("hub_image_put: empty x-name header".into());
    }
    Ok((task_id, name))
}

/// Store a pasted or dropped image on the hub (`POST /image`); returns the hub's
/// path relative to its app data dir (`attachments/<task>/<name>`), which the
/// window records with db.insertImage. The window sends the bytes as a raw IPC
/// body with `x-task-id` and `x-name` (percent-encoded) headers.
#[tauri::command]
pub async fn hub_image_put(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let (task_id, name) = image_args(request.headers())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("hub_image_put: expected the image as a raw body".into());
    };
    Hub::from_settings(&app)?
        .image_put(task_id, &name, bytes.to_vec())
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, Bytes};
    use axum::http::{HeaderMap, Method, Uri};
    use axum::response::Response;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::sync::mpsc;

    const TOKEN: &str = "good";

    struct Seen {
        method: Method,
        path: String,
        query: String,
        headers: HeaderMap,
        body: Vec<u8>,
    }

    /// A fake hub that implements the wire contract in hub.rs just far enough
    /// for these tests, and records every request it gets.
    #[derive(Clone)]
    struct Fake {
        seen: Arc<Mutex<Vec<Seen>>>,
        event_conns: Arc<AtomicUsize>,
        /// Schema version the /events stream announces.
        schema: i64,
        /// The first /events stream ends after its events; later ones stay open.
        drop_first_stream: bool,
        /// /events answers 401 from this connection number on (0-based).
        reject_events_from: Option<usize>,
        /// Streams send a `change` every 20 ms forever.
        ticking: bool,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                seen: Arc::default(),
                event_conns: Arc::default(),
                schema: crate::hub::SCHEMA_VERSION,
                drop_first_stream: false,
                reject_events_from: None,
                ticking: false,
            }
        }

        async fn serve(self) -> (Hub, Arc<Mutex<Vec<Seen>>>) {
            let seen = self.seen.clone();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let router = axum::Router::new().fallback(handle).with_state(self);
            tokio::spawn(async move {
                let _ = axum::serve(listener, router).await;
            });
            (Hub::new(&format!("http://{addr}"), TOKEN, client()), seen)
        }
    }

    fn json(status: u16, body: Value) -> Response {
        Response::builder()
            .status(status)
            .header("Content-Type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    async fn handle(
        axum::extract::State(fake): axum::extract::State<Fake>,
        method: Method,
        uri: Uri,
        headers: HeaderMap,
        body: Bytes,
    ) -> Response {
        let (path, query) = (
            uri.path().to_string(),
            uri.query().unwrap_or("").to_string(),
        );
        let authed = headers
            .get("authorization")
            .is_some_and(|v| v == format!("Bearer {TOKEN}").as_str());
        let has_origin = headers.contains_key("origin");
        fake.seen.lock().unwrap().push(Seen {
            method,
            path: path.clone(),
            query: query.clone(),
            headers,
            body: body.to_vec(),
        });
        if has_origin {
            return json(403, serde_json::json!({"error": "origin"}));
        }
        if !authed {
            return json(401, serde_json::json!({"error": "token"}));
        }
        match path.as_str() {
            "/sql" => {
                let req: Value = serde_json::from_slice(&body).unwrap();
                if req["sql"] == "SELEC broken" {
                    json(
                        400,
                        serde_json::json!({"error": "near \"SELEC\": syntax error"}),
                    )
                } else if req["kind"] == "select" {
                    json(
                        200,
                        serde_json::json!([{"id": 1, "title": "a", "note": null}]),
                    )
                } else {
                    json(
                        200,
                        serde_json::json!({"rowsAffected": 1, "lastInsertId": 7}),
                    )
                }
            }
            "/file" if query.contains("forbidden") => {
                json(403, serde_json::json!({"error": "path"}))
            }
            "/file" => Response::new(Body::from(vec![0u8, 255, 10, 13])),
            "/git-remote" => json(200, serde_json::json!("git@host:r.git")),
            "/image" => json(
                200,
                serde_json::json!({"path": "/hub/attachments/3/a b.png"}),
            ),
            "/events" => {
                let n = fake.event_conns.fetch_add(1, Ordering::SeqCst);
                if fake.reject_events_from.is_some_and(|from| n >= from) {
                    return json(401, serde_json::json!({"error": "token"}));
                }
                // Split mid-line and use CRLF in one event to exercise the parser.
                let schema = format!(
                    "event: schema\r\ndata: {{\"version\": {}}}\r\n\r\n",
                    fake.schema
                );
                let chunks: Vec<Vec<u8>> = vec![
                    schema.as_bytes()[..9].to_vec(),
                    schema.as_bytes()[9..].to_vec(),
                    b": keepalive\n\nevent: change\ndata: {}\n\n".to_vec(),
                    b"event: change\ndata: {}\n\n".to_vec(),
                ];
                let head = futures_util::stream::iter(
                    chunks.into_iter().map(Ok::<_, std::convert::Infallible>),
                );
                let body = if fake.drop_first_stream && n == 0 {
                    Body::from_stream(head)
                } else if fake.ticking {
                    let ticks = futures_util::stream::unfold((), |()| async {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        Some((
                            Ok::<_, std::convert::Infallible>(
                                b"event: change\ndata: {}\n\n".to_vec(),
                            ),
                            (),
                        ))
                    });
                    Body::from_stream(head.chain(ticks))
                } else {
                    Body::from_stream(head.chain(futures_util::stream::pending()))
                };
                Response::builder()
                    .header("Content-Type", "text/event-stream")
                    .body(body)
                    .unwrap()
            }
            _ => json(404, serde_json::json!({"error": "no route"})),
        }
    }

    #[tokio::test]
    async fn sql_sends_bearer_and_no_origin_and_passes_json_through() {
        let (hub, seen) = Fake::new().serve().await;
        let rows = hub
            .sql(
                "select",
                "SELECT * FROM t WHERE a = $2 AND b = $1",
                &[1.into(), "x".into()],
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            rows,
            serde_json::json!([{"id": 1, "title": "a", "note": null}])
        );
        let done = hub
            .sql("execute", "DELETE FROM t", &[], Some("op-1"))
            .await
            .unwrap();
        assert_eq!(
            done,
            serde_json::json!({"rowsAffected": 1, "lastInsertId": 7})
        );
        assert!(hub.sql("drop", "x", &[], None).await.is_err());

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].method, Method::POST);
        assert_eq!(seen[0].headers["authorization"], "Bearer good");
        assert!(!seen[0].headers.contains_key("origin"));
        let body: Value = serde_json::from_slice(&seen[0].body).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"kind": "select", "sql": "SELECT * FROM t WHERE a = $2 AND b = $1", "params": [1, "x"]})
        );
        let body: Value = serde_json::from_slice(&seen[1].body).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"kind": "execute", "sql": "DELETE FROM t", "params": [], "op": "op-1"})
        );
    }

    #[tokio::test]
    async fn errors_name_the_hub_and_the_cause() {
        let (hub, _) = Fake::new().serve().await;
        let url = hub.url.clone();

        let wrong = Hub::new(&url, "nope", client());
        assert_eq!(
            wrong.sql("select", "x", &[], None).await.unwrap_err(),
            format!("hub {url}: bad token")
        );
        assert_eq!(
            hub.file("/forbidden").await.unwrap_err(),
            format!("hub {url}: refused (Origin/Host)")
        );
        assert_eq!(
            hub.sql("select", "SELEC broken", &[], None).await.unwrap_err(),
            format!("hub {url}: near \"SELEC\": syntax error")
        );

        // A port nothing listens on.
        let closed = {
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap()
        };
        let gone = Hub::new(&format!("http://{closed}"), TOKEN, client());
        let err = gone.get_json("/presence").await.unwrap_err();
        assert!(
            err.starts_with(&format!("hub http://{closed}: unreachable: ")),
            "{err}"
        );
    }

    #[tokio::test]
    async fn file_returns_the_bytes_untouched() {
        let (hub, seen) = Fake::new().serve().await;
        assert_eq!(
            hub.file("/a b/c.png").await.unwrap(),
            vec![0u8, 255, 10, 13]
        );
        assert_eq!(seen.lock().unwrap()[0].query, "path=%2Fa%20b%2Fc.png");
    }

    #[tokio::test]
    async fn git_remote_url_encodes_the_cwd() {
        let (hub, seen) = Fake::new().serve().await;
        // The command builds its target with `enc`: spaces, `&`, `+` and `#` cannot split it.
        let target = format!("/git-remote?cwd={}", enc("/tmp/my repo&x=1+2#f"));
        let v = hub.get_json(&target).await.unwrap();
        assert_eq!(v, serde_json::json!("git@host:r.git"));
        assert_eq!(
            seen.lock().unwrap()[0].query,
            "cwd=%2Ftmp%2Fmy%20repo%26x%3D1%2B2%23f"
        );
    }

    #[tokio::test]
    async fn image_put_sends_the_bytes_and_the_query() {
        let (hub, seen) = Fake::new().serve().await;
        let path = hub
            .image_put(3, "a b.png", vec![1, 2, 3, 255])
            .await
            .unwrap();
        assert_eq!(path, "/hub/attachments/3/a b.png");
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].method, Method::POST);
        assert_eq!(seen[0].path, "/image");
        assert_eq!(seen[0].query, "task_id=3&name=a%20b.png");
        assert_eq!(seen[0].body, vec![1, 2, 3, 255]);
    }

    #[tokio::test]
    async fn connect_refuses_another_schema_naming_both_numbers() {
        let mut fake = Fake::new();
        fake.schema = crate::hub::SCHEMA_VERSION + 1;
        let (hub, _) = fake.serve().await;
        let err = hub.connect().await.err().unwrap();
        assert_eq!(err.fatal_state, Some("schema-mismatch"));
        assert_eq!(
            err.message,
            format!(
                "hub {} is at schema {}, this app is at {}: run the same Tildone build on both",
                hub.url,
                crate::hub::SCHEMA_VERSION + 1,
                crate::hub::SCHEMA_VERSION
            )
        );
    }

    /// Run `follow` on a connected fake and collect what it reports.
    #[derive(Debug, PartialEq)]
    enum Note {
        Change,
        Status(&'static str),
    }

    async fn run_follow(hub: Hub) -> (mpsc::UnboundedReceiver<Note>, Subscriber) {
        let (version, stream) = hub.connect().await.map_err(String::from).unwrap();
        assert_eq!(version, crate::hub::SCHEMA_VERSION);
        let (tx, rx) = mpsc::unbounded_channel();
        let tx2 = tx.clone();
        let handle = tauri::async_runtime::spawn(async move {
            follow(
                hub,
                stream,
                &[Duration::from_millis(10)],
                move |s| {
                    let _ = tx.send(Note::Status(s.state));
                },
                move || {
                    let _ = tx2.send(Note::Change);
                },
            )
            .await
        });
        (rx, handle)
    }

    async fn take(rx: &mut mpsc::UnboundedReceiver<Note>, n: usize) -> Vec<Note> {
        let mut out = Vec::new();
        for _ in 0..n {
            out.push(
                tokio::time::timeout(Duration::from_secs(5), rx.recv())
                    .await
                    .expect("timed out waiting for a note")
                    .unwrap(),
            );
        }
        out
    }

    #[tokio::test]
    async fn change_events_reach_the_callback() {
        let (hub, _) = Fake::new().serve().await;
        let (mut rx, _follower) = run_follow(hub).await;
        assert_eq!(take(&mut rx, 2).await, vec![Note::Change, Note::Change]);
    }

    #[tokio::test]
    async fn follow_reconnects_after_the_stream_drops() {
        let mut fake = Fake::new();
        fake.drop_first_stream = true;
        let (hub, _) = fake.serve().await;
        let (mut rx, _follower) = run_follow(hub).await;
        // Two changes, the drop, then connected plus one change to reload, then
        // the second stream's own two changes.
        assert_eq!(
            take(&mut rx, 7).await,
            vec![
                Note::Change,
                Note::Change,
                Note::Status("error"),
                Note::Status("connected"),
                Note::Change,
                Note::Change,
                Note::Change,
            ]
        );
    }

    #[tokio::test]
    async fn follow_stops_when_the_token_is_refused_on_reconnect() {
        let mut fake = Fake::new();
        fake.drop_first_stream = true;
        fake.reject_events_from = Some(1);
        let (hub, _) = fake.serve().await;
        let (mut rx, _follower) = run_follow(hub).await;
        assert_eq!(
            take(&mut rx, 4).await,
            vec![
                Note::Change,
                Note::Change,
                Note::Status("error"),
                Note::Status("error"),
            ]
        );
        // The channel closes when follow returns: no further retries.
        let end = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await;
        assert!(matches!(end, Ok(None)), "{end:?}");
    }

    #[tokio::test]
    async fn a_stalled_stream_is_dropped_by_the_read_timeout_and_reconnected() {
        // The fake holds the stream open and sends nothing after its events.
        let (mut hub, _) = Fake::new().serve().await;
        hub.client = build_client(Duration::from_millis(300));
        let (mut rx, _follower) = run_follow(hub).await;
        assert_eq!(
            take(&mut rx, 3).await,
            vec![Note::Change, Note::Change, Note::Status("error")]
        );
        // The reconnect goes through backoff and succeeds.
        assert_eq!(take(&mut rx, 2).await[0], Note::Status("connected"));
    }

    #[tokio::test]
    async fn hub_disconnect_stops_the_follower() {
        let mut fake = Fake::new();
        fake.ticking = true;
        let (hub, _) = fake.serve().await;
        let slot = Mutex::new(None);
        let (mut rx, follower) = run_follow(hub).await;
        swap_subscriber(&slot, Some(follower));
        take(&mut rx, 4).await; // changes keep coming
        swap_subscriber(&slot, None);
        tokio::time::sleep(Duration::from_millis(100)).await;
        while rx.try_recv().is_ok() {}
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(rx.try_recv().is_err(), "an event arrived after disconnect");
        swap_subscriber(&slot, None); // a no-op when none runs
    }

    /// Sets a flag when its task is dropped, which is what abort does.
    struct Dropped(Arc<AtomicUsize>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn swapping_the_subscriber_aborts_the_old_one() {
        let slot = Mutex::new(None);
        let dropped = Arc::new(AtomicUsize::new(0));
        for _ in 0..3 {
            let guard = Dropped(dropped.clone());
            let handle = tauri::async_runtime::spawn(async move {
                let _guard = guard;
                futures_util::future::pending::<()>().await
            });
            swap_subscriber(&slot, Some(handle));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        // Three spawned, one left running in the slot.
        assert_eq!(dropped.load(Ordering::SeqCst), 2);
        swap_subscriber(&slot, None);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(dropped.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn image_args_decode_the_headers_and_refuse_bad_ones() {
        let headers = |pairs: &[(&str, &str)]| {
            let mut h = tauri::http::HeaderMap::new();
            for (k, v) in pairs {
                h.insert(
                    tauri::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                    v.parse().unwrap(),
                );
            }
            h
        };
        assert_eq!(
            image_args(&headers(&[
                ("x-task-id", "12"),
                ("x-name", "caf%C3%A9%20shot%2B1.png")
            ])),
            Ok((12, "café shot+1.png".to_string()))
        );
        for bad in [
            headers(&[("x-name", "a.png")]),
            headers(&[("x-task-id", "12")]),
            headers(&[("x-task-id", "twelve"), ("x-name", "a.png")]),
            headers(&[("x-task-id", "12"), ("x-name", "")]),
            headers(&[("x-task-id", "12"), ("x-name", "a%2")]),
            headers(&[("x-task-id", "12"), ("x-name", "%FF")]),
        ] {
            assert!(image_args(&bad).is_err(), "{bad:?}");
        }
    }
}
