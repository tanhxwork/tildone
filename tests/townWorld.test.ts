import { describe, expect, it } from "bun:test";
import type { TownModel, TownRoom } from "../src/selectors";
import { buildWorld, CELL_H, CELL_W, isRoad, isWalkable, type TownWorld } from "../src/town/world";
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

/** Tiles the commons furnishings block (planters, notice board, market, …). */
function propTiles(world: TownWorld): Set<string> {
  return new Set(world.props.map((p) => `${p.tile.x},${p.tile.y}`));
}

/** Any open plaza tile — a fixed corner is no longer safe to assume walkable now
 *  that the commons is furnished, so tests that just need "somewhere in the
 *  square" ask for one. */
function openPlazaTile(world: TownWorld): { x: number; y: number } {
  const p = world.plaza;
  for (let dy = 0; dy < p.h; dy++) {
    for (let dx = 0; dx < p.w; dx++) {
      if (isWalkable(world, p.x + dx, p.y + dy)) return { x: p.x + dx, y: p.y + dy };
    }
  }
  throw new Error("plaza has no walkable tile");
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
  it("rings the house in wall with exactly one doorway", () => {
    const world = buildWorld(model("A"));
    const b = world.buildings[0];
    const doorwayKey = `${b.door.x},${b.door.y - 1}`; // the gap in the facade
    let gaps = 0;
    for (let dy = 0; dy < b.th; dy++) {
      for (let dx = 0; dx < b.tw; dx++) {
        const x = b.tx + dx;
        const y = b.ty + dy;
        const onRing = dx === 0 || dx === b.tw - 1 || dy === 0 || dy === b.th - 1;
        if (!onRing) continue;
        if (isWalkable(world, x, y)) {
          gaps++;
          expect(`${x},${y}`).toBe(doorwayKey);
        }
      }
    }
    expect(gaps).toBe(1);
  });

  it("leaves most of the house as open floor, not solid furniture", () => {
    // The failure this guards is the old geometry: a footprint that was 85% wall
    // with a single one-tile-tall aisle in it (15% walkable). A room needs more
    // floor than furniture or it reads as a corridor. The interior ratio is the
    // meaningful one — a small building is dominated by its own wall ring, so the
    // footprint figure is held to a looser floor.
    for (const openTasks of [1, 4, 9]) {
      const world = buildWorld({ rooms: [room("A", 1, openTasks)] });
      const b = world.buildings[0];
      let footprint = 0;
      for (let dy = 0; dy < b.th; dy++) {
        for (let dx = 0; dx < b.tw; dx++) {
          if (isWalkable(world, b.tx + dx, b.ty + dy)) footprint++;
        }
      }
      let inside = 0;
      for (let dy = 0; dy < b.interior.h; dy++) {
        for (let dx = 0; dx < b.interior.w; dx++) {
          if (isWalkable(world, b.interior.x + dx, b.interior.y + dy)) inside++;
        }
      }
      expect(inside / (b.interior.w * b.interior.h)).toBeGreaterThanOrEqual(0.6);
      expect(footprint / (b.tw * b.th)).toBeGreaterThanOrEqual(0.33);
    }
  });

  it("lays out named rooms, not one aisle", () => {
    const world = buildWorld({ rooms: [room("A", 1, 9)] }); // large tier
    const b = world.buildings[0];
    const kinds = new Set(b.furniture.map((f) => f.kind));
    for (const k of ["desk", "counter", "table", "sofa", "bed", "bookshelf"]) {
      expect(kinds.has(k as (typeof b.furniture)[number]["kind"])).toBe(true);
    }
    expect(b.partitions.length).toBeGreaterThan(0); // the house is divided
    // The hall is clear: the door reaches a desk seat without passing furniture
    // it would have to walk through.
    expect(findPath(world, b.door, b.seats[0]).length).toBeGreaterThan(0);
  });

  it("fences each lot, mows the yard and lays a path to an open gate", () => {
    const world = buildWorld(model("A", "B"));
    for (const b of world.buildings) {
      expect(isWalkable(world, b.door.x, b.door.y)).toBe(true); // the yard apron
      expect(isWalkable(world, b.gate.x, b.gate.y)).toBe(true); // the gate is open
      expect(world.path[b.door.y * world.cols + b.door.x]).toBe(true);
      // The door still reaches the street through its own gate.
      expect(findPath(world, b.door, world.edge).length).toBeGreaterThan(0);
    }
    expect(world.fences.length).toBeGreaterThan(0);
    for (const f of world.fences) {
      expect(isWalkable(world, f.x, f.y)).toBe(false);
      expect(isRoad(world, f.x, f.y)).toBe(false); // never built over the street
    }
    expect(world.yard.some(Boolean)).toBe(true);
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
  it("carves a central paved plaza, walkable except the fountain centre", () => {
    const world = buildWorld(model("A", "B", "C"));
    const p = world.plaza;
    const c = world.plazaCenter!;
    expect(c).not.toBeNull();
    expect(p.w).toBeGreaterThan(0);
    for (let dy = 0; dy < p.h; dy++) {
      for (let dx = 0; dx < p.w; dx++) {
        const x = p.x + dx;
        const y = p.y + dy;
        const isCentre = x === c.x && y === c.y;
        const isProp = propTiles(world).has(`${x},${y}`);
        // Pavement is painted under the whole plaza (incl. beneath the fountain
        // and the furnishings); a tile is walkable unless the fountain or one of
        // the blocked props (planter, notice board, market stall, …) sits on it.
        expect(isRoad(world, x, y)).toBe(true);
        expect(isWalkable(world, x, y)).toBe(!isCentre && !isProp);
      }
    }
    // No building sits on the plaza.
    for (const b of world.buildings) {
      const overlaps = p.x < b.tx + b.tw && b.tx < p.x + p.w && p.y < b.ty + b.th && b.ty < p.y + p.h;
      expect(overlaps).toBe(false);
    }
  });

  it("keeps a walkable ring around the blocked fountain centre", () => {
    const world = buildWorld(model("A", "B", "C"));
    const c = world.plazaCenter!;
    expect(isWalkable(world, c.x, c.y)).toBe(false);
    // A tile beside the fountain is walkable and still reachable from a door —
    // blocking the centre must not island the commons.
    const beside = { x: c.x - 1, y: c.y };
    expect(isWalkable(world, beside.x, beside.y)).toBe(true);
    expect(findPath(world, world.buildings[0].door, beside).length).toBeGreaterThan(0);
  });

  it("lines the roads with blocked lamp tiles that keep the town connected", () => {
    const world = buildWorld(model("A", "B", "C", "D"));
    expect(world.lamps.length).toBeGreaterThan(0);
    for (const l of world.lamps) {
      expect(isWalkable(world, l.x, l.y)).toBe(false); // blocked → routed around, not through
      expect(isRoad(world, l.x, l.y)).toBe(false); // sits on green beside the road
      expect(isRoad(world, l.x, l.y - 1)).toBe(true); // immediately south of a road
    }
    // Blocking the lamps must not island anything: every door still reaches the
    // plaza, and the walk-off edge is still reachable.
    const target = openPlazaTile(world);
    for (const b of world.buildings) {
      expect(findPath(world, b.door, target).length).toBeGreaterThan(0);
    }
    expect(findPath(world, world.buildings[0].door, world.edge).length).toBeGreaterThan(0);
  });

  it("connects every building's door to the plaza by road", () => {
    const world = buildWorld(model("A", "B", "C", "D"));
    // Target a walkable plaza corner (the geometric centre is the blocked fountain).
    const target = openPlazaTile(world);
    expect(isWalkable(world, target.x, target.y)).toBe(true);
    for (const b of world.buildings) {
      const path = findPath(world, b.door, target);
      expect(path.length).toBeGreaterThan(0);
    }
  });
});

describe("buildWorld — the furnished commons", () => {
  it("seats the town: at least one seat per five open plaza tiles", () => {
    const world = buildWorld(model("A", "B", "C"));
    const p = world.plaza;
    const inPlaza = (t: { x: number; y: number }) =>
      t.x >= p.x && t.x < p.x + p.w && t.y >= p.y && t.y < p.y + p.h;

    let open = 0;
    for (let dy = 0; dy < p.h; dy++) {
      for (let dx = 0; dx < p.w; dx++) if (isWalkable(world, p.x + dx, p.y + dy)) open++;
    }
    const seats = world.spots.filter((s) => s.kind === "bench" && inPlaza(s.tile));
    // Whyte's ratio, in tiles. A one-bench plaza is the failure this guards.
    expect(seats.length).toBeGreaterThanOrEqual(Math.ceil(open / 5));
  });

  it("puts every spot on a distinct walkable tile", () => {
    const world = buildWorld(model("A", "B", "C"));
    const keys = new Set(world.spots.map((s) => `${s.tile.x},${s.tile.y}`));
    expect(keys.size).toBe(world.spots.length); // no two share a tile
    for (const s of world.spots) {
      expect(isWalkable(world, s.tile.x, s.tile.y)).toBe(true);
    }
  });

  it("keeps water, fire and planting off the pavement", () => {
    const world = buildWorld(model("A", "B", "C"));
    const p = world.plaza;
    const kinds = new Set(world.spots.map((s) => s.kind));
    expect(kinds.has("pond")).toBe(true);
    expect(kinds.has("campfire")).toBe(true);
    expect(kinds.has("garden")).toBe(true);
    for (const s of world.spots) {
      if (s.kind === "bench") continue;
      const inPlaza =
        s.tile.x >= p.x && s.tile.x < p.x + p.w && s.tile.y >= p.y && s.tile.y < p.y + p.h;
      expect(inPlaza).toBe(false); // on the green beside the commons, not on it
      expect(isRoad(world, s.tile.x, s.tile.y)).toBe(false);
    }
  });

  it("furnishes the square with blocked props that never island it", () => {
    const world = buildWorld(model("A", "B", "C", "D"));
    expect(world.props.length).toBeGreaterThan(0);
    const kinds = new Set(world.props.map((p) => p.kind));
    expect(kinds.has("planter")).toBe(true);
    expect(kinds.has("noticeboard")).toBe(true);
    for (const p of world.props) {
      expect(isWalkable(world, p.tile.x, p.tile.y)).toBe(false);
    }
    // Every seat is still reachable from every door with the props in place.
    const seat = world.spots.find((s) => s.kind === "bench")!;
    for (const b of world.buildings) {
      expect(findPath(world, b.door, seat.tile).length).toBeGreaterThan(0);
    }
  });

  it("never puts a street lamp on a seat", () => {
    const world = buildWorld(model("A", "B", "C", "D", "E"));
    const seats = new Set(world.spots.map((s) => `${s.tile.x},${s.tile.y}`));
    for (const l of world.lamps) expect(seats.has(`${l.x},${l.y}`)).toBe(false);
  });
});
