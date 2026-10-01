import { browser, $, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { E2E_DB as DB } from "./support/dataDir.js";
import { remount } from "./support/reset.js";

// Task owner (spec 2026-10-01): Mine is the fresh-install view, and a project
// board splits into a You lane over an Agents lane. Cards are seeded through
// the sqlite3 CLI, a second connection to the same file, which is what the MCP
// agent server is; the owner column is written explicitly so the spec does not
// depend on the MCP create default.

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

let seq = 0;
function seedTask(title: string, owner: string, status: string, projectId: number): number {
  seq += 1;
  const completed = status === "done" ? "datetime('now')" : "NULL";
  sql(
    `INSERT INTO tasks (project_id, title, due_date, status, position, priority, notes, completed_at, created_at, number, ref, owner)
     VALUES (${projectId}, ${q(title)}, NULL, ${q(status)}, ${seq}, 0, '', ${completed}, datetime('now'), ${9800 + seq}, 'OWN-${seq}', ${q(owner)});`,
  );
  return Number(sql(`SELECT id FROM tasks WHERE title = ${q(title)};`));
}

function tagTask(id: number, tag: string) {
  sql(`INSERT OR IGNORE INTO tags (name, color) VALUES (${q(tag)}, '#5645d4');`);
  sql(
    `INSERT INTO task_tags (task_id, tag_id)
     SELECT ${id}, id FROM tags WHERE LOWER(name) = ${q(tag)};`,
  );
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
      const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
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

  before(async () => {
    await $("#root").waitForExist();
    await $('button[aria-label="New project"]').click();
    const nameField = $('.modal input[placeholder="Project name"]');
    await nameField.waitForDisplayed({ timeout: 10000 });
    await nameField.setValue(PROJECT);
    await $(".modal-footer button.btn.primary").click();
    await $(`.nav-project*=${PROJECT}`).waitForExist({ timeout: 10000 });

    const projectId = Number(sql(`SELECT id FROM projects WHERE name = ${q(PROJECT)};`));
    ids.human = seedTask(HUMAN_TODO, "human", "todo", projectId);
    ids.agentTodo = seedTask(AGENT_TODO, "agent", "todo", projectId);
    ids.agentDoing = seedTask(AGENT_DOING, "agent", "doing", projectId);
    ids.agentVerify = seedTask(AGENT_VERIFY, "agent", "done", projectId);
    ids.humanBlocked = seedTask(HUMAN_BLOCKED, "human", "todo", projectId);
    ids.agentApprove = seedTask(AGENT_APPROVE, "agent", "todo", projectId);
    ids.agentDismiss = seedTask(AGENT_DISMISS, "agent", "todo", projectId);
    ids.agentTake = seedTask(AGENT_TAKE, "agent", "todo", projectId);
    sql(`UPDATE tasks SET from_task_id = ${ids.human} WHERE id IN (${ids.agentTodo}, ${ids.agentApprove});`);
    tagTask(ids.agentVerify, "human-verify");
    tagTask(ids.humanBlocked, "blocked");
    tagTask(ids.agentApprove, "needs-approval");
    tagTask(ids.agentDismiss, "needs-approval");
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
    await browser.saveScreenshot(".test-artifacts/screenshots/owner-mine.png");

    await $(".queue-strip").click();
    await expect($('[data-nav="queue"]')).toHaveElementClass("active");
    await expect($(`.queue-row*=${AGENT_APPROVE}`)).toHaveText(/from OWN-/);
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
    // Checking an agent's finished work is the user's job: it sits in You.
    await expect(you.$('[data-status="done"]').$(`.board-card*=${AGENT_VERIFY}`)).toBeExisting();
    await expect(agents.$(`.board-card*=${AGENT_VERIFY}`)).not.toBeExisting();

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
    await browser.saveScreenshot(".test-artifacts/screenshots/owner-board-lanes-collapsed.png");
  });
});
