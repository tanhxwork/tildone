import { browser, $, expect } from "@wdio/globals";
import { mkdirSync } from "node:fs";

// Settings → Agent access → Command-line tool. e2e builds are debug builds, which
// ship no tildone-axi beside the executable, so the row must say so instead of
// offering a button that cannot work.

const SHOTS = "./.test-artifacts/screenshots";

describe("settings: command-line tool", () => {
  before(async () => {
    await $("#root").waitForExist();
  });

  it("says the CLI is not bundled in a build that does not ship it", async () => {
    await $(".nav-item*=Settings").click();
    const row = $(".settings-row*=Command-line tool");
    await row.waitForExist();
    await row.scrollIntoView();

    expect(await row.getText()).toContain("Not bundled in this build");
    expect(await row.$$("button")).toHaveLength(0);

    mkdirSync(SHOTS, { recursive: true });
    await browser.saveScreenshot(`${SHOTS}/settings-cli-not-bundled.png`);
  });
});
