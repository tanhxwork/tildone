//! The fixed actions a hub can run on this client app (TIL-248). `run` takes one
//! Command from the hub's `command` event (clients.rs) and returns its result.
//! Only the names in `clients::ACTIONS` exist; nothing the hub sends runs as a shell
//! command. `update` runs scripts/self-update.sh from this build's own checkout.

use crate::agent::{hide_tokens, AppActions, EngineOp, JsonMap};
use crate::clients::{Command, CommandResult, ACTIONS};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

/// Where `update` writes and `log` reads, inside the app data dir.
const UPDATE_LOG: &str = "self-update.log";
/// The running update's pid, written by scripts/self-update.sh and removed on exit.
const UPDATE_PID: &str = "self-update.pid";
/// How much of the end of the log `log` reads.
const LOG_WINDOW: u64 = 256 * 1024;
/// Lines `log` returns without an argument, and the most it returns.
const LOG_DEFAULT: usize = 100;
const LOG_MAX: usize = 2000;
/// Settings that name the link a command arrives over; changing one cuts it.
const LINK_KEYS: [&str; 2] = ["board_hub_url", "board_hub_token"];

/// What an action needs besides the app.
pub(crate) struct Ctx {
    /// The ClientHello id, echoed in each result.
    pub id: String,
    /// The app data dir (the update log lives here).
    pub data_dir: PathBuf,
    /// The checkout `update` rebuilds from.
    pub source_dir: PathBuf,
    /// Relaunch the app. The real one does not return.
    pub relaunch: Arc<dyn Fn() + Send + Sync>,
}

/// A result, and what to do once it has been sent.
pub(crate) struct Done {
    pub result: CommandResult,
    /// `restart` only: the relaunch, to run after the result has gone out.
    pub after: Option<Box<dyn FnOnce() + Send>>,
}

/// Run one command. An unknown action or bad args give `ok=false` naming it.
pub(crate) async fn run(actions: &dyn AppActions, ctx: &Ctx, cmd: Command) -> Done {
    let mut after: Option<Box<dyn FnOnce() + Send>> = None;
    let out = dispatch(actions, ctx, &cmd, &mut after).await;
    let (ok, output) = match out {
        Ok(v) => (true, v),
        Err(e) => (false, Value::String(e)),
    };
    Done {
        result: CommandResult {
            id: cmd.id,
            client: ctx.id.clone(),
            ok,
            output,
        },
        after,
    }
}

async fn dispatch(
    actions: &dyn AppActions,
    ctx: &Ctx,
    cmd: &Command,
    after: &mut Option<Box<dyn FnOnce() + Send>>,
) -> Result<Value, String> {
    let args: Vec<&str> = cmd.args.iter().map(String::as_str).collect();
    match (cmd.action.as_str(), args.as_slice()) {
        ("status", []) => serde_json::to_value(crate::hubclient::report(actions, &ctx.id))
            .map_err(|e| e.to_string()),
        ("restart", []) => {
            let relaunch = ctx.relaunch.clone();
            *after = Some(Box::new(move || relaunch()));
            Ok(json!({ "restarting": true }))
        }
        ("settings", []) => Ok(Value::Object(hide_tokens(actions.settings_get()?))),
        ("settings-set", [key, value]) => settings_set(actions, key, value),
        ("hook", [what @ ("connect" | "disconnect" | "status")]) => {
            match *what {
                "connect" => actions.hook_install().map(|_| ())?,
                "disconnect" => actions.hook_uninstall().map(|_| ())?,
                _ => {}
            }
            actions.hook_status()
        }
        ("engine", [what @ ("status" | "start" | "stop"), rest @ ..]) if rest.len() <= 1 => {
            engine(actions, what, rest.first().copied()).await
        }
        ("update", []) => update(ctx).await,
        ("log", []) => log_tail(ctx, LOG_DEFAULT),
        ("log", [n]) => match n.parse::<usize>() {
            Ok(n) => log_tail(ctx, n),
            Err(_) => Err(format!("log takes a line count, not `{n}`")),
        },
        (name, _) if !ACTIONS.contains(&name) => Err(format!(
            "unknown action `{name}`; one of: {}",
            ACTIONS.join(", ")
        )),
        ("settings-set", _) => Err("settings-set needs <key> <value>".into()),
        ("hook", _) => Err("hook needs connect, disconnect or status".into()),
        ("engine", _) => Err(
            "engine needs status, start or stop, and optionally small, default or better".into(),
        ),
        (name, _) => Err(format!("`{name}` takes no such arguments")),
    }
}

