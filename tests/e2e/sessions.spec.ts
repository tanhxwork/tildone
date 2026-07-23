import { browser, $, expect } from "@wdio/globals";
import { mkdirSync } from "node:fs";

// Runs inside the app's own webview (withGlobalTauri in the e2e overlay), so
// specs reach the same IPC surface the sidebar components use.
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
  task_id: number | null;
  task_ref: string | null;
  adapter_id: string;
  exited: boolean;
}

describe("hosted sessions — shell escape hatch", () => {
  it("spawns an unbound shell from the sidebar Sessions + and shows 'no card yet'", async () => {
    await $("#root").waitForExist();

    await $('button[aria-label="New session"]').click();
    await $(".sess-new").waitForExist();
    await $(".sess-new-cwd").setValue("/tmp");
    const shellAdapter = $(".sess-new-adapter*=Shell");
    await shellAdapter.waitForExist();
    await shellAdapter.click();

    // A live pty spawned: sidebar row + pane, both in the unbound state.
    await $(".sess-row").waitForExist();
    await expect($(".session-pane-ref--none")).toBeExisting();
    await expect($(".session-pane-ref--none")).toHaveText("no card yet");
  });

  it("flips the pane chip and row label to the card ref when the session binds", async () => {
    // A real card to bind to, created through quick-add like a user would. The
    // pane (open from the previous test) hides the board's quick-add in rail
    // mode, so collapse the terminal to reach it — then reopen to watch the flip.
    await browser.keys(["Meta", "Shift", "t"]);
    const input = $(".quick-add input");
    await input.waitForExist();
    await input.setValue("Bind target task");
    await browser.keys("Enter");

    // The middle now shows the open session's context rail, not the board, so the
    // new card isn't listed there. Read its id and ref from the DB the app uses
    // (the source of truth), polling until the quick-add's write has landed.
    await invoke("plugin:sql|load", { db: "sqlite:tildone.db" });
    let found: Array<{ id: number; ref: string }> = [];
    await browser.waitUntil(
      async () => {
        found = await invoke<Array<{ id: number; ref: string }>>("plugin:sql|select", {
          db: "sqlite:tildone.db",
          query: "SELECT id, ref FROM tasks WHERE title = $1",
          values: ["Bind target task"],
        });
        return found.length === 1;
      },
      { timeout: 10000, timeoutMsg: "quick-add task did not persist" },
    );
    const ref = found[0].ref;

    // Reopen the pane so the ref chip's live flip is observable.
    await browser.keys(["Meta", "Shift", "t"]);
    await expect($(".session-pane-peek")).not.toBeExisting();

    const sessions = await invoke<HostSession[]>("host_list");
    const shell = sessions.find((s) => s.adapter_id === "shell" && !s.exited);
    expect(shell).toBeDefined();
    expect(shell!.task_ref).toBeNull();

    // Bind (same IPC the bind-on-claim adoption and "make it a task" drive);
    // the open pane must flip live, without a re-open.
    await invoke("host_bind_task", { sessionId: shell!.id, taskId: found[0].id, taskRef: ref });
    await expect($(".session-pane-ref")).toHaveText(ref);
    await expect($(".session-pane-ref--none")).not.toBeExisting();
    await expect($(`.sess-label*=${ref}`)).toBeExisting();

    mkdirSync("./tests/e2e/artifacts", { recursive: true });
    await browser.saveScreenshot("./tests/e2e/artifacts/sessions-bound.png");

    // Teardown: don't leave a live pty behind the next spec.
    await invoke("host_kill", { sessionId: shell!.id });
  });

  it("reveals the close X on hover and kills the session when clicked", async () => {
    await $("#root").waitForExist();

    // Clean slate so exactly one row exists and the selectors are unambiguous,
    // whatever the prior specs left behind.
    for (const s of await invoke<HostSession[]>("host_list")) {
      await invoke("host_kill", { sessionId: s.id });
    }
    await browser.waitUntil(async () => (await invoke<HostSession[]>("host_list")).length === 0, {
      timeout: 5000,
      timeoutMsg: "sessions did not drain",
    });

    // Spawn one live shell from the sidebar +.
    await $('button[aria-label="New session"]').click();
    await $(".sess-new").waitForExist();
    await $(".sess-new-cwd").setValue("/tmp");
    const shellAdapter = $(".sess-new-adapter*=Shell");
    await shellAdapter.waitForExist();
    await shellAdapter.click();

    const row = $(".sess-row");
    await row.waitForExist();
    const close = $(".sess-close");
    await close.waitForExist();

    // At rest the close control is hidden (opacity 0). The reveal fires on
    // `:hover, :focus-within`; WebDriver's synthetic moveTo can't drive CSS
    // :hover in this webview (real mouse hover works for users), so assert the
    // reveal through the shared focus-within path — same declarations, and it
    // exercises the keyboard-a11y route too.
    const opacityAtRest = await browser.execute(() => {
      const el = document.querySelector(".sess-close");
      return el ? getComputedStyle(el).opacity : null;
    });
    expect(opacityAtRest).toBe("0");
    mkdirSync("./tests/e2e/artifacts", { recursive: true });
    await browser.saveScreenshot("./tests/e2e/artifacts/session-row-rest.png");

    // Reveal, read deterministically: focus, kill the transition inline so the
    // computed value is the target (not a mid-animation frame), and read it —
    // all in one synchronous step so the unbound shell's countdown re-renders
    // can't blur the focus between the focus() and the read.
    const opacityOnFocus = await browser.execute(() => {
      const el = document.querySelector(".sess-close") as HTMLElement | null;
      if (!el) return null;
      el.focus();
      const focusWithin = el.closest(".sess-row")?.matches(":focus-within") ?? false;
      el.style.transition = "none";
      const op = getComputedStyle(el).opacity;
      el.style.transition = "";
      return { op, focusWithin };
    });
    expect(opacityOnFocus).not.toBeNull();
    expect(opacityOnFocus!.focusWithin).toBe(true);
    expect(opacityOnFocus!.op).toBe("1");
    await browser.saveScreenshot("./tests/e2e/artifacts/session-row-reveal.png");

    // Triggering it kills the live shell (host_kill) and the row disappears.
    // Fire the handler directly — the reveal is proven above; this asserts the
    // wiring without racing the re-render churn for a synthetic click.
    const before = await invoke<HostSession[]>("host_list");
    expect(before.some((s) => s.adapter_id === "shell" && !s.exited)).toBe(true);
    await browser.execute(() => (document.querySelector(".sess-close") as HTMLElement | null)?.click());
    await browser.waitUntil(
      async () => (await invoke<HostSession[]>("host_list")).every((s) => s.exited),
      { timeout: 5000, timeoutMsg: "the shell was not killed by the close X" },
    );
    await expect($(".sess-row")).not.toBeExisting();
  });
});
