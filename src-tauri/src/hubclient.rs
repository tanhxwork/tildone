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
//!
//! The same connection makes this app a hub client (clients.rs): GET /events says
//! who it is (CLIENT_HEADER), a ClientReport goes to the hub after each connect,
//! every STATUS_EVERY and when the hub state changes, and a `command` event runs one
//! of the fixed actions in clientactions.rs and posts its result.

use crate::agent::{hide_tokens, AppActions, TauriActions};
use crate::clientactions;
use crate::clients::{self, ClientHello, ClientReport, Command, Logged};
use futures_util::future::{select, Either};
use futures_util::{stream::BoxStream, StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::error::Error as _;
use std::pin::pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{Emitter, Manager};

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
        record_hub_error(&message);
        Self {
            message,
            fatal_state: None,
        }
    }
    fn fatal(state: &'static str, message: String) -> Self {
        record_hub_error(&message);
        Self {
            message,
            fatal_state: Some(state),
        }
    }
}

/// What a ClientReport remembers: the failed hub calls and the window's uncaught
/// errors (newest last, ERRORS_KEPT each) and the last HUB_STATUS.
struct ClientLog {
    hub_errors: VecDeque<Logged>,
    window_errors: VecDeque<Logged>,
    state: String,
    message: String,
}

static LOG: Mutex<ClientLog> = Mutex::new(ClientLog {
    hub_errors: VecDeque::new(),
    window_errors: VecDeque::new(),
    state: String::new(),
    message: String::new(),
});

fn log() -> std::sync::MutexGuard<'static, ClientLog> {
    LOG.lock().unwrap_or_else(|e| e.into_inner())
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Append to a ring, dropping the oldest past ERRORS_KEPT.
fn push_logged(ring: &mut VecDeque<Logged>, message: &str) {
    ring.push_back(Logged {
        at: now(),
        message: message.to_string(),
    });
    while ring.len() > clients::ERRORS_KEPT {
        ring.pop_front();
    }
}

/// A failed hub call. HubError is the only producer of these.
fn record_hub_error(message: &str) {
    push_logged(&mut log().hub_errors, message);
}

/// The window's uncaught error or rejection, one line.
#[tauri::command]
pub fn client_report_error(message: String) {
    let line: String = message
        .lines()
        .next()
        .unwrap_or("")
        .chars()
        .take(500)
        .collect();
    push_logged(&mut log().window_errors, &line);
}

fn set_hub_state(state: &str, message: &str) {
    let mut log = log();
    log.state = state.to_string();
    log.message = message.to_string();
}

/// What this client says about itself now: the last HUB_STATUS, the error rings,
/// the settings with tokens hidden and the hook status.
pub(crate) fn report(actions: &dyn AppActions, id: &str) -> ClientReport {
    let (hub_state, hub_message, hub_errors, window_errors) = {
        let log = log();
        (
            if log.state.is_empty() {
                "connected".into()
            } else {
                log.state.clone()
            },
            log.message.clone(),
            log.hub_errors.iter().cloned().collect(),
            log.window_errors.iter().cloned().collect(),
        )
    };
    ClientReport {
        id: id.to_string(),
        hub_state,
        hub_message,
        hub_errors,
        window_errors,
        settings: actions
            .settings_get()
            .map(|s| Value::Object(hide_tokens(s)))
            .unwrap_or(Value::Null),
        hook: actions.hook_status().unwrap_or(Value::Null),
    }
}

/// What the hub accepts as a client id: 32 lowercase hex characters.
fn is_valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A random id kept in `<dir>/client-id`: made on first use, then read back. A file
/// holding anything else is replaced.
fn client_id(dir: &std::path::Path) -> String {
    let file = dir.join("client-id");
    if let Some(id) = std::fs::read_to_string(&file)
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| is_valid_id(t))
    {
        return id;
    }
    use std::hash::{BuildHasher, Hasher};
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // RandomState is seeded from the OS, so two of them make 128 random bits.
    let id: String = (0..2)
        .map(|_| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u128(nanos);
            h.write_u32(std::process::id());
            format!("{:016x}", h.finish())
        })
        .collect();
    if let Err(e) = std::fs::create_dir_all(dir).and_then(|_| std::fs::write(&file, &id)) {
        eprintln!(
            "tildone: cannot keep the client id in {}: {e}",
            file.display()
        );
    }
    id
}

#[cfg(unix)]
fn host_name() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: buf is valid for buf.len() bytes; gethostname NUL-terminates on success.
    if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } != 0 {
        return String::new();
    }
    let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..len]).to_string()
}

