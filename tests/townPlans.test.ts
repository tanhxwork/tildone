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

// Dynamic floor plans, held to the SAME invariants as the single plan they
// replace — measured across every variant rather than on the one house the
// original test happened to build.
//
// The reason this file exists rather than a few more cases in townInteriors:
// "the layout varies" is a promise about a *space* of layouts, and a space is
// only as sound as its worst member. A plan chosen from a hash means the bad
// variant does not show up on the machine that wrote it; it shows up on the
// machine whose project happens to be called something else. So the sweep is
// wide (many names × every tier), and it asserts the same measurements
// TIL-197/199 pinned: every named room standable and reachable, the workroom
// no more than a third of the house, density inside 0.40–0.45, 3–5 personal
// things, nothing stranded mid-floor, and every desk seat walkable-to.

const NAMES = [
  "Alpha",
  "Beta",
  "Gamma",
  "Delta",
  "Tildone",
  "zeno-logistics",
  "browser-harness",
  "Inbox",
  "a",
  "Some Project With A Long Name",
  "…",
  "1",
  "22",
  "333",
  "Ωmega",
  "kebab-case-name",
  "snake_case_name",
  "MiXeDcAsE",
];
/** Open-task counts that land on each tier (small ≤2, medium 3–6, large >6). */
const COUNTS = [1, 2, 4, 6, 9, 20];

function room(name: string, projectId: number, openTaskCount: number): TownRoom {
  return { projectId, name, color: null, characters: [], openTaskCount };
}

function tilesOf(r: Rect): Tile[] {
  const out: Tile[] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y });
  return out;
}

