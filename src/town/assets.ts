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
  };
  return cache;
}
