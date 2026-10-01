import type { TownCharacter, TownModel, TownRoom } from "../selectors";
import type { Environment } from "../types";

// The Town's structure, before anything is drawn: which grid cell each project's
// island takes, where the town square sits, which islands a bridge joins, how tall
// each building is, what each floor is for, and where each agent stands or sits.
// Pure (no DOM, no palette), so scene.ts and the tests share one source of truth.
// A port of the approved mockup (docs/artifacts/2026-10-01-town-redesign.html,
// layout B).

/** World units: an island is ISLAND_SIZE square, cells sit CELL_PITCH apart, and
 *  the gap between neighbours is spanned by a bridge. */
export const ISLAND_SIZE = 9;
export const CELL_PITCH = 12.5;

export const MAX_FLOORS = 4;
/** Open tasks per extra storey: a busy project reads as a taller building. */
export const TASKS_PER_FLOOR = 12;
/** Seats on the lounge couch; quiet agents past it fall back to the garden bench. */
export const COUCH_SEATS = 3;

export interface Cell {
  col: number;
  row: number;
}

export interface TownGrid {
  cols: number;
  rows: number;
  /** One cell per project, in project order. */
  projects: Cell[];
  /** The town square: the cell nearest the middle of the grid. */
  square: Cell;
}

/** A project's island (by projectId) or the town square. */
export type Place = number | "square";

export interface Bridge {
  from: Cell;
  to: Cell;
  /** The two places it joins, so focusing either keeps the bridge visible. */
  places: [Place, Place];
}

export type BuildingStyle = "cottage" | "tower" | "adobe" | "chalet" | "brick";
export type GroundTexture = "grass" | "tiles" | "sand" | "snow" | "leaves";
export type Weather = "butterflies" | "dust" | "snow" | "leaves";
export type Underside = "roots" | "cables" | "icicles";

/** How an environment looks: building, ground, ambient weather and what hangs
 *  under the island's rock. */
export interface IslandStyle {
  environment: Environment;
  building: BuildingStyle;
  ground: GroundTexture;
  weather: Weather | null;
  underside: Underside;
}

export const ISLAND_STYLES: Record<Environment, IslandStyle> = {
  meadow: { environment: "meadow", building: "cottage", ground: "grass", weather: "butterflies", underside: "roots" },
  city: { environment: "city", building: "tower", ground: "tiles", weather: null, underside: "cables" },
  desert: { environment: "desert", building: "adobe", ground: "sand", weather: "dust", underside: "roots" },
  snow: { environment: "snow", building: "chalet", ground: "snow", weather: "snow", underside: "icicles" },
  autumn: { environment: "autumn", building: "brick", ground: "leaves", weather: "leaves", underside: "roots" },
};

/** Ground floor first: desks, then meeting, lounge and lab cycling upward. */
export type FloorUse = "desks" | "meeting" | "lounge" | "lab";

/** A working agent at a desk: which storey, and the left (0) or right (1) desk. */
export interface DeskSlot {
  character: TownCharacter;
  floor: number;
  side: 0 | 1;
}

export interface BuildingPlan {
  floors: number;
  uses: FloorUse[];
  desks: DeskSlot[];
  /** The storey whose use is "lounge", or -1 when the building has none. */
  loungeFloor: number;
  /** Quiet agents on the lounge couch (only when there is a lounge). */
  couch: TownCharacter[];
  /** Quiet agents on the garden bench: all of them without a lounge, else the
   *  couch's overflow. */
  bench: TownCharacter[];
  /** Blocked agents, standing at the front door. */
  door: TownCharacter[];
}

/** One project's island: its room, grid cell, look and building. */
export interface IslandPlan {
  projectId: number;
  room: TownRoom;
  cell: Cell;
  style: IslandStyle;
  building: BuildingPlan;
}

export interface TownLayout {
  grid: TownGrid;
  islands: IslandPlan[];
  /** Project-less (Inbox) agents: they stand in the town square. */
  squareAgents: TownCharacter[];
  bridges: Bridge[];
}

/**
 * Grid cells for `projectCount` islands plus the town square, row-major and
 * roughly square. The square takes the cell nearest the grid's middle (the first
 * such cell on a tie); projects fill the remaining cells in order, so adding or
 * removing a project reflows every island after it.
 */
