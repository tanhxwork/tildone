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
import type { Activity } from "./sim";
import type { ClutterKind, FurnitureKind, PropKind, SpotKind } from "./world";

import grass0Url from "./assets/world/grass0.png";
import grass1Url from "./assets/world/grass1.png";
import grass2Url from "./assets/world/grass2.png";
import treePineUrl from "./assets/world/tree_pine.png";
import treeOrangeUrl from "./assets/world/tree_orange.png";
import bushUrl from "./assets/world/bush.png";
import mushroomsUrl from "./assets/world/mushrooms.png";
import indoorsUrl from "./assets/kenney/roguelike-indoors.png";
import urbanUrl from "./assets/kenney/rpg-urban.png";

/** The fitted furniture drawn procedurally here. `desk`, `rug` and `plant` come
 *  from the Kenney interior sheet instead, and clutter has its own drawer. */
type HomeFurnitureKind =
  | "counter"
  | "sink"
  | "table"
  | "chair"
  | "sofa"
  | "bookshelf"
  | "bed"
  | "nightstand"
  // The detail pass (TIL-199). Half of these are usable — the television, the
  // stove, the whiteboard, the rack, the shower — so they are what a character
  // walks to when it is not at a desk, not only what the room has in it.
  | "tv"
  | "stove"
  | "fridge"
  | "whiteboard"
  | "serverrack"
  | "shower"
  | "toilet"
  | "lamp";

export type Dir = "down" | "up" | "left" | "right";

/** A character's walk frames per facing. Frame 0 is the standing pose; the
 *  renderer cycles all frames while the character is moving. */
export type DirFrames = Record<Dir, Texture[]>;

/** The seated pose, per facing: the standing frame with its legs cropped off.
 *
 *  The sheet ships walk cycles and nothing else, so there is no sitting sprite to
 *  slice — but a seated figure is mostly *not showing its legs*, and at 16px a
 *  torso ending where the chair or the sofa begins reads as sitting far better
 *  than a full-length figure standing behind the furniture does. Which is what the
 *  town used to draw: the walk cycle at half speed, so a worker heads-down for 25
 *  minutes marched on the spot (TIL-200). */
export type SitFrames = Record<Dir, Texture>;

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
  /** Pale checkered tiling — the kitchen. */
  tiledFloor: Texture;
  /** Soft pile — the bedroom. */
  carpet: Texture;
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
  /** The same agents, seated — the standing frame cropped at the hip. */
  sits: Record<string, SitFrames>;
  /** The workstation chair, in two parts: the whole thing for the seat tile, and
   *  its back again for over the character sitting in it (see drawDeskChair). */
  chair: { all: Texture; back: Texture };
  /** Small self-authored decorations that belong to no other category: the mat at
   *  a front door, the clock on a workroom wall. */
  decor: { mat: Texture; clock: Texture };
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
  /** One small icon per activity, floated over a character's head. Null for the
   *  activities that need no icon — walking is legible from the walk cycle, and
   *  chatting already has its own bubble. */
  glyphs: Record<Activity, Texture | null>;
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

const DIRS: Dir[] = ["down", "up", "left", "right"];

function sliceChar(source: TextureSource, personIndex: number): DirFrames {
  const base = personIndex * 3; // three walk-frame rows per person
  const out = {} as DirFrames;
  for (const d of DIRS) {
    const col = CHAR_DIR_COL[d];
    // stand → stepA → stand → stepB reads as a bob-walk when advanced.
    out[d] = [base, base + 1, base, base + 2].map((r) => sub(source, col, r));
  }
  return out;
}

/** How much of the standing frame a seated character keeps. Cuts at the hip: the
 *  figure occupies roughly rows 2–15 of its cell, so 11 keeps head, shoulders and
 *  most of the torso and drops the legs. */
const SIT_H = 11;

/** The same person, cropped at the hip — one frame per facing (frame 0, the
 *  standing pose: a seated character is still, and stillness is the whole point). */
