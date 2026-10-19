//! `tildone-axi clients`: the Tildone apps that use this hub as their board hub, and
//! the fixed actions the hub machine can run on them. The hub keeps the list in
//! memory and only its own machine reaches these tools (`list_clients`,
//! `client_command`), so this works on the hub machine and nowhere else.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

use crate::hub::{self, Fail, Hub, Res};
use crate::toon;

/// The actions a client accepts (mirrors ACTIONS in src-tauri/src/clients.rs).
const ACTIONS: &[&str] = &[
    "status",
    "restart",
    "settings",
    "settings-set",
    "hook",
    "engine",
    "update",
    "log",
];

/// How long to wait for `client_command`: the hub gives up on a silent client after
/// 30 s and says which one, so the CLI must outlast it to relay that answer.
/// TILDONE_ACTION_TIMEOUT_MS replaces it (the tests use it).
const COMMAND_LIMIT: Duration = Duration::from_secs(40);

const LIST_HELP: &str = "tildone-axi clients";

fn say(text: &str) {
    println!("{}", text.trim_end());
}

/// Text from a client as one safe string: control characters other than newline
/// and tab become `\u00XX`, so a client cannot drive the operator's terminal.
fn plain(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\n' | '\t' => c.to_string(),
            c if c.is_control() => format!("\\u{:04X}", c as u32),
            c => c.to_string(),
        })
        .collect()
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// `42s ago`, `5m ago`, `3h ago`, `2d ago`; a time in the future reads as `0s ago`.
fn ago(at: i64) -> String {
    let s = (now() - at).max(0);
    match s {
        0..=59 => format!("{s}s ago"),
        60..=3599 => format!("{}m ago", s / 60),
        3600..=86399 => format!("{}h ago", s / 3600),
        _ => format!("{}d ago", s / 86400),
    }
}

/// Unix seconds as `2026-10-19T12:00:00Z` (UTC, civil-from-days).
fn iso(at: i64) -> String {
    let days = at.div_euclid(86400);
    let rem = at.rem_euclid(86400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn list_of<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
}

/// `connected`, or `seen 5m ago` once the stream is gone.
fn link(c: &Value) -> String {
    if c.get("connected").and_then(Value::as_bool) == Some(true) {
        "connected".into()
    } else {
        format!(
            "seen {}",
            ago(c.get("last_seen").and_then(Value::as_i64).unwrap_or(0))
        )
    }
}

fn error_count(report: &Value) -> usize {
    list_of(report, "hub_errors").len() + list_of(report, "window_errors").len()
}

async fn entries(hub: &Hub) -> Res<Vec<Value>> {
    let text = hub.call("list_clients", Map::new(), LIST_HELP).await?;
    Ok(serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default())
}

/// The one client `q` names: an exact id, an id prefix or a host. Zero or several
/// matches fail, the several naming each match.
fn pick<'a>(all: &'a [Value], q: &str) -> Res<&'a Value> {
    let hello = |c: &'a Value| c.get("hello").unwrap_or(&Value::Null).clone();
    if let Some(c) = all.iter().find(|c| s(&hello(c), "id") == q) {
        return Ok(c);
    }
    let hits: Vec<&Value> = all
        .iter()
        .filter(|c| {
            let h = hello(c);
            (!q.is_empty() && s(&h, "id").starts_with(q)) || s(&h, "host").eq_ignore_ascii_case(q)
        })
        .collect();
    match hits.as_slice() {
        [one] => Ok(one),
        [] => Err(Fail::tool(format!("no client matches `{q}`"), LIST_HELP)),
        many => {
            let names: Vec<String> = many
                .iter()
                .map(|c| {
                    let h = hello(c);
                    format!("{} ({})", s(&h, "id"), s(&h, "host"))
                })
                .collect();
            Err(Fail::tool(
                format!("`{q}` matches {} clients: {}", many.len(), names.join(", ")),
                "use the full id: tildone-axi clients <id>",
            ))
        }
    }
}

pub async fn run(
    hub: &Hub,
    target: Option<String>,
    action: Option<String>,
    args: Vec<String>,
) -> Res<()> {
    if let Some(a) = &action {
        if !ACTIONS.contains(&a.as_str()) {
            return Err(Fail::tool(
                format!("unknown client action `{a}`"),
                format!("actions: {}", ACTIONS.join("|")),
            ));
        }
    }
    let all = entries(hub).await?;
    match (target, action) {
        (None, _) => list(&all),
        (Some(q), None) => detail(pick(&all, &q)?),
        (Some(q), Some(action)) => command(hub, pick(&all, &q)?, &action, args).await?,
    }
    Ok(())
}

