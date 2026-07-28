// The living town view: a PixiJS canvas of the tiled overworld + a per-frame
// simulation of walking characters, with a DOM overlay layer carrying each
// character's hover tooltip, aria label, and test id.
//
// Split of responsibility:
//   townModel (store → roster)  — who exists + presence state (pure).
//   buildWorld (roster → world) — the tiled grid + building placement (pure).
//   stepTownSim (per frame)     — where everyone physically is (pure reducer).
//   pixiScene                   — draws world + characters from those.
// The overlay nodes are positioned imperatively from the sim each frame (React
// never re-renders per frame); the roster list itself only re-renders when the
// store changes, so hover/aria/e2e see one node per live session, following its
// sprite.

import { useEffect, useMemo, useRef, useState } from "react";
import { Application } from "pixi.js";
import { useStore } from "../store";
import { townModel } from "../selectors";
import { agentIdentity } from "../agents";
import { timeAgo } from "../utils/dates";
import { buildWorld, type TownWorld } from "./world";
import { createSim, stepTownSim, type RosterChar } from "./sim";
import { charKeyForAgent, createTownScene, type CharStyle, type TownTheme } from "./pixiScene";
import { loadTownTextures, type TownTextures } from "./assets";

const SCALE = 2;
const TILE_PX = 16 * SCALE;
/** Fixed simulation step (ms) — the sim advances in these chunks regardless of
 *  frame rate; MAX_SIM_STEPS caps catch-up so a slow frame can't spiral. */
const SIM_STEP_MS = 16;
const MAX_SIM_STEPS = 5;

