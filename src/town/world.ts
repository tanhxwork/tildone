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

/** Desks (= workroom seats) per tier. */
const TIER_DESKS: Record<BuildingTier, number> = { small: 2, medium: 4, large: 6 };
/** Interior floor size per tier, in tiles, excluding the surrounding walls. A
 *  house is sized to hold *rooms* — the old geometry gave a building a single
 *  one-tile-tall aisle, which is a corridor, and read as one. */
const TIER_INTERIOR: Record<BuildingTier, { w: number; h: number }> = {
  small: { w: 6, h: 5 },
  medium: { w: 8, h: 6 },
  large: { w: 10, h: 7 },
};

function tierFor(openTaskCount: number): BuildingTier {
  if (openTaskCount > 6) return "large";
  if (openTaskCount > 2) return "medium";
  return "small";
}

/** Largest possible building footprint — the cell is sized to hold it, so the
 *  lattice stays regular whatever tier each building is. Walls ring the interior,
 *  and the bottom row is the facade (front wall + door), which stays visible when
 *  the roof lifts. */
const MAX_BUILDING_W = TIER_INTERIOR.large.w + 2; // 12
const MAX_BUILDING_H = TIER_INTERIOR.large.h + 2; // 9

const TOP_MARGIN = 1; // green above a building (the roof never touches the cell edge)
/** Green between a building's front wall and the street. A house set straight
 *  onto the road reads as a shopfront; a setback with a fence, a mown yard and a
 *  path to the gate is what makes it read as somewhere someone lives. */
const YARD_DEPTH = 3;
/** Row within every cell where the road sits — buildings are bottom-aligned to
 *  their yard, so every gate opens onto the same street. */
const ROAD_ROW = TOP_MARGIN + MAX_BUILDING_H + YARD_DEPTH; // 13
const BELOW_MARGIN = 2; // green below the road before the next cell

/** One cell of the town lattice (holds a building or the plaza), in tiles. The
 *  width leaves two tiles either side of the widest building so a lot's fence
 *  never has to sit on the street. */
export const CELL_W = MAX_BUILDING_W + 5; // 17
export const CELL_H = ROAD_ROW + 1 + BELOW_MARGIN; // 16

/** A piece of interior furniture. Everything except `rug` is blocked — the floor
 *  plan is walls and furniture around open circulation space, which is what makes
 *  a room read as a room rather than a grid of objects. */
export type FurnitureKind =
  | "desk"
  | "counter"
  | "sink"
  | "table"
  | "chair"
  | "sofa"
  | "bookshelf"
  | "bed"
  | "nightstand"
  | "rug"
  | "plant";

export interface Furniture {
  tile: Tile;
  kind: FurnitureKind;
}

export interface BuildingPlacement {
  room: TownRoom;
  tier: BuildingTier;
  /** Footprint top-left tile and size. The wall ring and the furniture are
   *  blocked; the interior floor, the seats and the doorway are walkable. */
  tx: number;
  ty: number;
  tw: number;
  th: number;
  /** The interior floor region (inside the wall ring). */
  interior: Rect;
  /** Row of the facade — the front wall holding the door. Everything above it is
   *  under the roof, which lifts when the building is occupied. */
  frontWallY: number;
  /** Walkable yard tile directly in front of the doorway — the entry a spawning
   *  character appears at, where it paces when blocked, and where overflow rests.
   *  The wall gap is one tile up, at (door.x, door.y - 1). */
  door: Tile;
  /** The gate in the fence, on the street. Walkable; the path runs door → gate. */
  gate: Tile;
  /** Interior seat tiles (walkable), one per desk, left→right along the workroom
   *  row. A `working` character sits on one, facing up into the monitor above. */
  seats: Tile[];
  /** Desk tiles (blocked) directly above each seat — where a monitor is drawn. */
  desks: Tile[];
  /** Interior partition walls (blocked) dividing the house into rooms. */
  partitions: Tile[];
  /** Everything else in the house, for the renderer to draw. */
  furniture: Furniture[];
}

/** A shared leisure activity an idle character can visit (clustered in the plaza). */
export type SpotKind = "bench" | "pond" | "campfire" | "garden";

export interface LeisureSpot {
  id: number;
  tile: Tile;
  kind: SpotKind;
}

const SPOT_KINDS: SpotKind[] = ["bench", "pond", "campfire", "garden"];

/** A furnishing that is *not* a leisure spot: blocked, so characters path around
 *  it rather than stand on it. These exist so a space reads as somewhere people
 *  use — an empty rectangle of pavement reads as a car park. */
