import { browser, $, $$, expect } from "@wdio/globals";
import { mkdirSync } from "node:fs";
import { resetAppState } from "./support/reset.js";

// The Town page draws every project as an island on a canvas (TownRenderer; its
// pixels are not asserted here). Everything a test can hold on to is DOM: the
// toolbar, the focus bar, the agent card, and the visually hidden region that
// mirrors the canvas for the keyboard — one button per agent, one per building.
//
// Agents are seeded the way real ones arrive: projects and tasks through the MCP
// server, claims through a doing write carrying a session id, and live state
// through /heartbeat. /heartbeat rejects any request with an Origin header, so a
// web page cannot fake "working"; the webview always sends one and Node does not,
// so the beats go from the spec process, exactly as the shell hook sends them.

const SHOTS = "./.test-artifacts/screenshots";
const CLIENT = "claude-code";
const WORKING_SESSION = "3f6c2a10-7b1e-4c2d-9a51-0e2b7d4c1a01";
const BLOCKED_SESSION = "3f6c2a10-7b1e-4c2d-9a51-0e2b7d4c1a02";

/** The canvas redraws on the next frame and eases camera and cut-aways in, so
 *  wait for it to settle; the DOM assertions don't need this, the picture does. */
async function shot(state: string): Promise<void> {
  await browser.pause(1000);
  mkdirSync(SHOTS, { recursive: true });
  await browser.saveScreenshot(`${SHOTS}/town-${state}.png`);
}

