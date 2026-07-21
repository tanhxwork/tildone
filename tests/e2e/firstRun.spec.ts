import { browser, $, expect } from "@wdio/globals";

/**
 * Onboarding coverage.
 *
 * This spec exists because the per-spec-file reset (support/reset.ts) pins
 * `tildone-first-run-dismissed` so every other spec opens on a usable screen —
 * which means nothing else in the suite ever renders the overlay again. Without
 * this file, "the first-run overlay works" stopped being tested the moment the
 * eight scattered dismissal blocks were deleted, and no failure anywhere would
 * have said so.
 *
 * So this is the one spec that deliberately puts the app *back* into the
 * first-run state. It is safe to do that here: the reset runs per spec file, so
 * whatever this leaves behind is cleared before the next one starts.
 */
const DISMISS_KEY = "tildone-first-run-dismissed";

/** Drop the dismissal and re-mount, so the app boots as it does on a fresh install. */
async function bootAsFirstRun(): Promise<void> {
  await browser.execute((key: string) => {
    localStorage.removeItem(key);
    (window as unknown as Record<string, unknown>).__tildoneAwaitingReload = true;
    setTimeout(() => location.reload(), 0);
  }, DISMISS_KEY);

  await browser.waitUntil(
    async () => {
      try {
        return (
          (await browser.execute(() => {
            const reloaded = !(window as unknown as Record<string, unknown>)
              .__tildoneAwaitingReload;
            return reloaded && !!document.querySelector("#root")?.firstElementChild;
          })) === true
        );
      } catch {
        return false;
      }
    },
    { timeout: 20000, timeoutMsg: "app did not re-mount into the first-run state" },
  );
}

describe("first run", () => {
  it("shows the onboarding overlay on a fresh install and dismisses it", async () => {
    await bootAsFirstRun();

    const overlay = $(".firstrun-overlay");
    await overlay.waitForExist({ timeout: 10000 });

    await $(".firstrun-footer button.btn.primary").click();
    await overlay.waitForExist({ reverse: true, timeout: 10000 });

    // Dismissal is durable, not just visual — that persisted flag is precisely
    // what reset.ts sets on every other spec's behalf.
    expect(await browser.execute((key: string) => localStorage.getItem(key), DISMISS_KEY)).toBe("1");

    // And the app underneath is usable, not merely un-obscured.
    await expect($(".quick-add input")).toBeExisting();
  });
});
