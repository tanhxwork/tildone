import { browser, $, expect } from "@wdio/globals";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { E2E_CONFIG_DIR } from "./support/dataDir.js";
import { pasteImageInto } from "./support/imageActions.js";

// A Tildone can use another Tildone as its board (spec hub-client, TIL-233). Two
// app instances: a second process of this same e2e binary is the hub, with its own
// config and data dirs (XDG_*), its own agent port and its own WebDriver port, so
// nothing it does touches the board under test. The wdio app is the client.

const SHOTS = "./.test-artifacts/screenshots";
const TOKEN = "e2e-hub-token-0123456789abcdefghijklmnopqrstuv";
const SECOND = "Hub second task";

let hub: ChildProcess | null = null;
let hubUrl = "";
const hubDirs: string[] = [];

/** A port nothing listens on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** What a restarted hub reuses: its dirs (so its database) and its ports (so its URL). */
/** The real ref the offline-made task got on replay; the relaunch from the copy must show it. */
let replayedRef = "";

let hubRun: { root: string; agentPort: number; webdriverPort: number } | null = null;

/** Start the hub process (again, on the same dirs and ports, after stopHub) and wait until its MCP server answers. */
async function startHub() {
  const restart = hubRun !== null;
  if (!hubRun) {
    const root = mkdtempSync(join(tmpdir(), "tildone-hub-"));
    hubDirs.push(root);
    // The app dirs move with XDG_* on Linux; the folder name is the e2e identifier.
    const appConfig = join(root, "config", basename(E2E_CONFIG_DIR));
    mkdirSync(appConfig, { recursive: true });
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(
      join(appConfig, "settings.json"),
      JSON.stringify({ agent_server: true, _migrated: true }),
    );
    writeFileSync(join(appConfig, "hub-token"), TOKEN, { mode: 0o600 });
    hubRun = { root, agentPort: await freePort(), webdriverPort: await freePort() };
  }
  const { root, agentPort, webdriverPort } = hubRun;
  const config = join(root, "config");
  const data = join(root, "data");
  hubUrl = `http://127.0.0.1:${agentPort}`;
  mcpSession = ""; // the new process knows no session

  const binary = process.env.TAURI_E2E_BINARY ?? "./src-tauri/target-e2e/debug/tildone";
  mkdirSync("./.test-artifacts", { recursive: true });
  const log = openSync("./.test-artifacts/hub-process.log", restart ? "a" : "w");
  hub = spawn(binary, [], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      TILDONE_AGENT_PORT: String(agentPort),
      // The embedded WebDriver plugin binds this; the client's own port is in the
      // inherited environment and must not be reused.
      TAURI_WEBDRIVER_PORT: String(webdriverPort),
      TILDONE_E2E_WEBDRIVER_PORT: String(webdriverPort),
    },
    stdio: ["ignore", log, log],
  });
  // The PID, for whoever has to clean up after a killed run.
  writeFileSync("./.test-artifacts/hub.pid", String(hub.pid));

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (hub.exitCode !== null) throw new Error(`the hub process exited (${hub.exitCode})`);
    try {
      const res = await fetch(`${hubUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "hub-e2e", version: "1" } },
        }),
      });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error("the hub did not start listening within 60s");
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Stop the hub process and wait until it is gone, so the port refuses connections. */
async function stopHub() {
  const proc = hub!;
  if (proc.exitCode !== null) return;
  const gone = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  proc.kill("SIGTERM");
  const killer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
  await gone;
  clearTimeout(killer);
}

let mcpSession = "";
let rpcId = 1;
/** One JSON-RPC call to the hub's /mcp; the reply is plain JSON or one SSE `data:` event. */
async function rpc(method: string, params: unknown, notify = false) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (mcpSession) headers["mcp-session-id"] = mcpSession;
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (!notify) body.id = ++rpcId;
  const res = await fetch(`${hubUrl}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  mcpSession = res.headers.get("mcp-session-id") ?? mcpSession;
  const text = await res.text();
  if (notify) return null;
  const data = text.trim().startsWith("{")
    ? text
    : text.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5);
  return JSON.parse(data);
}

/** Call an MCP tool on the hub; resolves to its JSON result. */
async function hubTool(name: string, args: Record<string, unknown>) {
  if (!mcpSession) {
    await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "hub-e2e", version: "1" },
    });
    await rpc("notifications/initialized", {}, true);
  }
  const out = await rpc("tools/call", { name, arguments: args });
  if (out.error || out.result?.isError) throw new Error(`${name}: ${JSON.stringify(out)}`);
  return JSON.parse(out.result.content[0].text);
}

