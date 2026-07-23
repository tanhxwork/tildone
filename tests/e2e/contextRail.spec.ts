import { browser, $, $$, expect } from "@wdio/globals";
import { mkdirSync } from "node:fs";

// Runs inside the app's own webview (withGlobalTauri in the e2e overlay).
async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return browser.execute(
    (c, a) =>
      (
        window as unknown as {
          __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<unknown> } };
        }
      ).__TAURI__.core.invoke(c, a),
    cmd,
    args,
  ) as Promise<T>;
}

interface HostSession {
  id: number;
  adapter_id: string;
  exited: boolean;
}

async function killShells(): Promise<void> {
  const sessions = await invoke<HostSession[]>("host_list");
  for (const s of sessions.filter((x) => x.adapter_id === "shell" && !x.exited)) {
    await invoke("host_kill", { sessionId: s.id });
  }
}

// killShells stops the ptys (host_kill removes the rows) but leaves the pane
// open on a now-missing hosted target, which keeps the rail up and the board's
// quick-add hidden. Close it so the board — and quick-add — are reachable
// again. A hosted target whose row the store no longer has is treated as
// maybe-live (a just-started session lives in host.rs before the refresh
// lands), so the X — labelled "End session" (Ghostty close, TIL-162) — now
// raises the confirm; dismiss it. With no next live session to fall to, one
// confirmed close returns the pane to the board.
async function closePaneIfOpen(): Promise<void> {
  const close = $('button[aria-label="End session"]');
  while (await close.isExisting()) {
    await close.click();
    const confirm = $('.modal[aria-label="End this session?"] .btn.danger');
    if (await confirm.isExisting()) await confirm.click();
    await browser.pause(150);
  }
}

async function spawnShell(cwd: string): Promise<void> {
  await $('button[aria-label="New session"]').click();
  await $(".sess-new").waitForExist();
  await $(".sess-new-cwd").setValue(cwd);
  const shellAdapter = $(".sess-new-adapter*=Shell");
  await shellAdapter.waitForExist();
  await shellAdapter.click();
  await $(".session-pane").waitForExist();
}

