// Town world geometry — the contiguous tiled overworld the living sim moves on.
//
// v1 laid projects out as a wrapping grid of discrete card-rooms in *pixel*
// space (layout.ts). The living sim instead needs a single contiguous world of
// *tiles*: buildings (one per project, the former "rooms") sit on a shared green
// as obstacles, and characters walk the walkable tiles between them. This module
// is pure and deterministic — same model + viewport width → same world — so the
// walkability grid, building footprints, and the desk/door/despawn anchors are
// all unit-testable (tests/townWorld.test.ts), and the Pixi layer is a dumb
// renderer of what it computes.
//
// Coordinates are integer TILE units. Pixel conversion (tile → screen) is the
// renderer's job via TILE_PX; the sim and pathfinder never see pixels.

import type { TownModel, TownRoom } from "../selectors";

/** Art pixels per tile (Kenney Tiny Town is 16px); the renderer draws at scale. */
export const TILE_PX = 16;

/** One project's building cell, in tiles: a footprint plus a green margin so
 *  buildings never touch and there is always a walkable ring to path around. */
const BUILDING_W = 4;
const BUILDING_H = 3;
const MARGIN_X = 2; // green on each side → cell is BUILDING_W + 2*MARGIN_X wide
const MARGIN_TOP = 1;
const MARGIN_BOTTOM = 3; // extra green below for the door/desk apron + paths
export const CELL_W = BUILDING_W + MARGIN_X * 2; // 8
export const CELL_H = BUILDING_H + MARGIN_TOP + MARGIN_BOTTOM; // 7

export interface Tile {
  x: number;
  y: number;
}

export interface BuildingPlacement {
  room: TownRoom;
  /** Footprint top-left tile and size (obstacle tiles). */
  tx: number;
  ty: number;
  tw: number;
  th: number;
  /** Walkable tile directly in front of the building — where a `working`
   *  character stands, and the entry a spawning character appears at. */
  door: Tile;
}

/** A shared leisure activity an idle character can visit. */
export type SpotKind = "bench" | "pond" | "campfire" | "garden";

export interface LeisureSpot {
  id: number;
  tile: Tile;
  kind: SpotKind;
}

const SPOT_KINDS: SpotKind[] = ["bench", "pond", "campfire", "garden"];

export interface TownWorld {
  /** Grid extent in tiles. */
  cols: number;
  rows: number;
  /** Buildings in model order (projects by position, Inbox last). */
  buildings: BuildingPlacement[];
  /** Row-major `rows*cols` obstacle mask; true = building footprint (blocked). */
  blocked: boolean[];
  /** A walkable tile at the bottom-centre edge — the despawn / walk-off target. */
  edge: Tile;
  /** Shared leisure spots dotted across the green. Not per-project — any idle
   *  character walks to whichever is free (see stepTownSim). */
  spots: LeisureSpot[];
}

/** How many building cells fit across the given viewport width (≥1). */
export function buildingsPerRow(viewportWidth: number, scale: number): number {
  const tilePx = TILE_PX * scale;
  const viewTiles = Math.floor(Math.max(tilePx, viewportWidth) / tilePx);
  return Math.max(1, Math.floor(viewTiles / CELL_W));
}

function idx(x: number, y: number, cols: number): number {
  return y * cols + x;
}

/**
 * Build the tiled world from the town roster and viewport width. Buildings wrap
 * into a grid of equal cells; each cell holds a building footprint (blocked)
 * with a walkable apron. `scale` is the render scale used only to decide how
 * many cells fit across — the returned grid is pure tiles.
 */
export function buildWorld(
  model: TownModel,
  viewportWidth: number,
  scale = 2,
): TownWorld {
  const perRow = buildingsPerRow(viewportWidth, scale);
  const n = model.rooms.length;
  const rowCount = Math.max(1, Math.ceil(n / perRow));

  const cols = perRow * CELL_W;
  const rows = rowCount * CELL_H;
  const blocked = new Array<boolean>(cols * rows).fill(false);

  const buildings: BuildingPlacement[] = model.rooms.map((room, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const cellX = col * CELL_W;
    const cellY = row * CELL_H;
    const tx = cellX + MARGIN_X;
    const ty = cellY + MARGIN_TOP;
    for (let dy = 0; dy < BUILDING_H; dy++) {
      for (let dx = 0; dx < BUILDING_W; dx++) {
        blocked[idx(tx + dx, ty + dy, cols)] = true;
      }
    }
    // Door: the walkable tile centred just below the footprint.
    const door: Tile = { x: tx + Math.floor(BUILDING_W / 2), y: ty + BUILDING_H };
    return { room, tx, ty, tw: BUILDING_W, th: BUILDING_H, door };
  });

  // Shared leisure spots: one per building cell, tucked into the cell's
  // lower-right green (col 6 is outside the footprint cols 2..5; the cell's last
  // row is below the footprint) — always walkable, and spread across the map so
  // idle characters have somewhere to go. Kinds cycle bench/pond/campfire/garden.
  const spots: LeisureSpot[] = model.rooms.map((_, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    return {
      id: i,
      tile: { x: col * CELL_W + 6, y: row * CELL_H + CELL_H - 1 },
      kind: SPOT_KINDS[i % SPOT_KINDS.length],
    };
  });

  return {
    cols,
    rows,
    buildings,
    blocked,
    edge: { x: Math.floor(cols / 2), y: rows - 1 },
    spots,
  };
}

/** In-bounds and not a building footprint. */
export function isWalkable(world: TownWorld, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= world.cols || y >= world.rows) return false;
  return !world.blocked[idx(x, y, world.cols)];
}
