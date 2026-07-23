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

// killShells stops the ptys but leaves the pane open (showing exited sessions),
// which keeps the rail up and the board's quick-add hidden. Detach it so the
// board — and quick-add — are reachable again. With every session already
// exited, closeOrNextSession has no next to fall to, so one detach closes it.
async function detachPaneIfOpen(): Promise<void> {
  const detach = $('button[aria-label="Detach terminal"]');
  while (await detach.isExisting()) {
    await detach.click();
    await browser.pause(100);
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

  it("offers a tab per live session and switches the one pane between them", async () => {
    await $("#root").waitForExist();
    await killShells();

    // Two live sessions → the terminal grows a tab strip; the last opened is active.
    await spawnShell("/tmp");
    await spawnShell("/usr");
    const tabs = $(".session-pane-tabs");
    await tabs.waitForExist();
    await expect($$(".session-pane-tab")).toBeElementsArrayOfSize(2);
    await expect($$(".session-pane-tab.is-active")).toBeElementsArrayOfSize(1);

    // Which tab starts active is order-dependent; prove the SWITCH regardless.
    const activeIndex = () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll(".session-pane-tab")).findIndex((t) =>
          t.classList.contains("is-active"),
        ),
      );
    const before = await activeIndex();
    const other = before === 0 ? 1 : 0;
    await $(`.session-pane-tab:nth-child(${other + 1})`).click();
    // Clicking the other tab re-targets the single pane to it.
    await browser.waitUntil(async () => (await activeIndex()) === other, {
      timeout: 5000,
      timeoutMsg: "clicking a tab did not move the active session",
    });
    await expect($$(".session-pane-tab.is-active")).toBeElementsArrayOfSize(1);
    await expect($$(".session-pane")).toBeElementsArrayOfSize(1);

    mkdirSync("./tests/e2e/artifacts", { recursive: true });
    await browser.saveScreenshot("./tests/e2e/artifacts/context-rail-tabs.png");

    await killShells();
  });

  it("shows the FULL board (not one column) when a bound session's terminal is collapsed", async () => {
    await $("#root").waitForExist();
    await killShells();
    await detachPaneIfOpen(); // a prior test may have left the pane (and rail) up

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
});