describe("session context rail", () => {
  it("shows the active session's task, flips on bind, focuses, and docks when collapsed", async () => {
    await $("#root").waitForExist();
    await killShells();

    // A real card, created through quick-add before any pane is open (the
    // quick-add is hidden once the pane takes the middle).
    const input = $(".quick-add input");
    await input.waitForExist();
    await input.setValue("Rail target task");
    await browser.keys("Enter");
    await $(".task-title*=Rail target task").waitForExist();
    const ref = await $(".task-id").getText();

    // Open an UNBOUND shell: the middle becomes the minimal (no-card-yet) rail,
    // never the board and never an error.
    await spawnShell("/tmp");
    await expect($(".context-rail--unbound")).toBeExisting();
    await expect($(".context-rail--unbound .rail-ref--none")).toHaveText("no card yet");
    await expect($(".rail-make-task")).toBeExisting();

    // Bind it to the card (same IPC as bind-on-claim). The rail must flip to the
    // task's context live, without a re-open — like the pane's ref chip.
    const sessions = await invoke<HostSession[]>("host_list");
    const shell = sessions.find((s) => s.adapter_id === "shell" && !s.exited);
    const found = await invoke<Array<{ id: number }>>("plugin:sql|select", {
      db: "sqlite:tildone.db",
      query: "SELECT id FROM tasks WHERE title = $1",
      values: ["Rail target task"],
    });
    await invoke("host_bind_task", { sessionId: shell!.id, taskId: found[0].id, taskRef: ref });

    await expect($(".context-rail")).toBeExisting();
    await expect($(".context-rail--unbound")).not.toBeExisting();
    await expect($(".rail-ref")).toHaveText(ref);
    await expect($(".rail-title")).toHaveText("Rail target task");

    mkdirSync("./tests/e2e/artifacts", { recursive: true });
    await browser.saveScreenshot("./tests/e2e/artifacts/context-rail-bound.png");

    // Rail content (spec: e2e exercises progress / checklist / chips / feed).
    // Seed a subtask and a link, nudge the store to reload, assert they render.
    await invoke("plugin:sql|execute", {
      db: "sqlite:tildone.db",
      query: "INSERT INTO subtasks (task_id, title, position) VALUES ($1, $2, $3)",
      values: [found[0].id, "Wire the rail", 0],
    });
    await invoke("plugin:sql|execute", {
      db: "sqlite:tildone.db",
      query:
        "INSERT INTO task_links (task_id, url, label, kind, created_at) VALUES ($1, $2, $3, $4, $5)",
      values: [found[0].id, "https://example.com/tree/feature", "feature", "branch", "2026-07-23T00:00:00Z"],
    });
    await browser.execute(() =>
      (
        window as unknown as { __TAURI__: { event: { emit: (e: string) => void } } }
      ).__TAURI__.event.emit("agent-db-changed"),
    );
    await expect($(".rail-check")).toBeExisting();
    await expect($(".rail-bar")).toBeExisting();
    await expect($(".rail-link")).toBeExisting();
    await expect($(".rail-feed")).toBeExisting();

    // Board chrome (quick-add, search/filters/view-toggles) has nothing to act
    // on while the rail is up — it's hidden — and comes back when the terminal
    // collapses to show the original board (TIL-159).
    await expect($(".quick-add")).not.toBeExisting();
    await expect($(".header-controls")).not.toBeExisting();
    await browser.keys(["Meta", "Shift", "t"]); // collapse → original board
    await expect($(".session-pane-peek")).toBeExisting();
    await expect($(".quick-add")).toBeExisting();
    await browser.keys(["Meta", "Shift", "t"]); // reopen for the rest
    await expect($(".session-pane-peek")).not.toBeExisting();

    // Focus mode: the rail hides and the terminal widens, sidebar kept.
    await $('button[aria-label="Focus terminal"]').click();
    await expect($(".session-pane")).toHaveElementClass("session-pane--focus");
    await expect($(".context-rail")).not.toBeExisting();
    await expect($(".sidebar")).toBeExisting();
    // Restore the split.
    await $('button[aria-label="Show context rail"]').click();
    await expect($(".session-pane")).not.toHaveElementClass("session-pane--focus");
    await expect($(".context-rail")).toBeExisting();

    // Collapse the terminal: the reopen control is the flush docked rail, with
    // the parked session's status dot and its ref (not a floating mystery tab).
    await $(".session-pane-toggle").click();
    const peek = $(".session-pane-peek");
    await expect(peek).toBeExisting();
    await expect(peek.$(".sess-dot")).toBeExisting();
    await expect(peek.$(".session-pane-peek-label")).toHaveText(ref);
    // The board returns while the terminal is docked away.
    await expect($(".context-rail")).not.toBeExisting();
    await peek.click();
    await expect($(".session-pane-peek")).not.toBeExisting();

    await killShells();
  });

  it("offers a tab per live session and REBINDS the rail when switching", async () => {
    await $("#root").waitForExist();
    await killShells();
    await closePaneIfOpen();

    // Two cards, each with a live shell bound to it from birth. Distinct cards
    // are what let us prove the rail REBINDS (not just that the active CSS
    // index moves): the rail's ref must flip from one card to the other on
    // switch — spec docs/specs/2026-07-23-session-context-rail.md:111-116.
    const mkCard = async (title: string) => {
      const input = $(".quick-add input");
      await input.waitForExist();
      await input.setValue(title);
      await browser.keys("Enter");
      await $(`.task-title*=${title}`).waitForExist();
      const ref = await browser.execute((t) => {
        const row = Array.from(document.querySelectorAll(".task-row")).find(
          (r) => r.querySelector(".task-title")?.textContent === t,
        );
        return row?.querySelector(".task-id")?.textContent ?? null;
      }, title);
      const found = await invoke<Array<{ id: number }>>("plugin:sql|select", {
        db: "sqlite:tildone.db",
        query: "SELECT id FROM tasks WHERE title = $1",
        values: [title],
      });
      return { ref: ref!, id: found[0].id };
    };
    const a = await mkCard("Rebind card A");
    const b = await mkCard("Rebind card B");

    // host_start binds the shell to its card from the start (an already-open
    // unbound pane can't be rebound via IPC — openPane's same-session guard
    // never rewrites target.taskRef). No pane opens yet; quick-add stays up.
    const startBound = (card: { ref: string; id: number }, cwd: string) =>
      invoke<number>("host_start", {
        taskId: card.id,
        taskRef: card.ref,
        adapterId: "shell",
        claimCwd: cwd,
        projectName: null,
        prompt: null,
        cols: 80,
        rows: 24,
      });
    await startBound(a, "/tmp");
    await startBound(b, "/usr");

    // Open one bound session from the sidebar → the one pane, rail bound to
    // that card, plus a two-tab strip (both live sessions).
    const row = $(".sess-row");
    await row.waitForExist();
    await row.click();
    await $(".session-pane").waitForExist();
    await $(".session-pane-tabs").waitForExist();
    await expect($$(".session-pane-tab")).toBeElementsArrayOfSize(2);
    await expect($$(".session-pane-tab.is-active")).toBeElementsArrayOfSize(1);

    // The rail is bound to whichever card opened; the other is the switch
    // target. Reading it (rather than assuming order) keeps the test robust to
    // sidebar ordering.
    await expect($(".rail-ref")).toBeExisting();
    const firstRef = await $(".rail-ref").getText();
    expect([a.ref, b.ref]).toContain(firstRef);
    const otherRef = firstRef === a.ref ? b.ref : a.ref;

    // Click the OTHER session's tab (exact-match its ref label).
    await browser.execute((r) => {
      const tab = Array.from(document.querySelectorAll(".session-pane-tab")).find(
        (t) => t.querySelector(".session-pane-tab-label")?.textContent === r,
      );
      (tab as HTMLElement | undefined)?.click();
    }, otherRef);

    // The single pane re-targets AND the rail rebinds to the other card — its
    // ref, and the active tab, are now the switched-to session's, not the
    // original's. This is the rebind the tab test previously left unproven.
    await browser.waitUntil(async () => (await $(".rail-ref").getText()) === otherRef, {
      timeout: 5000,
      timeoutMsg: "switching tabs did not rebind the rail to the other card",
    });
    await expect($(".session-pane-tab.is-active .session-pane-tab-label")).toHaveText(otherRef);
    await expect($$(".session-pane-tab.is-active")).toBeElementsArrayOfSize(1);
    await expect($$(".session-pane")).toBeElementsArrayOfSize(1);

    mkdirSync("./tests/e2e/artifacts", { recursive: true });
    await browser.saveScreenshot("./tests/e2e/artifacts/context-rail-tabs.png");

    await killShells();
    await closePaneIfOpen();
  });

  it("shows the FULL board (not one column) when a bound session's terminal is collapsed", async () => {
    await $("#root").waitForExist();
    await killShells();
    await closePaneIfOpen(); // a prior test may have left the pane (and rail) up

    // A real card, and a shell BOUND to it from birth. This is the state the bug
    // needs: the pane target must itself carry the taskId. Binding an already-open
    // unbound pane via IPC does not — openPane's same-session guard never rewrites
    // target.taskId — so only opening an already-bound session (sidebar openSession
    // passes s.task_id) puts a taskId on the target. Start bound, then open it.
    const input = $(".quick-add input");
    await input.waitForExist();
    await input.setValue("Full board on collapse");
    await browser.keys("Enter");
    await $(".task-title*=Full board on collapse").waitForExist();
    const ref = await $(".task-id").getText();
    // Board view, so the collapsed board has columns to count (chrome is reachable
    // now, before any pane opens and hides it).
    await $('button[aria-label="Board view"]').click();

    const found = await invoke<Array<{ id: number }>>("plugin:sql|select", {
      db: "sqlite:tildone.db",
      query: "SELECT id FROM tasks WHERE title = $1",
      values: ["Full board on collapse"],
    });
    await invoke<number>("host_start", {
      taskId: found[0].id,
      taskRef: ref,
      adapterId: "shell",
      claimCwd: "/tmp",
      projectName: null,
      prompt: null,
      cols: 80,
      rows: 24,
    });
    // Open the bound session from the sidebar row → openPane's full path puts the
    // task id on the pane target. Confirm via the bound ref chip.
    const row = $(".sess-row");
    await row.waitForExist();
    await row.click();
    await $(".session-pane").waitForExist();
    await expect($(".session-pane-ref")).toHaveText(ref);

    // Collapse: the middle returns to the ORIGINAL full board — all three status
    // columns — not the single narrowed column of the bound card. Pre-fix, the
    // pane-focus narrowing survived into the docked-rail state and left only the
    // bound card's column (e.g. just "To Do"); this is the guard for that (TIL-160).
    await browser.keys(["Meta", "Shift", "t"]);
    await expect($(".session-pane-peek")).toBeExisting();
    await expect($(".board")).not.toHaveElementClass("pane-focus");
    const cols = await $$(".board-column");
    let shown = 0;
    for (const c of cols) if (await c.isDisplayed()) shown += 1;
    expect(shown).toBe(3);

    await killShells();
  });

  it("ends a live session on close (Ghostty ⌘W): confirm → fall to next → board", async () => {
    await $("#root").waitForExist();
    await killShells();
    await closePaneIfOpen();

    // Two live hosted shells → one pane with a two-tab strip.
    await spawnShell("/tmp");
    await spawnShell("/usr");
    await $(".session-pane-tabs").waitForExist();
    await expect($$(".session-pane-tab")).toBeElementsArrayOfSize(2);

    const liveShells = async () =>
      (await invoke<HostSession[]>("host_list")).filter(
        (s) => s.adapter_id === "shell" && !s.exited,
      ).length;
    expect(await liveShells()).toBe(2);

    // Closing a LIVE hosted session asks first — X is about to kill a running
    // CLI, not just hide it.
    await $('button[aria-label="End session"]').click();
    const confirm = $('.modal[aria-label="End this session?"]');
    await expect(confirm).toBeExisting();

    // Confirm → that session ends and the pane falls to the OTHER live one
    // (still exactly one pane — no ping-pong — now with a single session, so
    // the tab strip is gone and one live shell remains).
    await confirm.$(".btn.danger").click();
    await expect($('.modal[aria-label="End this session?"]')).not.toBeExisting();
    await expect($(".session-pane")).toBeExisting();
    await browser.waitUntil(async () => (await liveShells()) === 1, {
      timeout: 5000,
      timeoutMsg: "closing one of two sessions did not leave exactly one live shell",
    });
    await expect($$(".session-pane-tab")).toBeElementsArrayOfSize(0);

    // Close the last one → confirm → the pane closes to the board: no terminal,
    // no docked peek rail, and the quick-add is reachable again.
    await $('button[aria-label="End session"]').click();
    await $('.modal[aria-label="End this session?"]').$(".btn.danger").click();
    await browser.waitUntil(async () => !(await $(".session-pane").isExisting()), {
      timeout: 5000,
      timeoutMsg: "closing the last session did not return to the board",
    });
    await expect($(".session-pane-peek")).not.toBeExisting();
    await expect($(".quick-add")).toBeExisting();
    expect(await liveShells()).toBe(0);

    await killShells();
  });
});