export type PropKind =
  | "planter"
  | "noticeboard"
  | "market"
  | "coffeecart"
  | "cafetable";

export interface TownProp {
  tile: Tile;
  kind: PropKind;
}

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
   *  whichever is free (see stepTownSim). Spots are exclusive — one character
   *  each — so this array's length *is* the town's simultaneous leisure
   *  capacity, and it is budgeted against the plaza's open area rather than
   *  fixed (see furnishPlaza). */
  spots: LeisureSpot[];
  /** Blocked furnishings (planters, notice board, market stall, …) the renderer
   *  draws and the pathfinder routes around. */
  props: TownProp[];
  /** Row-major mask of mown lot grass — walkable; a rendering hint so a fenced
   *  yard reads as managed ground rather than the same wild green as everywhere
   *  else. */
  yard: boolean[];
  /** Row-major mask of worn path (door → gate → street). Walkable. */
  path: boolean[];
  /** Fence posts ringing each lot. Blocked, so characters use the gate. */
  fences: Tile[];
  /** Street-lamp tiles lining the roads. Blocked (so characters path around
   *  them, never through) and rendered + lit at night by the Pixi layer. */
  lamps: Tile[];
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
  const yard = new Array<boolean>(cols * rows).fill(false);
  const path = new Array<boolean>(cols * rows).fill(false);
  const fences: Tile[] = [];

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
  let plazaCellX = 0;
  let plazaCellY = 0;

  for (let cell = 0; cell < total; cell++) {
    const col = cell % perRow;
    const row = Math.floor(cell / perRow);
    const cellX = col * CELL_W;
    const cellY = row * CELL_H;

    if (cell === plazaCell) {
      // The plaza is the cell's building-region: an open walkable square (no
      // footprint blocked here). Its floor is painted as pavement for contrast.
      plazaCellX = cellX;
      plazaCellY = cellY;
      // The square is capped rather than filling the (building-sized) cell — a
      // commons wants to be human-scaled, not the size of the largest house.
      const pw = Math.min(CELL_W - 2, 13);
      const ph = Math.min(ROAD_ROW - 1, 10);
      plaza = {
        x: cellX + Math.floor((CELL_W - pw) / 2),
        y: cellY + Math.floor((ROAD_ROW - ph) / 2),
        w: pw,
        h: ph,
      };
      for (let dy = 0; dy < plaza.h; dy++) {
        for (let dx = 0; dx < plaza.w; dx++) road[idx(plaza.x + dx, plaza.y + dy, cols)] = true;
      }
      continue;
    }

    const roomForCell = rooms[roomPtr++];
    buildings.push(placeBuilding(roomForCell, cellX, cellY, cols, blocked));
  }

  // Lots are fenced after every footprint is written, so a fence can never be
  // laid over a neighbour's wall.
  for (const b of buildings) {
    furnishLot(b, cols, rows, blocked, road, yard, path, fences);
  }

  // A fountain centrepiece anchors the plaza: block its centre tile so the
  // commons has a focal point idle characters gather around, not stand on. Only
  // when the plaza can spare an interior tile (leave a walkable ring).
  let plazaCenter: Tile | null = null;
  if (plaza.w >= 3 && plaza.h >= 3) {
    plazaCenter = { x: plaza.x + Math.floor(plaza.w / 2), y: plaza.y + Math.floor(plaza.h / 2) };
    blocked[idx(plazaCenter.x, plazaCenter.y, cols)] = true;
  }

  // Furnish the commons, then put water/fire/planting on the green beside it.
  const spots: LeisureSpot[] = [];
  const props: TownProp[] = [];
  furnishPlaza(plaza, cols, blocked, spots, props);
  furnishCommonsGreen(plazaCellX, plazaCellY, cols, rows, blocked, road, spots);

  // Street lamps: one every few columns on the green immediately south of a
  // horizontal road. Blocked so pathfinding routes around them (a departure
  // path must not thread a lamp post), and exposed so the renderer draws + lights
  // them. Sparse single tiles beside (never on) the roads, so blocking them
  // can't disconnect a door from the plaza or the walk-off edge.
  const lamps: Tile[] = [];
  const edgeX = Math.floor(cols / 2);
  const LAMP_GAP = 5;
  // A lamp must never land on a leisure spot — a spot is walkable, so blocking it
  // would strand its claimant and quietly cost the town a seat.
  const spotTiles = new Set(spots.map((s) => `${s.tile.x},${s.tile.y}`));
  for (let y = 1; y < rows; y++) {
    for (let x = 2; x < cols; x += LAMP_GAP) {
      if (x === edgeX && y === rows - 1) continue; // never block the walk-off edge
      if (spotTiles.has(`${x},${y}`)) continue;
      const here = idx(x, y, cols);
      if (road[here] || blocked[here] || !road[idx(x, y - 1, cols)]) continue;
      blocked[here] = true;
      lamps.push({ x, y });
    }
  }

  return {
    cols,
    rows,
    buildings,
    blocked,
    road,
    plaza,
    plazaCenter,
    edge: { x: edgeX, y: rows - 1 },
    spots,
    props,
    yard,
    path,
    fences,
    lamps,
  };
}

