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

/** A piece of interior furniture. Everything except `rug` and `chair` is blocked
 *  — the floor plan is walls and furniture around open circulation space, which
 *  is what makes a room read as a room rather than a grid of objects. */
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
  | "plant"
  | ClutterKind;

/** The small personal things that make a house somebody's rather than anybody's.
 *  Chosen per project from its name (see `clutterFor`), which is why Alpha's
 *  house always looks like Alpha's house. Everything structural above is decided
 *  by the tier; everything here is decided by *whose* house it is. */
export type ClutterKind =
  | "mug"
  | "papers"
  | "laundry"
  | "guitar"
  | "boxes"
  | "catbed"
  | "bookstack";

/** What a character can *do* at a piece of furniture. The place tree (places.ts)
 *  already says where something is — "the counter, in the kitchen, in Alpha's
 *  house"; the verb is the other half of the sentence, and is what lets a working
 *  character take a trip to make coffee rather than only ever sitting still.
 *  Generative Agents (Park et al.) models an action as an (object, verb) pair for
 *  the same reason: a destination alone is not an activity. */
export type ActivityVerb =
  | "working"
  | "coffee"
  | "washing"
  | "eating"
  | "reading"
  | "resting"
  | "sleeping";

/** Which furniture affords what. Absent kinds are scenery — you walk past a
 *  bookshelf's neighbours all day, but only a bookshelf can be read at. */
const FURNITURE_VERB: Partial<Record<FurnitureKind, ActivityVerb>> = {
  desk: "working",
  counter: "coffee",
  sink: "washing",
  table: "eating",
  bookshelf: "reading",
  sofa: "resting",
  bed: "sleeping",
};

/**
 * Somewhere to stand, and the thing you stand there to use.
 *
 * The object itself is blocked — you cannot occupy a counter — so an affordance
 * is the *adjacent floor tile*, resolved here rather than in the sim, for the
 * same reason `pruneUnclaimableSpots` exists: only the builder can see the
 * finished grid, and an affordance whose standing tile got furnished over is
 * advertised capacity that silently never materialises.
 */
export interface Affordance {
  /** The walkable tile a character stands on to use it. */
  tile: Tile;
  /** The furniture being used. */
  object: Tile;
  kind: FurnitureKind;
  verb: ActivityVerb;
  room: RoomKind | null;
}

/** Where a character with nothing to do goes: beside the sofa by day, beside the
 *  bed at night. Both are walkable floor next to the blocked item. */
export interface RestSpot {
  tile: Tile;
  kind: "sofa" | "bed";
}

/** A named room of a house. "Room" here is the room you stand in — a project's
 *  place in the town is a **building** (glossary: `room` was renamed to
 *  `building` for that sense; `BuildingPlacement.room` is the legacy field name
 *  and still means the project). */
export type RoomKind = "workroom" | "hall" | "kitchen" | "lounge" | "bedroom";

export interface HouseRoom {
  kind: RoomKind;
  /** What to call it in prose: "the kitchen". */
  name: string;
  rect: Rect;
}

export interface Furniture {
  tile: Tile;
  kind: FurnitureKind;
  /** Which room it stands in, resolved from the room rects rather than declared
   *  at each `put()` — so a furniture item can never claim a room it is not in. */
  room: RoomKind | null;
}

export interface BuildingPlacement {
  /** The project this building belongs to (the legacy sense of "room"). */
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
  /** Interior partition walls (blocked) dividing the house into rooms. Empty in
   *  the wing plan below: at these interior sizes a wall costs a whole row of
   *  floor, and the rooms already read through the hall and through grouped
   *  furniture (Slynyrd's rule) without spending it. Kept because the renderer
   *  and the pathfinder treat it as data, not as a promise that it is non-empty. */
  partitions: Tile[];
  /** Everything else in the house, for the renderer to draw — the tier's fitted
   *  furniture *and* this project's clutter (which is also listed separately). */
  furniture: Furniture[];
  /** This project's personal things, a subset of `furniture`. Separate so the
   *  renderer can treat it as clutter and a test can assert two projects differ. */
  clutter: Furniture[];
  /** Standing tile + verb for everything usable in the house. Derived after the
   *  floor is finished, so every one of these is reachable. */
  affordances: Affordance[];
  /** Where a character rests when its session has gone quiet. */
  restSpots: RestSpot[];
  /** The named rooms of the house, as rects over the interior. Declared here so
   *  the renderer, the sim and the place tree all read one source rather than
   *  each re-deriving "where the kitchen is" from tile positions. */
  rooms: HouseRoom[];
  /** The fenced lot: the footprint plus its yard, out to the street. */
  lot: Rect;
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
  /** Cells deliberately left unbuilt: open green with water, a fire and a
   *  planted bed. What stops the grid reading as a grid of identical cells —
   *  and, incidentally, leisure capacity out among the streets rather than all
   *  of it on the square. Empty below four buildings. */
  parks: Rect[];
}

