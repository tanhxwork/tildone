// Town textures for the living overworld.
//
// Sources, all Kenney and all CC0 (see assets/ + ASSETS.md):
//   - Ground, tinted roof and green decorations: Kenney "Tiny Town"
//     (assets/world/*.png), one texture per tile.
//   - House-interior furnishings: sliced from the Kenney "Roguelike Indoors"
//     sheet, plus a brick wall from "RPG Urban".
//   - Walking characters: sliced from the "RPG Urban" sheet — six 4-direction
//     walk cycles (3 frames each), assigned per agent identity.
// The one exception is the desktop computer: the roguelike packs are rustic and
// ship no monitor, so it is drawn in code (self-authored → CC0) to sit on the
// Kenney desk. Leisure-spot props are likewise procedural for now.
//
// The Kenney sheets are 16px tiles with a 1px gap, so a tile at grid (col,row)
// lives at pixel (col*17, row*17); `sub()` slices a sub-texture there. Swapping
// art is contained: repoint the grid coordinates below.

import { Rectangle, Texture, type TextureSource } from "pixi.js";
import type { SpotKind } from "./world";
import grass0Url from "./assets/world/grass0.png";
import grass1Url from "./assets/world/grass1.png";
import grass2Url from "./assets/world/grass2.png";
import roofLUrl from "./assets/world/roofL.png";
import roofMUrl from "./assets/world/roofM.png";
import roofRUrl from "./assets/world/roofR.png";
import treePineUrl from "./assets/world/tree_pine.png";
import treeOrangeUrl from "./assets/world/tree_orange.png";
import bushUrl from "./assets/world/bush.png";
import mushroomsUrl from "./assets/world/mushrooms.png";
import indoorsUrl from "./assets/kenney/roguelike-indoors.png";
import urbanUrl from "./assets/kenney/rpg-urban.png";

export type Dir = "down" | "up" | "left" | "right";

/** A character's walk frames per facing. Frame 0 is the standing pose; the
 *  renderer cycles all frames while the character is moving. */
export type DirFrames = Record<Dir, Texture[]>;

/** Kenney Tiny Town world tiles the renderer composes from. The house bodies
 *  are furnished cutaways from `InteriorTiles` (see drawBuilding), so only the
 *  ground, the tinted roof and the scattered green decorations come from here. */
export interface WorldTiles {
  /** Grass variants — [plain, detail, flowers] — for ground variation. */
  grass: Texture[];
  /** Grey shingle roof left/mid/right (tinted per project by the renderer). */
  roofL: Texture;
  roofM: Texture;
  roofR: Texture;
  /** Scatterable green decorations. */
  trees: Texture[];
  bush: Texture;
  mushrooms: Texture;
}

/** Kenney interior furnishings the renderer composes each house's cutaway room
 *  from: a desk (two halves) with a computer where the working character sits,
 *  plus homey props so it reads as a real house, not a shut exterior. */
export interface InteriorTiles {
  floor: Texture;
  wall: Texture;
  deskL: Texture;
  deskR: Texture;
  /** Self-authored monitor (the packs ship none) — seats on the desk. */
  computer: Texture;
  plant: Texture;
  rug: Texture;
  /** Framed wall art (left/right of the back wall). */
  artA: Texture;
  artB: Texture;
}

/** Self-authored (CC0) pavement + facade tiles the v3 town needs but the Kenney
 *  packs don't ship cleanly: road/plaza floor, and a door + lit-window glow. */
export interface PavementTiles {
  road: Texture;
  plaza: Texture;
}
export interface FacadeTiles {
  /** The doorway in a building's front wall. */
  door: Texture;
  /** A dark window on the facade (drawn always). */
  window: Texture;
  /** A warm additive glow laid over a window when the office has a live session. */
  windowGlow: Texture;
}

export interface TownTextures {
  world: WorldTiles;
  /** Walk-cycle atlas per agent key (see charKeyForAgent). */
  chars: Record<string, DirFrames>;
  /** Procedural CC0 leisure-spot props, by kind — frame arrays (the campfire and
   *  pond animate; bench and garden are single-frame). */
  spots: Record<SpotKind, Texture[]>;
  /** Kenney interior furnishings for the house cutaways. */
  interior: InteriorTiles;
  /** Self-authored roads/plaza pavement. */
  pavement: PavementTiles;
  /** Self-authored door + lit-window glow. */
  facade: FacadeTiles;
  /** Self-authored plaza fountain centrepiece — water-shimmer frames (cycled). */
  fountain: Texture[];
  /** Self-authored street lamp (lit by a warm glow at night). */
  lamp: Texture;
}

const FRAME = 16;
const STRIDE = 17; // 16px tile + 1px gap in the Kenney sheets

