// The town's Pixi layer — a dumb renderer of the tiled world + the live sim.
//
// Responsibilities, all pure rendering over inputs it is handed:
//   renderWorld(world)  — tiles ground/roads/plaza and draws each building once
//     per world change / resize (buildings are few; never per frame).
//   syncChars(sim, …)   — every frame, reconciles one sprite view per live
//     character against SimState and advances its walk / desk-typing animation.
//   setCamera(cam)      — every frame, applies the pan/zoom transform to the
//     whole world container (canvas is viewport-sized; the world scrolls under it).
//   setAmbience(day, …) — every frame, drives the day/night tint overlay and the
//     warm window glow of offices with a live session.
//
// It owns no simulation and no timing beyond the walk-frame counter; TownView's
// ticker steps the sim and calls these. Textures are passed in, so this file
// imports no assets.

import {
  Application,
  Container,
  Graphics,
  Sprite,
  Text,
  TextStyle,
  Texture,
} from "pixi.js";
import type { PresenceState } from "../utils/presence";
import type { Camera } from "./camera";
import type { DirFrames, TownTextures } from "./assets";
import type { SimState } from "./sim";
import { TILE_PX, type TownWorld } from "./world";

export interface TownTheme {
  ground: number;
  wall: number;
  roof: number;
  title: number;
  inkMuted: number;
  blocked: number;
  reducedMotion: boolean;
}

/** Day/night ambience the renderer overlays (from daynight.ts). */
export interface Ambience {
  darkness: number;
  tint: number;
  glow: number;
}

/** Per-character render styling the sim doesn't carry (presence-derived). */
export interface CharStyle {
  agentKey: string;
  state: PresenceState;
  /** A live heartbeat placed it (vs a faded fallback write). */
  live: boolean;
}

interface CharView {
  container: Container;
  sprite: Sprite;
  ring: Graphics;
  anim: number;
  agentKey: string;
}

/** A window-glow sprite tagged with the building it belongs to and its world
 *  tile (projected to screen each frame, since it lives at the stage). */
interface Glow {
  buildingIndex: number;
  wx: number;
  wy: number;
  sprite: Sprite;
}

/** ms per walk frame. */
const FRAME_MS = 130;

/** Character sprite key by agent name — mirrors agents.tsx RULES. */
export function charKeyForAgent(name: string | null | undefined): string {
  const n = (name ?? "").toLowerCase();
  if (n.includes("tildone-ai")) return "secretary";
  if (n.includes("claude")) return "claude";
  if (n.includes("codex")) return "codex";
  if (n.includes("cursor")) return "cursor";
  return "generic";
}

