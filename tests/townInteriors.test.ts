import { describe, expect, it } from "bun:test";
import type { TownModel, TownRoom } from "../src/selectors";
import {
  buildWorld,
  isWalkable,
  type BuildingPlacement,
  type Rect,
  type Tile,
  type TownWorld,
} from "../src/town/world";

// The floor-plan invariants, as measurements rather than taste calls — the same
// shape as the plaza's seat budget (TIL-189), and for the same reason: the
// geometry has already changed three times, and a rule stated as a number stays
// true across the next change while a rule stated as a layout does not.
//
// These pin what TIL-197 measured and found broken:
//   - the bedroom held three blocked items in three tiles: 0% standable, so no
//     character could ever be in it and the place tree could never name it;
//   - the workroom was 60/50/43% of the interior — a call centre with a
//     kitchenette;
//   - density fell 0.44 → 0.33 from medium to large, so the busiest project got
//     the emptiest home.

function room(name: string, projectId: number | null = 1, openTaskCount = 1): TownRoom {
  return { projectId, name, color: null, characters: [], openTaskCount };
}

const TIERS: TownModel = {
  rooms: [room("small", 1, 1), room("medium", 2, 4), room("large", 3, 12)],
};

/** Every tile of a rect. */
function tilesOf(r: Rect): Tile[] {
  const out: Tile[] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y });
  return out;
}

/** Interior tiles a character can actually stand on, reached from the doorway.
 *  Walkability alone is not enough — a room walled off by its own furniture is
 *  walkable and unreachable, which is the failure the invariant exists to catch. */
function reachableInterior(world: TownWorld, b: BuildingPlacement): Set<string> {
  const start = { x: b.door.x, y: b.door.y - 1 }; // the gap in the facade
  const seen = new Set<string>();
  if (!isWalkable(world, start.x, start.y)) return seen;
  const queue: Tile[] = [start];
  seen.add(`${start.x},${start.y}`);
  const inside = (t: Tile) =>
    t.x >= b.interior.x &&
    t.x < b.interior.x + b.interior.w &&
    t.y >= b.interior.y &&
    t.y < b.interior.y + b.interior.h;
  while (queue.length) {
    const t = queue.shift()!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const n = { x: t.x + dx, y: t.y + dy };
      const key = `${n.x},${n.y}`;
      if (seen.has(key) || !inside(n) || !isWalkable(world, n.x, n.y)) continue;
      seen.add(key);
      queue.push(n);
    }
  }
  return seen;
}

describe("house floor plans — every named room is a place you can be", () => {
  const world = buildWorld(TIERS);

  it.each(["small", "medium", "large"])(
    "%s: every room is at least half standable, with two free tiles",
    (tier) => {
      const b = world.buildings.find((x) => x.tier === tier)!;
      const reached = reachableInterior(world, b);
      for (const r of b.rooms) {
        const tiles = tilesOf(r.rect);
        const free = tiles.filter((t) => reached.has(`${t.x},${t.y}`));
        expect({ room: r.kind, free: free.length, of: tiles.length }).toEqual({
          room: r.kind,
          free: free.length,
          of: tiles.length,
        });
        // ≥2 free tiles, and ≥50% of the room standable.
        expect(free.length).toBeGreaterThanOrEqual(2);
        expect(free.length / tiles.length).toBeGreaterThanOrEqual(0.5);
      }
    },
  );

  it.each(["small", "medium", "large"])("%s: has a bedroom you can walk into", (tier) => {
    const b = world.buildings.find((x) => x.tier === tier)!;
    const bed = b.rooms.find((r) => r.kind === "bedroom");
    expect(bed).toBeDefined();
    const reached = reachableInterior(world, b);
    const free = tilesOf(bed!.rect).filter((t) => reached.has(`${t.x},${t.y}`));
    expect(free.length).toBeGreaterThanOrEqual(2);
  });

  it.each(["small", "medium", "large"])(
    "%s: the workroom is at most a third of the interior",
    (tier) => {
      const b = world.buildings.find((x) => x.tier === tier)!;
      const wr = b.rooms.find((r) => r.kind === "workroom")!;
      const interior = b.interior.w * b.interior.h;
      expect(wr.rect.w * wr.rect.h).toBeLessThanOrEqual(Math.floor(interior / 3));
    },
  );

  it("holds furniture density steady as the house grows", () => {
    for (const b of world.buildings) {
      const density = b.furniture.length / (b.interior.w * b.interior.h);
      expect(density).toBeGreaterThanOrEqual(0.4);
      expect(density).toBeLessThanOrEqual(0.45);
    }
    // …and a bigger house therefore holds strictly more stuff, which is the
    // thing that was backwards: medium → large used to add 22 tiles and 2 items.
    const [s, m, l] = ["small", "medium", "large"].map(
      (t) => world.buildings.find((b) => b.tier === t)!,
    );
    expect(m.furniture.length).toBeGreaterThan(s.furniture.length);
    expect(l.furniture.length).toBeGreaterThan(m.furniture.length);
  });

  it("gives a bigger house more kinds of thing, not more of the same thing", () => {
    const kinds = (b: BuildingPlacement) => new Set(b.furniture.map((f) => f.kind)).size;
    const [s, m, l] = ["small", "medium", "large"].map(
      (t) => world.buildings.find((b) => b.tier === t)!,
    );
    expect(kinds(m)).toBeGreaterThanOrEqual(kinds(s));
    expect(kinds(l)).toBeGreaterThan(kinds(s));
  });

  it("leaves nothing stranded mid-floor — every item touches a wall or its group", () => {
    for (const b of world.buildings) {
      const items = new Set(b.furniture.map((f) => `${f.tile.x},${f.tile.y}`));
      const solid = (x: number, y: number) =>
        items.has(`${x},${y}`) || !isWalkable(world, x, y);
      for (const f of b.furniture) {
        if (f.kind === "rug") continue; // a rug is floor, and floor is meant to be open
        const touching = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dx, dy]) => solid(f.tile.x + dx, f.tile.y + dy));
        expect({ kind: f.kind, at: f.tile, touching }).toEqual({
          kind: f.kind,
          at: f.tile,
          touching: true,
        });
      }
    }
  });
});

