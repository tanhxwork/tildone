import { browser, $, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { E2E_DB as DB } from "./support/dataDir.js";
import { remount } from "./support/reset.js";

// Task owner (spec 2026-10-01): Mine is the fresh-install view, and a project
// board splits into a You lane over an Agents lane. Cards are created through
// the app's real MCP server, as an agent would: agent tasks pass no owner, so the
// create_task default is what puts them in the queue. The sqlite3 CLI only reads
// back what the app wrote.

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

function sql(statement: string): string {
  return execFileSync("sqlite3", ["-cmd", ".timeout 5000", DB, statement], {
    encoding: "utf8",
  }).trim();
}

/** Tell the app the database changed, the way Rust does after an agent write. */
async function announceDbChange() {
  await browser.executeAsync((done: (v: unknown) => void) => {
    const tauri = (window as never as { __TAURI__?: { event: { emit: Function } } }).__TAURI__;
    if (!tauri) return done("no __TAURI__");
    tauri.event.emit("agent-db-changed").then(
      () => done("ok"),
      (e: unknown) => done(String(e)),
    );
  });
}

const PROJECT = "Owner Lab";
const HUMAN_TODO = "Lab renew the certificate";
const AGENT_TODO = "Lab add the rename spec";
const AGENT_DOING = "Lab trim unused tokens";
const AGENT_VERIFY = "Lab drag keeps position";
const HUMAN_BLOCKED = "Lab pick the retry limit";
const AGENT_APPROVE = "Lab add a retry column";
const AGENT_DISMISS = "Lab rename the queue";
const AGENT_TAKE = "Lab write the release note";

const SESSION = "7c1e9a2b-4d3f-4b6a-9c2e-1f0a2b3c4d5e";
const CLIENT = "owner-e2e";

/** The agent server's MCP URL; the port is only known after bind. */
async function mcpUrl(): Promise<string> {
  const url = (await browser.executeAsync((done: (v: unknown) => void) => {
    const tauri = (window as never as { __TAURI__: { core: { invoke: Function } } }).__TAURI__;
    tauri.core.invoke("agent_server_start").then(done, (e: unknown) => done(`ERR ${e}`));
  })) as string;
  expect(url).not.toMatch(/^ERR/);
  return url.endsWith("/mcp") ? url : `${url.replace(/\/$/, "")}/mcp`;
}

let mcpSession = "";
let rpcId = 0;
/** One JSON-RPC call; the reply is plain JSON or a single SSE `data:` event. */
async function rpc(url: string, method: string, params: unknown, notify = false) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (mcpSession) headers["mcp-session-id"] = mcpSession;
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (!notify) body.id = ++rpcId;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  mcpSession = res.headers.get("mcp-session-id") ?? mcpSession;
  const text = await res.text();
  if (notify) return null;
  const data = text.trim().startsWith("{")
    ? text
    : text.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5);
  return JSON.parse(data);
}

async function connect(url: string) {
  await rpc(url, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: CLIENT, version: "1" },
  });
  await rpc(url, "notifications/initialized", {}, true);
}

/** Call a tool and return its JSON payload; a tool error fails the spec. */
async function tool(url: string, name: string, args: Record<string, unknown>) {
  const out = await rpc(url, "tools/call", { name, arguments: args });
  const text = out.result?.content?.[0]?.text ?? "";
  if (out.error || out.result?.isError) throw new Error(`${name}: ${JSON.stringify(out)}`);
  return JSON.parse(text);
}

function tagNames(id: number): string {
  return sql(
    `SELECT COALESCE(GROUP_CONCAT(t.name), '') FROM task_tags tt JOIN tags t ON t.id = tt.tag_id WHERE tt.task_id = ${id};`,
  );
}

function taskRow(id: number): string {
  return sql(`SELECT owner || '|' || status FROM tasks WHERE id = ${id};`);
}

/** Drag a card with synthetic pointer events, the input dnd-kit's PointerSensor
 *  listens to: down on the card, a few frames of moves past its 5px activation
 *  distance, up over the target. */
