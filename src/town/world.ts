// Town world geometry — the contiguous tiled overworld the living sim moves on.
//
// v1 laid projects out as a wrapping grid of discrete card-rooms in *pixel*
// space. v2 made it a tiled world of buildings on a green. v3 makes it a real
// *town*: buildings sit on a lattice of cells threaded by roads, arranged around
// a central plaza; the world is sized to the roster (not the viewport), so it is
// bigger than the screen and a camera scrolls it (see camera.ts / TownView).
//
// A building is an enclosed open-front office: an interior aisle of desk seats
// reachable only through one door on the road — a true cul-de-sac, so wanderers
// never route through it and a worker enters through the door to sit. A
// building's size scales with its project's open-task count (small/medium/large
// → 2/4/6 desks), so a busy project reads as a bigger building.
//
// This module is pure and deterministic — same model → same world — so the
// walkability grid, footprints, roads, plaza and the desk/door/despawn anchors
// are all unit-testable (tests/townWorld.test.ts); the Pixi layer is a dumb
// renderer of what it computes. Coordinates are integer TILE units; pixel
// conversion (tile → screen) is the renderer's job via TILE_PX.

import type { TownModel, TownRoom } from "../selectors";

/** Art pixels per tile (Kenney Tiny Town is 16px); the renderer draws at scale. */
export const TILE_PX = 16;

export interface Tile {
  x: number;
  y: number;
}

/** A building's size class, from its project's open-task count. */
export type BuildingTier = "small" | "medium" | "large";

/** Desks (= interior seats = interior columns) per tier. */
const TIER_DESKS: Record<BuildingTier, number> = { small: 2, medium: 4, large: 6 };
/** Upper wall rows (facade height) per tier — a large project gets a taller house. */
const TIER_WALL_ROWS: Record<BuildingTier, number> = { small: 1, medium: 1, large: 2 };

function tierFor(openTaskCount: number): BuildingTier {
  if (openTaskCount > 6) return "large";
  if (openTaskCount > 2) return "medium";
  return "small";
}

/** Largest possible building footprint — the cell is sized to hold it, so the
 *  lattice stays regular whatever tier each building is. */
const MAX_BUILDING_W = TIER_DESKS.large + 2; // 8
const MAX_BUILDING_H = 1 /*roof*/ + TIER_WALL_ROWS.large + 1 /*desk*/ + 1 /*aisle*/ + 1 /*front*/; // 6

const TOP_MARGIN = 1; // green above a building (roof never touches the cell edge)
/** Row within every cell where the road (and each door's apron) sits — buildings
 *  are bottom-aligned to it so all doors open onto the same street. */
const ROAD_ROW = TOP_MARGIN + MAX_BUILDING_H; // 7
const BELOW_MARGIN = 2; // green below the road before the next cell

/** One cell of the town lattice (holds a building or the plaza), in tiles. */
export const CELL_W = MAX_BUILDING_W + 3; // 11
export const CELL_H = ROAD_ROW + 1 + BELOW_MARGIN; // 10

export interface BuildingPlacement {
  room: TownRoom;
  tier: BuildingTier;
  /** Footprint top-left tile and size (mostly obstacle tiles; the interior aisle
   *  seats and the single doorway are the only walkable footprint tiles). */
  tx: number;
  ty: number;
  tw: number;
  th: number;
  /** Walkable road tile directly in front of the doorway — the entry a spawning
   *  character appears at, where it paces when blocked, and where overflow rests.
   *  The actual wall gap is one tile up, at (door.x, door.y - 1). */
  door: Tile;
  /** Interior seat tiles (walkable), one per desk, left→right along the aisle
   *  row. A `working` character sits on one, facing up into the monitor above. */
  seats: Tile[];
  /** Desk tiles (blocked) directly above each seat — where a monitor is drawn. */
  desks: Tile[];
}

/** A shared leisure activity an idle character can visit (clustered in the plaza). */
export type SpotKind = "bench" | "pond" | "campfire" | "garden";

export interface LeisureSpot {
  id: number;
  tile: Tile;
  kind: SpotKind;
}

const SPOT_KINDS: SpotKind[] = ["bench", "pond", "campfire", "garden"];

