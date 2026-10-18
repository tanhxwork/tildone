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

/** Start the hub process and wait until its MCP server answers. */
async function startHub() {
  const root = mkdtempSync(join(tmpdir(), "tildone-hub-"));
  const config = join(root, "config");
  const data = join(root, "data");
  hubDirs.push(root);
  // The app dirs move with XDG_* on Linux; the folder name is the e2e identifier.
  const appConfig = join(config, basename(E2E_CONFIG_DIR));
  mkdirSync(appConfig, { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(appConfig, "settings.json"),
    JSON.stringify({ agent_server: true, _migrated: true }),
  );
  writeFileSync(join(appConfig, "hub-token"), TOKEN, { mode: 0o600 });

  const agentPort = await freePort();
  const webdriverPort = await freePort();
  hubUrl = `http://127.0.0.1:${agentPort}`;

  const binary = process.env.TAURI_E2E_BINARY ?? "./src-tauri/target-e2e/debug/tildone";
  mkdirSync("./.test-artifacts", { recursive: true });
  const log = openSync("./.test-artifacts/hub-process.log", "w");
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

async function hubCreateTask(title: string) {
  if (!mcpSession) {
    await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "hub-e2e", version: "1" },
    });
    await rpc("notifications/initialized", {}, true);
  }
  const out = await rpc("tools/call", { name: "create_task", arguments: { title } });
  if (out.error || out.result?.isError) throw new Error(`create_task: ${JSON.stringify(out)}`);
}

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
