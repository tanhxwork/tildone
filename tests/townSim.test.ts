import { describe, expect, it } from "bun:test";
import {
  createSim,
  stepTownSim,
  type RosterChar,
  type SimState,
} from "../src/town/sim";
import { buildWorld, type TownWorld } from "../src/town/world";
import type { TownModel, TownRoom } from "../src/selectors";
import type { PresenceState } from "../src/utils/presence";

// The sim owns physical state (position, path, activity) over the pure roster.
// These pin the behaviour spine: spawn at the door, working→wander walks out,
// wander→working walks home, blocked paces the frontage, ended walks off and
// despawns, and reduced-motion collapses to a still tableau. Deterministic via
// a seeded rng — prior art: the pure townModel unit tests.

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function room(name: string): TownRoom {
  return { projectId: 1, name, color: null, characters: [] };
}
function world2(): TownWorld {
  const model: TownModel = { rooms: [room("A"), room("B")] };
  return buildWorld(model, 10_000, 2); // wide → both buildings on one row
}

function roster(
  taskId: number,
  state: PresenceState,
  live: boolean,
  buildingIndex = 0,
): RosterChar {
  return { taskId, agentName: "claude", state, live, buildingIndex };
}

/** Run N fixed 16ms steps. */
function run(sim: SimState, r: RosterChar[], world: TownWorld, n: number, rng: () => number) {
  for (let i = 0; i < n; i++) stepTownSim(sim, r, 16, world, rng);
}

describe("stepTownSim", () => {
  it("spawns a newcomer at its building's door", () => {
    const world = world2();
    const sim = createSim();
    stepTownSim(sim, [roster(1, "working", true)], 16, world, mulberry32(1));
    const c = sim.chars.get(1)!;
    expect(c).toBeDefined();
    expect({ x: Math.round(c.pos.x), y: Math.round(c.pos.y) }).toEqual(world.buildings[0].door);
  });

  it("keeps a working character home at its door", () => {
    const world = world2();
    const sim = createSim();
    run(sim, [roster(1, "working", true)], world, 60, mulberry32(2));
    const c = sim.chars.get(1)!;
    expect({ x: Math.round(c.pos.x), y: Math.round(c.pos.y) }).toEqual(world.buildings[0].door);
    expect(c.moving).toBe(false);
  });

  it("walks an idle (quiet+live) character out to wander", () => {
    const world = world2();
    const door = world.buildings[0].door;
    const sim = createSim();
    const rng = mulberry32(3);
    run(sim, [roster(1, "quiet", true)], world, 200, rng);
    const c = sim.chars.get(1)!;
    const here = { x: Math.round(c.pos.x), y: Math.round(c.pos.y) };
    // It has left its door tile — wandering is visible motion away from home.
    expect(here).not.toEqual(door);
  });

  it("walks a resuming (quiet→working) character back home", () => {
    const world = world2();
    const door = world.buildings[0].door;
    const sim = createSim();
    const rng = mulberry32(4);
    run(sim, [roster(1, "quiet", true)], world, 200, rng); // wander away first
    const away = sim.chars.get(1)!;
    expect({ x: Math.round(away.pos.x), y: Math.round(away.pos.y) }).not.toEqual(door);
    run(sim, [roster(1, "working", true)], world, 400, rng); // now resume work
    const c = sim.chars.get(1)!;
    expect({ x: Math.round(c.pos.x), y: Math.round(c.pos.y) }).toEqual(door);
  });

  it("paces a blocked character across its building frontage only", () => {
    const world = world2();
    const door = world.buildings[0].door;
    const sim = createSim();
    const rng = mulberry32(5);
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      stepTownSim(sim, [roster(1, "blocked", true)], 16, world, rng);
      const c = sim.chars.get(1)!;
      seen.add(`${Math.round(c.pos.x)},${Math.round(c.pos.y)}`);
    }
    const frontage = new Set([`${door.x},${door.y}`, `${door.x - 1},${door.y}`, `${door.x + 1},${door.y}`]);
    for (const s of seen) expect(frontage.has(s)).toBe(true);
  });

  it("walks an ended session off to the edge, then despawns (not instant)", () => {
    // Compact 1-building world so the edge is a few tiles from the door.
    const world = buildWorld({ rooms: [room("A")] }, 1, 2);
    const sim = createSim();
    const rng = mulberry32(6);
    stepTownSim(sim, [roster(1, "working", true)], 16, world, rng); // spawn
    // Roster now empty → it should still be present, heading for the edge.
    stepTownSim(sim, [], 16, world, rng);
    expect(sim.chars.get(1)).toBeDefined();
    expect(sim.chars.get(1)!.intent).toBe("off");
    // Given time it reaches the edge and is removed.
    run(sim, [], world, 600, rng);
    expect(sim.chars.get(1)).toBeUndefined();
  });

  it("collapses to a still tableau under reduced motion", () => {
    const world = world2();
    const door = world.buildings[0].door;
    const sim = createSim();
    const rng = mulberry32(7);
    run(sim, [roster(1, "quiet", true)], world, 200, rng); // get it wandering/moving
    stepTownSim(sim, [roster(1, "quiet", true)], 16, world, rng, { reducedMotion: true });
    const c = sim.chars.get(1)!;
    expect({ x: Math.round(c.pos.x), y: Math.round(c.pos.y) }).toEqual(door);
    expect(c.path).toHaveLength(0);
    expect(c.moving).toBe(false);
  });

  it("places characters in the building matching their roster buildingIndex", () => {
    const world = world2();
    const sim = createSim();
    stepTownSim(
      sim,
      [roster(1, "working", true, 0), roster(2, "working", true, 1)],
      16,
      world,
      mulberry32(8),
    );
    expect({ x: Math.round(sim.chars.get(1)!.pos.x), y: Math.round(sim.chars.get(1)!.pos.y) }).toEqual(
      world.buildings[0].door,
    );
    expect({ x: Math.round(sim.chars.get(2)!.pos.x), y: Math.round(sim.chars.get(2)!.pos.y) }).toEqual(
      world.buildings[1].door,
    );
  });
});
