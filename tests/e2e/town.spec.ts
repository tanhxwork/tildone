import { browser, $, expect } from "@wdio/globals";
import { mkdirSync } from "node:fs";
import { resetAppState } from "./support/reset.js";

// The living town re-renders the board's presence state as characters that walk
// a tiled overworld. The pixels live on a canvas (not asserted here); every
// character carries a DOM overlay node (hover/aria/testid) that FOLLOWS its
// moving sprite — so this drives the real app to prove the view mounts and that
// an agent-touched task surfaces as a character tagged with its presence state
// and its building. Positions are dynamic now, so we assert the node's identity
// and attributes, never a fixed coordinate or canvas pixels. Live presence needs
// the agent server; the activity *fallback* does not, so we seed a recent agent
// activity row and let cardPresence resolve a quiet character.

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

  it("mounts the living town and shows a character tagged with its state and building for an agent-touched task", async () => {
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
    // The DOM overlay carries hover/aria/hit-testing: the agent-touched task must
    // appear as a character node, proving the model → roster → character path.
    const char = $(`[data-testid="town-char-${tid}"]`);
    await char.waitForExist();
    // The node is tagged with its presence state (the fallback resolves quiet)
    // and the index of its building (its only project → building 0).
    await expect(char).toHaveAttribute("data-state", "quiet");
    await expect(char).toHaveAttribute("data-building", "0");

    // The Pixi canvas must actually mount. It silently fell back to "overlay
    // only" (TownView's catch) because Pixi's `Assets.load` rejects under
    // Tauri's `tauri://localhost` protocol — so the town rendered blank in the
    // app for months while this overlay-only assertion stayed green. Loading the
    // PNGs via <img> fixed it; assert the canvas so the regression can't hide
    // behind the overlay again.
    const canvasMounted = await browser.execute(() => {
      const c = document.querySelector(".town-canvas canvas") as HTMLCanvasElement | null;
      return !!c && c.width > 0 && c.height > 0;
    });
    expect(canvasMounted).toBe(true);

    // v3 has a camera: the canvas is sized to the VIEWPORT, not the whole world
    // (under v2 it was world-sized and the frame scrolled). So the canvas width
    // tracks its host, proving the world is scrolled by a camera rather than laid
    // out flat at full size.
    const viewportSized = await browser.execute(() => {
      const host = document.querySelector(".town") as HTMLElement | null;
      const canvas = document.querySelector(".town-canvas canvas") as HTMLCanvasElement | null;
      if (!host || !canvas) return false;
      return Math.abs(canvas.clientWidth - host.clientWidth) < 4;
    });
    expect(viewportSized).toBe(true);

    // Clicking a character makes the camera follow it — the node gains the
    // `following` class (React-driven; independent of the animation frame).
    await char.click();
    await expect(char).toHaveElementClass("following", { containing: true });

    // This automated webview is never composited, so requestAnimationFrame (and
    // therefore Pixi's ticker) never fires — the world would stay unrendered.
    // Pump the sim+camera+render loop manually so the pipeline runs end to end
    // and the screenshot shows the real living town.
    await browser.execute(() => {
      const step = (window as unknown as { __townStep?: (dt?: number) => void }).__townStep;
      for (let i = 0; i < 150; i++) step?.(16);
    });

    // The overlay node now carries a real pixel offset set by the frame loop —
    // proof the sim → camera → render pipeline ran (a black/blank canvas would
    // leave it unpositioned). The camera also followed it after the click.
    const positioned = await browser.execute(() => {
      const n = document.querySelector(".town-char") as HTMLElement | null;
      return /^-?\d/.test(n?.style.top ?? "") && /^-?\d/.test(n?.style.left ?? "");
    });
    expect(positioned).toBe(true);

    mkdirSync("./tests/e2e/artifacts", { recursive: true });
    await browser.saveScreenshot("./tests/e2e/artifacts/town.png");

    // Escape releases the follow (spec: cleared by background click / Escape).
    await browser.execute(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      const step = (window as unknown as { __townStep?: (dt?: number) => void }).__townStep;
      for (let i = 0; i < 5; i++) step?.(16);
    });
    await expect(char).not.toHaveElementClass("following", { containing: true });

    // A wheel over the canvas zooms the camera, which re-projects the overlay —
    // proof the pan/zoom camera transform is live (not a static full-size layout).
    // Follow is off now, so a moved node means the transform actually changed.
    const before = await browser.execute(
      () => (document.querySelector(".town-char") as HTMLElement | null)?.style.left ?? "",
    );
    await browser.execute(() => {
      const c = document.querySelector(".town-canvas") as HTMLElement;
      const rect = c.getBoundingClientRect();
      // Pivot the zoom near a corner (not the centre) so the node definitively
      // shifts even if the camera happened to be centred on it.
      c.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -300,
          clientX: rect.left + 24,
          clientY: rect.top + 24,
          bubbles: true,
          cancelable: true,
        }),
      );
      const step = (window as unknown as { __townStep?: (dt?: number) => void }).__townStep;
      for (let i = 0; i < 5; i++) step?.(16);
    });
    const after = await browser.execute(
      () => (document.querySelector(".town-char") as HTMLElement | null)?.style.left ?? "",
    );
    expect(after).not.toBe(before);
  });
});
