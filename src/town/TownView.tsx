// The living town view: a PixiJS canvas of the tiled overworld + a per-frame
// simulation of walking characters, seen through a pan/zoom camera, with a DOM
// overlay layer carrying each character's tooltip, aria label and test id.
//
// Split of responsibility:
//   townModel (store → roster)  — who exists + presence state (pure).
//   buildWorld (roster → world) — the tiled grid + building placement (pure).
//   stepTownSim (per frame)     — where everyone physically is (pure reducer).
//   camera.ts                   — pan/zoom/follow math (pure).
//   daynight.ts                 — hour → tint/glow (pure).
//   pixiScene                   — draws world + characters + ambience from those.
// The canvas is sized to the VIEWPORT; the world is larger and the camera
// scrolls it. Overlay nodes are positioned imperatively from the sim + camera
// each frame (React never re-renders per frame).

import { useEffect, useMemo, useRef, useState } from "react";
import { Application } from "pixi.js";
import { useStore } from "../store";
import { townModel } from "../selectors";
import { agentIdentity } from "../agents";
import { timeAgo } from "../utils/dates";
import { buildWorld, TILE_PX, type TownWorld } from "./world";
import { createSim, stepTownSim, type RosterChar } from "./sim";
import { charKeyForAgent, createTownScene, type CharStyle, type TownTheme } from "./pixiScene";
import { loadTownTextures, type TownTextures } from "./assets";
import {
  clampCamera,
  follow as followCam,
  nextZoom,
  panBy,
  zoomTo,
  type Camera,
} from "./camera";
import { dayNightPhase } from "./daynight";

const SCALE = 2;
const BASE_TILE = TILE_PX * SCALE; // world px per tile before zoom
const DEFAULT_ZOOM = 1.5;
const FOLLOW_EASE = 0.12;
/** Per-frame ease for the click-a-building camera glide (snaps when very close). */
const FRAME_EASE = 0.18;
/** Fixed simulation step (ms); MAX_SIM_STEPS caps catch-up so a slow frame can't spiral. */
const SIM_STEP_MS = 16;
const MAX_SIM_STEPS = 5;

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

