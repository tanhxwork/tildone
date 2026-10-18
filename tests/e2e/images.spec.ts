import { browser, $, expect } from "@wdio/globals";
import { mkdirSync } from "node:fs";
import { clickInsertAction, pasteImageInto } from "./support/imageActions.js";

describe("task images", () => {
  before(async () => {
    await $("#root").waitForExist();
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
