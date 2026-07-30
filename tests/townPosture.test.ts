import { describe, expect, it } from "bun:test";
import { createSim, stepTownSim, type RosterChar, type SimState } from "../src/town/sim";
import { buildWorld, isWalkable, spotPosture, type TownWorld } from "../src/town/world";
import type { TownModel, TownRoom } from "../src/selectors";
import type { PresenceState } from "../src/utils/presence";

// How a character is *holding itself*, and where it is drawn.
//
// The bug: the renderer had one animation for everything that was not walking —
// the walk cycle, at half speed, with a bob. So a worker heads-down at its desk
// for 25 minutes stepped in place the whole time, and so did a character asleep in
// bed. The town's busiest agent looked like it was marching on the spot at its own
// monitor, which is what the user reported.
//
// The fix is a fact about the character, not about the sprite: the sim says
// stand / sit / lie, because only the sim knows *why* a character is where it is —
// the same tile is somewhere to sit if you came for the bench and somewhere to
// stand if you came to fish off the bank. And because a sofa is blocked, the tile
// a resting character can stand on is the one beside it, so the sim also says
// which tile to *draw* it on. Without that, "went home to the sofa" rendered as a
// figure standing to attention next to one.

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

function room(name: string, openTaskCount = 12): TownRoom {
  return { projectId: 1, name, color: null, characters: [], openTaskCount };
}
function townOf(openTaskCount = 12): TownWorld {
  const model: TownModel = { rooms: [room("Alpha", openTaskCount), room("Beta", openTaskCount)] };
  return buildWorld(model);
}
function roster(taskId: number, state: PresenceState, live: boolean): RosterChar {
  return { taskId, agentName: "claude", state, live, buildingIndex: 0 };
}
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

