// Town textures for the living overworld.
//
// World tiles are Kenney "Tiny Town" (CC0, 16px) — grass, dirt, trees, fences,
// and house parts (see assets/world/ + ASSETS.md). Roofs use the neutral-grey
// shingle tiles so the renderer can tint them per project. The characters and
// the leisure-spot props are *procedurally* generated here (self-authored CC0)
// as 4-direction walk cycles / small props; swapping in richer CC0 character
// art is a contained change — replace `buildCharFrames` with a spritesheet
// slicer returning the same DirFrames shape.

import { Assets, Texture } from "pixi.js";
import type { SpotKind } from "./world";
import grass0Url from "./assets/world/grass0.png";
import grass1Url from "./assets/world/grass1.png";
import grass2Url from "./assets/world/grass2.png";
import dirtUrl from "./assets/world/dirt.png";
import roofLUrl from "./assets/world/roofL.png";
import roofMUrl from "./assets/world/roofM.png";
import roofRUrl from "./assets/world/roofR.png";
import wallUrl from "./assets/world/wall.png";
import door2Url from "./assets/world/door2.png";
import windowUrl from "./assets/world/window.png";
import treePineUrl from "./assets/world/tree_pine.png";
import treeOrangeUrl from "./assets/world/tree_orange.png";
import bushUrl from "./assets/world/bush.png";
import mushroomsUrl from "./assets/world/mushrooms.png";
import fenceUrl from "./assets/world/fence.png";
import barrelUrl from "./assets/world/barrel.png";

export type Dir = "down" | "up" | "left" | "right";

/** A character's walk frames per facing. Frame 0 is the standing pose; the
 *  renderer cycles all frames while the character is moving. */
export type DirFrames = Record<Dir, Texture[]>;

/** Kenney Tiny Town world tiles the renderer composes from. */
export interface WorldTiles {
  /** Grass variants — [plain, detail, flowers] — for ground variation. */
  grass: Texture[];
  dirt: Texture;
  /** Grey shingle roof left/mid/right (tinted per project by the renderer). */
  roofL: Texture;
  roofM: Texture;
  roofR: Texture;
  wall: Texture;
  door: Texture;
  window: Texture;
  /** Scatterable green decorations. */
  trees: Texture[];
  bush: Texture;
  mushrooms: Texture;
  fence: Texture;
  barrel: Texture;
}

/** Procedural CC0 interior furnishings the renderer composes each house's
 *  cutaway room from (a desk with a computer where the working character sits,
 *  plus homey props so it reads as a real house, not a shut exterior). */
export interface InteriorTiles {
  floor: Texture;
  wall: Texture;
  desk: Texture;
  computer: Texture;
  plant: Texture;
  bookshelf: Texture;
  rug: Texture;
  picture: Texture;
}

export interface TownTextures {
  world: WorldTiles;
  /** Walk-cycle atlas per agent key (see charKeyForAgent). */
  chars: Record<string, DirFrames>;
  /** Procedural CC0 leisure-spot props, by kind. */
  spots: Record<SpotKind, Texture>;
  /** Procedural CC0 interior furnishings for the house cutaways. */
  interior: InteriorTiles;
}

/** Placeholder character palette by agent key — mirrors the agent-identity
 *  accent colours so a character still reads as "the Claude one" etc. */
const CHAR_COLORS: Record<string, string> = {
  claude: "#d97757",
  codex: "#10a37f",
  cursor: "#4b5563",
  secretary: "#8b5cf6",
  generic: "#4f7ed4",
};

const SKIN = "#f0c39a";
const HAIR = "#3a2e2a";
const SHOE = "#2f2a28";
const FRAME = 16;

