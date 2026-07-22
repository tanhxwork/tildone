import { browser, $, $$, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, appendFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { E2E_DB as DB, E2E_ATTACHMENTS as ATTACHMENTS } from "./support/dataDir.js";

/* The board secretary end to end (spec 2026-07-21-local-ai-board-secretary),
 * with the engine stubbed: a Node HTTP server plays the OpenAI-shaped local
 * server, the spec seeds a claim + transcript exactly where the Rust loop
 * looks, and the assertions read the same DB the board renders. No real
 * model anywhere — the engine's judgment is canned, the plumbing is real.
 *
 * This is also the TIL-153 fallback guard: the e2e app has no built-in engine
 * installed, so the secretary MUST follow the external server (this stub), not
 * pin to the engine. If the builtin pin ever fired here it would route ticks
 * at a dead 127.0.0.1:<engine port>, the stub would never be called, and the
 * tick/log assertions below would time out. So these assertions passing IS the
 * proof that the pin did not break the engine-less path. */

// Same seeding channel as notesEmbed.spec.ts: the sqlite3 CLI is a second
// connection to the same file, which is exactly what an external writer is.
function sql(statement: string): string {
  return execFileSync("sqlite3", ["-cmd", ".timeout 5000", DB, statement], {
    encoding: "utf8",
  }).trim();
}

/** The transcript-slug rule from artifacts.rs: non-alphanumerics become '-'. */
function slugOf(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function assistantLine(blocks: string): string {
  return JSON.stringify({ type: "assistant", message: { content: JSON.parse(`[${blocks}]`) } });
}

async function until(check: () => boolean, label: string, ms = 20_000) {
  await browser.waitUntil(async () => check(), {
    timeout: ms,
    interval: 500,
    timeoutMsg: `timed out waiting for ${label}`,
  });
}

const SESSION = "e2ee2ee2-aaaa-4bbb-8ccc-000000000001";
const FAKE_REPO = join(homedir(), ".tildone-e2e-secretary", "repo");
const SCRATCH = "/private/tmp/tildone-e2e-secretary";
const TRANSCRIPT_DIR = join(homedir(), ".claude", "projects", slugOf(FAKE_REPO));
const TRANSCRIPT = join(TRANSCRIPT_DIR, `${SESSION}.jsonl`);

describe("board secretary", () => {
  let stub: Server;
  let stubPort = 0;
  let taskId = "";

  before(async () => {
    // The canned engine: /v1/models makes it detectable + "ready"; the chat
    // endpoint always ticks item 1 and logs one line.
    stub = createServer((req, res) => {
      if (req.url?.includes("/v1/models")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
        return;
      }
      if (req.url?.includes("/v1/chat/completions")) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              { message: { content: "tick 1\nlog tests written (RED, as expected)" } },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const addr = stub.address();
    stubPort = typeof addr === "object" && addr ? addr.port : 0;

    mkdirSync(join(FAKE_REPO, "docs", "specs"), { recursive: true });
    mkdirSync(SCRATCH, { recursive: true });
    mkdirSync(TRANSCRIPT_DIR, { recursive: true });
    // The transcript exists BEFORE the secretary first sees the session, with
    // history in it — first sight must start at the end (nothing replayed).
    writeFileSync(
      TRANSCRIPT,
      assistantLine(`{"type":"text","text":"old history that must never be replayed"}`) + "\n",
    );
  });

  after(async () => {
    stub?.close();
    rmSync(join(homedir(), ".tildone-e2e-secretary"), { recursive: true, force: true });
    rmSync(SCRATCH, { recursive: true, force: true });
    rmSync(TRANSCRIPT_DIR, { recursive: true, force: true });
    // Hand the app back with AI off, so no later spec inherits a config
    // pointing at a stub server that no longer exists.
    const overlay = $(".modal-overlay");
    if (!(await overlay.isExisting())) {
      await $(".sidebar-footer button.nav-item").click();
    }
    const off = $(".ai-modes .ai-mode:first-child input");
    if (await off.isExisting()) {
      await off.click();
      await $(".modal-footer button.btn.primary").click();
    }
  });

  it("connects the AI store to the stub engine", async () => {
    await $("#root").waitForExist();
    // Sidebar footer's first item is AI Assistant.
    await $(".sidebar-footer button.nav-item").click();
    await $(".ai-modes").waitForExist();
    // "My own local AI" — the second mode radio.
    await $(".ai-modes .ai-mode:nth-child(2) input").click();
    const custom = $(".ai-custom input");
    await custom.waitForExist();
    await custom.setValue(`127.0.0.1:${stubPort}`);
    await $(".ai-custom button.btn").click();
    // Connected: the server row appears selected with the model picked, and
    // the secretary section (aiReady) shows its toggle checked by default.
    await $(".ai-server.selected").waitForExist();
    const toggle = $(".ai-secretary-enable input");
    await toggle.waitForExist();
    expect(await toggle.isSelected()).toBe(true);
    // TIL-154: chat runs on the external stub, yet the Board secretary lane
    // still owns the engine tier picker — reachable without switching chat to
    // "Built-in engine". No engine is installed here, so the tiers render
    // their Download affordance rather than Use/Stop.
    await $(".ai-secretary .ai-models").waitForExist();
    const tiers = await $$(".ai-secretary .ai-models .ai-model");
    expect(tiers.length).toBeGreaterThan(0);
    await $(".ai-secretary .ai-models .ai-model .ai-model-actions .btn").waitForExist();
    await $(".modal-footer button.btn.primary").click();
  });

  it("derives ticks, logs and evidence from an appended transcript", async () => {
    // Seed the card the way an agent would leave it: doing, claimed, with a
    // build step and a verify step.
    sql(
      "INSERT INTO tasks (title, status, position, created_at) VALUES ('Secretary e2e', 'doing', 0, '2026-01-01T00:00:00.000Z')",
    );
    taskId = sql("SELECT id FROM tasks WHERE title = 'Secretary e2e'");
    sql(`INSERT INTO subtasks (task_id, title, position) VALUES (${taskId}, 'write tests', 0)`);
    sql(
      `INSERT INTO subtasks (task_id, title, position) VALUES (${taskId}, 'verify: check it in the app', 1)`,
    );
    sql(
      `INSERT INTO agent_claims (session_id, task_id, cwd, branch, agent_name, claimed_at) ` +
        `VALUES ('${SESSION}', ${taskId}, '${FAKE_REPO}', 'main', 'claude-code', '2026-01-01T00:00:00.000Z')`,
    );

    // The secretary registers the session by writing its cursor row — at the
    // END of the existing file (history is never replayed).
    await until(
      () => sql(`SELECT COUNT(*) FROM secretary_offsets WHERE session_id = '${SESSION}'`) === "1",
      "the secretary to register the claimed session",
    );

    // Now the session "works": narration + a test run + two artifacts. The
    // scratch report's Write record lands in the transcript BEFORE the file
    // exists on disk — the real transcript order — so this also proves the
    // evidence retry (the first sighting is legitimately too early).
    const scratchReport = join(SCRATCH, "report.html");
    appendFileSync(
      TRANSCRIPT,
      [
        assistantLine(`{"type":"tool_use","name":"Bash","input":{"command":"cargo test"}}`),
        assistantLine(`{"type":"text","text":"tests are written and failing as expected"}`),
        assistantLine(
          `{"type":"tool_use","name":"Write","input":{"file_path":"${join(FAKE_REPO, "docs/specs/2026-01-01-e2e.md")}","content":"spec"}}`,
        ),
        assistantLine(
          `{"type":"tool_use","name":"Write","input":{"file_path":"${scratchReport}","content":"<h1>"}}`,
        ),
      ].join("\n") + "\n",
    );
    // The file appears a few seconds after its record was scanned.
    setTimeout(() => writeFileSync(scratchReport, "<h1>e2e evidence</h1>"), 4000);

    // Criterion 1: the build subtask ticks and the log line lands — with no
    // MCP call from any agent — attributed to tildone-ai.
    await until(
      () =>
        sql(`SELECT done FROM subtasks WHERE task_id = ${taskId} AND title = 'write tests'`) ===
        "1",
      "the secretary to tick the build subtask",
    );
    const actors = sql(
      `SELECT DISTINCT actor_kind || '/' || actor_name FROM task_activity WHERE task_id = ${taskId}`,
    );
    expect(actors).toBe("agent/tildone-ai");

    // Criterion 2: the verify step stays untouched, always.
    expect(
      sql(`SELECT done FROM subtasks WHERE task_id = ${taskId} AND title LIKE 'verify:%'`),
    ).toBe("0");

    // Criterion 6, doc half: the spec links at its repo path, kind file.
    await until(
      () =>
        sql(
          `SELECT COUNT(*) FROM task_links WHERE task_id = ${taskId} AND kind = 'file' AND url LIKE '%docs/specs/2026-01-01-e2e.md'`,
        ) === "1",
      "the doc evidence chip",
    );

    // Criterion 6, scratch half: the report is copied into the app's own
    // attachments store and the COPY is linked — it must survive the scratch
    // dir being deleted.
    await until(
      () =>
        sql(
          `SELECT COUNT(*) FROM task_links WHERE task_id = ${taskId} AND url LIKE '${ATTACHMENTS}%report.html'`,
        ) === "1",
      "the scratch-copy evidence chip",
    );
    const copied = sql(
      `SELECT url FROM task_links WHERE task_id = ${taskId} AND url LIKE '${ATTACHMENTS}%'`,
    );
    rmSync(SCRATCH, { recursive: true, force: true });
    expect(existsSync(copied)).toBe(true);

    // Criterion 5: no raw transcript text in the DB — the narration line the
    // model saw is not what got stored, and nothing stores the sentence from
    // the pre-existing history.
    expect(
      sql(`SELECT COUNT(*) FROM task_activity WHERE label LIKE '%never be replayed%'`),
    ).toBe("0");
  });

  it("shows the watching status in AI settings", async () => {
    await $(".sidebar-footer button.nav-item").click();
    const hint = $(".ai-secretary-status");
    await hint.waitForExist();
    await browser.waitUntil(
      async () => (await hint.getText()).includes("Watching"),
      { timeout: 15_000, timeoutMsg: "status row never showed Watching" },
    );
    await $(".modal-footer button.btn.primary").click();
  });
});