function idx(x: number, y: number, cols: number): number {
  return y * cols + x;
}

/** The four orthogonal steps — the only moves the pathfinder makes. */
const ORTHO: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Drop leisure spots a character could never actually claim.
 *
 * The sim routes around *every* spot tile except the one it is heading to, so a
 * character has to be able to stand on a tile next to its target that is not
 * itself a spot. A bench in the middle of a solid run, boxed in by a planter on
 * one side and a lamp on the other, satisfies plain walkability but can never be
 * reached — it is advertised capacity that silently never materialises, and an
 * idle character that picks it stalls at its door.
 *
 * Runs after every blocking pass (footprints, props, fountain, fences, lamps) so
 * it sees the finished grid. Ids are left alone rather than re-packed: they are
 * opaque keys for `sim.occupied`, and renumbering them across a rebuild would
 * silently transfer one character's claim to a different bench.
 */
function pruneUnclaimableSpots(
  spots: LeisureSpot[],
  blocked: boolean[],
  cols: number,
  rows: number,
): LeisureSpot[] {
  const spotTiles = new Set(spots.map((s) => `${s.tile.x},${s.tile.y}`));
  return spots.filter(({ tile }) =>
    ORTHO.some(([dx, dy]) => {
      const nx = tile.x + dx;
      const ny = tile.y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) return false;
      if (blocked[idx(nx, ny, cols)]) return false;
      return !spotTiles.has(`${nx},${ny}`);
    }),
  );
}

/**
 * Build the tiled world from the town roster. Buildings + one central plaza wrap
 * into a roughly-square lattice of equal cells (so the town grows outward, not
 * into a strip); roads thread the lattice so every door connects to the plaza.
 * The world is sized to the roster — `_viewportWidth`/`scale` are accepted for
 * call-site compatibility but no longer drive the layout (a camera scrolls it).
 */
/** A small stable hash — the town must look the same every time it is built,
 *  so variation is derived from names and indices, never from Math.random. */