/// A value as the CLI's `settings set` sends it: on/off and true/false are booleans,
/// a whole number is a number (`none` clears default_project_id), anything else text.
fn setting_value(key: &str, raw: &str) -> Value {
    match raw.trim().to_lowercase().as_str() {
        "true" | "on" => return json!(true),
        "false" | "off" => return json!(false),
        "none" if key == "default_project_id" => return json!(0),
        _ => {}
    }
    match raw.trim().parse::<i64>() {
        Ok(n) => json!(n),
        Err(_) => json!(raw),
    }
}

fn settings_set(actions: &dyn AppActions, key: &str, value: &str) -> Result<Value, String> {
    if LINK_KEYS.contains(&key) {
        return Err(format!(
            "settings-set refuses {key}: changing it would cut the hub link this command came over"
        ));
    }
    let mut patch = JsonMap::new();
    patch.insert(key.to_string(), setting_value(key, value));
    let (settings, changed) = actions.settings_set(patch)?;
    Ok(json!({ "settings": hide_tokens(settings), "changed": changed }))
}

/// As the MCP `engine` tool: run the action, then return the engine status. The model
/// is the argument, else the ai_engine_model setting.
async fn engine(
    actions: &dyn AppActions,
    what: &str,
    model: Option<&str>,
) -> Result<Value, String> {
    let model = match model {
        Some(m) => m.to_string(),
        None => actions
            .settings_get()?
            .get("ai_engine_model")
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_string(),
    };
    match what {
        "start" => {
            actions.engine(EngineOp::Start(model.clone())).await?;
        }
        "stop" => {
            actions.engine(EngineOp::Stop).await?;
        }
        _ => {}
    }
    actions.engine(EngineOp::Status(model)).await
}

