import { browser, $, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { E2E_DB as DB } from "./support/dataDir.js";

// Observe (spec 2026-10-01 observe section): observe cards are seeded through
// the app's real MCP server (create_observation, log_observation), as sessions
// would; the user decides in the app. Agents cannot decide, so the two Observed
// cards start Due and are decided here by clicking an option. The sqlite3 CLI
// only reads back what the app wrote.

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

/** Local YYYY-MM-DD, `offset` days from today: the app's "today" is local. */
function localDay(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const PROJECT = "Observe Lab";
const DUE_Q = "Do builders probe mid-build?";
const DATE_Q = "Verify cards looked at after collapse?";
const METER_Q = "Sonnet high vs Opus medium: builder cost";
const EMPTY_Q = "Done cards lost after 3 days?";
const KEPT_Q = "Agents set owner correctly";
const REV_Q = "Secretary on haiku";
const NEW_Q = "Does the badge get noticed?";
const FOLLOW_UP = `Revert to sonnet: ${REV_Q}`;

const SHOTS = ".test-artifacts/screenshots";

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
    clientInfo: { name: "observe-e2e", version: "1" },
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

/** Light then dark capture of the current screen, back to the system theme after. */
async function shotPair(name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ["light", "dark"]) {
    await browser.execute((t: string) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await browser.pause(300);
    await browser.saveScreenshot(`${SHOTS}/${name}-${theme}.png`);
  }
  await browser.execute(() => {
    delete document.documentElement.dataset.theme;
  });
}

const row = (question: string) => $(`.observe-row*=${question}`);
const inGroup = (group: string, question: string) =>
  $(`[data-observe-group="${group}"]`).$(`.observe-row*=${question}`);
const navBadge = () => $('[data-nav="observe"] .nav-due');

describe("observe", () => {
  const ids: Record<string, number> = {};
  const refs: Record<string, string> = {};
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
    const create = async (key: string, question: string, args: Record<string, unknown>) => {
      const receipt = await tool(url, "create_observation", {
        project: PROJECT,
        question,
        check: "grep -c -- --agent= ~/.factory/<repo>/<slug>/gates/*test-l*.log",
        ...args,
      });
      ids[key] = receipt.id as number;
      refs[key] = receipt.ref as string;
    };
    const log = async (key: string, verdicts: ("yes" | "no" | null)[]) => {
      for (const [i, verdict] of verdicts.entries()) {
        await tool(url, "log_observation", {
          task: ids[key],
          text: `delivery ${i + 1}: lane ${(i % 3) + 1}`,
          session_id: `${(0x7c1e + i * 911).toString(16)}-e2e`,
          ...(verdict ? { verdict } : {}),
        });
      }
    };
    const threeWay = [
      { label: "Keep as advice", detail: "Leave 0.5.12 as is." },
      { label: "Make mandatory", detail: "Gate fails a lane with no probe." },
      { label: "Revert", detail: "Drop the instruction from builder.md." },
    ];

    // observe-due: one due count card, 5/5 with mixed verdicts.
    await create("due", DUE_Q, {
      why: "0.5.12 tells builders to probe mid-build. Nothing forces it.",
      trigger_count: 5,
      trigger_unit: "deliveries",
      options: threeWay,
    });
    await log("due", ["yes", "no", "yes", "no", "yes"]);
    // Three waiting: a date, a 4/10 meter, and one with nothing logged.
    await create("date", DATE_Q, { trigger_date: localDay(2), options: threeWay.slice(0, 2) });
    await log("date", [null]);
    await create("meter", METER_Q, {
      trigger_count: 10,
      trigger_unit: "deliveries",
      options: threeWay,
    });
    await log("meter", [null, null, null, null]);
    await create("empty", EMPTY_Q, { trigger_date: localDay(7), options: threeWay.slice(0, 2) });
    // Two to be decided in the app: due now, observed after the click.
    await create("kept", KEPT_Q, {
      trigger_count: 3,
      options: [
        { label: "Keep", detail: "The default holds." },
        { label: "Tighten the rule", detail: "Spell it out in the instructions." },
        { label: "Revert", detail: "Back to agent by default." },
      ],
    });
    await log("kept", ["yes", "yes", "no"]);
    await create("rev", REV_Q, {
      trigger_count: 2,
      options: [
        { label: "Keep on haiku", detail: "Cheaper, good enough." },
        { label: "Revert to sonnet", detail: "Haiku drops batches." },
      ],
    });
    await log("rev", ["no", "no"]);
    await announceDbChange();
  });

  it("decides a due card into Observed and opens its follow-up", async () => {
    await $('[data-nav="observe"]').click();
    await expect(navBadge()).toHaveText("3 due");

    await row(KEPT_Q).click();
    await $(".observe-det").$("button.observe-opt*=Keep").click();
    await browser.waitUntil(
      () =>
        sql(
          `SELECT o.decision || '|' || t.status || '|' || (t.completed_at IS NOT NULL) FROM observe_cards o JOIN tasks t ON t.id = o.task_id WHERE t.id = ${ids.kept};`,
        ) === "0|done|1",
      { timeout: 10000, timeoutMsg: "decision not written" },
    );
    await expect(inGroup("observed", KEPT_Q)).toBeExisting();
    await expect($(".observe-det")).toHaveText(/Decision: Keep\. Yes in 2 of 3\./);
    await expect($(".observe-det .observe-toggle")).toHaveText("3 log lines");
    await expect($(".observe-det .observe-log")).not.toBeExisting();

    await row(REV_Q).click();
    await $(".observe-det").$("button.observe-opt*=Revert to sonnet").click();
    await expect(inGroup("observed", REV_Q)).toBeExisting();
    await $(".observe-det").$("button=Open follow-up task").click();
    await browser.waitUntil(
      () =>
        sql(
          `SELECT owner || '|' || project_id || '|' || title FROM tasks WHERE from_task_id = ${ids.rev};`,
        ) === `human|${sql(`SELECT id FROM projects WHERE name = ${q(PROJECT)};`)}|${FOLLOW_UP}`,
      { timeout: 10000, timeoutMsg: "follow-up task not written" },
    );
    const followRef = sql(`SELECT ref FROM tasks WHERE from_task_id = ${ids.rev};`);
    await expect($(".observe-det")).toHaveText(
      new RegExp(`Follow-up ${followRef} opened from this decision`),
    );
  });

  it("shows the due, waiting and observed states", async () => {
    // Leaving and coming back resets the selection to the first due card.
    await $('[data-nav="mine"]').click();
    await $('[data-nav="observe"]').click();
    await expect(navBadge()).toHaveText("1 due");
    await expect($(".observe-row.selected")).toHaveText(new RegExp(DUE_Q.replace("?", "\\?")));
    await expect($(".observe-det")).toHaveText(/Due · 5\/5 deliveries/);
    await expect($(".observe-det")).toHaveText(/Yes in 3 of 5/);
    await expect($(".observe-det .observe-dec")).toBeExisting();
    await shotPair("observe-due");

    await row(METER_Q).click();
    await expect($(".observe-det")).toHaveText(/Waiting · 4\/10 deliveries/);
    await expect($(".observe-det .observe-dec")).not.toBeExisting();
    await shotPair("observe-waiting");

    await row(REV_Q).click();
    await expect($(".observe-det .observe-log")).not.toBeExisting();
    await shotPair("observe-observed");
  });

  it("keeps observe cards off the project board; the follow-up names its card", async () => {
    await $(`.nav-project*=${PROJECT}`).click();
    await $('button[aria-label="Board view"]').click();
    const followUp = $(`.board-card*=${FOLLOW_UP}`);
    await followUp.waitForExist({ timeout: 10000 });
    await expect(followUp).toHaveText(new RegExp(`from ${refs.rev}`));
    for (const question of [DUE_Q, DATE_Q, METER_Q, EMPTY_Q, KEPT_Q]) {
      await expect($(`.board-card*=${question}`)).not.toBeExisting();
    }
  });

  it("watches three more, which returns the card to Waiting", async () => {
    await $('[data-nav="observe"]').click();
    await row(DUE_Q).click();
    await $(".observe-det").$("button=Watch 3 more").click();
    await browser.waitUntil(
      () => sql(`SELECT trigger_count FROM observe_cards WHERE task_id = ${ids.due};`) === "8",
      { timeout: 10000, timeoutMsg: "trigger_count not raised to 8" },
    );
    await expect(inGroup("waiting", DUE_Q)).toBeExisting();
    await expect(navBadge()).not.toBeExisting();
  });

  it("moves a card to Due when a session logs over MCP, without a reload", async () => {
    for (let i = 0; i < 3; i++) {
      const receipt = await tool(url, "log_observation", {
        task: refs.due,
        text: `late delivery ${i + 1}`,
        verdict: "yes",
      });
      expect(receipt.state).toBe(i === 2 ? "due" : "waiting");
    }
    // No announceDbChange here: the agent server's own change event must do it.
    await inGroup("due", DUE_Q).waitForExist({ timeout: 10000 });
    await expect(navBadge()).toHaveText("1 due");
  });

  it("creates a Waiting card from New observation", async () => {
    await $("button=New observation").click();
    const dialog = $(".observe-dialog");
    await dialog.waitForDisplayed({ timeout: 10000 });
    await dialog.$('input[name="question"]').setValue(NEW_Q);
    await dialog.$('textarea[name="why"]').setValue("The sidebar pill is the only signal.");
    await dialog.$('textarea[name="check"]').setValue("Did you open Observe because of the badge?");
    await dialog.$('input[name="trigger_count"]').setValue("3");
    await dialog.$('input[name="trigger_unit"]').setValue("days");
    await dialog.$('input[name="option_label_0"]').setValue("Keep the pill");
    await dialog.$('input[name="option_label_1"]').setValue("Add a notification");
    await shotPair("observe-new");

    await dialog.$("button=Create").click();
    await browser.waitUntil(
      () =>
        sql(
          `SELECT t.kind || '|' || t.owner || '|' || t.status || '|' || o.trigger_count || '|' || o.trigger_unit FROM tasks t JOIN observe_cards o ON o.task_id = t.id WHERE t.title = ${q(NEW_Q)};`,
        ) === "observe|human|todo|3|days",
      { timeout: 10000, timeoutMsg: "new observe card not written" },
    );
    await expect(inGroup("waiting", NEW_Q)).toBeExisting();
    await expect($(".observe-row.selected")).toHaveText(new RegExp(NEW_Q.replace("?", "\\?")));
  });

  it("lists a card trashed over MCP in Trash and restores it to Observe", async () => {
    // delete_task answers in plain text, not JSON, so call it without tool().
    const trash = await rpc(url, "tools/call", { name: "delete_task", arguments: { id: refs.empty } });
    expect(trash.error ?? trash.result?.isError ?? false).toBeFalsy();
    await row(EMPTY_Q).waitForExist({ timeout: 10000, reverse: true });
    await $(".nav-item*=Completed").click();
    await $("button*=Trash").click();
    const trashed = $(`.history-row*=${EMPTY_Q}`);
    await trashed.waitForExist({ timeout: 10000 });
    await trashed.$("button=Restore").click();
    await trashed.waitForExist({ timeout: 10000, reverse: true });
    await $('[data-nav="observe"]').click();
    await expect(inGroup("waiting", EMPTY_Q)).toBeExisting();
  });
});