export function createTownScene(app: Application, tex: TownTextures, scale = 2) {
  const tilePx = TILE_PX * scale;
  const world = new Container();
  const ground = new Container();
  const buildings = new Container();
  const charLayer = new Container();
  const glowLayer = new Container();
  const nightOverlay = new Graphics();
  nightOverlay.alpha = 0;
  charLayer.sortableChildren = true;
  world.addChild(ground, buildings, charLayer);
  // The night tint + window glow live at the STAGE (screen space), above the
  // camera-transformed world — so the tint fills the whole viewport (not just the
  // world's extent, which can be smaller) and the glow punches through the night.
  // Glow sprites are projected onto screen each frame with the current camera.
  app.stage.addChild(world, nightOverlay, glowLayer);

  const views = new Map<number, CharView>();
  let glows: Glow[] = [];
  /** Street-lamp glows: warm pools projected to screen each frame (world-px),
   *  lit by the day/night cycle regardless of any office being live. */
  let lampGlows: { gx: number; gy: number; sprite: Sprite }[] = [];
  /** The plaza fountain sprite (its water shimmer is cycled each frame). */
  let fountainSprite: Sprite | null = null;
  let propAnim = 0;
  let currentCam: Camera = { x: 0, y: 0, zoom: 1 };

  const titleStyle = (fill: number) =>
    new TextStyle({ fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: "600", fill });

  /** Place a 16px tile sprite at tile (tx,ty), optional tint. */
  function tile(t: Texture, tx: number, ty: number, tint?: number): Sprite {
    const s = new Sprite(t);
    s.scale.set(scale);
    s.position.set(tx * tilePx, ty * tilePx);
    if (tint !== undefined) s.tint = tint;
    return s;
  }

  /** Deterministic 0..1 hash of a tile coord (stable scatter, no per-render RNG). */
  function hash(x: number, y: number): number {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) ^ 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function roofTint(place: TownWorld["buildings"][number]): number {
    return place.room.color && /^#[0-9a-f]{6}$/i.test(place.room.color)
      ? parseInt(place.room.color.slice(1), 16)
      : 0xcc5b3a;
  }

  function drawBuilding(place: TownWorld["buildings"][number]) {
    const g = new Container();
    const { tx, ty, tw, th } = place;
    const tint = roofTint(place);
    const int = tex.interior;
    // An enclosed open-front office: roof row on top, a facade of walls with
    // windows, a desk counter (one monitor per workstation) behind the wood-floor
    // aisle where workers sit, and a front wall with a single door onto the road.
    const wallTop = ty + 1;
    const deskRow = place.desks[0]?.y ?? ty + 2;
    const frontRow = ty + th - 1;

    // Walls fill everything between roof and the front wall; seats get wood floor.
    for (let ry = wallTop; ry <= frontRow; ry++) {
      for (let rx = 0; rx < tw; rx++) g.addChild(tile(int.wall, tx + rx, ry));
    }
    for (const s of place.seats) g.addChild(tile(int.floor, s.x, s.y));

    // Project-tinted roof.
    for (let rx = 0; rx < tw; rx++) {
      const roof = rx === 0 ? tex.world.roofL : rx === tw - 1 ? tex.world.roofR : tex.world.roofM;
      g.addChild(tile(roof, tx + rx, ty, tint));
    }

    // Facade: potted plants at the corners, windows between them.
    const winCols = [tx + 1, tx + tw - 2];
    g.addChild(tile(int.plant, tx, wallTop));
    g.addChild(tile(int.plant, tx + tw - 1, wallTop));
    for (const wx of winCols) g.addChild(tile(tex.facade.window, wx, wallTop));

    // A long desk counter with a monitor lifted onto each desk surface.
    place.desks.forEach((d, i) => {
      g.addChild(tile(i % 2 === 0 ? int.deskL : int.deskR, d.x, deskRow));
      const comp = tile(int.computer, d.x, deskRow);
      comp.y -= 5 * scale;
      g.addChild(comp);
    });

    // The single door in the front wall (over the wall tile already laid down).
    g.addChild(tile(tex.facade.door, place.door.x, frontRow));

    // Nameplate: a project-tinted dot + the project name on a dark rounded plate,
    // floated just above the roof. The plate is what makes the label readable —
    // bare text washed out against roof/grass (the v3 nameplates were near
    // invisible). Dim the whole plate when the office is empty (no characters).
    const occupied = place.room.characters.length > 0;
    const plate = new Container();
    const label = new Text({ text: place.room.name, style: titleStyle(0xf5f2ea) });
    label.anchor.set(0, 0.5);
    const padX = 5 * scale;
    const padY = 3 * scale;
    const dot = 5 * scale;
    const gap = 3 * scale;
    const plateW = padX * 2 + dot + gap + label.width;
    const plateH = padY * 2 + label.height;
    const cx = (tx + tw / 2) * tilePx;
    const plateX = cx - plateW / 2;
    const plateY = ty * tilePx - 3 * scale - plateH;
    const bg = new Graphics()
      .roundRect(plateX, plateY, plateW, plateH, 4 * scale)
      .fill({ color: 0x1e1b16, alpha: 0.78 });
    const midY = plateY + plateH / 2;
    const swatch = new Graphics()
      .circle(plateX + padX + dot / 2, midY, dot / 2)
      .fill({ color: tint });
    label.position.set(plateX + padX + dot + gap, midY);
    plate.addChild(bg, swatch, label);
    plate.alpha = occupied ? 1 : 0.55;
    g.addChild(plate);

    buildings.addChild(g);

    // Window-glow sprites (hidden until setAmbience lights a working office).
    // They live at the stage, so they carry their world tile and are projected +
    // scaled to screen each frame by setAmbience.
    return winCols.map((wx) => {
      const sprite = new Sprite(tex.facade.windowGlow);
      sprite.alpha = 0;
      sprite.blendMode = "add";
      glowLayer.addChild(sprite);
      return { wx, wy: wallTop, sprite };
    });
  }

  function renderWorld(w: TownWorld, _theme: TownTheme) {
    // Destroy detached display objects (not just detach) so resizes don't leak GPU.
    ground.removeChildren().forEach((c) => c.destroy({ children: true }));
    buildings.removeChildren().forEach((c) => c.destroy({ children: true }));
    glowLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    glows = [];
    lampGlows = [];
    fountainSprite = null;

    const isBuilding = new Set<string>();
    for (const b of w.buildings) {
      for (let ry = 0; ry < b.th; ry++) {
        for (let rx = 0; rx < b.tw; rx++) isBuilding.add(`${b.tx + rx},${b.ty + ry}`);
      }
    }
    const isSpot = new Set(w.spots.map((s) => `${s.tile.x},${s.tile.y}`));
    const isLamp = new Set(w.lamps.map((l) => `${l.x},${l.y}`));
    const inPlaza = (x: number, y: number) =>
      x >= w.plaza.x && x < w.plaza.x + w.plaza.w && y >= w.plaza.y && y < w.plaza.y + w.plaza.h;

    // Ground: grass with light per-tile variation, then roads and the plaza floor
    // painted over it where the world says so.
    for (let y = 0; y < w.rows; y++) {
      for (let x = 0; x < w.cols; x++) {
        const r = hash(x, y);
        const g = r < 0.06 ? tex.world.grass[2] : r < 0.18 ? tex.world.grass[1] : tex.world.grass[0];
        ground.addChild(tile(g, x, y));
        if (inPlaza(x, y)) ground.addChild(tile(tex.pavement.plaza, x, y));
        else if (w.road[y * w.cols + x]) ground.addChild(tile(tex.pavement.road, x, y));
      }
    }

    w.buildings.forEach((b, i) => {
      const winGlows = drawBuilding(b);
      for (const g of winGlows) glows.push({ buildingIndex: i, ...g });
    });

    // Scatter decorations on free green tiles (never on roads/plaza/footprints).
    for (let y = 0; y < w.rows; y++) {
      for (let x = 0; x < w.cols; x++) {
        const key = `${x},${y}`;
        if (isBuilding.has(key) || isSpot.has(key) || isLamp.has(key) || w.road[y * w.cols + x])
          continue;
        const r = hash(x * 7 + 1, y * 13 + 5);
        let dec: Texture | null = null;
        let tall = false;
        if (r < 0.06) {
          dec = tex.world.trees[x % tex.world.trees.length];
          tall = true;
        } else if (r < 0.11) {
          dec = tex.world.bush;
        } else if (r < 0.135) {
          dec = tex.world.mushrooms;
        }
        if (!dec) continue;
        const s = new Sprite(dec);
        s.scale.set(scale);
        if (tall) {
          s.anchor.set(0, 1);
          s.position.set(x * tilePx, (y + 1) * tilePx);
        } else {
          s.position.set(x * tilePx, y * tilePx);
        }
        buildings.addChild(s);
      }
    }

    // The fountain centrepiece on the plaza's (blocked) centre tile. Its water
    // shimmer is animated per frame (see the syncChars tail).
    if (w.plazaCenter) {
      const f = new Sprite(tex.fountain[0]);
      f.anchor.set(0.5, 0.9);
      f.scale.set(scale);
      f.position.set(w.plazaCenter.x * tilePx + tilePx / 2, w.plazaCenter.y * tilePx + tilePx);
      buildings.addChild(f);
      fountainSprite = f;
    }

    // Shared leisure props in the plaza (below the character layer).
    for (const s of w.spots) {
      const prop = new Sprite(tex.spots[s.kind]);
      prop.anchor.set(0.5, 0.9);
      prop.scale.set(scale);
      prop.position.set(s.tile.x * tilePx + tilePx / 2, s.tile.y * tilePx + tilePx);
      buildings.addChild(prop);
    }

    // Street lamps (positions + blocking come from the world model, so the sim
    // routes characters around them). Each carries a warm glow that the day/night
    // cycle lights at dusk (see setAmbience) — the streets come alive at night,
    // not just the office windows.
    for (const l of w.lamps) {
      const lamp = new Sprite(tex.lamp);
      lamp.anchor.set(0.5, 0.9);
      lamp.scale.set(scale);
      lamp.position.set(l.x * tilePx + tilePx / 2, l.y * tilePx + tilePx);
      buildings.addChild(lamp);
      // Glow pool centred on the lamp's glass (near the sprite top).
      const glow = new Sprite(tex.facade.windowGlow);
      glow.anchor.set(0.5, 0.5);
      glow.alpha = 0;
      glow.blendMode = "add";
      glowLayer.addChild(glow);
      lampGlows.push({ gx: l.x * tilePx + tilePx / 2, gy: l.y * tilePx + 3 * scale, sprite: glow });
    }
  }

  function makeView(agentKey: string): CharView {
    const container = new Container();
    const frames = (tex.chars[agentKey] ?? tex.chars.generic) as DirFrames;
    const sprite = new Sprite(frames.down[0]);
    sprite.anchor.set(0.5, 0.9);
    sprite.scale.set(scale);
    // A soft ground shadow so the character reads as standing on the tile, not
    // floating over it (the v3 sprites had none). Drawn at the feet, beneath
    // everything else in the container.
    const shadow = new Graphics()
      .ellipse(0, -1, 6, 2.5)
      .fill({ color: 0x000000, alpha: 0.22 });
    const ring = new Graphics().circle(0, -6, 13).stroke({ width: 2, color: 0xe03131, alpha: 0.9 });
    ring.visible = false;
    container.addChild(shadow, ring, sprite);
    charLayer.addChild(container);
    return { container, sprite, ring, anim: 0, agentKey };
  }

  function syncChars(
    sim: SimState,
    styleOf: (taskId: number) => CharStyle | undefined,
    dtMs: number,
    theme: TownTheme,
  ) {
    for (const [id, v] of views) {
      if (!sim.chars.has(id)) {
        v.container.destroy({ children: true });
        views.delete(id);
      }
    }
    for (const [id, c] of sim.chars) {
      const style = styleOf(id);
      const agentKey = style?.agentKey ?? charKeyForAgent(c.agentName);
      let v = views.get(id);
      if (!v || v.agentKey !== agentKey) {
        if (v) {
          v.container.destroy({ children: true });
          views.delete(id);
        }
        v = makeView(agentKey);
        views.set(id, v);
      }
      const frames = (tex.chars[agentKey] ?? tex.chars.generic) as DirFrames;
      const seq = frames[c.facing];
      // Lingering at a leisure spot, or seated heads-down at a desk (both not
      // walking) → a gentle activity loop, not a frozen frame. Seated work reads
      // as typing: a slow frame cycle + a tiny bob.
      const dwelling = (c.spotId !== null || c.seated) && !c.moving;
      if (c.moving && !theme.reducedMotion) {
        v.anim += dtMs;
        v.sprite.texture = seq[Math.floor(v.anim / FRAME_MS) % seq.length];
        v.sprite.y = 0;
      } else if (dwelling && !theme.reducedMotion) {
        v.anim += dtMs;
        v.sprite.texture = seq[Math.floor(v.anim / (FRAME_MS * 2)) % seq.length];
        v.sprite.y = Math.sin(v.anim / 240) * -1.5; // small bob
      } else {
        v.anim = 0;
        v.sprite.texture = seq[0];
        v.sprite.y = 0;
      }
      v.container.x = c.pos.x * tilePx + tilePx / 2;
      v.container.y = c.pos.y * tilePx + tilePx;
      v.container.zIndex = c.pos.y;
      const st = style?.state;
      v.ring.visible = st === "blocked";
      if (c.intent === "off") {
        v.sprite.alpha = Math.max(0.1, v.sprite.alpha - dtMs / 1500);
      } else {
        v.sprite.alpha = st === "quiet" && style?.live === false ? 0.55 : 1;
      }
    }

    // Animate the plaza fountain's water shimmer (paused under reduced motion).
    if (fountainSprite && !theme.reducedMotion) {
      propAnim += dtMs;
      fountainSprite.texture = tex.fountain[Math.floor(propAnim / 380) % tex.fountain.length];
    }
  }

  return {
    renderWorld(w: TownWorld, theme: TownTheme) {
      renderWorld(w, theme);
    },
    syncChars,
    /** Apply the camera pan/zoom to the whole world (screen = (world - cam)*zoom). */
    setCamera(cam: Camera) {
      currentCam = cam;
      world.scale.set(cam.zoom);
      world.position.set(-cam.x * cam.zoom, -cam.y * cam.zoom);
    },
    /** Size the screen-space night overlay to the viewport (call on resize). */
    resize(vw: number, vh: number) {
      nightOverlay.clear();
      nightOverlay.rect(0, 0, vw, vh).fill(0xffffff);
    },
    /** Drive day/night: darken the whole viewport, and warm the windows of
     *  actively working offices (projected to screen with the current camera). */
    setAmbience(a: Ambience, isLive: (buildingIndex: number) => boolean) {
      nightOverlay.tint = a.tint;
      nightOverlay.alpha = a.darkness;
      for (const g of glows) {
        g.sprite.position.set(
          (g.wx * tilePx - currentCam.x) * currentCam.zoom,
          (g.wy * tilePx - currentCam.y) * currentCam.zoom,
        );
        g.sprite.scale.set(scale * currentCam.zoom);
        g.sprite.alpha = isLive(g.buildingIndex) ? 0.15 + 0.85 * a.glow : 0;
      }
      // Street lamps light with the cycle (not gated by any office being live).
      for (const l of lampGlows) {
        l.sprite.position.set(
          (l.gx - currentCam.x) * currentCam.zoom,
          (l.gy - currentCam.y) * currentCam.zoom,
        );
        l.sprite.scale.set(scale * currentCam.zoom * 1.4);
        l.sprite.alpha = a.glow;
      }
    },
    destroy() {
      world.destroy({ children: true });
      // glowLayer + nightOverlay are stage-level siblings of `world`, so they
      // aren't torn down by world.destroy — release them explicitly.
      glowLayer.destroy({ children: true });
      nightOverlay.destroy();
      views.clear();
      glows = [];
      lampGlows = [];
      fountainSprite = null;
    },
  };
}
