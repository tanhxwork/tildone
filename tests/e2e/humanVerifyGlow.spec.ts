import { browser, $, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { E2E_DB as DB } from "./support/dataDir.js";

// Same seeding channel as notesEmbed.spec.ts: the sqlite3 CLI is a second
// connection to the same file, exactly what the MCP agent server is — these
// writes reach the app the way an agent's do.
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

// No punctuation in the titles — they feed wdio partial-text selectors, and a
// colon in the text breaks the compiled class+text selector.
const PINNED = "Glow shipped awaiting check";
const PLAIN = "Glow plain done card";

/** Seed what the agent-side close leaves behind: a done task tagged
 *  human-verify with an unticked verify: step, plus an untagged done control. */
function seedClosedCards() {
  sql(`INSERT OR IGNORE INTO tags (name, color) VALUES ('human-verify', '#5645d4');`);
  sql(
    `INSERT INTO tasks (project_id, title, due_date, status, position, priority, notes, completed_at, created_at, number, ref)
     VALUES (NULL, ${q(PINNED)}, NULL, 'done', -100, 0, '', datetime('now'), datetime('now'), 9901, 'E2E-9901');`,
  );
  sql(
    `INSERT INTO tasks (project_id, title, due_date, status, position, priority, notes, completed_at, created_at, number, ref)
     VALUES (NULL, ${q(PLAIN)}, NULL, 'done', -99, 0, '', datetime('now'), datetime('now'), 9902, 'E2E-9902');`,
  );
  sql(
    `INSERT INTO task_tags (task_id, tag_id)
     SELECT t.id, g.id FROM tasks t, tags g
     WHERE t.title = ${q(PINNED)} AND LOWER(g.name) = 'human-verify';`,
  );
  sql(
    `INSERT INTO subtasks (task_id, title, done, position)
     SELECT id, 'verify: the pinned card glows on the board', 0, 0
     FROM tasks WHERE title = ${q(PINNED)};`,
  );
}

function pinnedTagCount(): number {
  return Number(
    sql(
      `SELECT COUNT(*) FROM task_tags tt
       JOIN tasks t ON t.id = tt.task_id
       JOIN tags g ON g.id = tt.tag_id
       WHERE t.title = ${q(PINNED)} AND LOWER(g.name) = 'human-verify';`,
    ),
  );
}

describe("human-verify done glow", () => {
  before(async () => {
    // Fresh data dir shows the first-run overlay; localStorage may remember a
    // dismissal across runs, so treat it as optional (same as smoke).
    const overlay = $(".firstrun-overlay");
    if (await overlay.isExisting()) {
      await $(".firstrun-footer button.btn.primary").click();
      await overlay.waitForExist({ reverse: true });
    }
    seedClosedCards();
    await announceDbChange();
    // The board is where the Done column lives; All Tasks so no due-date filter
    // hides the seeded cards.
    await $("button.nav-item*=All Tasks").click();
    await $('button[aria-label="Board view"]').click();
    await $(".board").waitForExist();
  });

  after(async () => {
    // Leave the app the way later spec files expect to find it.
    await $('button[aria-label="List view"]').click();
    await $("button.nav-item*=Today").click();
  });

  it("pins the closed human-verify card above the Done window, under a Verify divider", async () => {
    const divider = $(".col-divider.verify-queue");
    await divider.waitForExist();
    expect(await divider.getText()).toContain("Verify · 1");

    // The pinned card renders full (verify counter in reach) with the state class.
    const pinned = $(".board-card.state-human-verify");
    await pinned.waitForExist();
    expect(await pinned.getText()).toContain(PINNED);
    expect(await pinned.$(".card-verify-count").getText()).toContain("0/1");

    // The untagged done card is on the board but not pinned and not glowing:
    // the queue counts exactly one card, and that card is the tagged one.
    await expect($(`.board-card*=${PLAIN}`)).toBeExisting();
    const glowing = await browser.$$(".board-card.state-human-verify");
    expect(glowing.length).toBe(1);

    mkdirSync("./tests/e2e/artifacts", { recursive: true });
    await browser.saveScreenshot("./tests/e2e/artifacts/human-verify-glow-pinned.png");
  });

  it("ticking the last verify step retires the tag and drops the pin", async () => {
    expect(pinnedTagCount()).toBe(1);

    // Tick in place through the card's popover — the user's gesture.
    await $(".board-card.state-human-verify .card-verify-count").click();
    const step = $(".verify-popover .verify-item");
    await step.waitForExist();
    await step.click();

    // The last tick retires the tag in the same gesture (store.toggleSubtask)…
    await browser.waitUntil(() => pinnedTagCount() === 0, {
      timeout: 5000,
      timeoutMsg: "human-verify tag was not retired by the last verify tick",
    });
    // …and the queue empties: no divider, no glow, the card settles into Today.
    await $(".col-divider.verify-queue").waitForExist({ reverse: true });
    await expect($(".board-card.state-human-verify")).not.toBeExisting();
    await expect($(`.board-card*=${PINNED}`)).toBeExisting();

    mkdirSync("./tests/e2e/artifacts", { recursive: true });
    await browser.saveScreenshot("./tests/e2e/artifacts/human-verify-glow.png");
  });
});
