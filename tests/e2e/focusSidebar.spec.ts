import { browser, $, $$, expect } from "@wdio/globals";
import { mkdirSync } from "node:fs";
import { backdateActivity, resetAppState } from "./support/reset.js";

// The Focus section of the sidebar (spec focus-compass, mockup D): the goals that
// moved this week with the cards moving toward each, loose work, and the Needs
// you / Stalled / Quiet rows. Boards are seeded the way agents write them: through
// the MCP server, then aged with backdateActivity (which moves open cards only).

const SHOTS = "./.test-artifacts/screenshots/focus-compass";

async function shot(name: string): Promise<void> {
  await browser.pause(400);
  mkdirSync(SHOTS, { recursive: true });
  await browser.saveScreenshot(`${SHOTS}/${name}.png`);
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

/** Tell the app the database changed, the way Rust does after an agent write —
 *  needed once backdateActivity has gone in through the sqlite3 CLI. */
async function announceDbChange(): Promise<void> {
  await browser.executeAsync((done: (v: unknown) => void) => {
    const tauri = (window as never as { __TAURI__?: { event: { emit: Function } } }).__TAURI__;
    if (!tauri) return done("no __TAURI__");
    tauri.event.emit("agent-db-changed").then(
      () => done("ok"),
      (e: unknown) => done(String(e)),
    );
  });
}

interface Seeded {
  goals: Record<string, number>;
  refs: Record<string, string>;
}

/**
 * sidebar-focus: three goals in three projects with cards moved today (a human
 * "you" card, agent cards, needs-approval cards), one of them finished but open,
 * and two loose doing cards. `stalled` adds two doing cards untouched for days;
 * `quiet` adds two projects whose only cards are just as old; `quietGoal` is
 * `quiet` plus an open goal on Archive One; `finishedStale` adds a finished goal
 * whose cards were all closed weeks ago.
 */
async function seed(
  level: "focus" | "stalled" | "quiet" | "quietGoal" | "finishedStale",
): Promise<Seeded> {
  const url = `${await endpoint()}/mcp`;
  mcpSession = "";
  await rpc(url, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "focus-sidebar-spec", version: "1" },
  });
  await rpc(url, "notifications/initialized", {}, true);
  const out: Seeded = { goals: {}, refs: {} };
  const task = async (key: string, args: Record<string, unknown>) => {
    const r = await tool(url, "create_task", args);
    out.refs[key] = r.ref;
    return r;
  };
  for (const name of ["Worklane", "Crestlink", "Factory"]) {
    await tool(url, "create_project", { name });
  }
  for (const [project, name, notes] of [
    ["Worklane", "Expenses launch", "Ready for first tenant"],
    ["Crestlink", "Mobile driver fixes", "Drivers stop calling the office"],
    ["Factory", "Factory learns", "Retros feed the next brief"],
  ]) {
    const g = await tool(url, "create_goal", { project, name, notes });
    out.goals[name] = g.id;
  }

  const expenses = { project: "Worklane", goal: "Expenses launch" };
  await task("e1", { ...expenses, title: "Export claims for payroll", status: "done" });
  await task("e2", {
    ...expenses,
    title: "Settle Finance approval",
    status: "doing",
    owner: "human",
    tags: ["needs-approval"],
  });
  await task("e3", { ...expenses, title: "Approve vendor list", tags: ["needs-approval"] });
  await task("e4", { ...expenses, title: "Wire up receipts", status: "doing" });
  await task("e5", { ...expenses, title: "Draft rollout notes", status: "doing" });

  // The only card of its goal, a day old: sorts after Expenses launch (today).
  const mobile = await task("m1", {
    project: "Crestlink",
    goal: "Mobile driver fixes",
    title: "Restore the rig card",
    status: "doing",
    owner: "human",
  });
  backdateActivity(mobile.id, 1);

  const factory = { project: "Factory", goal: "Factory learns" };
  await task("f1", { ...factory, title: "Write the retro prompt", status: "done" });
  await task("f2", { ...factory, title: "Ship the retro panel", status: "done" });

  await task("l1", { project: "Factory", title: "Why ui-check misses the map", status: "doing" });
  await task("l2", {
    project: "Crestlink",
    title: "Call the carrier",
    status: "doing",
    owner: "human",
  });

  if (level === "finishedStale") {
    const g = await tool(url, "create_goal", { project: "Worklane", name: "Legacy cleanup" });
    out.goals["Legacy cleanup"] = g.id;
    for (const [key, title] of [["z1", "Drop the old exporter"], ["z2", "Archive the old runbook"]]) {
      const t = await task(key, { project: "Worklane", goal: "Legacy cleanup", title, status: "done" });
      backdateActivity(t.id, 20);
    }
  }
  const quiet = level === "quiet" || level === "quietGoal";
  if (level === "stalled" || quiet) {
    const old1 = await task("s1", { project: "Factory", title: "Old spike A", status: "doing" });
    const old2 = await task("s2", { project: "Worklane", title: "Old spike B", status: "doing" });
    backdateActivity(old1.id, 12);
    backdateActivity(old2.id, 10);
  }
  if (quiet) {
    for (const [key, project] of [["q1", "Archive One"], ["q2", "Archive Two"]]) {
      await tool(url, "create_project", { name: project });
      const t = await task(key, { project, title: `${project} leftovers`, status: "doing" });
      backdateActivity(t.id, 10);
    }
  }
  if (level === "quietGoal") {
    const g = await tool(url, "create_goal", { project: "Archive One", name: "Dormant migration" });
    out.goals["Dormant migration"] = g.id;
    const t = await task("q3", {
      project: "Archive One",
      goal: "Dormant migration",
      title: "Cut over the old tenant",
      status: "doing",
    });
    backdateActivity(t.id, 10);
  }
  await announceDbChange();
  await $("[data-focus-goal]").waitForExist({ timeout: 10000 });
  return out;
}