/** Slice a 16px sub-texture at grid (col,row) of a 1px-gap Kenney sheet. */
function sub(source: TextureSource, col: number, row: number): Texture {
  return new Texture({
    source,
    frame: new Rectangle(col * STRIDE, row * STRIDE, FRAME, FRAME),
  });
}

// --- Characters: RPG Urban ships six people stacked 3 rows (walk frames) each,
// with columns left/down/up/right = grid cols 23/24/25/26. Each agent identity
// maps to one person; the walk cycle bobs stand→stepA→stand→stepB. ---
const CHAR_DIR_COL: Record<Dir, number> = { left: 23, down: 24, up: 25, right: 26 };
const CHAR_INDEX: Record<string, number> = {
  claude: 0, // green shirt
  codex: 1, // red shirt
  cursor: 2, // grey-haired
  secretary: 5, // headband
  generic: 3, // hard hat
};

function sliceChar(source: TextureSource, personIndex: number): DirFrames {
  const base = personIndex * 3; // three walk-frame rows per person
  const out = {} as DirFrames;
  for (const d of ["down", "up", "left", "right"] as Dir[]) {
    const col = CHAR_DIR_COL[d];
    // stand → stepA → stand → stepB reads as a bob-walk when advanced.
    out[d] = [base, base + 1, base, base + 2].map((r) => sub(source, col, r));
  }
  return out;
}

/** Draw one 16×16 leisure prop. Procedural + self-authored → CC0; swaps out for
 *  real art the same way (a texture per kind). `frame` (0..2) animates the props
 *  that should move — the campfire flame flickers and the pond glint ripples;
 *  bench and garden ignore it (they get a single frame). */
