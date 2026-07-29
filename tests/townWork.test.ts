import { describe, expect, it } from "bun:test";
import {
  classifyLog,
  createSim,
  stepTownSim,
  type RosterChar,
  type SimState,
} from "../src/town/sim";
import { buildWorld, inRect, type TownWorld } from "../src/town/world";
import type { TownModel, TownRoom } from "../src/selectors";
import type { PresenceState } from "../src/utils/presence";

// What a character is *doing*, as opposed to where it is.
//
// The bug these exist for: `working` and `quiet & not live` used to resolve to
// the same intent, the same desk seat and the same animation, so an agent
// grinding for 25 minutes and one whose session died an hour ago were the same
// picture. presence.ts refuses to report "working" without a heartbeat precisely
// because guessing from a fresh timestamp was the old bug — and the town then
// threw the distinction away at the last step. There was no test for the
// quiet-not-live case at all, which is how it survived.

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

function roster(
  taskId: number,
  state: PresenceState,
  live: boolean,
  extra: Partial<RosterChar> = {},
): RosterChar {
  return { taskId, agentName: "claude", state, live, buildingIndex: 0, ...extra };
}

/** Run until everyone has settled (long enough to cross a whole house). */
function settle(
  sim: SimState,
  r: RosterChar[],
  world: TownWorld,
  rng: () => number,
  opts: { night?: boolean } = {},
  steps = 400,
) {
  for (let i = 0; i < steps; i++) stepTownSim(sim, r, 16, world, rng, opts);
}

const at = (sim: SimState, id: number) => {
  const c = sim.chars.get(id)!;
  return { x: Math.round(c.pos.x), y: Math.round(c.pos.y) };
};

describe("a dead session visibly stops", () => {
  it("puts a working agent at its desk and a quiet-not-live one on the sofa", () => {
    const world = townOf();
    const b = world.buildings[0];
    const sim = createSim();
    settle(sim, [roster(1, "working", true), roster(2, "quiet", false)], world, mulberry32(7));

    const worker = sim.chars.get(1)!;
    expect(worker.intent).toBe("work");
    expect(worker.seated).toBe(true);
    expect(at(sim, 1)).toEqual(worker.seat!);

    const dead = sim.chars.get(2)!;
    expect(dead.intent).toBe("rest");
    expect(dead.seat).toBeNull();
    expect(dead.restKind).toBe("sofa");
    expect(at(sim, 2)).toEqual(dead.restSpot!);
    // The lounge, not the workroom — the whole point is that they differ.
    const lounge = b.rooms.find((r) => r.kind === "lounge")!;
    expect(inRect(lounge.rect, dead.restSpot!)).toBe(true);
    expect(at(sim, 1)).not.toEqual(at(sim, 2));
  });

  it("never seats two quiet agents on the same sofa", () => {
    const world = townOf();
    const sim = createSim();
    const ids = [1, 2, 3];
    settle(
      sim,
      ids.map((id) => roster(id, "quiet", false)),
      world,
      mulberry32(11),
    );
    const spots = ids
      .map((id) => sim.chars.get(id)!.restSpot)
      .filter(Boolean)
      .map((t) => `${t!.x},${t!.y}`);
    expect(new Set(spots).size).toBe(spots.length);
    const settled = ids.map((id) => `${at(sim, id).x},${at(sim, id).y}`);
    expect(new Set(settled).size).toBe(settled.length);
  });

  it("sends a quiet agent back to work when its session comes back", () => {
    const world = townOf();
    const sim = createSim();
    const rng = mulberry32(13);
    settle(sim, [roster(1, "quiet", false)], world, rng);
    expect(sim.chars.get(1)!.restKind).toBe("sofa");
    settle(sim, [roster(1, "working", true)], world, rng);
    const c = sim.chars.get(1)!;
    expect(c.intent).toBe("work");
    expect(c.seated).toBe(true);
    expect(c.restSpot).toBeNull();
  });
});