const goalBlock = (id: number) => $(`[data-focus-goal="${id}"]`);

/** Scroll the sidebar's list to its end, so the rows under the goals show. */
async function scrollSidebarToEnd(): Promise<void> {
  await browser.execute(() => {
    const list = document.querySelector(".sidebar-scroll");
    if (list) list.scrollTop = list.scrollHeight;
  });
}

/**
 * Force a project row's hover reveal on or off. WebDriver's moveTo cannot drive CSS
 * :hover in this webview (see sessions.spec), so the shot forces the styles, and the
 * caller clears them again so the next shot does not show a hovered row. Returns the
 * number of hover-revealed buttons on the row.
 */
async function forceRowHover(project: string, on: boolean): Promise<number> {
  return browser.execute(
    (name: string, show: boolean) => {
      const row = [...document.querySelectorAll<HTMLElement>(".nav-project")].find(
        (r) => r.querySelector(".nav-label")?.textContent === name,
      );
      const actions = row?.querySelectorAll<HTMLElement>(".row-action") ?? [];
      actions.forEach((b) => {
        if (show) {
          b.style.transition = "none";
          b.style.opacity = "1";
        } else {
          // Snap back with no transition: this webview can leave a running
          // opacity transition stuck at 1, which a later shot would show.
          b.style.transition = "none";
          b.style.removeProperty("opacity");
          void getComputedStyle(b).opacity;
          b.style.removeProperty("transition");
        }
      });
      if (show) row?.style.setProperty("background", "var(--bg-hover)");
      else row?.style.removeProperty("background");
      return actions.length;
    },
    project,
    on,
  );
}

/** XPath of a project's "No goal" row: the nav-goals block follows the project row. */
const noGoalRow = (project: string) =>
  `//*[contains(@class,"nav-project")][.//*[contains(@class,"nav-label")][normalize-space()="${project}"]]` +
  `/following-sibling::div[1]//*[contains(@class,"nav-goal-none")]`;

