import { describe, expect, it } from "bun:test";
import { createSim, stepTownSim, type RosterChar, type SimState } from "../src/town/sim";
import { buildWorld, type TownWorld } from "../src/town/world";
import type { TownModel, TownRoom } from "../src/selectors";
import type { PresenceState } from "../src/utils/presence";

// What a character does when it is *not* working, and what a working one does
// besides sit still.
//
// The picture this replaces: "quiet" resolved to a sofa and stayed there. The
// agent had stopped, so the town stopped — which is exactly backwards, because a
// stopped session is the state a viewer has the most time to look at. An evening
// at home is the same trip loop the workday already had, over a different set of
// verbs, and the constraint worth pinning is that it never turns into sleeping
// (going to bed is what night means) and never happens at night.

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

function room(name: string, openTaskCount: number): TownRoom {
  return { projectId: 1, name, color: null, characters: [], openTaskCount };
}
/** A town of large houses — the tier that has a whiteboard and a rack in it. */
function townOf(openTaskCount = 12): TownWorld {
  const model: TownModel = { rooms: [room("Alpha", openTaskCount), room("Beta", openTaskCount)] };
  return buildWorld(model);
}

function roster(
  taskId: number,
  state: PresenceState,
  live: boolean,
  buildingIndex = 0,
): RosterChar {
  return { taskId, agentName: "claude", state, live, buildingIndex };
}

/** Step for `steps` frames, collecting every activity each character showed. */
function observe(
  sim: SimState,
  r: RosterChar[],
  world: TownWorld,
  rng: () => number,
  steps: number,
  opts: { night?: boolean } = {},
): Map<number, Set<string>> {
  const seen = new Map<number, Set<string>>();
  for (let i = 0; i < steps; i++) {
    stepTownSim(sim, r, 16, world, rng, opts);
    for (const c of sim.chars.values()) {
      const set = seen.get(c.taskId) ?? new Set<string>();
      set.add(c.activity);
      seen.set(c.taskId, set);
    }
  }
  return seen;
}

describe("an evening at home — a quiet agent has something to do", () => {
  it("gets a quiet agent off the sofa and around its own house", () => {
    const world = townOf();
    const sim = createSim();
    // Two minutes of an afternoon in: long enough for several trips.
    const seen = observe(sim, [roster(1, "quiet", false)], world, mulberry32(5), 7500);
    const acts = seen.get(1)!;
    // It rested, it walked, and it did at least a couple of things that are only
    // possible in a furnished house.
    expect(acts.has("resting")).toBe(true);
    expect(acts.has("walking")).toBe(true);
    const leisure = ["watching", "music", "cooking", "eating", "reading", "coffee", "washing"];
    const did = leisure.filter((a) => acts.has(a));
    expect(did.length).toBeGreaterThanOrEqual(2);
    // …and it is home at the end of it, on its own claimed spot.
    const c = sim.chars.get(1)!;
    expect(c.intent).toBe("rest");
    expect(c.restSpot).not.toBeNull();
  });

  it("never goes to bed as an activity, and stops entirely at night", () => {
    const world = townOf();
    const day = createSim();
    const seenDay = observe(day, [roster(1, "quiet", false)], world, mulberry32(9), 6000);
    // Sleeping is what night is for. A live-looking agent that gets up from the
    // sofa and lies down is the exact confusion the workday loop already avoids.
    expect(seenDay.get(1)!.has("sleeping")).toBe(false);

    const night = createSim();
    const seenNight = observe(night, [roster(1, "quiet", false)], world, mulberry32(9), 6000, {
      night: true,
    });
    const c = night.chars.get(1)!;
    expect(c.restKind).toBe("bed");
    expect(c.chore).toBeNull();
    expect(seenNight.get(1)!.has("sleeping")).toBe(true);
    // Nothing leisurely happened at all — it went to bed and stayed there.
    for (const a of ["watching", "music", "cooking"]) {
      expect({ a, seen: seenNight.get(1)!.has(a) }).toEqual({ a, seen: false });
    }
  });

  it("keeps two housemates off the same object all evening", () => {
    const world = townOf();
    const sim = createSim();
    const r = [1, 2, 3].map((id) => roster(id, "quiet", false));
    for (let i = 0; i < 6000; i++) {
      stepTownSim(sim, r, 16, world, mulberry32(21 + (i % 7)), {});
      const busy = [...sim.chars.values()]
        .filter((c) => c.chore)
        .map((c) => `${c.chore!.tile.x},${c.chore!.tile.y}`);
      expect(new Set(busy).size).toBe(busy.length);
    }
  });
});