/**
 * Furnish the commons.
 *
 * An empty rectangle of pavement reads as a car park, not a square. Whyte's
 * study of why plazas fail found the strongest predictor of a public space
 * being used is sitting space — roughly one linear foot of seat per thirty
 * square feet of open area — so seating here is *budgeted* against the plaza's
 * area rather than decorative, and it is deliberately varied: a bench run along
 * the north edge (sitting up front), pairs flanking the fountain (off to the
 * side, facing the water), and a cafe table (in a group). The blocked props are
 * "triangulation" objects — a notice board, a market stall, a coffee cart give
 * strangers a reason to stand in the same place, which is what makes a group
 * form at all.
 *
 * Falls back to the old one-of-each-kind corner layout for a plaza too small to
 * lay this out in.
 */
function furnishPlaza(
  plaza: Rect,
  cols: number,
  blocked: boolean[],
  spots: LeisureSpot[],
  props: TownProp[],
) {
  const { x, y, w, h } = plaza;
  const free = (dx: number, dy: number) => !blocked[idx(x + dx, y + dy, cols)];
  const taken = new Set<string>();
  const seat = (dx: number, dy: number) => {
    if (!free(dx, dy)) return;
    const key = `${x + dx},${y + dy}`;
    if (taken.has(key)) return; // candidate lists overlap; one seat per tile
    taken.add(key);
    spots.push({ id: spots.length, tile: { x: x + dx, y: y + dy }, kind: "bench" });
  };
  const prop = (dx: number, dy: number, kind: PropKind) => {
    if (!free(dx, dy)) return;
    blocked[idx(x + dx, y + dy, cols)] = true;
    props.push({ tile: { x: x + dx, y: y + dy }, kind });
  };

  if (w < 9 || h < 6) {
    if (w >= 3 && h >= 3) {
      const corners: [number, number][] = [
        [1, 1],
        [w - 2, 1],
        [1, h - 2],
        [w - 2, h - 2],
      ];
      corners.forEach(([dx, dy], i) => {
        if (!free(dx, dy)) return;
        spots.push({
          id: spots.length,
          tile: { x: x + dx, y: y + dy },
          kind: SPOT_KINDS[i % SPOT_KINDS.length],
        });
      });
    }
    return;
  }

  // --- Fixed furniture first, so the seat budget is measured against what is
  // actually left open. ---

  // Planters at the corners so the square has a defined edge instead of simply
  // stopping where the pavement runs out (Whyte: the street/plaza transition is
  // what decides whether a space is entered at all).
  prop(0, 0, "planter");
  prop(w - 1, 0, "planter");
  prop(0, h - 1, "planter");
  prop(w - 1, h - 1, "planter");

  // Triangulation objects on the east and west edges.
  prop(0, 2, "noticeboard");
  prop(w - 1, 2, "coffeecart");

  // South edge: a market stall, and cafe tables with a chair either side.
  prop(1, h - 1, "market");
  prop(2, h - 1, "market");
  const cafes: number[] = [w - 5];
  if (w >= 13) cafes.push(5);
  for (const cx of cafes) prop(cx, h - 1, "cafetable");

  // --- Seating, budgeted against the open area rather than counted out by hand,
  // so a bigger square gets a proportionally bigger set of places to sit. ---
  let open = 0;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) if (free(dx, dy)) open++;
  }
  const target = Math.ceil(open / 5);

  // Candidates in priority order. Perimeter runs first (people sit at the edge
  // of a space and look into it, never in the middle of it), broken by gaps so a
  // run reads as several groups rather than one endless bench; then the pairs
  // facing the fountain; then a second rank in from the edge if the square is
  // big enough to need it.
  const candidates: [number, number][] = [];
  const midY = Math.floor(h / 2);
  for (const cx of cafes) {
    candidates.push([cx - 1, h - 1], [cx + 1, h - 1]);
  }
  for (let dx = 1; dx <= w - 2; dx++) if (dx % 4 !== 0) candidates.push([dx, 0]);
  for (let dx = 1; dx <= w - 2; dx++) if (dx % 4 !== 0) candidates.push([dx, h - 1]);
  for (const dy of [midY, midY + 1]) candidates.push([2, dy], [w - 3, dy]);
  for (let dy = 3; dy <= h - 4; dy++) if (dy % 3 !== 0) candidates.push([0, dy], [w - 1, dy]);
  for (let dx = 2; dx <= w - 3; dx++) if (dx % 4 === 1) candidates.push([dx, 2], [dx, h - 3]);

  for (const [dx, dy] of candidates) {
    if (spots.length >= target) break;
    seat(dx, dy);
  }
}

