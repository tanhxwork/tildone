// The town simulation — the per-frame stateful layer the living overworld runs.
//
// townModel (selectors.ts) stays the *pure roster*: who exists + their presence
// state. This reducer owns the *physical* world: where each character is, where
// it's walking, and what it's doing. It is a pure fixed-timestep function —
// `stepTownSim(sim, roster, dtMs, world, rng, opts) → sim` — so it unit-tests
// exactly like townModel (deterministic: seeded rng, injected dt). The Pixi
// ticker calls it each frame; a store reload only feeds it a fresh roster.
//
// Behaviour spine (a re-reading of presence — no new agent data):
//   working                 → walks inside and sits at its own desk (heads-down)
//   quiet & live (idle)     → walks out and gathers at the central plaza
//   quiet & not live (rest) → sits at its desk (no live heartbeat to wander)
//   blocked                 → paces just outside its own building
//   roster drops it (ended) → walks off to the world edge and despawns
//
// "Sits at its own desk": each building has a row of interior seat tiles (one
// per workstation). A working/resting character claims a seat *stickily* — it
// keeps the seat it holds, so a later joiner never reshuffles a seated worker
// (TIL-178) — and paths in through the single door to sit on it, facing up into
// the monitor. Several sessions on one project fill several desks; overflow past
// the desk count waits on distinct frontage tiles (spread by task id, never
// stacked on the door). Idle characters converge on the plaza and mill there.
//
// Under prefers-reduced-motion the whole thing collapses to a still tableau:
// every character snapped to its resting tile, no paths, no motion.

import type { PresenceState } from "../utils/presence";
import { findPath } from "./pathfind";
import { isWalkable, type LeisureSpot, type Tile, type TownWorld } from "./world";

/** Tiles traversed per second while walking. */
const SPEED = 2.4;
/** Pause (ms) between reaching a wander step and taking the next. */
const WANDER_PAUSE_MS = 900;
/** Chance an idle character heads to a free leisure spot vs a plain waypoint. */
const SPOT_CHANCE = 0.5;
/** How long (ms) a character lingers at a leisure spot before wandering on. */
const DWELL_MS = 2600;
/** dt is clamped so a long pause/resume can't teleport anyone across the map. */
const MAX_DT_MS = 100;

export type Facing = "up" | "down" | "left" | "right";

/** What presence resolves a character to want, physically. */
type Intent = "home" | "wander" | "pace" | "off";

export interface CharAgent {
  taskId: number;
  agentName: string | null;
  buildingIndex: number;
  /** Tile-space position (float — interpolates between integer tiles). */
  pos: { x: number; y: number };
  facing: Facing;
  /** Remaining tiles to walk; pos advances toward path[0]. */
  path: Tile[];
  intent: Intent;
  /** True while advancing along a path (drives the walk animation). */
  moving: boolean;
  /** Countdown until the next wander waypoint while standing idle. */
  wanderPauseMs: number;
  /** The leisure spot this character has claimed (walking to or sitting at), or
   *  null when it is not visiting one. */
  spotId: number | null;
  /** Remaining time (ms) to linger at the claimed spot. */
  dwellMs: number;
  /** The interior desk seat this character works at (its building's seat tile),
   *  or null when it has no seat (idle/leaving, or overflow past the desk count).
   *  Set each step by the seat assignment; the work target when non-null. */
  seat: Tile | null;
  /** Where an overflow worker (home, but no free desk) waits — a distinct tile
   *  near its building, assigned so two overflow workers never share one. Null
   *  unless this character is overflow. */
  restTile: Tile | null;
  /** True once the character is sitting on its `seat` — drives the desk "typing"
   *  animation and tells the renderer it is heads-down at the monitor. */
  seated: boolean;
}

export interface SimState {
  chars: Map<number, CharAgent>;
  /** Which character currently holds each leisure spot (spotId → taskId). A spot
   *  in this map is taken; that is what keeps two idlers off the same spot. */
  occupied: Map<number, number>;
}