describe("Focus sidebar", () => {
  beforeEach(async () => {
    await resetAppState();
  });

  it("focus lists moving goals", async () => {
    const s = await seed("focus");
    const [expenses, mobile, factory] = [
      s.goals["Expenses launch"],
      s.goals["Mobile driver fixes"],
      s.goals["Factory learns"],
    ];

    const order = await $$("[data-focus-goal]").map((el) => el.getAttribute("data-focus-goal"));
    expect(order).toHaveLength(3);
    expect(order.indexOf(String(expenses))).toBeLessThan(order.indexOf(String(mobile)));
    await expect($(".focus-section .section-header")).toHaveText(expect.stringContaining("3 goals"));

    // Expenses launch: needs-you pill, 1/5, three cards of five and "+2 more".
    const e = goalBlock(expenses);
    await expect(e.$(".focus-goal-name")).toHaveText("Expenses launch");
    await expect(e.$(".focus-goal-head .focus-you")).toHaveText("2");
    await expect(e.$(".focus-count")).toHaveText("1/5");
    await expect(e.$(".focus-goal-meta")).toHaveText("Worklane · Ready for first tenant");
    expect(await e.$$("[data-focus-card]")).toHaveLength(3);
    await expect(e.$(".focus-more")).toHaveText("+2 more");

    // Mobile driver fixes: one card left, no pill, the human card wears "you".
    const m = goalBlock(mobile);
    await expect(m.$(".focus-goal-meta")).toHaveText("Crestlink · 1 card left");
    expect(await m.$$(".focus-goal-head .focus-you")).toHaveLength(0);
    await expect(m.$("[data-focus-card] .focus-you")).toHaveText("you");

    // Factory learns: finished but open, waiting to be closed.
    const f = goalBlock(factory);
    await expect(f.$(".focus-count")).toHaveText("2/2 ✓");
    await expect(f.$(".focus-goal-meta")).toHaveText("Factory · close it?");

    // Loose doing cards: the agent one shows ◇, the human one "you".
    const rows = await $$(".focus-card.loose").map((el) => el.getText());
    expect(rows).toHaveLength(2);
    expect(rows.some((t) => t.includes("Why ui-check misses the map") && t.includes("◇"))).toBe(true);
    expect(rows.some((t) => t.includes("Call the carrier") && t.includes("you"))).toBe(true);

    await expect($('[data-nav="needs-you"] .focus-you')).toHaveText("2");
    expect(await $$('[data-nav="stalled"]')).toHaveLength(0);
    await shot("sidebar-focus");
    // The sidebar scrolls: the same state, past the goals.
    await scrollSidebarToEnd();
    await shot("sidebar-focus-lower");

    // A goal block opens the goal; a card opens the editor, not the goal.
    await m.scrollIntoView();
    await m.$(".focus-goal-head").click();
    await expect($(".view-title-sub")).toHaveText("Mobile driver fixes");
    await shot("sidebar-goal-click");
    await m.$("[data-focus-card]").click();
    await expect($('[aria-label="Task details"] .detail-breadcrumb-task')).toHaveText(
      "Restore the rig card",
    );
    await shot("sidebar-card-click");
  });

  it("needs you opens Mine", async () => {
    await seed("focus");
    await $('[data-nav="needs-you"]').click();
    await expect($('[data-nav="mine"]')).toHaveElementClass("active");
    // Mine is the active row, at the top of the list the click scrolled away from.
    await browser.execute(() => {
      const list = document.querySelector(".sidebar-scroll");
      if (list) list.scrollTop = 0;
    });
    await shot("sidebar-needs-you-click");
  });

  it("stalled expands oldest first", async () => {
    await seed("stalled");
    const row = $('[data-nav="stalled"]');
    await expect(row.$(".nav-count")).toHaveText("2");
    expect(await $$("[data-focus-stalled]")).toHaveLength(0);

    await row.click();
    const titles = await $$("[data-focus-stalled] .focus-card-title").map((el) => el.getText());
    expect(titles).toEqual(["Old spike A", "Old spike B"]);
    // Same anatomy as a loose row, but the marker is still: no pulse, no owner.
    expect(await $$("[data-focus-stalled] .focus-idle")).toHaveLength(2);
    expect(await $$("[data-focus-stalled] .focus-pulse")).toHaveLength(0);
    await scrollSidebarToEnd();
    await shot("sidebar-stalled-open");

    await $("[data-focus-stalled]").click();
    await expect($('[aria-label="Task details"] .detail-breadcrumb-task')).toHaveText("Old spike A");
    await shot("sidebar-stalled-click");
  });

  it("a finished goal with no recent move sorts last", async () => {
    const s = await seed("finishedStale");
    const order = await $$("[data-focus-goal]").map((el) => el.getAttribute("data-focus-goal"));
    expect(order).toHaveLength(4);
    expect(order[order.length - 1]).toBe(String(s.goals["Legacy cleanup"]));
    await expect(goalBlock(s.goals["Legacy cleanup"]).$(".focus-count")).toHaveText("2/2 ✓");
    await scrollSidebarToEnd();
    await shot("sidebar-finished-stale");
  });

  it("quiet fold hides projects with no move this week", async () => {
    await seed("quiet");
    const projects = await $$(".nav-project .nav-label").map((el) => el.getText());
    expect(projects.sort()).toEqual(["Crestlink", "Factory", "Worklane"]);

    const fold = $('[data-nav="quiet"]');
    await expect(fold).toHaveText("Quiet · 2 projects");
    await expect($(".nav-project*=Archive One")).not.toBeExisting();
    await scrollSidebarToEnd();
    await shot("sidebar-quiet-collapsed");

    // A project row shows its +goal and edit buttons on hover; the reveal is forced
    // on for the shot (see forceRowHover) and off again before the next one.
    const crest = $(".nav-project*=Crestlink");
    await expect(crest.$('[aria-label="New goal in Crestlink"]')).toBeExisting();
    await expect(crest.$('[aria-label="Edit Crestlink"]')).toBeExisting();
    expect(await forceRowHover("Crestlink", true)).toBe(2);
    await shot("sidebar-project-hover");
    await forceRowHover("Crestlink", false);

    await fold.click();
    await expect($(".nav-project*=Archive One")).toBeExisting();
    await expect($(".nav-project*=Archive Two")).toBeExisting();
    await shot("sidebar-quiet-open");

    // Selecting a quiet project pins the fold open: collapsing it does nothing.
    await $(".nav-project*=Archive One").click();
    await fold.click();
    await expect($(".nav-project*=Archive One")).toBeExisting();
  });

  it("selecting a quiet project from outside the fold opens it", async () => {
    await seed("quiet");
    await expect($(".nav-project*=Archive Two")).not.toBeExisting();

    // The command palette is the way in that does not go through the fold.
    await browser.keys(["Meta", "k"]);
    const input = $(".palette-input input");
    await input.waitForDisplayed({ timeout: 10000 });
    await input.setValue("Go to Archive Two");
    await browser.keys("Enter");
    await expect($(".view-title*=Archive Two")).toBeExisting();
    await expect($(".nav-project*=Archive Two")).toHaveElementClass("active");
    await expect($(".nav-project*=Archive One")).toBeExisting();
    await scrollSidebarToEnd();
    await shot("sidebar-quiet-auto-open");
  });

  it("selecting a quiet project's goal from outside the fold opens it", async () => {
    await seed("quietGoal");
    await expect($(".nav-project*=Archive One")).not.toBeExisting();

    // A goal chip on a card in All tasks is a way to a goal that skips the fold.
    await $("[data-nav=all]").click();
    const chip = $(".goal-chip*=Dormant migration");
    await chip.scrollIntoView();
    await chip.click();
    await expect($(".view-title-sub")).toHaveText("Dormant migration");
    await expect($('[data-nav="quiet"]')).toHaveAttribute("aria-expanded", "true");
    await expect($(".nav-goal*=Dormant migration")).toHaveElementClass("active");
    await scrollSidebarToEnd();
    await shot("sidebar-quiet-goal-auto-open");

    // A row inside the open fold keeps its goal chevron, +goal and edit controls.
    const archive = $(".nav-project*=Archive One");
    await expect(archive.$('[aria-label="Collapse Archive One goals"]')).toBeExisting();
    await expect(archive.$('[aria-label="New goal in Archive One"]')).toBeExisting();
    await expect(archive.$('[aria-label="Edit Archive One"]')).toBeExisting();
    expect(await forceRowHover("Archive One", true)).toBe(2);
    await shot("sidebar-quiet-row-controls");
    await forceRowHover("Archive One", false);
  });

  // No route reaches a quiet project's No goal list from outside the fold: the
  // palette lists projects only, selection is not restored at launch, and the home
  // view's chip lists projects that moved. So the project goes quiet under the
  // selection instead: the fold must open itself rather than drop the selected row.
  it("a project going quiet under its No goal list opens the fold", async () => {
    const s = await seed("focus");
    const noGoal = $(noGoalRow("Crestlink"));
    await noGoal.click();
    await expect(noGoal).toHaveElementClass("active");
    await expect($('[data-nav="quiet"]')).not.toExist();

    backdateActivity(s.refs.m1, 10);
    backdateActivity(s.refs.l2, 10);
    await announceDbChange();

    const fold = $('[data-nav="quiet"]');
    await fold.waitForExist({ timeout: 10000 });
    await expect(fold).toHaveText("Quiet · 1 project");
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect($(noGoalRow("Crestlink"))).toHaveElementClass("active");
    await scrollSidebarToEnd();
    await shot("sidebar-quiet-nogoal-auto-open");
  });

  it("an empty board says nothing moved", async () => {
    await $("[data-nav=all]").click();
    await expect($("[data-focus-empty]")).toHaveText("Nothing moved this week");
    expect(await $$("[data-focus-goal]")).toHaveLength(0);
    await shot("sidebar-empty");
  });
});
