import { browser, $, expect } from "@wdio/globals";

// Runs inside the app's own webview (withGlobalTauri in the e2e overlay).
async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return browser.execute(
    (c, a) =>
      (window as unknown as { __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<unknown> } } })
        .__TAURI__.core.invoke(c, a),
    cmd,
    args,
  ) as Promise<T>;
}

interface HostSession {
  id: number;
  adapter_id: string;
  exited: boolean;
}

// The root CSS var the board strip reads to stop underlapping the fixed pane.
async function paneInset(): Promise<string> {
  return browser.execute(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--pane-inset").trim(),
  );
}

describe("terminal divider — show/hide handle", () => {
  it("collapses to a peek tab and reopens at the same width", async () => {
    await $("#root").waitForExist();

    // Spawn a live shell session so the pane is open (same path a user takes).
    await $('button[aria-label="New session"]').click();
    await $(".sess-new").waitForExist();
    await $(".sess-new-cwd").setValue("/tmp");
    const shellAdapter = $(".sess-new-adapter*=Shell");
    await shellAdapter.waitForExist();
    await shellAdapter.click();

    const pane = $(".session-pane");
    await pane.waitForExist();

    // Open state: handle present + expanded, no peek tab, task strip inset to
    // the full pane width.
    const toggle = $(".session-pane-toggle");
    await expect(toggle).toBeExisting();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect($(".session-pane-peek")).not.toBeExisting();

    const openInset = await paneInset();
    expect(openInset.endsWith("vw")).toBe(true);
    const openWidth = (await pane.getSize()).width;
    expect(openWidth).toBeGreaterThan(0);

    // Collapse via the handle.
    await toggle.click();
    await expect(pane).toHaveElementClass("session-pane--collapsed");
    await expect(pane).toHaveAttribute("aria-hidden", "true");
    // inert keeps the hidden pane's buttons/terminal out of the tab order.
    await expect(pane).toHaveAttribute("inert");
    const peek = $(".session-pane-peek");
    await expect(peek).toBeExisting();
    await expect(peek).toHaveAttribute("aria-expanded", "false");
    // The board reclaims the FULL width on collapse: the reopen control is a
    // compact tab floating over the right edge (TIL-159/160, made a floating
    // tab in 964f73e/e41dfe6), so it reserves no gutter — inset is 0px, not the
    // old 34px docked-rail footprint. (This assertion had gone stale against
    // that redesign and was failing on main; TIL-166.)
    expect(await paneInset()).toBe("0px");
    // The pane actually slides off the right edge (not just reclassed): its
    // left edge clears the viewport.
    //
    // Read the TARGET, not the animation. Waiting for the 340ms transition to
    // settle looks reasonable and is not: a webview that is not being
    // composited — the app window occluded, or simply never brought frontmost,
    // which is the normal state when this spec runs on its own — does not
    // advance CSS transitions at all, so the poll burns its whole timeout and
    // reports a layout bug that is not there. Killing the transition inline
    // makes the computed geometry the end state immediately, whoever is
    // frontmost. Same fix as the sessions-spec reveal read (TIL-170).
    const offRight = await browser.execute(() => {
      const el = document.querySelector(".session-pane") as HTMLElement | null;
      if (!el) return null;
      const prev = el.style.transition;
      el.style.transition = "none";
      void el.offsetWidth; // force the style flush before measuring
      const left = el.getBoundingClientRect().left;
      el.style.transition = prev;
      return { left, viewport: window.innerWidth };
    });
    expect(offRight).not.toBeNull();
    expect(offRight!.left).toBeGreaterThanOrEqual(offRight!.viewport - 1);
    // Focus must not be stranded in the hidden, aria-hidden pane, or board
    // shortcuts stay suppressed and focus is trapped in aria-hidden content.
    expect(
      await browser.execute(() => !!document.activeElement?.closest(".session-pane")),
    ).toBe(false);

    // Reopen via the peek tab — width must be exactly what it was.
    await peek.click();
    await expect(pane).not.toHaveElementClass("session-pane--collapsed");
    await expect($(".session-pane-peek")).not.toBeExisting();
    expect((await pane.getSize()).width).toBe(openWidth);
    expect(await paneInset()).toBe(openInset);

    // ⇧⌘T toggles from anywhere (handled before the pane-focus guard).
    await browser.keys(["Meta", "Shift", "t"]);
    await expect(pane).toHaveElementClass("session-pane--collapsed");
    await browser.keys(["Meta", "Shift", "t"]);
    await expect(pane).not.toHaveElementClass("session-pane--collapsed");

    // Neither Ctrl+Shift+T nor Option+Cmd+Shift+T is the toggle (exactly
    // Cmd+Shift+T) — those chords must be left for the TUI.
    await browser.keys(["Control", "Shift", "t"]);
    await expect(pane).not.toHaveElementClass("session-pane--collapsed");
    await browser.keys(["Alt", "Meta", "Shift", "t"]);
    await expect(pane).not.toHaveElementClass("session-pane--collapsed");

    // Teardown: don't leave a live pty behind the next spec.
    const sessions = await invoke<HostSession[]>("host_list");
    for (const s of sessions.filter((x) => x.adapter_id === "shell" && !x.exited)) {
      await invoke("host_kill", { sessionId: s.id });
    }
  });
});
