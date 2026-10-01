import type { TownModel } from "../selectors";
import type { BuildingStyle } from "./layout";
import {
  buildScene,
  hash,
  isHelper,
  mix,
  rng,
  shade,
  tint,
  townPalette,
  type AgentItem,
  type BoxShape,
  type BuildingItem,
  type Deco,
  type Face,
  type Item,
  type LabelItem,
  type Palette,
  type TownScene,
} from "./scene";

// The Town's Canvas 2D renderer (lane 3's TownPage drives it). A port of the
// engine in docs/artifacts/2026-10-01-town-redesign.html, layout B: an isometric
// painter over scene.ts's sorted items, a camera that frames the town or one
// island, per-building cut-away, shadows, sky, and a hit list rebuilt every frame.

/** What the pointer is over. Bots, drones and scenery never produce one. */
export type TownTarget =
  | { kind: "agent"; taskId: number }
  /** A project's building; clicking it opens or closes that one building. */
  | { kind: "building"; projectId: number }
  /** A project's floating name chip; clicking it focuses that island. */
  | { kind: "label"; projectId: number };

export interface TownHover {
  target: TownTarget;
  /** Anchor in CSS pixels relative to the canvas's top-left, for placing the card. */
  x: number;
  y: number;
}

export interface TownRendererOptions {
  /** Pointer moved onto a target, or off every target (null). */
  onHover: (hover: TownHover | null) => void;
  onClick: (target: TownTarget) => void;
}

type Point = [number, number];

interface Camera {
  scale: number;
  ox: number;
  oy: number;
}

/** An agent drawn this frame: a circle around its body, in CSS px. */
interface AgentHit {
  x: number;
  y: number;
  r: number;
  taskId: number;
}

/** Screen box [x0, y0, x1, y1] in CSS px. */
type Rect = [number, number, number, number];

/** Per-building state that survives scene rebuilds. */
interface BuildingState {
  /** 0 closed .. 1 cut open, eased toward the open set. */
  cut: number;
  /** Height of the roof's top this frame; the name chip floats above it. */
  topZ: number;
}

const ISO_Z = 0.8;
const FONT = '"Notion Sans", Inter, -apple-system, BlinkMacSystemFont, sans-serif';
const SHIRTS = ["#3d405b", "#81b29a", "#e0a458", "#5b8def", "#8d6e63", "#6c5b9e", "#b08968", "#4f9d9a"];
const SKIN = ["#f1c7a5", "#d9a27e", "#a8724f", "#f6d5bd", "#c68863"];
const HAIR = ["#2b2420", "#5a3b28", "#c9a15a", "#1f1f24", "#8a4b2f", "#d8d2c8"];
const PANTS = ["#2f3542", "#4a4e69", "#5d4a3a"];
const FLOWERS = ["#ffffff", "#ffd75e", "#ff8fb1", "#b9a7ff"];
/** Plank joints on each storey's floor. */
const FLOOR_SPECKS = [[0.7], [1.9], [3.1], [1.2], [2.6]];
const EMPTY_MODEL: TownModel = { rooms: [] };