describe("the clock moves quiet agents; the session moves working ones", () => {
  it("sends a quiet-but-live agent home to bed at night instead of the plaza", () => {
    const world = townOf();
    const b = world.buildings[0];
    const sim = createSim();
    const rng = mulberry32(17);
    settle(sim, [roster(1, "quiet", true)], world, rng, { night: true });
    const c = sim.chars.get(1)!;
    expect(c.intent).toBe("rest");
    expect(c.restKind).toBe("bed");
    const bedroom = b.rooms.find((r) => r.kind === "bedroom")!;
    expect(inRect(bedroom.rect, c.restSpot!)).toBe(true);
    expect(c.activity).toBe("sleeping");
  });

  it("leaves a working agent at its desk at 3am", () => {
    const world = townOf();
    const sim = createSim();
    settle(sim, [roster(1, "working", true)], world, mulberry32(19), { night: true });
    const c = sim.chars.get(1)!;
    expect(c.intent).toBe("work");
    expect(c.seated).toBe(true);
    expect(at(sim, 1)).toEqual(c.seat!);
  });

  it("moves a sleeping agent to the sofa when morning comes", () => {
    const world = townOf();
    const sim = createSim();
    const rng = mulberry32(23);
    settle(sim, [roster(1, "quiet", false)], world, rng, { night: true });
    expect(sim.chars.get(1)!.restKind).toBe("bed");
    settle(sim, [roster(1, "quiet", false)], world, rng, { night: false });
    expect(sim.chars.get(1)!.restKind).toBe("sofa");
  });

  it("still sends a quiet-but-live agent out to the plaza by day", () => {
    const world = townOf();
    const sim = createSim();
    settle(sim, [roster(1, "quiet", true)], world, mulberry32(29), { night: false });
    expect(sim.chars.get(1)!.intent).toBe("wander");
  });
});

describe("working is a routine, not a pose", () => {
  it("takes a trip to a named object and comes back to the desk", () => {
    const world = townOf(12); // large house — plenty to go and do
    const sim = createSim();
    const rng = mulberry32(31);
    const r = [roster(1, "working", true)];
    settle(sim, r, world, rng);
    const c = sim.chars.get(1)!;
    expect(c.seated).toBe(true);

    // Long enough to cross the trip interval. Trips are deliberately rare —
    // heads-down work is meant to be mostly heads-down.
    const verbs = new Set<string>();
    let leftTheDesk = false;
    for (let i = 0; i < 4000; i++) {
      stepTownSim(sim, r, 100, world, rng);
      if (c.chore) {
        verbs.add(c.chore.verb);
        leftTheDesk = true;
      }
      if (leftTheDesk && !c.chore && c.seated) break;
    }
    expect(leftTheDesk).toBe(true);
    // Whatever it went to do, it was not "sit at a desk" — that is where it was.
    expect([...verbs].every((v) => v !== "working")).toBe(true);
    expect(c.seated).toBe(true); // and it went back
    expect(at(sim, 1)).toEqual(c.seat!);
  });

  it("never sends two workers to the same kettle", () => {
    const world = townOf(12);
    const sim = createSim();
    const rng = mulberry32(37);
    const r = [1, 2, 3, 4].map((id) => roster(id, "working", true));
    for (let i = 0; i < 4000; i++) {
      stepTownSim(sim, r, 100, world, rng);
      const targets = [...sim.chars.values()]
        .filter((c) => c.chore)
        .map((c) => `${c.chore!.tile.x},${c.chore!.tile.y}`);
      expect(new Set(targets).size).toBe(targets.length);
    }
  });
});

describe("classifyLog — spending the log line the town already carries", () => {
  it.each([
    ["running the test suite", "testing"],
    ["cargo build finished", "building"],
    ["reading src/town/world.ts", "reading"],
    ["implementing the room grammar", "writing"],
    ["waiting on the review", "waiting"],
  ])("reads %p as %p", (line, expected) => {
    expect(classifyLog(line)).toBe(expected);
  });

  it("says nothing when the line says nothing", () => {
    expect(classifyLog(null)).toBeNull();
    expect(classifyLog("")).toBeNull();
    expect(classifyLog("hmm")).toBeNull();
  });

  it("shows a seated worker's own log line as its activity", () => {
    const world = townOf();
    const sim = createSim();
    settle(
      sim,
      [roster(1, "working", true, { lastLog: "running the test suite" })],
      world,
      mulberry32(41),
    );
    expect(sim.chars.get(1)!.activity).toBe("testing");
  });

  it("falls back to typing when the agent has said nothing", () => {
    const world = townOf();
    const sim = createSim();
    settle(sim, [roster(1, "working", true)], world, mulberry32(43));
    expect(sim.chars.get(1)!.activity).toBe("typing");
  });

  it("shows a blocked agent as stuck, whatever its log says", () => {
    const world = townOf();
    const sim = createSim();
    settle(
      sim,
      [roster(1, "blocked", true, { lastLog: "running the test suite" })],
      world,
      mulberry32(47),
    );
    expect(sim.chars.get(1)!.activity).toBe("stuck");
  });
});
