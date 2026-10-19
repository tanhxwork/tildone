//! A fake Tildone hub: a real streamable-HTTP MCP server plus the `/session/{id}/task`
//! route, on a free port. Tools record the arguments they receive and return canned text.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use axum::{
    extract::Path as AxPath, http::StatusCode, response::IntoResponse, routing::get, Json, Router,
};
use rmcp::{
    handler::server::ServerHandler,
    model::{
        CallToolRequestParams, CallToolResult, ContentBlock, ErrorData, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    RoleServer,
};
use serde_json::{json, Map, Value};

pub const INSTRUCTIONS: &str = "Fake hub instructions: claim a card before you work.";

#[derive(Default)]
struct State {
    tools: Vec<Tool>,
    replies: Mutex<HashMap<String, (bool, String)>>,
    delays: Mutex<HashMap<String, u64>>,
    calls: Mutex<Vec<(String, Value)>>,
    claims: Mutex<HashMap<String, Value>>,
    authorization: Mutex<Vec<String>>,
    origin_seen: Mutex<bool>,
}

#[derive(Clone)]
struct FakeServer(Arc<State>);

impl ServerHandler for FakeServer {
    fn get_info(&self) -> ServerConfig {
        let mut info = ServerConfig::new(ServerCapabilities::builder().enable_tools().build());
        info.server_info.name = "fake-hub".into();
        info.server_info.version = "9.9.9".into();
        info.with_instructions(INSTRUCTIONS)
    }

    #[allow(clippy::field_reassign_with_default)] // ListToolsResult is non_exhaustive
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let mut out = ListToolsResult::default();
        out.tools = self.0.tools.clone();
        Ok(out)
    }

    async fn call_tool(
        &self,
        req: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::CallToolResponse, ErrorData> {
        let args = Value::Object(req.arguments.clone().unwrap_or_default());
        self.0
            .calls
            .lock()
            .unwrap()
            .push((req.name.to_string(), args));
        let delay = self
            .0
            .delays
            .lock()
            .unwrap()
            .get(req.name.as_ref())
            .copied();
        if let Some(ms) = delay {
            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        }
        let (is_error, text) = self
            .0
            .replies
            .lock()
            .unwrap()
            .get(req.name.as_ref())
            .cloned()
            .unwrap_or((false, "{}".into()));
        let content = vec![ContentBlock::text(text)];
        Ok(if is_error {
            CallToolResult::error(content)
        } else {
            CallToolResult::success(content)
        }
        .into())
    }
}

pub struct Fake {
    pub url: String,
    state: Arc<State>,
}

/// The tools the CLI calls, with schemas shaped like the real server's.
fn standard_tools() -> Vec<Tool> {
    let task_ref = json!({"anyOf": [{"type": "integer"}, {"type": "string"}]});
    let defs = json!({"TaskRef": task_ref});
    let s = |t: &str| json!({"type": [t, "null"]});
    let tool = |name: &str, about: &str, props: Value, required: Value| {
        let Value::Object(schema) =
            json!({"$defs": defs, "type": "object", "properties": props, "required": required})
        else {
            unreachable!()
        };
        Tool::new(name.to_string(), about.to_string(), Arc::new(schema))
    };
    let r = json!({"$ref": "#/$defs/TaskRef"});
    vec![
        tool(
            "list_tasks",
            "List tasks. Filter by project.",
            json!({"project": s("string"), "search": s("string"), "include_done": s("boolean")}),
            json!([]),
        ),
        tool("get_task", "Get one task.", json!({"id": r}), json!(["id"])),
        tool(
            "update_task",
            "Update a task.",
            json!({"id": r, "title": s("string"), "status": s("string"), "priority": s("integer"), "session_id": s("string"), "cwd": s("string"), "branch": s("string"),
                   "tags": {"type": ["array", "null"], "items": {"type": "string"}}, "options": {"type": "object"}}),
            json!(["id"]),
        ),
        tool(
            "create_task",
            "Create a task.",
            json!({"title": {"type": "string"}, "project": s("string"), "tags": {"type": ["array", "null"], "items": {"type": "string"}}, "from_task": {"anyOf": [r, {"type": "null"}]}}),
            json!(["title"]),
        ),
        tool(
            "log_progress",
            "Log progress.",
            json!({"task_id": r, "text": {"type": "string"}}),
            json!(["task_id", "text"]),
        ),
        tool(
            "append_note",
            "Append to notes.",
            json!({"id": r, "text": {"type": "string"}}),
            json!(["id", "text"]),
        ),
        tool(
            "add_subtask",
            "Add a subtask.",
            json!({"task_id": r, "title": {"type": "string"}}),
            json!(["task_id", "title"]),
        ),
        tool(
            "set_subtask",
            "Tick a subtask.",
            json!({"id": {"type": "integer"}, "done": s("boolean")}),
            json!(["id"]),
        ),
        tool(
            "complete_task",
            "Complete a task.",
            json!({"id": r}),
            json!(["id"]),
        ),
        tool(
            "next_task",
            "Next agent todo.",
            json!({"project": {"type": "string"}}),
            json!(["project"]),
        ),
        tool(
            "list_changes",
            "Park for changes.",
            json!({"since": s("integer"), "wait_ms": s("integer")}),
            json!([]),
        ),
        tool("get_settings", "Read every setting.", json!({}), json!([])),
        tool(
            "update_settings",
            "Change settings.",
            json!({"theme": s("string"), "week_start": s("string"), "default_project_id": s("integer"),
                   "agent_server": s("boolean"), "ai_model": s("string")}),
            json!([]),
        ),
        tool("list_clients", "List client apps.", json!({}), json!([])),
        tool(
            "client_command",
            "Run an action on a client app.",
            json!({"client": {"type": "string"}, "action": {"type": "string"}, "args": {"type": "array", "items": {"type": "string"}}}),
            json!(["client", "action"]),
        ),
        tool(
            "claude_hook",
            "Connect, disconnect or check the Claude hook.",
            json!({"action": {"type": "string"}}),
            json!(["action"]),
        ),
        tool(
            "engine",
            "Manage the local AI engine.",
            json!({"action": {"type": "string"}, "model": s("string"), "file": s("string")}),
            json!(["action"]),
        ),
    ]
}

impl Fake {
    pub async fn start() -> Fake {
        let state = Arc::new(State {
            tools: standard_tools(),
            ..Default::default()
        });
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let handler = state.clone();
        let service: StreamableHttpService<FakeServer, LocalSessionManager> =
            StreamableHttpService::new(
                move || Ok(FakeServer(handler.clone())),
                Default::default(),
                StreamableHttpServerConfig::default(),
            );
        let claims = state.clone();
        let seen = state.clone();
        let router = Router::new()
            .nest_service("/mcp", service)
            .route(
                "/session/{id}/task",
                get(move |AxPath(id): AxPath<String>| async move {
                    match claims.claims.lock().unwrap().get(&id) {
                        Some(card) => Json(card.clone()).into_response(),
                        None => StatusCode::NO_CONTENT.into_response(),
                    }
                }),
            )
            .layer(axum::middleware::from_fn(
                move |req: axum::extract::Request, next: axum::middleware::Next| {
                    let seen = seen.clone();
                    async move {
                        if let Some(a) = req.headers().get("authorization") {
                            seen.authorization
                                .lock()
                                .unwrap()
                                .push(a.to_str().unwrap().to_string());
                        }
                        if req.headers().contains_key("origin") {
                            *seen.origin_seen.lock().unwrap() = true;
                        }
                        next.run(req).await
                    }
                },
            ));
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            let _ = axum::serve(listener, router).await;
        });
        Fake {
            url: format!("http://{addr}/mcp"),
            state,
        }
    }

    /// The next result of `tool`, as the text the hub would send.
    pub fn reply(&self, tool: &str, text: impl Into<String>) {
        self.state
            .replies
            .lock()
            .unwrap()
            .insert(tool.into(), (false, text.into()));
    }

    pub fn reply_json(&self, tool: &str, v: Value) {
        self.reply(tool, v.to_string());
    }

    /// Makes `tool` answer only after `ms` milliseconds.
    pub fn delay(&self, tool: &str, ms: u64) {
        self.state.delays.lock().unwrap().insert(tool.into(), ms);
    }

    /// Makes `tool` return an `isError` result.
    pub fn fail(&self, tool: &str, text: &str) {
        self.state
            .replies
            .lock()
            .unwrap()
            .insert(tool.into(), (true, text.into()));
    }

    /// Makes `/session/{session}/task` answer 200 with this card.
    pub fn claim(&self, session: &str, card: Value) {
        self.state
            .claims
            .lock()
            .unwrap()
            .insert(session.into(), card);
    }

    pub fn calls(&self) -> Vec<(String, Value)> {
        self.state.calls.lock().unwrap().clone()
    }

    pub fn calls_to(&self, tool: &str) -> Vec<Value> {
        self.calls()
            .into_iter()
            .filter(|(n, _)| n == tool)
            .map(|(_, a)| a)
            .collect()
    }

    pub fn authorization(&self) -> Vec<String> {
        self.state.authorization.lock().unwrap().clone()
    }

    pub fn origin_seen(&self) -> bool {
        *self.state.origin_seen.lock().unwrap()
    }
}