const hubCreateTask = (title: string) => hubTool("create_task", { title });

/** The hub's own database, over its /sql route with the known token. */
async function hubSelect<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await fetch(`${hubUrl}/sql`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ kind: "select", sql, params }),
  });
  if (!res.ok) throw new Error(`/sql answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as T[];
}

const hubTitles = async (title: string) =>
  (await hubSelect<{ title: string }>("SELECT title FROM tasks WHERE title = $1", [title])).map(
    (r) => r.title,
  );

async function tauriInvoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return browser.executeAsync(
    (c: string, a: Record<string, unknown>, done: (v: unknown) => void) => {
      const tauri = (window as never as { __TAURI__: { core: { invoke: Function } } }).__TAURI__;
      tauri.core.invoke(c, a).then(done, (e: unknown) => done(`ERR ${e}`));
    },
    cmd,
    args,
  );
}

/** Write settings and wait for the window the change reloads to come back with the board. */
async function setSettingsAndReload(patch: Record<string, unknown>) {
  await browser.execute(() => {
    (window as unknown as Record<string, unknown>).__hubReload = true;
  });
  const result = await tauriInvoke("settings_set", { patch });
  expect(String(result)).not.toMatch(/^ERR/);
  await browser.waitUntil(
    async () => {
      try {
        return (
          (await browser.execute(
            () =>
              !(window as unknown as Record<string, unknown>).__hubReload &&
              !!document.querySelector(".app, .app-loading-error"),
          )) === true
        );
      } catch {
        return false; // the navigation is in flight
      }
    },
    { timeout: 20_000, timeoutMsg: "the window did not reload after the settings change" },
  );
}

/** Reload lands on Goals; the cases below look at All tasks. */
async function openAllTasks() {
  await $('[data-nav="all"]').waitForExist({ timeout: 15_000 });
  await $('[data-nav="all"]').click();
}

describe("hub: another Tildone as the board", () => {
  before(async () => {
    await $("#root").waitForExist();
    await startHub();
  });

  after(async () => {
    // Back to this machine's board whatever happened, so the next spec starts local.
    try {
      const now = (await tauriInvoke("settings_get")) as { board_hub_url: string };
      const patch = { board_hub_url: "", board_hub_token: "", agent_server: false };
      if (now.board_hub_url) await setSettingsAndReload(patch);
      else await tauriInvoke("settings_set", { patch });
    } catch {
      // the spec already failed on something else
    }
    if (hub?.pid) {
      try {
        process.kill(hub.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    for (const dir of hubDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("client creates a task on the hub", async () => {
    // Agent access is on in the patch to prove the client still runs no server.
    await setSettingsAndReload({
      board_hub_url: hubUrl,
      board_hub_token: TOKEN,
      agent_server: true,
    });
    await openAllTasks();

    // Settings → Board shows the hub and that it answers.
    await $(".nav-item*=Settings").click();
    const status = $('[data-testid="hub-status"]');
    await status.waitForExist({ timeout: 10_000 });
    await expect(status).toHaveText("Connected");
    await $('input[aria-label="Board hub URL"]').scrollIntoView();
    mkdirSync(SHOTS, { recursive: true });
    await browser.saveScreenshot(`${SHOTS}/settings-board-hub.png`);

    // Client mode starts no local MCP server, and hosts no sessions.
    expect(await tauriInvoke("agent_server_endpoint")).toBeNull();
    await expect($(".sidebar-section*=Sessions")).not.toBeExisting();
    await $('button[aria-label="Close settings"]').click();

    const title = "Made in the client";
    await $(".quick-add input").setValue(title);
    await browser.keys("Enter");
    await $(`.task-row*=${title}`).waitForExist({ timeout: 10_000 });

    // The task is in the hub's database, not in this machine's.
    await browser.waitUntil(async () => (await hubTitles(title)).length === 1, {
      timeout: 10_000,
      timeoutMsg: "the hub never received the task",
    });
  });

  it("an image attached in the client is stored on the hub and renders", async () => {
    const title = "Client image task";
    await $(".quick-add input").setValue(title);
    await pasteImageInto(".quick-add input");
    await $(".qa-image-chip").waitForExist({ timeout: 10_000 });
    await browser.keys("Enter");
    await $(`.task-title*=${title}`).click();
    const thumb = $(".detail-image-thumb img");
    await thumb.waitForExist({ timeout: 15_000 });
    // naturalWidth > 0: the bytes came back from the hub and decoded.
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            (document.querySelector(".detail-image-thumb img") as HTMLImageElement | null)
              ?.naturalWidth ?? 0,
        )) > 0,
      { timeout: 10_000, timeoutMsg: "the attachment did not render from the hub" },
    );
    // The hub's row holds a path relative to the hub's app data, like a local attachment.
    const rows = await hubSelect<{ path: string }>(
      "SELECT path FROM task_images ORDER BY id DESC LIMIT 1",
    );
    expect(rows[0]?.path).toMatch(/^attachments\/\d+\//);
  });

  it("offers no session launcher on a task in client mode", async () => {
    // The editor from the case above is still open on a task.
    await $(".detail-card").waitForExist();
    await expect($(".detail-session")).not.toBeExisting();
    await browser.keys("Escape");
    await $(".detail-card").waitForExist({ reverse: true });
  });

  it("hub change appears in the client", async () => {
    await hubCreateTask(SECOND);
    // No reload, no click: the hub's change stream moves the board.
    await $(`.task-row*=${SECOND}`).waitForExist({
      timeout: 5_000,
      timeoutMsg: "the hub's task did not reach the client within 5s",
    });
    await browser.saveScreenshot(`${SHOTS}/client-live-update.png`);
  });

  it("a file chip in the review band says the file is on the hub", async () => {
    const title = "Client review task";
    const task = await hubTool("create_task", { title, status: "doing", tags: ["needs-review"] });
    await hubTool("add_link", { task_id: task.id, url: "/home/someone/evidence/shot.png", label: "Shot" });
    await $(`.task-row*=${title}`).waitForExist({ timeout: 5_000 });
    await $(`.task-title*=${title}`).click();
    await $(".review-band-links").$("button*=Shot").click();
    await expect($(".detail-link-error")).toHaveText("Shot is on the hub — open it there.");
    await browser.saveScreenshot(`${SHOTS}/client-review-file-chip.png`);
    await browser.keys("Escape");
    await $(".detail-card").waitForExist({ reverse: true });
  });

  it("queues while the hub is down, survives a restart, and replays when it is back", async () => {
    const title = "Made while the hub was down";
    // Something to switch off: a project (goal and delete controls), and a second tag to merge into.
    await hubTool("create_project", { name: "Offline Proj" });
    await hubTool("create_goal", { project: "Offline Proj", name: "Offline Goal" });
    await hubTool("create_task", {
      title: "Tagged on the hub",
      project: "Offline Proj",
      goal: "Offline Goal",
      tags: ["alpha"],
    });
    await $('button[aria-label="New goal in Offline Proj"]').waitForExist({ timeout: 10_000 });
    await stopHub();
    await $(".hub-banner*=Offline").waitForExist({
      timeout: 15_000,
      timeoutMsg: "the client never said it was offline",
    });

    // One create is one change waiting, not the activity line that rides along.
    await $(".quick-add input").setValue(title);
    await browser.keys("Enter");
    const row = $(`.task-row*=${title}`);
    await row.waitForExist({ timeout: 10_000 });
    expect(await row.$(".task-id").getText()).toMatch(/-\?$/);
    await $(".hub-banner*=1 change waiting").waitForExist({ timeout: 5_000 });
    expect(await $(".hub-banner").getText()).toMatch(/^Offline · last synced \d\d:\d\d · 1 change waiting$/);
    await browser.saveScreenshot(`${SHOTS}/offline-queued-one.png`);

    // A subtask and an edit on the task that has no real id yet.
    await $(`.task-title*=${title}`).click();
    await $(".detail-card").waitForExist();
    // Images need the hub: the tile is off, with the reason beside it.
    expect(await $(".detail-image-add").isEnabled()).toBe(false);
    await $(".detail-image-add").scrollIntoView();
    await browser.saveScreenshot(`${SHOTS}/offline-image-disabled.png`);
    await $('input[aria-label="Add subtask"]').setValue("Queued step");
    await browser.keys("Enter");
    await $(".detail-subtask-title*=Queued step").waitForExist({ timeout: 5_000 });
    const edited = `${title} (edited)`;
    await $('textarea[aria-label="Task title"]').setValue(edited);
    await browser.keys("Enter");
    await $(".hub-banner*=changes waiting").waitForExist({ timeout: 5_000 });
    expect(await $(".hub-banner").getText()).toMatch(/^Offline · last synced \d\d:\d\d · 3 changes waiting$/);
    await browser.keys("Escape");
    await $(".detail-card").waitForExist({ reverse: true });
    await $(`.task-row*=${edited}`).waitForExist();
    await browser.saveScreenshot(`${SHOTS}/offline-queued.png`);

    // What cannot be queued is switched off, dimmed, with the reason written beside it.
    const newProject = $('button[aria-label="New project"]');
    expect(await newProject.isEnabled()).toBe(false);
    expect(await newProject.getAttribute("title")).toBe("Not available offline");
    await browser.saveScreenshot(`${SHOTS}/offline-disabled.png`);

    // The project's own controls: its goal "+", and Delete in its dialog.
    const projectGoal = $('button[aria-label="New goal in Offline Proj"]');
    expect(await projectGoal.isEnabled()).toBe(false);
    expect(await projectGoal.getAttribute("title")).toBe("Not available offline");
    await browser.saveScreenshot(`${SHOTS}/offline-project-goal-disabled.png`);
    await $('button[aria-label="Edit Offline Proj"]').click();
    const del = $(".modal-footer").$("button=Delete");
    await del.waitForExist({ timeout: 5_000 });
    expect(await del.isEnabled()).toBe(false);
    expect(await del.getAttribute("title")).toBe("Not available offline");
    await browser.saveScreenshot(`${SHOTS}/offline-project-delete-disabled.png`);
    await $(".modal-footer").$("button=Cancel").click();

    // Merging tags needs the hub too.
    await $(".nav-item*=Tags & projects").click();
    const merge = $("button=Merge");
    await merge.waitForExist({ timeout: 5_000 });
    expect(await merge.isEnabled()).toBe(false);
    expect(await merge.getAttribute("title")).toBe("Not available offline");
    await browser.saveScreenshot(`${SHOTS}/offline-tag-merge-disabled.png`);
    await $('button[aria-label="Close manager"]').click();
    await $(".modal-header").waitForExist({ reverse: true });

    await $('[data-nav="goals"]').click();
    const newGoal = $("button.goals-new");
    await newGoal.waitForExist({ timeout: 10_000 });
    expect(await newGoal.isEnabled()).toBe(false);
    expect(await newGoal.getAttribute("title")).toBe("Not available offline");
    await browser.saveScreenshot(`${SHOTS}/offline-goal-disabled.png`);

    // A goal's own dialog: deleting it, and saving an edit, need the hub.
    await $(".goal-row*=Offline Goal").click();
    await $('button[aria-label="Edit goal"]').click();
    const delGoal = $(".modal-footer").$("button=Delete goal");
    await delGoal.waitForExist({ timeout: 5_000 });
    expect(await delGoal.isEnabled()).toBe(false);
    expect(await $(".modal-footer").$("button=Save").isEnabled()).toBe(false);
    await browser.saveScreenshot(`${SHOTS}/offline-goal-delete-disabled.png`);
    await $(".modal-footer").$("button=Cancel").click();

    // Trash a card (queued), then the trash itself cannot be emptied.
    await openAllTasks();
    await $(".task-title*=Made in the client").click();
    await $(".detail-card").waitForExist();
    await $("button*=Delete task").click();
    await $("button*=Move to trash").click();
    await $(".detail-card").waitForExist({ reverse: true, timeout: 10_000 });
    await $('[data-nav="completed"]').click();
    await $(".completed-view").waitForExist();
    await $("button*=Trash").click();
    const empty = $("button*=Empty trash");
    await empty.waitForDisplayed({ timeout: 10_000 });
    expect(await empty.isEnabled()).toBe(false);
    expect(await empty.getAttribute("title")).toBe("Not available offline");
    await browser.saveScreenshot(`${SHOTS}/offline-trash-disabled.png`);

    // Restart while offline: the queue and the board it changed come back from disk.
    await browser.execute(() => location.reload());
    await $(".hub-banner*=changes waiting").waitForExist({
      timeout: 30_000,
      timeoutMsg: "the restart lost the queue",
    });
    expect(await $(".hub-banner").getText()).toMatch(/^Offline · last synced \d\d:\d\d · 4 changes waiting$/);
    await openAllTasks();
    await $(`.task-row*=${edited}`).waitForExist({ timeout: 10_000 });
    expect(await $(`.task-row*=${edited}`).$(".task-id").getText()).toMatch(/-\?$/);
    await expect($(".task-row*=Made in the client")).not.toBeExisting(); // it is in the trash
    await browser.saveScreenshot(`${SHOTS}/offline-restart-queued.png`);

    // The hub comes back: the queue replays, the task gets its real ref.
    await startHub();
    await browser.waitUntil(async () => (await hubTitles(edited)).length === 1, {
      timeout: 30_000,
      timeoutMsg: "the queued task never reached the hub",
    });
    const [made] = await hubSelect<{ id: number; ref: string }>(
      "SELECT id, ref FROM tasks WHERE title = $1",
      [edited],
    );
    expect(made.ref).toMatch(/^[A-Z]+-\d+$/);
    replayedRef = made.ref;
    const subs = await hubSelect<{ title: string }>("SELECT title FROM subtasks WHERE task_id = $1", [
      made.id,
    ]);
    expect(subs.map((r) => r.title)).toEqual(["Queued step"]);
    await browser.waitUntil(
      async () =>
        (
          await hubSelect<{ deleted_at: string | null }>(
            "SELECT deleted_at FROM tasks WHERE title = 'Made in the client'",
          )
        )[0]?.deleted_at != null,
      { timeout: 15_000, timeoutMsg: "the queued trash never reached the hub" },
    );
    await $(".hub-banner").waitForExist({ reverse: true, timeout: 15_000 });
    await browser.waitUntil(
      async () => (await $(`.task-row*=${edited}`).$(".task-id").getText()) === made.ref,
      { timeout: 10_000, timeoutMsg: "the board still shows the temporary ref" },
    );
    await browser.saveScreenshot(`${SHOTS}/offline-replayed.png`);
  });

  it("opens offline from the last synced copy", async () => {
    await stopHub();
    await browser.execute(() => location.reload());
    await $(".hub-banner*=Offline · last synced").waitForExist({
      timeout: 30_000,
      timeoutMsg: "the client did not open from its copy",
    });
    await openAllTasks(); // a reload lands on Goals
    await $(`.task-row*=${SECOND}`).waitForExist({ timeout: 10_000 });
    // The copy was written when the replay's reload landed: the real ref, not "-?".
    expect(await $(".task-row*=Made while the hub was down").$(".task-id").getText()).toBe(replayedRef);
    await browser.saveScreenshot(`${SHOTS}/offline-launch.png`);

    // Back online, the same window picks the hub up without a restart.
    await startHub();
    await $(".hub-banner").waitForExist({ reverse: true, timeout: 30_000 });
  });

  it("wrong token shows the error, and this machine's board is one click away", async () => {
    await setSettingsAndReload({ board_hub_token: "not-the-token" });
    const failure = $(".app-loading-error");
    await failure.waitForExist({ timeout: 15_000 });
    const text = await failure.getText();
    expect(text).toContain("The hub refused the token.");
    expect(text).toContain("Retry");
    await browser.saveScreenshot(`${SHOTS}/hub-bad-token.png`);

    await $("button=Use this machine’s board").click();
    await browser.waitUntil(
      async () => {
        try {
          return (await browser.execute(() => !!document.querySelector(".app"))) === true;
        } catch {
          return false;
        }
      },
      { timeout: 20_000, timeoutMsg: "the local board did not come back" },
    );
    const settings = (await tauriInvoke("settings_get")) as { board_hub_url: string };
    expect(settings.board_hub_url).toBe("");
    await openAllTasks();
    await expect($(`.task-row*=${SECOND}`)).not.toBeExisting();
  });

  it("shows the hub token with a copy button in Agent access", async () => {
    // Back on this machine's board, with Agent access on, the token is this machine's own.
    // Agent access alone does not reload the window; only the board settings do.
    expect(String(await tauriInvoke("settings_set", { patch: { agent_server: true } }))).not.toMatch(/^ERR/);
    await $(".nav-item*=Settings").click();
    const row = $(".settings-row*=Hub token");
    await row.waitForExist({ timeout: 15_000 });
    const field = row.$("input");
    expect(await field.getAttribute("type")).toBe("password");
    await expect(row.$("button=Copy")).toBeExisting();
    await row.scrollIntoView();
    await browser.saveScreenshot(`${SHOTS}/agent-access-hub-token.png`);
  });
});