function sliceSit(source: TextureSource, personIndex: number): SitFrames {
  const row = personIndex * 3;
  const out = {} as SitFrames;
  for (const d of DIRS) {
    out[d] = new Texture({
      source,
      frame: new Rectangle(CHAR_DIR_COL[d] * STRIDE, row * STRIDE, FRAME, SIT_H),
    });
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
  } else if (kind === "garden") {
    // garden plot
    ctx.fillStyle = "#7a5230";
    ctx.fillRect(3, 8, 10, 5);
    ctx.fillStyle = "#4f9d4f"; // sprouts
    ctx.fillRect(5, 6, 1, 3);
    ctx.fillRect(8, 5, 1, 4);
    ctx.fillRect(11, 7, 1, 2);
  } else if (kind === "swing") {
    ctx.fillStyle = "#8a5a2b"; // A-frame
    ctx.fillRect(2, 2, 1, 11);
    ctx.fillRect(13, 2, 1, 11);
    ctx.fillRect(2, 1, 12, 2);
    ctx.fillStyle = "#5e3d1c"; // ropes
    ctx.fillRect(6, 3, 1, 6);
    ctx.fillRect(10, 3, 1, 6);
    ctx.fillStyle = "#c9902e"; // seat
    ctx.fillRect(5, 9, 7, 2);
  } else if (kind === "hammock") {
    // Strung north–south, not east–west, and that is not an arbitrary choice: a
    // character lying down is drawn as its standing sprite (top-down, a lying
    // figure and a standing one are the same silhouette), so it is vertical — and
    // it has to lie *along* the hammock. Hung sideways, the napper read as
    // somebody standing in front of a hammock.
    ctx.fillStyle = "#5e3d1c"; // the two posts, head and foot
    ctx.fillRect(3, 0, 10, 2);
    ctx.fillRect(3, 14, 10, 2);
    ctx.fillStyle = "#c9902e"; // the slung cloth, bellying out in the middle
    ctx.fillRect(5, 2, 6, 12);
    ctx.fillRect(4, 5, 8, 6);
    ctx.fillStyle = "#e0b45c"; // sunlit left edge
    ctx.fillRect(4, 5, 1, 6);
    ctx.fillRect(5, 2, 1, 12);
    ctx.fillStyle = "#a8761c"; // the weave, and the shadow down the right side
    ctx.fillRect(11, 5, 1, 6);
    for (let y = 3; y < 14; y += 3) ctx.fillRect(5, y, 6, 1);
    ctx.fillStyle = "#5e3d1c"; // ropes gathering at each end
    ctx.fillRect(7, 2, 2, 1);
    ctx.fillRect(7, 13, 2, 1);
  } else if (kind === "chess") {
    ctx.fillStyle = "#6f4a24"; // stools either side
    ctx.fillRect(0, 9, 3, 3);
    ctx.fillRect(13, 9, 3, 3);
    ctx.fillStyle = "#5e3d1c"; // pedestal
    ctx.fillRect(7, 10, 2, 4);
    ctx.fillStyle = "#8a5a2b"; // table top
    ctx.fillRect(3, 4, 10, 7);
    ctx.fillStyle = "#f2f0ea"; // board
    ctx.fillRect(4, 5, 8, 5);
    ctx.fillStyle = "#3a3340"; // the dark squares
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 4; i++) ctx.fillRect(4 + i * 2 + (r % 2), 5 + r * 2, 1, 1);
    }
    ctx.fillStyle = "#c0562e"; // a piece each, mid-game
    ctx.fillRect(5, 6, 1, 1);
    ctx.fillStyle = "#f7f3ea";
    ctx.fillRect(10, 8, 1, 1);
  } else if (kind === "hoop") {
    ctx.fillStyle = "#8f8a82"; // post
    ctx.fillRect(7, 6, 2, 8);
    ctx.fillStyle = "#f2f0ea"; // backboard
    ctx.fillRect(4, 1, 8, 5);
    ctx.fillStyle = "#c9c3b8";
    ctx.fillRect(4, 1, 8, 1);
    ctx.fillStyle = "#c0562e"; // rim
    ctx.fillRect(5, 6, 6, 1);
    ctx.fillStyle = "rgba(245,242,234,0.85)"; // net
    ctx.fillRect(6, 7, 1, 2);
    ctx.fillRect(9, 7, 1, 2);
    ctx.fillStyle = "#e8791f"; // the ball, left where it stopped
    ctx.beginPath();
    ctx.ellipse(3, 12, 2.2, 2.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#b85c14";
    ctx.fillRect(1, 12, 4, 1);
  } else if (kind === "picnic") {
    ctx.fillStyle = "#d9cdb4"; // the blanket, laid flat
    ctx.fillRect(2, 5, 12, 9);
    ctx.fillStyle = "#c9552f"; // its check
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 3; i++) ctx.fillRect(3 + i * 4 + (r % 2) * 2, 6 + r * 3, 2, 2);
    }
    ctx.fillStyle = "#b08a5a"; // basket
    ctx.fillRect(9, 2, 6, 4);
    ctx.fillStyle = "#8f6c42";
    ctx.fillRect(9, 2, 6, 1);
    ctx.fillRect(11, 3, 1, 3);
  } else if (kind === "stage") {
    ctx.fillStyle = "#9a948a"; // the bandstand platform
    ctx.fillRect(1, 9, 14, 5);
    ctx.fillStyle = "#b3ada2";
    ctx.fillRect(1, 9, 14, 1);
    ctx.fillStyle = "#7f7a70"; // step
    ctx.fillRect(4, 14, 8, 1);
    ctx.fillStyle = "#5e3d1c"; // canopy posts
    ctx.fillRect(2, 4, 1, 5);
    ctx.fillRect(13, 4, 1, 5);
    ctx.fillStyle = "#3f7fb0"; // canopy
    ctx.fillRect(0, 1, FRAME, 3);
    ctx.fillStyle = "#5fa0cf";
    ctx.fillRect(0, 1, FRAME, 1);
    ctx.fillStyle = "#2e6b8f"; // its scalloped edge
    for (let x = 0; x < FRAME; x += 3) ctx.fillRect(x, 4, 2, 1);
  } else if (kind === "gym") {
    ctx.fillStyle = "#54524d"; // uprights
    ctx.fillRect(2, 4, 2, 11);
    ctx.fillRect(12, 4, 2, 11);
    ctx.fillStyle = "#6f6a63"; // the bar you pull up on
    ctx.fillRect(1, 3, 14, 2);
    ctx.fillStyle = "#8f8a82";
    ctx.fillRect(1, 3, 14, 1);
    ctx.fillStyle = "#3b3a37"; // a dumbbell left on the ground
    ctx.fillRect(6, 12, 4, 1);
    ctx.fillRect(5, 11, 2, 3);
    ctx.fillRect(9, 11, 2, 3);
  } else if (kind === "easel") {
    ctx.fillStyle = "#8a5a2b"; // legs
    ctx.fillRect(4, 8, 1, 6);
    ctx.fillRect(11, 8, 1, 6);
    ctx.fillStyle = "#f2f0ea"; // canvas
    ctx.fillRect(3, 2, 10, 8);
    ctx.fillStyle = "#3f7fb0"; // a sky and a hill, half-finished
    ctx.fillRect(4, 3, 8, 3);
    ctx.fillStyle = "#4f9d4f";
    ctx.fillRect(4, 6, 8, 2);
    ctx.fillStyle = "#5e3d1c"; // ledge
    ctx.fillRect(3, 10, 10, 1);
  } else {
    // A standing place at a prop that is already drawn — the queue at the coffee
    // cart, the front of the market stall, where you stand to read the notice
    // board. Nothing but worn ground: the thing you came for is the tile next
    // door, and drawing a second object here would double it.
    ctx.clearRect(0, 0, FRAME, FRAME);
    ctx.fillStyle = "rgba(90,74,52,0.20)";
    ctx.beginPath();
    ctx.ellipse(8, 9, 5, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(90,74,52,0.14)";
    ctx.fillRect(5, 11, 2, 1);
    ctx.fillRect(9, 6, 2, 1);
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
    // Arms *and* a back, in a colour family the bed does not use. Drawn flat,
    // the old one was a plain blue-grey rectangle — indistinguishable from the
    // bed two tiles away and, next to a window on the same wall, from a window.
    // A resting character is described as "on the sofa", so the sofa has to be
    // the thing the eye lands on.
    c.fillStyle = "#5a4470"; // back rail
    c.fillRect(1, 1, 14, 4);
    c.fillStyle = "#6d5488"; // back highlight
    c.fillRect(2, 2, 12, 2);
    c.fillStyle = "#5a4470"; // arms
    c.fillRect(0, 4, 3, 9);
    c.fillRect(13, 4, 3, 9);
    c.fillStyle = "#8a6fa8"; // seat cushions
    c.fillRect(3, 5, 10, 8);
    c.fillStyle = "#9f84bb"; // cushion tops
    c.fillRect(4, 6, 4, 5);
    c.fillRect(9, 6, 4, 5);
    c.fillStyle = "#4a3760"; // seam + shadow under the front edge
    c.fillRect(8, 5, 1, 8);
    c.fillRect(0, 13, FRAME, 2);
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
  } else if (kind === "nightstand") {
    // a small cabinet with a lamp
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
  } else if (kind === "tv") {
    // A flat screen on a low stand, seen from above-front: the dark screen is
    // the whole read at this size, so it is the biggest shape.
    c.fillStyle = "#2b2b30"; // bezel
    c.fillRect(1, 2, 14, 9);
    c.fillStyle = "#4a5f70"; // screen (lit warm by the renderer's object light)
    c.fillRect(2, 3, 12, 7);
    c.fillStyle = "#5f7887"; // screen sheen
    c.fillRect(3, 4, 5, 2);
    c.fillStyle = "#3a3a40"; // stand
    c.fillRect(6, 11, 4, 2);
    c.fillRect(4, 13, 8, 1);
  } else if (kind === "stove") {
    c.fillStyle = "#7d7871"; // body
    c.fillRect(0, 3, FRAME, 12);
    c.fillStyle = "#5d5952"; // hob top
    c.fillRect(0, 2, FRAME, 6);
    for (const [bx, by] of [
      [3, 3],
      [10, 3],
    ]) {
      c.fillStyle = "#33312e"; // burner
      c.fillRect(bx, by, 4, 3);
      c.fillStyle = "#c25a2a"; // one ring on
      if (bx === 3) c.fillRect(bx + 1, by + 1, 2, 1);
    }
    c.fillStyle = "#c9c3b8"; // oven door + handle
    c.fillRect(2, 9, 12, 5);
    c.fillStyle = "#8f8a82";
    c.fillRect(3, 10, 10, 1);
  } else if (kind === "fridge") {
    c.fillStyle = "#d7d3cb"; // body
    c.fillRect(1, 1, 14, 14);
    c.fillStyle = "#c2beb5"; // shaded right side
    c.fillRect(11, 1, 4, 14);
    c.fillStyle = "#a9a49b"; // door split
    c.fillRect(1, 6, 14, 1);
    c.fillStyle = "#8f8a82"; // handles
    c.fillRect(9, 3, 1, 2);
    c.fillRect(9, 8, 1, 3);
    c.fillStyle = "#e2c15a"; // a note stuck to the door
    c.fillRect(3, 9, 3, 3);
  } else if (kind === "whiteboard") {
    c.fillStyle = "#6f6a63"; // frame
    c.fillRect(0, 1, FRAME, 12);
    c.fillStyle = "#f2f0ea"; // board
    c.fillRect(1, 2, 14, 9);
    c.fillStyle = "#3f7fb0"; // a box-and-arrow diagram, the way plans get drawn
    c.fillRect(3, 4, 4, 3);
    c.fillRect(9, 4, 4, 3);
    c.fillRect(7, 5, 2, 1);
    c.fillStyle = "#c0562e";
    c.fillRect(3, 9, 8, 1);
    c.fillStyle = "#8f8a82"; // pen tray
    c.fillRect(2, 12, 12, 2);
  } else if (kind === "serverrack") {
    c.fillStyle = "#33363b"; // cabinet
    c.fillRect(2, 1, 12, 14);
    const rows = [3, 6, 9, 12];
    rows.forEach((y, i) => {
      c.fillStyle = "#4a4f55"; // blade
      c.fillRect(3, y, 10, 2);
      c.fillStyle = i % 2 === 0 ? "#5fd08a" : "#e2c15a"; // status lights
      c.fillRect(4, y, 1, 1);
      c.fillRect(6, y, 1, 1);
    });
  } else if (kind === "shower") {
    c.fillStyle = "#b9c3c9"; // tray
    c.fillRect(1, 4, 14, 11);
    c.fillStyle = "#cfd8dd";
    c.fillRect(2, 5, 12, 9);
    c.fillStyle = "#8f9aa3"; // riser + head
    c.fillRect(7, 1, 2, 4);
    c.fillRect(4, 1, 8, 2);
    c.fillStyle = "#7fb0d8"; // water
    for (const x of [5, 8, 11]) c.fillRect(x, 5, 1, 5);
    c.fillStyle = "#6f7a82"; // drain
    c.fillRect(7, 12, 2, 2);
  } else if (kind === "toilet") {
    c.fillStyle = "#e8e4dc"; // cistern
    c.fillRect(3, 2, 10, 4);
    c.fillStyle = "#f2efe8"; // pan
    c.beginPath();
    c.ellipse(8, 10, 4, 4, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#c9c3b8"; // seat rim shadow
    c.beginPath();
    c.ellipse(8, 11, 3, 2.4, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#a9a49b"; // flush
    c.fillRect(11, 3, 2, 1);
  } else {
    // lamp — a standard lamp, the cheapest warmth a room can have
    c.fillStyle = "rgba(0,0,0,0.14)"; // base shadow
    c.fillRect(5, 13, 6, 2);
    c.fillStyle = "#6f5a3a"; // stem
    c.fillRect(7, 6, 2, 8);
    c.fillStyle = "#5e4b30"; // base
    c.fillRect(5, 13, 6, 1);
    c.fillStyle = "#ffe6a0"; // shade
    c.fillRect(3, 2, 10, 5);
    c.fillStyle = "#ffd06a"; // shade underside
    c.fillRect(4, 6, 8, 1);
  }
}

/**
 * Draw one 16×16 piece of clutter — the personal things.
 *
 * Deliberately smaller and lower-contrast than the fitted furniture above: these
 * are what a *specific* project's house has lying around, and if they carried
 * the same visual weight as a sofa the room would read as a shop floor. They are
 * drawn to the same flat top-down convention and single light direction so a
 * cluttered room still reads as one room.
 */
function drawClutter(c: CanvasRenderingContext2D, kind: ClutterKind) {
  c.clearRect(0, 0, FRAME, FRAME);
  const shadow = () => {
    c.fillStyle = "rgba(0,0,0,0.14)";
    c.fillRect(3, 13, 10, 2);
  };
  if (kind === "mug") {
    shadow();
    c.fillStyle = "#f2efe8"; // body
    c.fillRect(5, 6, 6, 7);
    c.fillStyle = "#d8d2c6"; // shaded side
    c.fillRect(9, 6, 2, 7);
    c.fillStyle = "#6b4a2f"; // what is in it
    c.fillRect(6, 6, 4, 2);
    c.fillStyle = "#e8e2d6"; // handle
    c.fillRect(11, 8, 2, 1);
    c.fillRect(12, 9, 1, 2);
    c.fillRect(11, 11, 2, 1);
  } else if (kind === "papers") {
    shadow();
    c.fillStyle = "#efe9dc"; // a spilled stack
    c.fillRect(2, 7, 8, 6);
    c.fillStyle = "#f7f3ea";
    c.fillRect(5, 5, 8, 6);
    c.fillStyle = "#c9c1ae"; // edges
    c.fillRect(5, 5, 8, 1);
    c.fillStyle = "#a8a091"; // lines of text
    c.fillRect(7, 7, 5, 1);
    c.fillRect(7, 9, 4, 1);
  } else if (kind === "laundry") {
    shadow();
    c.fillStyle = "#9a8a6f"; // basket
    c.fillRect(3, 8, 10, 6);
    c.fillStyle = "#b3a184";
    c.fillRect(3, 8, 10, 1);
    c.fillStyle = "#7d6f58"; // weave
    c.fillRect(6, 9, 1, 5);
    c.fillRect(9, 9, 1, 5);
    c.fillStyle = "#cfd8e6"; // clothes spilling over
    c.fillRect(5, 5, 6, 4);
    c.fillStyle = "#e2b6c4";
    c.fillRect(8, 4, 4, 3);
  } else if (kind === "guitar") {
    shadow();
    c.fillStyle = "#8a5a2b"; // body
    c.fillRect(4, 8, 8, 6);
    c.fillRect(5, 6, 6, 3);
    c.fillStyle = "#5e3d1c"; // sound hole
    c.fillRect(7, 9, 3, 3);
    c.fillStyle = "#3f2d18"; // neck
    c.fillRect(7, 1, 2, 6);
    c.fillStyle = "#d8d2c6"; // head
    c.fillRect(6, 0, 4, 2);
  } else if (kind === "yogamat") {
    shadow();
    c.fillStyle = "#5f8fa8"; // the mat, unrolled
    c.fillRect(1, 6, 11, 7);
    c.fillStyle = "#7fb0c8"; // lit face
    c.fillRect(1, 6, 11, 2);
    c.fillStyle = "#4a7288"; // the rolled end
    c.fillRect(11, 5, 4, 9);
    c.fillStyle = "#6fa0b8";
    c.fillRect(11, 5, 4, 1);
    c.fillStyle = "#3d5f72"; // the roll's spiral
    c.fillRect(13, 8, 2, 3);
  } else if (kind === "boardgame") {
    shadow();
    c.fillStyle = "#efe9dc"; // the board, mid-game
    c.fillRect(2, 5, 10, 9);
    c.fillStyle = "#8c4a3f"; // its squares
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 3; i++) c.fillRect(3 + i * 3 + (r % 2), 6 + r * 3, 2, 2);
    }
    c.fillStyle = "#3f6a8c"; // two counters
    c.fillRect(4, 7, 2, 2);
    c.fillStyle = "#c9902e";
    c.fillRect(8, 11, 2, 2);
    c.fillStyle = "#f7f3ea"; // a die beside it
    c.fillRect(12, 10, 4, 4);
    c.fillStyle = "#3a3340";
    c.fillRect(13, 11, 1, 1);
    c.fillRect(14, 12, 1, 1);
  } else if (kind === "boxes") {
    shadow();
    c.fillStyle = "#b08a5a"; // lower carton
    c.fillRect(2, 7, 9, 7);
    c.fillStyle = "#8f6c42";
    c.fillRect(2, 7, 9, 1);
    c.fillStyle = "#c49a66"; // stacked one
    c.fillRect(8, 4, 7, 7);
    c.fillStyle = "#a07d4d";
    c.fillRect(8, 4, 7, 1);
    c.fillStyle = "#e6dcc6"; // tape
    c.fillRect(11, 4, 1, 7);
    c.fillRect(6, 7, 1, 7);
  } else if (kind === "catbed") {
    shadow();
    c.fillStyle = "#7f6f9a"; // cushion rim
    c.fillRect(2, 6, 12, 8);
    c.fillStyle = "#9a8ab5";
    c.fillRect(2, 6, 12, 1);
    c.fillStyle = "#5f527a"; // hollow
    c.fillRect(4, 8, 8, 4);
    c.fillStyle = "#3a3340"; // the cat, curled
    c.fillRect(5, 8, 6, 4);
    c.fillStyle = "#565060"; // ear + tail
    c.fillRect(5, 7, 2, 1);
    c.fillRect(10, 11, 2, 1);
  } else {
    // bookstack — a leaning pile, spines out
    shadow();
    c.fillStyle = "#8c4a3f";
    c.fillRect(3, 11, 11, 3);
    c.fillStyle = "#3f6a8c";
    c.fillRect(3, 8, 10, 3);
    c.fillStyle = "#6a8c4a";
    c.fillRect(4, 5, 9, 3);
    c.fillStyle = "rgba(0,0,0,0.18)"; // page edges
    c.fillRect(12, 8, 1, 3);
    c.fillRect(12, 5, 1, 3);
    c.fillRect(13, 11, 1, 3);
  }
}

