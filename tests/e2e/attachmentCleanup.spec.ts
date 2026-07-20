import { browser, $, expect } from "@wdio/globals";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The e2e build's own app-data dir (identifier com.tildone.e2e). Asserting on
 *  real files here is the whole point: TIL-112 is about bytes on disk, and the
 *  UI cannot show whether they are gone. */
const ATTACHMENTS = join(
  homedir(),
  "Library/Application Support/com.tildone.e2e/attachments",
);

function attachmentDirs(): string[] {
  if (!existsSync(ATTACHMENTS)) return [];
  return readdirSync(ATTACHMENTS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/** Paste a generated PNG into an element, the way ⌘V does. */
async function pasteImageInto(selector: string) {
  await browser.executeAsync((sel: string, done: (v: unknown) => void) => {
    const canvas = document.createElement("canvas");
    canvas.width = 24;
    canvas.height = 24;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#5645d4";
      ctx.fillRect(0, 0, 24, 24);
    }
    canvas.toBlob((blob) => {
      if (!blob) return done("no blob");
      const dt = new DataTransfer();
      dt.items.add(new File([blob], "cleanup.png", { type: "image/png" }));
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

describe("attachment cleanup on hard delete", () => {
  let baseline: string[] = [];

  // The last-viewed selection is persisted to localStorage and survives into the
  // next spec file's app launch, so a spec that ends on Completed leaves every
  // later spec looking at a view with no Quick Add. Always hand the app back on
  // Today.
  after(async () => {
    const today = $(".nav-item*=Today");
    if (await today.isExisting()) await today.click();
  });

  before(async () => {
    await $("#root").waitForExist();
    const overlay = $(".firstrun-overlay");
    if (await overlay.isExisting()) {
      await $(".firstrun-footer button.btn.primary").click();
      await overlay.waitForExist({ reverse: true });
    }
  });

  it("writes an attachment directory when an image is attached", async () => {
    baseline = attachmentDirs();
    const input = $(".quick-add input");
    await input.waitForExist();
    await input.setValue("Cleanup probe task");
    await pasteImageInto(".quick-add input");
    await $(".qa-image-chip").waitForExist({ timeout: 10000 });
    await browser.keys("Enter");
    await expect($(".task-title*=Cleanup probe task")).toBeExisting();

    await browser.waitUntil(() => attachmentDirs().length === baseline.length + 1, {
      timeout: 10000,
      timeoutMsg: "no new attachment directory appeared on disk",
    });
  });

  it("removes the files the moment the trash is emptied, not on next launch", async () => {
    // Trash the task.
    await $(".task-title*=Cleanup probe task").click();
    await $(".detail-card").waitForExist();
    await $("button*=Delete task").click();
    await $("button*=Move to trash").click();
    await $(".detail-card").waitForExist({ reverse: true, timeout: 10000 });

    // Trashing alone must NOT delete the files — the task is still restorable.
    expect(attachmentDirs().length).toBe(baseline.length + 1);

    // Completed view -> Trash tab -> Empty trash (two clicks: it arms first).
    await $(".nav-item*=Completed").click();
    await $(".completed-view").waitForExist();
    await $("button*=Trash").click();
    const empty = $("button*=Empty trash");
    await empty.waitForDisplayed({ timeout: 10000 });
    await empty.click();
    await $("button*=Really delete forever").click();

    await browser.waitUntil(() => attachmentDirs().length === baseline.length, {
      timeout: 10000,
      timeoutMsg: "attachment directory survived Empty trash",
    });
  });

  it("removes the files when the whole project is deleted", async () => {
    // Deleting a project hard-deletes its tasks by FK cascade, so nothing goes
    // through the trash at all — a separate path from the test above, and the
    // one that was shipped on code-reading alone.
    await $(".nav-item*=Today").click();
    const start = attachmentDirs();

    await $('button[aria-label="New project"]').click();
    const nameField = $('.modal input[placeholder="Project name"]');
    await nameField.waitForDisplayed({ timeout: 10000 });
    await nameField.setValue("Cascade probe");
    await $(".modal-footer button.btn.primary").click();
    await $(".nav-project*=Cascade probe").waitForExist({ timeout: 10000 });

    // Put a task with an image inside it.
    await $(".nav-project*=Cascade probe").click();
    const input = $(".quick-add input");
    await input.waitForExist();
    await input.setValue("Cascade probe task");
    await pasteImageInto(".quick-add input");
    await $(".qa-image-chip").waitForExist({ timeout: 10000 });
    await browser.keys("Enter");
    await browser.waitUntil(() => attachmentDirs().length === start.length + 1, {
      timeout: 10000,
      timeoutMsg: "no attachment directory appeared for the project task",
    });

    // Delete the project, tasks and all.
    // wdio's *= text selector can't take a descendant, so target the edit button
    // by its aria-label rather than by nesting it under the project row.
    await $('button[aria-label="Edit Cascade probe"]').click();
    await $(".modal-footer").waitForDisplayed({ timeout: 10000 });
    await $("button*=Delete").click();
    await $("button*=Delete project and its tasks").click();

    await browser.waitUntil(() => attachmentDirs().length === start.length, {
      timeout: 10000,
      timeoutMsg: "attachment directory survived deleting the project",
    });
  });
});