function drawSpot(ctx: CanvasRenderingContext2D, kind: SpotKind, frame = 0) {
  ctx.clearRect(0, 0, FRAME, FRAME);
  ctx.fillStyle = "rgba(0,0,0,0.15)";
  ctx.beginPath();
  ctx.ellipse(8, 13, 5, 2, 0, 0, Math.PI * 2);
  ctx.fill();
  if (kind === "bench") {
    ctx.fillStyle = "#8a5a2b"; // seat + back planks
    ctx.fillRect(3, 8, 10, 2);
    ctx.fillRect(3, 6, 10, 1);
    ctx.fillStyle = "#5e3d1c"; // legs
    ctx.fillRect(4, 10, 1, 3);
    ctx.fillRect(11, 10, 1, 3);
  } else if (kind === "pond") {
    ctx.fillStyle = "#3f7fb0";
    ctx.beginPath();
    ctx.ellipse(8, 9, 6, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#8fc4e6"; // glint (ripples across the surface)
    const gx = [6, 8, 5][frame];
    const gy = [7, 8, 9][frame];
    ctx.fillRect(gx, gy, 2, 1);
    ctx.fillRect(gx + 3, gy - 1, 1, 1);
  } else if (kind === "campfire") {
    ctx.fillStyle = "#5e3d1c"; // logs
    ctx.fillRect(4, 11, 8, 2);
    ctx.fillStyle = "#e8791f"; // flame (height + sway flicker)
    const apexY = [4, 6, 3][frame];
    const lean = [0, 1, -1][frame];
    ctx.beginPath();
    ctx.moveTo(8 + lean, apexY);
    ctx.lineTo(11, 11);
    ctx.lineTo(5, 11);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#f6c33b"; // inner core
    ctx.fillRect(7 + lean, apexY + 4, 2, 11 - (apexY + 4));
  } else {
    // garden plot
    ctx.fillStyle = "#7a5230";
    ctx.fillRect(3, 8, 10, 5);
    ctx.fillStyle = "#4f9d4f"; // sprouts
    ctx.fillRect(5, 6, 1, 3);
    ctx.fillRect(8, 5, 1, 4);
    ctx.fillRect(11, 7, 1, 2);
  }
}

/** Desktop computer — a monitor with a glowing screen + keyboard. Self-authored
 *  (the roguelike packs ship no computer) so it stays CC0; sits on the desk. */
function drawComputer(x: CanvasRenderingContext2D) {
  x.clearRect(0, 0, FRAME, FRAME);
  x.fillStyle = "#2b2620"; // dark bezel
  x.fillRect(3, 1, 10, 8);
  x.fillStyle = "#3fb6c4"; // screen
  x.fillRect(4, 2, 8, 6);
  x.fillStyle = "#7fe0ea";
  x.fillRect(4, 2, 8, 1);
  x.fillStyle = "#1e6b73"; // code lines
  x.fillRect(5, 4, 5, 1);
  x.fillRect(5, 6, 3, 1);
  x.fillStyle = "#4a3f33"; // stand
  x.fillRect(7, 9, 2, 2);
  x.fillRect(5, 11, 6, 1);
}

/** Road / pavement tile — warm grey with a few darker pebbles (deterministic). */
function drawRoad(c: CanvasRenderingContext2D) {
  c.clearRect(0, 0, FRAME, FRAME);
  c.fillStyle = "#b6afa2";
  c.fillRect(0, 0, FRAME, FRAME);
  c.fillStyle = "#a49c8d";
  for (const [x, y] of [
    [2, 3],
    [11, 2],
    [6, 8],
    [13, 11],
    [4, 12],
  ]) {
    c.fillRect(x, y, 2, 2);
  }
  c.fillStyle = "rgba(0,0,0,0.05)";
  c.fillRect(0, 15, FRAME, 1);
}

/** Plaza floor — lighter paved stone with a subtle tile grid, so the commons
 *  reads as a square distinct from the roads that feed it. */
function drawPlaza(c: CanvasRenderingContext2D) {
  c.clearRect(0, 0, FRAME, FRAME);
  c.fillStyle = "#d2ccbe";
  c.fillRect(0, 0, FRAME, FRAME);
  c.strokeStyle = "#bdb5a4";
  c.lineWidth = 1;
  c.strokeRect(0.5, 0.5, FRAME - 1, FRAME - 1);
  c.fillStyle = "#c6bfb0";
  c.fillRect(8, 0, 1, FRAME);
  c.fillRect(0, 8, FRAME, 1);
}

/** A stone fountain — the plaza centrepiece idle characters gather around.
 *  Self-authored → CC0. A round basin of water with a central spout + spray.
 *  `frame` (0..2) shifts the spray height, highlight and droplets so the
 *  renderer can cycle a gentle water shimmer (see pixiScene animateProps). */
function drawFountain(c: CanvasRenderingContext2D, frame = 0) {
  c.clearRect(0, 0, FRAME, FRAME);
  const ell = (cx: number, cy: number, rx: number, ry: number, fill: string) => {
    c.fillStyle = fill;
    c.beginPath();
    c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    c.fill();
  };
  ell(8, 14, 6, 2, "rgba(0,0,0,0.18)"); // ground shadow
  ell(8, 11, 7, 4, "#9a948a"); // outer stone rim
  ell(8, 11, 6, 3.2, "#7f7a70"); // rim inner edge
  ell(8, 11, 5, 2.6, "#3f7fb0"); // water
  ell(8 + [-1, 0, 1][frame], 10.4, 3, 1.3, "#5fa0cf"); // water highlight (drifts)
  c.fillStyle = "#8f8980"; // centre column
  c.fillRect(7, 5, 2, 6);
  c.fillStyle = "#bfe0f2"; // spray (pulses)
  const sprayH = [4, 2, 3][frame];
  c.fillRect(7, 5 - sprayH, 2, sprayH);
  const drop = [5, 4, 6][frame]; // side droplets rise/fall
  c.fillRect(5, drop, 1, 2);
  c.fillRect(10, drop, 1, 2);
}

/** A street lamp post — lines the roads; its glass lights up at night (a warm
 *  glow is overlaid separately, like the office windows). Self-authored → CC0. */
function drawLamp(c: CanvasRenderingContext2D) {
  c.clearRect(0, 0, FRAME, FRAME);
  c.fillStyle = "rgba(0,0,0,0.16)"; // ground shadow
  c.beginPath();
  c.ellipse(8, 15, 3, 1.2, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#3b3a37"; // post
  c.fillRect(7, 6, 2, 9);
  c.fillStyle = "#2c2b28"; // base
  c.fillRect(6, 14, 4, 2);
  c.fillStyle = "#54524d"; // lamp housing
  c.fillRect(5, 2, 6, 5);
  c.fillStyle = "#ffe6a0"; // glass (lit)
  c.fillRect(6, 3, 4, 3);
  c.fillStyle = "#3f3e3a"; // cap
  c.fillRect(6, 1, 4, 1);
}

/** A wooden door filling the front-wall gap. */
function drawDoor(c: CanvasRenderingContext2D) {
  c.clearRect(0, 0, FRAME, FRAME);
  c.fillStyle = "#7d5a3a"; // frame
  c.fillRect(3, 2, 10, 14);
  c.fillStyle = "#9a6f45"; // door
  c.fillRect(4, 3, 8, 13);
  c.fillStyle = "#7d5a3a"; // panel line
  c.fillRect(8, 3, 1, 13);
  c.fillStyle = "#e8c24a"; // knob
  c.fillRect(6, 9, 1, 2);
}

/** A dark facade window (a lit glow is overlaid separately when the office is
 *  live — see FacadeTiles.windowGlow). */
function drawWindow(c: CanvasRenderingContext2D) {
  c.clearRect(0, 0, FRAME, FRAME);
  c.fillStyle = "#5a4632"; // frame
  c.fillRect(3, 4, 10, 8);
  c.fillStyle = "#2b3346"; // dark glass
  c.fillRect(4, 5, 8, 6);
  c.fillStyle = "#4a5468"; // muntins
  c.fillRect(7, 5, 1, 6);
  c.fillRect(4, 7, 8, 1);
}

/** Warm window glow — a soft rounded rectangle, drawn additively over a window
 *  when the office has a live session (alpha scaled by night + liveness). */
function drawWindowGlow(c: CanvasRenderingContext2D) {
  c.clearRect(0, 0, FRAME, FRAME);
  const g = c.createRadialGradient(8, 8, 1, 8, 8, 7);
  g.addColorStop(0, "rgba(255,214,130,0.95)");
  g.addColorStop(1, "rgba(255,190,90,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, FRAME, FRAME);
  c.fillStyle = "rgba(255,236,180,0.9)";
  c.fillRect(4, 5, 8, 6);
}

function canvasTexture(draw: (ctx: CanvasRenderingContext2D) => void): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = FRAME;
  canvas.height = FRAME;
  draw(canvas.getContext("2d")!);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = "nearest";
  return tex;
}

/**
 * Load a bundled PNG into a Texture via an <img> drawn onto a canvas, rather
 * than Pixi's `Assets.load`. Under Tauri the app is served from the
 * `tauri://localhost` custom protocol, where Pixi's asset fetch/ImageBitmap
 * path rejects (`_loadAssetWithRetry`) and the whole town canvas silently falls
 * back to "overlay only" — the town never rendered in the app until this. An
 * `<img>` element loads `tauri://` URLs fine (it is how every other image in
 * the app loads), and `Texture.from(canvas)` is the same source path the
 * procedural textures already use, so it works in the WKWebView.
 */
function loadImageTexture(url: string): Promise<Texture> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")!.drawImage(img, 0, 0);
      const tex = Texture.from(canvas);
      tex.source.scaleMode = "nearest";
      resolve(tex);
    };
    img.onerror = () => reject(new Error(`town: failed to load ${url}`));
    img.src = url;
  });
}

