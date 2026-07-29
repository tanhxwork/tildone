import { describe, expect, it } from "bun:test";
import { findPath } from "../src/town/pathfind";
import { buildWorld } from "../src/town/world";
import type { TownModel, TownRoom } from "../src/selectors";

// A* over the walkability grid: straight on open ground, routes around a
// building obstacle, empty when unreachable / goal blocked, trivial when
// start == goal. Prior art: the pure-selector unit tests (townModel).

function room(name: string): TownRoom {
  return { projectId: 1, name, color: null, characters: [], openTaskCount: 1 };
}
function model(...names: string[]): TownModel {
  return { rooms: names.map(room) };
}

describe("findPath", () => {
  // A wide 1-building world gives us open green plus one obstacle to route past.
  const world = buildWorld(model("A"), 10_000, 2);
  const b = world.buildings[0];

  it("returns [from] when start equals goal", () => {
    const p = findPath(world, { x: 0, y: 0 }, { x: 0, y: 0 });
    expect(p).toEqual([{ x: 0, y: 0 }]);
  });

  it("walks a straight Manhattan line across open ground", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 3, y: 0 };
    const p = findPath(world, from, to);
    expect(p[0]).toEqual(from);
    expect(p[p.length - 1]).toEqual(to);
    expect(p).toHaveLength(4); // 0,1,2,3 along a clear row
  });

  it("routes around a building's lot rather than through it", () => {
    // Start and finish OUTSIDE the lot fence, on the footprint's own row: the
    // tiles immediately beside a building are the fence posts now, so the
    // straight line is blocked by the fence as well as by the walls.
    const from = { x: b.tx - 2, y: b.ty };
    const to = { x: b.tx + b.tw + 1, y: b.ty };
    const p = findPath(world, from, to);
    expect(p.length).toBeGreaterThan(0);
    expect(p[0]).toEqual(from);
    expect(p[p.length - 1]).toEqual(to);
    // No step ever lands on a blocked footprint tile...
    for (const t of p) {
      const onFootprint =
        t.x >= b.tx && t.x < b.tx + b.tw && t.y >= b.ty && t.y < b.ty + b.th;
      expect(onFootprint).toBe(false);
    }
    // ...nor on a fence post.
    const fences = new Set(world.fences.map((f) => `${f.x},${f.y}`));
    for (const t of p) expect(fences.has(`${t.x},${t.y}`)).toBe(false);
    // And it costs more than the blocked straight line (had to go around).
    expect(p.length).toBeGreaterThan(b.tw + 1);
  });

  it("is empty when the goal is a blocked (building) tile", () => {
    const goal = { x: b.tx, y: b.ty };
    expect(findPath(world, { x: 0, y: 0 }, goal)).toEqual([]);
  });

  it("is empty when the start is off the grid", () => {
    expect(findPath(world, { x: -1, y: -1 }, { x: 0, y: 0 })).toEqual([]);
  });

  it("produces a contiguous 4-connected path (no diagonal jumps)", () => {
    const p = findPath(world, { x: 0, y: 0 }, { x: b.tx + b.tw, y: b.ty });
    for (let i = 1; i < p.length; i++) {
      const step = Math.abs(p[i].x - p[i - 1].x) + Math.abs(p[i].y - p[i - 1].y);
      expect(step).toBe(1);
    }
  });
});