/** A rectangle of tiles (used for the plaza). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TownWorld {
  /** Grid extent in tiles (roster-driven, independent of the viewport). */
  cols: number;
  rows: number;
  /** Buildings in model order (projects by position, Inbox last). */
  buildings: BuildingPlacement[];
  /** Row-major `rows*cols` obstacle mask; true = blocked (building footprint). */
  blocked: boolean[];
  /** Row-major road/pavement mask; true = a road or plaza-floor tile (all
   *  walkable — purely a rendering hint so streets read as streets). */
  road: boolean[];
  /** The central open plaza (walkable) where idle characters gather. */
  plaza: Rect;
  /** The plaza's centre tile — blocked and rendered as a fountain centrepiece
   *  (null for a plaza too small to spare a centre tile). Idle characters gather
   *  around it; wander already skips blocked tiles so none stands in the water. */
  plazaCenter: Tile | null;
  /** A walkable tile at the bottom-centre edge — the despawn / walk-off target. */
  edge: Tile;
  /** Shared leisure spots, clustered in the plaza. Any idle character walks to
   *  whichever is free (see stepTownSim). */
  spots: LeisureSpot[];
}

function idx(x: number, y: number, cols: number): number {
  return y * cols + x;
}

/**
 * Build the tiled world from the town roster. Buildings + one central plaza wrap
 * into a roughly-square lattice of equal cells (so the town grows outward, not
 * into a strip); roads thread the lattice so every door connects to the plaza.
 * The world is sized to the roster — `_viewportWidth`/`scale` are accepted for
 * call-site compatibility but no longer drive the layout (a camera scrolls it).
 */
export function buildWorld(
  model: TownModel,
  _viewportWidth?: number,
  _scale = 2,
): TownWorld {
  const rooms = model.rooms;
  const n = rooms.length;
  const total = n + 1; // +1 cell reserved for the central plaza
  const perRow = Math.max(1, Math.ceil(Math.sqrt(total)));
  const rowCount = Math.max(1, Math.ceil(total / perRow));
  const cols = perRow * CELL_W;
  const rows = rowCount * CELL_H;

  const blocked = new Array<boolean>(cols * rows).fill(false);
  const road = new Array<boolean>(cols * rows).fill(false);

  // Roads: a horizontal street through every cell row (at ROAD_ROW) and a
  // vertical street down every cell column (at the cell's left edge). Because
  // every cell shares the same relative road lines, the per-cell segments join
  // into one connected lattice — every door and the plaza are reachable.
  for (let r = 0; r < rowCount; r++) {
    const y = r * CELL_H + ROAD_ROW;
    for (let x = 0; x < cols; x++) road[idx(x, y, cols)] = true;
  }
  for (let c = 0; c < perRow; c++) {
    const x = c * CELL_W;
    for (let y = 0; y < rows; y++) road[idx(x, y, cols)] = true;
  }

  // The plaza takes the most central cell; buildings fill the rest in model
  // order. Clamp so a small/partly-filled grid still has a real plaza cell.
  const plazaCell = Math.min(
    total - 1,
    Math.floor(rowCount / 2) * perRow + Math.floor(perRow / 2),
  );

  const buildings: BuildingPlacement[] = [];
  let roomPtr = 0;
  let plaza: Rect = { x: 0, y: 0, w: 0, h: 0 };

  for (let cell = 0; cell < total; cell++) {
    const col = cell % perRow;
    const row = Math.floor(cell / perRow);
    const cellX = col * CELL_W;
    const cellY = row * CELL_H;

    if (cell === plazaCell) {
      // The plaza is the cell's building-region: an open walkable square (no
      // footprint blocked here). Its floor is painted as pavement for contrast.
      plaza = { x: cellX + 1, y: cellY + 1, w: CELL_W - 2, h: ROAD_ROW - 1 };
      for (let dy = 0; dy < plaza.h; dy++) {
        for (let dx = 0; dx < plaza.w; dx++) road[idx(plaza.x + dx, plaza.y + dy, cols)] = true;
      }
      continue;
    }

    const roomForCell = rooms[roomPtr++];
    buildings.push(placeBuilding(roomForCell, cellX, cellY, cols, blocked));
  }

  // A fountain centrepiece anchors the plaza: block its centre tile so the
  // commons has a focal point idle characters gather around, not stand on. Only
  // when the plaza can spare an interior tile (leave a walkable ring).
  let plazaCenter: Tile | null = null;
  if (plaza.w >= 3 && plaza.h >= 3) {
    plazaCenter = { x: plaza.x + Math.floor(plaza.w / 2), y: plaza.y + Math.floor(plaza.h / 2) };
    blocked[idx(plazaCenter.x, plazaCenter.y, cols)] = true;
  }

  // Leisure spots cluster at the plaza corners (one of each kind). Guard tiny
  // plazas so a spot never lands outside it.
  const spots: LeisureSpot[] = [];
  if (plaza.w >= 3 && plaza.h >= 3) {
    const corners: Tile[] = [
      { x: plaza.x + 1, y: plaza.y + 1 },
      { x: plaza.x + plaza.w - 2, y: plaza.y + 1 },
      { x: plaza.x + 1, y: plaza.y + plaza.h - 2 },
      { x: plaza.x + plaza.w - 2, y: plaza.y + plaza.h - 2 },
    ];
    corners.forEach((tile, i) => spots.push({ id: i, tile, kind: SPOT_KINDS[i % SPOT_KINDS.length] }));
  }

  return {
    cols,
    rows,
    buildings,
    blocked,
    road,
    plaza,
    plazaCenter,
    edge: { x: Math.floor(cols / 2), y: rows - 1 },
    spots,
  };
}

