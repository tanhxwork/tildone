// The town's Pixi layer — a dumb renderer of the tiled world + the live sim.
//
// Two responsibilities, both pure rendering over inputs it is handed:
//   renderWorld(world) — tiles the ground and draws each building once per
//     world change / resize (buildings are few; never per frame).
//   syncChars(sim, …)  — every frame, reconciles one sprite view per live
//     character against SimState, moves it to its tile position, and advances
//     its 4-direction walk cycle from the sim's facing + moving flag.
//
// It owns no simulation and no timing beyond the walk-frame counter: TownView's
// ticker steps the sim and calls syncChars. Textures are passed in, so this file
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
  charLayer.sortableChildren = true;
  world.addChild(ground, buildings, charLayer);
  app.stage.addChild(world);

  const views = new Map<number, CharView>();

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

  function drawBuilding(place: TownWorld["buildings"][number], theme: TownTheme) {
    const g = new Container();
    const { tx, ty, tw, th } = place;
    const tint = roofTint(place);
    // Walls fill the footprint; the top row is the project-tinted shingle roof;
    // a window sits on the mid wall and the door on the bottom-centre.
    for (let ry = 0; ry < th; ry++) {
      for (let rx = 0; rx < tw; rx++) g.addChild(tile(tex.world.wall, tx + rx, ty + ry));
    }
    for (let rx = 0; rx < tw; rx++) {
      const roof = rx === 0 ? tex.world.roofL : rx === tw - 1 ? tex.world.roofR : tex.world.roofM;
      g.addChild(tile(roof, tx + rx, ty, tint));
    }
    g.addChild(tile(tex.world.window, tx + 1, ty + 1));
    if (tw >= 4) g.addChild(tile(tex.world.window, tx + tw - 2, ty + 1));
    g.addChild(tile(tex.world.door, tx + Math.floor(tw / 2), ty + th - 1));

    const label = new Text({
      text: place.room.name,
      style: titleStyle(place.room.characters.length ? theme.title : theme.inkMuted),
    });
    label.anchor.set(0.5, 1);
    label.position.set((tx + tw / 2) * tilePx, ty * tilePx - 3);
    g.addChild(label);

    buildings.addChild(g);
  }

  function renderWorld(w: TownWorld, theme: TownTheme) {
    // Destroy the detached display objects, not just detach them — otherwise
    // each resize / project-set change leaks their GPU resources until GC.
    ground.removeChildren().forEach((c) => c.destroy({ children: true }));
    buildings.removeChildren().forEach((c) => c.destroy({ children: true }));

    const isBuilding = new Set<string>();
    for (const b of w.buildings) {
      for (let ry = 0; ry < b.th; ry++) {
        for (let rx = 0; rx < b.tw; rx++) isBuilding.add(`${b.tx + rx},${b.ty + ry}`);
      }
    }
    const isSpot = new Set(w.spots.map((s) => `${s.tile.x},${s.tile.y}`));
    const isApron = new Set(w.buildings.map((b) => `${b.door.x},${b.door.y}`));

    // Grass ground with light per-tile variation (flowers/detail sprinkled in).
    for (let y = 0; y < w.rows; y++) {
      for (let x = 0; x < w.cols; x++) {
        const r = hash(x, y);
        const g = r < 0.06 ? tex.world.grass[2] : r < 0.18 ? tex.world.grass[1] : tex.world.grass[0];
        ground.addChild(tile(g, x, y));
      }
    }
    // A dirt threshold on each building's doorstep.
    for (const b of w.buildings) ground.addChild(tile(tex.world.dirt, b.door.x, b.door.y));

    for (const b of w.buildings) drawBuilding(b, theme);

    // Scatter decorations on free green tiles (below the character layer, which
    // always draws over them). Trees are anchored at their base so they stand a
    // little over the tile above.
    for (let y = 0; y < w.rows; y++) {
      for (let x = 0; x < w.cols; x++) {
        const key = `${x},${y}`;
        if (isBuilding.has(key) || isSpot.has(key) || isApron.has(key)) continue;
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

    // Shared leisure props (below the character layer).
    for (const s of w.spots) {
      const prop = new Sprite(tex.spots[s.kind]);
      prop.anchor.set(0.5, 0.9);
      prop.scale.set(scale);
      prop.position.set(s.tile.x * tilePx + tilePx / 2, s.tile.y * tilePx + tilePx);
      buildings.addChild(prop);
    }
  }

  function makeView(agentKey: string): CharView {
    const container = new Container();
    const frames = (tex.chars[agentKey] ?? tex.chars.generic) as DirFrames;
    const sprite = new Sprite(frames.down[0]);
    sprite.anchor.set(0.5, 0.9);
    sprite.scale.set(scale);
    const ring = new Graphics().circle(0, -6, 13).stroke({ width: 2, color: 0xe03131, alpha: 0.9 });
    ring.visible = false;
    container.addChild(ring, sprite);
    charLayer.addChild(container);
    return { container, sprite, ring, anim: 0, agentKey };
  }

  function syncChars(
    sim: SimState,
    styleOf: (taskId: number) => CharStyle | undefined,
    dtMs: number,
    theme: TownTheme,
  ) {
    // Remove views for characters the sim dropped.
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
      // Lingering at a leisure spot (claimed, not walking) → a gentle activity
      // loop, not a frozen frame (spec: "play a loop").
      const dwelling = c.spotId !== null && !c.moving;
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
        // Leaving: fade out as it walks off (it despawns at the world edge).
        v.sprite.alpha = Math.max(0.1, v.sprite.alpha - dtMs / 1500);
      } else {
        v.sprite.alpha = st === "quiet" && style?.live === false ? 0.55 : 1;
      }
    }
  }

  return {
    renderWorld(w: TownWorld, theme: TownTheme) {
      renderWorld(w, theme);
    },
    syncChars,
    destroy() {
      world.destroy({ children: true });
      views.clear();
    },
  };
}
