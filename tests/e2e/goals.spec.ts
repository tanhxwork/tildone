import { browser, $, $$, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { E2E_DB as DB } from "./support/dataDir.js";

// Exercises the goals feature (docs/specs/2026-08-20-goals-inside-projects.md)
// through the real UI end to end: create a goal, assign tasks to it, watch the
// sidebar and header band track live, delete it and see the tasks survive
// ungoaled, confirm an Inbox task offers no picker, and confirm the Goals page
// orders across projects with overdue first. The ordering fixture is seeded
// directly (a second sqlite3 connection, same channel every other e2e spec
// uses for setup that isn't the thing under test) so it isn't at the mercy of
// typing into a native date input.

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

function sql(statement: string): string {
  return execFileSync("sqlite3", ["-cmd", ".timeout 5000", DB, statement], {
    encoding: "utf8",
  }).trim();
}

function projectIdByName(name: string): number {
  const out = sql(`SELECT id FROM projects WHERE name = ${q(name)} LIMIT 1;`);
  if (!out) throw new Error(`no project titled ${name}`);
  return Number(out);
}

/** Tell the app the database changed, the way Rust does after an agent write —
 *  needed once a fixture goes in through the sqlite3 CLI rather than the UI. */
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

// No "Goal"/"Goals" substring in any fixture name — the sidebar's own "Goals"
// page link and "New goal"/"No goal" copy are matched with wdio's `*=`
// (contains) selector elsewhere in this file, and a fixture name containing
// that word would be a false match for those.
const PROJECT_A = "E2E Alpha";
const PROJECT_B = "E2E Beta";
const TASK_1 = "E2E task one";
const TASK_2 = "E2E task two";
const GOAL_NAME = "E2E ship it";
const INBOX_TASK = "E2E inbox task";
const OVERDUE_GOAL = "E2E overdue";
const FUTURE_GOAL = "E2E future";
const SHOT_GOAL = "E2E launch";
const SHOT_OUTCOME = "Every surface in this pass ships behind a flag, no exceptions.";

async function createProject(name: string) {
  await $('button[aria-label="New project"]').click();
  const nameField = $('.modal input[placeholder="Project name"]');
  await nameField.waitForDisplayed({ timeout: 10000 });
  await nameField.setValue(name);
  await $(".modal-footer button.btn.primary").click();
  await $(`.nav-project*=${name}`).waitForExist({ timeout: 10000 });
}

async function quickAdd(title: string) {
  const input = $(".quick-add input");
  await input.waitForExist();
  await input.setValue(title);
  await browser.keys("Enter");
  await $(`.task-title*=${title}`).waitForExist({ timeout: 10000 });
}

/** Open a task's editor by its title, from whatever list currently shows it. */
async function openTask(title: string) {
  await $(`.task-title*=${title}`).click();
  await $(".detail-card").waitForExist();
}

async function closeTask() {
  await $('button[aria-label="Close details"]').click();
  await $(".detail-card").waitForExist({ reverse: true, timeout: 10000 });
}

/**
 * `selectByVisibleText` is a no-op against this WKWebView WebDriver — it
 * resolves without error but never actually changes the control (option
 * click emulation on a native <select> is notoriously unreliable across
 * WebDriver implementations). Set the value and dispatch a real bubbling
 * "change" event instead, which is what React's select onChange listens for.
 */
async function selectGoalOption(visibleText: string) {
  await browser.execute((text: string) => {
    const select = document.querySelector('select[aria-label="Goal"]') as HTMLSelectElement | null;
    if (!select) throw new Error("no goal select on screen");
    const option = Array.from(select.options).find((o) => o.text === text);
    if (!option) throw new Error(`no goal option "${text}"`);
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, visibleText);
}

const ARTIFACTS_DIR = "./tests/e2e/artifacts";

/** Save a screenshot and fail loudly if the file never actually landed —
 *  saveScreenshot resolving is not proof of a written, non-empty PNG. */
async function shot(name: string) {
  const path = `${ARTIFACTS_DIR}/${name}`;
  await browser.saveScreenshot(path);
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error(`screenshot ${path} was not written, or is empty`);
  }
}

describe("goals", () => {
  before(async () => {
    await $("#root").waitForExist();
  });

  it("creates a goal in a project and assigns two tasks to it — sidebar and band read 0 / 2", async () => {
    await createProject(PROJECT_A);
    await $(`.nav-project*=${PROJECT_A}`).click();

    await quickAdd(TASK_1);
    await quickAdd(TASK_2);

    // The "+" row-action on the project row — reachable even before the
    // project has any goal, since the chevron/nested list only appear once
    // one exists (spec: "only when it has ≥1 open goal").
    await $(`button[aria-label="New goal in ${PROJECT_A}"]`).click();
    const goalName = $('.modal input[placeholder="Goal name"]');
    await goalName.waitForDisplayed({ timeout: 10000 });
    await goalName.setValue(GOAL_NAME);
    await $(".modal-footer button.btn.primary").click();

    // addGoal selects the new goal, so the band should already be up.
    await $(".goal-band").waitForExist({ timeout: 10000 });
    expect(await $(".goal-band-name").getText()).toContain(GOAL_NAME);

    // Back to the project's task list to assign both tasks via the editor's
    // goal picker (surface A4) — neither is in the goal yet.
    await $(`.nav-project*=${PROJECT_A}`).click();
    for (const title of [TASK_1, TASK_2]) {
      await openTask(title);
      await $('select[aria-label="Goal"]').waitForExist();
      await selectGoalOption(GOAL_NAME);
      await closeTask();
    }

    // Sidebar row: colour glyph, name, open count.
    const sidebarRow = $(`.nav-goal*=${GOAL_NAME}`);
    await sidebarRow.waitForExist();
    await browser.waitUntil(
      async () => (await sidebarRow.$(".nav-count").getText()) === "2",
      { timeout: 10000, timeoutMsg: "sidebar goal row never reached count 2" },
    );

    // The band, selected fresh (not the stale one from creation).
    await sidebarRow.click();
    await $(".goal-band").waitForExist();
    await expect($(".goal-band-count")).toHaveText("0 / 2");
  });

  it("refuses a duplicate goal name and leaves the dialog open with the error", async () => {
    await $(`button[aria-label="New goal in ${PROJECT_A}"]`).click();
    const goalName = $('.modal input[placeholder="Goal name"]');
    await goalName.waitForDisplayed({ timeout: 10000 });
    await goalName.setValue(GOAL_NAME);
    await $(".modal-footer button.btn.primary").click();

    const error = $(".field-error");
    await error.waitForExist({ timeout: 10000 });
    expect(await error.getText()).toContain(GOAL_NAME);
    // Not adopted — the dialog is still up, still in create mode.
    await expect($(".modal")).toBeExisting();
    await expect($(".modal-header h2")).toHaveText("New Goal");

    await $("button*=Cancel").click();
    await $(".modal").waitForExist({ reverse: true, timeout: 10000 });

    // The duplicate attempt didn't touch the real goal — band unaffected.
    await $(".goal-band").waitForExist();
    await expect($(".goal-band-count")).toHaveText("0 / 2");
  });

  it("completing one of the goal's tasks updates the band live, no reload", async () => {
    // Still on the goal view from the previous test (selection persists).
    await $(".goal-band").waitForExist();
    await expect($(".goal-band-count")).toHaveText("0 / 2");

    await $(`.task-row*=${TASK_1}`).$(".task-check").click();

    await browser.waitUntil(
      async () => (await $(".goal-band-count").getText()) === "1 / 2",
      { timeout: 10000, timeoutMsg: "goal band did not update to 1 / 2 after completing a task" },
    );
  });

  it("deleting the goal leaves both tasks in place, now ungoaled", async () => {
    await $('button[aria-label="Edit goal"]').click();
    await $(".modal-footer").waitForDisplayed({ timeout: 10000 });
    await $("button*=Delete goal").click();
    await $("button*=Tasks stay").click();

    // Deleting the goal returns to the project view (store.removeGoal), and
    // the goal — the project's only one — takes the whole nested section with
    // it: no chevron, no goal rows, nothing left to show a moved count in.
    await $(".goal-band").waitForExist({ reverse: true, timeout: 10000 });
    await expect($$(".nav-goals")).toBeElementsArrayOfSize(0);

    // Both tasks survive at the DB level...
    const surviving = Number(
      sql(
        `SELECT COUNT(*) FROM tasks WHERE title IN (${q(TASK_1)}, ${q(TASK_2)}) AND deleted_at IS NULL;`,
      ),
    );
    expect(surviving).toBe(2);

    // ...and the still-open one (TASK_1 was completed above and is hidden by
    // the default "hide completed" filter) shows "No goal" in its own picker.
    await openTask(TASK_2);
    await expect($('select[aria-label="Goal"]')).toHaveValue("");
    await closeTask();
  });

  it("offers no goal picker on an Inbox task", async () => {
    await $(".nav-item*=Inbox").click();
    await quickAdd(INBOX_TASK);
    await openTask(INBOX_TASK);
    expect(await $('select[aria-label="Goal"]').isExisting()).toBe(false);
    await closeTask();
  });

  it("lists goals from more than one project on the Goals page, overdue first", async () => {
    await createProject(PROJECT_B);

    sql(
      `INSERT INTO goals (project_id, name, target_date, created_at)
       VALUES (${projectIdByName(PROJECT_A)}, ${q(OVERDUE_GOAL)}, '2020-01-01', datetime('now'));`,
    );
    sql(
      `INSERT INTO goals (project_id, name, target_date, created_at)
       VALUES (${projectIdByName(PROJECT_B)}, ${q(FUTURE_GOAL)}, '2099-01-01', datetime('now'));`,
    );
    await announceDbChange();

    await $(".nav-item*=Goals").click();
    await $(".goals-view").waitForExist();
    await $(`.goal-row-name*=${OVERDUE_GOAL}`).waitForExist({ timeout: 10000 });

    const names: string[] = [];
    for (const row of await $$(".goal-row-name")) names.push(await row.getText());
    const overdueIndex = names.findIndex((n) => n.includes(OVERDUE_GOAL));
    const futureIndex = names.findIndex((n) => n.includes(FUTURE_GOAL));
    expect(overdueIndex).toBeGreaterThanOrEqual(0);
    expect(futureIndex).toBeGreaterThanOrEqual(0);
    expect(overdueIndex).toBeLessThan(futureIndex);

    // Each carries its own project, proving the page spans more than one.
    const overdueRow = $(`.goal-row*=${OVERDUE_GOAL}`);
    const futureRow = $(`.goal-row*=${FUTURE_GOAL}`);
    expect(await overdueRow.$(".goal-row-project").getText()).toContain(PROJECT_A);
    expect(await futureRow.$(".goal-row-project").getText()).toContain(PROJECT_B);

    // Overdue reads in the doing hue via the "late" modifier class.
    await expect(overdueRow.$(".goal-row-when")).toHaveElementClass("late");
    await expect(futureRow.$(".goal-row-when")).not.toHaveElementClass("late");
  });

  it("captures screenshots of the goal surfaces for visual review", async () => {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });

    // A second goal in Project A, with tasks spread across both goals plus one
    // left ungoaled, so the sidebar shot shows two counted goal rows and a
    // nonzero "No goal" row together — not just whatever the earlier tests
    // happened to leave behind.
    const projectAId = projectIdByName(PROJECT_A);
    const overdueGoalId = Number(sql(`SELECT id FROM goals WHERE name = ${q(OVERDUE_GOAL)};`));
    sql(
      `INSERT INTO goals (project_id, name, notes, color, target_date, created_at)
       VALUES (${projectAId}, ${q(SHOT_GOAL)}, ${q(SHOT_OUTCOME)}, '#1aae39', '2099-06-01', datetime('now'));`,
    );
    const shotGoalId = Number(sql(`SELECT id FROM goals WHERE name = ${q(SHOT_GOAL)};`));
    const now = new Date().toISOString();
    sql(
      `INSERT INTO tasks (project_id, goal_id, title, status, position, priority, notes, created_at)
       VALUES (${projectAId}, ${shotGoalId}, ${q("E2E shot task a")}, 'todo', 10, 0, '', ${q(now)});`,
    );
    sql(
      `INSERT INTO tasks (project_id, goal_id, title, status, position, priority, notes, completed_at, created_at)
       VALUES (${projectAId}, ${shotGoalId}, ${q("E2E shot task b")}, 'done', 11, 0, '', ${q(now)}, ${q(now)});`,
    );
    sql(
      `INSERT INTO tasks (project_id, goal_id, title, status, position, priority, notes, created_at)
       VALUES (${projectAId}, ${overdueGoalId}, ${q("E2E shot task c")}, 'todo', 12, 0, '', ${q(now)});`,
    );
    sql(
      `INSERT INTO tasks (project_id, goal_id, title, status, position, priority, notes, created_at)
       VALUES (${projectAId}, NULL, ${q("E2E shot task d")}, 'todo', 13, 0, '', ${q(now)});`,
    );
    await announceDbChange();

    await $(`.nav-project*=${PROJECT_A}`).click();
    await $(`.nav-goal*=${SHOT_GOAL}`).waitForExist({ timeout: 10000 });

    await shot("goals-sidebar.png");

    // The dark/light pair — cheap, and docs/DESIGN.md requires both themes
    // work, so it's worth seeing rather than assuming.
    await browser.execute(() => {
      document.documentElement.dataset.theme = "light";
    });
    await shot("goals-sidebar-light.png");
    await browser.execute(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await shot("goals-sidebar-dark.png");
    await browser.execute(() => {
      delete document.documentElement.dataset.theme;
    });

    // Band: a goal carrying an outcome, a target date and a part-done count.
    await $(`.nav-goal*=${SHOT_GOAL}`).click();
    await $(".goal-band").waitForExist();
    await shot("goals-band.png");

    // Page: goals from more than one project, one overdue — still true from
    // the ordering test above (OVERDUE_GOAL/FUTURE_GOAL are still on the board).
    await $(".nav-item*=Goals").click();
    await $(".goals-view").waitForExist();
    await $(`.goal-row-name*=${SHOT_GOAL}`).waitForExist({ timeout: 10000 });
    await shot("goals-page.png");
  });
});