/** Draw one 16×16 character frame. `phase` 0=stand, 1=step-left, 2=step-right. */
function drawFrame(ctx: CanvasRenderingContext2D, color: string, dir: Dir, phase: number) {
  ctx.clearRect(0, 0, FRAME, FRAME);
  // Contact shadow.
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.beginPath();
  ctx.ellipse(8, 14.5, 4, 1.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Legs (swing by phase).
  const lLeg = phase === 1 ? 11 : 12;
  const rLeg = phase === 2 ? 11 : 12;
  ctx.fillStyle = SHOE;
  ctx.fillRect(6, lLeg, 2, 15 - lLeg + 1);
  ctx.fillRect(8, rLeg, 2, 15 - rLeg + 1);

  // Body.
  ctx.fillStyle = color;
  ctx.fillRect(5, 7, 6, 5);
  // Arms hint.
  ctx.fillRect(4, 8, 1, 3);
  ctx.fillRect(11, 8, 1, 3);

  // Head.
  if (dir === "up") {
    ctx.fillStyle = HAIR; // back of head
    ctx.fillRect(5, 2, 6, 5);
  } else {
    ctx.fillStyle = SKIN;
    ctx.fillRect(5, 2, 6, 5);
    ctx.fillStyle = HAIR; // fringe
    ctx.fillRect(5, 2, 6, 1);
    // Eyes by facing.
    ctx.fillStyle = "#222";
    if (dir === "down") {
      ctx.fillRect(6, 4, 1, 1);
      ctx.fillRect(9, 4, 1, 1);
    } else if (dir === "left") {
      ctx.fillRect(6, 4, 1, 1);
    } else {
      ctx.fillRect(9, 4, 1, 1);
    }
  }
}

function frameTexture(color: string, dir: Dir, phase: number): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = FRAME;
  canvas.height = FRAME;
  const ctx = canvas.getContext("2d")!;
  drawFrame(ctx, color, dir, phase);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = "nearest";
  return tex;
}

/** Build the 4-direction walk cycle for one colour. Cycle order stand→L→stand→R
 *  reads as a bob-walk when advanced. */
function buildCharFrames(color: string): DirFrames {
  const dirs: Dir[] = ["down", "up", "left", "right"];
  const out = {} as DirFrames;
  for (const d of dirs) {
    out[d] = [0, 1, 0, 2].map((phase) => frameTexture(color, d, phase));
  }
  return out;
}

/** Draw one 16×16 leisure prop. Procedural + self-authored → CC0, like the
 *  characters; swaps out for real art the same way (a texture per kind). */
function drawSpot(ctx: CanvasRenderingContext2D, kind: SpotKind) {
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
    ctx.fillStyle = "#8fc4e6"; // glint
    ctx.fillRect(6, 7, 2, 1);
  } else if (kind === "campfire") {
    ctx.fillStyle = "#5e3d1c"; // logs
    ctx.fillRect(4, 11, 8, 2);
    ctx.fillStyle = "#e8791f"; // flame
    ctx.beginPath();
    ctx.moveTo(8, 4);
    ctx.lineTo(11, 11);
    ctx.lineTo(5, 11);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#f6c33b";
    ctx.fillRect(7, 8, 2, 3);
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

function spotTexture(kind: SpotKind): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = FRAME;
  canvas.height = FRAME;
  const ctx = canvas.getContext("2d")!;
  drawSpot(ctx, kind);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = "nearest";
  return tex;
}

// --- Interior furnishings for the house cutaways (procedural, self-authored →
// CC0). Each is one 16px tile the renderer lays inside a building's open front.
type Draw = (ctx: CanvasRenderingContext2D) => void;

/** Warm wood-plank floor. */
const drawFloor: Draw = (x) => {
  x.fillStyle = "#c69a63";
  x.fillRect(0, 0, 16, 16);
  x.fillStyle = "#b6885230"; // faint plank shading bands
  x.fillRect(0, 0, 16, 4);
  x.fillRect(0, 8, 16, 4);
  x.strokeStyle = "#9c6d3d";
  x.lineWidth = 1;
  x.beginPath();
  for (let y = 4; y < 16; y += 4) {
    x.moveTo(0, y + 0.5);
    x.lineTo(16, y + 0.5);
  }
  // staggered plank seams
  x.moveTo(5.5, 0);
  x.lineTo(5.5, 4);
  x.moveTo(11.5, 4);
  x.lineTo(11.5, 8);
  x.moveTo(4.5, 8);
  x.lineTo(4.5, 12);
  x.moveTo(10.5, 12);
  x.lineTo(10.5, 16);
  x.stroke();
  x.fillStyle = "#d3ac79";
  x.fillRect(0, 3, 16, 1); // top plank highlight
};