#[cfg(not(unix))]
fn host_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

/// When this process started, unix seconds: the first call sets it, and the app's
/// setup makes that call.
pub(crate) fn started_at() -> i64 {
    static START: OnceLock<i64> = OnceLock::new();
    *START.get_or_init(now)
}

fn hello(id: String) -> ClientHello {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let source_dir = std::fs::canonicalize(clients::SOURCE_DIR)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| clients::SOURCE_DIR.to_string());
    ClientHello {
        id,
        host: host_name(),
        os: std::env::consts::OS.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        commit: clients::BUILD_COMMIT.to_string(),
        schema: crate::hub::SCHEMA_VERSION,
        installed: crate::agent::is_installed_path(&exe, cfg!(target_os = "macos")),
        exe,
        source_dir,
        started_at: started_at(),
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
    /// The percent-encoded ClientHello sent as CLIENT_HEADER on /events.
    hello: Option<String>,
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
            hello: None,
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
        resp.json::<Value>().await.map_err(|e| {
            let message = format!("hub {}: bad response: {}", self.url, cause(&e));
            record_hub_error(&message);
            message
        })
    }

    /// `POST route` with a JSON body; the reply is not read.
    async fn post(&self, route: &str, body: &impl Serialize) -> Result<(), String> {
        self.send(self.timed(reqwest::Method::POST, route).json(body))
            .await?;
        Ok(())
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
        let mut req = self.request(reqwest::Method::GET, "/events");
        if let Some(hello) = &self.hello {
            req = req.header(clients::CLIENT_HEADER, hello);
        }
        let resp = self.send(req).await?;
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

/// The client side of the hub protocol, hooked into `follow`. Both hooks start a
/// task and return, so a slow report or action never stalls the change stream.
struct Link {
    /// How often to report unasked.
    every: Duration,
    /// Post a ClientReport now.
    report: Box<dyn Fn() + Send + Sync>,
    /// Run a `command` event, given its data.
    command: Box<dyn Fn(String) + Send + Sync>,
}

/// Follow a connected stream: `on_change` for each `change` event and
/// `link.command` for each `command`. When the stream drops, report an error and
/// reconnect after each wait in `backoff` (the last repeats); a reconnect reports
/// `connected` and calls `on_change` once, so the window reloads anything it
/// missed. A bad token or a different schema ends the loop with the matching
/// state. `link.report` runs at the start, every `link.every`, and whenever the
/// state changes.
async fn follow(
    hub: Hub,
    mut stream: EventStream,
    backoff: &[Duration],
    on_status: impl Fn(HubStatus),
    on_change: impl Fn(),
    link: Link,
) {
    let url = hub.url.clone();
    let mut last_state = "connected";
    let mut status = |s: HubStatus| {
        set_hub_state(s.state, &s.message);
        let changed = std::mem::replace(&mut last_state, s.state) != s.state;
        on_status(s);
        if changed {
            (link.report)();
        }
    };
    (link.report)();
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + link.every, link.every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let reason = loop {
            match select(pin!(stream.next_event()), pin!(tick.tick())).await {
                Either::Left((Ok(Some(ev)), _)) => match ev.event.as_str() {
                    "change" => on_change(),
                    clients::COMMAND_EVENT => (link.command)(ev.data),
                    _ => {}
                },
                Either::Left((Ok(None), _)) => break "closed the event stream".to_string(),
                Either::Left((Err(e), _)) => break format!("connection lost: {e}"),
                Either::Right(_) => (link.report)(),
            }
        };
        let message = format!("hub {url}: {reason}");
        record_hub_error(&message);
        status(HubStatus::new("error", message));
        let mut attempt = 0;
        stream = loop {
            tokio::time::sleep(backoff[attempt.min(backoff.len() - 1)]).await;
            attempt += 1;
            match hub.connect().await {
                Ok((_, s)) => break s,
                Err(e) => match e.fatal_state {
                    Some(state) => {
                        status(HubStatus::new(state, e.message));
                        return;
                    }
                    None => status(HubStatus::new("error", e.message)),
                },
            }
        };
        status(HubStatus::new("connected", ""));
        on_change();
    }
}

