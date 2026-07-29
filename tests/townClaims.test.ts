import { describe, expect, it } from "bun:test";
import {
  createSim,
  settleSim,
  stepTownSim,
  type CharAgent,
  type RosterChar,
  type SimState,
} from "../src/town/sim";
import { buildWorld, type TownWorld } from "../src/town/world";
import type { TownModel, TownRoom } from "../src/selectors";
import type { PresenceState } from "../src/utils/presence";

// The four defects the Codex verify of 67114c2 found in the indoor-claim
// bookkeeping. Every one of them is a way for two characters to end up in the
// same place, or for a place to become permanently unusable — the class of bug
// `pruneUnclaimableSpots` and the sticky-seat rules already guard outdoors and
// at the desks, reappearing at the affordances and rest spots the same commit
// introduced.
//
// They are pinned here rather than folded into townWork.test.ts because they
// are about the *bookkeeping*, not the behaviour: each one passes a plausible
// behavioural test and still leaves the town wrong.

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
function townOf(openTaskCount = 1): TownWorld {
  const model: TownModel = { rooms: [room("A", openTaskCount), room("B")] };
  return buildWorld(model);
}
function roster(taskId: number, state: PresenceState, live: boolean): RosterChar {
  return { taskId, agentName: "claude", state, live, buildingIndex: 0 };
}

/** Step until `done` says so, or give up after `limit` steps. */
function runUntil(
  sim: SimState,
  r: RosterChar[],
  world: TownWorld,
  rng: () => number,
  done: () => boolean,
  opts: { night?: boolean } = {},
  limit = 6000,
): boolean {
  for (let i = 0; i < limit; i++) {
    stepTownSim(sim, r, 100, world, rng, opts);
    if (done()) return true;
  }
  return false;
}

const posKey = (c: CharAgent) => `${Math.round(c.pos.x)},${Math.round(c.pos.y)}`;

describe("indoor claims are exactly what characters are holding", () => {
  it("gives the kettle back when the sim is settled mid-trip", () => {
    // Becoming visible again settles everyone in place. It cleared the trip but
    // not the trip's claim, so the object stayed reserved by a character that
    // was no longer going to it — and, because that character still existed, no
    // sweep ever collected it. The affordance was gone for the rest of the run.
    const world = townOf(12);
    const sim = createSim();
    const rng = mulberry32(3);
    const c = () => sim.chars.get(1)!;
    const started = runUntil(sim, [roster(1, "working", true)], world, rng, () => !!c().chore);
    expect(started).toBe(true);

    settleSim(sim, world);
    expect(c().chore).toBeNull();
    expect([...sim.claims.keys()]).toEqual([]);
  });

  it("holds no claim that no character is actually holding", () => {
    const world = townOf(12);
    const sim = createSim();
    const rng = mulberry32(5);
    const r = [1, 2, 3].map((id) => roster(id, id === 3 ? "quiet" : "working", true));
    for (let i = 0; i < 3000; i++) {
      stepTownSim(sim, r, 100, world, rng, { night: i % 700 > 350 });
      const held = new Set<string>();
      for (const ch of sim.chars.values()) {
        if (ch.chore) held.add(`${ch.chore.tile.x},${ch.chore.tile.y}`);
        if (ch.restSpot) held.add(`${ch.restSpot.x},${ch.restSpot.y}`);
      }
      expect([...sim.claims.keys()].sort()).toEqual([...held].sort());
    }
  });
});

describe("nobody keeps walking to a place it has given up", () => {
  it("drops the route to the sofa when night moves it to the bed", () => {
    // The rest claim is on a *kind* — sofa by day, bed by night — so nightfall
    // reassigns it. The path was left alone, so the character finished walking
    // to the sofa it no longer held (where another quiet agent could by then be
    // sitting) before turning round for the bed.
    const world = townOf();
    const sim = createSim();
    const rng = mulberry32(7);
    const r = [roster(1, "quiet", false)];
    const c = () => sim.chars.get(1)!;

    // Catch it while it is still walking to the sofa.
    const walking = runUntil(
      sim,
      r,
      world,
      rng,
      () => c().restKind === "sofa" && c().path.length > 0,
      {},
      400,
    );
    expect(walking).toBe(true);
    const sofa = { ...c().restSpot! };

    stepTownSim(sim, r, 100, world, rng, { night: true });
    expect(c().restKind).toBe("bed");
    const end = c().path[c().path.length - 1];
    if (end) expect(end).not.toEqual(sofa);
  });
});

