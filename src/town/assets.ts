// Town textures for the living overworld.
//
// The world tiles reuse the in-repo Kenney "Tiny Dungeon" CC0 art (floor / wall
// / door / desk) — see assets/ASSETS.md. The characters are *procedurally*
// generated here as 4-direction walk cycles: a small, self-authored (CC0)
// atlas so v2a ships with real directional walk animation and zero new asset
// downloads. Swapping in nicer CC0 art (Kenney Tiny Town ground + Piano no
// Renshu 4-dir walk characters) is a contained change: replace `buildCharFrames`
// with a spritesheet slicer returning the same DirFrames shape — pixiScene
// consumes DirFrames and never sees how they were made.

import { Assets, Texture } from "pixi.js";
import type { SpotKind } from "./world";
import floorUrl from "./assets/floor.png";
import wallUrl from "./assets/wall.png";
import deskUrl from "./assets/desk.png";
import doorUrl from "./assets/door.png";

export type Dir = "down" | "up" | "left" | "right";

/** A character's walk frames per facing. Frame 0 is the standing pose; the
 *  renderer cycles all frames while the character is moving. */
export type DirFrames = Record<Dir, Texture[]>;

export interface TownTextures {
  /** Tiled ground of the green. */
  ground: Texture;
  wall: Texture;
  door: Texture;
  desk: Texture;
  /** Walk-cycle atlas per agent key (see charKeyForAgent). */
  chars: Record<string, DirFrames>;
  /** Procedural CC0 leisure-spot props, by kind. */
  spots: Record<SpotKind, Texture>;
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

let cache: TownTextures | null = null;

export async function loadTownTextures(): Promise<TownTextures> {
  if (cache) return cache;
  const urls: Record<string, string> = {
    ground: floorUrl,
    wall: wallUrl,
    door: doorUrl,
    desk: deskUrl,
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
    ground: loaded.ground,
    wall: loaded.wall,
    door: loaded.door,
    desk: loaded.desk,
    chars,
    spots: {
      bench: spotTexture("bench"),
      pond: spotTexture("pond"),
      campfire: spotTexture("campfire"),
      garden: spotTexture("garden"),
    },
  };
  return cache;
}