/** The agent server's base endpoint; the port is only known after bind. */
async function endpoint(): Promise<string> {
  const url = (await browser.executeAsync((done: (v: unknown) => void) => {
    const tauri = (window as never as { __TAURI__: { core: { invoke: Function } } }).__TAURI__;
    tauri.core.invoke("agent_server_start").then(done, (e: unknown) => done(`ERR ${e}`));
  })) as string;
  expect(url).not.toMatch(/^ERR/);
  return url.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
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

/** Call a tool and return its JSON payload; a tool error fails the spec. */
async function tool(url: string, name: string, args: Record<string, unknown>) {
  const out = await rpc(url, "tools/call", { name, arguments: args });
  const text = out.result?.content?.[0]?.text ?? "";
  if (out.error || out.result?.isError) throw new Error(`${name}: ${JSON.stringify(out)}`);
  return JSON.parse(text);
}

/** Nudge the store to reload (and re-read presence), as every agent write does. */
async function nudge(): Promise<void> {
  await browser.execute(() =>
    (
      window as unknown as { __TAURI__: { event: { emit: (e: string) => void } } }
    ).__TAURI__.event.emit("agent-db-changed"),
  );
}

async function beat(base: string, session: string, state: "working" | "blocked") {
  const res = await fetch(`${base}/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: session, state }),
  });
  expect(res.status).toBe(200);
}

/** A toolbar or focus-bar button by its text. */
const seg = (group: string, label: string) =>
  $(`.town-toolbar [aria-label="${group}"]`).$(`button=${label}`);
const chip = (label: string) => $(".town-focusbar").$(`button*=${label}`);
const pressed = (el: ReturnType<typeof $>) => el.getAttribute("aria-pressed");

describe("town page", () => {
  const seeded: Record<string, { id: number; ref: string }> = {};
  let base = "";

  before(async () => {
    await resetAppState();
  });

  // First, while the board is still empty after the reset.
  it("shows the square with a hint when there are no projects", async () => {
    await $('[data-nav="town"]').click();
    await expect($(".view-title")).toHaveText("Town");
    await expect($(".town-empty")).toHaveText("Create a project to build its island");
    // Only "All projects" in the focus bar.
    await expect($$(".town-focusbar button")).toBeElementsArrayOfSize(1);
    await shot("empty");
  });

  it("opens from the sidebar with a live count", async () => {
    base = await endpoint();
    const url = `${base}/mcp`;
    await rpc(url, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: CLIENT, version: "1" },
    });
    await rpc(url, "notifications/initialized", {}, true);

    await tool(url, "create_project", { name: "Harbor" });
    await tool(url, "create_project", { name: "Atlas" });
    const task = async (key: string, project: string, title: string) => {
      const r = await tool(url, "create_task", { title, project });
      seeded[key] = { id: r.id, ref: r.ref };
    };
    await task("working", "Harbor", "Ship the island renderer");
    await task("blocked", "Atlas", "Pick the bridge colour");
    await task("quiet", "Atlas", "Draft the release note");

    await tool(url, "update_task", { id: seeded.working.id, status: "doing", session_id: WORKING_SESSION });
    await tool(url, "update_task", { id: seeded.blocked.id, status: "doing", session_id: BLOCKED_SESSION });
    await tool(url, "log_progress", { task_id: seeded.working.id, text: "drawing the town square" });
    await tool(url, "log_progress", { task_id: seeded.blocked.id, text: "waiting on a colour" });
    // No claim and no beat: the activity fallback places it, quiet and not live.
    await tool(url, "log_progress", { task_id: seeded.quiet.id, text: "outline written" });
    await beat(base, WORKING_SESSION, "working");
    await beat(base, BLOCKED_SESSION, "blocked");
    await nudge();

    // Two sessions beat; the fallback agent is present but not live.
    const row = $('[data-nav="town"]');
    await expect(row.$(".nav-count")).toHaveText("2 live");
    await $('[data-nav="all"]').click();
    await row.click();
    await expect($(".view-title")).toHaveText("Town");
    await expect($(".town-empty")).not.toBeExisting();
    await expect($$(".town-focusbar button")).toBeElementsArrayOfSize(3);
    for (const key of ["working", "blocked", "quiet"]) {
      await expect($(`[data-testid="town-agent-${seeded[key].id}"]`)).toBeExisting();
    }

    await browser.execute(() => {
      document.documentElement.dataset.theme = "light";
    });
    await shot("overview-day");
    await browser.execute(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await shot("overview-night");
    await browser.execute(() => {
      delete document.documentElement.dataset.theme;
    });
  });

  it("outside inside toggle", async () => {
    const buildings = () => $$('.town-stage [aria-label$=" building"]');
    await expect(buildings()).toBeElementsArrayOfSize(2);
    expect(await pressed(seg("Buildings", "Outside"))).toBe("true");

    await seg("Buildings", "Inside").click();
    expect(await buildings().map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "true"]);
    expect(await pressed(seg("Buildings", "Inside"))).toBe("true");
    expect(await pressed(seg("Buildings", "Outside"))).toBe("false");
    await shot("inside-all");

    // Closing one building leaves a mixed town: neither side is pressed.
    await browser.execute(() =>
      (document.querySelector('.town-stage [aria-label="Harbor building"]') as HTMLButtonElement).click(),
    );
    expect(await pressed(seg("Buildings", "Inside"))).toBe("false");
    expect(await pressed(seg("Buildings", "Outside"))).toBe("false");

    await seg("Buildings", "Outside").click();
    expect(await buildings().map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false"]);
    expect(await pressed(seg("Buildings", "Outside"))).toBe("true");
  });

  it("agent card on focus", async () => {
    const { id, ref } = seeded.working;
    await browser.execute(
      (t) => (document.querySelector(`[data-testid="town-agent-${t}"]`) as HTMLElement).focus(),
      id,
    );
    const card = $('[data-testid="town-card"]');
    await card.waitForExist();
    const text = await card.getText();
    expect(text).toContain(CLIENT);
    expect(text).toContain(`Harbor · ${ref}`);
    expect(text).toContain("Ship the island renderer");
    expect(text).toContain("Working");
    expect(text).toContain("drawing the town square");
    await shot("hover-card");

    // Blurring the agent hides its card.
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(card).not.toBeExisting();
  });

  it("focus bar zoom and Esc", async () => {
    const all = chip("All projects");
    expect(await pressed(all)).toBe("true");
    await chip("Atlas").click();
    expect(await pressed(chip("Atlas"))).toBe("true");
    expect(await pressed(all)).toBe("false");
    await shot("focus-one-project");

    // Esc in the palette closes the palette and leaves the island focused.
    await browser.keys(["Meta", "k"]);
    const input = $(".palette-input input");
    await input.waitForDisplayed({ timeout: 10000 });
    await browser.keys("Escape");
    await input.waitForExist({ reverse: true });
    expect(await pressed(chip("Atlas"))).toBe("true");

    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await browser.keys("Escape");
    await browser.waitUntil(async () => (await pressed(all)) === "true", {
      timeoutMsg: "Esc did not zoom back out to all projects",
    });
    expect(await pressed(chip("Atlas"))).toBe("false");
  });

  it("helper bots toggle", async () => {
    expect(await pressed(seg("Helper bots", "Helper bots"))).toBe("true");
    await seg("Helper bots", "Agents only").click();
    expect(await pressed(seg("Helper bots", "Agents only"))).toBe("true");
    expect(await pressed(seg("Helper bots", "Helper bots"))).toBe("false");
    await shot("agents-only");
    await seg("Helper bots", "Helper bots").click();
    expect(await pressed(seg("Helper bots", "Helper bots"))).toBe("true");
  });

  it("environment picker saves", async () => {
    const desert = () => $('[role="radiogroup"][aria-label="Environment"]').$("button=Desert");
    await $(".nav-project*=Harbor").moveTo();
    await $('button[aria-label="Edit Harbor"]').click();
    await desert().waitForDisplayed({ timeout: 10000 });
    await desert().click();
    await expect(desert()).toHaveAttribute("aria-checked", "true");
    await shot("project-dialog-environment");
    await $(".modal-footer button.btn.primary").click();
    await $(".modal").waitForExist({ reverse: true });

    await $(".nav-project*=Harbor").moveTo();
    await $('button[aria-label="Edit Harbor"]').click();
    await desert().waitForDisplayed({ timeout: 10000 });
    await expect(desert()).toHaveAttribute("aria-checked", "true");
    await browser.keys("Escape");
  });

  // TIL-216: opening Town while a goal is selected narrows it to that goal.
  it("narrows to the selected goal, and Whole town brings the rest back", async () => {
    const url = `${base}/mcp`;
    await tool(url, "create_goal", { project: "Atlas", name: "Bridge" });
    await tool(url, "update_task", { id: seeded.blocked.id, goal: "Bridge" });
    await nudge();

    const buildings = () => $$('.town-stage [aria-label$=" building"]');
    const agent = (key: string) => $(`[data-testid="town-agent-${seeded[key].id}"]`);
    const whole = () => $(".town-toolbar").$("button=Whole town");

    await $(".nav-project*=Atlas").click();
    await $(".nav-goal*=Bridge").waitForExist({ timeout: 10000 });
    await $(".nav-goal*=Bridge").click();
    await $('[data-nav="town"]').click();

    await expect($(".view-title-sub")).toHaveText("Bridge");
    await expect(buildings()).toBeElementsArrayOfSize(1);
    await expect(buildings()[0]).toHaveAttribute("aria-label", "Atlas building");
    await expect(agent("blocked")).toBeExisting();
    // Same project, no goal: gone. Other project: gone.
    await expect(agent("quiet")).not.toBeExisting();
    await expect(agent("working")).not.toBeExisting();
    await expect($$(".town-focusbar button")).toBeElementsArrayOfSize(2);
    await shot("goal-filtered");

    await whole().click();
    await expect($(".view-title")).toHaveText("Town");
    await expect($(".view-title-sub")).not.toBeExisting();
    await expect(whole()).not.toBeExisting();
    await expect(buildings()).toBeElementsArrayOfSize(2);
    for (const key of ["working", "blocked", "quiet"]) {
      await expect(agent(key)).toBeExisting();
    }
    await shot("goal-cleared");
  });
});
