//! tildone-axi against a fake hub: a real MCP server in this process, the real
//! binary as a subprocess.

mod common;

use common::{repo, tildone, worktree, Fake, INSTRUCTIONS};
use serde_json::{json, Value};

fn no_calls(fake: &Fake, tool: &str) {
    assert!(
        fake.calls_to(tool).is_empty(),
        "{tool} must not be called: {:?}",
        fake.calls()
    );
}

// ---- doctor, url, token ------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn doctor_reachable() {
    let fake = Fake::start().await;
    let out = tildone(&fake, &["doctor"]).run().await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(
        out.stdout.contains(&format!("url: \"{}\"", fake.url)),
        "{}",
        out.stdout
    );
    assert!(out.stdout.contains("reachable: true"));
    assert!(out.stdout.contains("server: fake-hub 9.9.9"));
    assert!(out.stdout.contains("tools: 17"));
}

#[tokio::test(flavor = "multi_thread")]
async fn doctor_unreachable_exits_2() {
    let fake = Fake::start().await;
    // Port 1 refuses connections.
    let out = tildone(&fake, &["doctor"])
        .url(Some("http://127.0.0.1:1/mcp"))
        .run()
        .await;
    assert_eq!(out.code, 2);
    assert!(
        out.stderr.contains("http://127.0.0.1:1/mcp"),
        "{}",
        out.stderr
    );
    assert!(
        out.stderr.contains("Settings → Agent access"),
        "{}",
        out.stderr
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn url_env_override() {
    let fake = Fake::start().await;
    // No TILDONE_URL: the default hub address is the one tried (reached or not).
    let out = tildone(&fake, &["doctor"]).url(None).run().await;
    let all = format!("{}{}", out.stdout, out.stderr);
    assert!(all.contains("http://127.0.0.1:11502/mcp"), "{all}");
    // TILDONE_URL wins: the fake answered, so it was the one used.
    let out = tildone(&fake, &["doctor"]).run().await;
    assert_eq!(out.code, 0);
    assert!(out.stdout.contains(&fake.url));
}

#[tokio::test(flavor = "multi_thread")]
async fn token_sent_as_bearer() {
    let fake = Fake::start().await;
    fake.claim(
        "sess-1",
        json!({"task_id": 5, "ref": "TIL-5", "title": "T", "status": "doing"}),
    );
    fake.reply_json(
        "get_task",
        json!({"ref": "TIL-5", "title": "T", "status": "doing", "subtasks": []}),
    );
    let out = tildone(&fake, &[])
        .session("sess-1")
        .env("TILDONE_TOKEN", "s3cret")
        .run()
        .await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    let seen = fake.authorization();
    // The plain claim GET and every MCP request carry the token; none carries Origin.
    assert!(seen.len() >= 3, "{seen:?}");
    assert!(seen.iter().all(|a| a == "Bearer s3cret"), "{seen:?}");
    assert!(
        !fake.origin_seen(),
        "the hub rejects requests that carry an Origin"
    );
    // And without a token nothing is sent.
    let before = fake.authorization().len();
    tildone(&fake, &["doctor"]).run().await;
    assert_eq!(fake.authorization().len(), before);
}

// ---- ls ----------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn ls_table_uniform_rows() {
    let fake = Fake::start().await;
    fake.reply_json(
        "list_tasks",
        json!({"count": 3, "tasks": [
            {"id": 1, "ref": "TIL-230", "title": "Build, test and run e2e on Linux", "status": "done", "tags": ""},
            {"id": 2, "ref": "TIL-216", "title": "Town view ignores the current goal selection", "status": "done", "tags": "follow-up"},
            {"id": 3, "title": "Old row: no ref", "status": "todo", "tags": ["a", "b"]},
        ]}),
    );
    let out = tildone(&fake, &["ls", "--project", "tildone", "--done"])
        .run()
        .await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        out.stdout.trim_end(),
        "tasks[3]{ref,status,title,tags}:\n  TIL-230,done,\"Build, test and run e2e on Linux\",\"\"\n  TIL-216,done,Town view ignores the current goal selection,follow-up\n  3,todo,\"Old row: no ref\",\"a,b\""
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ls_default_project() {
    let fake = Fake::start().await;
    fake.reply_json("list_tasks", json!({"count": 0, "tasks": []}));
    let dir = repo("ls_default_project", "myproj");
    tildone(&fake, &["ls"]).cwd(&dir).run().await;
    tildone(&fake, &["ls", "--done"]).cwd(&dir).run().await;
    // A linked worktree maps to the repo it belongs to, not to its own folder name.
    let wt = worktree(&dir, "myproj-slug");
    tildone(&fake, &["ls"]).cwd(&wt).run().await;
    tildone(&fake, &["ls", "--project", "other"])
        .cwd(&dir)
        .run()
        .await;
    let calls = fake.calls_to("list_tasks");
    assert_eq!(calls[0], json!({"project": "myproj"}));
    assert_eq!(calls[1]["include_done"], json!(true));
    assert_eq!(calls[2], json!({"project": "myproj"}));
    assert_eq!(calls[3], json!({"project": "other"}));
}

#[tokio::test(flavor = "multi_thread")]
async fn ls_search_passes_through() {
    let fake = Fake::start().await;
    fake.reply_json("list_tasks", json!({"count": 0, "tasks": []}));
    tildone(&fake, &["ls", "--project", "p", "--search", "hub token"])
        .run()
        .await;
    assert_eq!(
        fake.calls_to("list_tasks")[0],
        json!({"project": "p", "search": "hub token"})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ls_empty_hint() {
    let fake = Fake::start().await;
    fake.reply_json("list_tasks", json!({"count": 0, "tasks": []}));
    let out = tildone(&fake, &["ls", "--project", "empty"]).run().await;
    assert_eq!(out.code, 0);
    assert!(out.stdout.starts_with("tasks[0]:"), "{}", out.stdout);
    assert!(
        out.stdout
            .contains("help: no open tasks in project \"empty\""),
        "{}",
        out.stdout
    );
}

// ---- show --------------------------------------------------------------------

fn card_with_notes(lines: usize) -> Value {
    let notes: Vec<String> = (1..=lines).map(|i| format!("note line {i}")).collect();
    json!({
        "id": 9, "ref": "TIL-9", "title": "A card", "status": "doing", "priority": 2,
        "project": {"id": 1, "name": "tildone"}, "owner": "agent", "tags": ["x"],
        "notes": notes.join("\n"),
        "subtasks": [{"id": 4, "title": "First step", "done": true}, {"id": 5, "title": "Second step", "done": false}],
        "comments": [{"id": 1, "body": "Why?", "actor_kind": "human", "created_at": "2026-10-18"}],
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn show_truncates_notes() {
    let fake = Fake::start().await;
    fake.reply_json("get_task", card_with_notes(55));
    let out = tildone(&fake, &["show", "TIL-9"]).run().await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.contains("ref: TIL-9"));
    assert!(
        out.stdout
            .contains("subtasks[2]{id,done,title}:\n  4,true,First step\n  5,false,Second step"),
        "{}",
        out.stdout
    );
    assert!(out.stdout.contains("  note line 40\n"));
    assert!(!out.stdout.contains("note line 41"));
    assert!(
        out.stdout
            .trim_end()
            .ends_with("help: tildone-axi show TIL-9 --full (15 more lines)"),
        "{}",
        out.stdout
    );
    assert_eq!(fake.calls_to("get_task")[0], json!({"id": "TIL-9"}));
}

#[tokio::test(flavor = "multi_thread")]
async fn show_full() {
    let fake = Fake::start().await;
    fake.reply_json("get_task", card_with_notes(55));
    let out = tildone(&fake, &["show", "9", "--full"]).run().await;
    assert!(out.stdout.contains("  note line 55"));
    assert!(!out.stdout.contains("help:"), "{}", out.stdout);
    assert_eq!(fake.calls_to("get_task")[0], json!({"id": 9}));
}

// ---- bare, claim, verbs ------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn bare_shows_claimed_card() {
    let fake = Fake::start().await;
    fake.claim("sess-1", json!({"task_id": 232, "ref": "TIL-232", "title": "Build the CLI", "status": "doing", "branch": "feat", "state": "quiet"}));
    fake.reply_json("get_task", card_with_notes(0));
    let out = tildone(&fake, &[]).session("sess-1").run().await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.contains("ref: TIL-232"));
    assert!(
        out.stdout.contains("open[1]{id,title}:\n  5,Second step"),
        "{}",
        out.stdout
    );
    assert!(
        !out.stdout.contains("First step"),
        "a finished subtask is not a next step"
    );
    assert!(
        out.stdout.contains("help: tildone-axi sub done <id>"),
        "{}",
        out.stdout
    );
    assert_eq!(fake.calls_to("get_task"), vec![json!({"id": 232})]);
}

#[tokio::test(flavor = "multi_thread")]
async fn bare_without_claim() {
    let fake = Fake::start().await;
    let out = tildone(&fake, &[]).session("sess-none").run().await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.contains("claimed: none"));
    assert!(
        out.stdout.contains("tildone-axi next") && out.stdout.contains("tildone-axi claim <ref>"),
        "{}",
        out.stdout
    );
    assert!(fake.calls().is_empty(), "no claim means no MCP call");
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_fills_session_cwd_branch() {
    let fake = Fake::start().await;
    let dir = repo("claim_fills", "proj");
    let sub = dir.join("deep");
    std::fs::create_dir_all(&sub).unwrap();
    let out = tildone(&fake, &["claim", "TIL-5"])
        .session("sess-1")
        .cwd(&sub)
        .run()
        .await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        fake.calls_to("update_task")[0],
        json!({"id": "TIL-5", "status": "doing", "session_id": "sess-1", "cwd": dir.to_str().unwrap(), "branch": "feat"})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_without_session_id() {
    let fake = Fake::start().await;
    let out = tildone(&fake, &["claim", "TIL-5"]).run().await;
    assert_eq!(out.code, 1);
    assert!(
        out.stderr.starts_with("error: CLAUDE_CODE_SESSION_ID"),
        "{}",
        out.stderr
    );
    assert!(out.stderr.contains("\nhelp: "), "{}", out.stderr);
    no_calls(&fake, "update_task");
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_flags_override_defaults() {
    let fake = Fake::start().await;
    // --session works with no CLAUDE_CODE_SESSION_ID; --cwd and --branch beat git.
    let out = tildone(
        &fake,
        &[
            "claim",
            "TIL-5",
            "--session",
            "s-9",
            "--cwd",
            "/x/tree",
            "--branch",
            "b-2",
        ],
    )
    .run()
    .await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        fake.calls_to("update_task")[0],
        json!({"id": "TIL-5", "status": "doing", "session_id": "s-9", "cwd": "/x/tree", "branch": "b-2"})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn verbs_target_claimed_card() {
    let fake = Fake::start().await;
    fake.claim(
        "sess-1",
        json!({"task_id": 77, "ref": "TIL-77", "title": "T", "status": "doing"}),
    );
    for args in [
        &["log", "did", "the", "thing"][..],
        &["note", "remember this"],
        &["sub", "add", "Write tests"],
        &["sub", "done", "12"],
        &["done"],
    ] {
        let out = tildone(&fake, args).session("sess-1").run().await;
        assert_eq!(out.code, 0, "{args:?}: {}", out.stderr);
    }
    assert_eq!(
        fake.calls_to("log_progress")[0],
        json!({"task_id": 77, "text": "did the thing"})
    );
    assert_eq!(
        fake.calls_to("append_note")[0],
        json!({"id": 77, "text": "remember this"})
    );
    assert_eq!(
        fake.calls_to("add_subtask")[0],
        json!({"task_id": 77, "title": "Write tests"})
    );
    assert_eq!(
        fake.calls_to("set_subtask")[0],
        json!({"id": 12, "done": true})
    );
    assert_eq!(fake.calls_to("complete_task")[0], json!({"id": 77}));

    // No claim and no --id: an error that names the way out.
    let out = tildone(&fake, &["log", "x"])
        .session("sess-other")
        .run()
        .await;
    assert_eq!(out.code, 1);
    assert!(
        out.stderr.contains("error: this session holds no card")
            && out.stderr.contains("claim <ref>"),
        "{}",
        out.stderr
    );
    assert_eq!(fake.calls_to("log_progress").len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn verbs_take_explicit_id() {
    let fake = Fake::start().await;
    // No session at all: --id is enough.
    assert_eq!(
        tildone(&fake, &["log", "--id", "TIL-5", "hi"])
            .run()
            .await
            .code,
        0
    );
    assert_eq!(tildone(&fake, &["done", "--id", "9"]).run().await.code, 0);
    assert_eq!(
        tildone(&fake, &["sub", "add", "--id", "TIL-5", "Step"])
            .run()
            .await
            .code,
        0
    );
    assert_eq!(
        fake.calls_to("log_progress")[0],
        json!({"task_id": "TIL-5", "text": "hi"})
    );
    assert_eq!(fake.calls_to("complete_task")[0], json!({"id": 9}));
    assert_eq!(
        fake.calls_to("add_subtask")[0],
        json!({"task_id": "TIL-5", "title": "Step"})
    );
}

// ---- new, next, wait ---------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn new_follow_up_prints_matches() {
    let fake = Fake::start().await;
    fake.reply_json("list_tasks", json!({"count": 1, "tasks": [{"id": 3, "ref": "TIL-3", "status": "todo", "title": "Fix the thing"}]}));
    let out = tildone(
        &fake,
        &["new", "Fix the thing", "--follow-up", "--project", "p"],
    )
    .run()
    .await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(
        out.stdout
            .contains("matches[1]{ref,status,title}:\n  TIL-3,todo,Fix the thing"),
        "{}",
        out.stdout
    );
    assert!(out.stdout.contains("--force"));
    // The re-run suggestion survives a paste into a shell: single-quoted, no expansion.
    let out = tildone(
        &fake,
        &["new", "It's $HOME `x`", "--follow-up", "--project", "p"],
    )
    .run()
    .await;
    assert!(
        out.stdout
            .contains("tildone-axi new 'It'\\''s $HOME `x`' --follow-up --force --project 'p'"),
        "{}",
        out.stdout
    );
    assert_eq!(
        fake.calls_to("list_tasks")[0],
        json!({"project": "p", "include_done": true, "search": "Fix the thing"})
    );
    no_calls(&fake, "create_task");
}

#[tokio::test(flavor = "multi_thread")]
async fn new_follow_up_force_creates() {
    let fake = Fake::start().await;
    fake.claim(
        "sess-1",
        json!({"task_id": 77, "ref": "TIL-77", "title": "T", "status": "doing"}),
    );
    fake.reply_json(
        "create_task",
        json!({"id": 80, "ref": "TIL-80", "status": "todo", "title": "Fix the thing"}),
    );
    let out = tildone(
        &fake,
        &[
            "new",
            "Fix the thing",
            "--follow-up",
            "--force",
            "--project",
            "p",
        ],
    )
    .session("sess-1")
    .run()
    .await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        fake.calls_to("create_task")[0],
        json!({"title": "Fix the thing", "project": "p", "tags": ["follow-up"], "from_task": 77})
    );
    no_calls(&fake, "list_tasks");
    // No match and no --force also creates.
    fake.reply_json("list_tasks", json!({"count": 0, "tasks": []}));
    tildone(&fake, &["new", "Another", "--follow-up", "--project", "p"])
        .session("sess-1")
        .run()
        .await;
    assert_eq!(fake.calls_to("create_task").len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn new_passes_tags_owner_from_task() {
    let fake = Fake::start().await;
    fake.claim(
        "sess-1",
        json!({"task_id": 77, "ref": "TIL-77", "title": "T", "status": "doing"}),
    );
    fake.reply_json(
        "create_task",
        json!({"id": 81, "ref": "TIL-81", "status": "todo", "title": "Ask"}),
    );
    // Spaces around a name are trimmed and an empty name is dropped.
    let base = [
        "new",
        "Ask",
        "--project",
        "p",
        "--tags",
        "a, b,",
        "--owner",
        "human",
    ];
    tildone(&fake, &base).session("sess-1").run().await;
    // With --follow-up the tag joins --tags, and --from-task wins over the claimed card.
    let follow = [
        &base[..],
        &["--follow-up", "--force", "--from-task", "TIL-3"],
    ]
    .concat();
    tildone(&fake, &follow).session("sess-1").run().await;
    let calls = fake.calls_to("create_task");
    assert_eq!(
        calls[0],
        json!({"title": "Ask", "project": "p", "tags": ["a", "b"], "owner": "human"})
    );
    assert_eq!(
        calls[1],
        json!({"title": "Ask", "project": "p", "tags": ["a", "b", "follow-up"], "owner": "human", "from_task": "TIL-3"})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn next_uses_default_project() {
    let fake = Fake::start().await;
    fake.reply_json(
        "next_task",
        json!({"ref": "TIL-8", "title": "Do it", "status": "todo"}),
    );
    let dir = repo("next_default", "nxt");
    let out = tildone(&fake, &["next"]).cwd(&dir).run().await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(
        out.stdout.contains("ref: TIL-8") && out.stdout.contains("help: tildone-axi claim TIL-8"),
        "{}",
        out.stdout
    );
    assert_eq!(fake.calls_to("next_task")[0], json!({"project": "nxt"}));
}

#[tokio::test(flavor = "multi_thread")]
async fn wait_passes_since() {
    let fake = Fake::start().await;
    fake.reply_json("list_changes", json!({"cursor": 9, "changes": []}));
    let out = tildone(&fake, &["wait", "--since", "5", "--ms", "1500"])
        .run()
        .await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout.trim(), r#"{"cursor":9,"changes":[]}"#);
    assert_eq!(
        fake.calls_to("list_changes")[0],
        json!({"since": 5, "wait_ms": 1500})
    );
}

// ---- call --------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn call_flags_from_schema() {
    let fake = Fake::start().await;
    let out = tildone(
        &fake,
        &[
            "call",
            "update_task",
            "--id",
            "TIL-3",
            "--priority",
            "2",
            "--tags",
            "a,b",
            "--tags",
            "c",
            "--title",
            "two words",
            "--status=done",
        ],
    )
    .run()
    .await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        fake.calls_to("update_task")[0],
        json!({"id": "TIL-3", "priority": 2, "tags": ["a", "b", "c"], "title": "two words", "status": "done"})
    );
    // A numeric TaskRef is a number; booleans take --k and --no-k.
    tildone(&fake, &["call", "update_task", "--id", "42"])
        .run()
        .await;
    tildone(&fake, &["call", "list_tasks", "--include-done"])
        .run()
        .await;
    tildone(&fake, &["call", "list_tasks", "--no-include-done"])
        .run()
        .await;
    assert_eq!(fake.calls_to("update_task")[1], json!({"id": 42}));
    assert_eq!(
        fake.calls_to("list_tasks")[0],
        json!({"include_done": true})
    );
    assert_eq!(
        fake.calls_to("list_tasks")[1],
        json!({"include_done": false})
    );
    // A bad value stops before the hub is asked.
    let bad = tildone(
        &fake,
        &["call", "update_task", "--id", "1", "--priority", "high"],
    )
    .run()
    .await;
    assert_eq!(bad.code, 1);
    assert!(
        bad.stderr.contains("error: --priority needs an integer") && bad.stderr.contains("help: "),
        "{}",
        bad.stderr
    );
    assert_eq!(fake.calls_to("update_task").len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn call_json_and_stdin() {
    let fake = Fake::start().await;
    let out = tildone(
        &fake,
        &[
            "call",
            "update_task",
            "--json",
            r#"{"id":"TIL-1","options":{"deep":[1,2]}}"#,
            "--priority",
            "3",
        ],
    )
    .run()
    .await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        fake.calls_to("update_task")[0],
        json!({"id": "TIL-1", "options": {"deep": [1, 2]}, "priority": 3})
    );
    // `--json -` reads stdin; explicit flags still win over it.
    let out = tildone(
        &fake,
        &["call", "update_task", "--json", "-", "--status", "doing"],
    )
    .stdin(r#"{"id": 7, "status": "todo", "options": {"a": true}}"#)
    .run()
    .await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        fake.calls_to("update_task")[1],
        json!({"id": 7, "status": "doing", "options": {"a": true}})
    );
    // A nested property has no flag of its own.
    let out = tildone(
        &fake,
        &["call", "update_task", "--id", "1", "--options", "x"],
    )
    .run()
    .await;
    assert_eq!(out.code, 1);
    assert!(out.stderr.contains("--json"), "{}", out.stderr);
}

#[tokio::test(flavor = "multi_thread")]
async fn call_hyphen_alias() {
    let fake = Fake::start().await;
    fake.reply_json(
        "create_task",
        json!({"id": 1, "ref": "TIL-1", "status": "todo", "title": "x"}),
    );
    let out = tildone(
        &fake,
        &[
            "call",
            "create-task",
            "--title",
            "x",
            "--from-task",
            "TIL-2",
        ],
    )
    .run()
    .await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        fake.calls_to("create_task")[0],
        json!({"title": "x", "from_task": "TIL-2"})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn call_unknown_tool() {
    let fake = Fake::start().await;
    let out = tildone(&fake, &["call", "nope"]).run().await;
    assert_eq!(out.code, 1);
    assert!(
        out.stderr.starts_with("error: unknown tool `nope`"),
        "{}",
        out.stderr
    );
    assert!(
        out.stderr.contains("help: tildone-axi help"),
        "{}",
        out.stderr
    );
}

// ---- help, errors, receipts --------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn help_includes_instructions() {
    let fake = Fake::start().await;
    let out = tildone(&fake, &["help"]).run().await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.contains(INSTRUCTIONS), "{}", out.stdout);
    assert!(
        out.stdout.contains("tools[17]{name,about}:"),
        "{}",
        out.stdout
    );
    assert!(
        out.stdout.contains("  list_tasks,List tasks"),
        "{}",
        out.stdout
    );
    assert!(
        out.stdout.contains("claim <ref>"),
        "the command list is part of help"
    );
    let long = "  clients <id|host> <action> [args...]\n";
    assert!(out.stdout.contains(long), "{}", out.stdout);
    assert!(
        out.stdout
            .contains(&format!("{long}{}run status|restart", " ".repeat(34))),
        "a long form puts its description 34 columns in"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn tool_error_exit_1() {
    let fake = Fake::start().await;
    fake.fail("get_task", "No task TIL-999.");
    let out = tildone(&fake, &["show", "TIL-999"]).run().await;
    assert_eq!(out.code, 1);
    assert!(out.stdout.is_empty());
    assert!(
        out.stderr.starts_with("error: No task TIL-999.\nhelp: "),
        "{}",
        out.stderr
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn write_prints_receipt() {
    let fake = Fake::start().await;
    let receipt = r#"{"id":1466,"ref":"TIL-231","status":"doing","title":"Plan, then build"}"#;
    fake.reply("update_task", receipt);
    let out = tildone(&fake, &["claim", "TIL-231"])
        .session("sess-1")
        .run()
        .await;
    assert_eq!(out.stdout, format!("{receipt}\n"));

    // Tools that echo the input back must not reach the output: every write verb
    // prints one short line.
    let long = "ECHOED ".repeat(200);
    fake.reply_json("log_progress", json!({"task_id": 77, "logged": long}));
    fake.reply_json("append_note", json!({"id": 77, "notes": long}));
    fake.reply_json("add_subtask", json!({"id": 5, "title": long}));
    fake.reply_json(
        "complete_task",
        json!({"id": 77, "ref": "TIL-77", "status": "done", "title": long}),
    );
    fake.reply_json(
        "create_task",
        json!({"id": 80, "ref": "TIL-80", "status": "todo", "title": long, "notes": long}),
    );
    let cases: [(&[&str], &str); 7] = [
        (&["log", "--id", "TIL-77", "hello"], "logged on TIL-77"),
        (&["note", "--id", "TIL-77", "hello"], "noted on TIL-77"),
        (
            &["sub", "add", "--id", "TIL-77", "Step"],
            "subtask added on TIL-77",
        ),
        (&["sub", "done", "5"], "subtask 5 done"),
        (&["done", "--id", "TIL-77"], "done TIL-77"),
        (&["new", "A task", "--project", "p"], ""),
        (&["claim", "TIL-77"], ""),
    ];
    for (args, want) in cases {
        let out = tildone(&fake, args).session("sess-1").run().await;
        assert_eq!(out.code, 0, "{args:?}: {}", out.stderr);
        assert_eq!(out.stdout.lines().count(), 1, "{args:?}: {}", out.stdout);
        assert!(out.stdout.len() < 200, "{args:?}: {}", out.stdout);
        if !want.is_empty() {
            assert_eq!(out.stdout.trim_end(), want, "{args:?}");
        }
    }
    // A claimed card is named by its ref.
    fake.claim(
        "sess-2",
        json!({"task_id": 77, "ref": "TIL-77", "title": "T", "status": "doing"}),
    );
    let out = tildone(&fake, &["log", "hello"])
        .session("sess-2")
        .run()
        .await;
    assert_eq!(out.stdout.trim_end(), "logged on TIL-77");
}

#[tokio::test(flavor = "multi_thread")]
async fn wait_without_since_parks_from_the_current_cursor() {
    let fake = Fake::start().await;
    fake.reply_json("list_changes", json!({"cursor": 9, "changes": []}));
    let out = tildone(&fake, &["wait", "--ms", "1500"]).run().await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    // The hub only parks when it gets a cursor, so the baseline comes first.
    assert_eq!(
        fake.calls_to("list_changes"),
        vec![json!({}), json!({"since": 9, "wait_ms": 1500})]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn usage_error_has_error_and_help_lines() {
    let fake = Fake::start().await;
    let out = tildone(&fake, &["show"]).run().await;
    assert_eq!(out.code, 1);
    assert!(out.stdout.is_empty());
    assert!(
        out.stderr
            .starts_with("error: the following required arguments were not provided"),
        "{}",
        out.stderr
    );
    assert!(
        out.stderr
            .trim_end()
            .ends_with("help: tildone-axi show --help"),
        "{}",
        out.stderr
    );
    assert!(
        !out.stderr.contains("For more information"),
        "{}",
        out.stderr
    );
}

// ---- settings ------------------------------------------------------------------

fn config_dir(test: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("tildone-axi-{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_lists_every_key() {
    let fake = Fake::start().await;
    fake.reply_json(
        "get_settings",
        json!({"theme": "dark", "default_project_id": null, "agent_server": true, "ai_model": "", "board_hub_token": "s3cret", "other_token": ""}),
    );
    let out = tildone(&fake, &["settings"]).run().await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        out.stdout.trim_end(),
        "theme: dark\ndefault_project_id: none\nagent_server: true\nai_model: \"\"\nboard_hub_token: (set)\nother_token: (empty)"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_set_sends_each_type() {
    let fake = Fake::start().await;
    let cases = [
        ("theme", "dark", json!("dark"), "theme: dark"),
        ("agent_server", "on", json!(true), "agent_server: true"),
        ("agent_server", "FALSE", json!(false), "agent_server: false"),
        ("default_project_id", "7", json!(7), "default_project_id: 7"),
        (
            "default_project_id",
            "none",
            json!(0),
            "default_project_id: none",
        ),
        ("ai_model", "gpt 4", json!("gpt 4"), "ai_model: gpt 4"),
        // The token is sent but never printed.
        (
            "board_hub_token",
            "s3cret",
            json!("s3cret"),
            "board_hub_token: (set)",
        ),
    ];
    for (key, raw, sent, shown) in cases {
        let before = fake.calls_to("update_settings").len();
        // The fake echoes what the hub would: the whole settings with the key changed.
        let echoed = if key == "default_project_id" && sent == json!(0) {
            Value::Null
        } else {
            sent.clone()
        };
        fake.reply_json(
            "update_settings",
            json!({"settings": {key: echoed}, "changed": [key]}),
        );
        let out = tildone(&fake, &["settings", "set", key, raw]).run().await;
        assert_eq!(out.code, 0, "{key} {raw}: {}", out.stderr);
        assert_eq!(out.stdout.trim_end(), shown);
        let calls = fake.calls_to("update_settings");
        assert_eq!(calls.len(), before + 1);
        assert_eq!(calls.last().unwrap(), &json!({key: sent}));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_set_rejects_bad_input_without_a_call() {
    let fake = Fake::start().await;
    for (args, wants) in [
        (
            vec!["settings", "set", "colour", "red"],
            "known: theme, week_start",
        ),
        (
            vec!["settings", "set", "theme", "neon"],
            "theme must be one of: auto, light, dark",
        ),
        (
            vec!["settings", "set", "agent_server", "maybe"],
            "true or false",
        ),
        (
            vec!["settings", "set", "default_project_id", "0"],
            "or none to clear it",
        ),
        (
            vec!["settings", "engine", "install", "huge"],
            "small, default, better",
        ),
        (vec!["settings", "engine", "delete"], "needs a file name"),
    ] {
        let out = tildone(&fake, &args).run().await;
        assert_eq!(out.code, 1, "{args:?}: {}", out.stderr);
        assert!(out.stderr.starts_with("error: "), "{}", out.stderr);
        assert!(out.stderr.contains(wants), "{args:?}: {}", out.stderr);
    }
    assert!(fake.calls().is_empty(), "{:?}", fake.calls());
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_hook_and_engine_route_to_their_tools() {
    let fake = Fake::start().await;
    fake.reply_json("claude_hook", json!({"connected": true}));
    fake.reply_json("engine", json!({"state": "running"}));
    let out = tildone(&fake, &["settings", "hook", "connect"]).run().await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.contains("\"connected\":true"), "{}", out.stdout);
    for args in [
        vec!["settings", "engine", "status"],
        vec!["settings", "engine", "install", "small"],
        vec!["settings", "engine", "start"],
        vec!["settings", "engine", "delete", "m.gguf"],
    ] {
        let out = tildone(&fake, &args).run().await;
        assert_eq!(out.code, 0, "{args:?}: {}", out.stderr);
    }
    assert_eq!(
        fake.calls_to("claude_hook"),
        vec![json!({"action": "connect"})]
    );
    assert_eq!(
        fake.calls_to("engine"),
        vec![
            json!({"action": "status"}),
            json!({"action": "install", "model": "small"}),
            json!({"action": "start"}),
            json!({"action": "delete", "file": "m.gguf"}),
        ]
    );
    let bad = tildone(&fake, &["settings", "hook", "wipe"]).run().await;
    assert_eq!(bad.code, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_set_offline_writes_the_file() {
    let fake = Fake::start().await;
    let dir = config_dir("offline");
    std::fs::write(
        dir.join("settings.json"),
        r#"{"theme":"light","future_key":{"a":1}}"#,
    )
    .unwrap();
    // Port 1 refuses connections; a local URL may fall back to the file.
    let out = tildone(&fake, &["settings", "set", "agent_server", "true"])
        .url(Some("http://localhost:1/mcp"))
        .env("TILDONE_CONFIG_DIR", dir.to_str().unwrap())
        .run()
        .await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.contains("agent_server: true"), "{}", out.stdout);
    assert!(out.stdout.contains("within 2 s"), "{}", out.stdout);
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
    assert_eq!(
        file,
        json!({"theme": "light", "future_key": {"a": 1}, "agent_server": true})
    );
    let left: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(left, vec!["settings.json".to_string()]);

    // A missing file (and folder) starts from {}; `none` is stored as null.
    let fresh = dir.join("nested");
    let out = tildone(&fake, &["settings", "set", "default_project_id", "none"])
        .url(Some("http://127.0.0.1:1/mcp"))
        .env("TILDONE_CONFIG_DIR", fresh.to_str().unwrap())
        .run()
        .await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(fresh.join("settings.json")).unwrap())
            .unwrap();
    assert_eq!(file, json!({"default_project_id": null}));

    // Written to the file, never printed.
    let out = tildone(&fake, &["settings", "set", "board_hub_token", "s3cret"])
        .url(Some("http://127.0.0.1:1/mcp"))
        .env("TILDONE_CONFIG_DIR", fresh.to_str().unwrap())
        .run()
        .await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(!out.stdout.contains("s3cret"), "{}", out.stdout);
    assert!(
        out.stdout.contains("board_hub_token: (set)"),
        "{}",
        out.stdout
    );
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(fresh.join("settings.json")).unwrap())
            .unwrap();
    assert_eq!(file["board_hub_token"], json!("s3cret"));
    assert!(fake.calls_to("update_settings").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_read_offline_fills_defaults() {
    let fake = Fake::start().await;
    let dir = config_dir("offline-read");
    std::fs::write(dir.join("settings.json"), r#"{"theme":"dark"}"#).unwrap();
    let out = tildone(&fake, &["settings"])
        .url(Some("http://127.0.0.1:1/mcp"))
        .env("TILDONE_CONFIG_DIR", dir.to_str().unwrap())
        .run()
        .await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(
        out.stdout.starts_with("theme: dark\nweek_start: monday\n"),
        "{}",
        out.stdout
    );
    assert!(out.stdout.contains("agent_notify: true"), "{}", out.stdout);
    assert!(
        out.stdout.contains("default_project_id: none"),
        "{}",
        out.stdout
    );
    assert!(out.stdout.contains("read from"), "{}", out.stdout);
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_remote_unreachable_stays_an_error() {
    let fake = Fake::start().await;
    let dir = config_dir("remote");
    // A non-local host that cannot be resolved: still an error, and no file.
    let out = tildone(&fake, &["settings", "set", "theme", "dark"])
        .url(Some("http://hub.invalid:1/mcp"))
        .env("TILDONE_CONFIG_DIR", dir.to_str().unwrap())
        .run()
        .await;
    assert_eq!(out.code, 2, "{}", out.stderr);
    assert!(
        out.stderr.contains("cannot reach Tildone"),
        "{}",
        out.stderr
    );
    assert!(!dir.join("settings.json").exists());
    let read = tildone(&fake, &["settings"])
        .url(Some("http://hub.invalid:1/mcp"))
        .env("TILDONE_CONFIG_DIR", dir.to_str().unwrap())
        .run()
        .await;
    assert_eq!(read.code, 2, "{}", read.stderr);
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_actions_offline_need_the_running_app() {
    let fake = Fake::start().await;
    for args in [
        vec!["settings", "hook", "status"],
        vec!["settings", "engine", "stop"],
    ] {
        let out = tildone(&fake, &args)
            .url(Some("http://127.0.0.1:1/mcp"))
            .run()
            .await;
        assert_eq!(out.code, 2, "{args:?}: {}", out.stderr);
        assert!(
            out.stderr.contains("needs the running Tildone app"),
            "{}",
            out.stderr
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_action_timeout_says_it_is_still_running() {
    let fake = Fake::start().await;
    fake.delay("engine", 3000);
    let out = tildone(&fake, &["settings", "engine", "install"])
        .env("TILDONE_ACTION_TIMEOUT_MS", "300")
        .run()
        .await;
    assert_eq!(out.code, 1, "{}", out.stderr);
    assert!(
        out.stderr.contains("still running in Tildone"),
        "{}",
        out.stderr
    );
    assert!(
        out.stderr.contains("tildone-axi settings engine status"),
        "{}",
        out.stderr
    );
    assert!(!out.stderr.contains("cannot reach"), "{}", out.stderr);
}

// ---- clients -----------------------------------------------------------------

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn client(id: &str, host: &str, connected: bool, last_seen: i64, report: Value) -> Value {
    json!({
        "hello": {"id": id, "host": host, "os": "linux", "version": "0.9.0", "commit": "abc1234", "schema": 3,
                  "exe": "/usr/bin/tildone", "installed": true, "source_dir": "/src/tildone", "started_at": 1_700_000_000},
        "report": report,
        "connected": connected,
        "connected_since": 1_700_000_100,
        "last_seen": last_seen,
    })
}

fn report(hub_errors: Value, window_errors: Value) -> Value {
    json!({"id": "x", "hub_state": "connected", "hub_message": "", "hub_errors": hub_errors,
           "window_errors": window_errors, "settings": {"board_hub_url": "http://hub:11502", "theme": "dark"}, "hook": {"connected": true}})
}

#[tokio::test(flavor = "multi_thread")]
async fn clients_table_marks_connected_and_last_seen() {
    let fake = Fake::start().await;
    let errs = json!([{"at": 1_700_000_500, "message": "boom"}]);
    fake.reply_json(
        "list_clients",
        json!([
            client(
                "aaaaaaaa-1111",
                "laptop",
                true,
                unix_now(),
                report(errs.clone(), errs)
            ),
            client(
                "bbbbbbbb-2222",
                "desk",
                false,
                unix_now() - 7200,
                Value::Null
            ),
        ]),
    );
    let out = tildone(&fake, &["clients"]).run().await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(
        out.stdout.contains(
            "clients[2]{id,host,os,commit,link,hub,errors}:\n  aaaaaaaa,laptop,linux,abc1234,connected,connected,2\n  bbbbbbbb,desk,linux,abc1234,seen 2h ago,unreported,\"\""
        ),
        "{}",
        out.stdout
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn clients_empty_says_none_connected() {
    let fake = Fake::start().await;
    fake.reply_json("list_clients", json!([]));
    let out = tildone(&fake, &["clients"]).run().await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(
        out.stdout
            .contains("no client apps are connected to this hub"),
        "{}",
        out.stdout
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn clients_detail_by_host_or_id_prefix_lists_errors_newest_first() {
    let fake = Fake::start().await;
    let hub_errors = json!([{"at": 1_700_000_200, "message": "older hub"}]);
    let window_errors = json!([{"at": 1_700_000_900, "message": "newest window"}]);
    fake.reply_json(
        "list_clients",
        json!([
            client(
                "aaaaaaaa-1111",
                "laptop",
                true,
                unix_now(),
                report(hub_errors, window_errors)
            ),
            client("bbbbbbbb-2222", "desk", true, unix_now(), Value::Null),
        ]),
    );
    for q in ["laptop", "aaaa"] {
        let out = tildone(&fake, &["clients", q]).run().await;
        assert_eq!(out.code, 0, "{}", out.stderr);
        assert!(out.stdout.contains("id: aaaaaaaa-1111"), "{}", out.stdout);
        assert!(out.stdout.contains("theme: dark"), "{}", out.stdout);
        let newest = out.stdout.find("newest window").expect("window error");
        let older = out.stdout.find("older hub").expect("hub error");
        assert!(newest < older, "{}", out.stdout);
        assert!(
            out.stdout.contains("2023-11-14T22:28:20Z"),
            "{}",
            out.stdout
        );
    }
    let none = tildone(&fake, &["clients", "nope"]).run().await;
    assert_eq!(none.code, 1);
    assert!(
        none.stderr
            .starts_with("error: no client matches `nope`\nhelp: "),
        "{}",
        none.stderr
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn clients_ambiguous_target_exits_1_naming_matches() {
    let fake = Fake::start().await;
    fake.reply_json(
        "list_clients",
        json!([
            client("aaaaaaaa-1111", "twin", true, unix_now(), Value::Null),
            client("bbbbbbbb-2222", "twin", true, unix_now(), Value::Null),
        ]),
    );
    let out = tildone(&fake, &["clients", "twin", "restart"]).run().await;
    assert_eq!(out.code, 1);
    assert!(out.stdout.is_empty());
    assert!(
        out.stderr.contains("aaaaaaaa-1111")
            && out.stderr.contains("bbbbbbbb-2222")
            && out.stderr.contains("\nhelp: "),
        "{}",
        out.stderr
    );
    no_calls(&fake, "client_command");
}

#[tokio::test(flavor = "multi_thread")]
async fn clients_action_sends_resolved_id_and_prints_output() {
    let fake = Fake::start().await;
    fake.reply_json(
        "list_clients",
        json!([client(
            "aaaaaaaa-1111",
            "laptop",
            true,
            unix_now(),
            Value::Null
        )]),
    );
    fake.reply_json(
        "client_command",
        json!({"id": "c1", "client": "aaaaaaaa-1111", "ok": true, "output": "restarting"}),
    );
    let out = tildone(&fake, &["clients", "laptop", "settings-set", "theme", "-1"])
        .run()
        .await;
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout.trim_end(), "restarting");
    assert_eq!(
        fake.calls_to("client_command"),
        vec![json!({"client": "aaaaaaaa-1111", "action": "settings-set", "args": ["theme", "-1"]})]
    );

    fake.fail(
        "client_command",
        "client aaaaaaaa-1111 did not answer in 30s",
    );
    let bad = tildone(&fake, &["clients", "laptop", "status"]).run().await;
    assert_eq!(bad.code, 1);
    assert!(
        bad.stderr
            .starts_with("error: client aaaaaaaa-1111 did not answer in 30s\nhelp: "),
        "{}",
        bad.stderr
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn clients_unknown_action_is_refused_locally() {
    let fake = Fake::start().await;
    let out = tildone(&fake, &["clients", "laptop", "reboot"]).run().await;
    assert_eq!(out.code, 1);
    assert!(
        out.stderr.starts_with("error: unknown client action `reboot`\nhelp: actions: status|restart|settings|settings-set|hook|engine|update|log"),
        "{}",
        out.stderr
    );
    no_calls(&fake, "list_clients");
    no_calls(&fake, "client_command");
}