/** Interior tiles reachable on foot from the doorway (not merely walkable). */
function reachableInterior(world: TownWorld, b: BuildingPlacement): Set<string> {
  const start = { x: b.door.x, y: b.door.y - 1 };
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

/** Every house in the sweep, with the world it belongs to. */
const HOUSES: { world: TownWorld; b: BuildingPlacement; label: string }[] = [];
for (const count of COUNTS) {
  // One world per (count) with every name in it, so the sweep also exercises
  // real lattices rather than a one-house town.
  const model: TownModel = { rooms: NAMES.map((n, i) => room(n, i + 1, count)) };
  const world = buildWorld(model);
  world.buildings.forEach((b) => {
    HOUSES.push({ world, b, label: `${b.room.name} (${b.tier}, ${count} open)` });
  });
}

describe("dynamic floor plans — every variant is a house you can live in", () => {
  it("builds every name × tier without a room nobody can stand in", () => {
    const bad: string[] = [];
    for (const { world, b, label } of HOUSES) {
      const reached = reachableInterior(world, b);
      for (const r of b.rooms) {
        const tiles = tilesOf(r.rect);
        const free = tiles.filter((t) => reached.has(`${t.x},${t.y}`));
        if (free.length < 2 || free.length / tiles.length < 0.5) {
          bad.push(`${label}: ${r.kind} ${free.length}/${tiles.length} standable`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps every desk seat walkable-to, in every variant", () => {
    const bad: string[] = [];
    for (const { world, b, label } of HOUSES) {
      const reached = reachableInterior(world, b);
      for (const s of b.seats) {
        if (!reached.has(`${s.x},${s.y}`)) bad.push(`${label}: seat ${s.x},${s.y} unreachable`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps the workroom to a third of the house, and the density band", () => {
    const bad: string[] = [];
    for (const { b, label } of HOUSES) {
      const area = b.interior.w * b.interior.h;
      const wr = b.rooms.find((r) => r.kind === "workroom")!;
      if (wr.rect.w * wr.rect.h > Math.floor(area / 3)) bad.push(`${label}: workroom too big`);
      const density = b.furniture.length / area;
      if (density < 0.4 || density > 0.45) bad.push(`${label}: density ${density.toFixed(3)}`);
      if (b.clutter.length < 3 || b.clutter.length > 5) {
        bad.push(`${label}: ${b.clutter.length} personal things`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("strands nothing mid-floor, in every variant", () => {
    const bad: string[] = [];
    for (const { world, b, label } of HOUSES) {
      const items = new Set(b.furniture.map((f) => `${f.tile.x},${f.tile.y}`));
      for (const f of b.furniture) {
        if (f.kind === "rug") continue;
        const touching = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(
          ([dx, dy]) =>
            items.has(`${f.tile.x + dx},${f.tile.y + dy}`) ||
            !isWalkable(world, f.tile.x + dx, f.tile.y + dy),
        );
        if (!touching) bad.push(`${label}: ${f.kind} stranded at ${f.tile.x},${f.tile.y}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("gives every house somewhere to sit and somewhere to sleep", () => {
    const bad: string[] = [];
    for (const { b, label } of HOUSES) {
      const kinds = new Set(b.restSpots.map((r) => r.kind));
      if (!kinds.has("sofa")) bad.push(`${label}: no sofa`);
      if (!kinds.has("bed")) bad.push(`${label}: no bed`);
    }
    expect(bad).toEqual([]);
  });

  it("keeps every affordance in the room it belongs to, and beside its object", () => {
    const bad: string[] = [];
    for (const { world, b, label } of HOUSES) {
      const reached = reachableInterior(world, b);
      for (const a of b.affordances) {
        if (!reached.has(`${a.tile.x},${a.tile.y}`)) bad.push(`${label}: ${a.kind} unreachable`);
        const d = Math.abs(a.tile.x - a.object.x) + Math.abs(a.tile.y - a.object.y);
        if (d !== 1) bad.push(`${label}: ${a.kind} not adjacent`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("dynamic floor plans — the town is not one house repeated", () => {
  it("varies the plan across projects of the same tier", () => {
    const model: TownModel = { rooms: NAMES.map((n, i) => room(n, i + 1, 9)) };
    const world = buildWorld(model);
    const plans = new Set(
      world.buildings.map(
        (b) =>
          `${b.plan.mirrored}|${b.plan.hallCol}|${b.plan.kitchenAtBack}|${b.plan.bedAtBack}|${b.plan.bath}`,
      ),
    );
    // Same tier, same size, and still several distinct layouts.
    expect(new Set(world.buildings.map((b) => b.tier)).size).toBe(1);
    expect(plans.size).toBeGreaterThanOrEqual(6);
  });

  it("mirrors the plan without moving the front door off the hall", () => {
    for (const { b, label } of HOUSES) {
      const hall = b.rooms.find((r) => r.kind === "hall")!;
      expect({ label, doorInHall: b.door.x === hall.rect.x }).toEqual({ label, doorInHall: true });
    }
  });

  it("gives some houses a bathroom, and keeps its fixtures in it", () => {
    const withBath = HOUSES.filter(({ b }) => b.rooms.some((r) => r.kind === "bathroom"));
    expect(withBath.length).toBeGreaterThan(0);
    for (const { b, label } of withBath) {
      const shower = b.furniture.find((f) => f.kind === "shower");
      expect({ label, shower: shower?.room }).toEqual({ label, shower: "bathroom" });
    }
  });

  it("builds the same house for the same project every time", () => {
    const one = buildWorld({ rooms: [room("Alpha", 1, 9)] }).buildings[0];
    const two = buildWorld({ rooms: [room("Alpha", 1, 9)] }).buildings[0];
    expect(two.plan).toEqual(one.plan);
    expect(two.furniture.map((f) => `${f.kind}@${f.tile.x},${f.tile.y}`)).toEqual(
      one.furniture.map((f) => `${f.kind}@${f.tile.x},${f.tile.y}`),
    );
  });
});

describe("what there is to do — indoors and out", () => {
  it("offers a working house more than a kettle", () => {
    const model: TownModel = { rooms: NAMES.map((n, i) => room(n, i + 1, 20)) };
    const world = buildWorld(model);
    // Across the town's large houses, every workday and evening verb the sim
    // can pick has somewhere to happen.
    const verbs = new Set(world.buildings.flatMap((b) => b.affordances.map((a) => a.verb)));
    for (const v of ["coffee", "reading", "eating", "watching", "cooking", "planning"]) {
      expect({ verb: v, present: verbs.has(v as never) }).toEqual({ verb: v, present: true });
    }
  });

  it("names what each leisure spot is for", () => {
    const model: TownModel = { rooms: NAMES.map((n, i) => room(n, i + 1, 4)) };
    const world = buildWorld(model);
    expect(world.spots.length).toBeGreaterThan(0);
    for (const s of world.spots) expect(typeof s.verb).toBe("string");
    const verbs = new Set(world.spots.map((s) => s.verb));
    // The square and the parks between them cover more than sitting down.
    expect(verbs.has("fishing")).toBe(true);
    expect(verbs.has("gardening")).toBe(true);
    expect(verbs.size).toBeGreaterThanOrEqual(5);
  });

  it("puts a standing place at the cart, the stall and the notice board", () => {
    const model: TownModel = { rooms: NAMES.map((n, i) => room(n, i + 1, 4)) };
    const world = buildWorld(model);
    const kinds = new Set(world.spots.map((s) => s.kind));
    for (const k of ["cart", "stall", "board"]) {
      expect({ kind: k, present: kinds.has(k as never) }).toEqual({ kind: k, present: true });
    }
    // A standing place is walkable and beside its prop — the prop stays blocked.
    for (const s of world.spots) {
      expect(isWalkable(world, s.tile.x, s.tile.y)).toBe(true);
    }
  });
});
