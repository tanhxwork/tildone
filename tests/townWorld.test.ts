import { describe, expect, it } from "bun:test";
import type { TownModel, TownRoom } from "../src/selectors";
import {
  buildWorld,
  buildingsPerRow,
  CELL_H,
  CELL_W,
  isWalkable,
} from "../src/town/world";

// The world turns the town roster into a contiguous tiled grid: one building
// (obstacle footprint) per project + Inbox on a shared walkable green, wrapping
// into cells by viewport width. These cases pin the grid extent, the footprint
// blocking, and the door/edge anchors the sim paths to.

function room(name: string, projectId: number | null = 1): TownRoom {
  return { projectId, name, color: null, characters: [] };
}

function model(...names: string[]): TownModel {
  return { rooms: names.map((n, i) => room(n, i + 1)) };
}

describe("buildingsPerRow", () => {
  it("is at least 1 even for a zero/negative width", () => {
    expect(buildingsPerRow(0, 2)).toBe(1);
    expect(buildingsPerRow(-100, 2)).toBe(1);
  });

  it("fits floor(viewportTiles / CELL_W) cells across", () => {
    // width in px / (TILE_PX*scale) = view tiles; /CELL_W = cells.
    const scale = 2;
    const tilePx = 16 * scale; // 32
    const width = CELL_W * 3 * tilePx; // exactly 3 cells wide
    expect(buildingsPerRow(width, scale)).toBe(3);
  });
});

describe("buildWorld", () => {
  it("wraps buildings into a grid and sizes the tile extent to whole cells", () => {
    const m = model("A", "B", "C"); // 3 buildings
    // Narrow enough for 2 per row → 2 rows.
    const world = buildWorld(m, CELL_W * 2 * 32, 2);
    expect(world.buildings).toHaveLength(3);
    expect(world.cols).toBe(CELL_W * 2);
    expect(world.rows).toBe(CELL_H * 2);
  });

  it("blocks exactly the building footprints and leaves margins walkable", () => {
    const world = buildWorld(model("A"), 10_000, 2); // 1 building, wide
    const b = world.buildings[0];
    // Every footprint tile is blocked.
    for (let dy = 0; dy < b.th; dy++) {
      for (let dx = 0; dx < b.tw; dx++) {
        expect(isWalkable(world, b.tx + dx, b.ty + dy)).toBe(false);
      }
    }
    // The margin ring around it is walkable.
    expect(isWalkable(world, b.tx - 1, b.ty)).toBe(true);
    expect(isWalkable(world, b.tx, b.ty + b.th)).toBe(true); // apron below
  });

  it("places the door on a walkable tile directly below the footprint", () => {
    const world = buildWorld(model("A"), 10_000, 2);
    const b = world.buildings[0];
    expect(b.door.y).toBe(b.ty + b.th);
    expect(isWalkable(world, b.door.x, b.door.y)).toBe(true);
  });

  it("puts the walk-off edge on a walkable bottom tile", () => {
    const world = buildWorld(model("A", "B"), 10_000, 2);
    expect(world.edge.y).toBe(world.rows - 1);
    expect(isWalkable(world, world.edge.x, world.edge.y)).toBe(true);
  });

  it("keeps model order (Inbox last stays last)", () => {
    const m = model("Proj", "Inbox");
    const world = buildWorld(m, 10_000, 2);
    expect(world.buildings.map((b) => b.room.name)).toEqual(["Proj", "Inbox"]);
  });

  it("treats out-of-bounds tiles as unwalkable", () => {
    const world = buildWorld(model("A"), 10_000, 2);
    expect(isWalkable(world, -1, 0)).toBe(false);
    expect(isWalkable(world, world.cols, 0)).toBe(false);
    expect(isWalkable(world, 0, world.rows)).toBe(false);
  });
});