describe("house clutter — whose house this is", () => {
  it("gives two projects of the same tier different clutter", () => {
    const world = buildWorld({ rooms: [room("Alpha", 1, 4), room("Beta", 2, 4)] });
    const [a, b] = world.buildings;
    expect(a.tier).toBe(b.tier);
    const sig = (x: BuildingPlacement) =>
      x.clutter
        .map((c) => c.kind)
        .sort()
        .join(",");
    expect(sig(a)).not.toBe(sig(b));
  });

  it("gives the same project the same clutter every build", () => {
    const one = buildWorld({ rooms: [room("Alpha", 1, 4)] }).buildings[0];
    const two = buildWorld({ rooms: [room("Alpha", 1, 4)] }).buildings[0];
    expect(two.clutter.map((c) => c.kind)).toEqual(one.clutter.map((c) => c.kind));
  });

  it.each(["small", "medium", "large"])("%s: has three to five personal things", (tier) => {
    // The research asks for 3–5 clutter items per house *and* for 0.40–0.45
    // items per interior tile. Those only looked like they conflicted: density
    // is about the house's total furniture, so a large house's deficit is met by
    // fitting it out more thoroughly — a second bookshelf, another rug, more
    // greenery — and clutter stays the handful of personal things it is supposed
    // to be. Filling the entire deficit with clutter, and then calling the
    // ceiling unholdable, was the wrong reading.
    const b = buildWorld(TIERS).buildings.find((x) => x.tier === tier)!;
    expect(b.clutter.length).toBeGreaterThanOrEqual(3);
    expect(b.clutter.length).toBeLessThanOrEqual(5);
  });

  it("counts clutter as furniture, and keeps it inside the house", () => {
    const b = buildWorld({ rooms: [room("Alpha", 1, 12)] }).buildings[0];
    expect(b.clutter.length).toBeGreaterThanOrEqual(3);
    const furniture = new Set(b.furniture.map((f) => `${f.tile.x},${f.tile.y}`));
    for (const c of b.clutter) {
      expect(furniture.has(`${c.tile.x},${c.tile.y}`)).toBe(true);
      expect(c.tile.x).toBeGreaterThanOrEqual(b.interior.x);
      expect(c.tile.x).toBeLessThan(b.interior.x + b.interior.w);
      expect(c.tile.y).toBeGreaterThanOrEqual(b.interior.y);
      expect(c.tile.y).toBeLessThan(b.interior.y + b.interior.h);
    }
  });
});

describe("affordances — what a character can do in a house", () => {
  it("offers a standing tile beside each usable object", () => {
    const world = buildWorld(TIERS);
    for (const b of world.buildings) {
      expect(b.affordances.length).toBeGreaterThan(0);
      const reached = reachableInterior(world, b);
      for (const a of b.affordances) {
        // You have to be able to stand there…
        expect(isWalkable(world, a.tile.x, a.tile.y)).toBe(true);
        expect(reached.has(`${a.tile.x},${a.tile.y}`)).toBe(true);
        // …and the thing you are using has to be next to you.
        const d = Math.abs(a.tile.x - a.object.x) + Math.abs(a.tile.y - a.object.y);
        expect(d).toBe(1);
      }
    }
  });

  it("names a verb for the kitchen counter and the bookshelf", () => {
    const b = buildWorld({ rooms: [room("Alpha", 1, 12)] }).buildings[0];
    const verbs = new Set(b.affordances.map((a) => a.verb));
    expect(verbs.has("coffee")).toBe(true);
    expect(verbs.has("reading")).toBe(true);
  });

  it("gives a resting character somewhere to sit and somewhere to sleep", () => {
    const world = buildWorld(TIERS);
    for (const b of world.buildings) {
      const kinds = new Set(b.restSpots.map((r) => r.kind));
      expect(kinds.has("sofa")).toBe(true);
      expect(kinds.has("bed")).toBe(true);
      const reached = reachableInterior(world, b);
      for (const r of b.restSpots) {
        expect(reached.has(`${r.tile.x},${r.tile.y}`)).toBe(true);
      }
    }
  });
});