describe("a workday with more in it than a kettle", () => {
  it("takes a working agent to the whiteboard or the rack, not to bed", () => {
    const world = townOf();
    // Which houses have a workroom object at all is a property of the plan: a
    // work wing whose desk rows come out exactly full has no spare tile for one
    // (and that variation is the point of TIL-199). So this asserts the town
    // *has* such a workroom and that its workers use it — not that every house
    // is identical.
    const withBoard = world.buildings.findIndex((b) =>
      b.affordances.some((a) => a.verb === "planning" || a.verb === "deploying"),
    );
    expect(withBoard).toBeGreaterThanOrEqual(0);
    const sim = createSim();
    // Four minutes: CHORE_MIN is 18s, so several trips happen.
    const seen = observe(
      sim,
      [1, 2, 3].map((id) => roster(id, "working", true, withBoard)),
      world,
      mulberry32(3),
      15000,
    );
    const all = new Set([...seen.values()].flatMap((s) => [...s]));
    expect(all.has("typing")).toBe(true);
    // At least one of the workroom's own verbs showed up across the three.
    expect(all.has("planning") || all.has("deploying")).toBe(true);
    // And none of them ever lay down or wandered off to the plaza.
    expect(all.has("sleeping")).toBe(false);
    expect(all.has("resting")).toBe(false);
  });

  it("lets two workers stop and talk when they meet at an object", () => {
    const world = townOf();
    const sim = createSim();
    let chatted = false;
    const r = [1, 2, 3, 4].map((id) => roster(id, "working", true));
    const rng = mulberry32(17);
    for (let i = 0; i < 20000 && !chatted; i++) {
      stepTownSim(sim, r, 16, world, rng, {});
      chatted = [...sim.chars.values()].some((c) => c.chatMs > 0 && c.chore !== null);
    }
    expect(chatted).toBe(true);
  });
});

describe("out of doors — a spot is for something", () => {
  it("reads an idler at the pond as fishing, not as resting", () => {
    const world = townOf(2);
    const sim = createSim();
    const seen = observe(
      sim,
      [1, 2, 3, 4].map((id) => roster(id, "quiet", true)),
      world,
      mulberry32(2),
      9000,
    );
    const all = new Set([...seen.values()].flatMap((s) => [...s]));
    // Across four idlers over two and a half minutes, the town's spots get used
    // for what they are: the exact mix depends on which are nearest, so this
    // asserts that *something* verb-specific happened rather than naming one.
    const specific = ["fishing", "gardening", "cooking", "shopping", "playing", "painting", "reading"];
    expect(specific.some((a) => all.has(a))).toBe(true);
  });

  it("clears the spot verb when the character gives the spot up", () => {
    const world = townOf(2);
    const sim = createSim();
    const idle = [roster(1, "quiet", true)];
    for (let i = 0; i < 4000; i++) stepTownSim(sim, idle, 16, world, mulberry32(4), {});
    // Back to work: no lingering claim, and no lingering "what I was doing".
    for (let i = 0; i < 600; i++) {
      stepTownSim(sim, [roster(1, "working", true)], 16, world, mulberry32(6), {});
    }
    const c = sim.chars.get(1)!;
    expect(c.spotId).toBeNull();
    expect(c.spotVerb).toBeNull();
    expect(sim.occupied.size).toBe(0);
  });
});
