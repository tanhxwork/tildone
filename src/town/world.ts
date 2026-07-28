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
 *  buildings never touch and there is always a walkable ring to path around.
 *
 *  The house is a small open-front office. Its rows are:
 *    ty            roof (tinted per project)
 *    ty+1          back wall (framed art)
 *    ty+2          desk row — one desk + monitor per workstation column
 *    ty+3 (=aisle) walkable interior floor — the seats, where workers sit
 *  and its columns are `tx` (left wall) … `tx+BUILDING_W-1` (right wall) with
 *  the interior columns `tx+1 … tx+BUILDING_W-2` between them. Only the aisle
 *  row's interior columns are walkable; the door at the bottom-centre is the one
 *  opening into that pocket, so it is a cul-de-sac off the green — working
 *  characters walk in to sit, and wanderers never route through it. */
const BUILDING_W = 6;
const BUILDING_H = 4;
/** Interior columns (between the two side walls) = the workstation count. */
const INTERIOR_W = BUILDING_W - 2; // 4 desks/seats
const MARGIN_X = 2; // green on each side → cell is BUILDING_W + 2*MARGIN_X wide
const MARGIN_TOP = 1;
const MARGIN_BOTTOM = 3; // extra green below for the door/desk apron + paths
export const CELL_W = BUILDING_W + MARGIN_X * 2; // 10
export const CELL_H = BUILDING_H + MARGIN_TOP + MARGIN_BOTTOM; // 8

export interface Tile {
  x: number;
  y: number;
}

export interface BuildingPlacement {
  room: TownRoom;
  /** Footprint top-left tile and size (mostly obstacle tiles; the interior
   *  aisle row is walkable — see `seats`). */
  tx: number;
  ty: number;
  tw: number;
  th: number;
  /** Walkable tile directly in front of the building — the entry a spawning
   *  character appears at, and the one opening into the interior aisle. */
  door: Tile;
  /** Interior seat tiles (walkable), one per workstation, left→right along the
   *  aisle row. A `working` character sits on one, facing up into the monitor on
   *  the desk row directly above. */
  seats: Tile[];
  /** Desk tiles (blocked) directly above each seat — where a monitor is drawn. */
  desks: Tile[];
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
    const aisleRow = ty + BUILDING_H - 1; // interior floor = the seat row
    const deskRow = aisleRow - 1;
    for (let dy = 0; dy < BUILDING_H; dy++) {
      for (let dx = 0; dx < BUILDING_W; dx++) {
        // Block the whole footprint EXCEPT the interior columns of the aisle row,
        // which are the walkable seats reachable only via the door below.
        const isAisleInterior =
          ty + dy === aisleRow && dx >= 1 && dx <= INTERIOR_W;
        blocked[idx(tx + dx, ty + dy, cols)] = !isAisleInterior;
      }
    }
    const seats: Tile[] = [];
    const desks: Tile[] = [];
    for (let i = 0; i < INTERIOR_W; i++) {
      seats.push({ x: tx + 1 + i, y: aisleRow });
      desks.push({ x: tx + 1 + i, y: deskRow });
    }
    // Door: the walkable green tile centred just below the footprint, directly
    // under one of the interior seats so it opens into the aisle.
    const door: Tile = { x: tx + 1 + Math.floor((INTERIOR_W - 1) / 2), y: ty + BUILDING_H };
    return { room, tx, ty, tw: BUILDING_W, th: BUILDING_H, door, seats, desks };
  });

  // Shared leisure spots: one per building cell, tucked into the cell's
  // lower-right green (the footprint spans cols MARGIN_X..MARGIN_X+BUILDING_W-1,
  // so the right margin and the rows below the footprint are always green) —
  // spread across the map so idle characters have somewhere to go. Kinds cycle
  // bench/pond/campfire/garden.
  const spots: LeisureSpot[] = model.rooms.map((_, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    return {
      id: i,
      tile: { x: col * CELL_W + CELL_W - 2, y: row * CELL_H + CELL_H - 1 },
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