function hashStr(s: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** How far this house sits off its cell's centre line, and how deep its front
 *  yard is. Both are clamped inside the cell by placeBuilding. */
function cellJitter(name: string, cell: number): { dx: number; setback: number } {
  return {
    dx: Math.floor(hashStr(name, cell * 7 + 1) * 5) - 2, // -2..2
    setback: Math.floor(hashStr(name, cell * 13 + 5) * 3), // 0..2
  };
}

/** Spread `count` park cells across the grid, never on the plaza cell and never
 *  two in a row, so the gaps land as breathing space rather than as a hole. */
function pickParkCells(
  total: number,
  plazaCell: number,
  count: number,
  perRow: number,
): Set<number> {
  const parks = new Set<number>();
  if (count <= 0) return parks;
  // The step must not be a multiple of the row length, or every park lands in
  // the same column and the fix for one lattice introduces another (seen at
  // both 12 and 18 cells, from two different strides). Bump it until it walks
  // across columns as well as down rows.
  let step = Math.max(2, Math.floor(total / (count + 1)));
  if (perRow > 1) while (step % perRow === 0) step += 1;
  for (let i = 1; parks.size < count && i <= total; i++) {
    let cell = (i * step) % total;
    // Walk forward off any cell we cannot take (plaza, already a park, or
    // adjacent to one) rather than skipping the slot entirely.
    for (let tries = 0; tries < total; tries++) {
      const ok = cell !== plazaCell && !parks.has(cell) && !parks.has(cell - 1) && !parks.has(cell + 1);
      if (ok) break;
      cell = (cell + 1) % total;
    }
    if (cell !== plazaCell && !parks.has(cell)) parks.add(cell);
  }
  return parks;
}

/**
 * Furnish a park: a pond, a fire and a planted bed, spaced well apart.
 *
 * Spacing is not cosmetic. The sim routes around every leisure spot except the
 * one it is walking to, so two spots side by side can make each other
 * unclaimable; three tiles apart leaves each one free neighbours on all sides.
 */
function furnishPark(
  rect: Rect,
  cols: number,
  rows: number,
  blocked: boolean[],
  road: boolean[],
  spots: LeisureSpot[],
  props: TownProp[],
) {
  const cx = rect.x + Math.floor(rect.w / 2);
  const cy = rect.y + Math.floor(rect.h / 2);
  const free = (x: number, y: number) =>
    x > 0 && y > 0 && x < cols - 1 && y < rows - 1 && !blocked[idx(x, y, cols)] && !road[idx(x, y, cols)];

  const add = (x: number, y: number, kind: SpotKind) => {
    if (!free(x, y)) return;
    spots.push({ id: spots.length, tile: { x, y }, kind });
  };

  // The slots are fixed (that is the spacing guarantee); what varies is which
  // feature lands in which one, and whether the layout is flipped. Two parks
  // built to the identical plan is the same "generated" tell as two identical
  // house cells, so the variation has to reach in here too.
  const seed = `park${rect.x},${rect.y}`;
  const turn = Math.floor(hashStr(seed, 3) * 5);
  const flip = hashStr(seed, 9) < 0.5 ? -1 : 1;
  const slots: [number, number][] = [
    [-3, -2],
    [3, -2],
    [0, 2],
    [-3, 2],
    [3, 2],
  ];
  // A rotation, so each of pond / campfire / garden still appears exactly once
  // however the plan is turned — a park without water is not the variation we
  // are after.
  const kinds: SpotKind[] = ["pond", "campfire", "garden", "bench", "bench"];
  slots.forEach(([sx, sy], i) => add(cx + sx, cy + sy * flip, kinds[(i + turn) % kinds.length]));

  // One blocked centrepiece so the park has something to gather around, and so
  // the eye reads it as a place rather than a gap between houses.
  if (free(cx, cy - flip)) {
    blocked[idx(cx, cy - flip, cols)] = true;
    props.push({ tile: { x: cx, y: cy - flip }, kind: "planter" });
  }
}

export function buildWorld(
  model: TownModel,
  _viewportWidth?: number,
  _scale = 2,
): TownWorld {
  const rooms = model.rooms;
  const n = rooms.length;
  // Parks are cells left unbuilt (TIL-192). Only once the town is big enough to
  // spare one — in a three-house town an empty cell reads as a bug, not a park.
  const parkCount = n >= 4 ? Math.max(1, Math.round(n / 5)) : 0;
  const total = n + 1 + parkCount; // +1 cell reserved for the central plaza
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

  // Which cells are parks. A town of identical cells reads as generated however
  // good the houses are, so some of the grid is deliberately not built on
  // (TIL-192): a park is a cell with no house, which puts water, a fire and a
  // planted bed out among the streets instead of only beside the square.
  const parkCells = pickParkCells(total, plazaCell, parkCount, perRow);

  const buildings: BuildingPlacement[] = [];
  const parks: Rect[] = [];
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

    if (parkCells.has(cell)) {
      parks.push({ x: cellX + 1, y: cellY + TOP_MARGIN, w: CELL_W - 2, h: ROAD_ROW - TOP_MARGIN });
      continue;
    }

    const roomForCell = rooms[roomPtr++];
    // Jitter, derived from the project name so it is stable for a given town:
    // every house standing at the same offset with the same setback is what
    // makes the grid legible as a grid.
    const j = cellJitter(roomForCell.name, cell);
    buildings.push(placeBuilding(roomForCell, cellX, cellY, cols, blocked, j.dx, j.setback));
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
  for (const p of parks) furnishPark(p, cols, rows, blocked, road, spots, props);

  // Street lamps: one every few columns on the green immediately south of a
  // horizontal road. Blocked so pathfinding routes around them (a departure
  // path must not thread a lamp post), and exposed so the renderer draws + lights
  // them. Sparse single tiles beside (never on) the roads, so blocking them
  // can't disconnect a door from the plaza or the walk-off edge.
  const lamps: Tile[] = [];
  const edgeX = Math.floor(cols / 2);
  const LAMP_GAP = 5;
  // A lamp must never land on a leisure spot — a spot is walkable, so blocking it
  // would strand its claimant and quietly cost the town a seat. It must not land
  // *beside* one either: the sim routes around every spot tile except its own
  // target, so a lamp on a seat's last free neighbour makes that seat
  // unclaimable even though plain walkability says it is fine.
  const spotTiles = new Set(spots.map((s) => `${s.tile.x},${s.tile.y}`));
  const besideSpot = (x: number, y: number) =>
    ORTHO.some(([dx, dy]) => spotTiles.has(`${x + dx},${y + dy}`));
  for (let y = 1; y < rows; y++) {
    for (let x = 2; x < cols; x += LAMP_GAP) {
      if (x === edgeX && y === rows - 1) continue; // never block the walk-off edge
      if (spotTiles.has(`${x},${y}`) || besideSpot(x, y)) continue;
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
    spots: pruneUnclaimableSpots(spots, blocked, cols, rows),
    props,
    yard,
    path,
    fences,
    lamps,
    parks,
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
  const fx = Math.floor(w / 2); // the fountain, per buildWorld
  const fy = midY;

  // A pair of planters inside the square. A large plaza with everything pushed
  // to its edges reads as a vacant lot; these break up the middle distance.
  prop(fx - 4, fy - 3, "planter");
  prop(fx + 4, fy + 3, "planter");

  // Seats right at the fountain come first — the water is the thing people
  // actually sit facing.
  candidates.push([fx - 2, fy], [fx + 2, fy], [fx, fy - 2], [fx, fy + 2]);
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
 * the plan is a **hall down the middle with a wing either side**: the workroom
 * and the kitchen to the left, the lounge and the bedroom to the right. The hall
 * runs from the front door to the back wall and is never furnished, so every
 * room opens off it and none can be sealed in by its own contents.
 *
 * This replaces the plan TIL-197 measured, which was an office with a flat
 * pushed to the back wall: the workroom took 60/50/43% of the interior, and the
 * bedroom was three tiles holding three blocked items — 0% standable, a label on
 * a rect that no character could ever be inside. The invariants now held, and
 * checked in tests/townInteriors.test.ts:
 *
 *   - the workroom is at most a **third** of the interior;
 *   - every named room is **≥50% standable with ≥2 free tiles**, measured by a
 *     walk from the doorway rather than by walkability (a room walled off by its
 *     own furniture is walkable and unreachable — the same distinction that bit
 *     the leisure spots in TIL-189);
 *   - furniture density is held at **0.40–0.45 items per interior tile at every
 *     tier**, so a bigger house means more life rather than more floor. It used
 *     to fall 0.44 → 0.33, which handed the busiest project the emptiest home.
 *
 * Furniture hugs the outer wall of its wing and the column beside the hall stays
 * clear, which is both the circulation rule (Slynyrd: groups against walls,
 * middle open) and what keeps the reachability invariant true by construction
 * rather than by luck.
 */
function placeBuilding(
  room: TownRoom,
  cellX: number,
  cellY: number,
  cols: number,
  blocked: boolean[],
  dx = 0,
  setback = 0,
): BuildingPlacement {
  const tier = tierFor(room.openTaskCount);
  const deskCount = TIER_DESKS[tier];
  const { w: iw, h: ih } = TIER_INTERIOR[tier];
  const bw = iw + 2;
  const bh = ih + 2;

  // Offset off the cell's centre line, clamped so the LOT (footprint plus its
  // one-tile fence) always stays inside the cell and off the vertical street at
  // the cell's left edge.
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const tx = clamp(
    cellX + Math.floor((CELL_W - bw) / 2) + dx,
    cellX + 2,
    cellX + CELL_W - 1 - bw,
  );
  // Bottom-aligned to the street, then pushed back by the jitter — which deepens
  // the front yard rather than moving the fence, because the lot now runs down
  // to the road whatever the setback.
  const ty = clamp(
    cellY + ROAD_ROW - YARD_DEPTH - bh - setback,
    cellY + TOP_MARGIN,
    cellY + ROAD_ROW - YARD_DEPTH - bh,
  );
  /** The fence's street edge: one tile above the road, whatever the setback. */
  const lotBottom = cellY + ROAD_ROW - 1;
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
  const put = (lx: number, ly: number, kind: FurnitureKind): Furniture | null => {
    if (lx < 0 || ly < 0 || lx >= iw || ly >= ih) return null;
    const tile = { x: ix + lx, y: iy + ly };
    if (furniture.some((f) => f.tile.x === tile.x && f.tile.y === tile.y)) return null;
    if (!walkableKind(kind)) blocked[idx(tile.x, tile.y, cols)] = true;
    const item: Furniture = { tile, kind, room: null }; // room resolved from the rects below
    furniture.push(item);
    return item;
  };

  // --- The plan: a hall column with a wing either side. ---
  const leftW = hallCol; // workroom over kitchen
  const rightW = iw - hallCol - 1; // lounge over bedroom

  // Desks fill the left wing's top band, laid as (desk row, seat row) pairs — a
  // character sits below its own desk facing up into the monitor, which is the
  // arrangement the renderer draws. Two short rows rather than one long run
  // against the back wall: six desks in a line is the shape that reads
  // institutional (TIL-197), and it is also what drove the workroom over a
  // third of the house.
  const deskRows = Math.ceil(deskCount / leftW);
  const workH = deskRows * 2;
  for (let i = 0; i < deskCount; i++) {
    const lx = i % leftW;
    const ly = Math.floor(i / leftW) * 2;
    put(lx, ly, "desk");
    desks.push({ x: ix + lx, y: iy + ly });
    seats.push({ x: ix + lx, y: iy + ly + 1 });
  }

  // Room bands. The bedroom gets a third row once there is height for one; the
  // lounge takes the rest of the right wing.
  const bedH = ih >= 7 ? 3 : 2;
  const loungeH = ih - bedH;
  const kitchenTop = workH;
  const rightX = hallCol + 1;

  // --- Kitchen: a counter run down the outer wall, and a table out in the room
  // where there is width for one. Everything blocked stays in that one column,
  // which is what leaves each unit a free tile beside it *inside the kitchen* —
  // an object you can only reach by standing in the next room along is an object
  // the sim cannot use, and the place tree would describe using it wrongly. ---
  // The run is capped in the narrowest wing. A third counter there filled the
  // house to its density target on fitted furniture alone, leaving room for only
  // two pieces of clutter — and clutter is the whole of what makes a house
  // *someone's*, so the small tier came out the most anonymous of the three
  // (Codex spec-axis finding on 67114c2). The research asks for 3–5 per house.
  const counterRun = leftW >= 3 ? ih - kitchenTop : Math.min(2, ih - kitchenTop);
  for (let i = 0; i < counterRun; i++) {
    const ly = kitchenTop + i;
    put(0, ly, i === 1 ? "sink" : "counter");
  }
  // A table needs a column clear of both the counter run and the hall-side
  // circulation, so only the widest wing gets one.
  if (leftW >= 4 && kitchenTop + 2 < ih) {
    put(2, kitchenTop + 1, "table");
    put(2, kitchenTop + 2, "chair");
  }

  // --- Lounge: bookshelf and sofa against the outer wall, rug on the floor in
  // front of them (a rug is floor, so it costs no standing room). ---
  put(iw - 1, 0, "bookshelf");
  put(iw - 1, 1, "sofa");
  if (loungeH >= 4) put(iw - 1, 2, "sofa");
  if (rightW >= 2) put(iw - 2, 1, "rug");
  if (rightW >= 2 && loungeH >= 4) put(iw - 2, 2, "rug");
  if (loungeH >= 4) put(iw - 1, loungeH - 1, "plant");

  // --- Bedroom: the bed against the outer wall with a nightstand beside it. ---
  put(iw - 1, loungeH, "bed");
  put(iw - 1, loungeH + 1, "bed");
  if (rightW >= 2) put(iw - 2, loungeH, "nightstand");
  if (bedH >= 3) put(iw - 1, ih - 1, "plant");

  const door: Tile = { x: ix + hallCol, y: frontWallY + 1 }; // the yard apron
  const gate: Tile = { x: door.x, y: lotBottom };

  // --- The floor plan, as rects. Declaring them makes the plan readable data
  // instead of something a reader has to reconstruct from the put() calls, and
  // it is what lets a character say which room it is standing in (TIL-193).
  // Every interior tile falls in exactly one of these. ---
  const rooms: HouseRoom[] = [
    { kind: "workroom", name: "the workroom", rect: { x: ix, y: iy, w: leftW, h: workH } },
    {
      kind: "kitchen",
      name: "the kitchen",
      rect: { x: ix, y: iy + kitchenTop, w: leftW, h: ih - kitchenTop },
    },
    // The spine: the column from the back wall down to the front door.
    { kind: "hall", name: "the hall", rect: { x: ix + hallCol, y: iy, w: 1, h: ih } },
    { kind: "lounge", name: "the lounge", rect: { x: ix + rightX, y: iy, w: rightW, h: loungeH } },
    {
      kind: "bedroom",
      name: "the bedroom",
      rect: { x: ix + rightX, y: iy + loungeH, w: rightW, h: bedH },
    },
  ];

  const roomOf = (t: Tile) => roomKindAt(rooms, t);
  for (const f of furniture) f.room = roomOf(f.tile);

  const isFree = (t: Tile) => !blocked[idx(t.x, t.y, cols)];
  const interiorRect: Rect = { x: ix, y: iy, w: iw, h: ih };
  const doorway: Tile = { x: door.x, y: frontWallY };

  // Standing tiles of the base plan are protected from the clutter pass —
  // otherwise a mug takes the only tile beside the bed and the house quietly
  // loses its ability to sleep anyone.
  const protectedTiles = new Set<string>([
    ...seats.map((s) => `${s.x},${s.y}`),
    ...deriveAffordances(furniture, interiorRect, doorway, isFree, roomOf).map(
      (a) => `${a.tile.x},${a.tile.y}`,
    ),
  ]);

  const clutter = scatterClutter(
    room.name,
    furniture,
    rooms,
    interiorRect,
    doorway,
    protectedTiles,
    blocked,
    cols,
    put,
    roomOf,
  );

  // Derived from the *finished* grid, after the clutter is down — protecting a
  // standing tile stops clutter landing on it, but not clutter elsewhere cutting
  // the route to it, and an affordance you cannot walk to is exactly the kind of
  // advertised-but-unusable capacity that stalls a character at its own door.
  const affordances = deriveAffordances(furniture, interiorRect, doorway, isFree, roomOf);
  const restSpots = deriveRestSpots(affordances);

  return {
    room,
    tier,
    tx,
    ty,
    tw: bw,
    th: bh,
    interior: interiorRect,
    frontWallY,
    door,
    gate,
    seats,
    desks,
    partitions,
    furniture,
    clutter,
    affordances,
    restSpots,
    rooms,
    // Filled by furnishLot, which is the pass that knows where the fence runs.
    lot: { x: tx, y: ty, w: bw, h: bh },
  };
}

/** The interior tiles a character can actually reach, walking in through the
 *  doorway. Walkability is not reachability: a room sealed behind its own
 *  furniture passes `isWalkable` on every one of its tiles and is still a room
 *  nobody can enter — the same trap `pruneUnclaimableSpots` guards outdoors. */
function reachableInside(interior: Rect, doorway: Tile, isFree: (t: Tile) => boolean): Set<string> {
  const seen = new Set<string>();
  const queue: Tile[] = [];
  const push = (t: Tile) => {
    const key = `${t.x},${t.y}`;
    if (seen.has(key) || !inRect(interior, t) || !isFree(t)) return;
    seen.add(key);
    queue.push(t);
  };
  // Start from the tile the doorway opens into (the bottom of the hall).
  push({ x: doorway.x, y: doorway.y - 1 });
  while (queue.length) {
    const t = queue.shift()!;
    for (const [dx, dy] of ORTHO) push({ x: t.x + dx, y: t.y + dy });
  }
  return seen;
}

/** A standing tile beside every usable item, keeping only the ones a character
 *  can walk to. Deterministic: neighbours are tried in a fixed order. */
function deriveAffordances(
  furniture: Furniture[],
  interior: Rect,
  doorway: Tile,
  isFree: (t: Tile) => boolean,
  roomOf: (t: Tile) => RoomKind | null,
): Affordance[] {
  const reached = reachableInside(interior, doorway, isFree);
  const out: Affordance[] = [];
  for (const f of furniture) {
    const verb = FURNITURE_VERB[f.kind];
    if (!verb) continue;
    const options = ORTHO.map(([dx, dy]) => ({ x: f.tile.x + dx, y: f.tile.y + dy })).filter(
      (t) => inRect(interior, t) && reached.has(`${t.x},${t.y}`),
    );
    // You use the counter *from the kitchen*. A bed on the bedroom's top row has
    // a reachable neighbour one tile up in the lounge, and taking it would put a
    // character asleep in the lounge — which the place tree would then say out
    // loud in the tooltip. An object with no reachable tile in its own room is
    // simply not usable from that room, and is dropped: a two-tile bed has a
    // second tile that does have one, so nothing worth having is lost.
    const tile = options.find((t) => roomOf(t) === f.room);
    if (!tile) continue;
    out.push({ tile, object: f.tile, kind: f.kind, verb, room: roomOf(tile) });
  }
  return out;
}

/** Somewhere to sit and somewhere to sleep, read straight off the affordances so
 *  the two can never disagree about which tiles are usable. */
function deriveRestSpots(affordances: Affordance[]): RestSpot[] {
  const out: RestSpot[] = [];
  const seen = new Set<string>();
  for (const a of affordances) {
    const kind = a.kind === "sofa" ? "sofa" : a.kind === "bed" ? "bed" : null;
    if (!kind) continue;
    const key = `${a.tile.x},${a.tile.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tile: a.tile, kind });
  }
  return out;
}

/** Clutter kinds and the rooms each belongs in. Order is the fallback order when
 *  a kind has nowhere to go, so it is deliberately mixed across rooms rather
 *  than grouped — a house that fills its lounge before touching its kitchen
 *  reads as half-finished. */
const CLUTTER_ROOMS: { kind: ClutterKind; rooms: RoomKind[] }[] = [
  { kind: "papers", rooms: ["workroom"] },
  { kind: "laundry", rooms: ["bedroom"] },
  { kind: "mug", rooms: ["kitchen", "workroom"] },
  { kind: "guitar", rooms: ["lounge"] },
  { kind: "boxes", rooms: ["bedroom", "lounge"] },
  { kind: "bookstack", rooms: ["lounge", "workroom"] },
  { kind: "catbed", rooms: ["lounge", "bedroom"] },
];

/** Items per interior tile every house is furnished to. The midpoint of the
 *  0.40–0.45 band the invariant test pins, so rounding cannot fall outside it. */
const DENSITY_TARGET = 0.425;

/**
 * Fill the house up to the density target with this project's own things.
 *
 * Two rules keep the result honest. A clutter item may only land where it
 * **touches a wall or something already there** — an object stranded mid-floor
 * is the thing that makes a room read as a grid rather than a room. And after
 * each tentative placement the reachability invariant is re-checked, so clutter
 * can never be what seals a room off; if a tile would break it, the item goes
 * somewhere else. That is the same shape as `pruneUnclaimableSpots`: only the
 * pass that can see the finished grid is allowed to decide what fits.
 *
 * Which kinds, in which order, and where the scan starts all come from a hash of
 * the project name, so Alpha's house always looks like Alpha's house and never
 * like Beta's (user decision, 2026-07-29).
 */
function scatterClutter(
  projectName: string,
  furniture: Furniture[],
  rooms: HouseRoom[],
  interior: Rect,
  doorway: Tile,
  /** Tiles clutter may neither cover nor cut off: desk seats, and the standing
   *  tile of every affordance the base plan laid down. */
  mustReach: Set<string>,
  blocked: boolean[],
  cols: number,
  put: (lx: number, ly: number, kind: FurnitureKind) => Furniture | null,
  roomOf: (t: Tile) => RoomKind | null,
): Furniture[] {
  const area = interior.w * interior.h;
  const target = Math.round(area * DENSITY_TARGET);
  const clutter: Furniture[] = [];
  const isFree = (t: Tile) => !blocked[idx(t.x, t.y, cols)];
  const occupied = new Set(furniture.map((f) => `${f.tile.x},${f.tile.y}`));

  /** Every room still has ≥2 reachable tiles and ≥half its floor standable, and
   *  every protected tile is still walkable *to*.
   *
   *  The second half is not redundant. A desk seat boxed in by a wall, its own
   *  desk, a counter and one mug satisfies the room test — the room simply
   *  counts one fewer reachable tile and stays above half — while the worker
   *  assigned that seat can never sit down. Keeping clutter *off* a tile is not
   *  the same as keeping the route to it open. */
  const invariantHolds = (): boolean => {
    const reached = reachableInside(interior, doorway, isFree);
    for (const key of mustReach) if (!reached.has(key)) return false;
    for (const r of rooms) {
      let free = 0;
      for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++) {
        for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) {
          if (reached.has(`${x},${y}`)) free++;
        }
      }
      if (free < 2 || free * 2 < r.rect.w * r.rect.h) return false;
    }
    return true;
  };

  // A rotation of the kind list, and a starting offset into each room's tiles.
  const rot = Math.floor(hashStr(projectName, 101) * CLUTTER_ROOMS.length);
  const skew = hashStr(projectName, 211);
  const kinds = CLUTTER_ROOMS.map((_, i) => CLUTTER_ROOMS[(i + rot) % CLUTTER_ROOMS.length]);

  const candidatesIn = (kind: RoomKind): Tile[] => {
    const r = rooms.find((x) => x.kind === kind);
    if (!r) return [];
    const tiles: Tile[] = [];
    for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++) {
      for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) tiles.push({ x, y });
    }
    // Start the scan somewhere different per project so two houses of the same
    // tier put the same kind of thing in different corners.
    const start = Math.floor(skew * tiles.length);
    return [...tiles.slice(start), ...tiles.slice(0, start)];
  };

  /** Touching a wall, or another item — never stranded in open floor. */
  const anchored = (t: Tile) =>
    ORTHO.some(([dx, dy]) => {
      const n = { x: t.x + dx, y: t.y + dy };
      return !inRect(interior, n) || occupied.has(`${n.x},${n.y}`) || !isFree(n);
    });

  // Cycle the kind list until the house is full. `misses` stops an unfillable
  // house — every remaining candidate refused by the anchor or the invariant —
  // from looping forever: one full pass with nothing placed means it is done.
  let attempt = 0;
  let misses = 0;
  while (furniture.length < target && misses < kinds.length) {
    const spec = kinds[attempt % kinds.length];
    attempt++;
    let placed = false;
    for (const roomKind of spec.rooms) {
      for (const t of candidatesIn(roomKind)) {
        const key = `${t.x},${t.y}`;
        if (occupied.has(key) || mustReach.has(key) || !isFree(t)) continue;
        if (roomOf(t) !== roomKind) continue; // rects overlap nowhere, but be exact
        if (!anchored(t)) continue;
        const item = put(t.x - interior.x, t.y - interior.y, spec.kind);
        if (!item) continue;
        if (!invariantHolds()) {
          // Undo: this tile was what sealed a room in.
          blocked[idx(t.x, t.y, cols)] = false;
          furniture.pop();
          continue;
        }
        item.room = roomOf(item.tile);
        occupied.add(key);
        clutter.push(item);
        placed = true;
        break;
      }
      if (placed) break;
    }
    misses = placed ? 0 : misses + 1;
  }
  return clutter;
}

/** True when `t` lies inside `r`. */
export function inRect(r: Rect, t: Tile): boolean {
  return t.x >= r.x && t.x < r.x + r.w && t.y >= r.y && t.y < r.y + r.h;
}

/** Which named room a tile falls in. The bed nook is carved out of the kitchen's
 *  column, so the more specific room must win — hence last-match, matching the
 *  order rooms are declared in. */
function roomKindAt(rooms: HouseRoom[], t: Tile): RoomKind | null {
  let found: RoomKind | null = null;
  for (const r of rooms) if (inRect(r.rect, t)) found = r.kind;
  return found;
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
  // The gate is on the street edge of the lot by construction, so taking the
  // bottom from it keeps the fence against the road however far back the house
  // was set — a deeper setback becomes a deeper front yard, not a floating lot.
  const bottom = b.gate.y;
  const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows;
  b.lot = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };

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