/** World (x, y, z) to isometric screen units before the camera. */
function iso(x: number, y: number, z: number): Point {
  return [x - y, (x + y) * 0.5 - z * ISO_Z];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function poly(ctx: CanvasRenderingContext2D, points: Point[], fill?: string | CanvasGradient): void {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
}

/** Convex hull, for a box's shadow cast from its four base and four offset corners. */
function hull(points: Point[]): Point[] {
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  const upper: Point[] = [];
  for (const q of points) {
    while (lower.length > 1 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = points.length - 1; i >= 0; i--) {
    const q = points[i];
    while (upper.length > 1 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function ease(x: number): number {
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

/** Where a building's card anchors: the top centre of its screen box. */
function buildingAnchor([x0, y0, x1]: Rect): { x: number; y: number } {
  return { x: (x0 + x1) / 2, y: y0 };
}

/** Every agent drawn inside a building, by task, mapped to the building's project. */
function agentBuildings(scene: TownScene): Map<number, number> {
  const byTask = new Map<number, number>();
  for (const b of scene.buildings) {
    for (const item of b.contents.flat()) if (item.kind === "agent") byTask.set(item.character.taskId, b.projectId);
  }
  return byTask;
}

function targetKey(target: TownTarget | null): string {
  if (!target) return "";
  return target.kind === "agent" ? `agent:${target.taskId}` : `${target.kind}:${target.projectId}`;
}

/**
 * Owns one canvas: sizes it to its box (ResizeObserver, devicePixelRatio), runs
 * the draw loop (paused while the page is hidden; ambient motion frozen under
 * prefers-reduced-motion) and hit-tests the pointer. Every setter is cheap to call
 * on each React render: it rebuilds the scene only when its input changed.
 */
export class TownRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly shadowCanvas: HTMLCanvasElement;
  private readonly shadowCtx: CanvasRenderingContext2D;
  private readonly options: TownRendererOptions;
  private readonly reducedMotion: MediaQueryList;
  private readonly resizeObserver: ResizeObserver;
  private readonly intersectionObserver: IntersectionObserver;

  private model: TownModel = EMPTY_MODEL;
  private modelKey = "";
  private dark = false;
  private open: ReadonlySet<number> = new Set();
  private bots = true;
  private focusId: number | null = null;
  private palette: Palette = townPalette(false);
  private scene: TownScene;
  private readonly buildingStates = new Map<number, BuildingState>();
  /** taskId -> projectId for agents inside a building, so a hidden one anchors there. */
  private agentBuildings = new Map<number, number>();

  private width = 0;
  private height = 0;
  private dpr = 1;
  private camera: Camera = { scale: 1, ox: 0, oy: 0 };
  private overview: Camera = { scale: 1, ox: 0, oy: 0 };
  private target: Camera | null = null;

  private frameId = 0;
  private onScreen = true;
  private destroyed = false;
  /** Something is still easing (camera, a building opening): keep drawing under reduced motion. */
  private animating = false;
  private still = false;

  // per-frame paint state
  private alpha = 1;
  private dimmed = false;
  private hitOK = true;
  private shellHit = false;
  private hits: AgentHit[] = [];
  private labelRects: { projectId: number; rect: Rect }[] = [];
  private buildingRects: { projectId: number; rect: Rect }[] = [];

  private pointer: Point | null = null;
  private hoverKey = "";

  private readonly clouds: { x: number; y: number; size: number; speed: number }[];
  private readonly stars: { x: number; y: number; size: number; phase: number }[];
  private readonly fireflies: { x: number; y: number; phase: number }[];
  private readonly birds: { offset: number; y: number }[];

  constructor(canvas: HTMLCanvasElement, options: TownRendererOptions) {
    this.canvas = canvas;
    this.options = options;
    const ctx = canvas.getContext("2d");
    this.shadowCanvas = document.createElement("canvas");
    const shadowCtx = this.shadowCanvas.getContext("2d");
    if (!ctx || !shadowCtx) throw new Error("Town: no 2D canvas context");
    this.ctx = ctx;
    this.shadowCtx = shadowCtx;
    this.scene = buildScene(this.model, this.palette);
    this.agentBuildings = agentBuildings(this.scene);

    const r = rng(hash("town-sky"));
    this.clouds = Array.from({ length: 7 }, () => ({ x: r(), y: 0.06 + r() * 0.42, size: 0.6 + r() * 0.8, speed: 0.4 + r() * 0.8 }));
    this.stars = Array.from({ length: 70 }, () => ({ x: r(), y: r() * 0.65, size: r() * 1.4 + 0.4, phase: r() * 6 }));
    this.fireflies = Array.from({ length: 26 }, () => ({ x: r(), y: 0.25 + r() * 0.65, phase: r() * 6 }));
    this.birds = Array.from({ length: 4 }, () => ({ offset: r(), y: 0.08 + r() * 0.25 }));

    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion.addEventListener("change", this.wake);
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(canvas);
    this.intersectionObserver = new IntersectionObserver((entries) => {
      this.onScreen = entries[entries.length - 1]?.isIntersecting ?? true;
      this.wake();
    });
    this.intersectionObserver.observe(canvas);
    document.addEventListener("visibilitychange", this.wake);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("click", this.onClick);
    this.fit();
  }

  /** The roster to draw: one island per project room, Inbox agents in the square. */
  setModel(model: TownModel): void {
    const key = JSON.stringify(model);
    if (key === this.modelKey) return;
    this.model = model;
    this.modelKey = key;
    this.rebuild();
  }

  /** Night palette (dark theme) or day palette. */
  setDark(dark: boolean): void {
    if (dark === this.dark) return;
    this.dark = dark;
    this.rebuild();
  }

  /** Buildings drawn cut open; every other building is drawn closed. */
  setOpen(projectIds: ReadonlySet<number>): void {
    if (projectIds.size === this.open.size && [...projectIds].every((id) => this.open.has(id))) return;
    this.open = new Set(projectIds);
    this.wake();
  }

  /** Show helper bots and drones (true) or agents only (false). */
  setBots(show: boolean): void {
    if (show === this.bots) return;
    this.bots = show;
    this.wake();
  }

  /** Zoom to one project's island and fade the rest; null frames the whole town. */
  focus(projectId: number | null): void {
    if (projectId === this.focusId) return;
    this.focusId = projectId;
    this.retarget(false);
    this.wake();
  }

  /** Where an agent is drawn now (CSS px, canvas-relative), for showing its card
   *  from the keyboard. An agent hidden inside a closed building (not at one of
   *  its window silhouettes) anchors where its building's hover does; null when
   *  the agent is not in the scene. */
  agentAnchor(taskId: number): { x: number; y: number } | null {
    const hit = this.hits.find((h) => h.taskId === taskId);
    if (hit) return { x: hit.x, y: hit.y };
    const projectId = this.agentBuildings.get(taskId);
    const building = this.buildingRects.find((b) => b.projectId === projectId);
    return building ? buildingAnchor(building.rect) : null;
  }

  /** Stops the loop and disconnects observers and listeners. */
  destroy(): void {
    this.destroyed = true;
    if (this.frameId) cancelAnimationFrame(this.frameId);
    this.frameId = 0;
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    this.reducedMotion.removeEventListener("change", this.wake);
    document.removeEventListener("visibilitychange", this.wake);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("click", this.onClick);
  }

  // ---------- loop ----------

  private running(): boolean {
    return !this.destroyed && this.onScreen && !document.hidden && this.width > 0;
  }

  private readonly wake = (): void => {
    if (this.frameId || !this.running()) return;
    this.frameId = requestAnimationFrame(this.tick);
  };

  private readonly tick = (now: number): void => {
    this.frameId = 0;
    if (!this.running()) return;
    this.still = this.reducedMotion.matches;
    this.draw(this.still ? 0 : now);
    this.refreshHover();
    if (!this.still || this.animating) this.wake();
  };

  private rebuild(): void {
    this.palette = townPalette(this.dark);
    this.scene = buildScene(this.model, this.palette);
    this.agentBuildings = agentBuildings(this.scene);
    const live = new Set(this.scene.buildings.map((b) => b.projectId));
    for (const id of this.buildingStates.keys()) if (!live.has(id)) this.buildingStates.delete(id);
    if (this.width) {
      this.overview = this.frame(() => true, 22);
      this.retarget(false);
    }
    this.wake();
  }

  /** Size the canvas to its CSS box at device resolution and reframe the camera. */
  private fit(): void {
    const box = this.canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const dpr = window.devicePixelRatio || 1;
    this.width = box.width;
    this.height = box.height;
    this.dpr = dpr;
    this.canvas.width = Math.round(box.width * dpr);
    this.canvas.height = Math.round(box.height * dpr);
    this.shadowCanvas.width = this.canvas.width;
    this.shadowCanvas.height = this.canvas.height;
    this.overview = this.frame(() => true, 22);
    this.retarget(true);
    this.wake();
  }

  // ---------- camera ----------

  /** A camera that frames the items `keep` passes, with `pad` CSS px around them. */
  private frame(keep: (item: Item) => boolean, pad: number): Camera {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const item of this.scene.items) {
      if (item.kind === "fall" || !keep(item)) continue;
      const [bx, by, bz, bw, bd, bh] = item.bounds;
      for (const dx of [0, bw]) {
        for (const dy of [0, bd]) {
          for (const dz of [bz, bz + bh]) {
            const [x, y] = iso(bx + dx, by + dy, dz);
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
          }
        }
      }
    }
    if (!Number.isFinite(x0)) return this.overview;
    const scale = Math.min((this.width - pad * 2) / (x1 - x0), (this.height - pad * 2) / (y1 - y0));
    return {
      scale,
      ox: (this.width - (x1 - x0) * scale) / 2 - x0 * scale,
      oy: (this.height - (y1 - y0) * scale) / 2 - y0 * scale,
    };
  }

  private retarget(snap: boolean): void {
    const focus = this.focusId;
    this.target = focus === null ? this.overview : this.frame((item) => item.group === focus, 40);
    if (snap) this.camera = { ...this.target };
  }

  private moveCamera(): void {
    const target = this.target;
    if (!target) return;
    if (this.still) {
      this.camera = { ...target };
      return;
    }
    const k = 0.12;
    const cam = this.camera;
    cam.scale += (target.scale - cam.scale) * k;
    cam.ox += (target.ox - cam.ox) * k;
    cam.oy += (target.oy - cam.oy) * k;
    if (Math.abs(target.scale - cam.scale) > 1e-3 || Math.abs(target.ox - cam.ox) > 0.3 || Math.abs(target.oy - cam.oy) > 0.3) {
      this.animating = true;
    }
  }

  /** World point to canvas CSS px through the camera. */
  private at(x: number, y: number, z: number): Point {
    const [a, b] = iso(x, y, z);
    return [this.camera.ox + a * this.camera.scale, this.camera.oy + b * this.camera.scale];
  }

  private setAlpha(a: number): void {
    this.alpha = a;
    this.ctx.globalAlpha = a;
  }

  private faded(item: Item): boolean {
    const focus = this.focusId;
    if (focus === null) return false;
    if (item.groups) return !item.groups.includes(focus);
    return item.group !== undefined && item.group !== focus;
  }

  // ---------- pointer ----------

  private targetAt(mx: number, my: number): TownHover | null {
    let best: AgentHit | null = null;
    let bestDistance = Infinity;
    for (const h of this.hits) {
      const distance = Math.hypot(h.x - mx, h.y - my);
      if (distance < h.r && distance < bestDistance) {
        bestDistance = distance;
        best = h;
      }
    }
    if (best) return { target: { kind: "agent", taskId: best.taskId }, x: best.x, y: best.y };
    const inside = ([x0, y0, x1, y1]: Rect) => mx >= x0 && mx <= x1 && my >= y0 && my <= y1;
    const label = this.labelRects.find((l) => inside(l.rect));
    if (label) return { target: { kind: "label", projectId: label.projectId }, x: (label.rect[0] + label.rect[2]) / 2, y: label.rect[1] };
    for (let i = this.buildingRects.length - 1; i >= 0; i--) {
      const b = this.buildingRects[i];
      if (inside(b.rect)) return { target: { kind: "building", projectId: b.projectId }, ...buildingAnchor(b.rect) };
    }
    return null;
  }

  private pointerAt(event: MouseEvent): Point {
    const box = this.canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  }

  /** Report the target under the pointer when it changes (the scene moves under a still pointer too). */
  private refreshHover(): void {
    const hover = this.pointer ? this.targetAt(...this.pointer) : null;
    const key = targetKey(hover?.target ?? null);
    this.canvas.style.cursor = hover ? "pointer" : "";
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    this.options.onHover(hover);
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.pointer = this.pointerAt(event);
    this.refreshHover();
  };

  private readonly onPointerLeave = (): void => {
    this.pointer = null;
    this.refreshHover();
  };

  private readonly onClick = (event: MouseEvent): void => {
    const hover = this.targetAt(...this.pointerAt(event));
    if (hover) this.options.onClick(hover.target);
  };

  // ---------- frame ----------

  private draw(t: number): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.animating = false;
    this.moveCamera();
    this.sky(t);
    this.hits = [];
    this.labelRects = [];
    this.buildingRects = [];
    let shadowed = false;
    for (const item of this.scene.items) {
      if (!shadowed && item.layer >= 0.45) {
        this.shadows();
        shadowed = true;
      }
      this.dimmed = !!item.dim;
      this.setAlpha((item.dim ? 0.6 : 1) * (this.faded(item) ? 0.2 : 1));
      this.hitOK = true;
      this.drawItem(item, 0, t);
    }
    this.setAlpha(1);
    this.foreground(t);
  }

  private drawItem(item: Item, dz: number, t: number): void {
    if (isHelper(item) && !this.bots) return;
    switch (item.kind) {
      case "box":
        return this.box(item, dz, t);
      case "building":
        return this.building(item, dz, t);
      case "agent":
        return this.agent(item, dz, t);
      case "tree":
        return this.tree(item, dz, t);
      case "lamp":
        return this.lamp(item, dz);
      case "plant":
        return this.plant(item, dz, t);
      case "fall":
        return this.fall(item, dz, t);
      case "hang":
        return this.hang(item, dz, t);
      case "steam":
        return this.steam(item, dz, t);
      case "fountain":
        return this.fountain(item, dz, t);
      case "car":
        return this.car(item, dz, t);
      case "snowman":
        return this.snowman(item, dz, t);
      case "pumpkin":
        return this.pumpkin(item, dz, t);
      case "bot":
        return this.bot(item, dz, t);
      case "flag":
        return this.flag(item, dz, t);
      case "drone":
        return this.drone(item, dz, t);
      case "weather":
        return this.weather(item, dz, t);
      case "label":
        this.setAlpha(this.focusId !== null && item.group !== this.focusId ? 0.2 : 1);
        return this.label(item, dz);
    }
  }

  // ---------- sky and foreground ----------

  private sky(t: number): void {
    const { ctx, palette: p, width: W, height: H } = this;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, p.sky[0]);
    g.addColorStop(0.55, p.sky[1]);
    g.addColorStop(1, p.sky[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    if (p.night) {
      for (const s of this.stars) {
        ctx.globalAlpha = 0.35 + 0.45 * Math.sin(t / 700 + s.phase * 5) ** 2;
        ctx.fillStyle = "#fff";
        ctx.fillRect(s.x * W, s.y * H, s.size, s.size);
      }
    }
    ctx.globalAlpha = 1;
    const ox = W * 0.08;
    const oy = H * 0.12;
    const glow = ctx.createRadialGradient(ox, oy, 0, ox, oy, H * 0.35);
    glow.addColorStop(0, p.night ? "rgba(240,235,210,.22)" : "rgba(255,240,200,.75)");
    glow.addColorStop(1, "rgba(255,240,200,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = p.orb;
    ctx.beginPath();
    ctx.arc(ox, oy, p.night ? 18 : 24, 0, 7);
    ctx.fill();
    if (p.night) {
      ctx.fillStyle = "rgba(0,0,0,.08)";
      ctx.beginPath();
      ctx.arc(ox + 5, oy - 4, 5, 0, 7);
      ctx.arc(ox - 6, oy + 5, 3.5, 0, 7);
      ctx.fill();
    }
    for (const c of this.clouds) {
      const x = (((c.x + (t * c.speed) / 600000) % 1.3) - 0.15) * W;
      this.cloud(x, c.y * H, c.size * H * 0.07, p.cloud);
    }
    for (let k = 0; k < 18; k++) {
      const x = (((k / 18 + t / 900000) % 1.1) - 0.05) * W;
      this.cloud(x, H * 0.97 + Math.sin(k * 2.3) * H * 0.02, H * (0.07 + (k % 3) * 0.02), p.sea);
    }
  }

  private cloud(x: number, y: number, r: number, color: string): void {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const [dx, dy, k] of [
      [-1.3, 0.25, 0.6],
      [-0.6, -0.15, 0.85],
      [0.2, -0.35, 1],
      [1, 0, 0.75],
      [1.6, 0.3, 0.5],
    ]) {
      ctx.moveTo(x + dx * r + k * r, y + dy * r);
      ctx.arc(x + dx * r, y + dy * r, k * r, 0, 7);
    }
    ctx.fill();
  }

  private foreground(t: number): void {
    const { ctx, palette: p, width: W, height: H } = this;
    if (p.night) {
      ctx.globalCompositeOperation = "lighter";
      for (const f of this.fireflies) {
        const x = (f.x + Math.sin(t / 2300 + f.phase) * 0.03) * W;
        const y = (f.y + Math.cos(t / 2900 + f.phase) * 0.03) * H;
        const a = 0.5 + 0.5 * Math.sin(t / 480 + f.phase * 3);
        const g = ctx.createRadialGradient(x, y, 0, x, y, 7);
        g.addColorStop(0, `rgba(230,255,150,${0.8 * a})`);
        g.addColorStop(1, "rgba(230,255,150,0)");
        ctx.fillStyle = g;
        ctx.fillRect(x - 7, y - 7, 14, 14);
      }
      ctx.globalCompositeOperation = "source-over";
    } else {
      ctx.strokeStyle = "rgba(60,60,75,.55)";
      ctx.lineWidth = 1.3;
      for (const b of this.birds) {
        const x = (((t / 45000 + b.offset) % 1.3) - 0.15) * W;
        const y = b.y * H + Math.sin(t / 800 + b.offset * 9) * 5;
        const flap = Math.sin(t / 120 + b.offset * 20) * 3;
        ctx.beginPath();
        ctx.moveTo(x - 6, y - flap);
        ctx.quadraticCurveTo(x - 3, y - 2, x, y);
        ctx.quadraticCurveTo(x + 3, y - 2, x + 6, y - flap);
        ctx.stroke();
      }
    }
    const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.75);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, p.night ? "rgba(0,0,0,.35)" : "rgba(70,60,40,.08)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }

  /** Every shadow drawn opaque on a scratch canvas, clipped to the island tops,
   *  then laid over the ground at the palette's shadow alpha. */
  private shadows(): void {
    const c = this.shadowCtx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.width, this.height);
    c.fillStyle = "#000";
    for (const item of this.scene.items) {
      if (!item.shadow) continue;
      const { x, y, w, d, h, z } = item.shadow;
      const sx = h * 0.55;
      const sy = h * 0.12;
      const points: Point[] = [];
      for (const [a, b] of [
        [x, y],
        [x + w, y],
        [x + w, y + d],
        [x, y + d],
      ]) {
        points.push(this.at(a, b, z), this.at(a + sx, b + sy, z));
      }
      poly(c, hull(points));
      c.fill();
    }
    c.globalCompositeOperation = "destination-in";
    c.beginPath();
    for (const g of this.scene.grounds) {
      const z = g.z + g.h;
      [
        [g.x, g.y],
        [g.x + g.w, g.y],
        [g.x + g.w, g.y + g.d],
        [g.x, g.y + g.d],
      ].forEach(([a, b], k) => {
        const [q, r] = this.at(a, b, z);
        if (k) c.lineTo(q, r);
        else c.moveTo(q, r);
      });
      c.closePath();
    }
    c.fill();
    c.globalCompositeOperation = "source-over";
    this.ctx.globalAlpha = this.palette.shadowAlpha;
    this.ctx.drawImage(this.shadowCanvas, 0, 0, this.width, this.height);
    this.ctx.globalAlpha = 1;
  }

  // ---------- boxes ----------

  /** A quad on a box's front-left (L) or front-right (R) face, in face units. */
  private faceQuad(b: { x: number; y: number; w: number; d: number }, z: number, face: Face, u: number, zz: number, w: number, h: number): Point[] {
    const x0 = b.x;
    const x1 = b.x + b.w;
    const y1 = b.y + b.d;
    return face === "L"
      ? [this.at(x0 + u, y1, z + zz), this.at(x0 + u + w, y1, z + zz), this.at(x0 + u + w, y1, z + zz + h), this.at(x0 + u, y1, z + zz + h)]
      : [this.at(x1, y1 - u, z + zz), this.at(x1, y1 - u - w, z + zz), this.at(x1, y1 - u - w, z + zz + h), this.at(x1, y1 - u, z + zz + h)];
  }

  /** Text painted flat onto a box face (signs, board titles). */
  private faceText(b: BoxShape, z: number, face: Face, u: number, zz: number, text: string, size: number, color: string, center = false): void {
    const { ctx, dpr } = this;
    const s = this.camera.scale;
    ctx.save();
    ctx.font = `700 ${size * 100}px ${FONT}`;
    const start = center ? u - ctx.measureText(text).width / 200 : u;
    const o = face === "L" ? this.at(b.x + start, b.y + b.d, z + zz) : this.at(b.x + b.w, b.y + b.d - start, z + zz);
    const ey = face === "L" ? 0.5 * s : -0.5 * s;
    ctx.setTransform((dpr * s) / 100, (dpr * ey) / 100, 0, (dpr * ISO_Z * s) / 100, dpr * o[0], dpr * o[1]);
    ctx.fillStyle = color;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  /** Horizontal courses round a box's two visible faces (siding, logs, brick). */
  private courses(b: BoxShape, z: number, step: number, color: string, top: number): void {
    const { ctx } = this;
    const x0 = b.x;
    const x1 = b.x + b.w;
    const y0 = b.y;
    const y1 = b.y + b.d;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let zz = z + step; zz < top - 0.03; zz += step) {
      ctx.moveTo(...this.at(x0, y1, zz));
      ctx.lineTo(...this.at(x1, y1, zz));
      ctx.lineTo(...this.at(x1, y0, zz));
    }
    ctx.stroke();
  }

  private box(b: BoxShape, dz: number, t: number): void {
    const { ctx } = this;
    const s = this.camera.scale;
    const z = b.z + dz;
    const top = z + b.h;
    const x0 = b.x;
    const x1 = b.x + b.w;
    const y0 = b.y;
    const y1 = b.y + b.d;
    const S = (a: number, c: number, e: number) => this.at(a, c, e);
    if (b.h > 0.025) {
      poly(ctx, [S(x0, y1, z), S(x1, y1, z), S(x1, y1, top), S(x0, y1, top)], shade(b.color, -0.1));
      poly(ctx, [S(x1, y0, z), S(x1, y1, z), S(x1, y1, top), S(x1, y0, top)], shade(b.color, -0.25));
    }
    if (b.side === "strata" && b.strata) {
      ctx.lineWidth = Math.max(1, s * 0.03);
      ctx.strokeStyle = shade(b.color, -0.22);
      for (const [f] of b.strata.slice(0, 3)) {
        const zz = z + b.h * (0.2 + f * 0.7);
        ctx.beginPath();
        ctx.moveTo(...S(x0, y1, zz));
        ctx.lineTo(...S(x1, y1, zz));
        ctx.lineTo(...S(x1, y0, zz));
        ctx.stroke();
      }
      for (const [u, v, k] of b.strata) {
        const face: Face = k < 0.5 ? "L" : "R";
        const length = face === "L" ? b.w : b.d;
        poly(ctx, this.faceQuad(b, z, face, u * (length - 0.6), v * b.h * 0.7, 0.5, 0.18), shade(b.color, k < 0.25 || k > 0.75 ? 0.08 : -0.16));
      }
    } else if (b.side === "siding") {
      this.courses(b, z, 0.2, shade(b.color, -0.14), top);
    } else if (b.side === "logs") {
      this.courses(b, z, 0.22, shade(b.color, -0.3), top);
      this.courses(b, z + 0.04, 0.22, shade(b.color, 0.12), top);
    } else if (b.side === "brick") {
      this.courses(b, z, 0.15, shade(b.color, 0.18), top);
      ctx.beginPath();
      let row = 0;
      for (let zz = z; zz < top - 0.05; zz += 0.15, row++) {
        for (let u = (row % 2) * 0.16; u < b.w; u += 0.32) {
          const q = this.faceQuad(b, z, "L", u, zz - z, 0, 0.15);
          ctx.moveTo(...q[0]);
          ctx.lineTo(...q[3]);
        }
        for (let u = (row % 2) * 0.16; u < b.d; u += 0.32) {
          const q = this.faceQuad(b, z, "R", u, zz - z, 0, 0.15);
          ctx.moveTo(...q[0]);
          ctx.lineTo(...q[3]);
        }
      }
      ctx.stroke();
    } else if (b.side === "plaster") {
      ctx.fillStyle = shade(b.color, 0.06);
      const r = rng(b.seed);
      for (let k = 0; k < 6; k++) {
        const face: Face = r() < 0.5 ? "L" : "R";
        poly(ctx, this.faceQuad(b, z, face, r() * (face === "L" ? b.w : b.d) * 0.8, r() * b.h * 0.8, 0.4, 0.12));
        ctx.fill();
      }
    }
    const T = [S(x0, y0, top), S(x1, y0, top), S(x1, y1, top), S(x0, y1, top)];
    const g = ctx.createLinearGradient(T[0][0], T[0][1], T[2][0], T[2][1]);
    g.addColorStop(0, shade(b.color, 0.07));
    g.addColorStop(1, shade(b.color, -0.04));
    poly(ctx, T, g);
    if (b.specks) this.topTexture(b, b.specks, top, t);
    if (b.texture === "water") {
      ctx.strokeStyle = "rgba(255,255,255,.55)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let k = 0; k < 3; k++) {
        const f = (t / 1800 + k / 3) % 1;
        const u = x0 + b.w * (0.2 + 0.6 * ((k * 0.37) % 1));
        const v = y0 + b.d * f;
        ctx.moveTo(...S(u - 0.15, v, top));
        ctx.lineTo(...S(u + 0.15, v, top));
      }
      ctx.stroke();
    }
    if (b.h > 0.05 && !b.flat) {
      ctx.strokeStyle = shade(b.color, 0.28);
      ctx.globalAlpha = this.alpha * 0.7;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(...T[3]);
      ctx.lineTo(...T[2]);
      ctx.lineTo(...T[1]);
      ctx.stroke();
      ctx.globalAlpha = this.alpha;
    }
    if (b.decos) for (const d of b.decos) this.deco(b, z, d, t);
  }

  private topTexture(b: BoxShape, specks: number[][], top: number, t: number): void {
    const { ctx, palette: p } = this;
    const s = this.camera.scale;
    const S = (u: number, v: number) => this.at(b.x + u, b.y + v, top);
    if (b.texture === "grass" || b.texture === "leaves") {
      ctx.beginPath();
      for (const [u, v, k] of specks) {
        if (k >= 0.62) continue;
        const [px, py] = S(u, v);
        ctx.moveTo(px, py);
        ctx.lineTo(px - 0.035 * s, py - 0.08 * s);
        ctx.moveTo(px, py);
        ctx.lineTo(px + 0.03 * s, py - 0.09 * s);
      }
      ctx.strokeStyle = shade(b.color, -0.2);
      ctx.lineWidth = Math.max(1, s * 0.022);
      ctx.stroke();
      const leaves = b.texture === "leaves";
      const colors = leaves ? ["#d9672e", "#b8402c", "#e8b23e", "#a65a2a"] : FLOWERS;
      for (const [u, v, k] of specks) {
        if (k < 0.62 || k >= (leaves ? 0.9 : 0.72)) continue;
        const [px, py] = S(u, v);
        ctx.fillStyle = tint(p, colors[Math.floor(k * 1000) % 4]);
        if (leaves) {
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(k * 20);
          ctx.fillRect(-s * 0.05, -s * 0.025, s * 0.1, s * 0.05);
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.arc(px, py - 0.03 * s, Math.max(1.2, s * 0.035), 0, 7);
          ctx.fill();
        }
      }
      ctx.fillStyle = shade(b.color, 0.1);
      for (const [u, v, k] of specks) {
        if (k < 0.93) continue;
        const [px, py] = S(u, v);
        ctx.beginPath();
        ctx.ellipse(px, py, s * 0.16, s * 0.07, 0, 0, 7);
        ctx.fill();
      }
    } else if (b.texture === "tiles") {
      ctx.strokeStyle = shade(b.color, -0.1);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let u = 1; u < b.w; u++) {
        ctx.moveTo(...S(u, 0));
        ctx.lineTo(...S(u, b.d));
      }
      for (let v = 1; v < b.d; v++) {
        ctx.moveTo(...S(0, v));
        ctx.lineTo(...S(b.w, v));
      }
      ctx.stroke();
      ctx.fillStyle = shade(b.color, -0.05);
      for (let u = 0; u < b.w; u++) {
        for (let v = 0; v < b.d; v++) {
          if ((u + v) % 2) {
            poly(ctx, [S(u, v), S(u + 1, v), S(u + 1, v + 1), S(u, v + 1)]);
            ctx.fill();
          }
        }
      }
    } else if (b.texture === "sand") {
      ctx.strokeStyle = shade(b.color, -0.12);
      ctx.lineWidth = Math.max(1, s * 0.025);
      ctx.beginPath();
      for (const [u, v, k] of specks) {
        if (k >= 0.35) continue;
        const a = S(u, v);
        const c = S(u + 0.5, v);
        ctx.moveTo(...a);
        ctx.quadraticCurveTo((a[0] + c[0]) / 2, (a[1] + c[1]) / 2 - s * 0.06, c[0], c[1]);
      }
      ctx.stroke();
    } else if (b.texture === "snow") {
      for (const [u, v, k] of specks) {
        const [px, py] = S(u, v);
        if (k < 0.25) {
          ctx.fillStyle = p.night ? "rgba(160,180,220,.35)" : "rgba(170,195,225,.35)";
          ctx.beginPath();
          ctx.ellipse(px, py, s * 0.22, s * 0.09, 0, 0, 7);
          ctx.fill();
        } else if (k > 0.9) {
          ctx.fillStyle = "#ffffff";
          ctx.globalAlpha = this.alpha * (0.4 + 0.6 * Math.abs(Math.sin(t / 600 + k * 40)));
          ctx.fillRect(px, py, 1.5, 1.5);
          ctx.globalAlpha = this.alpha;
        }
      }
    } else if (b.texture === "planks") {
      ctx.strokeStyle = shade(b.color, -0.12);
      ctx.lineWidth = 1;
      ctx.beginPath();
      let k = 0;
      for (let v = 0.3; v < b.d; v += 0.3) {
        ctx.moveTo(...S(0, v));
        ctx.lineTo(...S(b.w, v));
        const joint = specks[k++ % specks.length][0];
        ctx.moveTo(...S(joint, v - 0.3));
        ctx.lineTo(...S(joint, v));
      }
      ctx.stroke();
    } else if (b.texture === "ice") {
      ctx.strokeStyle = "rgba(255,255,255,.8)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [u, v] of specks.slice(0, 5)) {
        ctx.moveTo(...S(u, v));
        ctx.lineTo(...S(Math.min(b.w, u + 0.3), Math.min(b.d, v + 0.15)));
        ctx.lineTo(...S(Math.min(b.w, u + 0.45), v));
      }
      ctx.stroke();
    }
  }

  private deco(b: BoxShape, z: number, d: Deco, t: number): void {
    const { ctx, palette: p } = this;
    const s = this.camera.scale;
    const q = (face: Face, u: number, zz: number, w: number, h: number) => this.faceQuad(b, z, face, u, zz, w, h);
    switch (d.kind) {
      case "band": {
        poly(ctx, q(d.face, 0, d.z, d.face === "L" ? b.w : b.d, d.h), d.color);
        return;
      }
      case "curtain": {
        const length = d.face === "L" ? b.w : b.d;
        const wall = q(d.face, 0, 0.1, length, b.h - 0.1);
        const g = ctx.createLinearGradient(wall[3][0], wall[3][1], wall[1][0], wall[1][1]);
        g.addColorStop(0, p.night ? "#2c3a5a" : "#e8f4fb");
        g.addColorStop(0.5, p.night ? "#1f2944" : tint(p, "#9cc6e0"));
        g.addColorStop(1, p.night ? "#18203a" : "#6f9fc0");
        poly(ctx, wall, g);
        ctx.strokeStyle = p.night ? "#3a4660" : "#dfe9f0";
        ctx.lineWidth = Math.max(1, s * 0.04);
        ctx.beginPath();
        for (let u = 0.6; u < length; u += 0.6) {
          const m = q(d.face, u, 0.1, 0, b.h - 0.1);
          ctx.moveTo(...m[0]);
          ctx.lineTo(...m[3]);
        }
        const m = q(d.face, 0, 0.85, length, 0);
        ctx.moveTo(...m[0]);
        ctx.lineTo(...m[1]);
        ctx.stroke();
        return;
      }
      case "window":
        return this.windowDeco(b, z, d, t);
      case "pane": {
        const frame = p.night ? "#4a4250" : "#ffffff";
        poly(ctx, q(d.face, d.u - 0.05, d.z - 0.05, d.w + 0.1, d.h + 0.1), frame);
        const glass = q(d.face, d.u, d.z, d.w, d.h);
        const g = ctx.createLinearGradient(glass[3][0], glass[3][1], glass[0][0], glass[0][1]);
        g.addColorStop(0, p.night ? "#141a3a" : "#9fd3f2");
        g.addColorStop(1, p.night ? "#2c2c5a" : "#e6f4fb");
        poly(ctx, glass, g);
        ctx.strokeStyle = frame;
        ctx.lineWidth = Math.max(1, s * 0.04);
        const m = q(d.face, d.u + d.w / 2, d.z, 0, d.h);
        const n = q(d.face, d.u, d.z + d.h / 2, d.w, 0);
        ctx.beginPath();
        ctx.moveTo(...m[0]);
        ctx.lineTo(...m[3]);
        ctx.moveTo(...n[0]);
        ctx.lineTo(...n[1]);
        ctx.stroke();
        poly(ctx, q(d.face, d.u - 0.08, d.z - 0.1, d.w + 0.16, 0.06), p.woodDark);
        return;
      }
      case "picture": {
        poly(ctx, q(d.face, d.u, d.z, d.w, d.h), d.warn ? "#f2c94c" : "#3b3330");
        poly(ctx, q(d.face, d.u + 0.05, d.z + 0.05, d.w - 0.1, d.h - 0.1), d.warn ? "#f2c94c" : "#f6f1e7");
        if (d.warn) {
          ctx.fillStyle = "#2b2d35";
          ctx.font = `800 ${Math.max(7, s * 0.24)}px ${FONT}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const c = q(d.face, d.u + d.w / 2, d.z + d.h / 2, 0, 0)[0];
          ctx.fillText("⚡", c[0], c[1]);
        } else {
          const r = rng(b.seed + d.u * 13);
          poly(ctx, q(d.face, d.u + 0.08, d.z + 0.08, d.w - 0.16, (d.h - 0.16) * 0.45), mix("#9fd3f2", d.color, 0.2));
          poly(ctx, q(d.face, d.u + 0.08, d.z + 0.08, (d.w - 0.16) * (0.4 + r() * 0.3), (d.h - 0.16) * (0.3 + r() * 0.3)), mix("#7fbf6a", d.color, 0.25));
          const c = q(d.face, d.u + d.w * (0.55 + r() * 0.2), d.z + d.h * 0.68, 0, 0)[0];
          ctx.fillStyle = mix("#ffcf5a", d.color, 0.3);
          ctx.beginPath();
          ctx.arc(c[0], c[1], Math.max(1.5, s * 0.05), 0, 7);
          ctx.fill();
        }
        return;
      }
      case "clock": {
        const c = q(d.face, d.u + d.w / 2, d.z + d.h / 2, 0, 0)[0];
        const r = d.w * s * 0.45;
        const now = new Date();
        const hour = ((now.getHours() % 12) + now.getMinutes() / 60) / 12 * Math.PI * 2;
        const minute = (now.getMinutes() / 60) * Math.PI * 2;
        ctx.save();
        ctx.translate(c[0], c[1]);
        ctx.scale(0.9, 1);
        ctx.fillStyle = "#fbfbf8";
        ctx.strokeStyle = "#3b3330";
        ctx.lineWidth = Math.max(1, s * 0.035);
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, 7);
        ctx.fill();
        ctx.stroke();
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.sin(hour) * r * 0.5, -Math.cos(hour) * r * 0.5);
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.sin(minute) * r * 0.8, -Math.cos(minute) * r * 0.8);
        ctx.stroke();
        ctx.restore();
        return;
      }
      case "screen": {
        poly(ctx, q(d.face, d.u, d.z, d.w, d.h), "#23252d");
        poly(ctx, q(d.face, d.u + 0.05, d.z + 0.05, d.w - 0.1, d.h - 0.1), p.night ? "#1a2740" : "#22334d");
        const r = rng(b.seed);
        for (let k = 0; k < 6; k++) {
          const bar = (0.15 + r() * 0.5) * (d.h - 0.2) * (0.75 + 0.25 * Math.sin(t / 900 + k));
          poly(ctx, q(d.face, d.u + 0.14 + (k * (d.w - 0.28)) / 6, d.z + 0.1, ((d.w - 0.28) / 6) * 0.6, bar), k % 2 ? d.color : mix(d.color, "#ffffff", 0.45));
        }
        ctx.strokeStyle = "#7fe8a8";
        ctx.lineWidth = Math.max(1, s * 0.03);
        ctx.beginPath();
        for (let k = 0; k <= 8; k++) {
          const pt = q(d.face, d.u + 0.12 + (k * (d.w - 0.24)) / 8, d.z + d.h * (0.62 + 0.14 * Math.sin(k * 1.3 + t / 1500)), 0, 0)[0];
          if (k) ctx.lineTo(...pt);
          else ctx.moveTo(...pt);
        }
        ctx.stroke();
        return;
      }
      case "door": {
        const color =
          d.style === "brick"
            ? (b.projectColor ?? p.woodDark)
            : d.style === "tower"
              ? p.night
                ? "#2c3a5a"
                : "#cfe7f3"
              : d.style === "chalet"
                ? "#4a2f1f"
                : p.woodDark;
        poly(ctx, q(d.face, d.u - 0.06, 0, d.w + 0.12, d.h + 0.06), d.style === "tower" ? "#4b5866" : shade(color, -0.3));
        poly(ctx, q(d.face, d.u, 0, d.w, d.h), color);
        if (d.style === "tower") {
          ctx.strokeStyle = "#4b5866";
          ctx.lineWidth = 1.2;
          const m = q(d.face, d.u + d.w / 2, 0, 0, d.h);
          ctx.beginPath();
          ctx.moveTo(...m[0]);
          ctx.lineTo(...m[3]);
          ctx.stroke();
        } else {
          const k = q(d.face, d.u + d.w * 0.78, d.h * 0.48, 0, 0)[0];
          ctx.fillStyle = "#e2c26a";
          ctx.beginPath();
          ctx.arc(k[0], k[1], Math.max(1.2, s * 0.03), 0, 7);
          ctx.fill();
        }
        if (p.night && b.lit) this.glow(q(d.face, d.u + d.w / 2, d.h + 0.15, 0, 0)[0], s * 1.2, "255,205,120", 0.45);
        return;
      }
      case "sign": {
        if (d.style === "tower") {
          poly(ctx, q(d.face, 0, d.z, d.face === "L" ? b.w : b.d, d.h), b.projectColor ?? p.woodDark);
          this.faceText(b, z, d.face, (d.face === "L" ? b.w : b.d) / 2, d.z + 0.07, d.text, 0.17, "#ffffff", true);
        } else {
          poly(ctx, q(d.face, d.u, d.z, d.w, d.h), p.wood);
          ctx.strokeStyle = p.woodDark;
          ctx.lineWidth = 1;
          poly(ctx, q(d.face, d.u, d.z, d.w, d.h));
          ctx.stroke();
          this.faceText(b, z, d.face, d.u + d.w / 2, d.z + 0.07, d.text, 0.16, "#fff8ea", true);
        }
        return;
      }
      case "board": {
        poly(ctx, q(d.face, d.u, d.z, d.w, d.h), "#fbfbf8");
        this.faceText(b, z, d.face, d.u + 0.08, d.z + d.h - 0.15, d.title, 0.11, "#55534c");
        const cols = Math.floor((d.w - 0.12) / 0.25);
        d.notes.forEach((color, k) => {
          const col = k % cols;
          const row = Math.floor(k / cols);
          poly(ctx, q(d.face, d.u + 0.08 + col * 0.25, d.z + d.h - 0.38 - row * 0.2, 0.18, 0.15), color);
        });
        return;
      }
      case "books": {
        const r = rng(b.seed);
        const spines = ["#c45a4a", "#4f7cac", "#e0b04f", "#5f9e6e", "#8b6bb1", "#e8e2d6"];
        for (let row = 0; row < 3; row++) {
          const zz = d.z + row * 0.34;
          poly(ctx, q(d.face, d.u, zz, d.w, 0.03), shade(p.woodDark, -0.25));
          for (let u = d.u + 0.03; u < d.u + d.w - 0.1; ) {
            const w = 0.06 + r() * 0.07;
            const h = 0.18 + r() * 0.1;
            if (r() < 0.85) poly(ctx, q(d.face, u, zz + 0.03, w, h), spines[Math.floor(r() * 6)]);
            u += w + 0.015;
          }
        }
        return;
      }
      case "logo": {
        const c = q("L", b.w / 2, b.h / 2, 0, 0)[0];
        ctx.fillStyle = d.color;
        ctx.beginPath();
        ctx.arc(c[0], c[1], Math.max(1.5, s * 0.05), 0, 7);
        ctx.fill();
        return;
      }
      case "leds": {
        for (let r = 0; r < 6; r++) {
          for (let c = 0; c < 3; c++) {
            const on = Math.sin(t / (200 + r * 37 + c * 53) + r * c) > 0;
            poly(ctx, q("L", 0.12 + c * 0.15, 0.15 + r * 0.18, 0.06, 0.05), on ? (c === 2 ? "#ff6b5e" : "#6bff9a") : "#1a1b20");
          }
        }
        return;
      }
      case "net": {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.2;
        const a = this.at(b.x + b.w / 2, b.y, z + b.h);
        const c = this.at(b.x + b.w / 2, b.y + b.d, z + b.h);
        ctx.beginPath();
        ctx.moveTo(...a);
        ctx.lineTo(...c);
        ctx.stroke();
        return;
      }
    }
  }

  /** An additive warm glow around a point (lamps, lit windows, doors). */
  private glow(at: Point, radius: number, rgbValue: string, strength: number): void {
    const { ctx } = this;
    const g = ctx.createRadialGradient(at[0], at[1], 0, at[0], at[1], radius);
    g.addColorStop(0, `rgba(${rgbValue},${strength})`);
    g.addColorStop(1, `rgba(${rgbValue},0)`);
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = g;
    ctx.fillRect(at[0] - radius * 1.1, at[1] - radius * 1.1, radius * 2.2, radius * 2.2);
    ctx.globalCompositeOperation = "source-over";
  }

  /** A window by building style; it shows the silhouette of a working agent at
   *  its desk (with a work bubble) or a dozing quiet one, hoverable while closed. */
  private windowDeco(b: BoxShape, z: number, d: Extract<Deco, { kind: "window" }>, t: number): void {
    const { ctx, palette: p } = this;
    const s = this.camera.scale;
    const style: BuildingStyle = d.style;
    const pc = b.projectColor ?? p.woodDark;
    const q = (u: number, zz: number, w: number, h: number) => this.faceQuad(b, z, d.face, u, zz, w, h);
    const glass = q(d.u, d.z, d.w, d.h);
    const center: Point = [(glass[0][0] + glass[2][0]) / 2, (glass[0][1] + glass[2][1]) / 2];
    const frames: Record<BuildingStyle, string> = {
      cottage: "#ffffff",
      tower: "#ffffff",
      chalet: "#3b2618",
      adobe: shade(b.color, -0.38),
      brick: "#efe9df",
    };
    if (style !== "tower") poly(ctx, q(d.u - 0.05, d.z - 0.05, d.w + 0.1, d.h + 0.1), frames[style]);
    if (style === "chalet") {
      poly(ctx, q(d.u - 0.24, d.z, 0.17, d.h), pc);
      poly(ctx, q(d.u + d.w + 0.07, d.z, 0.17, d.h), pc);
    }
    if (style === "brick") poly(ctx, q(d.u - 0.07, d.z + d.h + 0.04, d.w + 0.14, 0.08), tint(p, "#d9d4cb"));
    if (style === "adobe") poly(ctx, q(d.u - 0.09, d.z + d.h + 0.04, d.w + 0.18, 0.07), p.woodDark);
    const worker = d.worker ?? null;
    const sleeper = d.sleeper ?? null;
    const warm = !!worker || !!sleeper || (d.lit && p.night);
    if (warm) {
      poly(ctx, glass, worker ? (p.night ? "#ffc56b" : "#ffe0a6") : sleeper ? (p.night ? "#8a84a6" : "#e4dff0") : p.lit);
    } else {
      const g = ctx.createLinearGradient(glass[3][0], glass[3][1], glass[1][0], glass[1][1]);
      g.addColorStop(0, p.night ? "#33405e" : "#ffffff");
      g.addColorStop(0.5, p.glass);
      g.addColorStop(1, shade(p.glass, -0.12));
      poly(ctx, glass, g);
    }
    if (worker || sleeper) {
      ctx.save();
      poly(ctx, glass);
      ctx.clip();
      ctx.fillStyle = sleeper ? "rgba(90,85,100,.5)" : "rgba(45,35,45,.7)";
      const hs = Math.abs(glass[1][0] - glass[0][0]);
      ctx.beginPath();
      ctx.arc(center[0], center[1] - hs * 0.05, hs * 0.17, 0, 7);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(center[0], center[1] + hs * 0.42, hs * 0.34, hs * 0.26, 0, 0, 7);
      ctx.fill();
      ctx.restore();
    }
    if (warm && p.night) this.glow(center, s * 1.1, "255,200,110", 0.35);
    if (style !== "tower") {
      ctx.strokeStyle = frames[style];
      ctx.lineWidth = Math.max(1, s * 0.03);
      const m = q(d.u + d.w / 2, d.z, 0, d.h);
      const n = q(d.u, d.z + d.h / 2, d.w, 0);
      ctx.beginPath();
      ctx.moveTo(...m[0]);
      ctx.lineTo(...m[3]);
      ctx.moveTo(...n[0]);
      ctx.lineTo(...n[1]);
      ctx.stroke();
    }
    if (style === "cottage") {
      poly(ctx, q(d.u - 0.06, d.z - 0.16, d.w + 0.12, 0.1), p.woodDark);
      const r = rng(b.seed + d.u * 10);
      for (let k = 0; k < 5; k++) {
        const f = q(d.u + (k * d.w) / 4.2, d.z - 0.04, 0, 0)[0];
        const flower = FLOWERS[Math.floor(r() * 4)];
        ctx.fillStyle = tint(p, flower === "#ffffff" ? pc : FLOWERS[Math.floor(r() * 4)]);
        ctx.beginPath();
        ctx.arc(f[0], f[1], Math.max(1.3, s * 0.04), 0, 7);
        ctx.fill();
      }
    }
    if (!this.shellHit) return;
    if (sleeper) {
      const bp = q(d.u + d.w, d.z + d.h + 0.15, 0, 0)[0];
      const ph = (t / 2200) % 1;
      ctx.fillStyle = p.night ? "#b9b8c8" : "#8d8a83";
      ctx.font = `700 ${Math.max(9, s * 0.22)}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.globalAlpha = this.alpha * Math.sin(ph * Math.PI);
      ctx.fillText("z", bp[0] + ph * s * 0.2, bp[1] - ph * s * 0.3);
      ctx.globalAlpha = this.alpha;
      this.hits.push({ x: center[0], y: center[1], r: Math.max(12, s * 0.5), taskId: sleeper.taskId });
    }
    if (worker) {
      const bp = q(d.u + d.w, d.z + d.h + 0.2, 0, 0)[0];
      this.workBubble(bp[0], bp[1], t, s * 1.1);
      this.hits.push({ x: center[0], y: center[1], r: Math.max(12, s * 0.5), taskId: worker.taskId });
    }
  }

  /** The "typing…" bubble over a working agent. */
  private workBubble(bx: number, by: number, t: number, s: number): void {
    const { ctx, palette: p } = this;
    ctx.fillStyle = p.labelBg;
    roundRect(ctx, bx - 0.2 * s, by - 0.11 * s, 0.4 * s, 0.2 * s, 0.1 * s);
    ctx.fill();
    ctx.strokeStyle = p.doing;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx - 0.1 * s, by + 0.08 * s);
    ctx.lineTo(bx - 0.16 * s, by + 0.16 * s);
    ctx.lineTo(bx - 0.03 * s, by + 0.09 * s);
    ctx.fillStyle = p.labelBg;
    ctx.fill();
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = p.doing;
      ctx.beginPath();
      ctx.arc(bx - 0.1 * s + k * 0.1 * s, by - 0.01 * s + Math.sin(t / 130 + k * 1.2) * 0.02 * s, 0.03 * s, 0, 7);
      ctx.fill();
    }
  }

  private smoke(x: number, y: number, z: number, dz: number, t: number): void {
    const { ctx, palette: p } = this;
    const s = this.camera.scale;
    for (let k = 0; k < 6; k++) {
      const f = (t / 2200 + k / 6) % 1;
      const c = this.at(x + f * 0.5, y - f * 0.3, z + dz + f * 1.8);
      ctx.globalAlpha = this.alpha * (1 - f) * 0.9;
      ctx.fillStyle = p.smoke;
      ctx.beginPath();
      ctx.arc(c[0], c[1], (0.08 + f * 0.22) * s, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = this.alpha;
  }

  // ---------- buildings ----------

  private stateOf(projectId: number): BuildingState {
    let state = this.buildingStates.get(projectId);
    if (!state) {
      state = { cut: this.open.has(projectId) ? 1 : 0, topZ: 0 };
      this.buildingStates.set(projectId, state);
    }
    return state;
  }

  /** One building: storeys with their rooms, the outside shell over them, and the
   *  roof. Opening eases the storeys apart and fades the shell and roof away. */
  private building(b: BuildingItem, dz: number, t: number): void {
    const p = this.palette;
    const state = this.stateOf(b.projectId);
    const goal = this.open.has(b.projectId) ? 1 : 0;
    if (this.still) state.cut = goal;
    else {
      state.cut += (goal - state.cut) * 0.09;
      if (Math.abs(state.cut - goal) < 0.002) state.cut = goal;
    }
    if (state.cut !== goal) this.animating = true;
    const c = ease(state.cut);
    const spacing = b.floorHeight + c * 1.9;
    const A0 = this.alpha;
    const inner = tint(p, mix(p.paper, b.color, 0.12));
    const floorColor = tint(p, mix(p.floor, b.color, 0.05));
    for (let f = 0; f < b.floors; f++) {
      const zf = f * spacing;
      this.box(
        { x: b.x, y: b.y, z: zf - 0.1, w: b.w, d: b.d, h: 0.1, color: b.style === "tower" ? tint(p, "#cfd3d8") : floorColor, texture: "planks", specks: FLOOR_SPECKS, seed: b.seed },
        dz,
        t,
      );
      if (c > 0.02 || f === b.floors - 1) {
        const decorated = c > 0.02;
        this.box({ x: b.x, y: b.y, z: zf, w: b.w, d: 0.1, h: b.floorHeight, color: inner, seed: b.seed, decos: decorated ? b.innerWalls[f].L : null }, dz, t);
        this.box(
          { x: b.x, y: b.y + 0.1, z: zf, w: 0.1, d: b.d - 0.1, h: b.floorHeight, color: shade(inner, -0.04), seed: b.seed + 1, decos: decorated ? b.innerWalls[f].R : null },
          dz,
          t,
        );
      }
      if (c > 0.02) {
        this.setAlpha(A0 * Math.min(1, c * 1.6));
        this.hitOK = c > 0.5;
        for (const item of b.contents[f]) this.drawItem(item, dz + zf, t);
        this.hitOK = true;
        this.setAlpha(A0);
      }
      if (c < 0.98) {
        this.setAlpha(A0 * (1 - c));
        this.shellHit = c < 0.5;
        this.box(
          {
            x: b.x,
            y: b.y,
            z: zf,
            w: b.w,
            d: b.d,
            h: b.floorHeight,
            color: b.wallColor,
            side: b.material,
            decos: b.shell[f],
            seed: b.seed + f,
            projectColor: b.color,
            lit: b.lit,
          },
          dz,
          t,
        );
        if (b.style === "tower" && f < b.floors - 1) {
          this.box({ x: b.x - 0.04, y: b.y - 0.04, z: zf + b.floorHeight - 0.06, w: b.w + 0.08, d: b.d + 0.08, h: 0.08, color: b.color, seed: b.seed }, dz, t);
        }
        this.shellHit = false;
        this.setAlpha(A0);
      }
    }
    const zt = b.floors * spacing;
    let top = zt;
    if (c < 0.98) {
      this.setAlpha(A0 * (1 - c));
      top = this.roof(b, zt + c * 1.4, dz, t);
      this.setAlpha(A0);
    }
    state.topZ = Math.max(top, zt + 0.4);
    const corners = [
      [b.x, b.y, 0],
      [b.x + b.w, b.y + b.d, 0],
      [b.x + b.w, b.y, 0],
      [b.x, b.y + b.d, 0],
      [b.x, b.y, state.topZ],
      [b.x + b.w, b.y, state.topZ],
    ].map(([x, y, z]) => this.at(x, y, z + dz));
    const xs = corners.map((q) => q[0]);
    const ys = corners.map((q) => q[1]);
    this.buildingRects.push({ projectId: b.projectId, rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
  }

  /** The roof by style; returns its top height for the name chip. */
  private roof(b: BuildingItem, zt: number, dz: number, t: number): number {
    const { ctx, palette: p } = this;
    const s = this.camera.scale;
    const x0 = b.x;
    const x1 = b.x + b.w;
    const y0 = b.y;
    const y1 = b.y + b.d;
    const ym = (y0 + y1) / 2;
    const S = (a: number, c: number, e: number) => this.at(a, c, e + dz);
    const style = b.style;
    const pc = b.color;
    const B = (o: Omit<BoxShape, "seed" | "z"> & { z?: number }) => this.box({ z: 0, seed: b.seed, ...o }, dz, t);
    if (style === "cottage" || style === "chalet") {
      const rise = b.d * (style === "chalet" ? 0.85 : 0.55);
      const zr = zt + rise;
      const o = 0.22;
      const wall = b.wallColor;
      poly(ctx, [S(x1, y0, zt), S(x1, y1, zt), S(x1, ym, zr)], shade(wall, -0.25));
      ctx.strokeStyle = shade(wall, -0.42);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let zz = zt + 0.2; zz < zr; zz += 0.2) {
        const f = (zz - zt) / (zr - zt);
        ctx.moveTo(...S(x1, ym - (ym - y0) * (1 - f), zz));
        ctx.lineTo(...S(x1, ym + (y1 - ym) * (1 - f), zz));
      }
      ctx.stroke();
      poly(ctx, [S(x0 - o, y0 - o, zt - 0.05), S(x1 + o, y0 - o, zt - 0.05), S(x1 + o, ym, zr), S(x0 - o, ym, zr)], shade(pc, -0.3));
      B({ x: x0 + 0.45, y: y0 + 0.4, z: zt, w: 0.34, d: 0.34, h: rise + 0.35, color: p.brick });
      const F = [S(x0 - o, y1 + o, zt - 0.05), S(x1 + o, y1 + o, zt - 0.05), S(x1 + o, ym, zr), S(x0 - o, ym, zr)];
      const g = ctx.createLinearGradient(F[3][0], F[3][1], F[0][0], F[0][1]);
      g.addColorStop(0, shade(pc, 0.12));
      g.addColorStop(1, shade(pc, -0.12));
      poly(ctx, F, g);
      ctx.strokeStyle = shade(pc, -0.22);
      ctx.lineWidth = Math.max(1, s * 0.025);
      ctx.beginPath();
      for (let f = 0.2; f < 1; f += 0.2) {
        const yy = ym + (y1 + o - ym) * f;
        const zz = zr - (zr - zt + 0.05) * f;
        ctx.moveTo(...S(x0 - o, yy, zz));
        ctx.lineTo(...S(x1 + o, yy, zz));
      }
      ctx.stroke();
      if (style === "chalet") {
        const f = 0.42;
        const yy = ym + (y1 + o - ym) * f;
        const zz = zr - (zr - zt + 0.05) * f;
        poly(ctx, [S(x0 - o, ym, zr), S(x1 + o, ym, zr), S(x1 + o, yy, zz), S(x0 - o, yy, zz)], p.snow);
        poly(ctx, [S(x0 - o, y1 + o, zt - 0.05), S(x1 + o, y1 + o, zt - 0.05), S(x1 + o, y1 + o, zt + 0.06), S(x0 - o, y1 + o, zt + 0.06)], p.snow);
      }
      ctx.strokeStyle = style === "chalet" ? p.snow : shade(pc, -0.4);
      ctx.lineWidth = Math.max(2, s * 0.07);
      ctx.beginPath();
      ctx.moveTo(...S(x1 + o, y1 + o, zt - 0.05));
      ctx.lineTo(...S(x1 + o, ym, zr));
      ctx.lineTo(...S(x1 + o, y0 - o, zt - 0.05));
      ctx.stroke();
      ctx.strokeStyle = style === "chalet" ? p.snow : shade(pc, 0.3);
      ctx.beginPath();
      ctx.moveTo(...S(x0 - o, ym, zr));
      ctx.lineTo(...S(x1 + o, ym, zr));
      ctx.stroke();
      if (b.active) this.smoke(x0 + 0.62, y0 + 0.57, zt + rise + 0.35, dz, t);
      return zr;
    }
    if (style === "brick") {
      const r = b.d / 2;
      const zr = zt + b.d * 0.5;
      const o = 0.18;
      const roofColor = tint(p, "#585d6b");
      B({ x: x0 + 0.4, y: y0 + 0.5, z: zt, w: 0.34, d: 0.34, h: b.d * 0.5 + 0.4, color: p.brick });
      poly(ctx, [S(x0 - o, y1 + o, zt), S(x1 + o, y1 + o, zt), S(x1 - r, ym, zr), S(x0 + r, ym, zr)], shade(roofColor, 0.06));
      poly(ctx, [S(x1 + o, y1 + o, zt), S(x1 + o, y0 - o, zt), S(x1 - r, ym, zr)], shade(roofColor, -0.2));
      ctx.strokeStyle = shade(roofColor, -0.25);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let f = 0.2; f < 1; f += 0.2) {
        const zz = zt + (zr - zt) * f;
        const i = r * f;
        ctx.moveTo(...S(x0 - o + i * (1 + o / r), y1 + o - (r + o) * f, zz));
        ctx.lineTo(...S(x1 + o - i * (1 + o / r), y1 + o - (r + o) * f, zz));
      }
      ctx.stroke();
      ctx.strokeStyle = pc;
      ctx.lineWidth = Math.max(1.5, s * 0.05);
      ctx.beginPath();
      ctx.moveTo(...S(x0 + r, ym, zr));
      ctx.lineTo(...S(x1 - r, ym, zr));
      ctx.lineTo(...S(x1 + o, y1 + o, zt));
      ctx.moveTo(...S(x1 - r, ym, zr));
      ctx.lineTo(...S(x1 + o, y0 - o, zt));
      ctx.stroke();
      if (b.active) this.smoke(x0 + 0.57, y0 + 0.67, zr + 0.4, dz, t);
      return zr;
    }
    // flat roof with a parapet: tower (with plant, antenna and banner) or adobe
    const tower = style === "tower";
    const parapet = tower ? tint(p, "#56616d") : b.wallColor;
    B({ x: x0, y: y0, z: zt, w: b.w, d: b.d, h: 0.05, color: tower ? tint(p, "#b8bdc3") : shade(b.wallColor, -0.06) });
    B({ x: x0, y: y0, z: zt, w: b.w, d: 0.14, h: 0.3, color: parapet });
    B({ x: x0, y: y0 + 0.14, z: zt, w: 0.14, d: b.d - 0.14, h: 0.3, color: parapet });
    if (tower) {
      B({ x: x0 + 0.5, y: y0 + 0.5, z: zt + 0.05, w: 0.8, d: 0.6, h: 0.45, color: tint(p, "#d7dade") });
      B({ x: x0 + 1.6, y: y0 + 0.6, z: zt + 0.05, w: 0.6, d: 0.6, h: 0.35, color: tint(p, "#c9cdd2") });
      B({ x: x1 - 0.8, y: y0 + 0.7, z: zt, w: 0.06, d: 0.06, h: 1.5, color: "#666" });
      const beacon = this.at(x1 - 0.77, y0 + 0.73, zt + 1.55 + dz);
      ctx.fillStyle = Math.sin(t / 300) > 0 ? "#ff4a3d" : "#6b1f1a";
      ctx.beginPath();
      ctx.arc(beacon[0], beacon[1], Math.max(2, s * 0.06), 0, 7);
      ctx.fill();
      B({ x: x0 + 0.5, y: y1 - 0.7, z: zt, w: 0.05, d: 0.05, h: 1.1, color: "#777" });
      B({ x: x0 + 0.55, y: y1 - 0.68, z: zt + 0.75, w: 0.55, d: 0.04, h: 0.32, color: pc });
      if (b.active) this.smoke(x0 + 0.9, y0 + 0.8, zt + 0.5, dz, t);
    } else {
      for (let u = 0.35; u < b.w - 0.2; u += 0.62) B({ x: x0 + u, y: y1 - 0.05, z: zt - 0.32, w: 0.12, d: 0.32, h: 0.12, color: p.woodDark });
      B({ x: x1 - 1.1, y: y0 + 0.45, z: zt, w: 0.45, d: 0.45, h: 0.55, color: shade(b.wallColor, -0.04) });
      if (b.active) this.smoke(x1 - 0.88, y0 + 0.67, zt + 0.6, dz, t);
    }
    B({ x: x0, y: y1 - 0.14, z: zt, w: b.w, d: 0.14, h: 0.3, color: parapet });
    B({ x: x1 - 0.14, y: y0, z: zt, w: 0.14, d: b.d - 0.14, h: 0.3, color: parapet });
    B({ x: x0, y: y1 - 0.14, z: zt + 0.3, w: b.w, d: 0.14, h: 0.04, color: pc });
    B({ x: x1 - 0.14, y: y0, z: zt + 0.3, w: 0.14, d: b.d - 0.14, h: 0.04, color: pc });
    return zt + (tower ? 1.6 : 0.6);
  }

  // ---------- props ----------

  private tree(tr: Extract<Item, { kind: "tree" }>, dz: number, t: number): void {
    const { ctx, palette: p } = this;
    const s = this.camera.scale;
    const k = tr.scale;
    const { x, y } = tr;
    const sway = this.still ? 0 : Math.sin(t / 1400 + tr.phase) * 0.03;
    const B = (o: Omit<BoxShape, "seed" | "z"> & { z?: number }) => this.box({ z: 0, seed: tr.seed, ...o }, dz, t);
    if (tr.variety === "cactus") {
      const g = tint(p, "#5d9b4f");
      B({ x: x + 0.38, y: y + 0.38, w: 0.24, d: 0.24, h: 1.1 * k, color: g });
      B({ x: x + 0.18, y: y + 0.43, z: 0.45 * k, w: 0.2, d: 0.14, h: 0.12, color: g });
      B({ x: x + 0.14, y: y + 0.43, z: 0.45 * k, w: 0.12, d: 0.14, h: 0.38 * k, color: g });
      B({ x: x + 0.62, y: y + 0.43, z: 0.6 * k, w: 0.2, d: 0.14, h: 0.12, color: g });
      B({ x: x + 0.74, y: y + 0.43, z: 0.6 * k, w: 0.12, d: 0.14, h: 0.3 * k, color: g });
      return;
    }
    if (tr.variety === "palm") {
      for (let j = 0; j < 6; j++) {
        B({ x: x + 0.42 + j * 0.035 + sway * j, y: y + 0.42, z: j * 0.28 * k, w: 0.15, d: 0.15, h: 0.28 * k, color: shade(tint(p, "#9c7a52"), j % 2 ? 0.06 : -0.04) });
      }
      const top = this.at(x + 0.5 + 0.21 + sway * 6, y + 0.5, 1.7 * k + dz);
      ctx.strokeStyle = tint(p, "#3f9a52");
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(2, s * 0.09);
      for (let j = 0; j < 7; j++) {
        const a = (j / 7) * Math.PI * 2 + tr.phase;
        const dx = Math.cos(a) * s * 0.75;
        const dy = Math.sin(a) * s * 0.35;
        ctx.beginPath();
        ctx.moveTo(...top);
        ctx.quadraticCurveTo(top[0] + dx * 0.6, top[1] + dy * 0.6 - s * 0.25, top[0] + dx, top[1] + dy + s * 0.2);
        ctx.stroke();
      }
      ctx.lineCap = "butt";
      ctx.fillStyle = "#6b4a2a";
      ctx.beginPath();
      ctx.arc(top[0] - 3, top[1] + 3, Math.max(2, s * 0.06), 0, 7);
      ctx.arc(top[0] + 3, top[1] + 4, Math.max(2, s * 0.06), 0, 7);
      ctx.fill();
      return;
    }
    if (tr.variety === "planter") {
      B({ x: x + 0.15, y: y + 0.15, w: 0.7, d: 0.7, h: 0.35, color: tint(p, "#b3aea6") });
      B({ x: x + 0.45, y: y + 0.45, z: 0.35, w: 0.1, d: 0.1, h: 0.4, color: p.trunk });
      B({ x: x + 0.2 + sway, y: y + 0.2, z: 0.7, w: 0.6, d: 0.6, h: 0.45, color: p.leaf });
      B({ x: x + 0.3 + sway, y: y + 0.3, z: 1.15, w: 0.4, d: 0.4, h: 0.25, color: p.leaf2 });
      return;
    }
    B({ x: x + 0.42, y: y + 0.42, w: 0.16, d: 0.16, h: 0.55 * k, color: p.trunk });
    if (tr.variety === "pine" || tr.variety === "snowpine") {
      for (let j = 0; j < 3; j++) {
        const w = (0.9 - j * 0.25) * k;
        const o = (1 - w) / 2;
        B({ x: x + o + sway * j, y: y + o, z: (0.4 + j * 0.42) * k, w, d: w, h: 0.42 * k, color: shade(p.pine, j * 0.06) });
        if (tr.variety === "snowpine") {
          B({ x: x + o + sway * j + 0.04, y: y + o + 0.04, z: (0.4 + j * 0.42 + 0.42) * k, w: w - 0.08, d: w - 0.08, h: 0.07, color: p.snow });
        }
      }
      return;
    }
    const crowns: Partial<Record<typeof tr.variety, [string, string]>> = {
      round: [p.leaf, p.leaf2],
      bloom: [p.bloom, shade(p.bloom, 0.15)],
      orange: [tint(p, "#e2833a"), tint(p, "#efa04d")],
      red: [tint(p, "#c4452f"), tint(p, "#dc6342")],
      gold: [tint(p, "#e2ad3a"), tint(p, "#efc75a")],
    };
    const [c0, c1] = crowns[tr.variety] ?? [p.leaf, p.leaf2];
    B({ x: x + 0.08 + sway, y: y + 0.08, z: 0.5 * k, w: 0.84 * k, d: 0.84 * k, h: 0.55 * k, color: c0 });
    B({ x: x + 0.22 + sway * 1.5, y: y + 0.22, z: 1.05 * k, w: 0.56 * k, d: 0.56 * k, h: 0.38 * k, color: c1 });
    B({ x: x + 0.5 + sway, y: y + 0.12, z: 0.78 * k, w: 0.4 * k, d: 0.4 * k, h: 0.36 * k, color: c1 });
  }

  private lamp(l: Extract<Item, { kind: "lamp" }>, dz: number): void {
    const p = this.palette;
    const s = this.camera.scale;
    const B = (o: Omit<BoxShape, "seed">) => this.box({ ...o, seed: l.seed }, dz, 0);
    if (l.indoor) {
      B({ x: l.x - 0.08, y: l.y - 0.08, z: 0, w: 0.22, d: 0.22, h: 0.04, color: "#3e3e46" });
      B({ x: l.x, y: l.y, z: 0.04, w: 0.05, d: 0.05, h: l.height, color: "#8d8a83" });
      B({ x: l.x - 0.15, y: l.y - 0.15, z: l.height, w: 0.35, d: 0.35, h: 0.26, color: p.night ? "#ffe2a0" : "#f3e3c3" });
    } else {
      B({ x: l.x, y: l.y, z: 0, w: 0.08, d: 0.08, h: l.height, color: "#3e3e46" });
      if (l.modern) B({ x: l.x - 0.25, y: l.y - 0.04, z: l.height, w: 0.42, d: 0.16, h: 0.08, color: "#3e3e46" });
      else {
        B({ x: l.x - 0.07, y: l.y - 0.07, z: l.height, w: 0.22, d: 0.22, h: 0.22, color: p.night ? "#ffe2a0" : "#f2ecd8" });
        B({ x: l.x - 0.1, y: l.y - 0.1, z: l.height + 0.22, w: 0.28, d: 0.28, h: 0.06, color: "#3e3e46" });
      }
    }
    if (!p.night || this.dimmed) return;
    const { ctx } = this;
    this.glow(this.at(l.x + 0.04, l.y + 0.04, l.height + 0.1 + dz), s * 0.7, "255,215,140", 0.7);
    const g = this.at(l.x + 0.04, l.y + 0.04, dz);
    ctx.globalCompositeOperation = "lighter";
    ctx.save();
    ctx.translate(g[0], g[1]);
    ctx.scale(1, 0.5);
    const pool = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 1.8);
    pool.addColorStop(0, "rgba(255,205,120,.32)");
    pool.addColorStop(1, "rgba(255,205,120,0)");
    ctx.fillStyle = pool;
    ctx.fillRect(-s * 2, -s * 2, s * 4, s * 4);
    ctx.restore();
    ctx.globalCompositeOperation = "source-over";
  }

  private plant(pl: Extract<Item, { kind: "plant" }>, dz: number, t: number): void {
    const p = this.palette;
    const sway = this.still ? 0 : Math.sin(t / 1500 + pl.seed) * 0.02;
    this.box({ x: pl.x, y: pl.y, z: 0, w: 0.32, d: 0.32, h: 0.3, color: "#c4704f", seed: pl.seed }, dz, t);
    this.box({ x: pl.x + 0.02 + sway, y: pl.y + 0.02, z: 0.3, w: 0.28, d: 0.28, h: 0.28, color: p.leaf, seed: pl.seed }, dz, t);
    this.box({ x: pl.x + 0.08 + sway * 2, y: pl.y + 0.06, z: 0.58, w: 0.18, d: 0.18, h: 0.18, color: p.leaf2, seed: pl.seed }, dz, t);
  }

  private fountain(f: Extract<Item, { kind: "fountain" }>, dz: number, t: number): void {
    const { ctx, palette: p } = this;
    const s = this.camera.scale;
    const stone = tint(p, "#c9c4bb");
    this.box({ x: f.x, y: f.y, z: 0, w: 1.4, d: 1.4, h: 0.3, color: stone, seed: f.seed }, dz, t);
    this.box({ x: f.x + 0.12, y: f.y + 0.12, z: 0.3, w: 1.16, d: 1.16, h: 0.005, color: p.water, flat: true, texture: "water", seed: f.seed }, dz, t);
    this.box({ x: f.x + 0.6, y: f.y + 0.6, z: 0.3, w: 0.2, d: 0.2, h: 0.5, color: stone, seed: f.seed }, dz, t);
    ctx.fillStyle = "rgba(255,255,255,.85)";
    for (let k = 0; k < 14; k++) {
      const ph = (t / 1100 + k / 14) % 1;
      const a = (k / 14) * Math.PI * 2;
      const r = ph * 0.5;
      const c = this.at(f.x + 0.7 + Math.cos(a) * r, f.y + 0.7 + Math.sin(a) * r, 0.8 + dz + ph * 0.7 - ph * ph * 1.4);
      ctx.beginPath();
      ctx.arc(c[0], c[1], Math.max(1, s * 0.03), 0, 7);
      ctx.fill();
    }
  }

  private car(c: Extract<Item, { kind: "car" }>, dz: number, t: number): void {
    const p = this.palette;
    const s = this.camera.scale;
    const B = (o: Omit<BoxShape, "seed" | "z"> & { z?: number }) => this.box({ z: 0, seed: c.seed, ...o }, dz, t);
    const body = tint(p, c.color);
    for (const [a, b] of [
      [0.15, 0],
      [0.85, 0],
      [0.15, 0.48],
      [0.85, 0.48],
    ]) {
      B({ x: c.x + a, y: c.y + b, w: 0.2, d: 0.1, h: 0.18, color: "#222" });
    }
    B({ x: c.x, y: c.y + 0.04, z: 0.1, w: 1.2, d: 0.52, h: 0.26, color: body });
    B({ x: c.x + 0.28, y: c.y + 0.07, z: 0.36, w: 0.6, d: 0.46, h: 0.22, color: p.night ? "#2a3550" : "#bfe0ef" });
    B({ x: c.x + 0.3, y: c.y + 0.09, z: 0.58, w: 0.56, d: 0.42, h: 0.02, color: body });
    if (p.night) this.glow(this.at(c.x + 1.2, c.y + 0.3, 0.25 + dz), s * 0.8, "255,240,190", 0.6);
  }

  private snowman(m: Extract<Item, { kind: "snowman" }>, dz: number, t: number): void {
    const white = this.palette.snow;
    const B = (o: Omit<BoxShape, "seed" | "z"> & { z?: number }) => this.box({ z: 0, seed: m.seed, ...o }, dz, t);
    B({ x: m.x, y: m.y, w: 0.55, d: 0.55, h: 0.45, color: white });
    B({ x: m.x + 0.09, y: m.y + 0.09, z: 0.45, w: 0.38, d: 0.38, h: 0.32, color: white });
    B({ x: m.x + 0.08, y: m.y + 0.08, z: 0.72, w: 0.4, d: 0.4, h: 0.06, color: m.color });
    B({ x: m.x + 0.14, y: m.y + 0.14, z: 0.78, w: 0.28, d: 0.28, h: 0.26, color: white });
    B({ x: m.x + 0.24, y: m.y + 0.42, z: 0.88, w: 0.06, d: 0.16, h: 0.05, color: "#f08a24" });
    B({ x: m.x + 0.12, y: m.y + 0.12, z: 1.04, w: 0.32, d: 0.32, h: 0.04, color: "#2a2a2e" });
    B({ x: m.x + 0.17, y: m.y + 0.17, z: 1.08, w: 0.22, d: 0.22, h: 0.2, color: "#2a2a2e" });
  }

  private pumpkin(m: Extract<Item, { kind: "pumpkin" }>, dz: number, t: number): void {
    const p = this.palette;
    this.box({ x: m.x, y: m.y, z: 0, w: 0.34, d: 0.34, h: 0.26, color: tint(p, "#e47b22"), side: "siding", seed: m.seed }, dz, t);
    this.box({ x: m.x + 0.15, y: m.y + 0.15, z: 0.26, w: 0.05, d: 0.05, h: 0.08, color: tint(p, "#4f7a33"), seed: m.seed }, dz, t);
  }

  private steam(st: Extract<Item, { kind: "steam" }>, dz: number, t: number): void {
    const { ctx } = this;
    const s = this.camera.scale;
    ctx.strokeStyle = this.palette.night ? "rgba(220,220,235,.35)" : "rgba(255,255,255,.85)";
    ctx.lineWidth = Math.max(1, s * 0.03);
    for (let k = 0; k < 2; k++) {
      const f = (t / 1600 + k * 0.5) % 1;
      const c = this.at(st.x + k * 0.05, st.y, st.z + dz + f * 0.5);
      ctx.globalAlpha = this.alpha * (1 - f);
      ctx.beginPath();
      ctx.moveTo(c[0], c[1]);
      ctx.quadraticCurveTo(c[0] + s * 0.06, c[1] - s * 0.08, c[0], c[1] - s * 0.16);
      ctx.stroke();
    }
    ctx.globalAlpha = this.alpha;
  }

  /** The meadow's waterfall off the island edge. */
  private fall(f: Extract<Item, { kind: "fall" }>, dz: number, t: number): void {
    const { ctx, palette: p } = this;
    const s = this.camera.scale;
    const z = f.z + dz;
    const q = [this.at(f.x, f.y, z), this.at(f.x, f.y + f.width, z), this.at(f.x, f.y + f.width, z - f.length), this.at(f.x, f.y, z - f.length)];
    const g = ctx.createLinearGradient(q[0][0], q[0][1], q[3][0], q[3][1]);
    g.addColorStop(0, p.water);
    g.addColorStop(0.75, shade(p.water, 0.35) + "aa");
    g.addColorStop(1, "rgba(255,255,255,0)");
    poly(ctx, q, g);
    ctx.strokeStyle = "rgba(255,255,255,.75)";
    ctx.lineWidth = Math.max(1, s * 0.03);
    ctx.beginPath();
    for (let k = 0; k < 7; k++) {
      const u = f.y + f.width * ((k + 0.5) / 7);
      const zz = z - ((t / 700 + k * 0.37) % 1) * f.length * 0.85;
      ctx.moveTo(...this.at(f.x, u, zz));
      ctx.lineTo(...this.at(f.x, u, zz - 0.5));
    }
    ctx.stroke();
  }

  /** Roots, cables or icicles hanging off an island's two front edges. */
  private hang(h: Extract<Item, { kind: "hang" }>, dz: number, t: number): void {
    const { ctx, palette: p } = this;
    const s = this.camera.scale;
    const R = rng(h.pattern);
    const edge = (front: boolean, u: number, zz: number) =>
      front ? this.at(h.x + u, h.y + h.size + 0.07, zz + dz) : this.at(h.x + h.size + 0.07, h.y + u, zz + dz);
    if (h.variety === "icicles") {
      ctx.fillStyle = p.night ? "rgba(190,215,240,.8)" : "rgba(225,240,252,.95)";
      for (let k = 0; k < 22; k++) {
        const front = R() < 0.5;
        const u = 0.2 + R() * (h.size - 0.4);
        const length = 0.2 + R() * 0.6;
        const a = edge(front, u, -0.46);
        const w = s * 0.06;
        ctx.beginPath();
        ctx.moveTo(a[0] - w, a[1]);
        ctx.lineTo(a[0] + w, a[1]);
        ctx.lineTo(a[0], a[1] + length * s);
        ctx.fill();
      }
      return;
    }
    ctx.strokeStyle = h.variety === "cables" ? "#4a4d55" : tint(p, "#4a3a2c");
    ctx.lineWidth = Math.max(1, s * 0.03);
    ctx.beginPath();
    for (let k = 0; k < 9; k++) {
      const front = R() < 0.5;
      const u = 0.4 + R() * (h.size - 0.8);
      const length = 0.5 + R() * 1.2;
      const sway = Math.sin(t / 1600 + k) * 0.12;
      const a = edge(front, u, -0.46);
      ctx.moveTo(...a);
      ctx.quadraticCurveTo(a[0] + sway * s, a[1] + length * s * 0.4, a[0] + sway * s * 2, a[1] + length * s * 0.75);
    }
    ctx.stroke();
    if (h.variety === "roots") {
      ctx.fillStyle = p.leaf;
      for (let k = 0; k < 6; k++) {
        const front = R() < 0.5;
        const u = 0.3 + R() * (h.size - 0.6);
        const a = edge(front, u, -0.5);
        ctx.beginPath();
        ctx.ellipse(a[0], a[1] + s * 0.08, s * 0.1, s * 0.14, 0, 0, 7);
        ctx.fill();
      }
    }
  }

  /** Falling snow, drifting leaves, butterflies or blowing dust over an island. */
  private weather(e: Extract<Item, { kind: "weather" }>, dz: number, t: number): void {
    const { ctx, palette: p } = this;
    const s = this.camera.scale;
    const R = rng(e.pattern + 99);
    if (e.variety === "snow") {
      ctx.fillStyle = "#ffffff";
      for (let k = 0; k < 40; k++) {
        const u = R() * e.size;
        const v = R() * e.size;
        const ph = (t / 5000 + R()) % 1;
        const c = this.at(e.x + u + Math.sin(t / 900 + k) * 0.2, e.y + v, 5 - ph * 5.2 + dz);
        ctx.globalAlpha = this.alpha * 0.9;
        ctx.beginPath();
        ctx.arc(c[0], c[1], Math.max(1.2, s * 0.04), 0, 7);
        ctx.fill();
      }
    } else if (e.variety === "leaves") {
      const colors = ["#d9672e", "#b8402c", "#e8b23e"];
      for (let k = 0; k < 16; k++) {
        const u = R() * e.size;
        const v = R() * e.size;
        const ph = (t / 6500 + R()) % 1;
        const c = this.at(e.x + u + Math.sin(t / 700 + k) * 0.35, e.y + v, 4 - ph * 4 + dz);
        ctx.save();
        ctx.translate(...c);
        ctx.rotate(t / 400 + k);
        ctx.fillStyle = tint(p, colors[k % 3]);
        ctx.globalAlpha = this.alpha * Math.min(1, (1 - ph) * 4);
        ctx.fillRect(-s * 0.06, -s * 0.03, s * 0.12, s * 0.06);
        ctx.restore();
      }
    } else if (e.variety === "butterflies") {
      const colors = ["#ffd75e", "#ff8fb1", "#ffffff", "#b9a7ff"];
      for (let k = 0; k < 5; k++) {
        const u = 1 + R() * (e.size - 2);
        const v = 5 + R() * 3;
        const a = t / 1800 + k * 1.7;
        const c = this.at(e.x + u + Math.cos(a) * 0.6, e.y + v + Math.sin(a * 1.3) * 0.5, 0.8 + Math.sin(a * 3) * 0.25 + dz);
        const flap = this.still ? 0.7 : Math.abs(Math.sin(t / 70 + k));
        ctx.fillStyle = colors[k % 4];
        ctx.beginPath();
        ctx.ellipse(c[0] - s * 0.05 * flap, c[1], s * 0.06 * flap + 0.5, s * 0.05, 0, 0, 7);
        ctx.ellipse(c[0] + s * 0.05 * flap, c[1], s * 0.06 * flap + 0.5, s * 0.05, 0, 0, 7);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = p.night ? "rgba(200,170,130,.18)" : "rgba(220,180,120,.3)";
      for (let k = 0; k < 10; k++) {
        const v = R() * e.size;
        const ph = (t / 7000 + R()) % 1;
        const c = this.at(e.x + ph * e.size, e.y + v, 0.3 + R() * 0.5 + dz);
        ctx.beginPath();
        ctx.arc(c[0], c[1], s * (0.12 + R() * 0.15), 0, 7);
        ctx.fill();
      }
    }
    ctx.globalAlpha = this.alpha;
  }

  private flag(fl: Extract<Item, { kind: "flag" }>, dz: number, t: number): void {
    const { ctx } = this;
    const s = this.camera.scale;
    const [bx, by] = this.at(fl.x, fl.y, dz);
    const [tx, ty] = this.at(fl.x, fl.y, dz + fl.height);
    ctx.strokeStyle = "#8d8a83";
    ctx.lineWidth = Math.max(1, s * 0.05);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.fillStyle = tint(this.palette, fl.color);
    ctx.beginPath();
    ctx.moveTo(tx, ty + 1);
    const L = s * 0.6;
    const H = s * 0.34;
    const wave = (u: number) => Math.sin(t / 300 + fl.phase + u * 4) * s * 0.05 * u;
    for (let k = 0; k <= 6; k++) ctx.lineTo(tx + (k / 6) * L, ty + 1 + wave(k / 6));
    for (let k = 6; k >= 0; k--) ctx.lineTo(tx + (k / 6) * L, ty + 1 + H + wave(k / 6));
    ctx.fill();
  }

  // ---------- helpers (decoration: never hoverable, never a state bubble) ----------

  private bot(b: Extract<Item, { kind: "bot" }>, dz: number, t: number): void {
    if (b.use === "lounge") return this.vacuum(b, dz, t);
    if (b.use === "lab") return this.armBot(b, dz, t);
    const { ctx } = this;
    const s = this.camera.scale * 1.45;
    const f = (t / (8000 + b.phase * 3000) + b.phase) % 1;
    const tri = f < 0.5 ? f * 2 : 2 - f * 2;
    const dir = f < 0.5 ? 1 : -1;
    const x = b.x0 + (b.x1 - b.x0) * tri;
    const hover = 0.2 + Math.sin(t / 260 + b.phase * 9) * 0.03;
    const [gx, gy] = this.at(x, b.y, dz);
    const [bx, by] = this.at(x, b.y, dz + hover);
    const body = mix(b.color, "#ffffff", 0.35);
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, s * 0.22);
    g.addColorStop(0, "rgba(127,232,255,.35)");
    g.addColorStop(1, "rgba(127,232,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(gx, gy, s * 0.22, s * 0.1, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,.18)";
    ctx.beginPath();
    ctx.ellipse(gx, gy, s * 0.14, s * 0.06, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = body;
    ctx.strokeStyle = "rgba(0,0,0,.25)";
    ctx.lineWidth = 1;
    roundRect(ctx, bx - s * 0.15, by - s * 0.3, s * 0.3, s * 0.26, s * 0.1);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#24262e";
    roundRect(ctx, bx - s * 0.11, by - s * 0.25, s * 0.22, s * 0.1, s * 0.05);
    ctx.fill();
    ctx.fillStyle = "#7fe8ff";
    for (const e of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(bx + e * s * 0.045 + dir * s * 0.02, by - s * 0.2, Math.max(1, s * 0.022), 0, 7);
      ctx.fill();
    }
    ctx.strokeStyle = "#55575f";
    ctx.beginPath();
    ctx.moveTo(bx, by - s * 0.3);
    ctx.lineTo(bx, by - s * 0.4);
    ctx.stroke();
    ctx.fillStyle = Math.sin(t / 300 + b.phase * 7) > 0 ? b.color : "#55575f";
    ctx.beginPath();
    ctx.arc(bx, by - s * 0.41, Math.max(1.2, s * 0.03), 0, 7);
    ctx.fill();
    if (b.use === "meeting") {
      ctx.fillStyle = "#f6f1e7";
      for (let k = 0; k < 3; k++) ctx.fillRect(bx - s * 0.08 + k * 1.2, by - s * 0.06 - k * 1.2, s * 0.15, s * 0.1);
    } else if (b.phase > 0.5) {
      ctx.fillStyle = "#c9a26b";
      ctx.fillRect(bx - s * 0.09, by - s * 0.07, s * 0.18, s * 0.11);
      ctx.strokeStyle = "rgba(0,0,0,.2)";
      ctx.strokeRect(bx - s * 0.09, by - s * 0.07, s * 0.18, s * 0.11);
    } else {
      ctx.fillStyle = "#efe9de";
      roundRect(ctx, bx - s * 0.05, by - s * 0.08, s * 0.1, s * 0.09, 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.6)";
      ctx.lineWidth = 1;
      const w = Math.sin(t / 300) * s * 0.01;
      ctx.beginPath();
      ctx.moveTo(bx, by - s * 0.1);
      ctx.quadraticCurveTo(bx + s * 0.03 + w, by - s * 0.15, bx, by - s * 0.2);
      ctx.stroke();
    }
  }

  /** Lounge helper: a round vacuum that loops the rug. */
  private vacuum(b: Extract<Item, { kind: "bot" }>, dz: number, t: number): void {
    const { ctx } = this;
    const s = this.camera.scale;
    const cx = (b.x0 + b.x1) / 2;
    const angle = t / 2600 + b.phase * 6;
    const [px, py] = this.at(cx - 0.3 + Math.cos(angle) * (b.x1 - b.x0) * 0.26, b.y + Math.sin(angle) * 0.22, dz + 0.02);
    const r = s * 0.24;
    ctx.fillStyle = "rgba(0,0,0,.2)";
    ctx.beginPath();
    ctx.ellipse(px, py + s * 0.03, r, r * 0.5, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = "#3a3c44";
    ctx.beginPath();
    ctx.ellipse(px, py, r, r * 0.5, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = "#e8e6e1";
    ctx.beginPath();
    ctx.ellipse(px, py - s * 0.05, r, r * 0.5, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.ellipse(px, py - s * 0.05, r * 0.45, r * 0.22, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = Math.sin(t / 250) > 0 ? "#7fe8a8" : "#3a3c44";
    ctx.beginPath();
    ctx.arc(px + Math.cos(angle + 1.6) * r * 0.7, py - s * 0.05 + Math.sin(angle + 1.6) * r * 0.35, Math.max(1, s * 0.03), 0, 7);
    ctx.fill();
  }

  /** Lab helper: a tracked arm bot that scans the racks. */
  private armBot(b: Extract<Item, { kind: "bot" }>, dz: number, t: number): void {
    const { ctx } = this;
    const s = this.camera.scale;
    const f = (t / (9000 + b.phase * 2000) + b.phase) % 1;
    const tri = f < 0.5 ? f * 2 : 2 - f * 2;
    const [px, py] = this.at(b.x0 + (b.x1 - b.x0) * tri, b.y, dz);
    ctx.fillStyle = "rgba(0,0,0,.2)";
    ctx.beginPath();
    ctx.ellipse(px, py, s * 0.26, s * 0.1, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = "#2b2d35";
    roundRect(ctx, px - s * 0.24, py - s * 0.12, s * 0.48, s * 0.12, s * 0.05);
    ctx.fill();
    ctx.fillStyle = "#55575f";
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.arc(px - s * 0.17 + k * s * 0.113, py - s * 0.06, Math.max(1, s * 0.035), 0, 7);
      ctx.fill();
    }
    ctx.fillStyle = mix(b.color, "#ffffff", 0.3);
    roundRect(ctx, px - s * 0.14, py - s * 0.32, s * 0.28, s * 0.2, s * 0.05);
    ctx.fill();
    const a1 = -1.2 + Math.sin(t / 700 + b.phase * 5) * 0.35;
    const a2 = a1 + 1.4 + Math.sin(t / 430) * 0.3;
    const j1: Point = [px + s * 0.06, py - s * 0.32];
    const j2: Point = [j1[0] + Math.cos(a1) * s * 0.3, j1[1] + Math.sin(a1) * s * 0.3];
    const j3: Point = [j2[0] + Math.cos(a2) * s * 0.24, j2[1] + Math.sin(a2) * s * 0.24];
    ctx.strokeStyle = "#f2c94c";
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(2, s * 0.07);
    ctx.beginPath();
    ctx.moveTo(...j1);
    ctx.lineTo(...j2);
    ctx.lineTo(...j3);
    ctx.stroke();
    ctx.lineCap = "butt";
    ctx.fillStyle = "#2b2d35";
    for (const j of [j1, j2]) {
      ctx.beginPath();
      ctx.arc(j[0], j[1], Math.max(1.5, s * 0.045), 0, 7);
      ctx.fill();
    }
    ctx.fillStyle = `rgba(255,80,80,${0.5 + 0.5 * Math.sin(t / 200)})`;
    ctx.beginPath();
    ctx.arc(j3[0], j3[1], Math.max(1.5, s * 0.04), 0, 7);
    ctx.fill();
  }

  /** A delivery drone shuttling between an island and the square. */
  private drone(d: Extract<Item, { kind: "drone" }>, dz: number, t: number): void {
    const { ctx } = this;
    const s = this.camera.scale;
    const f = (t / 14000 + d.phase * 0.37) % 1;
    const leg = f < 0.5 ? f * 2 : (f - 0.5) * 2;
    const outbound = f < 0.5;
    const u = ease(Math.min(1, Math.max(0, (leg - 0.15) / 0.7)));
    const from = outbound ? [d.x, d.y] : [d.x2, d.y2];
    const to = outbound ? [d.x2, d.y2] : [d.x, d.y];
    const x = from[0] + (to[0] - from[0]) * u;
    const y = from[1] + (to[1] - from[1]) * u;
    const lift = leg < 0.15 ? (leg / 0.15) * 1.5 : leg > 0.85 ? ((1 - leg) / 0.15) * 1.5 : 1.5 + Math.sin(Math.PI * u) * 3;
    const z = 0.35 + lift + Math.sin(t / 300 + d.phase) * 0.05;
    const [px, py] = this.at(x, y, z + dz);
    ctx.strokeStyle = "#55575f";
    ctx.lineWidth = Math.max(1, s * 0.04);
    for (const [ex, ey] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      const rx = px + ex * s * 0.2;
      const ry = py + ey * s * 0.07;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(rx, ry);
      ctx.stroke();
      ctx.fillStyle = `rgba(200,205,215,${0.45 + 0.25 * Math.sin(t / 30 + ex * ey)})`;
      ctx.beginPath();
      ctx.ellipse(rx, ry - s * 0.03, s * 0.12, s * 0.035, 0, 0, 7);
      ctx.fill();
    }
    ctx.fillStyle = "#2b2d35";
    roundRect(ctx, px - s * 0.11, py - s * 0.06, s * 0.22, s * 0.1, s * 0.04);
    ctx.fill();
    ctx.fillStyle = d.color;
    roundRect(ctx, px - s * 0.06, py - s * 0.05, s * 0.12, s * 0.04, s * 0.02);
    ctx.fill();
    if (outbound) {
      ctx.strokeStyle = "rgba(60,60,60,.6)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, py + s * 0.04);
      ctx.lineTo(px, py + s * 0.14);
      ctx.stroke();
      ctx.fillStyle = "#c9a26b";
      ctx.fillRect(px - s * 0.08, py + s * 0.14, s * 0.16, s * 0.12);
      ctx.strokeStyle = "rgba(0,0,0,.25)";
      ctx.strokeRect(px - s * 0.08, py + s * 0.14, s * 0.16, s * 0.12);
    }
    ctx.fillStyle = Math.sin(t / 180 + d.phase) > 0 ? "#ff5a5a" : "#7fe8a8";
    ctx.beginPath();
    ctx.arc(px + s * 0.1, py - s * 0.02, Math.max(1, s * 0.025), 0, 7);
    ctx.fill();
  }

  // ---------- agents and labels ----------

  /** An agent by state: working types with a "…" bubble, blocked waves with a red
   *  "!", quiet dozes greyed out with a mug and "z"s. Registers its hit circle. */
  private agent(item: AgentItem, dz: number, t: number): void {
    const { ctx, palette: p } = this;
    const s = this.camera.scale * 1.3;
    const character = item.character;
    const h = hash(`${character.agentName ?? ""}${character.taskId}`);
    const quiet = character.state === "quiet";
    const blocked = character.state === "blocked";
    const working = character.state === "working";
    const x = item.pace ? item.x + Math.sin(t / 1100 + h) * item.pace : item.x;
    const [sx, sy] = this.at(x, item.y, item.z + dz);
    let shirt = SHIRTS[h % SHIRTS.length];
    let skin = SKIN[(h >> 3) % SKIN.length];
    let hair = HAIR[(h >> 5) % HAIR.length];
    let pants = PANTS[(h >> 7) % 3];
    if (quiet) {
      shirt = mix(shirt, p.faint, 0.55);
      skin = mix(skin, p.faint, 0.35);
      hair = mix(hair, p.faint, 0.4);
      pants = mix(pants, p.faint, 0.4);
    }
    const sit = item.pose === "sit";
    const legH = sit ? 0 : 0.3 * s;
    const torsoH = 0.34 * s;
    const bodyW = 0.3 * s;
    const headR = 0.135 * s;
    const bob = working ? Math.sin(t / 170 + h) * 0.01 * s : blocked ? -Math.abs(Math.sin(t / 320 + h)) * 0.035 * s : 0;
    const base = sy + bob;
    ctx.fillStyle = "rgba(0,0,0,.2)";
    ctx.beginPath();
    ctx.ellipse(sx, sy + (sit ? 0.02 * s : 0), 0.2 * s, 0.09 * s, 0, 0, 7);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,.28)";
    if (!sit) {
      const step = item.pace ? Math.sin(t / 190 + h) * 0.025 * s : 0;
      ctx.fillStyle = pants;
      roundRect(ctx, sx - bodyW * 0.42 + step, base - legH, bodyW * 0.36, legH, 2);
      ctx.fill();
      roundRect(ctx, sx + bodyW * 0.06 - step, base - legH, bodyW * 0.36, legH, 2);
      ctx.fill();
      ctx.fillStyle = "#2a2522";
      roundRect(ctx, sx - bodyW * 0.46 + step, base - 0.05 * s, bodyW * 0.42, 0.05 * s, 2);
      ctx.fill();
      roundRect(ctx, sx + bodyW * 0.04 - step, base - 0.05 * s, bodyW * 0.42, 0.05 * s, 2);
      ctx.fill();
    } else if (!item.desk) {
      ctx.fillStyle = pants;
      roundRect(ctx, sx - bodyW * 0.46, base - 0.07 * s, bodyW * 0.92, 0.13 * s, 4);
      ctx.fill();
      ctx.fillStyle = shade(pants, -0.15);
      roundRect(ctx, sx - bodyW * 0.38, base + 0.03 * s, bodyW * 0.28, 0.15 * s, 2);
      ctx.fill();
      roundRect(ctx, sx + bodyW * 0.1, base + 0.03 * s, bodyW * 0.28, 0.15 * s, 2);
      ctx.fill();
    }
    const torsoTop = base - legH - torsoH;
    const g = ctx.createLinearGradient(sx - bodyW / 2, 0, sx + bodyW / 2, 0);
    g.addColorStop(0, shade(shirt, 0.08));
    g.addColorStop(1, shade(shirt, -0.18));
    ctx.fillStyle = g;
    roundRect(ctx, sx - bodyW / 2, torsoTop, bodyW, torsoH + (sit ? 0.05 * s : 0), bodyW * 0.38);
    ctx.fill();
    ctx.stroke();
    // lanyard and badge in the project colour
    const badge = quiet ? mix(item.color, p.faint, 0.5) : item.color;
    ctx.strokeStyle = badge;
    ctx.lineWidth = Math.max(1, s * 0.025);
    ctx.beginPath();
    ctx.moveTo(sx - bodyW * 0.22, torsoTop + 0.02 * s);
    ctx.lineTo(sx, torsoTop + 0.15 * s);
    ctx.lineTo(sx + bodyW * 0.22, torsoTop + 0.02 * s);
    ctx.stroke();
    ctx.fillStyle = badge;
    roundRect(ctx, sx - 0.045 * s, torsoTop + 0.14 * s, 0.09 * s, 0.1 * s, 1.5);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.fillRect(sx - 0.03 * s, torsoTop + 0.17 * s, 0.06 * s, 0.015 * s);
    ctx.lineCap = "round";
    ctx.strokeStyle = shade(shirt, -0.12);
    ctx.lineWidth = 0.085 * s;
    if (working) {
      for (const side of [-1, 1]) {
        const typing = Math.sin(t / 85 + h + side * 1.7) * 0.02 * s;
        ctx.beginPath();
        ctx.moveTo(sx + side * bodyW * 0.45, torsoTop + 0.08 * s);
        ctx.lineTo(sx + side * bodyW * 0.22, torsoTop + 0.27 * s + typing);
        ctx.stroke();
      }
    } else if (blocked) {
      ctx.beginPath();
      ctx.moveTo(sx - bodyW * 0.48, torsoTop + 0.08 * s);
      ctx.lineTo(sx - bodyW * 0.55, torsoTop + 0.3 * s);
      ctx.stroke();
      const wave = Math.sin(t / 160 + h) * 0.06 * s;
      ctx.beginPath();
      ctx.moveTo(sx + bodyW * 0.45, torsoTop + 0.06 * s);
      ctx.lineTo(sx + bodyW * 0.62 + wave, torsoTop - 0.22 * s);
      ctx.stroke();
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.arc(sx + bodyW * 0.62 + wave, torsoTop - 0.24 * s, 0.045 * s, 0, 7);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(sx - bodyW * 0.48, torsoTop + 0.08 * s);
      ctx.lineTo(sx - bodyW * 0.52, torsoTop + 0.28 * s);
      ctx.moveTo(sx + bodyW * 0.48, torsoTop + 0.08 * s);
      ctx.lineTo(sx + bodyW * 0.2, torsoTop + 0.24 * s);
      ctx.stroke();
      ctx.fillStyle = "#efe9de";
      roundRect(ctx, sx + bodyW * 0.05, torsoTop + 0.17 * s, 0.08 * s, 0.09 * s, 1.5);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,.3)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.strokeStyle = p.night ? "rgba(220,220,235,.35)" : "rgba(255,255,255,.7)";
      ctx.beginPath();
      ctx.moveTo(sx + bodyW * 0.18, torsoTop + 0.15 * s);
      ctx.quadraticCurveTo(sx + bodyW * 0.3, torsoTop + 0.08 * s, sx + bodyW * 0.2, torsoTop + 0.02 * s);
      ctx.stroke();
    }
    ctx.lineCap = "butt";
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,.28)";
    const hx = sx + (quiet ? 0.035 * s : 0);
    const hy = torsoTop - headR * 0.82;
    const hairStyle = (h >> 9) % 3;
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(hx, hy, headR, 0, 7);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = hair;
    ctx.beginPath();
    ctx.arc(hx, hy - headR * 0.12, headR * 1.02, Math.PI * 1.02, Math.PI * 1.98);
    ctx.closePath();
    ctx.fill();
    if (hairStyle === 2) {
      roundRect(ctx, hx - headR * 1.02, hy - headR * 0.3, headR * 0.32, headR * 1.2, 3);
      ctx.fill();
      roundRect(ctx, hx + headR * 0.7, hy - headR * 0.3, headR * 0.32, headR * 1.2, 3);
      ctx.fill();
    }
    if (hairStyle === 1) {
      ctx.beginPath();
      ctx.arc(hx, hy - headR * 1.05, headR * 0.38, 0, 7);
      ctx.fill();
    }
    if (working && h % 2) {
      // headset
      ctx.strokeStyle = "#2b2d35";
      ctx.lineWidth = Math.max(1.2, headR * 0.18);
      ctx.beginPath();
      ctx.arc(hx, hy, headR * 1.12, Math.PI * 1.08, Math.PI * 1.92);
      ctx.stroke();
      ctx.fillStyle = "#2b2d35";
      roundRect(ctx, hx - headR * 1.2, hy - headR * 0.25, headR * 0.32, headR * 0.55, headR * 0.12);
      ctx.fill();
      roundRect(ctx, hx + headR * 0.88, hy - headR * 0.25, headR * 0.32, headR * 0.55, headR * 0.12);
      ctx.fill();
      ctx.lineWidth = Math.max(1, headR * 0.1);
      ctx.beginPath();
      ctx.moveTo(hx - headR * 1.05, hy + headR * 0.25);
      ctx.quadraticCurveTo(hx - headR * 0.9, hy + headR * 0.8, hx - headR * 0.35, hy + headR * 0.75);
      ctx.stroke();
    }
    ctx.fillStyle = "#2a2522";
    if (quiet) {
      ctx.fillRect(hx - headR * 0.5, hy + headR * 0.15, headR * 0.32, 1.2);
      ctx.fillRect(hx + headR * 0.18, hy + headR * 0.15, headR * 0.32, 1.2);
    } else {
      ctx.beginPath();
      ctx.arc(hx - headR * 0.35, hy + headR * 0.15, Math.max(1, headR * 0.11), 0, 7);
      ctx.arc(hx + headR * 0.35, hy + headR * 0.15, Math.max(1, headR * 0.11), 0, 7);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(240,120,120,.35)";
    ctx.beginPath();
    ctx.arc(hx - headR * 0.55, hy + headR * 0.45, headR * 0.16, 0, 7);
    ctx.arc(hx + headR * 0.55, hy + headR * 0.45, headR * 0.16, 0, 7);
    ctx.fill();
    if (working && item.desk) {
      const glow = ctx.createRadialGradient(hx, hy + headR * 0.4, 0, hx, hy + headR * 0.4, headR * 2);
      glow.addColorStop(0, `rgba(150,190,255,${p.night ? 0.45 : 0.25})`);
      glow.addColorStop(1, "rgba(150,190,255,0)");
      ctx.globalCompositeOperation = p.night ? "lighter" : "source-over";
      ctx.fillStyle = glow;
      ctx.fillRect(hx - headR * 2, hy - headR * 1.6, headR * 4, headR * 4);
      ctx.globalCompositeOperation = "source-over";
    }
    const bx = sx + 0.2 * s;
    const by = hy - headR - 0.16 * s;
    if (working) this.workBubble(bx, by, t, s);
    else if (blocked) {
      const pulse = (t / 900 + h * 0.01) % 1;
      ctx.strokeStyle = p.danger;
      ctx.globalAlpha = this.alpha * (1 - pulse) * 0.8;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(bx, by, (0.13 + pulse * 0.32) * s, 0, 7);
      ctx.stroke();
      ctx.globalAlpha = this.alpha;
      ctx.fillStyle = p.danger;
      roundRect(ctx, bx - 0.14 * s, by - 0.14 * s, 0.28 * s, 0.28 * s, 0.08 * s);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(bx - 0.08 * s, by + 0.12 * s);
      ctx.lineTo(bx - 0.15 * s, by + 0.22 * s);
      ctx.lineTo(bx, by + 0.13 * s);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = `800 ${Math.max(8, 0.22 * s)}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("!", bx, by + 1);
    } else {
      ctx.fillStyle = p.night ? "#b9b8c8" : "#8d8a83";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let k = 0; k < 3; k++) {
        const ph = (t / 2200 + k / 3 + h * 0.07) % 1;
        ctx.globalAlpha = this.alpha * Math.sin(ph * Math.PI) * 0.9;
        ctx.font = `700 ${Math.max(7, (0.11 + ph * 0.12) * s)}px ${FONT}`;
        ctx.fillText("z", bx - 0.05 * s + ph * 0.3 * s, by + 0.05 * s - ph * 0.45 * s);
      }
      ctx.globalAlpha = this.alpha;
    }
    if (this.hitOK) this.hits.push({ x: sx, y: torsoTop, r: Math.max(12, 0.4 * s), taskId: character.taskId });
  }

  /** The floating name chip: colour dot, name, and a dot + count per state (or
   *  "N open" when nobody is there). Project chips are clickable. */
  private label(item: LabelItem, dz: number): void {
    const { ctx, palette: p } = this;
    const topZ = item.projectId !== null ? this.buildingStates.get(item.projectId)?.topZ || item.baseZ : item.baseZ;
    const [sx, sy] = this.at(item.x, item.y, topZ + 0.7 + dz);
    const parts = (
      [
        [item.counts.working, p.doing],
        [item.counts.blocked, p.danger],
        [item.counts.quiet, p.faint],
      ] as [number, string][]
    ).filter(([n]) => n > 0);
    ctx.font = `600 12px ${FONT}`;
    const nameWidth = ctx.measureText(item.name).width;
    const sub = parts.length ? "" : `${item.open} open`;
    ctx.font = `500 11px ${FONT}`;
    const extra = parts.length ? parts.length * 24 : ctx.measureText(sub).width + 8;
    const W = nameWidth + 30 + extra;
    const H = 26;
    const x = sx - W / 2;
    const y = sy - H;
    if (item.projectId !== null) this.labelRects.push({ projectId: item.projectId, rect: [x, y, x + W, y + H + 6] });
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.18)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = p.labelBg;
    roundRect(ctx, x, y, W, H, 8);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = p.line;
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, W, H, 8);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx - 5, y + H);
    ctx.lineTo(sx, y + H + 6);
    ctx.lineTo(sx + 5, y + H);
    ctx.fillStyle = p.labelBg;
    ctx.fill();
    ctx.fillStyle = item.color;
    roundRect(ctx, x + 9, y + 8, 10, 10, 3);
    ctx.fill();
    ctx.fillStyle = p.ink;
    ctx.font = `600 12px ${FONT}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(item.name, x + 24, y + 13.5);
    let cx = x + 24 + nameWidth + 8;
    ctx.font = `600 11px ${FONT}`;
    if (!parts.length) {
      ctx.fillStyle = p.muted;
      ctx.fillText(sub, cx, y + 13.5);
    }
    for (const [n, color] of parts) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx + 4, y + 13, 4, 0, 7);
      ctx.fill();
      ctx.fillStyle = p.ink;
      ctx.fillText(String(n), cx + 11, y + 13.5);
      cx += 24;
    }
  }
}
