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
  const cloudLayer = new Container();
  const buildings = new Container();
  const charLayer = new Container();
  const glowLayer = new Container();
  const nightOverlay = new Graphics();
  nightOverlay.alpha = 0;
  charLayer.sortableChildren = true;
  // Cloud shadows sit above the ground but below buildings/characters, so they
  // sweep over the terrain without muddying the sprites on top of it.
  world.addChild(ground, cloudLayer, buildings, charLayer);
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
  /** Leisure-spot sprites with more than one frame (campfire, pond) — cycled. */
  let animatedSpots: { sprite: Sprite; frames: Texture[] }[] = [];
  /** Cloud shadows drifting across the terrain (world-px positions + speeds). */
  let clouds: { sprite: Sprite; speed: number }[] = [];
  /** World width in px — the wrap point for drifting clouds. */
  let worldPxW = 0;
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

  /** Scale a packed RGB tint toward black — used to shade the lower roof rows so
   *  a multi-row roof reads as a slope rather than a flat rectangle. */
  function darken(rgb: number, k: number): number {
    const r = Math.round(((rgb >> 16) & 0xff) * k);
    const g = Math.round(((rgb >> 8) & 0xff) * k);
    const b = Math.round((rgb & 0xff) * k);
    return (r << 16) | (g << 8) | b;
  }

  function roofTint(place: TownWorld["buildings"][number]): number {
    return place.room.color && /^#[0-9a-f]{6}$/i.test(place.room.color)
      ? parseInt(place.room.color.slice(1), 16)
      : 0xcc5b3a;
  }

  function drawBuilding(place: TownWorld["buildings"][number]) {
    const g = new Container();
    const { tx, ty, tw, th, interior, frontWallY } = place;
    const tint = roofTint(place);
    const int = tex.interior;
    // A house: a wall ring around an open floor, entered through one door in the
    // facade (the bottom row, which stays visible when the roof lifts). Draw
    // order matters and is the thing the old renderer got wrong — floor first
    // across the *whole* interior, then walls as a frame, then furniture. Painting
    // wall texture everywhere and floor only under the seats is what made a house
    // read as a solid block with a one-tile corridor in it.
    for (let y = interior.y; y < interior.y + interior.h; y++) {
      for (let x = interior.x; x < interior.x + interior.w; x++) {
        g.addChild(tile(int.floor, x, y));
      }
    }
    for (let dy = 0; dy < th; dy++) {
      for (let dx = 0; dx < tw; dx++) {
        const onRing = dx === 0 || dx === tw - 1 || dy === 0 || dy === th - 1;
        if (onRing) g.addChild(tile(int.wall, tx + dx, ty + dy));
      }
    }
    for (const p of place.partitions) g.addChild(tile(int.wall, p.x, p.y));

    // Framed art on the back wall — the Sims' "room score" insight in miniature:
    // bare walls read as unfinished, and these were already sliced but never drawn.
    if (tw >= 6) {
      g.addChild(tile(int.artA, tx + 2, ty));
      g.addChild(tile(int.artB, tx + tw - 3, ty));
    }

    // Furniture. Everything but the rug is bottom-anchored so it overlaps the
    // tile above and the room gains a little depth.
    for (const f of place.furniture) {
      if (f.kind === "rug") {
        g.addChild(tile(tex.furniture.rug, f.tile.x, f.tile.y));
        continue;
      }
      if (f.kind === "desk") continue; // drawn below, with its monitor
      const s = new Sprite(tex.furniture[f.kind]);
      s.anchor.set(0.5, 0.9);
      s.scale.set(scale);
      s.position.set(f.tile.x * tilePx + tilePx / 2, f.tile.y * tilePx + tilePx);
      g.addChild(s);
    }

    // The desk counter, with a monitor lifted onto each workstation.
    place.desks.forEach((d, i) => {
      g.addChild(tile(i % 2 === 0 ? int.deskL : int.deskR, d.x, d.y));
      const comp = tile(int.computer, d.x, d.y);
      comp.y -= 5 * scale;
      g.addChild(comp);
    });

    // Facade: the door, with a window either side of it.
    const winCols = [tx + 1, tx + tw - 2];
    for (const wx of winCols) g.addChild(tile(tex.facade.window, wx, frontWallY));
    g.addChild(tile(tex.facade.door, place.door.x, frontWallY));

    // The roof, as a liftable lid over everything above the facade. A house you
    // can never see into is just a box; fading the roof out while anyone is home
    // is what turns the floor plan into something the viewer actually sees — and
    // leaves the closed house reading as a house the rest of the time.
    const roof = new Container();
    for (let ry = ty; ry < frontWallY; ry++) {
      const shade = ry === ty ? tint : darken(tint, 0.86);
      for (let rx = 0; rx < tw; rx++) {
        const t = rx === 0 ? tex.world.roofL : rx === tw - 1 ? tex.world.roofR : tex.world.roofM;
        roof.addChild(tile(t, tx + rx, ry, shade));
      }
    }
    roof.alpha = place.room.characters.length > 0 ? 0.12 : 1;
    g.addChild(roof);

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
      return { wx, wy: frontWallY, sprite };
    });
  }

  function renderWorld(w: TownWorld, _theme: TownTheme) {
    // Destroy detached display objects (not just detach) so resizes don't leak GPU.
    ground.removeChildren().forEach((c) => c.destroy({ children: true }));
    cloudLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    buildings.removeChildren().forEach((c) => c.destroy({ children: true }));
    glowLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    glows = [];
    lampGlows = [];
    fountainSprite = null;
    animatedSpots = [];
    clouds = [];

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
        const i = y * w.cols + x;
        if (inPlaza(x, y)) ground.addChild(tile(tex.pavement.plaza, x, y));
        else if (w.road[i]) ground.addChild(tile(tex.pavement.road, x, y));
        else if (w.path[i]) ground.addChild(tile(tex.pavement.path, x, y));
        else if (w.yard[i]) ground.addChild(tile(tex.pavement.yard, x, y));
      }
    }

    w.buildings.forEach((b, i) => {
      const winGlows = drawBuilding(b);
      for (const g of winGlows) glows.push({ buildingIndex: i, ...g });
    });

    // Fences ringing each lot.
    const isFence = new Set(w.fences.map((f) => `${f.x},${f.y}`));
    for (const f of w.fences) {
      const s = new Sprite(tex.fence);
      s.anchor.set(0.5, 0.9);
      s.scale.set(scale);
      s.position.set(f.x * tilePx + tilePx / 2, f.y * tilePx + tilePx);
      buildings.addChild(s);
    }

    // Scatter decorations on free wild green. Two rules the old uniform per-tile
    // roll broke: vegetation *clumps* (a coarse grove mask decides whether a
    // patch is woodland at all, so trees arrive in groves rather than as evenly
    // spread confetti — uniform noise is the visual signature of "generated"),
    // and built space is *cleared* — nothing grows on a lot, on a path, or right
    // up against a street, because managed ground is what reads as inhabited.
    const built = (x: number, y: number) =>
      isBuilding.has(`${x},${y}`) || isFence.has(`${x},${y}`);
    const grove = (x: number, y: number) =>
      hash(Math.floor(x / 6) * 31 + 7, Math.floor(y / 6) * 17 + 3) < 0.34;
    for (let y = 0; y < w.rows; y++) {
      for (let x = 0; x < w.cols; x++) {
        const key = `${x},${y}`;
        const i = y * w.cols + x;
        if (isBuilding.has(key) || isSpot.has(key) || isLamp.has(key)) continue;
        if (isFence.has(key) || w.road[i] || w.path[i] || w.yard[i]) continue;
        // Cleared ring: never crowd a street, a lot fence or a wall.
        let crowds = false;
        for (let dy = -1; dy <= 1 && !crowds; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w.cols || ny >= w.rows) continue;
            if (built(nx, ny) || w.road[ny * w.cols + nx]) {
              crowds = true;
              break;
            }
          }
        }
        if (crowds) continue;
        const r = hash(x * 7 + 1, y * 13 + 5);
        let dec: Texture | null = null;
        let tall = false;
        if (grove(x, y)) {
          if (r < 0.42) {
            dec = tex.world.trees[x % tex.world.trees.length];
            tall = true;
          } else if (r < 0.62) {
            dec = tex.world.bush;
          } else if (r < 0.68) {
            dec = tex.world.mushrooms;
          }
        } else if (r < 0.03) {
          dec = tex.world.trees[x % tex.world.trees.length];
          tall = true;
        } else if (r < 0.06) {
          dec = tex.world.bush;
        } else if (r < 0.075) {
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

    // Blocked commons furnishings — planters, notice board, market stall, coffee
    // cart, cafe table. Bottom-anchored like the other props so they sit on their
    // tile and overlap the one above, which is what gives the square depth.
    for (const p of w.props) {
      const sprite = new Sprite(tex.props[p.kind]);
      sprite.anchor.set(0.5, 0.9);
      sprite.scale.set(scale);
      sprite.position.set(p.tile.x * tilePx + tilePx / 2, p.tile.y * tilePx + tilePx);
      buildings.addChild(sprite);
    }

    // Shared leisure props in the plaza (below the character layer). The
    // campfire + pond carry multiple frames and are cycled (see syncChars tail).
    for (const s of w.spots) {
      const frames = tex.spots[s.kind];
      const prop = new Sprite(frames[0]);
      prop.anchor.set(0.5, 0.9);
      prop.scale.set(scale);
      prop.position.set(s.tile.x * tilePx + tilePx / 2, s.tile.y * tilePx + tilePx);
      buildings.addChild(prop);
      if (frames.length > 1) animatedSpots.push({ sprite: prop, frames });
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

    // Drifting cloud shadows, scaled in number to the world size. Deterministic
    // scatter; drift + wrap happen per frame (see the syncChars tail).
    worldPxW = w.cols * tilePx;
    const worldPxH = w.rows * tilePx;
    const cloudCount = Math.max(3, Math.round((w.cols * w.rows) / 260));
    for (let i = 0; i < cloudCount; i++) {
      const cloud = new Sprite(tex.cloud);
      cloud.anchor.set(0.5, 0.5);
      cloud.scale.set(6 + hash(i * 31 + 3, 7) * 6); // 6..12× → big, soft blobs
      cloud.alpha = 0.5;
      cloud.position.set(hash(i, 11) * worldPxW, hash(i * 17 + 5, 23) * worldPxH);
      cloudLayer.addChild(cloud);
      clouds.push({ sprite: cloud, speed: 0.004 + hash(i * 13 + 1, 41) * 0.006 });
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

    // Animate the plaza props — fountain shimmer, campfire flicker, pond ripple
    // — off one shared clock (paused under reduced motion).
    if (!theme.reducedMotion) {
      propAnim += dtMs;
      if (fountainSprite) {
        fountainSprite.texture = tex.fountain[Math.floor(propAnim / 380) % tex.fountain.length];
      }
      for (const a of animatedSpots) {
        a.sprite.texture = a.frames[Math.floor(propAnim / 300) % a.frames.length];
      }
      // Drift cloud shadows on the wind, wrapping back once fully off the east edge.
      for (const cl of clouds) {
        cl.sprite.x += cl.speed * dtMs;
        const halfW = cl.sprite.width / 2;
        if (cl.sprite.x - halfW > worldPxW) cl.sprite.x = -halfW;
      }
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
      animatedSpots = [];
      clouds = [];
    },
  };
}