/** Parse "#rrggbb" to a Pixi hex number, or null. */
function cssColorToHex(css: string): number | null {
  const m = css.trim().match(/^#([0-9a-f]{6})$/i);
  return m ? parseInt(m[1], 16) : null;
}

function resolveTheme(el: HTMLElement): TownTheme {
  const cs = getComputedStyle(el);
  const num = (v: string, fb: number) => cssColorToHex(cs.getPropertyValue(v)) ?? fb;
  return {
    ground: num("--bg-inset", 0xf6f5f4),
    wall: num("--bg-card", 0xffffff),
    roof: num("--border", 0xe5e3df),
    title: num("--text", 0x37352f),
    inkMuted: num("--text-muted", 0x787671),
    blocked: num("--danger", 0xe03131),
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}

/** A character for the view: the sim's roster fields plus the presentation
 *  fields the DOM overlay tooltip needs. Structurally a RosterChar, so it feeds
 *  the sim directly while also driving the overlay. */
interface TownChar extends RosterChar {
  lastLog: string | null;
  at: string;
}

/** Flatten the town model into TownChars: one per character, tagged with the
 *  index of its building (== its room's index in model.rooms). */
function charsFromModel(model: ReturnType<typeof townModel>): TownChar[] {
  const out: TownChar[] = [];
  model.rooms.forEach((room, buildingIndex) => {
    for (const c of room.characters) {
      out.push({
        taskId: c.taskId,
        agentName: c.agentName,
        state: c.state,
        live: c.live,
        buildingIndex,
        lastLog: c.lastLog,
        at: c.at,
      });
    }
  });
  return out;
}

export function TownView() {
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const live = useStore((s) => s.live);
  const presence = useStore((s) => s.presence);

  const model = useMemo(
    () => townModel(projects, tasks, live, presence),
    [projects, tasks, live, presence],
  );
  const roster = useMemo(() => charsFromModel(model), [model]);

  const hostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const sceneRef = useRef<ReturnType<typeof createTownScene> | null>(null);
  const simRef = useRef(createSim());
  const nodeRefs = useRef(new Map<number, HTMLButtonElement>());
  const [width, setWidth] = useState(0);

  const world = useMemo(() => buildWorld(model, width || 900, SCALE), [model, width]);

  // Latest-value refs so the ticker reads current state without re-subscribing.
  const rosterRef = useRef(roster);
  const worldRef = useRef<TownWorld>(world);
  rosterRef.current = roster;
  worldRef.current = world;

  // Style lookup (presence-derived, per character) for the scene.
  const styleOf = useMemo(() => {
    const map = new Map<number, CharStyle>();
    for (const r of roster) {
      map.set(r.taskId, { agentKey: charKeyForAgent(r.agentName), state: r.state, live: r.live });
    }
    return (taskId: number) => map.get(taskId);
  }, [roster]);
  const styleRef = useRef(styleOf);
  styleRef.current = styleOf;

  // Fixed-timestep accumulator, a signature of the current grid geometry (to
  // detect real layout changes vs. mere presence churn), and the visibility
  // listener's teardown (registered inside the async init).
  const accRef = useRef(0);
  const worldSigRef = useRef("");
  const visibilityCleanup = useRef<() => void>(() => {});

  // Create the Pixi app once; drive the sim from its ticker.
  useEffect(() => {
    const host = hostRef.current;
    const wrap = wrapRef.current;
    if (!host || !wrap) return;
    let disposed = false;
    const app = new Application();
    void app
      .init({
        background: getComputedStyle(host).getPropertyValue("--bg-inset").trim() || "#f6f5f4",
        antialias: false,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
      })
      .then(() => loadTownTextures())
      .then((tex: TownTextures) => {
        if (disposed) {
          app.destroy(true);
          return;
        }
        wrap.appendChild(app.canvas);
        app.canvas.style.display = "block";
        appRef.current = app;
        const scene = createTownScene(app, tex, SCALE);
        sceneRef.current = scene;
        setWidth(host.clientWidth);

        app.ticker.add((ticker) => {
          const h = hostRef.current;
          if (!h) return;
          const theme = resolveTheme(h);
          // Pause on genuine invisibility (minimize / hidden tab) — NOT on focus
          // loss, so a window on a second monitor keeps living.
          if (document.hidden) return;
          // Fixed-timestep: accumulate real elapsed time, advance the sim in
          // fixed SIM_STEP_MS chunks (frame-rate independent, deterministic),
          // capped so a stalled frame can't trigger a spiral of death.
          accRef.current += ticker.deltaMS;
          let steps = 0;
          while (accRef.current >= SIM_STEP_MS && steps < MAX_SIM_STEPS) {
            stepTownSim(simRef.current, rosterRef.current, SIM_STEP_MS, worldRef.current, Math.random, {
              reducedMotion: theme.reducedMotion,
            });
            accRef.current -= SIM_STEP_MS;
            steps++;
          }
          if (steps === MAX_SIM_STEPS) accRef.current = 0; // fell behind → drop backlog
          scene.syncChars(simRef.current, styleRef.current, ticker.deltaMS, theme);
          positionOverlay();
        });

        // Snap to a valid resting state when the tab becomes visible again
        // (spec: reconcile + snap on visibility restore). A fresh sim respawns
        // everyone at their doors on the next tick.
        const onVisibility = () => {
          if (!document.hidden) {
            simRef.current = createSim();
            accRef.current = 0;
          }
        };
        document.addEventListener("visibilitychange", onVisibility);
        visibilityCleanup.current = () =>
          document.removeEventListener("visibilitychange", onVisibility);
      })
      .catch((err) => {
        // WebGL can be unavailable (e.g. a GPU-less test webview). The pixel
        // layer is skipped, but the DOM overlay still renders the roster.
        console.warn("[town] renderer unavailable, showing overlay only:", err);
      });

    const ro = new ResizeObserver(() => setWidth(host.clientWidth));
    ro.observe(host);
    return () => {
      disposed = true;
      ro.disconnect();
      visibilityCleanup.current();
      sceneRef.current?.destroy();
      sceneRef.current = null;
      appRef.current?.destroy(true);
      appRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw the (static) world when it changes; size the canvas to the world.
  useEffect(() => {
    const host = hostRef.current;
    const app = appRef.current;
    const scene = sceneRef.current;
    if (!host || !app || !scene) return;
    app.renderer.resize(world.cols * TILE_PX, world.rows * TILE_PX);
    scene.renderWorld(world, resolveTheme(host));
    // If the grid geometry actually changed (resize / project set) — not just
    // presence churn — the old sim positions may be off the new grid; snap by
    // respawning everyone at their doors. Signature keys on geometry only.
    const sig = `${world.cols}x${world.rows}:${world.buildings
      .map((b) => `${b.door.x},${b.door.y}`)
      .join(";")}`;
    if (sig !== worldSigRef.current) {
      worldSigRef.current = sig;
      simRef.current = createSim();
      accRef.current = 0;
    }
  }, [world]);

  /** Move each overlay node onto its character's current sim position. */
  function positionOverlay() {
    const sim = simRef.current;
    for (const [taskId, node] of nodeRefs.current) {
      const c = sim.chars.get(taskId);
      if (!c) {
        node.style.display = "none";
        continue;
      }
      node.style.display = "block";
      node.style.left = `${c.pos.x * TILE_PX + TILE_PX / 2 - 18}px`;
      node.style.top = `${c.pos.y * TILE_PX + TILE_PX - 34}px`;
    }
  }

  return (
    <div className="town" ref={hostRef}>
      <div
        className="town-canvas"
        ref={wrapRef}
        style={{ width: world.cols * TILE_PX, height: world.rows * TILE_PX }}
      >
        <div className="town-overlay" aria-label="Agent town" ref={overlayRef}>
          {roster.map((r) => {
            const { label } = agentIdentity(r.agentName);
            const detail = r.lastLog ?? r.state;
            const title = `${label} · ${detail} · ${timeAgo(r.at)}`;
            return (
              <button
                key={r.taskId}
                ref={(el) => {
                  if (el) nodeRefs.current.set(r.taskId, el);
                  else nodeRefs.current.delete(r.taskId);
                }}
                className={`town-char ${r.state}${r.live ? " live" : ""}`}
                data-testid={`town-char-${r.taskId}`}
                data-state={r.state}
                data-building={r.buildingIndex}
                title={title}
                aria-label={title}
                type="button"
              />
            );
          })}
        </div>
      </div>
      {roster.length === 0 && (
        <div className="town-empty">
          No agents at work right now. Claim a task and its character appears here.
        </div>
      )}
    </div>
  );
}