/** Interior back wall (warm plaster) with a wood baseboard. */
const drawWall: Draw = (x) => {
  x.fillStyle = "#efe4d2";
  x.fillRect(0, 0, 16, 16);
  x.fillStyle = "#e6d8c0";
  x.fillRect(0, 0, 16, 2); // top shade under the roof
  x.fillStyle = "#c9a878";
  x.fillRect(0, 13, 16, 3); // baseboard
  x.fillStyle = "#b8946530";
  x.fillRect(0, 13, 16, 1);
};

/** Wooden desk, top slab + drawers, front edge facing the seated character. */
const drawDesk: Draw = (x) => {
  x.clearRect(0, 0, 16, 16);
  x.fillStyle = "rgba(0,0,0,.15)";
  x.fillRect(1, 14, 14, 2); // shadow
  x.fillStyle = "#7a4a25";
  x.fillRect(0, 5, 16, 4); // top slab
  x.fillStyle = "#8a5730";
  x.fillRect(0, 5, 16, 1); // front-edge highlight
  x.fillStyle = "#6b3f20";
  x.fillRect(1, 9, 14, 5); // body / drawers
  x.fillStyle = "#5a3319";
  x.fillRect(1, 9, 14, 1);
  x.fillStyle = "#4a2a14";
  x.fillRect(8, 9, 1, 5); // drawer seam
  x.fillStyle = "#d8b487";
  x.fillRect(4, 11, 1, 1); // knobs
  x.fillRect(11, 11, 1, 1);
};

/** Desktop computer — a monitor with a glowing screen + keyboard, on the desk. */
const drawComputer: Draw = (x) => {
  x.clearRect(0, 0, 16, 16);
  x.fillStyle = "#2c2f36"; // stand
  x.fillRect(7, 7, 2, 2);
  x.fillRect(5, 9, 6, 1);
  x.fillStyle = "#20242b"; // bezel
  x.fillRect(3, 1, 10, 7);
  x.fillStyle = "#39c6d6"; // screen glow
  x.fillRect(4, 2, 8, 5);
  x.fillStyle = "#8be6ef";
  x.fillRect(4, 2, 8, 1); // top glow line
  x.fillStyle = "#1f6f79"; // code lines
  x.fillRect(5, 4, 5, 1);
  x.fillRect(5, 5, 3, 1);
  x.fillStyle = "#3a3f47"; // keyboard on the desk
  x.fillRect(4, 11, 8, 2);
  x.fillStyle = "#565d68";
  x.fillRect(4, 11, 8, 1);
};

/** Potted plant. */
const drawPlant: Draw = (x) => {
  x.clearRect(0, 0, 16, 16);
  x.fillStyle = "rgba(0,0,0,.15)";
  x.fillRect(4, 14, 8, 2);
  x.fillStyle = "#c56b3f"; // terracotta pot
  x.fillRect(5, 11, 6, 4);
  x.fillStyle = "#a85631";
  x.fillRect(5, 11, 6, 1);
  x.fillStyle = "#3f8f4a"; // foliage
  x.fillRect(6, 4, 4, 7);
  x.fillRect(4, 6, 2, 4);
  x.fillRect(10, 6, 2, 4);
  x.fillStyle = "#57ad61";
  x.fillRect(7, 4, 2, 3);
  x.fillRect(5, 7, 1, 2);
  x.fillRect(10, 7, 1, 2);
};