pub struct Out {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub struct Run {
    args: Vec<String>,
    env: Vec<(String, String)>,
    cwd: Option<PathBuf>,
    stdin: Option<String>,
    url: Option<String>,
}

pub fn tildone(fake: &Fake, args: &[&str]) -> Run {
    Run {
        args: args.iter().map(|s| s.to_string()).collect(),
        env: vec![],
        cwd: None,
        stdin: None,
        url: Some(fake.url.clone()),
    }
}

impl Run {
    pub fn env(mut self, k: &str, v: &str) -> Self {
        self.env.push((k.to_string(), v.to_string()));
        self
    }
    pub fn session(self, id: &str) -> Self {
        self.env("CLAUDE_CODE_SESSION_ID", id)
    }
    pub fn cwd(mut self, p: &Path) -> Self {
        self.cwd = Some(p.to_path_buf());
        self
    }
    pub fn stdin(mut self, s: &str) -> Self {
        self.stdin = Some(s.to_string());
        self
    }
    pub fn url(mut self, u: Option<&str>) -> Self {
        self.url = u.map(str::to_string);
        self
    }

    /// Runs the binary on a blocking thread so the fake hub keeps serving.
    pub async fn run(self) -> Out {
        tokio::task::spawn_blocking(move || {
            let mut c = Command::new(env!("CARGO_BIN_EXE_tildone-axi"));
            c.args(&self.args)
                .env_remove("TILDONE_URL")
                .env_remove("TILDONE_TOKEN")
                .env_remove("CLAUDE_CODE_SESSION_ID")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if let Some(u) = &self.url {
                c.env("TILDONE_URL", u);
            }
            for (k, v) in &self.env {
                c.env(k, v);
            }
            if let Some(d) = &self.cwd {
                c.current_dir(d);
            }
            let mut child = c.spawn().unwrap();
            {
                use std::io::Write;
                let mut stdin = child.stdin.take().unwrap();
                if let Some(s) = &self.stdin {
                    stdin.write_all(s.as_bytes()).unwrap();
                }
            }
            let out = child.wait_with_output().unwrap();
            Out {
                code: out.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            }
        })
        .await
        .unwrap()
    }
}

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap()
        .status
        .success();
    assert!(ok, "git {args:?} failed in {dir:?}");
}

/// A fresh git repo named `name` on branch `feat`, with one commit. `test` keeps
/// parallel tests apart.
pub fn repo(test: &str, name: &str) -> PathBuf {
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(test);
    let _ = std::fs::remove_dir_all(&root);
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "feat"]);
    git(&dir, &["commit", "-q", "--allow-empty", "-m", "init"]);
    dir.canonicalize().unwrap()
}

/// A linked worktree of `repo`, in a differently named folder.
pub fn worktree(repo: &Path, name: &str) -> PathBuf {
    let wt = repo.parent().unwrap().join(name);
    git(
        repo,
        &[
            "worktree",
            "add",
            "-q",
            wt.to_str().unwrap(),
            "-b",
            "wt-branch",
        ],
    );
    wt.canonicalize().unwrap()
}

pub fn object(v: Value) -> Map<String, Value> {
    let Value::Object(m) = v else {
        panic!("not an object")
    };
    m
}