describe("overflow tiles are shared out, not handed out twice", () => {
  it("never parks a waiting worker and a waiting sleeper on the same tile", () => {
    // Work overflow and rest overflow each asked for "the nearest free tiles to
    // the door" without telling the other, so both got the same answer and the
    // two characters settled on top of each other.
    const world = townOf(); // 2 desks, so 3 workers means one overflows
    const sim = createSim();
    const rng = mulberry32(11);
    const r = [
      roster(1, "working", true),
      roster(2, "working", true),
      roster(3, "working", true),
      roster(4, "quiet", false),
      roster(5, "quiet", false),
      roster(6, "quiet", false),
    ];
    for (let i = 0; i < 900; i++) {
      stepTownSim(sim, r, 16, world, rng);
      const tiles = [...sim.chars.values()]
        .map((c) => c.restTile)
        .filter(Boolean)
        .map((t) => `${t!.x},${t!.y}`);
      expect(new Set(tiles).size).toBe(tiles.length);
      if (i > 500) {
        const settled = [...sim.chars.values()].map(posKey);
        expect(new Set(settled).size).toBe(settled.length);
      }
    }
  });
});

describe("the fix's own defects, found by re-verifying it", () => {
  it("gives the kettle back when reduced motion snaps everyone home", () => {
    // The ledger is reconciled once per step, before the reduced-motion branch —
    // which then cancels every trip and returns without reconciling again. One
    // frame of a claim nobody holds, at the API boundary, which is exactly the
    // invariant the first fix said it had made unrepresentable.
    const world = townOf(12);
    const sim = createSim();
    const rng = mulberry32(3);
    const r = [roster(1, "working", true)];
    const c = () => sim.chars.get(1)!;
    expect(runUntil(sim, r, world, rng, () => !!c().chore)).toBe(true);

    stepTownSim(sim, r, 100, world, rng, { reducedMotion: true });
    expect(c().chore).toBeNull();
    expect([...sim.claims.keys()]).toEqual([]);
  });

  it("drops the route to a waiting tile it has been moved off", () => {
    // Overflow tiles are handed out from one pool in task-id order, so a quiet
    // character joining later can take the tile a worker was already walking to
    // and push that worker elsewhere. Reassigning `restTile` without clearing
    // the path left the worker still heading for a tile now promised to someone
    // else — the same stale-route defect as the sofa, one layer down.
    const world = townOf();
    const sim = createSim();
    const rng = mulberry32(17);
    const workers = [100, 101, 102].map((id) => roster(id, "working", true));
    stepTownSim(sim, workers, 16, world, rng);
    const late = sim.chars.get(102)!;
    expect(late.restTile).not.toBeNull();

    stepTownSim(sim, [...workers, roster(1, "quiet", false), roster(2, "quiet", false)], 16, world, rng);
    for (const ch of sim.chars.values()) {
      const end = ch.path[ch.path.length - 1];
      if (!end || !ch.restTile) continue;
      // Whatever it is walking to, it must be the tile it currently holds.
      expect(end).toEqual(ch.restTile);
    }
  });

  it("does not re-plan an overflow rester's route every single frame", () => {
    // A resting character with no free sofa has `restSpot === null`, which the
    // "did my rest kind change?" check reads as "it changed" — so it cleared the
    // path and re-ran A* on every frame of the walk. It still arrived, so no
    // behavioural test caught it; the cost was a pathfind per character per
    // frame. Path identity is the direct expression of the defect: an untouched
    // walk keeps the same array.
    const world = townOf();
    const sim = createSim();
    const rng = mulberry32(19);
    const r = [1, 2, 3, 4].map((id) => roster(id, "quiet", false));
    let overflow: CharAgent | undefined;
    for (let i = 0; i < 60 && !overflow; i++) {
      stepTownSim(sim, r, 16, world, rng);
      overflow = [...sim.chars.values()].find((c) => c.restSpot === null && c.path.length > 1);
    }
    expect(overflow).toBeDefined();
    const before = overflow!.path;
    stepTownSim(sim, r, 16, world, rng);
    expect(overflow!.path).toBe(before); // same array — not cleared and rebuilt
  });

  it("spreads waiting characters evenly when there are more of them than tiles", () => {
    // The world is finite, so past some population two characters must share a
    // waiting tile — that part is physical, not a bug. Piling every extra onto
    // the *last* tile is the bug: it turns an unavoidable pair into a heap.
    // One building means the smallest world the town ever builds (two cells),
    // which is what makes the tiles run out at a testable population — with a
    // second building the search finds distinct tiles for 700 characters.
    const world = buildWorld({ rooms: [room("Inbox", 12)] });
    const sim = createSim();
    const rng = mulberry32(23);
    const r = Array.from({ length: 500 }, (_, i) => roster(i + 1, "working", true));
    stepTownSim(sim, r, 16, world, rng);
    const counts = new Map<string, number>();
    for (const c of sim.chars.values()) {
      if (!c.restTile) continue;
      const k = `${c.restTile.x},${c.restTile.y}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const n = [...counts.values()];
    // The tiles genuinely ran out — otherwise this asserts nothing.
    expect(Math.max(...n)).toBeGreaterThanOrEqual(2);
    expect(counts.size).toBeGreaterThan(1);
    expect(Math.max(...n) - Math.min(...n)).toBeLessThanOrEqual(1);
  });
});

describe("nobody outruns the walk speed, however its route is replanned", () => {
  // The integrator advanced `budget` tiles on BOTH axes at once whenever the
  // deltas to the next waypoint were both nonzero — twice the intended speed,
  // diagonally, with visible jitter. Its comment said "axis-aligned segments",
  // and that held only while a path was never replanned mid-tile: replanning
  // starts from `round(pos)`, so a character caught between tiles is off the
  // lane of its own first waypoint.
  //
  // Latent since long before the rest spots — an intent flip has always been
  // able to clear a path mid-tile — but reassigning waiting tiles made it
  // reachable in ordinary play. So this pins the speed limit itself rather than
  // the one route that exposed it.
  const SPEED = 2.4; // tiles/sec, from sim.ts
  const manhattan = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

  it("holds the speed limit through a churning roster", () => {
    const world = townOf();
    const sim = createSim();
    const rng = mulberry32(29);
    const dt = 16;
    const limit = (SPEED * dt) / 1000 + 1e-9;
    // Churn the roster hard: characters arriving, flipping state and leaving is
    // what clears paths mid-tile.
    for (let i = 0; i < 1200; i++) {
      const r: RosterChar[] = [];
      for (let id = 100; id < 106; id++) {
        if ((i + id) % 97 < 60) continue; // comes and goes
        const s: PresenceState = (i + id) % 3 === 0 ? "working" : (i + id) % 3 === 1 ? "quiet" : "blocked";
        r.push({ ...roster(id, s, (i + id) % 5 !== 0) });
      }
      for (let id = 1; id < 4; id++) r.push(roster(id, "quiet", false));
      const before = new Map([...sim.chars].map(([id, c]) => [id, { ...c.pos }]));
      stepTownSim(sim, r, dt, world, rng, { night: i % 300 > 150 });
      for (const [id, c] of sim.chars) {
        const was = before.get(id);
        if (!was) continue; // spawned this step
        expect({ id, moved: manhattan(was, c.pos) <= limit }).toEqual({ id, moved: true });
      }
    }
  });

  it("never leaves a character off both axes of its own next waypoint", () => {
    // The other half of the same invariant: mid-step a character may be between
    // tiles on ONE axis. Being off on both is what produced the diagonal.
    const world = townOf();
    const sim = createSim();
    const rng = mulberry32(31);
    const workers = [100, 101, 102].map((id) => roster(id, "working", true));
    stepTownSim(sim, workers, 16, world, rng);
    const churned = [...workers, roster(1, "quiet", false), roster(2, "quiet", false)];
    for (let i = 0; i < 400; i++) {
      stepTownSim(sim, churned, 16, world, rng);
      for (const c of sim.chars.values()) {
        const next = c.path[0];
        if (!next) continue;
        const offX = next.x !== c.pos.x;
        const offY = next.y !== c.pos.y;
        expect({ id: c.taskId, diagonal: offX && offY }).toEqual({
          id: c.taskId,
          diagonal: false,
        });
      }
    }
  });
});

describe("a working agent never looks asleep", () => {
  it("takes trips to the kettle, not to bed", () => {
    // The trip picker admitted every affordance whose verb was not "working",
    // which includes the sofa and the bed. A live agent grinding away would get
    // up, walk to bed and render as `sleeping` — precisely the picture this
    // whole change exists to stop a *working* agent from showing.
    const world = townOf(12);
    const sim = createSim();
    const rng = mulberry32(13);
    const r = [roster(1, "working", true)];
    const c = () => sim.chars.get(1)!;
    const seen = new Set<string>();
    for (let i = 0; i < 12000; i++) {
      stepTownSim(sim, r, 100, world, rng, { night: i % 400 > 200 });
      if (c().chore) seen.add(c().chore!.verb);
      expect(["resting", "sleeping"]).not.toContain(c().activity);
    }
    expect(seen.size).toBeGreaterThan(0); // it did go and do things
    for (const v of seen) expect(["resting", "sleeping"]).not.toContain(v);
  });
});