/** Bookshelf against the back wall, colourful spines. */
const drawBookshelf: Draw = (x) => {
  x.clearRect(0, 0, 16, 16);
  x.fillStyle = "#6b4626"; // frame
  x.fillRect(2, 1, 12, 15);
  x.fillStyle = "#4d3117";
  x.fillRect(2, 1, 12, 1);
  x.fillRect(2, 7, 12, 1);
  x.fillRect(2, 13, 12, 1);
  x.fillStyle = "#3a2410";
  x.fillRect(2, 1, 1, 15);
  x.fillRect(13, 1, 1, 15);
  const books = ["#c0503f", "#4f7ed4", "#e0a93b", "#4f9d4f", "#8b5cf6"];
  for (let s = 0; s < 2; s++) {
    const yy = 2 + s * 6;
    for (let i = 0; i < 5; i++) {
      x.fillStyle = books[(i + s) % books.length];
      x.fillRect(3 + i * 2, yy, 2, 5);
    }
  }
};

/** Small floor rug. */
const drawRug: Draw = (x) => {
  x.clearRect(0, 0, 16, 16);
  x.fillStyle = "#c0503f";
  x.fillRect(2, 4, 12, 9);
  x.fillStyle = "#ffffff40";
  x.fillRect(3, 5, 10, 7);
  x.fillStyle = "#c0503f";
  x.fillRect(5, 7, 6, 3);
};

/** Framed wall picture — a little landscape. */
const drawPicture: Draw = (x) => {
  x.clearRect(0, 0, 16, 16);
  x.fillStyle = "#7a5a34"; // frame
  x.fillRect(4, 3, 8, 7);
  x.fillStyle = "#cfe6f2"; // sky
  x.fillRect(5, 4, 6, 5);
  x.fillStyle = "#8fbf7a"; // hills
  x.fillRect(5, 7, 6, 2);
  x.fillStyle = "#f2c94c"; // sun
  x.fillRect(9, 4, 2, 2);
};

function pixelTexture(draw: Draw): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = FRAME;
  canvas.height = FRAME;
  draw(canvas.getContext("2d")!);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = "nearest";
  return tex;
}

let cache: TownTextures | null = null;

export async function loadTownTextures(): Promise<TownTextures> {
  if (cache) return cache;
  const urls: Record<string, string> = {
    grass0: grass0Url,
    grass1: grass1Url,
    grass2: grass2Url,
    dirt: dirtUrl,
    roofL: roofLUrl,
    roofM: roofMUrl,
    roofR: roofRUrl,
    wall: wallUrl,
    door2: door2Url,
    window: windowUrl,
    treePine: treePineUrl,
    treeOrange: treeOrangeUrl,
    bush: bushUrl,
    mushrooms: mushroomsUrl,
    fence: fenceUrl,
    barrel: barrelUrl,
  };
  const loaded: Record<string, Texture> = {};
  await Promise.all(
    Object.entries(urls).map(async ([k, url]) => {
      const tex = (await Assets.load(url)) as Texture;
      tex.source.scaleMode = "nearest";
      loaded[k] = tex;
    }),
  );
  const chars: Record<string, DirFrames> = {};
  for (const [key, color] of Object.entries(CHAR_COLORS)) {
    chars[key] = buildCharFrames(color);
  }
  cache = {
    world: {
      grass: [loaded.grass0, loaded.grass1, loaded.grass2],
      dirt: loaded.dirt,
      roofL: loaded.roofL,
      roofM: loaded.roofM,
      roofR: loaded.roofR,
      wall: loaded.wall,
      door: loaded.door2,
      window: loaded.window,
      trees: [loaded.treePine, loaded.treeOrange],
      bush: loaded.bush,
      mushrooms: loaded.mushrooms,
      fence: loaded.fence,
      barrel: loaded.barrel,
    },
    chars,
    spots: {
      bench: spotTexture("bench"),
      pond: spotTexture("pond"),
      campfire: spotTexture("campfire"),
      garden: spotTexture("garden"),
    },
    interior: {
      floor: pixelTexture(drawFloor),
      wall: pixelTexture(drawWall),
      desk: pixelTexture(drawDesk),
      computer: pixelTexture(drawComputer),
      plant: pixelTexture(drawPlant),
      bookshelf: pixelTexture(drawBookshelf),
      rug: pixelTexture(drawRug),
      picture: pixelTexture(drawPicture),
    },
  };
  return cache;
}