describe("posture — a working agent is sitting, not walking", () => {
  it("sits a worker at its desk, and draws it on its own seat", () => {
    const world = townOf();
    const sim = createSim();
    settle(sim, [roster(1, "working", true)], world, mulberry32(3));
    const c = sim.chars.get(1)!;
    expect(c.seated).toBe(true);
    expect(c.posture).toBe("sit");
    expect(c.moving).toBe(false);
    // A desk seat is a walkable tile, so a seated worker needs no offset — it is
    // already standing (sitting) exactly where the chair is drawn.
    expect(c.onTile).toBeNull();
    expect(c.pos).toEqual({ x: c.seat!.x, y: c.seat!.y });
  });

  it("puts a worker back on its feet for the walk to the kettle and back", () => {
    const world = townOf();
    const sim = createSim();
    const r = [roster(1, "working", true)];
    settle(sim, r, world, mulberry32(11));
    const c = () => sim.chars.get(1)!;
    // Walk it forward to a trip: while it is *walking* it must be standing, and
    // while it is *at* the object it must be standing too (you make coffee on your
    // feet), so the only thing that ever sits at a desk is a worker at its desk.
    let sawWalking = false;
    let sawAtObject = false;
    for (let i = 0; i < 4000; i++) {
      stepTownSim(sim, r, 16, world, mulberry32(11 + (i % 13)), {});
      const ch = c();
      if (ch.moving) {
        expect(ch.posture).toBe("stand");
        sawWalking = true;
      }
      if (ch.chore && !ch.moving) {
        expect(ch.posture).toBe("stand");
        sawAtObject = true;
      }
      // Sitting is only ever on the seat.
      if (ch.posture === "sit") expect(ch.seated).toBe(true);
    }
    expect(sawWalking).toBe(true);
    expect(sawAtObject).toBe(true);
  });

  it("sits a quiet agent on the sofa itself, not on the floor beside it", () => {
    const world = townOf();
    const sim = createSim();
    settle(sim, [roster(1, "quiet", false)], world, mulberry32(7));
    const c = sim.chars.get(1)!;
    expect(c.restKind).toBe("sofa");
    expect(c.posture).toBe("sit");
    // Drawn on the sofa — which is a *different*, blocked tile next to the one it
    // is standing on. Both halves matter: the offset exists, and the thing it
    // points at is the furniture.
    expect(c.onTile).not.toBeNull();
    expect(c.onTile).toEqual(c.restObject!);
    expect(c.onTile).not.toEqual(c.restSpot!);
    expect(isWalkable(world, c.onTile!.x, c.onTile!.y)).toBe(false);
    const d = Math.abs(c.onTile!.x - c.restSpot!.x) + Math.abs(c.onTile!.y - c.restSpot!.y);
    expect(d).toBe(1);
  });

  it("lies a sleeping agent in the bed", () => {
    const world = townOf();
    const sim = createSim();
    settle(sim, [roster(1, "quiet", false)], world, mulberry32(7), { night: true });
    const c = sim.chars.get(1)!;
    expect(c.restKind).toBe("bed");
    expect(c.posture).toBe("lie");
    expect(c.activity).toBe("sleeping");
    expect(c.onTile).toEqual(c.restObject!);
  });

  it("keeps a blocked agent and a leaver on their feet", () => {
    const world = townOf();
    const sim = createSim();
    settle(sim, [roster(1, "blocked", true)], world, mulberry32(5));
    expect(sim.chars.get(1)!.posture).toBe("stand");

    // Dropped from the roster: walking off to the edge, never sitting down on the
    // way out.
    for (let i = 0; i < 60; i++) {
      stepTownSim(sim, [], 16, world, mulberry32(5));
      const c = sim.chars.get(1);
      if (!c) break;
      expect(c.posture).toBe("stand");
    }
  });

  it("holds the pose in the reduced-motion tableau", () => {
    const world = townOf();
    const sim = createSim();
    // Settled with motion, then the tableau: the still picture must still show a
    // worker seated and a sleeper in bed, not everyone standing at attention.
    settle(sim, [roster(1, "working", true)], world, mulberry32(3));
    stepTownSim(sim, [roster(1, "working", true)], 16, world, mulberry32(3), {
      reducedMotion: true,
    });
    const c = sim.chars.get(1)!;
    expect(c.posture).toBe("sit");
    expect(c.moving).toBe(false);
  });

  it("sits an idler on a bench and stands one at the pond", () => {
    // Posture out of doors comes from what the spot *is*, which is why the world
    // declares it: a visitor at the pond is on the bank with a rod, and one on a
    // bench is sat down. Everything reading as "resting" wherever it stopped was
    // the same flattening the activity glyphs already fixed.
    expect(spotPosture("bench")).toBe("sit");
    expect(spotPosture("chess")).toBe("sit");
    expect(spotPosture("picnic")).toBe("sit");
    expect(spotPosture("hammock")).toBe("lie");
    expect(spotPosture("pond")).toBe("stand");
    expect(spotPosture("gym")).toBe("stand");

    const world = townOf();
    const sim = createSim();
    const r = [1, 2, 3, 4].map((id) => ({ ...roster(id, "quiet", true), taskId: id }));
    // Quiet but live, by day → out at the commons, claiming spots.
    let checked = 0;
    for (let i = 0; i < 6000; i++) {
      stepTownSim(sim, r, 16, world, mulberry32(31 + (i % 11)), {});
      for (const c of sim.chars.values()) {
        if (c.spotId === null || c.moving || c.chatMs > 0) continue;
        const spot = world.spots.find((s) => s.id === c.spotId)!;
        // Only once it has actually arrived: it holds the claim on the way there.
        if (c.pos.x !== spot.tile.x || c.pos.y !== spot.tile.y) continue;
        expect({ kind: spot.kind, posture: c.posture }).toEqual({
          kind: spot.kind,
          posture: spotPosture(spot.kind),
        });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("more to do — the town's leisure vocabulary", () => {
  it("puts something other than water, fire and planting on the green", () => {
    // Every park used to be the same afternoon: five kinds rotating through five
    // slots is not variation, it is the same set every time.
    const world = buildWorld({
      rooms: Array.from({ length: 12 }, (_, i) => room(`P${i}`, 4)),
    });
    const kinds = new Set(world.spots.map((s) => s.kind));
    const added = ["hammock", "chess", "hoop", "picnic", "stage", "gym"].filter((k) =>
      kinds.has(k as never),
    );
    expect(added.length).toBeGreaterThanOrEqual(2);
    // …and the verbs reach the sim, which is the half that matters: a new prop
    // nobody can be doing anything at is scenery.
    const verbs = new Set(world.spots.map((s) => s.verb));
    expect(verbs.has("napping") || verbs.has("gaming") || verbs.has("exercising")).toBe(true);
  });

  it("gives even a park-less town somewhere to eat outside and somewhere to doze", () => {
    // A three-project town has no park at all — the new spots must not all live
    // in one, or the smallest towns keep the old, shorter afternoon.
    const world = buildWorld({ rooms: [room("A", 1), room("B", 4), room("C", 9)] });
    expect(world.parks).toHaveLength(0);
    const kinds = new Set(world.spots.map((s) => s.kind));
    expect(kinds.has("picnic")).toBe(true);
    expect(kinds.has("hammock")).toBe(true);
  });

  it("lets a house water its plants and raid its fridge", () => {
    // Both were already in every house and both were pure scenery. Promoting them
    // costs no art and no floor space, and it is two more things a character can
    // be doing between one desk stint and the next.
    const world = buildWorld({ rooms: [room("Alpha", 12), room("Beta", 12)] });
    const verbs = new Set(world.buildings.flatMap((b) => b.affordances.map((a) => a.verb)));
    expect(verbs.has("gardening")).toBe(true);
    expect(verbs.has("eating")).toBe(true);
  });

  it("does the new things, indoors, over an evening", () => {
    const world = buildWorld({ rooms: [room("Alpha", 12), room("Beta", 12)] });
    const sim = createSim();
    const r = [roster(1, "quiet", false)];
    const seen = new Set<string>();
    for (let i = 0; i < 9000; i++) {
      stepTownSim(sim, r, 16, world, mulberry32(13 + (i % 17)), {});
      seen.add(sim.chars.get(1)!.activity);
    }
    // Not any *specific* one — which verbs a given house affords depends on which
    // clutter that project got — but the evening must be more than the kitchen.
    const evening = ["watching", "music", "cooking", "eating", "reading", "coffee", "washing"];
    const widened = ["gaming", "exercising", "gardening"];
    expect(evening.filter((a) => seen.has(a)).length).toBeGreaterThanOrEqual(2);
    expect(widened.some((a) => seen.has(a))).toBe(true);
  });
});
