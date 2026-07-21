import { browser, $, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { E2E_DB as DB } from "./support/dataDir.js";
import { clickInsertAction } from "./support/imageActions.js";

// The wdio runner is node, not bun, so bun:sqlite isn't importable here — drive
// the sqlite3 CLI instead. A separate connection to the same file is exactly
// what the MCP agent server is, which is the point: these writes reach the app
// the same way an agent's do.
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

/** Write notes behind the app's back, exactly as an agent does over MCP. */
function agentWritesNotes(title: string, notes: string): number {
  const id = taskIdByTitle(title);
  sql(`UPDATE tasks SET notes = ${q(notes)} WHERE id = ${id};`);
  return id;
}

function notesInDb(id: number): string {
  return sql(`SELECT notes FROM tasks WHERE id = ${id};`);
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

async function pasteImageInto(selector: string) {
  await browser.executeAsync((sel: string, done: (v: unknown) => void) => {
    const canvas = document.createElement("canvas");
    canvas.width = 20;
    canvas.height = 20;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#5645d4";
      ctx.fillRect(0, 0, 20, 20);
    }
    canvas.toBlob((blob) => {
      if (!blob) return done("no blob");
      const dt = new DataTransfer();
      dt.items.add(new File([blob], "embed.png", { type: "image/png" }));
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return done("no element");
      el.focus();
      el.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
      );
      done("ok");
    }, "image/png");
  }, selector);
}

const TITLE = "Embed probe task";

describe("notes image embeds", () => {
  before(async () => {
    await $("#root").waitForExist();
    const input = $(".quick-add input");
    await input.waitForExist();
    await input.setValue(TITLE);
    await pasteImageInto(".quick-add input");
    await $(".qa-image-chip").waitForExist({ timeout: 10000 });
    await browser.keys("Enter");
    await $(`.task-title*=${TITLE}`).waitForExist({ timeout: 10000 });
    await $(`.task-title*=${TITLE}`).click();
    await $(".detail-card").waitForExist();
    await $(".detail-image").waitForExist({ timeout: 10000 });
  });

  it("opens the lightbox when the inline embed is clicked", async () => {
    await clickInsertAction();

    const embed = $(".detail-notes-rendered img.md-image");
    await embed.waitForExist({ timeout: 10000 });
    await embed.click();
    await expect($(".lightbox-overlay")).toBeExisting();
    await browser.keys("Escape");
    await $(".lightbox-overlay").waitForExist({ reverse: true, timeout: 5000 });
  });

  it("keeps notes written by an agent while the card is open", async () => {
    // The bug: local notes state only re-synced on task switch, so the card
    // rendered a stale copy and the next blur wrote it back over the agent's
    // text. Reproduce the whole path — external write, reload, then a user edit.
    const id = agentWritesNotes(TITLE, "AGENT-WROTE-THIS");
    await announceDbChange();

    // The open card must show the new text, not the stale copy.
    await browser.waitUntil(
      async () => (await $(".detail-notes-rendered").getText()).includes("AGENT-WROTE-THIS"),
      { timeout: 10000, timeoutMsg: "open card never picked up the agent's notes" },
    );

    // Now the user clicks into the notes and clicks away — the old code wrote
    // the stale local copy back here, destroying the agent's text.
    await $(".detail-notes-rendered").click();
    await $("textarea.detail-notes").waitForDisplayed({ timeout: 5000 });
    await $(".detail-title-input, .detail-card").click();
    await browser.pause(300);

    expect(notesInDb(id)).toContain("AGENT-WROTE-THIS");
  });

  it("degrades a removed image to its alt text instead of a broken tile", async () => {
    // The previous test leaves the textarea open; the rendered view only exists
    // when it is closed.
    const textarea = $("textarea.detail-notes");
    if (await textarea.isExisting()) {
      await browser.execute(() =>
        (document.querySelector("textarea.detail-notes") as HTMLElement | null)?.blur(),
      );
      await textarea.waitForExist({ reverse: true, timeout: 5000 });
    }

    const id = agentWritesNotes(TITLE, "before\n\n![embed.png](tildone://img/99999)\n\nafter");
    await announceDbChange();
    await browser.waitUntil(
      async () =>
        (await $(".detail-notes-rendered").isExisting()) &&
        (await $(".detail-notes-rendered").getText()).includes("before"),
      { timeout: 10000, timeoutMsg: "rendered notes never showed the embed markdown" },
    );
    // 99999 is not an image on this task, which is the same state a removed
    // image leaves behind.
    await expect($(".md-image-missing")).toBeExisting();
    expect(await $(".detail-notes-rendered").getText()).toContain("embed.png");
    expect(notesInDb(id)).toContain("tildone://img/99999");
  });
});