/** Place one building in its cell: bottom-aligned so its door lands on the road,
 *  horizontally centred, enclosed except a single doorway. Writes its footprint
 *  into `blocked` and returns the placement. */
function placeBuilding(
  room: TownRoom,
  cellX: number,
  cellY: number,
  cols: number,
  blocked: boolean[],
): BuildingPlacement {
  const tier = tierFor(room.openTaskCount);
  const desks = TIER_DESKS[tier];
  const wallRows = TIER_WALL_ROWS[tier];
  const bw = desks + 2;
  const bh = 1 /*roof*/ + wallRows + 1 /*desk*/ + 1 /*aisle*/ + 1 /*front wall*/;

  const tx = cellX + Math.floor((CELL_W - bw) / 2);
  const ty = cellY + ROAD_ROW - bh; // door apron (ty+bh) == the cell's road row

  const deskRow = 1 + wallRows; // rows within the footprint (0 = roof)
  const aisleRow = deskRow + 1;
  const frontRow = bh - 1;
  const doorCol = 1 + Math.floor((desks - 1) / 2); // interior column of the doorway

  for (let dy = 0; dy < bh; dy++) {
    for (let dx = 0; dx < bw; dx++) {
      // Walkable footprint tiles: the interior aisle seats, and the one doorway
      // in the front wall. Everything else (walls, desks, roof, front wall) is
      // blocked — so the aisle is a cul-de-sac reachable only through the door.
      const isSeat = dy === aisleRow && dx >= 1 && dx <= desks;
      const isDoorway = dy === frontRow && dx === doorCol;
      blocked[idx(tx + dx, ty + dy, cols)] = !(isSeat || isDoorway);
    }
  }

  const seats: Tile[] = [];
  const desksT: Tile[] = [];
  for (let i = 0; i < desks; i++) {
    seats.push({ x: tx + 1 + i, y: ty + aisleRow });
    desksT.push({ x: tx + 1 + i, y: ty + deskRow });
  }
  const door: Tile = { x: tx + doorCol, y: ty + bh }; // road apron below the doorway

  return { room, tier, tx, ty, tw: bw, th: bh, door, seats, desks: desksT };
}

/** In-bounds and not a building footprint (roads/plaza/green are all walkable). */
export function isWalkable(world: TownWorld, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= world.cols || y >= world.rows) return false;
  return !world.blocked[idx(x, y, world.cols)];
}

/** True if (x,y) is a road or plaza-floor tile (walkable pavement). */
export function isRoad(world: TownWorld, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= world.cols || y >= world.rows) return false;
  return world.road[idx(x, y, world.cols)];
}