let cache: TownTextures | null = null;

export async function loadTownTextures(): Promise<TownTextures> {
  if (cache) return cache;
  const urls: Record<string, string> = {
    grass0: grass0Url,
    grass1: grass1Url,
    grass2: grass2Url,
    roofL: roofLUrl,
    roofM: roofMUrl,
    roofR: roofRUrl,
    treePine: treePineUrl,
    treeOrange: treeOrangeUrl,
    bush: bushUrl,
    mushrooms: mushroomsUrl,
    indoors: indoorsUrl,
    urban: urbanUrl,
  };
  const loaded: Record<string, Texture> = {};
  await Promise.all(
    Object.entries(urls).map(async ([k, url]) => {
      loaded[k] = await loadImageTexture(url);
    }),
  );
  const indoors = loaded.indoors.source;
  const urban = loaded.urban.source;

  const chars: Record<string, DirFrames> = {};
  for (const [key, idx] of Object.entries(CHAR_INDEX)) {
    chars[key] = sliceChar(urban, idx);
  }

  cache = {
    world: {
      grass: [loaded.grass0, loaded.grass1, loaded.grass2],
      roofL: loaded.roofL,
      roofM: loaded.roofM,
      roofR: loaded.roofR,
      trees: [loaded.treePine, loaded.treeOrange],
      bush: loaded.bush,
      mushrooms: loaded.mushrooms,
    },
    chars,
    spots: {
      bench: [canvasTexture((c) => drawSpot(c, "bench"))],
      pond: [0, 1, 2].map((f) => canvasTexture((c) => drawSpot(c, "pond", f))),
      campfire: [0, 1, 2].map((f) => canvasTexture((c) => drawSpot(c, "campfire", f))),
      garden: [canvasTexture((c) => drawSpot(c, "garden"))],
    },
    interior: {
      floor: sub(indoors, 24, 0), // wood plank floor
      wall: sub(urban, 18, 4), // tan brick wall
      deskL: sub(indoors, 0, 0), // table, left half
      deskR: sub(indoors, 1, 0), // table, right half
      computer: canvasTexture(drawComputer),
      plant: sub(indoors, 16, 0), // potted plant
      rug: sub(indoors, 5, 9), // bordered rug
      artA: sub(indoors, 20, 12), // framed landscape (cream)
      artB: sub(indoors, 19, 12), // framed landscape (green)
    },
    pavement: {
      road: canvasTexture(drawRoad),
      plaza: canvasTexture(drawPlaza),
    },
    facade: {
      door: canvasTexture(drawDoor),
      window: canvasTexture(drawWindow),
      windowGlow: canvasTexture(drawWindowGlow),
    },
    fountain: [0, 1, 2].map((f) => canvasTexture((c) => drawFountain(c, f))),
    lamp: canvasTexture(drawLamp),
  };
  return cache;
}