export function townGrid(projectCount: number): TownGrid {
  const count = projectCount + 1;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const all: Cell[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) all.push({ col, row });
  }
  const midCol = (cols - 1) / 2;
  const midRow = (rows - 1) / 2;
  const fromMiddle = (cell: Cell) => Math.hypot(cell.col - midCol, cell.row - midRow);
  let squareIndex = 0;
  all.forEach((cell, i) => {
    if (fromMiddle(cell) < fromMiddle(all[squareIndex])) squareIndex = i;
  });
  const rest = all.filter((_, i) => i !== squareIndex);
  return { cols, rows, projects: rest.slice(0, projectCount), square: all[squareIndex] };
}

/** World position of a cell's top-left corner. */
export function cellOrigin(cell: Cell): { x: number; y: number } {
  return { x: cell.col * CELL_PITCH, y: cell.row * CELL_PITCH };
}

/** Storeys for a project: one, plus one per TASKS_PER_FLOOR open tasks, capped. */
export function floorCount(openTaskCount: number): number {
  return Math.min(MAX_FLOORS, 1 + Math.floor(openTaskCount / TASKS_PER_FLOOR));
}

export function floorUses(floors: number): FloorUse[] {
  const upper: FloorUse[] = ["meeting", "lounge", "lab"];
  return Array.from({ length: floors }, (_, f) => (f === 0 ? "desks" : upper[(f - 1) % upper.length]));
}

/**
 * Where a project's agents go, by state: working agents take desks spread one per
 * storey from the ground up (agent i on storey i % floors, second lap on the right
 * desk); quiet agents sit on the lounge couch when there is a lounge, else on the
 * garden bench; blocked agents stand at the front door.
 */
export function buildingPlan(characters: TownCharacter[], openTaskCount: number): BuildingPlan {
  const floors = floorCount(openTaskCount);
  const uses = floorUses(floors);
  const loungeFloor = uses.indexOf("lounge");
  const working = characters.filter((c) => c.state === "working");
  const quiet = characters.filter((c) => c.state === "quiet");
  const desks = working.map(
    (character, i): DeskSlot => ({
      character,
      floor: i % floors,
      side: Math.floor(i / floors) % 2 === 0 ? 0 : 1,
    }),
  );
  const couch = loungeFloor >= 0 ? quiet.slice(0, COUCH_SEATS) : [];
  return {
    floors,
    uses,
    desks,
    loungeFloor,
    couch,
    bench: quiet.slice(couch.length),
    door: characters.filter((c) => c.state === "blocked"),
  };
}

/** Bridges between every pair of grid neighbours (Manhattan distance 1), the
 *  square included. */
export function gridBridges(cells: { cell: Cell; place: Place }[]): Bridge[] {
  const bridges: Bridge[] = [];
  cells.forEach((a, i) => {
    for (const b of cells.slice(i + 1)) {
      if (Math.abs(a.cell.col - b.cell.col) + Math.abs(a.cell.row - b.cell.row) !== 1) continue;
      bridges.push({ from: a.cell, to: b.cell, places: [a.place, b.place] });
    }
  });
  return bridges;
}

/**
 * The whole town for a roster: one island per project room in order, the square,
 * the bridges, and the Inbox agents who stand in the square. A project room
 * without an environment (never written by the app) is drawn as meadow.
 */
export function townLayout(model: TownModel): TownLayout {
  const projectRooms = model.rooms.filter(
    (room): room is TownRoom & { projectId: number } => room.projectId !== null,
  );
  const grid = townGrid(projectRooms.length);
  const islands = projectRooms.map(
    (room, i): IslandPlan => ({
      projectId: room.projectId,
      room,
      cell: grid.projects[i],
      style: ISLAND_STYLES[room.environment ?? "meadow"],
      building: buildingPlan(room.characters, room.openTaskCount),
    }),
  );
  const bridges = gridBridges([
    ...islands.map((island) => ({ cell: island.cell, place: island.projectId as Place })),
    { cell: grid.square, place: "square" },
  ]);
  const squareAgents = model.rooms.filter((room) => room.projectId === null).flatMap((room) => room.characters);
  return { grid, islands, squareAgents, bridges };
}