/// The hooks a real follower uses: post a report, run a command through
/// clientactions and post its result, then whatever it wants done after (a restart).
fn link(
    hub: &Hub,
    actions: Arc<dyn AppActions>,
    ctx: Arc<clientactions::Ctx>,
    every: Duration,
) -> Link {
    let send_report = {
        let (hub, actions, ctx) = (hub.clone(), actions.clone(), ctx.clone());
        move || {
            let (hub, actions, ctx) = (hub.clone(), actions.clone(), ctx.clone());
            tauri::async_runtime::spawn(async move {
                let body = report(&*actions, &ctx.id);
                if let Err(e) = hub.post(clients::STATUS_ROUTE, &body).await {
                    eprintln!("tildone: client report not sent: {e}");
                }
            });
        }
    };
    let hub = hub.clone();
    let command = move |data: String| {
        let cmd = match serde_json::from_str::<Command>(&data) {
            Ok(cmd) => cmd,
            Err(e) => return eprintln!("tildone: ignoring a bad command event: {e}"),
        };
        let (hub, actions, ctx) = (hub.clone(), actions.clone(), ctx.clone());
        tauri::async_runtime::spawn(async move {
            let done = clientactions::run(&*actions, &ctx, cmd).await;
            if let Err(e) = hub.post(clients::RESULT_ROUTE, &done.result).await {
                eprintln!("tildone: command result not sent: {e}");
            }
            if let Some(after) = done.after {
                after();
            }
        });
    };
    Link {
        every,
        report: Box::new(send_report),
        command: Box::new(command),
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
    let mut hub = Hub::from_settings(&app)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let id = client_id(&data_dir);
    hub.hello = serde_json::to_string(&hello(id.clone()))
        .ok()
        .map(|h| enc(&h));
    let (version, stream) = hub.connect().await?;
    set_hub_state("connected", "");
    let ctx = Arc::new(clientactions::Ctx {
        id,
        data_dir,
        source_dir: clients::SOURCE_DIR.into(),
        relaunch: Arc::new({
            let app = app.clone();
            move || {
                app.restart();
            }
        }),
    });
    let link = link(
        &hub,
        Arc::new(TauriActions(app.clone())),
        ctx,
        clients::STATUS_EVERY,
    );
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
            link,
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
    /// A valid hello id: the hub takes only 32 lowercase hex characters.
    const ID: &str = "0123456789abcdef0123456789abcdef";

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
        /// Every stream sends this as a `command` event after its changes.
        command: Option<String>,
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
                command: None,
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
            "/client-status" | "/client-result" => json(200, serde_json::json!({"ok": true})),
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
                let mut chunks: Vec<Vec<u8>> = vec![
                    schema.as_bytes()[..9].to_vec(),
                    schema.as_bytes()[9..].to_vec(),
                    b": keepalive\n\nevent: change\ndata: {}\n\n".to_vec(),
                    b"event: change\ndata: {}\n\n".to_vec(),
                ];
                if let Some(command) = &fake.command {
                    chunks.push(format!("event: command\ndata: {command}\n\n").into_bytes());
                }
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
            hub.sql("select", "SELEC broken", &[], None)
                .await
                .unwrap_err(),
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

    impl Link {
        /// Hooks that do nothing, reporting once an hour.
        fn idle() -> Self {
            Self {
                every: Duration::from_secs(3600),
                report: Box::new(|| {}),
                command: Box::new(|_| {}),
            }
        }
    }

    /// Run `follow` on a connected fake and collect what it reports.
    #[derive(Debug, PartialEq)]
    enum Note {
        Change,
        Status(&'static str),
    }

    async fn run_follow(hub: Hub) -> (mpsc::UnboundedReceiver<Note>, Subscriber) {
        run_follow_with(hub, Link::idle()).await
    }

    async fn run_follow_with(hub: Hub, link: Link) -> (mpsc::UnboundedReceiver<Note>, Subscriber) {
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
                link,
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

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tildone-hubclient-{name}-{}-{}",
            std::process::id(),
            now() as u128 * 1_000_000 + std::time::Instant::now().elapsed().subsec_nanos() as u128
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// An app with one token set and a hook that cannot be read.
    struct Quiet;
    impl AppActions for Quiet {
        fn settings_get(&self) -> Result<crate::agent::JsonMap, String> {
            Ok(
                serde_json::json!({ "theme": "dark", "board_hub_token": "tok-clear" })
                    .as_object()
                    .unwrap()
                    .clone(),
            )
        }
        fn settings_set(
            &self,
            _: crate::agent::JsonMap,
        ) -> Result<(crate::agent::JsonMap, Vec<String>), String> {
            Err("no".into())
        }
        fn hook_status(&self) -> Result<Value, String> {
            Err("no hook".into())
        }
        fn hook_install(&self) -> Result<String, String> {
            Err("no".into())
        }
        fn hook_uninstall(&self) -> Result<String, String> {
            Err("no".into())
        }
        fn engine(
            &self,
            _: crate::agent::EngineOp,
        ) -> futures_util::future::BoxFuture<'_, Result<Value, String>> {
            Box::pin(async { Err("no".to_string()) })
        }
    }

    fn posted(seen: &Arc<Mutex<Vec<Seen>>>, path: &str) -> Vec<Value> {
        seen.lock()
            .unwrap()
            .iter()
            .filter(|s| s.path == path)
            .map(|s| serde_json::from_slice(&s.body).unwrap())
            .collect()
    }

    async fn until(what: &str, mut ready: impl FnMut() -> bool) {
        for _ in 0..100 {
            if ready() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("timed out waiting for {what}");
    }

    #[tokio::test]
    async fn events_carry_the_hello_with_an_id_kept_across_runs() {
        let dir = temp_dir("id");
        let id = client_id(&dir);
        assert_eq!(id.len(), 32);
        assert_eq!(client_id(&dir), id, "the id changed on the second run");
        assert_ne!(client_id(&temp_dir("id2")), id);
        // A file the hub would refuse is replaced, and the new id is kept.
        for bad in ["me", "ABCDEF0123456789ABCDEF0123456789", ""] {
            std::fs::write(dir.join("client-id"), bad).unwrap();
            let fresh = client_id(&dir);
            assert!(is_valid_id(&fresh), "{bad:?} gave {fresh}");
            assert_eq!(client_id(&dir), fresh);
        }
        let id = client_id(&dir);

        let (mut hub, seen) = Fake::new().serve().await;
        hub.hello = serde_json::to_string(&hello(id.clone()))
            .ok()
            .map(|h| enc(&h));
        hub.connect().await.map_err(String::from).unwrap();
        let header = seen.lock().unwrap()[0].headers[clients::CLIENT_HEADER]
            .to_str()
            .unwrap()
            .to_string();
        let sent: ClientHello = serde_json::from_str(&dec(&header).unwrap()).unwrap();
        assert_eq!(sent, hello(id));
        assert_eq!(sent.schema, crate::hub::SCHEMA_VERSION);
        assert_eq!(sent.commit, clients::BUILD_COMMIT);
        assert!(!sent.host.is_empty() && !sent.exe.is_empty() && sent.started_at > 0);
    }

    #[tokio::test]
    async fn a_report_keeps_the_newest_errors_and_hides_tokens() {
        let mut ring = VecDeque::new();
        for i in 0..clients::ERRORS_KEPT + 5 {
            push_logged(&mut ring, &format!("e{i}"));
        }
        assert_eq!(ring.len(), clients::ERRORS_KEPT);
        assert_eq!(ring.front().unwrap().message, "e5");
        assert_eq!(
            ring.back().unwrap().message,
            format!("e{}", clients::ERRORS_KEPT + 4)
        );

        // The window's command keeps the first line only; HubError keeps its message.
        client_report_error("Uncaught TypeError: x is undefined\n    at app.js:1".into());
        let _ = HubError::transient("hub h: unreachable: refused".into());
        let r = report(&Quiet, ID);
        assert_eq!(
            r.window_errors.last().unwrap().message,
            "Uncaught TypeError: x is undefined"
        );
        assert!(r
            .hub_errors
            .iter()
            .any(|e| e.message == "hub h: unreachable: refused"));
        assert!(r.window_errors.len() <= clients::ERRORS_KEPT);
        assert_eq!(r.settings["board_hub_token"], "(set)");
        assert!(!serde_json::to_string(&r).unwrap().contains("tok-clear"));
        assert_eq!(r.hook, Value::Null);
    }

    #[tokio::test]
    async fn follow_reports_at_the_start_on_the_interval_and_on_a_state_change() {
        // State changes: start, then the drop (error), then the reconnect (connected).
        let mut fake = Fake::new();
        fake.drop_first_stream = true;
        let (hub, _) = fake.serve().await;
        let count = Arc::new(AtomicUsize::new(0));
        let counter = count.clone();
        let link = Link {
            every: Duration::from_secs(3600),
            report: Box::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
            command: Box::new(|_| {}),
        };
        let (_rx, _follower) = run_follow_with(hub, link).await;
        until("three reports", || count.load(Ordering::SeqCst) >= 3).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            count.load(Ordering::SeqCst),
            3,
            "an extra report with no change"
        );

        // The interval alone.
        let (hub, _) = Fake::new().serve().await;
        let count = Arc::new(AtomicUsize::new(0));
        let counter = count.clone();
        let link = Link {
            every: Duration::from_millis(60),
            report: Box::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
            command: Box::new(|_| {}),
        };
        let (_rx, _follower) = run_follow_with(hub, link).await;
        until("interval reports", || count.load(Ordering::SeqCst) >= 4).await;
    }

    fn real_link(hub: &Hub, relaunch: Arc<dyn Fn() + Send + Sync>) -> Link {
        let ctx = clientactions::Ctx {
            id: ID.into(),
            data_dir: temp_dir("data"),
            source_dir: temp_dir("src"),
            relaunch,
        };
        link(
            hub,
            Arc::new(Quiet),
            Arc::new(ctx),
            Duration::from_secs(3600),
        )
    }

    #[tokio::test]
    async fn a_command_event_posts_its_result_and_an_unknown_action_says_so() {
        let mut fake = Fake::new();
        fake.command = Some(r#"{"id":"c9","action":"bogus","args":[]}"#.into());
        let (hub, seen) = fake.serve().await;
        let link = real_link(&hub, Arc::new(|| {}));
        let (_rx, _follower) = run_follow_with(hub, link).await;
        until("the result", || !posted(&seen, "/client-result").is_empty()).await;
        let result = &posted(&seen, "/client-result")[0];
        assert_eq!(result["id"], "c9");
        assert_eq!(result["client"], ID);
        assert_eq!(result["ok"], false);
        assert!(
            result["output"].as_str().unwrap().contains("`bogus`"),
            "{result}"
        );
        // The report went out at the start, with the id and no clear token.
        until("the report", || !posted(&seen, "/client-status").is_empty()).await;
        let report = &posted(&seen, "/client-status")[0];
        assert_eq!(report["id"], ID);
        assert!(!report.to_string().contains("tok-clear"));
    }

    #[tokio::test]
    async fn a_bad_command_payload_is_ignored_and_restart_relaunches_after_the_result() {
        let (hub, seen) = Fake::new().serve().await;
        let (tx, mut relaunched) = mpsc::unbounded_channel();
        let seen2 = seen.clone();
        let link = real_link(
            &hub,
            Arc::new(move || {
                // What the hub had received by the time the app relaunched.
                let _ = tx.send(posted(&seen2, "/client-result").len());
            }),
        );
        (link.command)("not json".into());
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(posted(&seen, "/client-result").is_empty());
        (link.command)(r#"{"id":"r1","action":"restart"}"#.into());
        let results_seen = tokio::time::timeout(Duration::from_secs(5), relaunched.recv())
            .await
            .expect("never relaunched")
            .unwrap();
        assert_eq!(results_seen, 1, "relaunched before the result was posted");
    }

    /// The real hub router and the real follower, end to end: the hub lists the
    /// client from its hello, holds its report, and gets a command's result back.
    #[tokio::test]
    async fn the_real_hub_lists_this_client_and_runs_a_command_on_it() {
        let (events, _) = tokio::sync::broadcast::channel(16);
        let shutdown = tokio_util::sync::CancellationToken::new();
        let clients = crate::hub::Clients::default();
        let cfg = crate::hub::HubConfig {
            db: Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap())),
            on_change: Arc::new(|| {}),
            beats: Default::default(),
            events,
            token: TOKEN.into(),
            allowed_hosts: vec!["127.0.0.1".into()],
            data_dir: temp_dir("hub"),
            evidence_home: None,
            shutdown: shutdown.clone(),
            clients: clients.clone(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, crate::hub::router(cfg))
                .with_graceful_shutdown(shutdown.cancelled_owned())
                .await;
        });

        let mut hub = Hub::new(&format!("http://{addr}"), TOKEN, client());
        hub.hello = serde_json::to_string(&hello(ID.into()))
            .ok()
            .map(|h| enc(&h));
        let link = real_link(&hub, Arc::new(|| {}));
        let (_rx, _follower) = run_follow_with(hub, link).await;

        until("the report", || {
            clients.list().first().is_some_and(|c| c.report.is_some())
        })
        .await;
        let entry = &clients.list()[0];
        assert!(entry.connected);
        assert_eq!(entry.hello, hello(ID.into()));
        assert!(!serde_json::to_string(entry).unwrap().contains("tok-clear"));

        let done = clients
            .command(ID, "settings", vec![], Duration::from_secs(5))
            .await
            .unwrap();
        assert!(done.ok, "{done:?}");
        assert_eq!(done.client, ID);
        assert_eq!(done.output["theme"], "dark");
        assert_eq!(done.output["board_hub_token"], "(set)");
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