async function drag(sourceSel: string, targetSel: string) {
  const result = await browser.executeAsync(
    (src: string, dst: string, done: (v: unknown) => void) => {
      const from = document.querySelector(src);
      const to = document.querySelector(dst);
      if (!from || !to) return done(`missing ${from ? dst : src}`);
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      const start = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
      const end = { x: b.left + b.width / 2, y: b.top + Math.min(b.height / 2, 30) };
      const fire = (el: EventTarget, type: string, p: { x: number; y: number }) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: p.x,
            clientY: p.y,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
          }),
        );
      // setTimeout, not requestAnimationFrame: WebKit throttles rAF in a background
      // window, which stalled this drag past the script timeout (1 run in 2).
      const frame = () => new Promise((r) => setTimeout(() => r(null), 16));
      void (async () => {
        fire(from, "pointerdown", start);
        await frame();
        const steps = 12;
        for (let i = 1; i <= steps; i++) {
          fire(document, "pointermove", {
            x: start.x + ((end.x - start.x) * i) / steps,
            y: start.y + ((end.y - start.y) * i) / steps,
          });
          await frame();
        }
        await frame();
        fire(document, "pointerup", end);
        done("ok");
      })();
    },
    sourceSel,
    targetSel,
  );
  expect(result).toBe("ok");
}

