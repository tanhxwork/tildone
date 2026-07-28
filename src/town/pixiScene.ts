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
  TilingSprite,
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

  function drawBuilding(place: TownWorld["buildings"][number], theme: TownTheme) {
    const g = new Container();
    const x = place.tx * tilePx;
    const y = place.ty * tilePx;
    const w = place.tw * tilePx;
    const h = place.th * tilePx;

    // Wall body.
    g.addChild(new Graphics().roundRect(x, y, w, h, 4).fill(theme.wall));
    // Roof band tinted by the project colour (falls back to theme roof).
    const tint =
      place.room.color && /^#[0-9a-f]{6}$/i.test(place.room.color)
        ? parseInt(place.room.color.slice(1), 16)
        : theme.roof;
    g.addChild(new Graphics().roundRect(x, y, w, tilePx, 4).fill(tint));
    // A desk against the front wall — where the working character sits — with
    // the door beside it. The working character stands on the door tile just
    // below, facing up into the desk, so "home" reads as "at the desk".
    const desk = new Sprite(tex.desk);
    desk.anchor.set(0.5, 1);
    desk.scale.set(scale);
    desk.position.set(x + w / 2, y + h - 2);
    const door = new Sprite(tex.door);
    door.anchor.set(0.5, 1);
    door.scale.set(scale);
    door.position.set(x + w - scale * 5, y + h);
    g.addChild(desk, door);

    // Project label above the roof.
    const label = new Text({
      text: place.room.name,
      style: titleStyle(place.room.characters.length ? theme.title : theme.inkMuted),
    });
    label.anchor.set(0.5, 1);
    label.position.set(x + w / 2, y - 3);
    g.addChild(label);

    buildings.addChild(g);
  }

  function renderWorld(w: TownWorld, theme: TownTheme) {
    // Destroy the detached display objects, not just detach them — otherwise
    // each resize / project-set change leaks their GPU resources until GC.
    ground.removeChildren().forEach((c) => c.destroy({ children: true }));
    buildings.removeChildren().forEach((c) => c.destroy({ children: true }));
    const gw = w.cols * tilePx;
    const gh = w.rows * tilePx;
    // Base green wash, then the tiled floor texture over it.
    ground.addChild(new Graphics().rect(0, 0, gw, gh).fill(theme.ground));
    const tile = new TilingSprite({ texture: tex.ground, width: gw, height: gh });
    tile.tileScale.set(tilePx / tex.ground.width);
    tile.alpha = 0.5;
    ground.addChild(tile);
    for (const b of w.buildings) drawBuilding(b, theme);
    // Shared leisure props dotted across the green (below the character layer).
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
