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
//   working                 → home at its building's door (heads-down)
//   quiet & live (idle)     → walks out and wanders the green
//   quiet & not live (rest) → stands at home (no live heartbeat to wander)
//   blocked                 → paces just outside its own building
//   roster drops it (ended) → walks off to the world edge and despawns
//
// Under prefers-reduced-motion the whole thing collapses to a still tableau:
// every character snapped to its resting tile, no paths, no motion.

import type { PresenceState } from "../utils/presence";
import { findPath } from "./pathfind";
import { isWalkable, type Tile, type TownWorld } from "./world";

/** Tiles traversed per second while walking. */
const SPEED = 2.4;
/** How far (tiles) an idle wanderer picks its next waypoint. */
const WANDER_RADIUS = 3;
/** Pause (ms) between reaching a wander waypoint and choosing the next. */
const WANDER_PAUSE_MS = 900;
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
}

export interface SimState {
  chars: Map<number, CharAgent>;
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
  return { chars: new Map() };
}

function intentOf(state: PresenceState, live: boolean): Intent {
  if (state === "blocked") return "pace";
  if (state === "quiet" && live) return "wander";
  return "home"; // working, or quiet-not-live (rest at home)
}

/** The tile a character rests on for a given intent — its building's door. */
function homeTile(world: TownWorld, buildingIndex: number): Tile {
  const b = world.buildings[buildingIndex] ?? world.buildings[0];
  return b ? b.door : { x: 0, y: 0 };
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

/** Pick a walkable wander waypoint within WANDER_RADIUS, or null after retries. */
function wanderTarget(world: TownWorld, from: Tile, rng: () => number): Tile | null {
  for (let i = 0; i < 8; i++) {
    const dx = Math.floor(rng() * (WANDER_RADIUS * 2 + 1)) - WANDER_RADIUS;
    const dy = Math.floor(rng() * (WANDER_RADIUS * 2 + 1)) - WANDER_RADIUS;
    const t = { x: from.x + dx, y: from.y + dy };
    if ((dx !== 0 || dy !== 0) && isWalkable(world, t.x, t.y)) return t;
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

  // --- Spawn newcomers at their building door. ---
  for (const r of roster) {
    if (sim.chars.has(r.taskId)) {
      const c = sim.chars.get(r.taskId)!;
      c.agentName = r.agentName;
      c.buildingIndex = r.buildingIndex;
      c.intent = intentOf(r.state, r.live);
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
    });
  }

  // --- Reduced motion: still tableau. Snap everyone home, no motion. ---
  if (opts.reducedMotion) {
    for (const [id, c] of sim.chars) {
      if (!byId.has(id)) {
        sim.chars.delete(id); // gone characters simply vanish (no walk-off)
        continue;
      }
      const home = homeTile(world, c.buildingIndex);
      c.pos = { x: home.x, y: home.y };
      c.path = [];
      c.moving = false;
      c.facing = "up";
    }
    return sim;
  }

  // --- Leavers walk off to the edge, then despawn. ---
  for (const [id, c] of sim.chars) {
    if (byId.has(id)) continue;
    if (c.intent !== "off") {
      c.intent = "off";
      c.path = findPath(world, round(c.pos), world.edge).slice(1);
      if (c.path.length === 0) sim.chars.delete(id); // already at edge / stuck
    }
  }

  // --- Resolve intent → path, then integrate movement. ---
  for (const [id, c] of sim.chars) {
    const here = round(c.pos);

    if (c.intent === "home") {
      const home = homeTile(world, c.buildingIndex);
      if (c.path.length === 0 && !sameTile(here, home)) {
        c.path = findPath(world, here, home).slice(1);
      }
    } else if (c.intent === "wander") {
      if (c.path.length === 0) {
        if (c.wanderPauseMs > 0) {
          c.wanderPauseMs -= dt;
        } else {
          const target = wanderTarget(world, here, rng);
          if (target) c.path = findPath(world, here, target).slice(1);
          c.wanderPauseMs = WANDER_PAUSE_MS;
        }
      }
    } else if (c.intent === "pace") {
      if (c.path.length === 0) {
        const spots = frontage(world, c.buildingIndex).filter((t) => !sameTile(t, here));
        const pick = spots[Math.floor(rng() * spots.length)] ?? null;
        if (pick) c.path = findPath(world, here, pick).slice(1);
        c.wanderPauseMs = WANDER_PAUSE_MS;
        if (spots.length && c.path.length === 0) c.wanderPauseMs = WANDER_PAUSE_MS;
      }
    }
    // intent === "off": path already set above.

    // Integrate along the path.
    if (c.path.length > 0) {
      let budget = (SPEED * dt) / 1000; // tiles this frame
      c.moving = true;
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
      // Resting at home → face up, into the building (a "working at the desk" read).
      if (c.intent === "home") c.facing = "up";
    }
  }

  return sim;
}