/**
 * Water, fire and a vegetable plot belong on the green at the commons' edge, not
 * on the pavement — a pond in the middle of a paved square was one of the things
 * that made the town read as assembled rather than built. They stay leisure
 * spots (somewhere to go), just somewhere that makes sense.
 */
function furnishCommonsGreen(
  cellX: number,
  cellY: number,
  cols: number,
  rows: number,
  blocked: boolean[],
  road: boolean[],
  spots: LeisureSpot[],
) {
  const y = cellY + ROAD_ROW + 1; // the green strip immediately south of the street
  if (y >= rows) return;
  const plan: [number, SpotKind][] = [
    [2, "pond"],
    [5, "campfire"],
    [8, "garden"],
  ];
  for (const [dx, kind] of plan) {
    const x = cellX + dx;
    if (x >= cols) continue;
    const here = idx(x, y, cols);
    if (blocked[here] || road[here]) continue;
    spots.push({ id: spots.length, tile: { x, y }, kind });
  }
}

/**
 * Place one building in its cell and lay out its floor plan.
 *
 * A house is a wall ring around an open interior, entered through one door in
 * the facade — the bottom row, which stays visible when the roof lifts. Inside,
 * the plan is a workroom across the back (the desks, which are what the project
 * actually is), a circulation row, and the home rooms below it off a hall:
 * kitchen to one side, lounge to the other, with a bed nook in the larger tiers.
 *
 * The rule the old geometry broke is that a room needs *more floor than
 * furniture*: everything here hugs a wall and the hall stays clear, so the plan
 * reads as rooms rather than as a grid of objects. The workroom seats stay
 * reachable only through the front door, so wanderers never route through a
 * house — the cul-de-sac property the sim depends on.
 */
