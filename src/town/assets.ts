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
import type { FurnitureKind, PropKind, SpotKind } from "./world";

/** The furniture kinds drawn procedurally here. `desk`, `rug` and `plant` come
 *  from the Kenney interior sheet instead. */
type HomeFurnitureKind = Exclude<FurnitureKind, "desk" | "rug" | "plant">;
import grass0Url from "./assets/world/grass0.png";
import grass1Url from "./assets/world/grass1.png";
import grass2Url from "./assets/world/grass2.png";
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
  /** Shingle roof surface, tinted per project by the renderer: the ridge course,
   *  the body repeated down the slope, and the overhanging eave. */
  roof: { ridge: Texture; body: Texture; eave: Texture };
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
  /** Mown lot grass inside a fence. */
  yard: Texture;
  /** Worn path from a front door to its gate. */
  path: Texture;
}
export interface FacadeTiles {
  /** The doorway in a building's front wall. */
  door: Texture;
  /** A dark window on the facade (drawn always). */
  window: Texture;
  /** A warm additive glow laid over a window when the office has a live session. */
  windowGlow: Texture;
}

/** Self-authored (CC0) blocked furnishings for the commons — see drawProp. */
export type PropTiles = Record<PropKind, Texture>;

export interface TownTextures {
  world: WorldTiles;
  /** Walk-cycle atlas per agent key (see charKeyForAgent). */
  chars: Record<string, DirFrames>;
  /** Procedural CC0 leisure-spot props, by kind — frame arrays (the campfire and
   *  pond animate; bench and garden are single-frame). */
  spots: Record<SpotKind, Texture[]>;
  /** Kenney interior furnishings for the house cutaways. */
  interior: InteriorTiles;
  /** Self-authored blocked furnishings for the commons. */
  props: PropTiles;
  /** One texture per interior furniture kind (Kenney desk/rug/plant, the rest
   *  self-authored — see drawFurniture). */
  furniture: Record<FurnitureKind, Texture>;
  /** Picket fence ringing a lot. */
  fence: Texture;
  /** Self-authored roads/plaza pavement. */
  pavement: PavementTiles;
  /** Self-authored door + lit-window glow. */
  facade: FacadeTiles;
  /** Self-authored plaza fountain centrepiece — water-shimmer frames (cycled). */
  fountain: Texture[];
  /** Self-authored street lamp (lit by a warm glow at night). */
  lamp: Texture;
  /** Self-authored soft cloud shadow that drifts across the terrain. */
  cloud: Texture;
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

/** Draw one 16×16 commons furnishing. Self-authored → CC0, in the same idiom as
 *  the leisure props: a soft ground shadow, then a small silhouette that reads at
 *  16px. These are the blocked props that make the square look used — somewhere
 *  to stand at, queue at, or read — rather than an empty paved rectangle. */
function drawProp(c: CanvasRenderingContext2D, kind: PropKind) {
  c.clearRect(0, 0, FRAME, FRAME);
  c.fillStyle = "rgba(0,0,0,0.15)";
  c.beginPath();
  c.ellipse(8, 14, 5, 2, 0, 0, Math.PI * 2);
  c.fill();
  if (kind === "planter") {
    c.fillStyle = "#3f7a3a"; // shrub
    c.beginPath();
    c.ellipse(8, 6, 5, 4, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#4f9d4f"; // lit side
    c.beginPath();
    c.ellipse(6.5, 5, 3, 2.2, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#9a948a"; // stone tub
    c.fillRect(4, 10, 8, 4);
    c.fillStyle = "#b3ada2";
    c.fillRect(4, 10, 8, 1);
  } else if (kind === "noticeboard") {
    c.fillStyle = "#5e3d1c"; // posts
    c.fillRect(4, 9, 1, 5);
    c.fillRect(11, 9, 1, 5);
    c.fillStyle = "#7d5a3a"; // frame
    c.fillRect(2, 2, 12, 8);
    c.fillStyle = "#d9cdb4"; // cork
    c.fillRect(3, 3, 10, 6);
    c.fillStyle = "#f5f2ea"; // pinned notices
    c.fillRect(4, 4, 3, 4);
    c.fillRect(8, 4, 4, 2);
    c.fillStyle = "#cbb894";
    c.fillRect(8, 7, 4, 1);
  } else if (kind === "market") {
    c.fillStyle = "#8a5a2b"; // trestle
    c.fillRect(2, 9, 12, 2);
    c.fillRect(3, 11, 1, 3);
    c.fillRect(12, 11, 1, 3);
    c.fillStyle = "#c9552f"; // awning, striped
    c.fillRect(1, 3, 14, 4);
    c.fillStyle = "#f0e6d2";
    for (const sx of [3, 7, 11]) c.fillRect(sx, 3, 2, 4);
    c.fillStyle = "#6b4a24"; // posts
    c.fillRect(2, 7, 1, 2);
    c.fillRect(13, 7, 1, 2);
    c.fillStyle = "#4f9d4f"; // produce on the trestle
    c.fillRect(4, 7, 2, 2);
    c.fillStyle = "#e8a33b";
    c.fillRect(8, 7, 2, 2);
  } else if (kind === "coffeecart") {
    c.fillStyle = "#7d5a3a"; // cart body
    c.fillRect(3, 7, 10, 6);
    c.fillStyle = "#9a6f45";
    c.fillRect(3, 7, 10, 1);
    c.fillStyle = "#3b3a37"; // wheel
    c.beginPath();
    c.arc(6, 13, 2, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#8f8980"; // urn
    c.fillRect(6, 2, 5, 5);
    c.fillStyle = "#b3ada2";
    c.fillRect(6, 2, 5, 1);
    c.fillStyle = "#2b2620"; // tap
    c.fillRect(11, 5, 1, 1);
    c.fillStyle = "#f5f2ea"; // steam
    c.fillRect(8, 0, 1, 2);
  } else {
    // cafe table — a round bistro top with a small vase
    c.fillStyle = "#5e3d1c"; // pedestal + foot
    c.fillRect(7, 9, 2, 4);
    c.fillRect(5, 13, 6, 1);
    c.fillStyle = "#d9cdb4"; // table top
    c.beginPath();
    c.ellipse(8, 8, 6, 3, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#c2b699"; // rim shadow
    c.beginPath();
    c.ellipse(8, 9, 6, 2.4, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#3f7fb0"; // vase
    c.fillRect(7, 4, 2, 4);
    c.fillStyle = "#e05a7a"; // bloom
    c.fillRect(7, 2, 2, 2);
  }
}

/** Draw one 16×16 piece of home furniture, top-down. Self-authored → CC0: the
 *  Kenney roguelike pack is rustic and ships no coherent modern set, and the
 *  house plans need a consistent one (a bed that matches the sofa that matches
 *  the counter). Everything is drawn flat-on from above with a single light
 *  direction so a room reads at a glance. */
function drawFurniture(c: CanvasRenderingContext2D, kind: HomeFurnitureKind) {
  c.clearRect(0, 0, FRAME, FRAME);
  const wood = "#8a5a2b";
  const woodDark = "#5e3d1c";
  const linen = "#e6dcc6";
  if (kind === "counter") {
    c.fillStyle = woodDark; // carcass
    c.fillRect(0, 3, FRAME, 12);
    c.fillStyle = "#b3ada2"; // worktop
    c.fillRect(0, 2, FRAME, 5);
    c.fillStyle = "#c9c3b8"; // top highlight
    c.fillRect(0, 2, FRAME, 1);
    c.fillStyle = "#6f4a24"; // door seams
    c.fillRect(5, 8, 1, 6);
    c.fillRect(11, 8, 1, 6);
    c.fillStyle = "#d8d2c6"; // handles
    c.fillRect(3, 10, 2, 1);
    c.fillRect(8, 10, 2, 1);
  } else if (kind === "sink") {
    c.fillStyle = woodDark;
    c.fillRect(0, 3, FRAME, 12);
    c.fillStyle = "#b3ada2";
    c.fillRect(0, 2, FRAME, 5);
    c.fillStyle = "#8f9aa3"; // basin
    c.fillRect(3, 5, 10, 7);
    c.fillStyle = "#c3ced6";
    c.fillRect(4, 6, 8, 5);
    c.fillStyle = "#6f7a82"; // tap
    c.fillRect(7, 3, 2, 3);
    c.fillRect(9, 3, 2, 1);
  } else if (kind === "table") {
    c.fillStyle = woodDark; // legs
    c.fillRect(2, 12, 2, 3);
    c.fillRect(12, 12, 2, 3);
    c.fillStyle = wood; // top
    c.fillRect(1, 3, 14, 10);
    c.fillStyle = "#9c6a35"; // grain highlight
    c.fillRect(2, 4, 12, 3);
    c.fillStyle = linen; // a set place
    c.fillRect(4, 8, 3, 3);
    c.fillRect(9, 8, 3, 3);
  } else if (kind === "chair") {
    c.fillStyle = woodDark; // back rail (chair faces the table above)
    c.fillRect(4, 10, 8, 2);
    c.fillStyle = wood; // seat
    c.fillRect(4, 5, 8, 6);
    c.fillStyle = "#9c6a35";
    c.fillRect(5, 6, 6, 3);
    c.fillStyle = woodDark; // legs
    c.fillRect(4, 12, 1, 2);
    c.fillRect(11, 12, 1, 2);
  } else if (kind === "sofa") {
    c.fillStyle = "#3f6f7a"; // back
    c.fillRect(0, 2, FRAME, 5);
    c.fillStyle = "#4d838f"; // seat cushions
    c.fillRect(0, 6, FRAME, 8);
    c.fillStyle = "#5c98a5"; // cushion highlight
    c.fillRect(1, 7, 6, 5);
    c.fillRect(9, 7, 6, 5);
    c.fillStyle = "#345c66"; // seam + skirt
    c.fillRect(7, 6, 2, 8);
    c.fillRect(0, 14, FRAME, 1);
  } else if (kind === "bookshelf") {
    c.fillStyle = woodDark; // case
    c.fillRect(1, 1, 14, 14);
    c.fillStyle = "#4a3218"; // interior
    c.fillRect(2, 2, 12, 12);
    const books: [number, number, string][] = [
      [3, 3, "#b03a2e"],
      [5, 3, "#2e6b8f"],
      [7, 3, "#c9902e"],
      [10, 3, "#4f8f4f"],
      [3, 9, "#7a4f9c"],
      [6, 9, "#b03a2e"],
      [9, 9, "#2e6b8f"],
    ];
    for (const [bx, by, col] of books) {
      c.fillStyle = col;
      c.fillRect(bx, by, 2, 4);
    }
    c.fillStyle = wood; // shelf edges
    c.fillRect(2, 7, 12, 1);
    c.fillRect(2, 13, 12, 1);
  } else if (kind === "bed") {
    c.fillStyle = woodDark; // frame
    c.fillRect(1, 1, 14, 14);
    c.fillStyle = linen; // mattress
    c.fillRect(2, 2, 12, 12);
    c.fillStyle = "#c8bda3"; // pillow shadow
    c.fillRect(2, 2, 12, 5);
    c.fillStyle = "#f7f2e6"; // pillow
    c.fillRect(3, 3, 10, 3);
    c.fillStyle = "#7a9ec4"; // turned-down blanket
    c.fillRect(2, 8, 12, 6);
    c.fillStyle = "#93b3d4";
    c.fillRect(2, 8, 12, 1);
  } else {
    // nightstand — a small cabinet with a lamp
    c.fillStyle = woodDark;
    c.fillRect(3, 6, 10, 9);
    c.fillStyle = wood;
    c.fillRect(3, 5, 10, 3);
    c.fillStyle = "#d8d2c6"; // drawer handle
    c.fillRect(7, 10, 2, 1);
    c.fillStyle = "#6f5a3a"; // lamp stem
    c.fillRect(7, 2, 2, 4);
    c.fillStyle = "#ffe6a0"; // shade
    c.fillRect(5, 0, 6, 3);
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

/** Mown lot grass — lighter than the wild green, with faint mower stripes. The
 *  contrast is the whole point: managed ground is what reads as "someone lives
 *  here" rather than "a house was dropped on a field". */
function drawYard(c: CanvasRenderingContext2D) {
  c.clearRect(0, 0, FRAME, FRAME);
  c.fillStyle = "#87b356";
  c.fillRect(0, 0, FRAME, FRAME);
  c.fillStyle = "#7fa950";
  for (let y = 0; y < FRAME; y += 4) c.fillRect(0, y, FRAME, 2);
  c.fillStyle = "#93bd61";
  c.fillRect(0, 0, FRAME, 1);
}

/** A worn path — trodden earth with scattered grit. */
function drawPath(c: CanvasRenderingContext2D) {
  c.clearRect(0, 0, FRAME, FRAME);
  c.fillStyle = "#c2a878";
  c.fillRect(0, 0, FRAME, FRAME);
  c.fillStyle = "#b39a6b";
  for (const [x, y] of [
    [3, 2],
    [10, 5],
    [6, 9],
    [12, 12],
    [2, 13],
  ]) {
    c.fillRect(x, y, 2, 2);
  }
  c.fillStyle = "#a88f61";
  c.fillRect(0, 0, 1, FRAME);
  c.fillRect(15, 0, 1, FRAME);
}

/** A picket fence segment, bottom-anchored like the other props. The gaps
 *  between pickets are transparent so the ground shows through — a solid
 *  16×16 block of pickets reads as masonry, not as a fence. */
function drawFence(c: CanvasRenderingContext2D) {
  c.clearRect(0, 0, FRAME, FRAME);
  c.fillStyle = "rgba(0,0,0,0.12)"; // ground shadow
  c.fillRect(1, 14, 14, 1);
  c.fillStyle = "#b99a6d"; // rails behind the pickets
  c.fillRect(0, 7, FRAME, 1);
  c.fillRect(0, 11, FRAME, 1);
  for (const px of [1, 6, 11]) {
    c.fillStyle = "#eadfc6"; // picket
    c.fillRect(px, 3, 2, 11);
    c.fillRect(px, 2, 2, 1); // pointed cap
    c.fillStyle = "#c8b993"; // shaded edge
    c.fillRect(px + 1, 3, 1, 11);
  }
}

/**
 * Roof surface, tinted per project. Three parts because a roof drawn as one
 * ridge tile repeated down every row reads as a stack of separate bars rather
 * than a single sloped surface — which is exactly how the multi-row roofs of the
 * bigger houses looked. Light grey so the project tint multiplies cleanly.
 */
function drawRoof(c: CanvasRenderingContext2D, part: "ridge" | "body" | "eave") {
  c.clearRect(0, 0, FRAME, FRAME);
  c.fillStyle = "#cfc9be";
  c.fillRect(0, 0, FRAME, FRAME);
  // Staggered shingle courses.
  c.fillStyle = "#b0a99e";
  for (let y = 3, course = 0; y < FRAME; y += 5, course++) {
    c.fillRect(0, y, FRAME, 1);
    const off = course % 2 ? 2 : 0;
    for (let x = off; x < FRAME; x += 4) c.fillRect(x, y - 3, 1, 3);
  }
  if (part === "ridge") {
    c.fillStyle = "#e6e0d5"; // capping, catching the light
    c.fillRect(0, 0, FRAME, 2);
    c.fillStyle = "#8f887c";
    c.fillRect(0, 2, FRAME, 1);
  } else if (part === "eave") {
    c.fillStyle = "#8f887c"; // the roof edge, overhanging
    c.fillRect(0, 13, FRAME, 3);
    c.fillStyle = "rgba(0,0,0,0.18)";
    c.fillRect(0, 15, FRAME, 1);
  }
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

/** A soft cloud shadow — a feathered dark blob of a few overlapping radial
 *  gradients, drawn on a larger-than-tile canvas. Drifts across the terrain
 *  (see pixiScene) for ambient sky motion — render-only, not a weather sim.
 *  Self-authored → CC0. */
const CLOUD_W = 64;
const CLOUD_H = 36;
function drawCloudShadow(c: CanvasRenderingContext2D) {
  c.clearRect(0, 0, CLOUD_W, CLOUD_H);
  const blob = (cx: number, cy: number, r: number, a: number) => {
    const g = c.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
    g.addColorStop(0, `rgba(0,0,0,${a})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, CLOUD_W, CLOUD_H);
  };
  blob(26, 18, 20, 0.22);
  blob(40, 16, 16, 0.2);
  blob(34, 22, 14, 0.16);
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

/** Like `canvasTexture` but for a larger, non-tile-sized texture (e.g. the cloud
 *  shadow). Uses linear filtering so its soft gradient stays smooth when scaled. */
function canvasTextureSized(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext("2d")!);
  return Texture.from(canvas);
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
      roof: {
        ridge: canvasTexture((c) => drawRoof(c, "ridge")),
        body: canvasTexture((c) => drawRoof(c, "body")),
        eave: canvasTexture((c) => drawRoof(c, "eave")),
      },
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
    props: {
      planter: canvasTexture((c) => drawProp(c, "planter")),
      noticeboard: canvasTexture((c) => drawProp(c, "noticeboard")),
      market: canvasTexture((c) => drawProp(c, "market")),
      coffeecart: canvasTexture((c) => drawProp(c, "coffeecart")),
      cafetable: canvasTexture((c) => drawProp(c, "cafetable")),
    },
    furniture: {
      desk: sub(indoors, 0, 0), // Kenney table half, tiled into a desk counter
      rug: sub(indoors, 5, 9),
      plant: sub(indoors, 16, 0),
      counter: canvasTexture((c) => drawFurniture(c, "counter")),
      sink: canvasTexture((c) => drawFurniture(c, "sink")),
      table: canvasTexture((c) => drawFurniture(c, "table")),
      chair: canvasTexture((c) => drawFurniture(c, "chair")),
      sofa: canvasTexture((c) => drawFurniture(c, "sofa")),
      bookshelf: canvasTexture((c) => drawFurniture(c, "bookshelf")),
      bed: canvasTexture((c) => drawFurniture(c, "bed")),
      nightstand: canvasTexture((c) => drawFurniture(c, "nightstand")),
    },
    fence: canvasTexture(drawFence),
    pavement: {
      road: canvasTexture(drawRoad),
      plaza: canvasTexture(drawPlaza),
      yard: canvasTexture(drawYard),
      path: canvasTexture(drawPath),
    },
    facade: {
      door: canvasTexture(drawDoor),
      window: canvasTexture(drawWindow),
      windowGlow: canvasTexture(drawWindowGlow),
    },
    fountain: [0, 1, 2].map((f) => canvasTexture((c) => drawFountain(c, f))),
    lamp: canvasTexture(drawLamp),
    cloud: canvasTextureSized(CLOUD_W, CLOUD_H, drawCloudShadow),
  };
  return cache;
}
