import { describe, expect, it } from "bun:test";
import type { TownModel, TownRoom } from "../src/selectors";
import { buildWorld, CELL_H, CELL_W, isRoad, isWalkable } from "../src/town/world";
import { findPath } from "../src/town/pathfind";

// v3 world: the roster (buildings + one central plaza) wraps into a roughly
// square lattice threaded by roads. The world is sized to the roster, not the
// viewport. Buildings are enclosed single-door offices whose size scales with
// the project's open-task count. These cases pin the extent, the road/plaza
// lattice, the size tiers, and the single-door enclosure the sim relies on.

function room(name: string, projectId: number | null = 1, openTaskCount = 1): TownRoom {
  return { projectId, name, color: null, characters: [], openTaskCount };
}

function model(...names: string[]): TownModel {
  return { rooms: names.map((n, i) => room(n, i + 1)) };
}

describe("buildWorld — extent & order", () => {
  it("sizes the world to the roster (+1 plaza cell), not the viewport", () => {
    // 1 building + 1 plaza = 2 cells → 2 per row, 1 row.
    const world = buildWorld(model("A"));
    expect(world.buildings).toHaveLength(1);
    expect(world.cols).toBe(CELL_W * 2);
    expect(world.rows).toBe(CELL_H * 1);
    // Viewport width no longer changes the layout.
    expect(buildWorld(model("A"), 10_000, 2).cols).toBe(world.cols);
  });

  it("keeps model order (Inbox last stays last)", () => {
    const world = buildWorld(model("Proj", "Inbox"));
    expect(world.buildings.map((b) => b.room.name)).toEqual(["Proj", "Inbox"]);
  });

  it("treats out-of-bounds tiles as unwalkable", () => {
    const world = buildWorld(model("A"));
    expect(isWalkable(world, -1, 0)).toBe(false);
    expect(isWalkable(world, world.cols, 0)).toBe(false);
    expect(isWalkable(world, 0, world.rows)).toBe(false);
  });

  it("puts the walk-off edge on a walkable bottom tile", () => {
    const world = buildWorld(model("A", "B"));
    expect(world.edge.y).toBe(world.rows - 1);
    expect(isWalkable(world, world.edge.x, world.edge.y)).toBe(true);
  });
});

describe("buildWorld — activity-scaled buildings", () => {
  it("scales the office (desks) by the project's open-task count", () => {
    const world = buildWorld({
      rooms: [room("small", 1, 1), room("medium", 2, 4), room("large", 3, 12)],
    });
    const [s, m, l] = world.buildings;
    expect(s.tier).toBe("small");
    expect(s.seats).toHaveLength(2);
    expect(m.tier).toBe("medium");
    expect(m.seats).toHaveLength(4);
    expect(l.tier).toBe("large");
    expect(l.seats).toHaveLength(6);
    // A larger project is a physically larger footprint.
    expect(l.tw).toBeGreaterThan(s.tw);
    expect(l.th).toBeGreaterThanOrEqual(s.th);
  });
});

describe("buildWorld — enclosed single-door office", () => {
  it("blocks the whole footprint except the interior seats and one doorway", () => {
    const world = buildWorld(model("A"));
    const b = world.buildings[0];
    const seatKeys = new Set(b.seats.map((s) => `${s.x},${s.y}`));
    const doorwayKey = `${b.door.x},${b.door.y - 1}`; // gap in the front wall
    for (let dy = 0; dy < b.th; dy++) {
      for (let dx = 0; dx < b.tw; dx++) {
        const x = b.tx + dx;
        const y = b.ty + dy;
        const key = `${x},${y}`;
        const walkable = seatKeys.has(key) || key === doorwayKey;
        expect(isWalkable(world, x, y)).toBe(walkable);
      }
    }
  });

  it("gives each desk a seat below it (seat walkable, desk blocking)", () => {
    const world = buildWorld({ rooms: [room("A", 1, 4)] });
    const b = world.buildings[0];
    expect(b.desks).toHaveLength(b.seats.length);
    b.seats.forEach((s, i) => {
      expect(isWalkable(world, s.x, s.y)).toBe(true);
      expect(b.desks[i].x).toBe(s.x);
      expect(b.desks[i].y).toBe(s.y - 1);
      expect(isWalkable(world, b.desks[i].x, b.desks[i].y)).toBe(false);
    });
  });

  it("makes every seat reachable ONLY through the single door", () => {
    // From an outside tile, the shortest path to each seat must thread the one
    // doorway — the enclosure the TIL-178 open-front bug lacked.
    const world = buildWorld({ rooms: [room("A", 1, 4)] });
    const b = world.buildings[0];
    const doorway = { x: b.door.x, y: b.door.y - 1 };
    // The door apron is a walkable road tile just outside the doorway.
    expect(isWalkable(world, b.door.x, b.door.y)).toBe(true);
    expect(isWalkable(world, doorway.x, doorway.y)).toBe(true);
    for (const seat of b.seats) {
      const path = findPath(world, world.edge, seat);
      expect(path.length).toBeGreaterThan(0);
      expect(path.some((t) => t.x === doorway.x && t.y === doorway.y)).toBe(true);
    }
  });
});

describe("buildWorld — roads & plaza", () => {
  it("carves a central walkable plaza on the road network", () => {
    const world = buildWorld(model("A", "B", "C"));
    const p = world.plaza;
    expect(p.w).toBeGreaterThan(0);
    for (let dy = 0; dy < p.h; dy++) {
      for (let dx = 0; dx < p.w; dx++) {
        expect(isWalkable(world, p.x + dx, p.y + dy)).toBe(true);
        expect(isRoad(world, p.x + dx, p.y + dy)).toBe(true);
      }
    }
    // No building sits on the plaza.
    for (const b of world.buildings) {
      const overlaps = p.x < b.tx + b.tw && b.tx < p.x + p.w && p.y < b.ty + b.th && b.ty < p.y + p.h;
      expect(overlaps).toBe(false);
    }
  });

  it("connects every building's door to the plaza by road", () => {
    const world = buildWorld(model("A", "B", "C", "D"));
    const plazaCentre = { x: world.plaza.x + Math.floor(world.plaza.w / 2), y: world.plaza.y + Math.floor(world.plaza.h / 2) };
    for (const b of world.buildings) {
      const path = findPath(world, b.door, plazaCentre);
      expect(path.length).toBeGreaterThan(0);
    }
  });
});

describe("buildWorld — leisure spots (in the plaza)", () => {
  it("clusters distinct spots of all four kinds on walkable plaza tiles", () => {
    const world = buildWorld(model("A", "B", "C"));
    expect(world.spots.length).toBe(4);
    const keys = new Set(world.spots.map((s) => `${s.tile.x},${s.tile.y}`));
    expect(keys.size).toBe(world.spots.length); // no two share a tile
    expect(new Set(world.spots.map((s) => s.kind)).size).toBe(4);
    for (const s of world.spots) {
      expect(isWalkable(world, s.tile.x, s.tile.y)).toBe(true);
      const p = world.plaza;
      const inside = s.tile.x >= p.x && s.tile.x < p.x + p.w && s.tile.y >= p.y && s.tile.y < p.y + p.h;
      expect(inside).toBe(true);
    }
  });
});
