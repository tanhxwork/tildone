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
