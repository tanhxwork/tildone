import { browser, $, $$, expect } from "@wdio/globals";
import { mkdirSync } from "node:fs";
import { backdateActivity, resetAppState } from "./support/reset.js";

// The home view, "Where you're going" (spec focus-compass, mockup E): one band per
// goal that moved this week, a NEEDS YOU lane and a MOVED lane inside it, and a
// last band for work moving with no goal. Seeded through the MCP server the way
// agents write; open cards are aged with backdateActivity (it leaves completed_at
// alone, so done cards stay "moved now").

const SHOTS = "./.test-artifacts/screenshots/focus-compass";

async function shot(name: string): Promise<void> {
  await browser.pause(500);
  mkdirSync(SHOTS, { recursive: true });
  await browser.saveScreenshot(`${SHOTS}/${name}.png`);
}

/** The agent server's base endpoint; the port is only known after bind. */
async function endpoint(): Promise<string> {
  const url = (await browser.executeAsync((done: (v: unknown) => void) => {
    const tauri = (
      window as never as { __TAURI__: { core: { invoke: Function } } }
    ).__TAURI__;
    tauri.core
      .invoke("agent_server_start")
      .then(done, (e: unknown) => done(`ERR ${e}`));
  })) as string;
  expect(url).not.toMatch(/^ERR/);
  return `${url.replace(/\/mcp\/?$/, "").replace(/\/$/, "")}/mcp`;
}

let mcpSession = "";
let rpcId = 0;
/** One JSON-RPC call; the reply is plain JSON or a single SSE `data:` event. */
async function rpc(
  url: string,
  method: string,
  params: unknown,
  notify = false,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (mcpSession) headers["mcp-session-id"] = mcpSession;
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (!notify) body.id = ++rpcId;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  mcpSession = res.headers.get("mcp-session-id") ?? mcpSession;
  const text = await res.text();
  if (notify) return null;
  const data = text.trim().startsWith("{")
    ? text
    : text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .pop()!
        .slice(5);
  return JSON.parse(data);
}

/** Call a tool and return its JSON payload; a tool error fails the spec. */
async function tool(url: string, name: string, args: Record<string, unknown>) {
  const out = await rpc(url, "tools/call", { name, arguments: args });
  const text = out.result?.content?.[0]?.text ?? "";
  if (out.error || out.result?.isError)
    throw new Error(`${name}: ${JSON.stringify(out)}`);
  return JSON.parse(text);
}

async function connect(): Promise<string> {
  const url = await endpoint();
  mcpSession = "";
  await rpc(url, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "claude-code", version: "1" },
  });
  await rpc(url, "notifications/initialized", {}, true);
  return url;
}

/** Tell the app the database changed, as Rust does after an agent write. */
async function announce(): Promise<void> {
  await browser.execute(() =>
    (
      window as unknown as {
        __TAURI__: { event: { emit: (e: string) => void } };
      }
    ).__TAURI__.event.emit("agent-db-changed"),
  );
}

type Seed = {
  title: string;
  goal?: string;
  status?: string;
  owner?: string;
  tags?: string[];
};

async function cards(url: string, project: string, seeds: Seed[]) {
  const made: Record<string, { id: number; ref: string }> = {};
  for (const s of seeds) {
    const r = await tool(url, "create_task", { ...s, project });
    made[s.title] = { id: r.id, ref: r.ref };
  }
  return made;
}

const bandTexts = async () => {
  const out: string[] = [];
  for (const b of await $$("[data-compass-goal] .compass-name"))
    out.push(await b.getText());
  return out;
};

