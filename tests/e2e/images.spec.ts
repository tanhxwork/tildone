import { browser, $, expect } from "@wdio/globals";
import { mkdirSync } from "node:fs";
import { clickInsertAction } from "./support/imageActions.js";

/** Paste a small generated PNG into an element, the way ⌘V does. A real
 *  clipboard can't be primed from WebDriver, but the app only ever reads
 *  `clipboardData.items`, so a constructed DataTransfer exercises the same path. */
async function pasteImageInto(selector: string) {
  await browser.executeAsync((sel: string, done: (v: unknown) => void) => {
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 30;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#5645d4";
      ctx.fillRect(0, 0, 40, 30);
    }
    canvas.toBlob((blob) => {
      if (!blob) return done("no blob");
      const file = new File([blob], "e2e-shot.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
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

describe("task images", () => {
  before(async () => {
    await $("#root").waitForExist();
    const overlay = $(".firstrun-overlay");
    if (await overlay.isExisting()) {
      await $(".firstrun-footer button.btn.primary").click();
      await overlay.waitForExist({ reverse: true });
    }
  });

  it("declares Quick Add as an OS file-drop target", async () => {
    // The native drag itself can't be synthesised from WebDriver; this proves the
    // surface opted in, which is what the drop router hit-tests against.
    await expect($('.quick-add[data-drop-target="quick-add"]')).toBeExisting();
  });

  it("pastes an image into Quick Add and attaches it on Enter", async () => {
    const input = $(".quick-add input");
    await input.waitForExist();
    await input.setValue("Image embed task");
    await pasteImageInto(".quick-add input");

    await $(".qa-image-chip").waitForExist({ timeout: 10000 });
    await browser.keys("Enter");
    await expect($(".task-title*=Image embed task")).toBeExisting();
  });

  it("shows the image on the open card and can embed it in the notes", async () => {
    await $(".task-title*=Image embed task").click();
    const card = $(".detail-card");
    await card.waitForExist();
    await expect($('.detail-card[data-drop-target="task-editor"]')).toBeExisting();

    const tile = $(".detail-image");
    await tile.waitForExist({ timeout: 10000 });
    // Reveal is hover/focus-driven and WKWebView drops :focus-within when the
    // window loses OS focus — see tests/e2e/support/imageActions.ts (TIL-147).
    await clickInsertAction();

    // The embed must resolve to a real asset URL, not the tildone:img sentinel.
    const embed = $(".detail-notes-rendered img.md-image");
    await embed.waitForExist({ timeout: 10000 });
    const src = await embed.getAttribute("src");
    expect(src).not.toContain("tildone:");

    mkdirSync("./tests/e2e/artifacts", { recursive: true });
    await browser.saveScreenshot("./tests/e2e/artifacts/image-embed.png");
  });
});