/// The last `n` lines of the update log, read from its last LOG_WINDOW bytes; no log
/// yet is an empty list.
fn log_tail(ctx: &Ctx, n: usize) -> Result<Value, String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = ctx.data_dir.join(UPDATE_LOG);
    let read = || -> std::io::Result<(Vec<u8>, bool)> {
        let mut file = std::fs::File::open(&path)?;
        let len = file.metadata()?.len();
        let cut = len > LOG_WINDOW;
        file.seek(SeekFrom::Start(len.saturating_sub(LOG_WINDOW)))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok((bytes, cut))
    };
    let lines: Vec<String> = match read() {
        Ok((bytes, cut)) => {
            let text = String::from_utf8_lossy(&bytes);
            let mut all: Vec<&str> = text.lines().collect();
            if cut && !all.is_empty() {
                all.remove(0); // the window starts mid-line
            }
            let from = all.len().saturating_sub(n.min(LOG_MAX));
            all[from..].iter().map(|l| l.to_string()).collect()
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    Ok(json!({ "log": path.to_string_lossy(), "lines": lines }))
}

/// The pid in the update pid file, when that process is alive.
#[cfg(unix)]
fn running_update(data: &std::path::Path) -> Option<i32> {
    // 0 or a negative pid would ask kill about a whole process group.
    let pid: i32 = std::fs::read_to_string(data.join(UPDATE_PID))
        .ok()?
        .trim()
        .parse()
        .ok()
        .filter(|p| *p > 0)?;
    // Signal 0 only checks; EPERM means the process exists but is not ours.
    // SAFETY: kill with signal 0 sends nothing.
    let alive = unsafe { libc::kill(pid, 0) } == 0
        || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    alive.then_some(pid)
}

#[cfg(not(unix))]
async fn update(_: &Ctx) -> Result<Value, String> {
    Err("update is not supported on Windows".into())
}

/// Refuse a checkout that is missing, not git, dirty or off main; else start
/// scripts/self-update.sh from it and reply with the log path.
#[cfg(unix)]
async fn update(ctx: &Ctx) -> Result<Value, String> {
    let (source, data) = (ctx.source_dir.clone(), ctx.data_dir.clone());
    tauri::async_runtime::spawn_blocking(move || start_update(&source, &data))
        .await
        .map_err(|e| format!("update failed to start: {e}"))?
}

#[cfg(unix)]
fn git(dir: &std::path::Path, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The user's login shell when it is one we know how to call, else the system's.
/// A GUI app on macOS has a minimal PATH; a login shell brings back bun and git.
#[cfg(unix)]
fn login_shell() -> String {
    let known = ["bash", "zsh", "sh", "dash", "ksh"];
    if let Ok(shell) = std::env::var("SHELL") {
        let name = shell.rsplit('/').next().unwrap_or("");
        if known.contains(&name) && std::path::Path::new(&shell).exists() {
            return shell;
        }
    }
    if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/bash"
    }
    .to_string()
}

#[cfg(unix)]
fn start_update(source: &std::path::Path, data: &std::path::Path) -> Result<Value, String> {
    use std::os::unix::process::CommandExt;
    let shown = source.display();
    let Ok(source) = std::fs::canonicalize(source) else {
        return Err(format!(
            "update refused: the source checkout {shown} is missing"
        ));
    };
    if git(&source, &["rev-parse", "--git-dir"]).is_none() {
        return Err(format!("update refused: {shown} is not a git checkout"));
    }
    if git(&source, &["status", "--porcelain", "--untracked-files=no"])
        .is_none_or(|s| !s.is_empty())
    {
        return Err(format!(
            "update refused: the checkout {shown} has uncommitted changes to tracked files"
        ));
    }
    let branch = git(&source, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    if branch != "main" {
        return Err(format!(
            "update refused: the checkout {shown} is on `{branch}`, not main"
        ));
    }
    if !source.join("scripts/self-update.sh").is_file() {
        return Err(format!(
            "update refused: {shown}/scripts/self-update.sh is missing"
        ));
    }
    // Held from the check until the pid file names the new run, so two update
    // commands arriving together cannot both start.
    static STARTING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _starting = STARTING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(pid) = running_update(data) {
        return Err(format!(
            "update refused: an update is already running (pid {pid}, in {}); see `log`",
            data.join(UPDATE_PID).display()
        ));
    }
    let log_path = data.join(UPDATE_LOG);
    let open = || -> std::io::Result<std::fs::File> {
        std::fs::create_dir_all(data)?;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
    };
    let log = open().map_err(|e| format!("cannot open {}: {e}", log_path.display()))?;
    let exe = std::env::current_exe().map_err(|e| format!("cannot find this app's exe: {e}"))?;
    let mut child = std::process::Command::new(login_shell())
        .args(["-lc", r#"exec bash "$1/scripts/self-update.sh" "$2" "$3""#])
        .arg("tildone-update")
        .arg(&source)
        .arg(std::process::id().to_string())
        .arg(exe)
        .current_dir(&source)
        .env("TILDONE_UPDATE_PID_FILE", data.join(UPDATE_PID))
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        // Its own process group, so stopping the app does not stop the update.
        .process_group(0)
        .spawn()
        .map_err(|e| format!("cannot start scripts/self-update.sh: {e}"))?;
    // `exec bash` keeps this pid; the script writes the same one and removes it.
    let pid_file = data.join(UPDATE_PID);
    let pid = child.id().to_string();
    let _ = std::fs::write(&pid_file, &pid);
    std::thread::spawn(move || {
        let _ = child.wait();
        // A script that stopped before its trap leaves the file behind.
        if std::fs::read_to_string(&pid_file).is_ok_and(|p| p.trim() == pid) {
            let _ = std::fs::remove_file(&pid_file);
        }
    });
    Ok(json!({ "started": true, "log": log_path.to_string_lossy() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::AppActions;
    use futures_util::future::BoxFuture;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    /// A fake app: a settings map that accepts any patch, a hook switch, and a
    /// record of the calls.
    struct FakeApp {
        settings: Mutex<JsonMap>,
        hook_on: AtomicBool,
        calls: Mutex<Vec<String>>,
    }

    impl FakeApp {
        fn new() -> Self {
            let settings = json!({
                "theme": "auto",
                "board_hub_url": "http://ws:11503",
                "board_hub_token": "secret-token",
                "ai_engine_model": "better",
            });
            Self {
                settings: Mutex::new(settings.as_object().unwrap().clone()),
                hook_on: AtomicBool::new(false),
                calls: Mutex::default(),
            }
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl AppActions for FakeApp {
        fn settings_get(&self) -> Result<JsonMap, String> {
            Ok(self.settings.lock().unwrap().clone())
        }
        fn settings_set(&self, patch: JsonMap) -> Result<(JsonMap, Vec<String>), String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("settings_set {}", Value::Object(patch.clone())));
            let mut s = self.settings.lock().unwrap();
            let changed = patch.keys().cloned().collect();
            s.extend(patch);
            Ok((s.clone(), changed))
        }
        fn hook_status(&self) -> Result<Value, String> {
            Ok(json!({ "installed": self.hook_on.load(Ordering::SeqCst) }))
        }
        fn hook_install(&self) -> Result<String, String> {
            self.hook_on.store(true, Ordering::SeqCst);
            Ok("Connected".into())
        }
        fn hook_uninstall(&self) -> Result<String, String> {
            self.hook_on.store(false, Ordering::SeqCst);
            Ok("Disconnected".into())
        }
        fn engine(&self, op: EngineOp) -> BoxFuture<'_, Result<Value, String>> {
            self.calls.lock().unwrap().push(format!("{op:?}"));
            Box::pin(async move {
                match op {
                    EngineOp::Status(model) => Ok(json!({ "model": model })),
                    _ => Ok(Value::Null),
                }
            })
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tildone-clientactions-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ctx(source: PathBuf, data: PathBuf, relaunched: Arc<AtomicBool>) -> Ctx {
        Ctx {
            id: "me".into(),
            data_dir: data,
            source_dir: source,
            relaunch: Arc::new(move || relaunched.store(true, Ordering::SeqCst)),
        }
    }

    async fn call(app: &FakeApp, ctx: &Ctx, action: &str, args: &[&str]) -> CommandResult {
        let cmd = Command {
            id: "c1".into(),
            action: action.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
        };
        run(app, ctx, cmd).await.result
    }

    fn plain_ctx() -> Ctx {
        ctx(temp_dir("src"), temp_dir("data"), Arc::default())
    }

    #[tokio::test]
    async fn status_and_settings_report_but_never_show_a_token() {
        let (app, ctx) = (FakeApp::new(), plain_ctx());
        let status = call(&app, &ctx, "status", &[]).await;
        assert!(status.ok);
        assert_eq!((status.id.as_str(), status.client.as_str()), ("c1", "me"));
        assert_eq!(status.output["id"], "me");
        assert_eq!(status.output["hook"]["installed"], false);
        let settings = call(&app, &ctx, "settings", &[]).await;
        assert_eq!(settings.output["board_hub_token"], "(set)");
        assert!(!status.output.to_string().contains("secret-token"));
        assert!(!settings.output.to_string().contains("secret-token"));
    }

    #[tokio::test]
    async fn an_unknown_action_or_bad_args_fail_naming_it() {
        let (app, ctx) = (FakeApp::new(), plain_ctx());
        let r = call(&app, &ctx, "rm-rf", &["/"]).await;
        assert!(!r.ok);
        assert!(r.output.as_str().unwrap().contains("`rm-rf`"), "{r:?}");
        let r = call(&app, &ctx, "hook", &["explode"]).await;
        assert!(!r.ok);
        assert!(r.output.as_str().unwrap().contains("hook needs"), "{r:?}");
        let r = call(&app, &ctx, "engine", &["install"]).await;
        assert!(!r.ok, "install is not an allowed engine action");
        assert!(app.calls().is_empty());
    }

    #[tokio::test]
    async fn settings_set_refuses_the_hub_link_and_applies_the_rest() {
        let (app, ctx) = (FakeApp::new(), plain_ctx());
        for key in ["board_hub_url", "board_hub_token"] {
            let r = call(&app, &ctx, "settings-set", &[key, "x"]).await;
            assert!(!r.ok);
            assert!(r.output.as_str().unwrap().contains(key), "{r:?}");
        }
        assert!(app.calls().is_empty(), "a refused key reached the app");
        let r = call(&app, &ctx, "settings-set", &["agent_server", "on"]).await;
        assert!(r.ok, "{r:?}");
        call(&app, &ctx, "settings-set", &["week_start", "monday"]).await;
        call(&app, &ctx, "settings-set", &["default_project_id", "7"]).await;
        assert_eq!(
            app.calls(),
            vec![
                r#"settings_set {"agent_server":true}"#,
                r#"settings_set {"week_start":"monday"}"#,
                r#"settings_set {"default_project_id":7}"#,
            ]
        );
        assert_eq!(r.output["changed"], json!(["agent_server"]));
        assert_eq!(r.output["settings"]["board_hub_token"], "(set)");
    }

    #[tokio::test]
    async fn hook_and_engine_follow_the_mcp_tools() {
        let (app, ctx) = (FakeApp::new(), plain_ctx());
        let r = call(&app, &ctx, "hook", &["connect"]).await;
        assert_eq!(r.output["installed"], true);
        let r = call(&app, &ctx, "hook", &["disconnect"]).await;
        assert_eq!(r.output["installed"], false);
        // The model defaults to the ai_engine_model setting.
        let r = call(&app, &ctx, "engine", &["start"]).await;
        assert_eq!(r.output["model"], "better");
        call(&app, &ctx, "engine", &["stop"]).await;
        assert_eq!(
            app.calls(),
            vec![
                r#"Start("better")"#,
                r#"Status("better")"#,
                "Stop",
                r#"Status("better")"#
            ]
        );
    }

    #[tokio::test]
    async fn restart_replies_first_and_relaunches_only_when_told() {
        let relaunched = Arc::new(AtomicBool::new(false));
        let ctx = ctx(temp_dir("src"), temp_dir("data"), relaunched.clone());
        let cmd = Command {
            id: "c1".into(),
            action: "restart".into(),
            args: vec![],
        };
        let done = run(&FakeApp::new(), &ctx, cmd).await;
        assert!(done.result.ok);
        assert!(
            !relaunched.load(Ordering::SeqCst),
            "relaunched before the reply"
        );
        (done.after.expect("restart sets an after step"))();
        assert!(relaunched.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn log_returns_the_last_n_lines_and_an_empty_list_without_a_log() {
        let (app, ctx) = (FakeApp::new(), plain_ctx());
        let r = call(&app, &ctx, "log", &[]).await;
        assert!(r.ok, "{r:?}");
        assert_eq!(r.output["lines"], json!([]));
        std::fs::write(ctx.data_dir.join(UPDATE_LOG), "a\nb\nc\nd\n").unwrap();
        assert_eq!(
            call(&app, &ctx, "log", &["2"]).await.output["lines"],
            json!(["c", "d"])
        );
        assert_eq!(
            call(&app, &ctx, "log", &[]).await.output["lines"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        assert!(!call(&app, &ctx, "log", &["lots"]).await.ok);

        // A log bigger than the read window: the newest lines, whole.
        let big: String = (0..40_000).map(|i| format!("line {i:06}\n")).collect();
        assert!(big.len() as u64 > LOG_WINDOW);
        std::fs::write(ctx.data_dir.join(UPDATE_LOG), big).unwrap();
        let r = call(&app, &ctx, "log", &["3"]).await;
        assert_eq!(
            r.output["lines"],
            json!(["line 039997", "line 039998", "line 039999"])
        );
        let all = call(&app, &ctx, "log", &["2000"]).await;
        assert_eq!(all.output["lines"][0], "line 038000");
    }

    #[cfg(unix)]
    fn sh(dir: &std::path::Path, script: &str) {
        let ok = std::process::Command::new("sh")
            .arg("-c")
            .arg(script)
            .current_dir(dir)
            .status()
            .unwrap()
            .success();
        assert!(ok, "{script}");
    }

    /// A temp git repo on `main` with a stub scripts/self-update.sh committed.
    #[cfg(unix)]
    fn repo() -> PathBuf {
        let dir = temp_dir("repo");
        sh(
            &dir,
            "git init -q -b main && mkdir scripts && \
             printf '#!/bin/sh\\necho \"stub updated $@\"\\n' > scripts/self-update.sh && \
             git add . && git -c user.name=t -c user.email=t@t commit -q -m init",
        );
        dir
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn update_refuses_a_missing_dirty_or_off_main_checkout() {
        let (app, data) = (FakeApp::new(), temp_dir("data"));
        let run = |source: PathBuf| {
            let (app, ctx) = (&app, ctx(source, data.clone(), Arc::default()));
            async move { call(app, &ctx, "update", &[]).await }
        };
        let missing = run(PathBuf::from("/nonexistent/tildone-source")).await;
        assert!(!missing.ok);
        assert!(
            missing.output.as_str().unwrap().contains("missing"),
            "{missing:?}"
        );

        let plain = run(temp_dir("plain")).await;
        assert!(
            plain
                .output
                .as_str()
                .unwrap()
                .contains("not a git checkout"),
            "{plain:?}"
        );

        let repo = repo();
        sh(&repo, "echo more >> scripts/self-update.sh");
        let dirty = run(repo.clone()).await;
        assert!(
            dirty.output.as_str().unwrap().contains("uncommitted"),
            "{dirty:?}"
        );

        sh(&repo, "git checkout -q -- . && git checkout -q -b feature");
        let off = run(repo.clone()).await;
        assert!(
            off.output.as_str().unwrap().contains("`feature`, not main"),
            "{off:?}"
        );
        assert!(
            !data.join(UPDATE_LOG).exists(),
            "a refusal started something"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn update_refuses_while_another_update_runs() {
        let (app, data) = (FakeApp::new(), temp_dir("data"));
        let ctx = ctx(repo(), data.clone(), Arc::default());
        // A pid file naming a live process (this test's own).
        std::fs::write(data.join(UPDATE_PID), std::process::id().to_string()).unwrap();
        let r = call(&app, &ctx, "update", &[]).await;
        assert!(!r.ok);
        assert!(
            r.output.as_str().unwrap().contains("already running"),
            "{r:?}"
        );
        assert!(
            !data.join(UPDATE_LOG).exists(),
            "a refusal started something"
        );
        // Pids 0 and -1 would ask about a process group, so they never count.
        for pid in ["0", "-1"] {
            std::fs::write(data.join(UPDATE_PID), pid).unwrap();
            assert_eq!(running_update(&data), None, "pid {pid}");
        }
        // A pid file left by a dead process does not block it.
        std::fs::write(data.join(UPDATE_PID), "2147483646").unwrap();
        assert!(call(&app, &ctx, "update", &[]).await.ok);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn update_on_a_clean_main_runs_the_script_into_the_log() {
        let (app, data) = (FakeApp::new(), temp_dir("data"));
        let ctx = ctx(repo(), data.clone(), Arc::default());
        let r = call(&app, &ctx, "update", &[]).await;
        assert!(r.ok, "{r:?}");
        assert_eq!(r.output["started"], true);
        assert_eq!(
            r.output["log"],
            data.join(UPDATE_LOG).to_string_lossy().as_ref()
        );
        // The script runs detached: wait for its line, which carries this pid.
        let want = format!("stub updated {}", std::process::id());
        for _ in 0..100 {
            let log = std::fs::read_to_string(data.join(UPDATE_LOG)).unwrap_or_default();
            if log.contains(&want) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("the update script never wrote to the log");
    }
}
