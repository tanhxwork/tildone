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

function room(name: string, openTaskCount = 1): TownRoom {
  return { projectId: 1, name, color: null, characters: [], openTaskCount };
}
function world2(): TownWorld {
  const model: TownModel = { rooms: [room("A"), room("B")] };
  return buildWorld(model); // small offices (2 desks each)
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

  it("walks a working character inside to sit at its desk seat", () => {
    const world = world2();
    const sim = createSim();
    run(sim, [roster(1, "working", true)], world, 60, mulberry32(2));
    const c = sim.chars.get(1)!;
    // It has left the door and is sitting on its building's first seat, facing
    // up into the monitor.
    expect({ x: Math.round(c.pos.x), y: Math.round(c.pos.y) }).toEqual(world.buildings[0].seats[0]);
    expect(c.moving).toBe(false);
    expect(c.seated).toBe(true);
    expect(c.facing).toBe("up");
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

  it("walks a resuming (quiet→working) character back home to its desk seat", () => {
    const world = world2();
    const seat = world.buildings[0].seats[0];
    const sim = createSim();
    const rng = mulberry32(4);
    run(sim, [roster(1, "quiet", true)], world, 200, rng); // wander away first
    const away = sim.chars.get(1)!;
    expect({ x: Math.round(away.pos.x), y: Math.round(away.pos.y) }).not.toEqual(seat);
    run(sim, [roster(1, "working", true)], world, 400, rng); // now resume work
    const c = sim.chars.get(1)!;
    expect({ x: Math.round(c.pos.x), y: Math.round(c.pos.y) }).toEqual(seat);
    expect(c.seated).toBe(true);
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

describe("stepTownSim — desk seating (work-sim)", () => {
  it("seats two workers in one building at distinct desks", () => {
    const world = world2();
    const seats = world.buildings[0].seats;
    const sim = createSim();
    const rng = mulberry32(21);
    run(sim, [roster(1, "working", true, 0), roster(2, "working", true, 0)], world, 120, rng);
    const a = sim.chars.get(1)!;
    const b = sim.chars.get(2)!;
    const seatKeys = new Set(seats.map((s) => `${s.x},${s.y}`));
    for (const c of [a, b]) {
      expect(c.seated).toBe(true);
      const here = `${Math.round(c.pos.x)},${Math.round(c.pos.y)}`;
      expect(seatKeys.has(here)).toBe(true); // sitting on a real desk seat
    }
    // The two workers are not on the same desk.
    expect(`${Math.round(a.pos.x)},${Math.round(a.pos.y)}`).not.toBe(
      `${Math.round(b.pos.x)},${Math.round(b.pos.y)}`,
    );
  });

  it("gives up its desk and walks back out when the session goes idle", () => {
    const world = world2();
    const seat = world.buildings[0].seats[0];
    const sim = createSim();
    const rng = mulberry32(22);
    run(sim, [roster(1, "working", true)], world, 120, rng); // sit down
    expect(sim.chars.get(1)!.seated).toBe(true);
    // Goes idle (quiet+live) → must leave the seat and end up outside the house.
    run(sim, [roster(1, "quiet", true)], world, 400, rng);
    const c = sim.chars.get(1)!;
    expect(c.seated).toBe(false);
    const here = { x: Math.round(c.pos.x), y: Math.round(c.pos.y) };
    expect(here).not.toEqual(seat);
    // It is no longer inside the footprint (walked out through the door).
    const b = world.buildings[0];
    const inside = here.x >= b.tx && here.x < b.tx + b.tw && here.y >= b.ty && here.y < b.ty + b.th;
    expect(inside).toBe(false);
  });
});

describe("stepTownSim — leisure spots (v2b)", () => {
  it("sends an idle character to a free spot, then releases it after lingering", () => {
    const world = world2(); // 2 buildings → 2 shared spots
    expect(world.spots.length).toBeGreaterThan(0);
    const sim = createSim();
    const rng = mulberry32(11);
    let claimed = false;
    let releasedAfterClaim = false;
    for (let i = 0; i < 1500; i++) {
      stepTownSim(sim, [roster(1, "quiet", true)], 16, world, rng);
      const c = sim.chars.get(1)!;
      if (c.spotId !== null) {
        claimed = true;
        // While claimed, the occupancy map points the spot back at this char.
        expect(sim.occupied.get(c.spotId)).toBe(1);
      } else if (claimed) {
        releasedAfterClaim = true;
      }
    }
    expect(claimed).toBe(true);
    expect(releasedAfterClaim).toBe(true);
    // Nothing left holding a spot it isn't at.
    expect(sim.occupied.size).toBeLessThanOrEqual(world.spots.length);
  });

  it("never lets two idle characters occupy the same spot", () => {
    const world = world2();
    const sim = createSim();
    const rng = mulberry32(12);
    const r = [roster(1, "quiet", true, 0), roster(2, "quiet", true, 1)];
    for (let i = 0; i < 1500; i++) {
      stepTownSim(sim, r, 16, world, rng);
      const a = sim.chars.get(1)!;
      const b = sim.chars.get(2)!;
      if (a.spotId !== null && b.spotId !== null) {
        expect(a.spotId).not.toBe(b.spotId);
      }
      // The occupancy map is a strict 1:1 (no spot claimed by two tasks).
      const taskIds = [...sim.occupied.values()];
      expect(new Set(taskIds).size).toBe(taskIds.length);
    }
  });

  it("makes a character give up its spot when its session resumes work", () => {
    const world = world2();
    const sim = createSim();
    const rng = mulberry32(13);
    // Wander until it has claimed a spot.
    let steps = 0;
    while (sim.chars.get(1)?.spotId == null && steps < 2000) {
      stepTownSim(sim, [roster(1, "quiet", true)], 16, world, rng);
      steps++;
    }
    expect(sim.chars.get(1)!.spotId).not.toBeNull();
    // Session goes active → it must release the spot and head home.
    stepTownSim(sim, [roster(1, "working", true)], 16, world, rng);
    expect(sim.chars.get(1)!.spotId).toBeNull();
    expect(sim.occupied.size).toBe(0);
  });

  it("never lets two characters physically stand on the same spot tile", () => {
    const world = world2(); // 2 spots
    const spotKeys = new Set(world.spots.map((s) => `${s.tile.x},${s.tile.y}`));
    const sim = createSim();
    const rng = mulberry32(1);
    const r = [
      roster(1, "quiet", true, 0),
      roster(2, "quiet", true, 0),
      roster(3, "quiet", true, 1),
      roster(4, "quiet", true, 1),
    ];
    for (let i = 0; i < 2000; i++) {
      stepTownSim(sim, r, 16, world, rng);
      const perTile = new Map<string, number>();
      for (const c of sim.chars.values()) {
        const key = `${Math.round(c.pos.x)},${Math.round(c.pos.y)}`;
        if (spotKeys.has(key)) perTile.set(key, (perTile.get(key) ?? 0) + 1);
      }
      for (const n of perTile.values()) expect(n).toBeLessThanOrEqual(1);
    }
  });

  it("snaps to the exact seat tile when work resumes mid-step (no off-tile rest)", () => {
    const world = world2();
    const seat = world.buildings[0].seats[0];
    const sim = createSim();
    // rng→0 makes it head to a spot immediately, so after one step it sits at a
    // fractional position, mid-tile.
    stepTownSim(sim, [roster(1, "quiet", true)], 16, world, () => 0);
    const midPos = sim.chars.get(1)!.pos;
    expect(Number.isInteger(midPos.x) && Number.isInteger(midPos.y)).toBe(false);
    // Work resumes → it must reach its exact seat tile, not rest a fraction off.
    for (let i = 0; i < 200; i++) {
      stepTownSim(sim, [roster(1, "working", true)], 16, world, () => 0);
    }
    const c = sim.chars.get(1)!;
    expect(c.pos).toEqual({ x: seat.x, y: seat.y });
  });
});

describe("stepTownSim — v3 sticky seats, overflow & plaza gathering", () => {
  it("keeps a seated worker on its desk when another session joins the project", () => {
    const world = world2(); // building 0 has 2 desks
    const sim = createSim();
    const rng = mulberry32(31);
    // Higher-id worker (5) settles first — under the old id-sorted assignment a
    // later lower-id joiner would steal seat 0 and shuffle 5 to seat 1.
    run(sim, [roster(5, "working", true, 0)], world, 120, rng);
    const held = sim.chars.get(5)!.seat;
    expect(held).not.toBeNull();
    // Lower-id worker (2) joins the same building.
    run(sim, [roster(5, "working", true, 0), roster(2, "working", true, 0)], world, 120, rng);
    // 5 keeps the exact seat it already held (sticky, no reshuffle).
    expect(sim.chars.get(5)!.seat).toEqual(held!);
    // 2 took the other desk — the two are not on the same seat.
    expect(sim.chars.get(2)!.seat).not.toEqual(held!);
  });

  it("spreads overflow past the desks so no two characters share a tile", () => {
    const world = world2(); // building 0 has only 2 desks
    const sim = createSim();
    const rng = mulberry32(32);
    const r = [1, 2, 3, 4].map((id) => roster(id, "working", true, 0));
    run(sim, r, world, 200, rng);
    const positions = [...sim.chars.values()].map((c) => `${Math.round(c.pos.x)},${Math.round(c.pos.y)}`);
    expect(new Set(positions).size).toBe(positions.length); // all distinct — no pile-up
    const seated = [...sim.chars.values()].filter((c) => c.seated);
    expect(seated).toHaveLength(2); // exactly the two desks are filled
  });

  it("gathers idle characters into the plaza rather than scattering", () => {
    const world = world2();
    const sim = createSim();
    const rng = mulberry32(33);
    const r = [1, 2, 3].map((id) => roster(id, "quiet", true, id % 2));
    run(sim, r, world, 1600, rng);
    const p = world.plaza;
    const inPlaza = [...sim.chars.values()].filter((c) => {
      const x = Math.round(c.pos.x);
      const y = Math.round(c.pos.y);
      return x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h;
    });
    expect(inPlaza.length).toBeGreaterThanOrEqual(2); // most have converged on the plaza
  });
});