/**
 * The chair at a workstation — and the reason it is drawn in two parts.
 *
 * A worker faces *up* into its monitor, so the viewer sees its back, which means
 * the chair's own back is between the viewer and the character. Drawn entirely
 * beneath the sprite it reads as a chair the character is standing in front of;
 * drawn entirely over it, it hides the person. So `all` goes down on the seat tile
 * with the rest of the furniture (an empty desk then has a visible empty chair,
 * which is half of what makes a six-desk workroom read as one worker in it), and
 * `back` is drawn again inside the character's own container, above the sprite —
 * the overlap is what puts the character *in* the chair rather than behind it.
 */
function drawDeskChair(c: CanvasRenderingContext2D, part: "all" | "back") {
  c.clearRect(0, 0, FRAME, FRAME);
  if (part === "all") {
    c.fillStyle = "rgba(0,0,0,0.16)"; // ground shadow
    c.beginPath();
    c.ellipse(8, 15, 5, 1.6, 0, 0, Math.PI * 2);
    c.fill();
    // The seat runs right up to the top of the tile, where the desk's front edge
    // is: a chair drawn only in the lower half of its tile left a strip of bare
    // floor between it and the desk, so it read as a chair pushed *back* from the
    // desk rather than tucked under it.
    c.fillStyle = "#4b525c";
    c.fillRect(3, 1, 10, 11);
    c.fillStyle = "#5a626d"; // seat highlight
    c.fillRect(4, 2, 8, 2);
    c.fillStyle = "#343a42"; // the seat's front lip
    c.fillRect(3, 10, 10, 2);
  }
  // The back — the part that overlaps the person. Low in the tile, because a
  // character sits with its head at the top of it: the back comes up to the
  // shoulders and no further. A taller back covered everything except the crown of
  // the head, so a worker read as a hat on a chair.
  c.fillStyle = "#2f343a"; // armrests
  c.fillRect(1, 9, 2, 5);
  c.fillRect(13, 9, 2, 5);
  c.fillStyle = "#3d434c"; // backrest
  c.fillRect(3, 11, 10, 5);
  c.fillStyle = "#4b525c"; // its padded panel
  c.fillRect(4, 12, 8, 3);
  c.fillStyle = "#343a42"; // centre seam
  c.fillRect(8, 12, 1, 3);
  c.fillStyle = "#565e6a"; // top edge catching the monitor's light
  c.fillRect(3, 11, 10, 1);
}