interface TownChar extends RosterChar {
  lastLog: string | null;
  at: string;
}

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
  const appRef = useRef<Application | null>(null);
  const sceneRef = useRef<ReturnType<typeof createTownScene> | null>(null);
  const simRef = useRef(createSim());
  const nodeRefs = useRef(new Map<number, HTMLButtonElement>());
  const buildingRefs = useRef(new Map<number, HTMLButtonElement>());
  const [view, setView] = useState({ w: 0, h: 0 });
  const [followId, setFollowId] = useState<number | null>(null);
  // Flips true once the async Pixi init + textures are ready, so the render
  // effect (which needs the scene) re-runs and actually draws the world.
  const [ready, setReady] = useState(false);

  // World is roster-driven (not viewport-driven) — resizing must not rebuild it.
  const world = useMemo(() => buildWorld(model), [model]);
  const worldPx = useMemo(() => ({ w: world.cols * BASE_TILE, h: world.rows * BASE_TILE }), [world]);

  // Latest-value refs so the ticker reads current state without re-subscribing.
  const rosterRef = useRef(roster);
  const worldRef = useRef<TownWorld>(world);
  const worldPxRef = useRef(worldPx);
  const viewRef = useRef(view);
  const camRef = useRef<Camera>({ x: 0, y: 0, zoom: DEFAULT_ZOOM });
  /** A pending camera destination (clicking a building) the loop glides toward;
   *  null when idle. Cleared the instant the user takes manual control. */
  const camTargetRef = useRef<Camera | null>(null);
  const followRef = useRef<number | null>(followId);
  rosterRef.current = roster;
  worldRef.current = world;
  worldPxRef.current = worldPx;
  viewRef.current = view;
  followRef.current = followId;

  // Which buildings have an actively *working* session → their windows are lit.
  // A quiet building (even a quiet-but-live idler wandering the plaza) stays dark.
  const liveBuildingsRef = useRef<Set<number>>(new Set());
  liveBuildingsRef.current = useMemo(
    () => new Set(roster.filter((r) => r.state === "working").map((r) => r.buildingIndex)),
    [roster],
  );

  const styleOf = useMemo(() => {
    const map = new Map<number, CharStyle>();
    for (const r of roster) {
      map.set(r.taskId, { agentKey: charKeyForAgent(r.agentName), state: r.state, live: r.live });
    }
    return (taskId: number) => map.get(taskId);
  }, [roster]);
  const styleRef = useRef(styleOf);
  styleRef.current = styleOf;

  const accRef = useRef(0);
  const worldSigRef = useRef("");
  const visibilityCleanup = useRef<() => void>(() => {});

  /** Centre the camera on the world (used on first mount and geometry changes). */
  function centreCamera() {
    const v = viewRef.current;
    if (v.w === 0) return;
    const zoom = camRef.current.zoom;
    camRef.current = clampCamera(
      { x: (worldPxRef.current.w - v.w / zoom) / 2, y: (worldPxRef.current.h - v.h / zoom) / 2, zoom },
      worldPxRef.current,
      v,
    );
  }

  // Create the Pixi app once; drive the sim + camera + ambience from its ticker.
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
        setView({ w: host.clientWidth, h: host.clientHeight });
        setReady(true);

        // One simulation + camera + render frame. Driven every rAF tick by the
        // Pixi ticker; also exposed as __townStep so an automated webview whose
        // rAF is throttled (never composited) can pump frames deterministically.
        const runFrame = (dtMs: number) => {
          const h = hostRef.current;
          if (!h) return;
          const theme = resolveTheme(h);
          accRef.current += dtMs;
          let steps = 0;
          while (accRef.current >= SIM_STEP_MS && steps < MAX_SIM_STEPS) {
            stepTownSim(simRef.current, rosterRef.current, SIM_STEP_MS, worldRef.current, Math.random, {
              reducedMotion: theme.reducedMotion,
            });
            accRef.current -= SIM_STEP_MS;
            steps++;
          }
          if (steps === MAX_SIM_STEPS) accRef.current = 0;

          // Resolve the camera: following a character overrides any pending
          // building-glide; otherwise ease toward a pending destination.
          const fid = followRef.current;
          if (fid !== null) {
            camTargetRef.current = null; // following wins over a building glide
            const c = simRef.current.chars.get(fid);
            if (c) {
              const target = {
                x: c.pos.x * BASE_TILE + BASE_TILE / 2,
                y: c.pos.y * BASE_TILE + BASE_TILE / 2,
              };
              camRef.current = followCam(camRef.current, target, worldPxRef.current, viewRef.current, FOLLOW_EASE);
            }
          } else if (camTargetRef.current) {
            // Re-clamp the pending target to CURRENT geometry every frame. If the
            // viewport resizes or the world changes mid-glide, a target clamped
            // only at creation can become unreachable — the clamped intermediate
            // never meets it and the glide never completes. Re-clamping keeps the
            // target a legal camera, so the ease always converges.
            const t = clampCamera(camTargetRef.current, worldPxRef.current, viewRef.current);
            camTargetRef.current = t;
            const cam = camRef.current;
            const nx = cam.x + (t.x - cam.x) * FRAME_EASE;
            const ny = cam.y + (t.y - cam.y) * FRAME_EASE;
            const nz = cam.zoom + (t.zoom - cam.zoom) * FRAME_EASE;
            const done =
              Math.abs(t.x - nx) < 0.5 && Math.abs(t.y - ny) < 0.5 && Math.abs(t.zoom - nz) < 0.001;
            camRef.current = done
              ? t
              : clampCamera({ x: nx, y: ny, zoom: nz }, worldPxRef.current, viewRef.current);
            if (done) camTargetRef.current = null;
          }
          scene.setCamera(camRef.current);
          scene.syncChars(simRef.current, styleRef.current, dtMs, theme);

          // Day/night from the wall clock; lit windows for live offices.
          const now = new Date();
          const amb = dayNightPhase(now.getHours() + now.getMinutes() / 60);
          scene.setAmbience(amb, (i) => liveBuildingsRef.current.has(i));

          positionOverlay();
        };

        app.ticker.add((ticker) => {
          if (document.hidden) return;
          runFrame(ticker.deltaMS);
        });
        (window as unknown as { __townStep?: (dt?: number) => void }).__townStep = (dt = 16) => {
          runFrame(dt);
          app.render();
        };

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
        console.warn("[town] renderer unavailable, showing overlay only:", err);
      });

    const ro = new ResizeObserver(() => setView({ w: host.clientWidth, h: host.clientHeight }));
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

  // Resize the renderer to the viewport and re-clamp the camera.
  useEffect(() => {
    const app = appRef.current;
    if (!app || !ready || view.w === 0) return;
    app.renderer.resize(view.w, view.h);
    sceneRef.current?.resize(view.w, view.h);
    camRef.current = clampCamera(camRef.current, worldPx, view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, worldPx, ready]);

  // Redraw the (static) world when it changes or once the scene is ready;
  // re-centre + reset the sim on geometry changes.
  useEffect(() => {
    const host = hostRef.current;
    const scene = sceneRef.current;
    if (!host || !scene || !ready) return;
    scene.renderWorld(world, resolveTheme(host));
    const sig = `${world.cols}x${world.rows}`;
    if (sig !== worldSigRef.current) {
      worldSigRef.current = sig;
      simRef.current = createSim();
      accRef.current = 0;
      centreCamera();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, ready]);

  // Pan / zoom input on the canvas.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e: PointerEvent) => {
      // A pointerdown that reaches the canvas is on the background — the
      // character/building buttons stopPropagation. So it releases any follow
      // (spec: cleared by a background click / drag) and begins a pan.
      setFollowId(null);
      camTargetRef.current = null; // manual pan cancels a building glide
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      wrap.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      camRef.current = panBy(camRef.current, { x: dx, y: dy }, worldPxRef.current, viewRef.current);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFollowId(null); // spec: Escape releases follow
        camTargetRef.current = null; // and cancels a building glide
      }
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      try {
        wrap.releasePointerCapture(e.pointerId);
      } catch {
        /* capture may already be gone */
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      camTargetRef.current = null; // manual zoom cancels a building glide
      const nz = nextZoom(camRef.current.zoom, e.deltaY < 0 ? 1 : -1);
      camRef.current = zoomTo(camRef.current, nz, pointer, worldPxRef.current, viewRef.current);
    };
    wrap.addEventListener("pointerdown", onDown);
    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerup", onUp);
    wrap.addEventListener("pointercancel", onUp);
    wrap.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
      wrap.removeEventListener("pointerdown", onDown);
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerup", onUp);
      wrap.removeEventListener("pointercancel", onUp);
      wrap.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  /** Frame a building: centre + step-zoom the camera on it, releasing follow. */
  function frameBuilding(index: number) {
    setFollowId(null);
    const b = worldRef.current.buildings[index];
    if (!b) return;
    // Step *in*: never zoom out below the current level (spec: "center + step
    // zoom in"), but bring a zoomed-out view up to a readable level.
    const zoom = Math.max(camRef.current.zoom, 2);
    const cx = (b.tx + b.tw / 2) * BASE_TILE;
    const cy = (b.ty + b.th / 2) * BASE_TILE;
    // Glide there over the next frames (the loop eases camRef toward this),
    // rather than snapping — matches the eased character-follow feel.
    camTargetRef.current = clampCamera(
      { x: cx - viewRef.current.w / zoom / 2, y: cy - viewRef.current.h / zoom / 2, zoom },
      worldPxRef.current,
      viewRef.current,
    );
  }

  /** Move each overlay node onto its character/building on-screen rect (camera-aware). */
  function positionOverlay() {
    const sim = simRef.current;
    const cam = camRef.current;
    for (const [taskId, node] of nodeRefs.current) {
      const c = sim.chars.get(taskId);
      if (!c) {
        node.style.display = "none";
        continue;
      }
      const sx = (c.pos.x * BASE_TILE + BASE_TILE / 2 - cam.x) * cam.zoom;
      const sy = (c.pos.y * BASE_TILE + BASE_TILE - cam.y) * cam.zoom;
      node.style.display = "block";
      node.style.left = `${sx - 18}px`;
      node.style.top = `${sy - 34}px`;
    }
    for (const [i, node] of buildingRefs.current) {
      const b = worldRef.current.buildings[i];
      if (!b) {
        node.style.display = "none";
        continue;
      }
      node.style.display = "block";
      node.style.left = `${(b.tx * BASE_TILE - cam.x) * cam.zoom}px`;
      node.style.top = `${(b.ty * BASE_TILE - cam.y) * cam.zoom}px`;
      node.style.width = `${b.tw * BASE_TILE * cam.zoom}px`;
      node.style.height = `${b.th * BASE_TILE * cam.zoom}px`;
    }
  }

  return (
    <div className="town" ref={hostRef}>
      <div className="town-canvas" ref={wrapRef} style={{ width: "100%", height: "100%" }}>
        <div className="town-overlay" aria-label="Agent town">
          {world.buildings.map((b, i) => (
            <button
              key={`building-${i}`}
              ref={(el) => {
                if (el) buildingRefs.current.set(i, el);
                else buildingRefs.current.delete(i);
              }}
              className="town-building"
              data-testid={`town-building-${i}`}
              aria-label={`Frame ${b.room.name}`}
              title={`Frame ${b.room.name}`}
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => frameBuilding(i)}
            />
          ))}
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
                className={`town-char ${r.state}${r.live ? " live" : ""}${followId === r.taskId ? " following" : ""}`}
                data-testid={`town-char-${r.taskId}`}
                data-state={r.state}
                data-building={r.buildingIndex}
                title={title}
                aria-label={title}
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setFollowId((cur) => (cur === r.taskId ? null : r.taskId))}
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
