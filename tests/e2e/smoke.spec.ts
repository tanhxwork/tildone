import { browser, $, expect } from "@wdio/globals";
import { mkdirSync } from "node:fs";

describe("Tildone smoke", () => {
  it("launches and renders the app shell", async () => {
    await $("#root").waitForExist();
    expect(await browser.getTitle()).toContain("Tildone");
  });

  it("adds a task through quick-add", async () => {
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