describe("compass home view", () => {
  let url = "";

  beforeEach(async () => {
    await resetAppState();
    url = await connect();
    await $('[data-nav="goals"]').click();
    await $(".compass-sub").waitForExist({ timeout: 10000 });
  });

  it("shows a band per moving goal, both lanes, and the no-goal band", async () => {
    await tool(url, "create_project", { name: "Harbor" });
    await tool(url, "create_project", { name: "Atlas" });
    await tool(url, "create_goal", {
      project: "Harbor",
      name: "Wrap the sprint",
      notes: "Everything shipped.",
    });
    await tool(url, "create_goal", {
      project: "Harbor",
      name: "Ship the island",
      notes: "Visitors can walk the whole island.",
    });
    await tool(url, "create_goal", {
      project: "Atlas",
      name: "Plan the atlas",
    });

    await cards(url, "Harbor", [
      { title: "Wrap one", goal: "Wrap the sprint", status: "done" },
      { title: "Wrap two", goal: "Wrap the sprint", status: "done" },
    ]);
    // Moves are stamped to the second: keep "Ship the island" strictly newer.
    await browser.pause(1200);
    await cards(url, "Harbor", [
      {
        title: "Pick the bridge",
        goal: "Ship the island",
        owner: "human",
        tags: ["blocked"],
      },
      {
        title: "Approve the lighthouse",
        goal: "Ship the island",
        tags: ["needs-approval"],
      },
      {
        title: "Check the harbor",
        goal: "Ship the island",
        status: "doing",
        tags: ["human-verify"],
      },
      { title: "Paint the pier", goal: "Ship the island", status: "done" },
      { title: "Build the quay", goal: "Ship the island", status: "doing" },
      { title: "Lay the road", goal: "Ship the island" },
      { title: "Loose one", status: "doing" },
      { title: "Loose two", status: "doing" },
      { title: "Loose three", status: "doing" },
    ]);
    const atlas = await cards(url, "Atlas", [
      { title: "Chart the coast", goal: "Plan the atlas", status: "doing" },
      { title: "Print the atlas", goal: "Plan the atlas" },
    ]);
    await cards(url, "inbox", [{ title: "Inbox loose", status: "doing" }]);
    for (const t of Object.values(atlas)) backdateActivity(t.id, 1);
    await announce();

    await expect($(".view-title")).toHaveText("Where you’re going");
    await expect($(".compass-sub")).toHaveText(
      "3 goals moved this week · 3 cards need you",
    );

    await $("[data-compass-goal]").waitForExist({ timeout: 10000 });
    expect(await bandTexts()).toEqual([
      "Ship the island",
      "Wrap the sprint",
      "Plan the atlas",
    ]);
    // The loose band comes last.
    const bands = await $$(".compass-band");
    expect(
      await bands[bands.length - 1].getAttribute("data-compass-loose"),
    ).not.toBeNull();

    const ship = $("[data-compass-goal]");
    await expect(ship.$(".compass-outcome")).toHaveText(
      "Visitors can walk the whole island.",
    );
    await expect(ship.$(".compass-count")).toHaveText("1 of 6");
    const lanes: string[] = [];
    for (const l of await ship.$$(".compass-lane"))
      lanes.push(await l.getText());
    expect(lanes).toEqual(["NEEDS YOU", "MOVED · NEXT"]);
    const need = (title: string) => ship.$(`.compass-row*=${title}`);
    await expect(need("Pick the bridge").$(".state-pill")).toHaveText("decide");
    await expect(need("Approve the lighthouse").$(".state-pill")).toHaveText(
      "approve",
    );
    await expect(need("Check the harbor").$(".state-pill")).toHaveText(
      "verify",
    );
    await expect(ship.$(".compass-row*=Paint the pier")).toHaveText(
      expect.stringContaining("◇ done"),
    );
    await expect(ship.$(".compass-row*=Build the quay")).toHaveText(
      expect.stringContaining("◇ doing"),
    );
    await expect(ship.$(".compass-row*=Lay the road")).toHaveText(
      expect.stringContaining("◇ queued"),
    );

    const wrap = (await $$("[data-compass-goal]"))[1];
    await expect(wrap).toHaveText(expect.stringContaining("All cards done."));
    await expect(wrap.$(".compass-ok")).toHaveText("2 of 2 ✓");

    const loose = $("[data-compass-loose]");
    await expect(loose.$(".compass-count")).toHaveText("4 of 14 this week");
    await expect(loose.$('[data-compass-chip="inbox"]')).toHaveText(
      expect.stringContaining("Inbox"),
    );
    await expect(loose.$('[data-compass-chip="inbox"]')).toHaveText(
      expect.stringContaining("1"),
    );
    expect(await loose.$$("[data-compass-card]")).toHaveLength(2);
    await expect(loose.$(".compass-more-text")).toHaveText("+2 more doing");
    await shot("compass");

    const harbor = (await loose.$$("[data-compass-chip]"))[0];
    await expect(harbor).toHaveText(expect.stringContaining("Harbor"));
    await expect(harbor).toHaveText(expect.stringContaining("3"));
    await harbor.click();
    await expect($(".view-title-sub")).toHaveText("No goal");
    await $(".task-row*=Loose one").waitForExist({ timeout: 10000 });
    await expect($(".task-row*=Inbox loose")).not.toExist();
  });

  it("closes a finished goal from its band", async () => {
    await tool(url, "create_project", { name: "Harbor" });
    await tool(url, "create_goal", {
      project: "Harbor",
      name: "Wrap the sprint",
      notes: "Everything shipped.",
    });
    await cards(url, "Harbor", [
      { title: "Wrap one", goal: "Wrap the sprint", status: "done" },
      { title: "Wrap two", goal: "Wrap the sprint", status: "done" },
    ]);
    await announce();

    const wrap = $("[data-compass-goal]");
    await wrap.waitForExist({ timeout: 10000 });
    await expect(wrap).toHaveText(expect.stringContaining("All cards done."));
    await shot("compass-finished");
    await wrap.$("button=Close goal").click();
    await $("[data-compass-goal]").waitForExist({
      timeout: 10000,
      reverse: true,
    });
    await expect($(".compass-empty")).toHaveText("Nothing moved this week");
  });

  it("shows one quiet line when nothing moved", async () => {
    await expect($(".compass-empty")).toHaveText("Nothing moved this week");
    await expect($(".compass-sub")).toHaveText(
      "0 goals moved this week · 0 cards need you",
    );
    await expect($(".compass-all-title")).toHaveText("All goals");
    await shot("compass-empty");
  });
});
