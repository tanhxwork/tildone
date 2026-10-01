import { browser, $, $$, expect } from "@wdio/globals";
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
    // The default Mine view renders task rows (.task-title), not board cards.
    await expect($(".task-title*=Smoke test task")).toBeExisting();
  });

  it("offers no Today, Upcoming, Inbox, My Week or Calendar view anywhere", async () => {
    mkdirSync("./.test-artifacts/screenshots", { recursive: true });
    const removed = ["Today", "Upcoming", "Inbox", "My Week"];

    await $(".nav-item*=Mine").click();
    const labels = await $$(".sidebar .nav-label").map((el) => el.getText());
    expect(labels).toEqual(expect.arrayContaining(["Mine", "Agent queue", "Observe", "All Tasks"]));
    for (const name of removed) expect(labels).not.toContain(name);
    await browser.saveScreenshot("./.test-artifacts/screenshots/remove-views-sidebar.png");

    const viewModes = async () =>
      $$('.segmented[aria-label="View mode"] button').map((el) => el.getAttribute("aria-label"));
    await $(".nav-item*=All Tasks").click();
    expect(await viewModes()).toEqual(["List view", "Board view", "Table view"]);

    await $('button[aria-label="New project"]').click();
    const nameField = $('.modal input[placeholder="Project name"]');
    await nameField.waitForDisplayed({ timeout: 10000 });
    await nameField.setValue("Views probe");
    await $(".modal-footer button.btn.primary").click();
    await $(".nav-project*=Views probe").click();
    await $(".view-title*=Views probe").waitForExist({ timeout: 10000 });
    expect(await viewModes()).toEqual(["List view", "Board view", "Table view"]);
    await browser.saveScreenshot("./.test-artifacts/screenshots/remove-views-project-header.png");

    await browser.keys(["Meta", "k"]);
    const input = $(".palette-input input");
    await input.waitForDisplayed({ timeout: 10000 });
    await input.setValue("go");
    const entries = await $$(".palette-item .palette-label").map((el) => el.getText());
    expect(entries).toContain("Go to All Tasks");
    for (const name of removed) expect(entries).not.toContain(`Go to ${name}`);
    expect(entries.some((e) => e.includes("Calendar"))).toBe(false);
    await browser.saveScreenshot("./.test-artifacts/screenshots/remove-views-palette.png");
    await browser.keys("Escape");
  });
});
