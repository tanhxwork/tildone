import { browser, $, $$, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { E2E_DB as DB } from "./support/dataDir.js";

// Evidence links resolve against the *filesystem*, so this spec puts real files
// on disk and a real claim in the database — the same two things an agent
// leaves behind — and then clicks what the notes say.

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

function sql(statement: string): string {
  return execFileSync("sqlite3", ["-cmd", ".timeout 5000", DB, statement], {
    encoding: "utf8",
  }).trim();
}

function taskIdByTitle(title: string): number {
  const out = sql(`SELECT id FROM tasks WHERE title = ${q(title)} LIMIT 1;`);
  if (!out) throw new Error(`no task titled ${title}`);
  return Number(out);
}

function agentWritesNotes(id: number, notes: string) {
  sql(`UPDATE tasks SET notes = ${q(notes)} WHERE id = ${id};`);
}

/** A claim is what supplies the working directory a relative path hangs off. */
function agentClaims(id: number, cwd: string) {
  sql(
    `INSERT OR REPLACE INTO agent_claims
       (session_id, task_id, cwd, branch, agent_name, claimed_at, last_pid)
     VALUES ('e2e-evidence-session', ${id}, ${q(cwd)}, 'worktree-e2e', 'claude',
             strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL);`,
  );
}

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

async function showNotes(id: number, notes: string) {
  agentWritesNotes(id, notes);
  await announceDbChange();
  await browser.waitUntil(
    async () =>
      (await $(".detail-notes-rendered").isExisting()) &&
      (await $(".detail-notes-rendered").getText()).includes(MARKER),
    { timeout: 10000, timeoutMsg: "rendered notes never showed the evidence block" },
  );
}

// A 1x1 png — the lightbox only has to receive bytes it can decode.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// Under $HOME on purpose: that is the boundary read_evidence_image enforces,
// and a fixture outside it would be refused (as it should be).
const ROOT = join(homedir(), ".tildone-e2e-evidence");
const SHOTS = join(ROOT, "shots");
const TITLE = "Evidence probe task";
const MARKER = "EVIDENCE-BLOCK";

describe("evidence links", () => {
  let taskId = 0;

  before(async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, "shot-light.png"), PNG);
    writeFileSync(join(SHOTS, "shot-dark.png"), PNG);
    mkdirSync(join(ROOT, "docs"), { recursive: true });
    writeFileSync(join(ROOT, "docs", "report.md"), "# report\n");

    await $("#root").waitForExist();
    const input = $(".quick-add input");
    await input.waitForExist();
    await input.setValue(TITLE);
    await browser.keys("Enter");
    await $(`.task-title*=${TITLE}`).waitForExist({ timeout: 10000 });
    await $(`.task-title*=${TITLE}`).click();
    await $(".detail-card").waitForExist();

    taskId = taskIdByTitle(TITLE);
    agentClaims(taskId, ROOT);
  });

  after(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  it("opens a screenshot named by a relative path in the lightbox", async () => {
    await showNotes(taskId, `${MARKER}\n\nscreenshots: shots/shot-light.png`);

    const link = $(".detail-notes-rendered a.md-evidence");
    await link.waitForExist({ timeout: 10000 });
    expect(await link.getText()).toContain("shots/shot-light.png");

    await link.click();
    await $(".lightbox-overlay").waitForExist({ timeout: 10000 });
    await browser.keys("Escape");
    await $(".lightbox-overlay").waitForExist({ reverse: true, timeout: 5000 });
  });

  it("opens a brace set as one gallery", async () => {
    await showNotes(taskId, `${MARKER}\n\nscreenshots: shots/shot-{light,dark}.png`);

    const link = $(".detail-notes-rendered a.md-evidence");
    await link.waitForExist({ timeout: 10000 });
    expect(await link.getText()).toContain("×2");

    await link.click();
    await $(".lightbox-overlay").waitForExist({ timeout: 10000 });
    // Both shots are in the viewer, so it offers its stepper.
    await expect($(".lightbox-count")).toHaveText("1 / 2");
    await browser.keys("Escape");
    await $(".lightbox-overlay").waitForExist({ reverse: true, timeout: 5000 });
  });

  it("links a document without previewing it, and leaves code and climbs as prose", async () => {
    await showNotes(
      taskId,
      `${MARKER}\n\ndoc: docs/report.md\ncode: src/main.tsx\nclimb: ../outside/secret.md`,
    );
    await $(".detail-notes-rendered a.md-evidence").waitForExist({ timeout: 10000 });

    const texts: string[] = [];
    const titles: string[] = [];
    for (const link of await $$(".detail-notes-rendered a.md-evidence")) {
      texts.push(await link.getText());
      titles.push((await link.getAttribute("title")) ?? "");
    }
    expect(texts.some((t) => t.includes("docs/report.md"))).toBe(true);
    expect(texts.some((t) => t.includes("main.tsx"))).toBe(false);
    expect(texts.some((t) => t.includes("secret.md"))).toBe(false);

    // No click here on purpose: opening it would launch the user's editor.
    expect(titles[texts.findIndex((t) => t.includes("docs/report.md"))]).toContain(
      "default app",
    );
  });

  it("leaves a sha inert when the task names no repo", async () => {
    await showNotes(taskId, `${MARKER}\n\ncommit: e4548660`);
    const inert = $(".detail-notes-rendered .md-evidence-inert");
    await inert.waitForExist({ timeout: 10000 });
    expect(await inert.getText()).toContain("e4548660");
    expect(await $(".detail-notes-rendered a.md-evidence").isExisting()).toBe(false);
  });

  it("links a sha to the repo once the task carries a repo link", async () => {
    sql(
      `INSERT INTO task_links (task_id, url, label, kind, created_at)
       VALUES (${taskId}, 'https://github.com/tanhxwork/tildone/pull/84', 'PR #84', 'pr',
               strftime('%Y-%m-%dT%H:%M:%fZ','now'));`,
    );
    await showNotes(taskId, `${MARKER}\n\ncommit: e4548660 landed in #84`);

    await browser.waitUntil(
      async () => (await $$(".detail-notes-rendered a.md-evidence")).length >= 2,
      { timeout: 10000, timeoutMsg: "sha and pr never resolved to links" },
    );
    const hrefs: (string | null)[] = [];
    for (const link of await $$(".detail-notes-rendered a.md-evidence")) {
      hrefs.push(await link.getAttribute("href"));
    }
    expect(hrefs).toContain("https://github.com/tanhxwork/tildone/commit/e4548660");
    expect(hrefs).toContain("https://github.com/tanhxwork/tildone/pull/84");
  });
});