/** One roster entry the sim consumes — a townModel character plus its building. */
export interface RosterChar {
  taskId: number;
  agentName: string | null;
  state: PresenceState;
  live: boolean;
  buildingIndex: number;
}

export interface StepOpts {
  reducedMotion?: boolean;
}

export function createSim(): SimState {
  return { chars: new Map(), occupied: new Map() };
}

/** Release any leisure spot this character holds. */
function releaseSpot(sim: SimState, c: CharAgent) {
  if (c.spotId !== null) {
    sim.occupied.delete(c.spotId);
    c.spotId = null;
    c.dwellMs = 0;
  }
}

/** The nearest free leisure spot to `from`, or null if all are taken. */
function freeSpot(world: TownWorld, sim: SimState, from: Tile): LeisureSpot | null {
  let best: LeisureSpot | null = null;
  let bestDist = Infinity;
  for (const s of world.spots) {
    if (sim.occupied.has(s.id)) continue;
    const d = Math.abs(s.tile.x - from.x) + Math.abs(s.tile.y - from.y);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

function intentOf(state: PresenceState, live: boolean): Intent {
  if (state === "blocked") return "pace";
  if (state === "quiet" && live) return "wander";
  return "home"; // working, or quiet-not-live (rest at home)
}

/** The building door — a character's outside entry/rest tile. */
function homeTile(world: TownWorld, buildingIndex: number): Tile {
  const b = world.buildings[buildingIndex] ?? world.buildings[0];
  return b ? b.door : { x: 0, y: 0 };
}

/** Where a `home` character heads: its claimed desk seat if it has one, else its
 *  assigned overflow rest tile (distinct per worker — see assignSeats), or the
 *  door as a last resort. */
function workTile(world: TownWorld, c: CharAgent): Tile {
  return c.seat ?? c.restTile ?? homeTile(world, c.buildingIndex);
}

/** `count` distinct walkable tiles near a building's door, nearest first, for
 *  overflow workers to wait on — a BFS out from the door that skips interior
 *  seats/doorways and leisure spots, so two overflow workers never share a tile
 *  (the old `taskId % frontage` aliased ids like 3 and 6 onto the door). */
function nearbyRestTiles(world: TownWorld, buildingIndex: number, count: number): Tile[] {
  const door = homeTile(world, buildingIndex);
  const interior = new Set(
    world.buildings.flatMap((b) => [
      ...b.seats.map((s) => `${s.x},${s.y}`),
      `${b.door.x},${b.door.y - 1}`,
    ]),
  );
  const spots = new Set(world.spots.map((s) => `${s.tile.x},${s.tile.y}`));
  // Exclude the door + its frontage — those tiles belong to a `blocked` worker
  // pacing the building front, so an overflow rester must never wait there.
  const frontageSet = new Set(frontage(world, buildingIndex).map((t) => `${t.x},${t.y}`));
  const seen = new Set<string>([`${door.x},${door.y}`]);
  const queue: Tile[] = [door];
  const out: Tile[] = [];
  while (queue.length && out.length < count) {
    const t = queue.shift()!;
    const key = `${t.x},${t.y}`;
    if (
      isWalkable(world, t.x, t.y) &&
      !interior.has(key) &&
      !spots.has(key) &&
      !frontageSet.has(key)
    ) {
      out.push(t);
    }
    for (const [dx, dy] of STEPS) {
      const n = { x: t.x + dx, y: t.y + dy };
      const k = `${n.x},${n.y}`;
      if (!seen.has(k) && isWalkable(world, n.x, n.y)) {
        seen.add(k);
        queue.push(n);
      }
    }
  }
  return out.length ? out : [{ x: door.x, y: door.y + 1 }];
}

/**
 * Give each `home`-intent character an interior desk seat in its building —
 * *stickily*. A character keeps the seat it already holds; only seatless home
 * characters claim a free one (lowest task id first, deterministic). So a worker
 * that is already seated never moves when another session joins or leaves the
 * same project (the TIL-178 reshuffle bug). Non-home / departed / building-moved
 * characters release their seat; overflow past the desk count gets `seat = null`
 * and waits at a frontage tile (see workTile).
 */
function assignSeats(sim: SimState, world: TownWorld, byId: Map<number, RosterChar>) {
  // 1. Release seats no longer valid (not home, gone, or wrong building), and
  //    collect the home characters per building.
  const homeByBuilding = new Map<number, number[]>();
  for (const [id, c] of sim.chars) {
    if (c.intent !== "home" || !byId.has(id)) {
      c.seat = null;
      c.restTile = null;
      continue;
    }
    if (c.seat) {
      const seats = world.buildings[c.buildingIndex]?.seats ?? [];
      if (!seats.some((s) => s.x === c.seat!.x && s.y === c.seat!.y)) c.seat = null;
    }
    const list = homeByBuilding.get(c.buildingIndex) ?? [];
    list.push(id);
    homeByBuilding.set(c.buildingIndex, list);
  }
  // 2. Fill free seats with the seatless, keeping already-held seats put (sticky);
  //    workers past the desk count become overflow on distinct rest tiles.
  for (const [buildingIndex, ids] of homeByBuilding) {
    const seats = world.buildings[buildingIndex]?.seats ?? [];
    const taken = new Set<string>();
    for (const id of ids) {
      const s = sim.chars.get(id)!.seat;
      if (s) taken.add(`${s.x},${s.y}`);
    }
    const free = seats.filter((s) => !taken.has(`${s.x},${s.y}`));
    const needy = ids.filter((id) => !sim.chars.get(id)!.seat).sort((a, b) => a - b);
    const overflow: number[] = [];
    needy.forEach((id, i) => {
      const c = sim.chars.get(id)!;
      if (i < free.length) {
        c.seat = free[i];
        c.restTile = null;
      } else {
        c.seat = null;
        overflow.push(id);
      }
    });
    if (overflow.length) {
      const tiles = nearbyRestTiles(world, buildingIndex, overflow.length);
      overflow.forEach((id, i) => {
        sim.chars.get(id)!.restTile = tiles[Math.min(i, tiles.length - 1)];
      });
    }
    for (const id of ids) {
      const c = sim.chars.get(id)!;
      if (c.seat) c.restTile = null;
    }
  }
}

/** Is tile `t` within the plaza rectangle? */
function inPlaza(world: TownWorld, t: Tile): boolean {
  const p = world.plaza;
  return p.w > 0 && t.x >= p.x && t.x < p.x + p.w && t.y >= p.y && t.y < p.y + p.h;
}

/** A random walkable plaza tile to gather at (the centre is the blocked fountain,
 *  so fall back to the first walkable tile, not the geometric centre). */
function randomPlazaTile(world: TownWorld, rng: () => number): Tile {
  const p = world.plaza;
  for (let i = 0; i < 8; i++) {
    const x = p.x + Math.floor(rng() * p.w);
    const y = p.y + Math.floor(rng() * p.h);
    if (isWalkable(world, x, y)) return { x, y };
  }
  for (let dy = 0; dy < p.h; dy++) {
    for (let dx = 0; dx < p.w; dx++) {
      if (isWalkable(world, p.x + dx, p.y + dy)) return { x: p.x + dx, y: p.y + dy };
    }
  }
  return { x: p.x, y: p.y };
}

function facingOf(dx: number, dy: number, fallback: Facing): Facing {
  if (dx === 0 && dy === 0) return fallback;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

function round(t: { x: number; y: number }): Tile {
  return { x: Math.round(t.x), y: Math.round(t.y) };
}

function sameTile(a: Tile, b: Tile): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Frontage tiles a `blocked` character paces across — the door and its
 *  walkable left/right neighbours. */
function frontage(world: TownWorld, buildingIndex: number): Tile[] {
  const door = homeTile(world, buildingIndex);
  return [door, { x: door.x - 1, y: door.y }, { x: door.x + 1, y: door.y }].filter(
    (t) => isWalkable(world, t.x, t.y),
  );
}

const STEPS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** A single random walkable step to a 4-neighbour that `avoid` rejects none of,
 *  or null if hemmed in. Wander is deliberately these cheap adjacent steps — not
 *  A* to a distant waypoint (A* is reserved for a specific target: home, a spot,
 *  the edge). `avoid` keeps wanderers off leisure-spot tiles so only a spot's
 *  claimant ever stands on it. */
function randomAdjacentStep(
  world: TownWorld,
  from: Tile,
  rng: () => number,
  avoid: (t: Tile) => boolean,
): Tile | null {
  const start = Math.floor(rng() * STEPS.length);
  for (let i = 0; i < STEPS.length; i++) {
    const [dx, dy] = STEPS[(start + i) % STEPS.length];
    const t = { x: from.x + dx, y: from.y + dy };
    if (isWalkable(world, t.x, t.y) && !avoid(t)) return t;
  }
  return null;
}

/**
 * Advance the simulation by `dtMs`. Reconciles the character set against the
 * roster (spawn newcomers at their door; walk off leavers), resolves each
 * character's intent from its presence state, and integrates movement along
 * paths. Pure: returns the same mutated `sim` for convenience but relies only
 * on its inputs. `rng` must be a deterministic 0..1 source for testability.
 */
export function stepTownSim(
  sim: SimState,
  roster: RosterChar[],
  dtMs: number,
  world: TownWorld,
  rng: () => number = Math.random,
  opts: StepOpts = {},
): SimState {
  const dt = Math.min(Math.max(dtMs, 0), MAX_DT_MS);
  const byId = new Map(roster.map((r) => [r.taskId, r]));
  // Leisure-spot tiles are off-limits to wanderers — only a spot's claimant
  // stands on it, so two bodies never share a spot.
  const spotTiles = new Set(world.spots.map((s) => `${s.tile.x},${s.tile.y}`));
  // A path predicate that routes around every spot tile except the destination,
  // so a character walking to its own spot (or home/edge) never transits — and
  // momentarily stands on — a spot another character is occupying.
  const avoidSpots = (target: Tile) => (x: number, y: number) =>
    spotTiles.has(`${x},${y}`) && !(x === target.x && y === target.y);
  // Interior seat tiles are the only walkable tiles inside a house (a cul-de-sac
  // off the green). Wanderers must never step onto them — only a `home`
  // character heading to *its* seat enters, via an explicit path. So wander's
  // random steps avoid them, and a character standing inside (its intent just
  // flipped away from work) is first walked back out to the door.
  const interiorTiles = new Set(
    world.buildings.flatMap((b) => [
      ...b.seats.map((s) => `${s.x},${s.y}`),
      `${b.door.x},${b.door.y - 1}`, // the doorway (front-wall gap) is inside too
    ]),
  );
  const insideKey = (t: Tile) => interiorTiles.has(`${t.x},${t.y}`);

  // --- Spawn newcomers at their building door. ---
  for (const r of roster) {
    if (sim.chars.has(r.taskId)) {
      const c = sim.chars.get(r.taskId)!;
      c.agentName = r.agentName;
      const newIntent = intentOf(r.state, r.live);
      // A changed intent (or building) invalidates the current path — drop it so
      // the new state is honoured next resolve, not after a stale walk finishes.
      if (newIntent !== c.intent || r.buildingIndex !== c.buildingIndex) {
        c.path = [];
        c.wanderPauseMs = 0;
        releaseSpot(sim, c);
      }
      c.buildingIndex = r.buildingIndex;
      c.intent = newIntent;
      continue;
    }
    const door = homeTile(world, r.buildingIndex);
    sim.chars.set(r.taskId, {
      taskId: r.taskId,
      agentName: r.agentName,
      buildingIndex: r.buildingIndex,
      pos: { x: door.x, y: door.y },
      facing: "down",
      path: [],
      intent: intentOf(r.state, r.live),
      moving: false,
      wanderPauseMs: 0,
      spotId: null,
      dwellMs: 0,
      seat: null,
      restTile: null,
      seated: false,
    });
  }

  // Assign interior desk seats to working/resting characters (see assignSeats).
  assignSeats(sim, world, byId);

  // Safety net: drop spot claims held by characters that no longer exist, so a
  // missed release can never leave a spot permanently blocked.
  for (const [spotId, taskId] of sim.occupied) {
    if (!sim.chars.has(taskId)) sim.occupied.delete(spotId);
  }

  // --- Reduced motion: still tableau. Snap everyone home, no motion. ---
  if (opts.reducedMotion) {
    sim.occupied.clear(); // nobody is out using a spot in the still tableau
    for (const [id, c] of sim.chars) {
      if (!byId.has(id)) {
        sim.chars.delete(id); // gone characters simply vanish (no walk-off)
        continue;
      }
      // Home characters snap to their desk seat (sitting), everyone else to the
      // door — a still tableau of workers at their monitors.
      const rest = c.intent === "home" ? workTile(world, c) : homeTile(world, c.buildingIndex);
      c.pos = { x: rest.x, y: rest.y };
      c.path = [];
      c.moving = false;
      c.facing = "up";
      c.seated = c.intent === "home" && c.seat !== null;
      c.spotId = null;
      c.dwellMs = 0;
    }
    return sim;
  }

  // --- Leavers walk off to the edge, then despawn. ---
  for (const [id, c] of sim.chars) {
    if (byId.has(id)) continue;
    if (c.intent !== "off") {
      c.intent = "off";
      releaseSpot(sim, c); // give up any spot on the way out
      c.path = findPath(world, round(c.pos), world.edge, avoidSpots(world.edge)).slice(1);
      if (c.path.length === 0) sim.chars.delete(id); // already at edge / stuck
    }
  }

  // --- Resolve intent → path, then integrate movement. ---
  for (const [id, c] of sim.chars) {
    const here = round(c.pos);

    // Any non-wander intent gives up a held spot (resumed work, blocked, off).
    if (c.intent !== "wander" && c.spotId !== null) releaseSpot(sim, c);

    // A character that just stopped working (now wandering or pacing) is sitting
    // inside — walk it back out to the door before it does anything else, since
    // the interior's only exit is that door and wander/pace steps never enter it.
    if ((c.intent === "wander" || c.intent === "pace") && c.path.length === 0 && insideKey(here)) {
      const door = homeTile(world, c.buildingIndex);
      c.path = findPath(world, here, door, avoidSpots(door)).slice(1);
      c.seated = false;
    }

    if (c.intent === "home") {
      const target = workTile(world, c); // its desk seat, or the door on overflow
      if (c.path.length === 0) {
        if (!sameTile(here, target)) {
          c.path = findPath(world, here, target, avoidSpots(target)).slice(1);
        } else if (c.pos.x !== target.x || c.pos.y !== target.y) {
          // On the target tile but stopped mid-tile (e.g. path cleared by an
          // intent flip) — snap the residual float to the exact rest tile.
          c.pos = { x: target.x, y: target.y };
        }
      }
    } else if (c.intent === "wander") {
      if (c.spotId !== null) {
        // Claimed a spot: walk to it, linger, then step off — holding the
        // reservation until physically clear of the tile, so no one else can
        // claim or enter it while we are still standing there.
        const spot = world.spots.find((s) => s.id === c.spotId);
        const onSpot = !!spot && here.x === spot.tile.x && here.y === spot.tile.y;
        if (c.path.length === 0) {
          if (onSpot && c.dwellMs > 0) {
            c.dwellMs -= dt; // lingering
          } else if (onSpot) {
            // Done lingering — step off to an adjacent non-spot tile.
            const step = randomAdjacentStep(world, here, rng, (t) =>
              spotTiles.has(`${t.x},${t.y}`) || insideKey(t),
            );
            if (step) c.path = [step];
          } else {
            // Clear of the spot tile now — release it and resume wandering.
            releaseSpot(sim, c);
            c.wanderPauseMs = WANDER_PAUSE_MS;
          }
        }
      } else if (c.path.length === 0) {
        if (c.wanderPauseMs > 0) {
          c.wanderPauseMs -= dt;
        } else {
          // Head to a free leisure spot, or take a plain wander waypoint.
          const spot = rng() < SPOT_CHANCE ? freeSpot(world, sim, here) : null;
          if (spot) {
            const path = findPath(world, here, spot.tile, avoidSpots(spot.tile)).slice(1);
            if (path.length > 0) {
              sim.occupied.set(spot.id, c.taskId);
              c.spotId = spot.id;
              c.dwellMs = DWELL_MS;
              c.path = path;
            } else {
              c.wanderPauseMs = WANDER_PAUSE_MS; // unreachable — try again later
            }
          } else if (world.plaza.w > 0 && !inPlaza(world, here)) {
            // Not at the plaza yet — head there to gather with the others.
            const target = randomPlazaTile(world, rng);
            const path = findPath(world, here, target, avoidSpots(target)).slice(1);
            if (path.length > 0) c.path = path;
            c.wanderPauseMs = WANDER_PAUSE_MS;
          } else {
            // Milling about the plaza (or nowhere to gather): a small step that
            // stays in the plaza and off spot/interior tiles.
            const step = randomAdjacentStep(world, here, rng, (t) =>
              spotTiles.has(`${t.x},${t.y}`) ||
              insideKey(t) ||
              (world.plaza.w > 0 && !inPlaza(world, t)),
            );
            if (step) c.path = [step];
            c.wanderPauseMs = WANDER_PAUSE_MS;
          }
        }
      }
    } else if (c.intent === "pace") {
      if (c.path.length === 0) {
        const spots = frontage(world, c.buildingIndex).filter((t) => !sameTile(t, here));
        const pick = spots[Math.floor(rng() * spots.length)] ?? null;
        if (pick) c.path = findPath(world, here, pick, avoidSpots(pick)).slice(1);
        c.wanderPauseMs = WANDER_PAUSE_MS;
        if (spots.length && c.path.length === 0) c.wanderPauseMs = WANDER_PAUSE_MS;
      }
    }
    // intent === "off": path already set above.

    // Integrate along the path.
    if (c.path.length > 0) {
      let budget = (SPEED * dt) / 1000; // tiles this frame
      c.moving = true;
      c.seated = false;
      while (budget > 0 && c.path.length > 0) {
        const next = c.path[0];
        const dx = next.x - c.pos.x;
        const dy = next.y - c.pos.y;
        const dist = Math.abs(dx) + Math.abs(dy); // axis-aligned segments
        c.facing = facingOf(dx, dy, c.facing);
        if (dist <= budget) {
          c.pos = { x: next.x, y: next.y };
          c.path.shift();
          budget -= dist;
        } else {
          const ux = dx === 0 ? 0 : dx > 0 ? 1 : -1;
          const uy = dy === 0 ? 0 : dy > 0 ? 1 : -1;
          c.pos = { x: c.pos.x + ux * budget, y: c.pos.y + uy * budget };
          budget = 0;
        }
      }
      if (c.path.length === 0) {
        c.moving = false;
        if (c.intent === "off") sim.chars.delete(id);
      }
    } else {
      c.moving = false;
      // Resting at its desk → face up into the monitor, and mark it seated once
      // it is actually on its seat tile (drives the desk "typing" animation).
      if (c.intent === "home") {
        c.facing = "up";
        c.seated = c.seat !== null && sameTile(here, c.seat);
      } else {
        c.seated = false;
      }
    }
  }

  return sim;
}