fn list(all: &[Value]) {
    if all.is_empty() {
        say("clients[0]:");
        say("help: no client apps are connected to this hub (a client connects by setting this app as its board hub)");
        return;
    }
    let rows: Vec<Value> = all
        .iter()
        .map(|c| {
            let h = c.get("hello").unwrap_or(&Value::Null);
            let report = c.get("report").filter(|r| !r.is_null());
            json!({
                "id": s(h, "id").chars().take(8).collect::<String>(),
                "host": s(h, "host"),
                "os": s(h, "os"),
                "commit": s(h, "commit"),
                "link": link(c),
                "hub": report.map_or("unreported", |r| s(r, "hub_state")),
                "errors": report.map_or(Value::Null, |r| json!(error_count(r))),
            })
        })
        .collect();
    say(&toon::table(
        "clients",
        &["id", "host", "os", "commit", "link", "hub", "errors"],
        &rows,
    ));
    say("help: tildone-axi clients <id|host> shows one; add an action to run it");
}

/// One client in full: identity, link, report, then every recent error newest first.
fn detail(c: &Value) {
    let h = c.get("hello").unwrap_or(&Value::Null);
    let mut out: Vec<String> = Vec::new();
    for key in [
        "id",
        "host",
        "os",
        "version",
        "commit",
        "schema",
        "exe",
        "installed",
        "source_dir",
    ] {
        out.push(toon::kv(key, h.get(key).unwrap_or(&Value::Null)));
    }
    let since = c
        .get("connected_since")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let seen = c.get("last_seen").and_then(Value::as_i64).unwrap_or(0);
    out.push(toon::kv("link", &json!(link(c))));
    out.push(toon::kv(
        "started_at",
        &json!(iso(h
            .get("started_at")
            .and_then(Value::as_i64)
            .unwrap_or(0))),
    ));
    out.push(toon::kv("connected_since", &json!(iso(since))));
    out.push(toon::kv(
        "last_seen",
        &json!(format!("{} ({})", iso(seen), ago(seen))),
    ));
    match c.get("report").filter(|r| !r.is_null()) {
        None => out.push("report: none yet (the client has not reported)".into()),
        Some(r) => {
            out.push(toon::kv("hub_state", &json!(s(r, "hub_state"))));
            out.push(toon::kv("hub_message", &json!(s(r, "hub_message"))));
            out.push(toon::kv("hook", r.get("hook").unwrap_or(&Value::Null)));
            out.push("settings:".into());
            if let Some(map) = r.get("settings").and_then(Value::as_object) {
                for (k, v) in map {
                    out.push(format!("  {}", toon::kv(k, v)));
                }
            }
            let mut errors: Vec<Value> = ["hub_errors", "window_errors"]
                .iter()
                .flat_map(|kind| {
                    list_of(r, kind).iter().map(move |e| {
                        let at = e.get("at").and_then(Value::as_i64).unwrap_or(0);
                        json!({"at": at, "source": kind.trim_end_matches("_errors"), "message": s(e, "message")})
                    })
                })
                .collect();
            errors.sort_by_key(|e| std::cmp::Reverse(e["at"].as_i64().unwrap_or(0)));
            for e in &mut errors {
                let at = e["at"].as_i64().unwrap_or(0);
                e["at"] = json!(format!("{} ({})", iso(at), ago(at)));
            }
            out.push(toon::table("errors", &["at", "source", "message"], &errors));
        }
    }
    out.push("help: tildone-axi clients <id|host> <action> runs an action (status|restart|settings|settings-set|hook|engine|update|log)".into());
    say(&out.join("\n"));
}

/// Runs `action` on the client and prints its output: text as is, JSON pretty.
async fn command(hub: &Hub, c: &Value, action: &str, args: Vec<String>) -> Res<()> {
    let id = s(c.get("hello").unwrap_or(&Value::Null), "id");
    let mut a = Map::new();
    a.insert("client".into(), json!(id));
    a.insert("action".into(), json!(action));
    a.insert("args".into(), json!(args));
    let help = format!("tildone-axi clients {id}");
    let limit = std::env::var("TILDONE_ACTION_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .map_or(COMMAND_LIMIT, Duration::from_millis);
    let text = match hub.call_within("client_command", a, &help, limit).await {
        // The hub answered earlier, so a timeout is a silent client, not a dead hub.
        Err(Fail::Conn { msg, .. }) if msg.ends_with(hub::TIMED_OUT) => {
            return Err(Fail::tool(
                format!(
                    "client {id}: {action} got no answer within {} s",
                    limit.as_secs().max(1)
                ),
                help,
            ))
        }
        // The text may quote what the client sent.
        Err(Fail::Tool { msg, help }) => return Err(Fail::tool(plain(&msg), help)),
        other => other?,
    };
    let result: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let output = result.get("output").cloned().unwrap_or(Value::Null);
    if result.get("ok").and_then(Value::as_bool) == Some(false) {
        let msg = output
            .as_str()
            .map_or_else(|| output.to_string(), str::to_string);
        return Err(Fail::tool(plain(&msg), help));
    }
    match output {
        Value::String(t) => say(&plain(&t)),
        other => say(&plain(
            &serde_json::to_string_pretty(&other).unwrap_or_default(),
        )),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::iso;

    #[test]
    fn iso_is_utc_civil_time() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_784_462_400), "2026-07-19T12:00:00Z");
        assert_eq!(iso(951_782_400), "2000-02-29T00:00:00Z");
    }
}
