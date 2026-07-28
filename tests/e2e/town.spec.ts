import { browser, $, expect } from "@wdio/globals";
import { mkdirSync } from "node:fs";
import { resetAppState } from "./support/reset.js";

// The town re-renders the board's presence state as pixel rooms. The pixels live
// on a canvas (not asserted here), but every character carries a DOM overlay node
// (hover/aria/testid) — so this drives the real app to prove the view mounts and
// that an agent-touched task surfaces as a character in its project's room. Live
// presence needs the agent server; the activity *fallback* does not, so we seed a
// recent agent activity row and let cardPresence resolve a quiet character.

async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return browser.execute(
    (c, a) =>
      (
        window as unknown as {
          __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<unknown> } };
        }
      ).__TAURI__.core.invoke(c, a) as Promise<T>,
    cmd,
    args,
  );
}

async function exec(query: string, values: unknown[] = []): Promise<void> {
  await invoke("plugin:sql|execute", { db: "sqlite:tildone.db", query, values });
}

async function selectId(query: string): Promise<number> {
  const rows = await invoke<{ id: number }[]>("plugin:sql|select", {
    db: "sqlite:tildone.db",
    query,
    values: [],
  });
  return rows[0].id;
}

/** Nudge the store to reload from the DB, the same event every agent write fires. */
async function nudge(): Promise<void> {
  await browser.execute(() =>
    (
      window as unknown as { __TAURI__: { event: { emit: (e: string) => void } } }
    ).__TAURI__.event.emit("agent-db-changed"),
  );
}

describe("town view", () => {
  before(async () => {
    await resetAppState();
  });

  it("mounts the town and shows a character for an agent-touched task in its project room", async () => {
    await exec(
      "INSERT INTO projects (name, color, position, created_at, code) VALUES ($1,$2,$3,$4,$5)",
      ["Townproj", "#5645d4", 0, "2026-01-01T00:00:00Z", "TWN"],
    );
    const pid = await selectId("SELECT id FROM projects WHERE name = 'Townproj'");

    await exec(
      "INSERT INTO tasks (project_id, title, status, position, priority, notes, created_at) VALUES ($1,$2,'doing',0,0,'',$3)",
      [pid, "Town task", "2026-01-01T00:00:00Z"],
    );
    const tid = await selectId("SELECT id FROM tasks WHERE title = 'Town task'");

    // Recent agent activity → cardPresence resolves a quiet character via the
    // fallback (within the 12h presence window), no live server needed.
    const recent = new Date(Date.now() - 60_000).toISOString();
    await exec(
      "INSERT INTO task_activity (task_id, label, created_at, actor_kind, actor_name) VALUES ($1,$2,$3,'agent','claude-code')",
      [tid, "working", recent],
    );
    await nudge();

    // Open the town from the header view toggle.
    const townButton = $('button[aria-label="Town view"]');
    await townButton.waitForExist();
    await townButton.click();

    await $(".town").waitForExist();
    // Assert the DOM overlay, not the canvas: the pixel layer needs WebGL (absent
    // in a GPU-less test webview), but the overlay renders from the model either
    // way — and it is what carries hover/aria/hit-testing. The agent-touched task
    // must appear as a character node, proving the model → room → character path.
    await $(`[data-testid="town-char-${tid}"]`).waitForExist();

    mkdirSync("./tests/e2e/artifacts", { recursive: true });
    await browser.saveScreenshot("./tests/e2e/artifacts/town.png");
  });
});