function placeBuilding(
  room: TownRoom,
  cellX: number,
  cellY: number,
  cols: number,
  blocked: boolean[],
): BuildingPlacement {
  const tier = tierFor(room.openTaskCount);
  const deskCount = TIER_DESKS[tier];
  const { w: iw, h: ih } = TIER_INTERIOR[tier];
  const bw = iw + 2;
  const bh = ih + 2;

  const tx = cellX + Math.floor((CELL_W - bw) / 2);
  // Bottom-aligned to the yard, so every facade stands the same setback back
  // from the street whatever the tier.
  const ty = cellY + ROAD_ROW - YARD_DEPTH - bh;
  const ix = tx + 1; // interior origin
  const iy = ty + 1;
  const frontWallY = ty + bh - 1;
  const hallCol = Math.floor((iw - 1) / 2);

  // Wall ring blocked, interior floor open.
  for (let dy = 0; dy < bh; dy++) {
    for (let dx = 0; dx < bw; dx++) {
      const onRing = dx === 0 || dx === bw - 1 || dy === 0 || dy === bh - 1;
      blocked[idx(tx + dx, ty + dy, cols)] = onRing;
    }
  }
  // The single doorway through the facade.
  blocked[idx(ix + hallCol, frontWallY, cols)] = false;

  const seats: Tile[] = [];
  const desks: Tile[] = [];
  const partitions: Tile[] = [];
  const furniture: Furniture[] = [];
  /** Furniture you can stand on — a chair is for sitting, a rug is floor. */
  const walkableKind = (k: FurnitureKind) => k === "rug" || k === "chair";
  const put = (lx: number, ly: number, kind: FurnitureKind) => {
    if (lx < 0 || ly < 0 || lx >= iw || ly >= ih) return;
    const tile = { x: ix + lx, y: iy + ly };
    if (!walkableKind(kind)) blocked[idx(tile.x, tile.y, cols)] = true;
    furniture.push({ tile, kind });
  };

  // --- Workroom: a desk counter along the back wall, seats below it. ---
  const deskStart = Math.floor((iw - deskCount) / 2);
  for (let i = 0; i < deskCount; i++) {
    const lx = deskStart + i;
    put(lx, 0, "desk");
    desks.push({ x: ix + lx, y: iy });
    seats.push({ x: ix + lx, y: iy + 1 });
  }
  put(0, 0, "plant"); // back corners
  put(iw - 1, 0, "plant");

  // --- Rooms below: a partition where there is height for one, else open plan.
  // Row 2 is left clear as circulation between the workroom and the home. ---
  const hasPartition = ih >= 7;
  const homeTop = hasPartition ? 4 : 3;
  if (hasPartition) {
    for (let lx = 0; lx < iw; lx++) {
      if (lx === hallCol) continue; // the doorway through to the workroom
      const tile = { x: ix + lx, y: iy + 3 };
      blocked[idx(tile.x, tile.y, cols)] = true;
      partitions.push(tile);
    }
  }

  // --- Kitchen, left of the hall: a counter run with a sink, then a table. ---
  put(0, homeTop, "counter");
  if (hallCol > 1) put(1, homeTop, "counter");
  if (hallCol > 2) put(2, homeTop, "sink");
  if (homeTop + 1 < ih) {
    put(1, homeTop + 1, "table");
    put(0, homeTop + 1, "chair");
    if (hallCol > 2) put(2, homeTop + 1, "chair");
  }

  // --- Lounge, right of the hall: a sofa, a rug in front of it, a bookshelf. ---
  put(hallCol + 1, homeTop, "sofa");
  if (hallCol + 2 < iw - 1) put(hallCol + 2, homeTop, "sofa");
  put(iw - 1, homeTop, "bookshelf");
  if (homeTop + 1 < ih) {
    put(hallCol + 1, homeTop + 1, "rug");
    put(hallCol + 2, homeTop + 1, "rug");
  }

  // --- Bed nook along the back of the home area, where there is a third row. ---
  if (ih - 1 >= homeTop + 2) {
    put(0, ih - 1, "bed");
    if (hallCol > 1) put(1, ih - 1, "bed");
    if (hallCol > 2) put(2, ih - 1, "nightstand");
    put(iw - 1, ih - 1, "plant");
  }

  const door: Tile = { x: ix + hallCol, y: frontWallY + 1 }; // the yard apron
  const gate: Tile = { x: door.x, y: frontWallY + YARD_DEPTH };

  return {
    room,
    tier,
    tx,
    ty,
    tw: bw,
    th: bh,
    interior: { x: ix, y: iy, w: iw, h: ih },
    frontWallY,
    door,
    gate,
    seats,
    desks,
    partitions,
    furniture,
  };
}

/**
 * Fence a building's lot, mow the yard inside it, and lay a path from the front
 * door out to a gate on the street.
 *
 * This is the cheapest change that makes a building look inhabited: managed
 * ground — a boundary, cut grass, a worn path — is what tells the eye that
 * someone lives here, as opposed to a house dropped on undifferentiated green.
 * The fence never covers a road tile, and the gate is always open, so a lot can
 * never island its own front door.
 */
function furnishLot(
  b: BuildingPlacement,
  cols: number,
  rows: number,
  blocked: boolean[],
  road: boolean[],
  yard: boolean[],
  path: boolean[],
  fences: Tile[],
) {
  const left = b.tx - 1;
  const right = b.tx + b.tw;
  const top = b.ty - 1;
  const bottom = b.frontWallY + YARD_DEPTH;
  const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows;

  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      if (!inBounds(x, y)) continue;
      const here = idx(x, y, cols);
      if (road[here]) continue; // never build over the street
      const onFence = x === left || x === right || y === top || y === bottom;
      if (onFence) {
        if (x === b.gate.x && y === bottom) continue; // the gate stays open
        if (blocked[here]) continue; // don't double-up on a wall
        blocked[here] = true;
        fences.push({ x, y });
      } else if (!blocked[here]) {
        yard[here] = true; // mown grass inside the fence
      }
    }
  }

  // The worn path: front door → gate. Marked over the yard so it reads as the
  // route people actually take (a desire path), not decoration.
  for (let y = b.door.y; y <= bottom; y++) {
    if (!inBounds(b.door.x, y)) continue;
    const here = idx(b.door.x, y, cols);
    if (blocked[here]) continue;
    path[here] = true;
    yard[here] = false;
  }
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
