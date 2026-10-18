//! The commands. Each one is a few tool calls plus the shaping of their output:
//! TOON for lists and cards, the hub's own compact JSON for receipts and `call`.

use std::io::Read;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::callargs::{self, task_ref};
use crate::git;
use crate::hub::{self, Fail, Hub, Res};
use crate::toon;

/// Notes longer than this are cut in `show`/`next` unless `--full`.
const NOTE_LINES: usize = 40;

fn args(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect()
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

fn field<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn say(text: &str) {
    println!("{}", text.trim_end());
}

pub async fn doctor(hub: &Hub) -> Res<()> {
    let (name, version, _) = hub.server();
    let tools = hub.tools().await?;
    say(&toon::kv("url", &json!(hub::url())));
    say(&toon::kv("reachable", &json!(true)));
    say(&toon::kv("server", &json!(format!("{name} {version}"))));
    say(&toon::kv("tools", &json!(tools.len())));
    Ok(())
}

pub async fn help(hub: &Hub) -> Res<()> {
    let (_, _, instructions) = hub.server();
    let tools: Vec<Value> = hub
        .tools()
        .await?
        .iter()
        .map(|t| {
            let about = t.description.as_deref().unwrap_or_default();
            let first = about.split(". ").next().unwrap_or_default();
            json!({"name": t.name, "about": first.chars().take(100).collect::<String>()})
        })
        .collect();
    say(include_str!("help.txt"));
    say(&toon::table("tools", &["name", "about"], &tools));
    say("help: tildone-axi call <tool> --help lists a tool's flags");
    println!("instructions:");
    for line in instructions.lines() {
        println!("  {line}");
    }
    Ok(())
}

pub async fn ls(hub: &Hub, project: Option<String>, done: bool) -> Res<()> {
    let project = project.unwrap_or_else(git::default_project);
    let mut a = args(&[("project", json!(project))]);
    if done {
        a.insert("include_done".into(), json!(true));
    }
    let text = hub
        .call("list_tasks", a, "tildone-axi call list_tasks --help")
        .await?;
    let tasks: Vec<Value> = parse(&text)
        .get("tasks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if tasks.is_empty() {
        say("tasks[0]:");
        say(&format!(
            "help: no {}tasks in project \"{project}\"; try tildone-axi ls --done, or --project <name>",
            if done { "" } else { "open " }
        ));
        return Ok(());
    }
    // `ref` can be absent on a very old row; fall back to the numeric id.
    let rows: Vec<Value> = tasks
        .iter()
        .map(|t| {
            json!({
                "ref": t.get("ref").filter(|r| !r.is_null()).or_else(|| t.get("id")).cloned().unwrap_or(Value::Null),
                "status": t.get("status").cloned().unwrap_or(Value::Null),
                "title": t.get("title").cloned().unwrap_or(Value::Null),
                "tags": t.get("tags").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    say(&toon::table(
        "tasks",
        &["ref", "status", "title", "tags"],
        &rows,
    ));
    Ok(())
}

pub async fn show(hub: &Hub, r: &str, full: bool) -> Res<()> {
    let text = hub
        .call("get_task", args(&[("id", task_ref(r))]), "tildone-axi ls")
        .await?;
    say(&render_card(&parse(&text), full, r));
    Ok(())
}

/// The whole card as TOON: flat fields, then subtasks, links, comments, and the
/// notes as an indented block. Notes past `NOTE_LINES` are cut with a `help:` line
/// that names the `--full` command.
fn render_card(task: &Value, full: bool, asked: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    fn put(out: &mut Vec<String>, key: &str, v: Option<&Value>) {
        if let Some(v) = v.filter(|v| !v.is_null() && v.as_str() != Some("")) {
            out.push(toon::kv(key, v));
        }
    }
    put(&mut out, "ref", task.get("ref").or_else(|| task.get("id")));
    put(&mut out, "title", task.get("title"));
    put(&mut out, "status", task.get("status"));
    let project = task.get("project").map(|p| p.get("name").unwrap_or(p));
    put(&mut out, "project", project);
    put(
        &mut out,
        "priority",
        task.get("priority").filter(|p| p.as_i64() != Some(0)),
    );
    put(&mut out, "due", task.get("due_date"));
    put(&mut out, "owner", task.get("owner"));
    put(&mut out, "from", task.get("from_task"));
    if let Some(g) = task.get("goal") {
        let line = format!("{} ({}/{})", field(g, "name"), g["done"], g["total"]);
        put(&mut out, "goal", Some(&json!(line)));
    }
    if let Some(tags) = task
        .get("tags")
        .and_then(Value::as_array)
        .filter(|t| !t.is_empty())
    {
        let list = tags
            .iter()
            .filter_map(Value::as_str)
            .map(toon::string)
            .collect::<Vec<_>>()
            .join(",");
        out.push(format!("tags[{}]: {list}", tags.len()));
    }
    let list = |key: &str| {
        task.get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let subtasks = list("subtasks");
    if !subtasks.is_empty() {
        out.push(toon::table("subtasks", &["id", "done", "title"], &subtasks));
    }
    let links = list("links");
    if !links.is_empty() {
        out.push(toon::table("links", &["kind", "label", "url"], &links));
    }
    let comments: Vec<Value> = list("comments")
        .iter()
        .map(|c| json!({"by": c.get("actor_name").filter(|n| !n.is_null()).or_else(|| c.get("actor_kind")), "at": c.get("created_at"), "body": c.get("body")}))
        .collect();
    if !comments.is_empty() {
        out.push(toon::table("comments", &["by", "at", "body"], &comments));
    }
    let notes = field(task, "notes").trim_end();
    let lines: Vec<&str> = notes.lines().collect();
    if !lines.is_empty() {
        out.push("notes:".into());
        let shown = if full {
            lines.len()
        } else {
            lines.len().min(NOTE_LINES)
        };
        out.extend(lines[..shown].iter().map(|l| format!("  {l}")));
        if shown < lines.len() {
            let r = task.get("ref").and_then(Value::as_str).unwrap_or(asked);
            out.push(format!(
                "help: tildone-axi show {r} --full ({} more lines)",
                lines.len() - shown
            ));
        }
    }
    out.join("\n")
}

/// Bare `tildone-axi`: this session's card, its open subtasks, and a next step.
pub async fn status() -> Res<()> {
    let Some(claim) = hub::claimed_card().await? else {
        let why = if hub::session_id().is_none() {
            " (CLAUDE_CODE_SESSION_ID is not set)"
        } else {
            ""
        };
        say(&format!("claimed: none{why}"));
        say("help: tildone-axi next (pull the top agent todo), or tildone-axi claim <ref>");
        return Ok(());
    };
    let hub = Hub::connect().await?;
    let got = hub
        .call(
            "get_task",
            args(&[("id", claim["task_id"].clone())]),
            "tildone-axi ls",
        )
        .await;
    hub.close().await;
    let task = parse(&got?);
    let open: Vec<Value> = task
        .get("subtasks")
        .and_then(Value::as_array)
        .map(|s| {
            s.iter()
                .filter(|s| s["done"] != json!(true))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    for key in ["ref", "title", "status", "branch", "state"] {
        if let Some(v) = claim.get(key).filter(|v| !v.is_null()) {
            say(&toon::kv(key, v));
        }
    }
    if !open.is_empty() {
        say(&toon::table("open", &["id", "title"], &open));
    }
    say(&if open.is_empty() {
        "help: tildone-axi done when the work is finished, or sub add \"<step>\" to plan more"
            .to_string()
    } else {
        "help: tildone-axi sub done <id> after a step, log \"<text>\" for progress, done when finished".to_string()
    });
    Ok(())
}

pub async fn claim(hub: &Hub, r: &str) -> Res<()> {
    let Some(session) = hub::session_id() else {
        return Err(Fail::tool(
            "CLAUDE_CODE_SESSION_ID is not set, so there is no session to claim the card for",
            "run inside a Claude Code session, or: tildone-axi call update-task --id <ref> --status doing",
        ));
    };
    let mut a = args(&[
        ("id", task_ref(r)),
        ("status", json!("doing")),
        ("session_id", json!(session)),
        ("cwd", json!(git::checkout())),
    ]);
    if let Some(b) = git::branch() {
        a.insert("branch".into(), json!(b));
    }
    let reply = hub
        .call("update_task", a, "tildone-axi call update_task --help")
        .await?;
    say(&receipt(&reply));
    Ok(())
}

/// The card a verb acts on: `--id`, else the card this session holds. The second
/// value is how the receipt names it.
async fn target(id: Option<String>) -> Res<(Value, String)> {
    if let Some(id) = id {
        return Ok((task_ref(&id), id));
    }
    match hub::claimed_card().await? {
        Some(card) => {
            let label = card
                .get("ref")
                .and_then(Value::as_str)
                .map_or_else(|| card["task_id"].to_string(), str::to_string);
            Ok((card["task_id"].clone(), label))
        }
        None => Err(Fail::tool(
            "this session holds no card",
            "tildone-axi claim <ref>, or pass --id <ref>",
        )),
    }
}

/// `s` as one single-quoted shell word, so `$`, backticks and quotes stay literal.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A write's reply cut down to a one-line receipt: only id, ref, status and a short
/// title survive, so a tool that echoes the input text back never reaches the output.
fn receipt(text: &str) -> String {
    let Ok(Value::Object(o)) = serde_json::from_str::<Value>(text) else {
        return text
            .lines()
            .next()
            .unwrap_or_default()
            .chars()
            .take(120)
            .collect();
    };
    let mut kept = Map::new();
    for key in ["id", "ref", "status", "title"] {
        if let Some(v) = o.get(key) {
            let v = match v {
                Value::String(s) if s.chars().count() > 80 => {
                    json!(format!("{}...", s.chars().take(80).collect::<String>()))
                }
                v => v.clone(),
            };
            kept.insert(key.to_string(), v);
        }
    }
    Value::Object(kept).to_string()
}

pub enum Verb {
    Log(String),
    Note(String),
    SubAdd(String),
    Done,
}

pub async fn verb(hub: &Hub, v: Verb, id: Option<String>) -> Res<()> {
    let (id, label) = target(id).await?;
    let (tool, a, done) = match v {
        Verb::Log(text) => (
            "log_progress",
            args(&[("task_id", id), ("text", json!(text))]),
            format!("logged on {label}"),
        ),
        Verb::Note(text) => (
            "append_note",
            args(&[("id", id), ("text", json!(text))]),
            format!("noted on {label}"),
        ),
        Verb::SubAdd(title) => (
            "add_subtask",
            args(&[("task_id", id), ("title", json!(title))]),
            format!("subtask added on {label}"),
        ),
        Verb::Done => (
            "complete_task",
            args(&[("id", id)]),
            format!("done {label}"),
        ),
    };
    let help = format!("tildone-axi call {} --help", tool.replace('_', "-"));
    hub.call(tool, a, &help).await?;
    say(&done);
    Ok(())
}

/// `sub done <id>`: the id is the subtask's own, as `show` and bare list it.
pub async fn sub_done(hub: &Hub, n: i64) -> Res<()> {
    let a = args(&[("id", json!(n)), ("done", json!(true))]);
    hub.call("set_subtask", a, "tildone-axi show <ref> lists subtask ids")
        .await?;
    say(&format!("subtask {n} done"));
    Ok(())
}

pub async fn new(
    hub: &Hub,
    title: &str,
    project: Option<String>,
    follow_up: bool,
    force: bool,
) -> Res<()> {
    let project = project.unwrap_or_else(git::default_project);
    let mut a = args(&[("title", json!(title)), ("project", json!(project))]);
    if follow_up {
        if !force {
            let search = args(&[
                ("project", json!(project)),
                ("include_done", json!(true)),
                ("search", json!(title)),
            ]);
            let text = hub
                .call("list_tasks", search, "tildone-axi call list_tasks --help")
                .await?;
            let matches: Vec<Value> = parse(&text)
                .get("tasks")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if !matches.is_empty() {
                say(&toon::table(
                    "matches",
                    &["ref", "status", "title"],
                    &matches,
                ));
                say(&format!(
                    "help: nothing created. If this is a new task: tildone-axi new {} --follow-up --force --project {}",
                    shell_quote(title),
                    shell_quote(&project)
                ));
                return Ok(());
            }
        }
        a.insert("tags".into(), json!(["follow-up"]));
        if let Some(card) = hub::claimed_card().await? {
            a.insert("from_task".into(), card["task_id"].clone());
        }
    }
    let reply = hub
        .call("create_task", a, "tildone-axi call create-task --help")
        .await?;
    say(&receipt(&reply));
    Ok(())
}

pub async fn next(hub: &Hub, project: Option<String>) -> Res<()> {
    let project = project.unwrap_or_else(git::default_project);
    let text = hub
        .call(
            "next_task",
            args(&[("project", json!(project))]),
            "tildone-axi ls",
        )
        .await?;
    let task = parse(&text);
    if task.get("ref").is_some() {
        say(&render_card(&task, false, ""));
        let r = field(&task, "ref");
        say(&format!("help: tildone-axi claim {r}"));
    } else if let Some(reason) = task.get("reason") {
        say(&toon::kv("reason", reason));
        say("help: tildone-axi ls --project <name> to see the board");
    } else {
        say(&text);
    }
    Ok(())
}

pub async fn wait(hub: &Hub, since: Option<i64>, ms: u64) -> Res<()> {
    let help = "tildone-axi call list_changes --help";
    // The server only parks when it has a cursor to compare against, so without
    // --since take the current one first.
    let since = match since {
        Some(s) => s,
        None => {
            let baseline = hub.call("list_changes", Map::new(), help).await?;
            parse(&baseline)
                .get("cursor")
                .and_then(Value::as_i64)
                .ok_or_else(|| Fail::tool("the hub sent no change cursor", help))?
        }
    };
    let a = args(&[("since", json!(since)), ("wait_ms", json!(ms))]);
    let limit = Duration::from_millis(ms) + Duration::from_secs(30);
    say(&hub.call_within("list_changes", a, help, limit).await?);
    Ok(())
}

/// `call <tool> [flags]`: the generic path to any server tool.
pub async fn call(hub: &Hub, tool: &str, tokens: &[String]) -> Res<()> {
    let wanted = tool.replace('-', "_");
    let tools = hub.tools().await?;
    let Some(t) = tools.iter().find(|t| t.name == wanted) else {
        return Err(Fail::tool(
            format!("unknown tool `{tool}`"),
            "tildone-axi help (lists every tool)",
        ));
    };
    let props = callargs::props(&t.input_schema);
    let usage = format!("tildone-axi call {tool} --help");
    if tokens.iter().any(|t| t == "--help" || t == "-h") {
        say(&toon::kv("tool", &json!(t.name)));
        say(&toon::kv(
            "about",
            &json!(t.description.as_deref().unwrap_or_default()),
        ));
        let rows: Vec<Value> = props
            .iter()
            .map(|p| json!({"flag": p.flag(), "type": p.kind.label(), "required": p.required, "about": p.about.chars().take(100).collect::<String>()}))
            .collect();
        say(&toon::table(
            "flags",
            &["flag", "type", "required", "about"],
            &rows,
        ));
        say("help: pass each as --<flag> <value>; --json '<object>' (or --json - for stdin) carries any nested value");
        return Ok(());
    }
    let a = callargs::parse(&props, tokens, || {
        let mut s = String::new();
        let _ = std::io::stdin().read_to_string(&mut s);
        s
    })
    .map_err(|e| Fail::tool(e, usage.clone()))?;
    say(&hub.call(&t.name, a, &usage).await?);
    Ok(())
}
