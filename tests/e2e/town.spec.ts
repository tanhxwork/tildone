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

    // Open the town from the header view toggle. Clear the first-open hint's
    // seen-flag first so it shows on this open (a prior run may have set it).
    const townButton = $('button[aria-label="Town view"]');
    await townButton.waitForExist();
    await browser.execute(() => localStorage.removeItem("tildone-town-hint-seen"));
    await townButton.click();

    await $(".town").waitForExist();
    // First open → the discoverability hint bar teaches the controls. Pump a few
    // frames first so the canvas renders behind it for the artifact screenshot.
    await expect($('[data-testid="town-hint"]')).toBeExisting();
    await browser.execute(() => {
      const step = (window as unknown as { __townStep?: (dt?: number) => void }).__townStep;
      for (let i = 0; i < 40; i++) step?.(16);
    });
    mkdirSync("./tests/e2e/artifacts", { recursive: true });
    await browser.saveScreenshot("./tests/e2e/artifacts/town-hint.png");
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
    // Clicking a character is a "first interaction" → the hint retires for good.
    await expect($('[data-testid="town-hint"]')).not.toBeExisting();

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

    // Zoom all the way out and capture the whole town. The close shot above only
    // ever shows one house, so nothing in this spec used to exercise — or let a
    // reviewer see — the commons, the street lattice or the lots together.
    await browser.execute(() => {
      const wrap = document.querySelector(".town-canvas") as HTMLElement | null;
      for (let i = 0; i < 6; i++) {
        wrap?.dispatchEvent(
          new WheelEvent("wheel", { deltaY: 120, clientX: 400, clientY: 300, bubbles: true, cancelable: true }),
        );
      }
      const step = (window as unknown as { __townStep?: (dt?: number) => void }).__townStep;
      for (let i = 0; i < 60; i++) step?.(16);
    });
    await browser.saveScreenshot("./tests/e2e/artifacts/town-wide.png");

    // A session with no heartbeat is quiet-and-NOT-live, and it must not look
    // like a working one. Until TIL-198 both resolved to the same intent, the
    // same desk seat and the same animation, so this character — an agent that
    // touched the card once and left — sat at a desk indistinguishable from one
    // grinding. It now goes home to the sofa (or, after dark, to bed), which is
    // the whole point: presence.ts refuses to *say* "working" without a
    // heartbeat, and the town must not draw it either.
    await browser.execute(() => {
      const step = (window as unknown as { __townStep?: (dt?: number) => void }).__townStep;
      for (let i = 0; i < 600; i++) step?.(16);
    });
    // Captured *after* it has settled, which the earlier shots never were: the
    // activity badge only appears once a character stops walking, so every
    // screenshot this spec used to take showed a town with no badges in it. A
    // green spec proving nothing about how it looked is how three defects
    // shipped through TIL-189.
    await browser.saveScreenshot("./tests/e2e/artifacts/town-settled.png");
    // What it is doing depends on the wall clock and on where it is in its
    // evening, and the spec must not care which: asserting "on the sofa" would
    // fail every evening, and asserting it *only* ever rests would fail as soon
    // as it got up to put the kettle on (TIL-199).
    const HOME_LIFE = [
      "resting",
      "sleeping",
      "walking",
      "watching",
      "music",
      "cooking",
      "eating",
      "reading",
      "coffee",
      "washing",
    ];
    const activity = await char.getAttribute("data-activity");
    expect(HOME_LIFE).toContain(activity);
    const restingWhere = await char.getAttribute("data-where");
    // Somewhere in its own house, and never back at a desk.
    expect(restingWhere).toContain("house");
    expect(restingWhere).not.toContain("in the workroom");
    // The tooltip says it in words — the user's decision was a glyph in the
    // world and the name on hover, so the words have to actually be there. These
    // are the phrases, not the activity names: "resting" reads as "on the sofa".
    expect(await char.getAttribute("title")).toMatch(
      /on the sofa|asleep|walking|watching television|playing the guitar|cooking|eating|reading|making coffee|washing up/,
    );

    // An evening is a *routine*, not a pose: over the next minute of simulated
    // time this character must be seen doing more than one thing. The old
    // picture — a quiet agent parked on a sofa for as long as you watched —
    // passed every assertion above and was the deadest thing in the town.
    const seen = new Set<string>([activity ?? ""]);
    for (let i = 0; i < 12; i++) {
      await browser.execute(() => {
        const step = (window as unknown as { __townStep?: (dt?: number) => void }).__townStep;
        for (let n = 0; n < 300; n++) step?.(16);
      });
      seen.add((await char.getAttribute("data-activity")) ?? "");
    }
    expect([...seen].every((a) => HOME_LIFE.includes(a))).toBe(true);
    expect(seen.size).toBeGreaterThan(1);

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

    // Clicking a building GLIDES the camera in (eased), it does not snap. Zoom
    // out first so the glide has a guaranteed zoom-in to ease through, then click
    // building 0 and assert its overlay keeps growing across frames — a snap
    // would reach final size on the first frame and not change afterwards.
    await browser.execute(() => {
      const c = document.querySelector(".town-canvas") as HTMLElement;
      const rect = c.getBoundingClientRect();
      for (let i = 0; i < 4; i++)
        c.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: 300,
            clientX: rect.left + 40,
            clientY: rect.top + 40,
            bubbles: true,
            cancelable: true,
          }),
        );
      const step = (window as unknown as { __townStep?: (dt?: number) => void }).__townStep;
      for (let i = 0; i < 5; i++) step?.(16);
      (document.querySelector('[data-testid="town-building-0"]') as HTMLElement).click();
    });
    const buildingWidth = (frames: number) =>
      browser.execute((n) => {
        const step = (window as unknown as { __townStep?: (dt?: number) => void }).__townStep;
        for (let i = 0; i < n; i++) step?.(16);
        const el = document.querySelector('[data-testid="town-building-0"]') as HTMLElement | null;
        return parseFloat(el?.style.width || "0");
      }, frames);
    const wEarly = await buildingWidth(1);
    const wSettled = await buildingWidth(60);
    expect(wSettled).toBeGreaterThan(wEarly);
  });

  // A live presence TRANSITION, which the steady-state test above never exercised:
  // it only ever asserted one frozen data-state. The reconcile path that clears a
  // character's path when its intent changes had no coverage at all (TIL-176).
  //
  // Live state needs a real heartbeat, and /heartbeat rejects any request carrying
  // an Origin header — precisely so a web page cannot fake "working". The webview
  // always sends one; Node does not, so the beat goes from the spec process
  // straight at the app's agent server, exactly the way the shell hook does.
  it("walks a character to its desk when it starts working, and out again when it goes quiet", async () => {
    const pid = await selectId("SELECT id FROM projects WHERE name = 'Townproj'");
    await exec(
      "INSERT INTO tasks (project_id, title, status, position, priority, notes, created_at) VALUES ($1,$2,'doing',1,0,'',$3)",
      [pid, "Flip task", "2026-01-01T00:00:00Z"],
    );
    const tid = await selectId("SELECT id FROM tasks WHERE title = 'Flip task'");

    // Bind a session to the task — the durable half of presence; the beat below
    // is the volatile half and finds its card through this row.
    const session = "e2e-town-flip-0000-0000-000000000001";
    await exec("INSERT INTO agent_claims (session_id, task_id, agent_name) VALUES ($1,$2,$3)", [
      session,
      tid,
      "claude-code",
    ]);

    const endpoint = await invoke<string>("agent_server_start");
    const beat = async (state: "working" | "idle") => {
      const res = await fetch(new URL("/heartbeat", endpoint).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: session, state }),
      });
      expect(res.status).toBe(200);
      await nudge(); // agent-db-changed → reload → loadPresence
    };

    const step = (n: number) =>
      browser.execute((frames) => {
        const s = (window as unknown as { __townStep?: (dt?: number) => void }).__townStep;
        for (let i = 0; i < frames; i++) s?.(16);
      }, n);

    /** Is the character's overlay node inside its building's overlay box? */
    const atHome = (taskId: number, building: number) =>
      browser.execute(
        (t, b) => {
          const c = document.querySelector(`[data-testid="town-char-${t}"]`);
          const h = document.querySelector(`[data-testid="town-building-${b}"]`);
          if (!c || !h) return null;
          const cr = c.getBoundingClientRect();
          const hr = h.getBoundingClientRect();
          const x = cr.left + cr.width / 2;
          const y = cr.top + cr.height / 2;
          return x >= hr.left && x <= hr.right && y >= hr.top && y <= hr.bottom;
        },
        taskId,
        building,
      );

    // --- working: the character heads home and settles at its desk. ---
    await beat("working");
    const char = $(`[data-testid="town-char-${tid}"]`);
    await char.waitForExist();
    await expect(char).toHaveAttribute("data-state", "working");
    const building = Number(await char.getAttribute("data-building"));
    await step(900); // long enough to walk the yard, the gate and the house
    expect(await atHome(tid, building)).toBe(true);

    // The place tree is live, not decoration: the frame loop names where the
    // character is standing, and at its desk that has to be the workroom.
    const where = await char.getAttribute("data-where");
    expect(where).toContain("in the workroom");
    expect(where).toContain("'s house");
    expect(await char.getAttribute("aria-label")).toContain(where);

    // Heads-down at the desk is its own activity, distinct from the resting one
    // asserted in the case above. A working character takes occasional trips —
    // coffee, a wash — so accept those too rather than pinning a single frame of
    // a routine; what must never appear here is resting or sleeping.
    const workActivity = await char.getAttribute("data-activity");
    expect(["typing", "building", "testing", "reading", "writing", "waiting", "coffee", "washing", "eating", "walking"]).toContain(
      workActivity,
    );
    expect(["resting", "sleeping"]).not.toContain(workActivity);

    // Chat state is mirrored from the sim onto the overlay every frame. Only the
    // wiring is asserted here — that it is published, and that a working
    // character is never mid-chat. WHETHER two idle characters meet is
    // stochastic, so its coverage is the seeded townSim cases; an e2e that
    // waited for a random encounter would just be a flake.
    expect(await char.getAttribute("data-chatting")).toBe("false");

    // --- Visibility resume settles in place; it does not re-spawn the town. ---
    // Asserted HERE, with the character seated at its desk, because that is the
    // only state where the two behaviours differ observably: settling a working
    // character is a no-op, while createSim() empties the sim and the next step
    // puts it back on its door, outside the house. Asserting this on a WANDERING
    // character proves nothing — settle and respawn both send it to the door —
    // and the first version of this check did exactly that, so it passed with
    // the bug still present (caught by the Codex verify of TIL-190).
    const posOf = () =>
      browser.execute((t) => {
        const n = document.querySelector(`[data-testid="town-char-${t}"]`) as HTMLElement | null;
        return n ? { left: n.style.left, top: n.style.top } : null;
      }, tid);
    const idsOf = () =>
      browser.execute(() =>
        [...document.querySelectorAll(".town-char")]
          .map((n) => (n as HTMLElement).dataset.testid ?? "")
          .sort(),
      );

    const posBefore = await posOf();
    const idsBefore = await idsOf();
    expect(posBefore).not.toBeNull();

    // The handler is keyed on visibilitychange and the document is visible, so
    // firing the event runs exactly the resume branch.
    await browser.execute(() => document.dispatchEvent(new Event("visibilitychange")));
    await step(2);

    expect(await posOf()).toEqual(posBefore); // did not budge
    expect(await idsOf()).toEqual(idsBefore); // same population
    expect(await atHome(tid, building)).toBe(true); // still indoors, not on the door

    // --- quiet: the same character leaves its desk. Same node, no respawn. ---
    //
    // What it does next depends on the clock — by day it walks out to the plaza,
    // after dark it goes to bed — so the assertion is the part that is true
    // either way: it is no longer working at its desk in the workroom. Asserting
    // "outdoors" would have passed every afternoon and failed every night.
    await beat("idle");
    await expect(char).toHaveAttribute("data-state", "quiet");
    await step(1200);
    await expect(char).toBeExisting(); // it left its desk; it did not vanish and return
    const quietWhere = await char.getAttribute("data-where");
    expect(quietWhere).not.toContain("in the workroom");
    const quietActivity = await char.getAttribute("data-activity");
    expect(["typing", "building", "testing", "reading", "writing"]).not.toContain(quietActivity);
  });

});