/** A doormat at a front door. The cheapest possible "someone lives here": a house
 *  whose facade is a door, two windows and nothing else reads as a model of a
 *  house rather than one in use. */
function drawMat(c: CanvasRenderingContext2D) {
  c.clearRect(0, 0, FRAME, FRAME);
  c.fillStyle = "#7d6f58";
  c.fillRect(3, 9, 10, 5);
  c.fillStyle = "#93866c"; // worn middle
  c.fillRect(4, 10, 8, 3);
  c.fillStyle = "#6a5d48"; // bristle lines
  for (const x of [5, 7, 9, 11]) c.fillRect(x, 10, 1, 3);
}

/** A wall clock for the back wall of a workroom. */
function drawClock(c: CanvasRenderingContext2D) {
  c.clearRect(0, 0, FRAME, FRAME);
  c.fillStyle = "#3b3a37"; // case
  c.beginPath();
  c.ellipse(8, 8, 5, 5, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#f2efe8"; // face
  c.beginPath();
  c.ellipse(8, 8, 4, 4, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#3b3a37"; // hands, at a quarter past ten
  c.fillRect(8, 5, 1, 4);
  c.fillRect(8, 8, 3, 1);
}

/**
 * Activity badges — the small icon floated over a character's head.
 *
 * Drawn in code at 16px rather than set as emoji, for the same reason the
 * furniture is: the town is entirely self-authored pixel art, and a colour emoji
 * dropped into it reads as a sticker from another program. It is also the only
 * way to guarantee the icon renders identically wherever the app runs — an emoji
 * is whatever the platform font decides it is.
 *
 * Each badge is a dark rounded plate with a light icon on it, the same
 * plate-behind-text device the nameplates use, and for the same reason: a bare
 * glyph over grass or a roof washes out at this size.
 */
const GLYPH_INK = "#f5f2ea";

function glyphPlate(c: CanvasRenderingContext2D) {
  c.clearRect(0, 0, FRAME, FRAME);
  c.fillStyle = "rgba(30,27,22,0.82)";
  // A 14×12 plate with the corners knocked off — a rounded rect at this size.
  c.fillRect(2, 2, 12, 12);
  c.fillRect(1, 3, 14, 10);
  c.fillStyle = "rgba(245,242,234,0.16)"; // top edge catch-light
  c.fillRect(2, 2, 12, 1);
}

function drawGlyph(c: CanvasRenderingContext2D, activity: Activity) {
  glyphPlate(c);
  const ink = GLYPH_INK;
  if (activity === "typing") {
    c.fillStyle = ink; // keyboard: two rows of keys and a space bar
    for (const x of [4, 6, 8, 10]) c.fillRect(x, 5, 1, 2);
    for (const x of [4, 6, 8, 10]) c.fillRect(x, 8, 1, 2);
    c.fillRect(5, 11, 6, 1);
  } else if (activity === "building") {
    c.fillStyle = "#c9a227"; // hammer head
    c.fillRect(4, 4, 7, 3);
    c.fillStyle = ink; // handle
    c.fillRect(7, 7, 2, 6);
  } else if (activity === "testing") {
    c.fillStyle = ink; // flask neck + body
    c.fillRect(7, 3, 2, 3);
    c.fillRect(5, 6, 6, 2);
    c.fillRect(4, 8, 8, 4);
    c.fillStyle = "#6aa84f"; // what is in it
    c.fillRect(5, 9, 6, 3);
  } else if (activity === "reading") {
    c.fillStyle = ink; // open book, two leaves
    c.fillRect(3, 5, 5, 7);
    c.fillRect(8, 5, 5, 7);
    c.fillStyle = "rgba(30,27,22,0.82)"; // spine + page lines
    c.fillRect(7, 5, 2, 7);
    c.fillRect(4, 7, 3, 1);
    c.fillRect(9, 7, 3, 1);
  } else if (activity === "writing") {
    c.fillStyle = "#c9a227"; // pencil barrel
    c.fillRect(9, 3, 3, 3);
    c.fillRect(7, 5, 3, 3);
    c.fillRect(5, 7, 3, 3);
    c.fillStyle = ink; // tip
    c.fillRect(3, 9, 3, 3);
    c.fillStyle = "#3a3340";
    c.fillRect(3, 11, 2, 1);
  } else if (activity === "waiting") {
    c.fillStyle = ink; // hourglass
    c.fillRect(4, 3, 8, 1);
    c.fillRect(4, 12, 8, 1);
    c.fillRect(5, 4, 6, 1);
    c.fillRect(6, 5, 4, 1);
    c.fillRect(7, 6, 2, 3);
    c.fillRect(6, 9, 4, 1);
    c.fillRect(5, 10, 6, 2);
    c.fillStyle = "#c9a227"; // the sand that has fallen
    c.fillRect(6, 10, 4, 2);
  } else if (activity === "coffee") {
    c.fillStyle = ink; // cup + handle
    c.fillRect(4, 7, 7, 6);
    c.fillRect(11, 8, 2, 3);
    c.fillStyle = "#6b4a2f";
    c.fillRect(5, 7, 5, 2);
    c.fillStyle = "rgba(245,242,234,0.55)"; // steam
    c.fillRect(6, 3, 1, 3);
    c.fillRect(9, 2, 1, 4);
  } else if (activity === "washing") {
    c.fillStyle = "#7fb0d8"; // a falling drop
    c.fillRect(7, 3, 2, 4);
    c.fillRect(6, 6, 4, 3);
    c.fillRect(7, 9, 2, 1);
    c.fillStyle = "rgba(245,242,234,0.8)"; // suds
    c.fillRect(3, 10, 3, 2);
    c.fillRect(10, 11, 3, 2);
  } else if (activity === "eating") {
    c.fillStyle = ink; // plate
    c.fillRect(4, 7, 8, 4);
    c.fillStyle = "rgba(30,27,22,0.82)";
    c.fillRect(6, 8, 4, 2);
    c.fillStyle = ink; // fork
    c.fillRect(2, 4, 1, 8);
    c.fillRect(13, 4, 1, 8);
  } else if (activity === "resting") {
    // A sofa seen head-on: back rail, two arms, seat — with dark gaps between
    // them. Drawn as one solid block first, the parts merged at this size into a
    // white rectangle that read as a blank card, so the gaps are the icon.
    c.fillStyle = ink;
    c.fillRect(3, 4, 10, 2); // back rail
    c.fillRect(3, 7, 2, 5); // left arm
    c.fillRect(11, 7, 2, 5); // right arm
    c.fillRect(6, 8, 4, 4); // seat cushion
    c.fillRect(3, 12, 10, 1); // base
  } else if (activity === "sleeping") {
    // the universal stack of Zs
    c.fillStyle = ink;
    c.fillRect(8, 3, 5, 1);
    c.fillRect(10, 4, 2, 1);
    c.fillRect(9, 5, 2, 1);
    c.fillRect(8, 6, 5, 1);
    c.fillRect(3, 8, 4, 1);
    c.fillRect(5, 9, 2, 1);
    c.fillRect(4, 10, 2, 1);
    c.fillRect(3, 11, 4, 1);
  } else if (activity === "planning") {
    c.fillStyle = ink; // a board with two boxes and an arrow between them
    c.fillRect(2, 3, 12, 10);
    c.fillStyle = "rgba(30,27,22,0.82)";
    c.fillRect(3, 4, 10, 8);
    c.fillStyle = "#7fb0d8";
    c.fillRect(4, 6, 3, 3);
    c.fillRect(10, 6, 2, 3);
    c.fillStyle = ink;
    c.fillRect(7, 7, 3, 1);
  } else if (activity === "deploying") {
    c.fillStyle = ink; // a stack of blades with an arrow going up out of it
    c.fillRect(3, 9, 10, 2);
    c.fillRect(3, 12, 10, 2);
    c.fillStyle = "#5fd08a"; // status lights, and the arrow
    c.fillRect(4, 9, 1, 1);
    c.fillRect(4, 12, 1, 1);
    c.fillRect(7, 3, 2, 5);
    c.fillRect(6, 4, 4, 1);
    c.fillRect(5, 5, 6, 1);
  } else if (activity === "watching") {
    c.fillStyle = ink; // a screen throwing light
    c.fillRect(2, 4, 12, 7);
    c.fillStyle = "#7fb0d8";
    c.fillRect(3, 5, 10, 5);
    c.fillStyle = ink;
    c.fillRect(6, 11, 4, 1);
    c.fillRect(4, 12, 8, 1);
  } else if (activity === "music") {
    c.fillStyle = ink; // a quaver
    c.fillRect(9, 3, 2, 8);
    c.fillRect(11, 3, 2, 2);
    c.beginPath();
    c.ellipse(7, 11, 3, 2.4, 0, 0, Math.PI * 2);
    c.fill();
  } else if (activity === "cooking") {
    c.fillStyle = ink; // a pan on the heat, steaming
    c.fillRect(3, 8, 10, 4);
    c.fillRect(12, 8, 2, 1);
    c.fillStyle = "#c25a2a"; // the ring
    c.fillRect(5, 12, 6, 1);
    c.fillStyle = "rgba(245,242,234,0.55)"; // steam
    c.fillRect(6, 3, 1, 4);
    c.fillRect(9, 2, 1, 5);
  } else if (activity === "fishing") {
    c.fillStyle = ink; // rod and line
    c.fillRect(3, 3, 1, 2);
    c.fillRect(4, 5, 1, 2);
    c.fillRect(5, 7, 1, 2);
    c.fillRect(6, 9, 1, 1);
    c.fillStyle = "rgba(245,242,234,0.6)";
    c.fillRect(11, 3, 1, 6);
    c.fillStyle = "#7fb0d8"; // water, and a float on it
    c.fillRect(2, 11, 12, 3);
    c.fillStyle = "#c0562e";
    c.fillRect(10, 9, 2, 2);
  } else if (activity === "gardening") {
    c.fillStyle = "#7a5230"; // a bed with something coming up in it
    c.fillRect(2, 10, 12, 3);
    c.fillStyle = "#5fd08a";
    c.fillRect(5, 5, 1, 5);
    c.fillRect(4, 6, 1, 2);
    c.fillRect(6, 4, 1, 2);
    c.fillRect(10, 7, 1, 3);
    c.fillRect(11, 6, 1, 2);
  } else if (activity === "shopping") {
    c.fillStyle = ink; // a basket with a handle
    c.fillRect(3, 7, 10, 6);
    c.fillStyle = "rgba(30,27,22,0.82)";
    c.fillRect(4, 8, 8, 4);
    c.fillStyle = ink;
    c.fillRect(5, 4, 1, 3);
    c.fillRect(10, 4, 1, 3);
    c.fillRect(6, 3, 4, 1);
    c.fillStyle = "#5fd08a"; // something green sticking out of it
    c.fillRect(6, 8, 2, 2);
    c.fillStyle = "#e2c15a";
    c.fillRect(9, 8, 2, 2);
  } else if (activity === "gaming") {
    c.fillStyle = ink; // a die, tipped towards the viewer
    c.fillRect(3, 4, 9, 9);
    c.fillStyle = "rgba(30,27,22,0.82)"; // its pips
    c.fillRect(5, 6, 2, 2);
    c.fillRect(8, 9, 2, 2);
    c.fillStyle = "#c9a227"; // a counter beside it
    c.fillRect(11, 10, 3, 3);
  } else if (activity === "exercising") {
    c.fillStyle = ink; // a dumbbell
    c.fillRect(6, 7, 4, 2);
    c.fillRect(3, 5, 3, 6);
    c.fillRect(10, 5, 3, 6);
    c.fillStyle = "rgba(30,27,22,0.82)"; // the gap between plates
    c.fillRect(4, 7, 1, 2);
    c.fillRect(11, 7, 1, 2);
  } else if (activity === "napping") {
    // One Z, where sleeping has a stack of two. A hammock under a Z was tried
    // first and at 16px the slung curve read as a bowl — the Z is the only part of
    // that icon anyone would recognise, so it is the whole icon.
    c.fillStyle = ink;
    c.fillRect(4, 4, 8, 2);
    c.fillRect(8, 6, 2, 2);
    c.fillRect(6, 8, 2, 2);
    c.fillRect(4, 10, 8, 2);
  } else if (activity === "playing") {
    c.fillStyle = ink; // a ball in the air, and its bounce
    c.beginPath();
    c.ellipse(8, 7, 4, 4, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "rgba(30,27,22,0.82)";
    c.fillRect(4, 6, 8, 1);
    c.fillRect(7, 4, 1, 6);
    c.fillStyle = "rgba(245,242,234,0.45)";
    c.fillRect(4, 12, 8, 1);
  } else {
    // painting — a palette with paint on it, and a brush
    c.fillStyle = ink;
    c.beginPath();
    c.ellipse(7, 9, 5, 4, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "rgba(30,27,22,0.82)"; // thumb hole
    c.beginPath();
    c.ellipse(9, 10, 1.4, 1.2, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#c0562e"; // three dabs
    c.fillRect(4, 7, 2, 2);
    c.fillStyle = "#3f7fb0";
    c.fillRect(7, 6, 2, 2);
    c.fillStyle = "#5fd08a";
    c.fillRect(10, 7, 2, 2);
    c.fillStyle = ink; // brush
    c.fillRect(12, 2, 2, 5);
  }
}

/** One badge per activity that has something to show. Walking is legible from
 *  the walk cycle, chatting already has its own bubble, and a character that has
 *  left is on its way off the map — a badge on any of those is noise. */
function buildGlyphs(): Record<Activity, Texture | null> {
  const drawn: Activity[] = [
    "typing",
    "building",
    "testing",
    "reading",
    "writing",
    "waiting",
    "coffee",
    "washing",
    "eating",
    "resting",
    "sleeping",
    "planning",
    "deploying",
    "watching",
    "music",
    "cooking",
    "fishing",
    "gardening",
    "shopping",
    "playing",
    "painting",
    "gaming",
    "exercising",
    "napping",
  ];
  const out = {
    walking: null,
    chatting: null,
    stuck: null,
    leaving: null,
  } as Record<Activity, Texture | null>;
  for (const a of drawn) out[a] = canvasTexture((c) => drawGlyph(c, a));
  // `stuck` reuses the waiting hourglass rather than inventing a second "not
  // making progress" icon — the ring around a blocked character already says
  // which of the two it is.
  out.stuck = out.waiting;
  return out;
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

/**
 * Kitchen tiling and bedroom carpet — the two floors a house needs that are not
 * boards.
 *
 * Tinting the Kenney wood floor per room was tried first and cannot work: a
 * multiply over a saturated orange plank can only ever produce a browner plank,
 * so the "cool tile" kitchen came out as dark wood and the rooms read as
 * blotches rather than as different materials. A floor is a material, and the
 * material is what says which room you are in.
 */
function drawKitchenFloor(c: CanvasRenderingContext2D) {
  c.clearRect(0, 0, FRAME, FRAME);
  c.fillStyle = "#d9d6cd"; // pale tile
  c.fillRect(0, 0, FRAME, FRAME);
  c.fillStyle = "#cfccc2"; // the checker, one shade off so it reads as tiling
  c.fillRect(0, 0, 8, 8);
  c.fillRect(8, 8, 8, 8);
  c.fillStyle = "#bab7ad"; // grout
  c.fillRect(0, 7, FRAME, 1);
  c.fillRect(7, 0, 1, FRAME);
  c.fillRect(0, 15, FRAME, 1);
  c.fillRect(15, 0, 1, FRAME);
}

function drawCarpet(c: CanvasRenderingContext2D) {
  c.clearRect(0, 0, FRAME, FRAME);
  // Muted and greyed rather than a saturated mauve: the sofa is the strongest
  // purple in the house and a carpet competing with it flattens the lounge.
  c.fillStyle = "#9a8f9c";
  c.fillRect(0, 0, FRAME, FRAME);
  c.fillStyle = "#a89ca9"; // flecks, so it reads as a weave not a flat fill
  for (const [x, y] of [
    [2, 3],
    [9, 1],
    [5, 8],
    [13, 6],
    [1, 12],
    [10, 13],
    [6, 11],
  ]) {
    c.fillRect(x, y, 2, 1);
  }
  c.fillStyle = "#8b8090";
  for (const [x, y] of [
    [4, 1],
    [12, 4],
    [8, 6],
    [2, 9],
    [14, 11],
    [7, 14],
  ]) {
    c.fillRect(x, y, 1, 2);
  }
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
  const sits: Record<string, SitFrames> = {};
  for (const [key, idx] of Object.entries(CHAR_INDEX)) {
    chars[key] = sliceChar(urban, idx);
    sits[key] = sliceSit(urban, idx);
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
    sits,
    chair: {
      all: canvasTexture((c) => drawDeskChair(c, "all")),
      back: canvasTexture((c) => drawDeskChair(c, "back")),
    },
    decor: {
      mat: canvasTexture(drawMat),
      clock: canvasTexture(drawClock),
    },
    spots: {
      bench: [canvasTexture((c) => drawSpot(c, "bench"))],
      pond: [0, 1, 2].map((f) => canvasTexture((c) => drawSpot(c, "pond", f))),
      campfire: [0, 1, 2].map((f) => canvasTexture((c) => drawSpot(c, "campfire", f))),
      garden: [canvasTexture((c) => drawSpot(c, "garden"))],
      swing: [canvasTexture((c) => drawSpot(c, "swing"))],
      easel: [canvasTexture((c) => drawSpot(c, "easel"))],
      hammock: [canvasTexture((c) => drawSpot(c, "hammock"))],
      chess: [canvasTexture((c) => drawSpot(c, "chess"))],
      hoop: [canvasTexture((c) => drawSpot(c, "hoop"))],
      picnic: [canvasTexture((c) => drawSpot(c, "picnic"))],
      stage: [canvasTexture((c) => drawSpot(c, "stage"))],
      gym: [canvasTexture((c) => drawSpot(c, "gym"))],
      // Standing places: worn ground, since the prop beside them is the object.
      cart: [canvasTexture((c) => drawSpot(c, "cart"))],
      stall: [canvasTexture((c) => drawSpot(c, "stall"))],
      board: [canvasTexture((c) => drawSpot(c, "board"))],
    },
    interior: {
      tiledFloor: canvasTexture(drawKitchenFloor),
      carpet: canvasTexture(drawCarpet),
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
      mug: canvasTexture((c) => drawClutter(c, "mug")),
      papers: canvasTexture((c) => drawClutter(c, "papers")),
      laundry: canvasTexture((c) => drawClutter(c, "laundry")),
      guitar: canvasTexture((c) => drawClutter(c, "guitar")),
      boxes: canvasTexture((c) => drawClutter(c, "boxes")),
      catbed: canvasTexture((c) => drawClutter(c, "catbed")),
      bookstack: canvasTexture((c) => drawClutter(c, "bookstack")),
      yogamat: canvasTexture((c) => drawClutter(c, "yogamat")),
      boardgame: canvasTexture((c) => drawClutter(c, "boardgame")),
      counter: canvasTexture((c) => drawFurniture(c, "counter")),
      sink: canvasTexture((c) => drawFurniture(c, "sink")),
      table: canvasTexture((c) => drawFurniture(c, "table")),
      chair: canvasTexture((c) => drawFurniture(c, "chair")),
      sofa: canvasTexture((c) => drawFurniture(c, "sofa")),
      bookshelf: canvasTexture((c) => drawFurniture(c, "bookshelf")),
      bed: canvasTexture((c) => drawFurniture(c, "bed")),
      nightstand: canvasTexture((c) => drawFurniture(c, "nightstand")),
      tv: canvasTexture((c) => drawFurniture(c, "tv")),
      stove: canvasTexture((c) => drawFurniture(c, "stove")),
      fridge: canvasTexture((c) => drawFurniture(c, "fridge")),
      whiteboard: canvasTexture((c) => drawFurniture(c, "whiteboard")),
      serverrack: canvasTexture((c) => drawFurniture(c, "serverrack")),
      shower: canvasTexture((c) => drawFurniture(c, "shower")),
      toilet: canvasTexture((c) => drawFurniture(c, "toilet")),
      lamp: canvasTexture((c) => drawFurniture(c, "lamp")),
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
    glyphs: buildGlyphs(),
  };
  return cache;
}
