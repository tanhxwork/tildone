import { describe, expect, it } from "bun:test";
import {
  createSim,
  settleSim,
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
    run(sim, [roster(1, "working", true)], world, 400, mulberry32(2));
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
    run(sim, [roster(1, "quiet", true)], world, 500, rng);
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
    run(sim, [roster(1, "quiet", true)], world, 500, rng); // wander away first
    const away = sim.chars.get(1)!;
    expect({ x: Math.round(away.pos.x), y: Math.round(away.pos.y) }).not.toEqual(seat);
    run(sim, [roster(1, "working", true)], world, 900, rng); // now resume work
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
    run(sim, [roster(1, "quiet", true)], world, 500, rng); // get it wandering/moving
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
    run(sim, [roster(1, "working", true, 0), roster(2, "working", true, 0)], world, 400, rng);
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
    run(sim, [roster(1, "working", true)], world, 400, rng); // sit down
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
    run(sim, [roster(5, "working", true, 0)], world, 400, rng);
    const held = sim.chars.get(5)!.seat;
    expect(held).not.toBeNull();
    // Lower-id worker (2) joins the same building.
    run(sim, [roster(5, "working", true, 0), roster(2, "working", true, 0)], world, 400, rng);
    // 5 keeps the exact seat it already held (sticky, no reshuffle).
    expect(sim.chars.get(5)!.seat).toEqual(held!);
    // 2 took the other desk — the two are not on the same seat.
    expect(sim.chars.get(2)!.seat).not.toEqual(held!);
  });

  it("spreads overflow past the desks so no two characters share a tile", () => {
    const world = world2(); // building 0 has only 2 desks
    const sim = createSim();
    const rng = mulberry32(32);
    // Ids 3 and 6 both hit `id % frontage.length === 0` — the old overflow
    // aliasing stacked them both on the door tile. They must now be distinct.
    const r = [1, 2, 3, 6].map((id) => roster(id, "working", true, 0));
    run(sim, r, world, 500, rng);
    const positions = [...sim.chars.values()].map((c) => `${Math.round(c.pos.x)},${Math.round(c.pos.y)}`);
    expect(new Set(positions).size).toBe(positions.length); // all distinct — no pile-up
    const seated = [...sim.chars.values()].filter((c) => c.seated);
    expect(seated).toHaveLength(2); // exactly the two desks are filled
  });

  it("frees a desk for a waiting overflow worker when a seated session ends", () => {
    const world = world2(); // 2 desks
    const sim = createSim();
    const rng = mulberry32(34);
    run(sim, [1, 2, 3].map((id) => roster(id, "working", true, 0)), world, 500, rng);
    expect(sim.chars.get(3)!.seat).toBeNull(); // id 3 is the overflow
    // Id 1 leaves the roster → its desk frees; id 3 should claim it and sit
    // (id 1 itself is meanwhile walking off toward the edge).
    run(sim, [2, 3].map((id) => roster(id, "working", true, 0)), world, 300, rng);
    expect(sim.chars.get(3)!.seat).not.toBeNull();
    expect(sim.chars.get(3)!.seated).toBe(true);
  });

  it("settles an overflow worker off a blocked pacer's frontage tile", () => {
    // The overflow worker's rest tile must avoid the door + frontage where a
    // `blocked` worker paces, so at rest they never share a tile. (Transient
    // overlap while one is still walking in is inherent — the sim has no general
    // moving-collision avoidance — so this pins the settled state.)
    const world = world2(); // 2 desks
    const sim = createSim();
    const rng = mulberry32(36);
    const r = [
      roster(1, "working", true, 0),
      roster(2, "working", true, 0),
      roster(3, "working", true, 0),
      roster(4, "blocked", true, 0),
    ];
    for (let i = 0; i < 450; i++) {
      stepTownSim(sim, r, 16, world, rng);
      // Let everyone reach their settled position first. The window tracks how
      // deep the house is: the back seat is now behind the front seat off a
      // hall, so the last walker settles at step ~169 rather than ~150.
      if (i < 220) continue;
      const pos = [...sim.chars.values()].map((c) => `${Math.round(c.pos.x)},${Math.round(c.pos.y)}`);
      expect(new Set(pos).size).toBe(pos.length); // no pile-up once settled
    }
    // The overflow worker rests beyond the pacer's frontage, not on the door.
    const c3 = sim.chars.get(3)!;
    const frontageKeys = new Set([
      `${world.buildings[0].door.x},${world.buildings[0].door.y}`,
      `${world.buildings[0].door.x - 1},${world.buildings[0].door.y}`,
      `${world.buildings[0].door.x + 1},${world.buildings[0].door.y}`,
    ]);
    expect(frontageKeys.has(`${Math.round(c3.pos.x)},${Math.round(c3.pos.y)}`)).toBe(false);
  });

  it("keeps idle wanderers out of building interiors entirely", () => {
    const world = world2();
    const interior = new Set(
      world.buildings.flatMap((b) => b.seats.map((s) => `${s.x},${s.y}`)),
    );
    const sim = createSim();
    const rng = mulberry32(35);
    const r = [1, 2, 3].map((id) => roster(id, "quiet", true, id % 2));
    for (let i = 0; i < 1200; i++) {
      stepTownSim(sim, r, 16, world, rng);
      for (const c of sim.chars.values()) {
        expect(interior.has(`${Math.round(c.pos.x)},${Math.round(c.pos.y)}`)).toBe(false);
      }
    }
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

// Light social (spec v2c): idle characters who pass close stop, face each
// other and chat briefly. Cosmetic and bounded — the point is that the town
// looks inhabited, so the properties worth pinning are that it happens, that
// it ENDS, and that it never holds up real work.
describe("light social — chatting", () => {
  /** Run until the predicate holds, or give up after `n` steps. */
  function runUntil(
    sim: SimState,
    r: RosterChar[],
    world: TownWorld,
    n: number,
    rng: () => number,
    done: (s: SimState) => boolean,
  ): boolean {
    for (let i = 0; i < n; i++) {
      stepTownSim(sim, r, 16, world, rng);
      if (done(sim)) return true;
    }
    return false;
  }
  const chatting = (s: SimState) => [...s.chars.values()].filter((c) => c.chatMs > 0);

  it("pairs two idle characters that pass close, facing each other", () => {
    const world = world2();
    const sim = createSim();
    const r = [1, 2, 3, 4].map((id) => roster(id, "quiet", true, id % 2));
    const met = runUntil(sim, r, world, 4000, mulberry32(21), (s) => chatting(s).length >= 2);
    expect(met).toBe(true);

    const pair = chatting(sim);
    expect(pair.length % 2).toBe(0); // nobody chats alone
    for (const c of pair) {
      const other = sim.chars.get(c.chatWith!)!;
      expect(other).toBeDefined();
      expect(other.chatWith).toBe(c.taskId); // the link points both ways
      expect(c.moving).toBe(false); // they stopped
      expect(Math.hypot(other.pos.x - c.pos.x, other.pos.y - c.pos.y)).toBeLessThanOrEqual(1.6);
    }
  });

  it("ends the chat and lets them wander on", () => {
    const world = world2();
    const sim = createSim();
    const r = [1, 2, 3, 4].map((id) => roster(id, "quiet", true, id % 2));
    expect(runUntil(sim, r, world, 4000, mulberry32(22), (s) => chatting(s).length >= 2)).toBe(true);

    // A chat is bounded: well under 4s of sim time everyone is free again.
    const freed = runUntil(sim, r, world, 250, mulberry32(23), (s) => chatting(s).length === 0);
    expect(freed).toBe(true);
    for (const c of sim.chars.values()) expect(c.chatWith).toBeNull();
  });

  it("never chats while working — only idle characters stop", () => {
    const world = world2();
    const sim = createSim();
    // Two workers in the same building walk the same route to adjacent desks,
    // so they pass well within chat range.
    const r = [roster(1, "working", true, 0), roster(2, "working", true, 0)];
    run(sim, r, world, 2000, mulberry32(24));
    for (const c of sim.chars.values()) expect(c.chatMs).toBe(0);
  });

  it("drops the chat the moment a character is needed at its desk", () => {
    const world = world2();
    const sim = createSim();
    const idle = [1, 2, 3, 4].map((id) => roster(id, "quiet", true, id % 2));
    expect(runUntil(sim, idle, world, 4000, mulberry32(25), (s) => chatting(s).length >= 2)).toBe(
      true,
    );
    const talker = chatting(sim)[0].taskId;

    // That agent starts working: the intent change must end the chat rather
    // than leave it standing in the street for the rest of the bubble.
    const back = idle.map((r) =>
      r.taskId === talker ? roster(r.taskId, "working", true, r.buildingIndex) : r,
    );
    stepTownSim(sim, back, 16, world, mulberry32(26));
    expect(sim.chars.get(talker)!.chatMs).toBe(0);
    expect(sim.chars.get(talker)!.chatWith).toBeNull();
  });

  it("ends the chat when the other one despawns mid-sentence", () => {
    // Found by the Codex verify: the leavers pass deletes a character before
    // chats are stepped, so the survivor was left paused for the rest of the
    // bubble holding a chatWith pointing at nobody.
    const world = world2();
    const sim = createSim();
    const r = [1, 2, 3, 4].map((id) => roster(id, "quiet", true, id % 2));
    expect(runUntil(sim, r, world, 4000, mulberry32(31), (s) => chatting(s).length >= 2)).toBe(true);

    // a's ACTUAL partner, not just the next character that happens to be
    // chatting — with four idlers there can be two independent pairs.
    const a = chatting(sim)[0];
    const b = sim.chars.get(a.chatWith!)!;
    expect(b).toBeDefined();
    // Park the leaver on the walk-off edge so it despawns on the very next step.
    a.pos = { x: world.edge.x, y: world.edge.y };
    const without = r.filter((x) => x.taskId !== a.taskId);
    stepTownSim(sim, without, 16, world, mulberry32(32));

    expect(sim.chars.has(a.taskId)).toBe(false);
    const survivor = sim.chars.get(b.taskId)!;
    expect(survivor.chatMs).toBe(0);
    expect(survivor.chatWith).toBeNull();
  });

  it("still gets everyone home afterwards — a chat delays, it does not strand", () => {
    const world = world2();
    const sim = createSim();
    const idle = [1, 2].map((id) => roster(id, "quiet", true, 0));
    run(sim, idle, world, 2000, mulberry32(27));
    const working = [1, 2].map((id) => roster(id, "working", true, 0));
    run(sim, working, world, 2000, mulberry32(28));
    for (const c of sim.chars.values()) {
      expect(c.seated).toBe(true);
      expect(c.chatMs).toBe(0);
    }
  });
});

// What "becoming visible again" runs (spec: reconcile against the roster and
// snap everyone to a valid resting position, then resume). The bug it replaces
// was calling createSim(), which threw the population away and let the next
// step re-spawn everyone at their doors (TIL-190).
describe("settleSim", () => {
  it("keeps the population and its desk seats — nobody is re-spawned", () => {
    const world = world2();
    const sim = createSim();
    const r = [roster(1, "working", true), roster(2, "working", true, 1)];
    run(sim, r, world, 400, mulberry32(7));
    const seatsBefore = new Map([...sim.chars].map(([id, c]) => [id, c.seat]));

    settleSim(sim, world);

    expect([...sim.chars.keys()].sort()).toEqual([1, 2]);
    for (const [id, c] of sim.chars) expect(c.seat).toEqual(seatsBefore.get(id)!);
  });

  it("snaps a worker to its desk, not back to the door", () => {
    const world = world2();
    const sim = createSim();
    const r = [roster(1, "working", true)];
    run(sim, r, world, 400, mulberry32(8));

    settleSim(sim, world);

    const c = sim.chars.get(1)!;
    expect({ x: Math.round(c.pos.x), y: Math.round(c.pos.y) }).toEqual(world.buildings[0].seats[0]);
    expect({ x: Math.round(c.pos.x), y: Math.round(c.pos.y) }).not.toEqual(world.buildings[0].door);
    expect(c.moving).toBe(false);
    expect(c.path).toEqual([]);
    expect(c.seated).toBe(true);
  });

  it("stops mid-walk motion and releases every leisure claim", () => {
    const world = world2();
    const sim = createSim();
    const r = [1, 2, 3].map((id) => roster(id, "quiet", true, id % 2));
    run(sim, r, world, 1600, mulberry32(9));

    settleSim(sim, world);

    expect(sim.occupied.size).toBe(0);
    for (const c of sim.chars.values()) {
      expect(c.moving).toBe(false);
      expect(c.path).toEqual([]);
      expect(c.spotId).toBeNull();
      expect(c.dwellMs).toBe(0);
    }
  });

  it("resumes cleanly — the next step keeps everyone it settled", () => {
    const world = world2();
    const sim = createSim();
    const r = [roster(1, "working", true), roster(2, "quiet", true, 1)];
    run(sim, r, world, 400, mulberry32(10));

    settleSim(sim, world);
    stepTownSim(sim, r, 16, world, mulberry32(11));

    expect([...sim.chars.keys()].sort()).toEqual([1, 2]);
    // The worker is still at its desk one step later — a re-spawn would have
    // put it back on the door tile.
    const c = sim.chars.get(1)!;
    expect({ x: Math.round(c.pos.x), y: Math.round(c.pos.y) }).not.toEqual(world.buildings[0].door);
  });
});
