// The town view: a PixiJS canvas of rooms + characters, with a DOM overlay layer
// carrying each character's hover tooltip, aria label, and test id. Canvas draws
// the pixels; the overlay (same geometry, from layoutTown) is what a mouse and a
// screen reader and e2e actually touch.

import { useEffect, useMemo, useRef, useState } from "react";
import { Application } from "pixi.js";
import { useStore } from "../store";
import { townModel } from "../selectors";
import { agentIdentity } from "../agents";
import { timeAgo } from "../utils/dates";
import { layoutTown } from "./layout";
import { createTownScene, type TownTheme } from "./pixiScene";
import { loadTownTextures, type TownTextures } from "./assets";

/** Parse "#rrggbb" to a Pixi hex number, or null. */
function cssColorToHex(css: string): number | null {
  const m = css.trim().match(/^#([0-9a-f]{6})$/i);
  return m ? parseInt(m[1], 16) : null;
}

function resolveTheme(el: HTMLElement): TownTheme {
  const cs = getComputedStyle(el);
  const num = (v: string, fb: number) => cssColorToHex(cs.getPropertyValue(v)) ?? fb;
  return {
    floor: num("--bg-card", 0xffffff),
    wall: num("--border", 0xe5e3df),
    title: num("--text", 0x37352f),
    inkMuted: num("--text-muted", 0x787671),
    blocked: num("--danger", 0xe03131),
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
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

  const hostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const sceneRef = useRef<ReturnType<typeof createTownScene> | null>(null);
  const [width, setWidth] = useState(0);

  const layout = useMemo(() => layoutTown(model, width || 900), [model, width]);

  // Create the Pixi app once; measure the scroll container for the layout width.
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
        sceneRef.current = createTownScene(app, tex);
        setWidth(host.clientWidth);
      })
      .catch((err) => {
        // WebGL can be unavailable (e.g. a GPU-less test webview). The pixel
        // layer is then skipped, but the DOM overlay still renders the roster —
        // so the view degrades to labels-over-empty rather than crashing.
        console.warn("[town] renderer unavailable, showing overlay only:", err);
      });

    const ro = new ResizeObserver(() => setWidth(host.clientWidth));
    ro.observe(host);
    return () => {
      disposed = true;
      ro.disconnect();
      sceneRef.current?.destroy();
      sceneRef.current = null;
      appRef.current?.destroy(true);
      appRef.current = null;
    };
  }, []);

  // Redraw whenever the model or size changes. Cheap: fires on store reloads and
  // resizes, never per frame (the ticker owns animation).
  useEffect(() => {
    const host = hostRef.current;
    const app = appRef.current;
    const scene = sceneRef.current;
    if (!host || !app || !scene) return;
    app.renderer.resize(layout.width, layout.height);
    scene.render(layout, resolveTheme(host));
  }, [layout]);

  const placements = layout.rooms.flatMap((r) => r.chars);

  return (
    <div className="town" ref={hostRef}>
      <div
        className="town-canvas"
        ref={wrapRef}
        style={{ width: layout.width, height: layout.height }}
      >
        <div className="town-overlay" aria-label="Agent town">
          {placements.map(({ char, x, y }) => {
            const { label } = agentIdentity(char.agentName);
            const detail = char.lastLog ?? char.state;
            const title = `${label} · ${detail} · ${timeAgo(char.at)}`;
            return (
              <button
                key={char.taskId}
                className={`town-char ${char.state}${char.live ? " live" : ""}`}
                data-testid={`town-char-${char.taskId}`}
                data-state={char.state}
                style={{ left: x - 18, top: y - 26 }}
                title={title}
                aria-label={title}
                type="button"
              />
            );
          })}
        </div>
      </div>
      {model.rooms.every((r) => r.characters.length === 0) && (
        <div className="town-empty">
          No agents at work right now. Claim a task and its character appears here.
        </div>
      )}
    </div>
  );
}
