import { browser, $, expect } from "@wdio/globals";
import { mkdirSync } from "node:fs";

describe("Tildone smoke", () => {
  it("launches and renders the app shell", async () => {
    await $("#root").waitForExist();
    expect(await browser.getTitle()).toContain("Tildone");
  });

  it("adds a task through quick-add", async () => {
    // Fresh data dir shows the first-run overlay; localStorage may remember a
    // dismissal across runs, so treat it as optional.
    const overlay = $(".firstrun-overlay");
    if (await overlay.isExisting()) {
      await $(".firstrun-footer button.btn.primary").click();
      await overlay.waitForExist({ reverse: true });
    }

    const input = $(".quick-add input");
    await input.waitForExist();
    await input.setValue("Smoke test task");
    await browser.keys("Enter");
    await browser.pause(500);

    mkdirSync("./tests/e2e/artifacts", { recursive: true });
    await browser.saveScreenshot("./tests/e2e/artifacts/smoke.png");
    // The default Today view renders a list (.task-title), not board cards.
    await expect($(".task-title*=Smoke test task")).toBeExisting();
  });
});