describe("task owner", () => {
  const ids: Record<string, number> = {};
  let url = "";

  before(async () => {
    await $("#root").waitForExist();
    await $('button[aria-label="New project"]').click();
    const nameField = $('.modal input[placeholder="Project name"]');
    await nameField.waitForDisplayed({ timeout: 10000 });
    await nameField.setValue(PROJECT);
    await $(".modal-footer button.btn.primary").click();
    await $(`.nav-project*=${PROJECT}`).waitForExist({ timeout: 10000 });

    url = await mcpUrl();
    await connect(url);
    const create = async (title: string, args: Record<string, unknown> = {}) =>
      (await tool(url, "create_task", { title, project: PROJECT, ...args })).id as number;
    ids.human = await create(HUMAN_TODO, { owner: "human" });
    ids.agentTodo = await create(AGENT_TODO, { from_task: ids.human });
    ids.agentDoing = await create(AGENT_DOING);
    ids.agentVerify = await create(AGENT_VERIFY, { tags: ["human-verify"] });
    ids.humanBlocked = await create(HUMAN_BLOCKED, { owner: "human", tags: ["blocked"] });
    ids.agentApprove = await create(AGENT_APPROVE, { from_task: ids.human, tags: ["needs-approval"] });
    ids.agentDismiss = await create(AGENT_DISMISS, { tags: ["needs-approval"] });
    ids.agentTake = await create(AGENT_TAKE);
    await tool(url, "update_task", { id: ids.agentVerify, status: "done" });
    // Claimed the way a session claims: the doing write carries its session id.
    await tool(url, "update_task", { id: ids.agentDoing, status: "doing", session_id: SESSION });
    expect(taskRow(ids.agentTodo)).toBe("agent|todo");
    await announceDbChange();
  });

  it("opens Mine on a fresh install", async () => {
    // The per-spec reset pins Today for the other specs; with no saved nav at
    // all, the app must fall back to Mine.
    await remount(() => localStorage.removeItem("tildone-nav"));
    await expect($('[data-nav="mine"]')).toHaveElementClass("active");
  });

  it("groups Mine and works the agent queue", async () => {
    const mine = $(".owner-view");
    await mine.waitForExist({ timeout: 10000 });
    await expect(mine.$(".task-group*=Needs your answer").$(`.task-row*=${HUMAN_BLOCKED}`)).toBeExisting();
    await expect(mine.$(".task-group*=To verify").$(`.task-row*=${AGENT_VERIFY}`)).toBeExisting();
    await expect(mine.$(".task-group*=My todos").$(`.task-row*=${HUMAN_TODO}`)).toBeExisting();
    await expect(mine.$(`.task-row*=${AGENT_TODO}`)).not.toBeExisting();
    mkdirSync(".test-artifacts/screenshots", { recursive: true });
    await browser.pause(300);
    await browser.saveScreenshot(".test-artifacts/screenshots/owner-mine.png");

    await $(".queue-strip").click();
    await expect($('[data-nav="queue"]')).toHaveElementClass("active");
    const humanRef = sql(`SELECT ref FROM tasks WHERE id = ${ids.human};`);
    await expect($(`.queue-row*=${AGENT_APPROVE}`)).toHaveText(new RegExp(`from ${humanRef}`));
    // The Doing row names who holds the card: the claiming client.
    await expect($(".task-group*=Doing").$(`.queue-row*=${AGENT_DOING}`)).toHaveText(
      new RegExp(CLIENT),
    );
    // The nav background transitions for 150ms; capture after it settles.
    await browser.pause(300);
    await browser.saveScreenshot(".test-artifacts/screenshots/owner-queue.png");

    await $(`.queue-row*=${AGENT_APPROVE}`).$("button=Approve").click();
    await browser.waitUntil(() => !tagNames(ids.agentApprove).includes("needs-approval"), {
      timeout: 10000,
      timeoutMsg: `needs-approval still on: ${tagNames(ids.agentApprove)}`,
    });
    await $(`.queue-row*=${AGENT_DISMISS}`).$("button=Dismiss").click();
    await browser.waitUntil(
      () => sql(`SELECT deleted_at IS NOT NULL FROM tasks WHERE id = ${ids.agentDismiss};`) === "1",
      { timeout: 10000, timeoutMsg: "dismissed task not in trash" },
    );
    await $(`.queue-row*=${AGENT_TAKE}`).$("button=Take it").click();
    await browser.waitUntil(() => taskRow(ids.agentTake) === "human|todo", {
      timeout: 10000,
      timeoutMsg: `expected human|todo, got ${taskRow(ids.agentTake)}`,
    });
    await expect($(`.queue-row*=${AGENT_TAKE}`)).not.toBeExisting();

    await $('[data-nav="mine"]').click();
    await expect($(".owner-view").$(".task-group*=My todos").$(`.task-row*=${AGENT_TAKE}`)).toBeExisting();
  });

  it("splits a project board into You over Agents", async () => {
    await $(`.nav-project*=${PROJECT}`).click();
    await $('button[aria-label="Board view"]').click();
    const you = $('[data-lane="human"]');
    const agents = $('[data-lane="agent"]');
    await you.waitForExist({ timeout: 10000 });

    await expect(you.$(`.board-card*=${HUMAN_TODO}`)).toBeExisting();
    await expect(agents.$(`.board-card*=${AGENT_TODO}`)).toBeExisting();
    await expect(agents.$(`.board-card*=${AGENT_DOING}`)).toBeExisting();
    // A held agent card names who holds it, as the queue's Doing row does.
    await expect(agents.$(`.board-card*=${AGENT_DOING}`)).toHaveText(new RegExp(CLIENT));
    // Checking an agent's finished work is the user's job: it sits in You.
    await expect(you.$('[data-status="done"]').$(`.board-card*=${AGENT_VERIFY}`)).toBeExisting();
    await expect(agents.$(`.board-card*=${AGENT_VERIFY}`)).not.toBeExisting();

    await browser.pause(300);
    await browser.saveScreenshot(".test-artifacts/screenshots/owner-board-lanes.png");
  });

  it("hands an agent card to the user when dragged into You, changing its column too", async () => {
    await drag(
      `[data-task-id="${ids.agentDoing}"]`,
      '[data-lane="human"] [data-status="todo"] .column-body',
    );
    await browser.waitUntil(() => taskRow(ids.agentDoing) === "human|todo", {
      timeout: 10000,
      timeoutMsg: `expected human|todo, got ${taskRow(ids.agentDoing)}`,
    });
    await expect(
      $('[data-lane="human"] [data-status="todo"]').$(`.board-card*=${AGENT_DOING}`),
    ).toBeExisting();
  });

  it("keeps the Agents lane collapsed across a reload", async () => {
    await $('button[aria-label="Collapse agents lane"]').click();
    await expect($('[data-lane="agent"]')).toHaveElementClass("collapsed");

    await remount(() => {});
    await $('[data-lane="agent"]').waitForExist({ timeout: 10000 });
    await expect($('[data-lane="agent"]')).toHaveElementClass("collapsed");
    await expect($(`.board-card*=${AGENT_TODO}`)).not.toBeExisting();
    await browser.pause(300);
    await browser.saveScreenshot(".test-artifacts/screenshots/owner-board-lanes-collapsed.png");
  });

  it("collapses a verify card once it has been done a day", async () => {
    const verify = $(`.board-card*=${AGENT_VERIFY}`);
    await expect(verify).not.toHaveElementClass("compact");
    sql(`UPDATE tasks SET completed_at = datetime('now', '-2 days') WHERE id = ${ids.agentVerify};`);
    await announceDbChange();
    await browser.waitUntil(async () => (await verify.getAttribute("class")).includes("compact"), {
      timeout: 10000,
      timeoutMsg: "verify card done two days ago is still full",
    });
    // Still pinned in the verify queue, just one line.
    await expect($('[data-lane="human"] [data-status="done"]').$(`.board-card*=${AGENT_VERIFY}`)).toBeExisting();
    await browser.pause(300);
    await browser.saveScreenshot(".test-artifacts/screenshots/owner-verify-compact.png");
  });

  it("moves a done card to Completed after three days", async () => {
    sql(`UPDATE tasks SET completed_at = datetime('now', '-4 days') WHERE id = ${ids.agentVerify};`);
    await announceDbChange();
    await $(`.board-card*=${AGENT_VERIFY}`).waitForExist({ reverse: true, timeout: 10000 });
    await expect($('[data-lane="human"]').$(".see-all*=more in Completed")).toBeExisting();
  });
});
