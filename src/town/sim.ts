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
//   working                 → walks inside and works at its own desk
//   quiet & live, by day    → walks out and gathers at the central plaza
//   quiet & live, at night  → goes home to bed
//   quiet & NOT live        → goes home to the sofa (or to bed, at night)
//   blocked                 → paces just outside its own building
//   roster drops it (ended) → walks off to the world edge and despawns
//
// Working and quiet-not-live used to be the same picture: both resolved to the
// same intent, the same seat and the same animation, so an agent grinding for 25
// minutes and one whose session died an hour ago were visually identical (only
// the building's window glow carried the difference, and that is a property of
// the building, not the person). That threw away the exact distinction presence.ts
// exists to preserve — it refuses to report "working" without a heartbeat
// precisely because guessing from a fresh timestamp was the old bug. A dead
// session now visibly stops: it leaves the desk and goes to the sofa.
//
// Night comes from the same day/night phase the renderer tints with, and the
// session wins over the clock (user decision, 2026-07-29): a quiet agent goes to
// bed at 3am, a working one is still at its desk. So the town at night reads as
// "these two projects are still going", which is the thing worth knowing.
//
// A working character is not a pose held for 25 minutes, either. It spends most
// of its time at its desk and takes short trips — coffee at the counter, a wash
// at the sink, a plan at the whiteboard, a build watched at the rack — because
// rendering heads-down work as 25 unbroken minutes of the same bob is what made
// the town feel deadest at exactly the moment it was busiest. Trips resolve to an
// (object, verb) affordance the world declares (world.ts), the Generative-Agents
// shape: an action is a verb against a named object, not a coordinate.
//
// And a quiet character is not a pose either (TIL-199). "Went home" used to mean
// "sits on the sofa until the roster drops it" — the deadest picture in the town,
// arriving the moment an agent stopped working. A resting character now runs the
// same trip loop over the house's *leisure* objects: the television, the guitar,
// the stove, a book, the shower. Out of doors the same principle applies to the
// commons — a spot carries a verb, so an idler at the pond is fishing and one at
// the stall is shopping, rather than everyone everywhere "resting".
//
// "Sits at its own desk": each building has a row of interior seat tiles (one
// per workstation). A working/resting character claims a seat *stickily* — it
// keeps the seat it holds, so a later joiner never reshuffles a seated worker
// (TIL-178) — and paths in through the single door to sit on it, facing up into
// the monitor. Several sessions on one project fill several desks; overflow past
// the desk count waits on distinct frontage tiles (spread by task id, never
// stacked on the door). Idle characters converge on the plaza and mill there.
//
// And a character is not only a position and a verb: it has a *posture*
// (TIL-200). The renderer used to animate everything that was not walking with the
// walk cycle at half speed, so a worker heads-down for 25 minutes marched on the
// spot at its desk and a sleeper marched on the spot beside its bed. The sim now
// says whether a character is on its feet, sat down or lying — and, when it is on
// furniture, which tile to draw it on, since a sofa is blocked and the tile a
// character can actually stand on is the one *next to* it.
//
// Under prefers-reduced-motion the whole thing collapses to a still tableau:
// every character snapped to its resting tile, no paths, no motion.

import type { PresenceState } from "../utils/presence";
import { findPath } from "./pathfind";
import {
  isWalkable,
  spotPosture,
  type Affordance,
  type ActivityVerb,
  type LeisureSpot,
  type SpotKind,
  type Tile,
  type TownWorld,
} from "./world";

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
/** How close (tiles) two idle characters must pass to stop and chat. */
const CHAT_RANGE = 1.6;
/** How long (ms) a chat lasts. Bounded: nobody is stuck talking. */
const CHAT_MS = 2200;
/** How long (ms) before a character will stop to chat again — without it, two
 *  wanderers who stay near each other chat on a loop and never wander. */
const CHAT_COOLDOWN_MS = 6000;
/** How long (ms) a worker stays at its desk between short trips. Deliberately
 *  long: a trip every few seconds reads as a fidget, and the point of the
 *  routine is that heads-down work is *mostly* heads-down. */
const CHORE_MIN_MS = 18_000;
const CHORE_SPREAD_MS = 16_000;
/** How long (ms) a worker spends on the trip before heading back to its desk. */
const CHORE_DWELL_MS = 3200;
/**
 * What a working character may get up to do.
 *
 * An allow-list, not "anything that is not a desk". Excluding only `working`
 * admitted the sofa and the bed, so a live agent grinding away would get up,
 * walk to bed and render as `sleeping` — the exact picture this change exists to
 * reserve for a session that has actually stopped (Codex finding on 67114c2).
 * The research's phrase for this loop is "coffee, a stretch at the window, back
 * to the desk"; lying down is not in it.
 */
const CHORE_VERBS: ActivityVerb[] = [
  "coffee",
  "washing",
  "eating",
  "reading",
  // The workday past the kettle (TIL-199): a plan gets drawn at the whiteboard
  // and a build gets watched at the rack. Both are workroom objects, so this
  // reads as work happening rather than as a break from it.
  "planning",
  "deploying",
  // The research's phrase for this loop is "coffee, a stretch at the window, back
  // to the desk", and until TIL-200 the stretch was the one part missing. Watering
  // the plant is the same shape of break — a minute away from the screen, still in
  // the house.
  "exercising",
  "gardening",
];

/**
 * What a character does with an evening off.
 *
 * A quiet agent used to sit on the sofa until the roster dropped it — the town's
 * least alive picture arriving exactly when its work stopped. It now runs the
 * same trip loop a worker does, over a different set of verbs: the television,
 * the guitar, the stove, a book, the shower. `sleeping` is deliberately absent —
 * going to bed is what *night* means (`intentOf`), not something to get up and do.
 */
const LEISURE_VERBS: ActivityVerb[] = [
  "watching",
  "music",
  "cooking",
  "eating",
  "reading",
  "coffee",
  "washing",
  // TIL-200: an evening of seven verbs, four of which are the kitchen, was still
  // a short evening. A game, a mat and the plants are the rest of it — and each
  // has an outdoor twin on the green, so the two halves of the day rhyme.
  "gaming",
  "exercising",
  "gardening",
];
/** An evening is more restless than a workday: shorter gaps, longer stays. */
const LEISURE_MIN_MS = 7000;
const LEISURE_SPREAD_MS = 9000;
const LEISURE_DWELL_MS = 6500;
/** How long a visitor stays at a spot whose whole point is staying a while. */
const SPOT_DWELL_MS: Partial<Record<ActivityVerb, number>> = {
  // A doze is the longest thing you can do outdoors and a coffee the shortest;
  // the point of the spread is that the square never empties and refills in step.
  napping: 14_000,
  fishing: 9000,
  painting: 8000,
  gaming: 8000,
  music: 7500,
  playing: 6500,
  reading: 6000,
  exercising: 5500,
  eating: 5000,
  gardening: 5000,
  shopping: 3000,
  coffee: 3500,
};

export type Facing = "up" | "down" | "left" | "right";

/**
 * How a character is holding itself: on its feet, sat down, or lying.
 *
 * The sim owned "where" and "what it is doing" and left the *body* to the
 * renderer, which had one animation for everything that was not walking: the walk
 * cycle, at half speed, with a bob. So an agent heads-down at its desk for 25
 * minutes stepped in place the whole time, and so did one asleep in bed — the town
 * read as a room full of people marching on the spot (TIL-200, and the thing the
 * user actually asked for).
 *
 * Posture belongs here rather than there because only the sim knows *why* a
 * character is where it is: the same tile is somewhere to sit if you came to sit
 * on the bench and somewhere to stand if you came to fish off the bank.
 */
export type Posture = "stand" | "sit" | "lie";

/** What presence resolves a character to want, physically.
 *
 *  `work` and `rest` were one intent (`home`) until TIL-198 — which is exactly
 *  why a live agent and a dead one looked the same. */
type Intent = "work" | "rest" | "wander" | "pace" | "off";

/**
 * What a character is visibly doing — the thing the town renders a glyph for and
 * the tooltip says in words.
 *
 * The first six come from the agent's own last log line rather than from the
 * sim: `lastLog` already reaches the town model and was being spent on hover
 * text alone, while the town drove itself off a three-value enum. The rest are
 * physical states the sim owns.
 */
export type Activity =
  // What the agent says it is doing, classified from its last log line.
  | "typing"
  | "building"
  | "testing"
  | "reading"
  | "writing"
  | "waiting"
  // What the sim can see it doing.
  | "coffee"
  | "washing"
  | "eating"
  | "resting"
  | "sleeping"
  | "walking"
  | "chatting"
  | "stuck"
  | "leaving"
  // At the workroom's other objects, and around the house of an evening.
  | "planning"
  | "deploying"
  | "watching"
  | "music"
  | "cooking"
  // Out of doors, at a spot that is for something in particular.
  | "fishing"
  | "gardening"
  | "shopping"
  | "playing"
  | "painting"
  // Each of these happens in two places — a board game at the chess table or on
  // the lounge floor, a stretch at the frame or on the mat, a doze in the hammock.
  | "gaming"
  | "exercising"
  | "napping";

/** The activity a log line implies, or null when it says nothing useful. Kept
 *  deliberately small and literal — this is a legibility aid, not an intent
 *  classifier, and a wrong guess here shows up as a wrong glyph over someone's
 *  head.
 *
 *  Order is first-match, and it is load-bearing: not-making-progress words beat
 *  everything (a line is about waiting whatever it is waiting *for* — "waiting
 *  on the review" is not reading), then the two concrete machine activities,
 *  then the broad verbs, which are broad enough to swallow anything left. */
const LOG_PATTERNS: [RegExp, Activity][] = [
  [/\b(wait|block|pending|queue|retry|stuck)/i, "waiting"],
  [/\b(test|spec|suite|vitest|jest|pytest|e2e)/i, "testing"],
  [/\b(build|compil|bundl|tsc|cargo|webpack|vite)/i, "building"],
  [/\b(read|inspect|search|grep|scan|explor|audit|review)/i, "reading"],
  [/\b(writ|edit|implement|refactor|add|updat|fix|commit)/i, "writing"],
];

/** Classify an agent's last log line into something the town can draw. */
export function classifyLog(lastLog: string | null | undefined): Activity | null {
  if (!lastLog) return null;
  for (const [re, activity] of LOG_PATTERNS) if (re.test(lastLog)) return activity;
  return null;
}

/** The activity a trip to a piece of furniture reads as. */
const VERB_ACTIVITY: Record<ActivityVerb, Activity> = {
  working: "typing",
  coffee: "coffee",
  washing: "washing",
  eating: "eating",
  reading: "reading",
  resting: "resting",
  sleeping: "sleeping",
  planning: "planning",
  deploying: "deploying",
  watching: "watching",
  music: "music",
  cooking: "cooking",
  fishing: "fishing",
  gardening: "gardening",
  shopping: "shopping",
  playing: "playing",
  painting: "painting",
  gaming: "gaming",
  exercising: "exercising",
  napping: "napping",
};

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
  /** What that spot is for — fishing at the pond, shopping at the stall, sitting
   *  on a bench. Copied off the spot when it is claimed so the activity does not
   *  need the world to resolve, and so an idle character reads as *doing* the
   *  thing it walked across town to do. */
  spotVerb: ActivityVerb | null;
  /** …and what kind of thing it is, so posture can tell a bench from a pond bank
   *  without the sim having to look the spot up again. */
  spotKind: SpotKind | null;
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
  /** The sofa- or bed-side tile a `rest` character has claimed in its own house,
   *  or null when it is not resting. Exclusive, like a desk seat: two quiet
   *  agents never share a bed. */
  restSpot: Tile | null;
  /** Which it is — what the character is resting *on*, for the glyph. */
  restKind: "sofa" | "bed" | null;
  /** The sofa/bed tile itself. A rest spot is the walkable tile *beside* the
   *  furniture (it has to be — the furniture is blocked), so drawing the character
   *  at its position put it standing smartly to attention next to the bed it was
   *  supposedly asleep in. This is where the renderer actually draws it. */
  restObject: Tile | null;
  /** The short trip a working character is on: where it is going and what for.
   *  Null while it is at its desk. */
  chore: { tile: Tile; verb: ActivityVerb } | null;
  /** Countdown (ms) at the desk until the next trip; then the dwell at it. */
  choreMs: number;
  choreDwellMs: number;
  /** True once the character is sitting on its `seat` — drives the desk "typing"
   *  animation and tells the renderer it is heads-down at the monitor. */
  seated: boolean;
  /** What this character is visibly doing, recomputed every step. The renderer
   *  draws it as a glyph over the head and the tooltip says it in words. */
  activity: Activity;
  /** How it is holding itself, recomputed every step alongside `activity`. */
  posture: Posture;
  /** The furniture tile to draw this character *on* rather than at `pos` — the
   *  sofa it is sat on, the bed it is asleep in. Null whenever it is drawn where
   *  it stands, which is everywhere else. */
  onTile: Tile | null;
  /** Remaining time (ms) of a chat with a passer-by; 0 when not chatting. While
   *  it runs the character stands still, faces its partner, and the renderer
   *  shows a bubble over it. Cosmetic — there is no dialogue (spec non-goal). */
  chatMs: number;
  /** The character on the other side of that chat, or null. */
  chatWith: number | null;
  /** Time (ms) before this character will stop to chat again, so two that stay
   *  near each other do not chat on a loop instead of wandering. */
  chatCooldownMs: number;
}

export interface SimState {
  chars: Map<number, CharAgent>;
  /** Which character currently holds each leisure spot (spotId → taskId). A spot
   *  in this map is taken; that is what keeps two idlers off the same spot. */
  occupied: Map<number, number>;
  /** Indoor tiles claimed exclusively — rest spots and trip destinations, keyed
   *  `"x,y" → taskId`. The outdoor equivalent of `occupied`, and it exists for
   *  the same reason: without it two characters stand in the same armchair. */
  claims: Map<string, number>;
}

/** One roster entry the sim consumes — a townModel character plus its building. */
export interface RosterChar {
  taskId: number;
  agentName: string | null;
  state: PresenceState;
  live: boolean;
  buildingIndex: number;
  /** The agent's own last log line. Classified into an activity so a working
   *  character shows what it is working *on* rather than a generic desk pose —
   *  the app already carries this to the town and used to spend it on nothing
   *  but hover text. */
  lastLog?: string | null;
}

export interface StepOpts {
  reducedMotion?: boolean;
  /** True when the day/night phase says it is dark. Passed in rather than read
   *  from a clock so the sim stays pure and the behaviour is testable. */
  night?: boolean;
}

export function createSim(): SimState {
  return { chars: new Map(), occupied: new Map(), claims: new Map() };
}

/** Snap one character to "a valid resting position" (the spec's phrase): a
 *  worker to its desk seat, everyone else to its door. No path, no motion, no
 *  leisure claim. Shared by the reduced-motion tableau and settleSim so the two
 *  cannot drift apart. */
function snapToRest(c: CharAgent, world: TownWorld): void {
  const rest = indoorTarget(world, c) ?? homeTile(world, c.buildingIndex);
  c.pos = { x: rest.x, y: rest.y };
  c.path = [];
  c.moving = false;
  c.facing = "up";
  c.seated = c.intent === "work" && c.seat !== null;
  c.chore = null;
  c.spotId = null;
  c.spotVerb = null;
  c.spotKind = null;
  c.dwellMs = 0;
  c.chatMs = 0;
  c.chatWith = null;
  setPose(c, null);
}

/** Settle the sim in place: everyone at a resting tile, nothing walking, no
 *  spot claims — while KEEPING the population, their buildings and their desk
 *  seats. This is what becoming visible again calls for; the roster reconcile
 *  then happens on the next step.
 *
 *  Not createSim(): discarding the sim makes the next step re-spawn every
 *  character at its door, so restoring a hidden window sent the whole town
 *  walking home from the street (TIL-190). */
export function settleSim(sim: SimState, world: TownWorld): SimState {
  sim.occupied.clear();
  // Rest-spot claims survive: unlike a leisure spot, the tile a quiet character
  // is settled *on* is where it stays, so dropping the claim here would let the
  // next step hand the same sofa to somebody else. Trips in flight do not —
  // snapToRest cancels them, and the ledger has to say so at once rather than
  // wait for the next step to notice.
  for (const c of sim.chars.values()) snapToRest(c, world);
  reconcileClaims(sim);
  return sim;
}

/**
 * Make the indoor-claim ledger exactly what characters are holding.
 *
 * Derived rather than swept for dead owners. A despawn check is not enough: a
 * live character can stop holding something without despawning — settling the
 * sim on a visibility resume cancels a trip in flight, and the kettle it was
 * walking to stayed reserved by a character that still existed, so no
 * owner-based sweep ever collected it (Codex finding on 67114c2). Deriving the
 * ledger from the holders makes "a claim nobody holds" unrepresentable.
 */
function reconcileClaims(sim: SimState) {
  const held = new Set<string>();
  for (const c of sim.chars.values()) {
    if (c.chore) held.add(`${c.chore.tile.x},${c.chore.tile.y}`);
    if (c.restSpot) held.add(`${c.restSpot.x},${c.restSpot.y}`);
  }
  for (const key of sim.claims.keys()) {
    if (!held.has(key)) sim.claims.delete(key);
  }
}

/** End a chat, and start this character's cooldown. */
function endChat(c: CharAgent) {
  c.chatMs = 0;
  c.chatWith = null;
  c.chatCooldownMs = CHAT_COOLDOWN_MS;
}

/**
 * Light social: two idle characters who pass close stop, face each other and
 * chat briefly (spec v2c). Cosmetic — the bubble carries no dialogue, which is
 * an explicit non-goal; what it buys is that the town looks inhabited rather
 * than like independent agents on independent errands.
 *
 * O(n²) over the roster, which the spec calls trivial per frame and is: this
 * runs over at most a couple of dozen characters, so no spatial index.
 */
function stepChats(sim: SimState, dt: number) {
  for (const c of sim.chars.values()) {
    if (c.chatMs > 0) {
      // The other one may have despawned mid-chat (walked off the edge, dropped
      // from the roster). Without this the survivor stands paused for the rest
      // of the bubble holding a chatWith that points at nobody.
      if (c.chatWith === null || !sim.chars.has(c.chatWith)) {
        endChat(c);
        continue;
      }
      c.chatMs -= dt;
      if (c.chatMs <= 0) endChat(c);
    } else if (c.chatCooldownMs > 0) {
      c.chatCooldownMs = Math.max(0, c.chatCooldownMs - dt);
    }
  }

  // Who is available to be interrupted: an idler between waypoints, or anybody
  // standing at an object mid-trip — two workers meeting at the kettle, two
  // housemates in the kitchen of an evening. A character *walking* somewhere is
  // not (it has an errand), and one at a leisure spot is already doing something.
  //
  // Indoor chat is what makes several sessions on one project read as colleagues
  // rather than as parallel processes that happen to share an address.
  const free = [...sim.chars.values()].filter(
    (c) =>
      c.chatMs === 0 &&
      c.chatCooldownMs === 0 &&
      ((c.intent === "wander" && c.spotId === null) || (c.chore !== null && !c.moving)),
  );
  for (let i = 0; i < free.length; i++) {
    const a = free[i];
    if (a.chatMs > 0) continue; // paired earlier in this same pass
    for (let j = i + 1; j < free.length; j++) {
      const b = free[j];
      if (b.chatMs > 0) continue;
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      if (Math.hypot(dx, dy) > CHAT_RANGE) continue;
      for (const c of [a, b]) {
        c.chatMs = CHAT_MS;
        c.path = []; // stop where they are; they re-plan when the chat ends
        c.moving = false;
        c.wanderPauseMs = 0;
      }
      a.chatWith = b.taskId;
      b.chatWith = a.taskId;
      a.facing = facingOf(dx, dy, a.facing);
      b.facing = facingOf(-dx, -dy, b.facing);
      break; // one partner each
    }
  }
}

/** Release any leisure spot this character holds. */
function releaseSpot(sim: SimState, c: CharAgent) {
  if (c.spotId !== null) {
    sim.occupied.delete(c.spotId);
    c.spotId = null;
    c.spotVerb = null;
    c.spotKind = null;
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

/**
 * What presence means, physically.
 *
 * The one substantive change from v3: `working` and `quiet & not live` no longer
 * collapse together. A heartbeat is the whole difference between an agent that
 * is grinding and one that died an hour ago, and the town used to render both as
 * the same figure at the same desk.
 *
 * `night` only ever moves a *quiet* character — the session wins over the clock
 * (user decision, 2026-07-29), so a working agent is at its desk at 3am.
 */
function intentOf(state: PresenceState, live: boolean, night: boolean): Intent {
  if (state === "blocked") return "pace";
  if (state === "working") return "work";
  if (live && !night) return "wander"; // quiet but alive: out at the plaza
  return "rest"; // quiet and dead, or quiet and it is the middle of the night
}

/** The building door — a character's outside entry/rest tile. */
function homeTile(world: TownWorld, buildingIndex: number): Tile {
  const b = world.buildings[buildingIndex] ?? world.buildings[0];
  return b ? b.door : { x: 0, y: 0 };
}

/** Where a character that belongs indoors is heading right now: the trip it is
 *  on, else its desk seat / rest spot, else its assigned overflow tile (distinct
 *  per worker — see assignAnchors), else the door as a last resort. */
function indoorTarget(world: TownWorld, c: CharAgent): Tile | null {
  if (c.intent !== "work" && c.intent !== "rest") return null;
  if (c.chore) return c.chore.tile;
  return c.seat ?? c.restSpot ?? c.restTile ?? homeTile(world, c.buildingIndex);
}

/** What to draw over this character's head, from what it is actually doing.
 *  `logActivity` is its own last log line classified (null when it says nothing),
 *  and only ever applies while it is heads-down at its desk — a character
 *  walking to the kettle is making coffee whatever its log says. */
function activityOf(c: CharAgent, logActivity: Activity | null): Activity {
  if (c.intent === "off") return "leaving";
  if (c.chatMs > 0) return "chatting";
  if (c.intent === "pace") return "stuck";
  if (c.chore) return c.moving ? "walking" : VERB_ACTIVITY[c.chore.verb];
  if (c.moving) return "walking";
  if (c.intent === "work") return c.seated ? (logActivity ?? "typing") : "waiting";
  if (c.intent === "rest") return c.restKind === "bed" ? "sleeping" : "resting";
  // At a spot: what that spot is for. Every idle character used to read as
  // "resting" wherever it had walked to, so an afternoon at the pond and a
  // moment on a bench were the same word and the same glyph.
  if (c.spotId !== null) return c.spotVerb ? VERB_ACTIVITY[c.spotVerb] : "resting";
  return "walking";
}

/**
 * How this character is holding itself.
 *
 * Read off state that already exists rather than stored as a mode, so it cannot
 * drift out of step with the thing it describes: a character is sitting because it
 * is on its seat, not because something remembered to say so.
 */
function postureOf(c: CharAgent): Posture {
  if (c.moving || c.intent === "off" || c.intent === "pace" || c.chatMs > 0) return "stand";
  // A trip is to a counter, a whiteboard, a hob — things you stand at. The two you
  // would sit or lie on are excluded from the trip verbs by construction, because
  // getting up from the desk to go to bed is the exact picture CHORE_VERBS exists
  // to prevent.
  if (c.chore) return "stand";
  if (c.intent === "work") return c.seated ? "sit" : "stand";
  // Overflow (no sofa free) waits outside on its feet; everyone else is on the
  // furniture it claimed.
  if (c.intent === "rest") return !c.restSpot ? "stand" : c.restKind === "bed" ? "lie" : "sit";
  if (c.spotId !== null && c.spotKind) return spotPosture(c.spotKind);
  return "stand";
}

/** Recompute the visible pose — what it is doing, how it is holding itself, and
 *  which tile to draw it on. One place, so the three can never disagree. */
function setPose(c: CharAgent, logActivity: Activity | null): void {
  c.activity = activityOf(c, logActivity);
  c.posture = postureOf(c);
  // Only a character on its own sofa or bed is drawn off its tile: a hammock or a
  // bench *is* the tile it stands on, so those need no offset.
  c.onTile = c.intent === "rest" && c.posture !== "stand" ? c.restObject : null;
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

/** Drop every indoor claim this character holds (rest spot and trip target). */
function releaseClaims(sim: SimState, c: CharAgent) {
  for (const [key, id] of sim.claims) if (id === c.taskId) sim.claims.delete(key);
  c.restSpot = null;
  c.restKind = null;
  c.restObject = null;
  c.chore = null;
}

/** Claim an indoor tile for this character, if nobody else holds it. */
function claim(sim: SimState, c: CharAgent, t: Tile): boolean {
  const key = `${t.x},${t.y}`;
  const holder = sim.claims.get(key);
  if (holder !== undefined && holder !== c.taskId) return false;
  sim.claims.set(key, c.taskId);
  return true;
}

/**
 * Give every character that belongs indoors somewhere of its own to be —
 * *stickily*.
 *
 * A working character keeps the desk seat it already holds; only seatless ones
 * claim a free seat (lowest task id first, deterministic), so a worker already
 * sitting never moves when another session joins or leaves the same project (the
 * TIL-178 reshuffle bug). A resting character gets the same treatment over its
 * house's rest spots, preferring a bed at night and a sofa by day. Whoever is
 * past the count of either waits on a distinct tile outside (see
 * `nearbyRestTiles`) rather than stacking on the door.
 */
function assignAnchors(
  sim: SimState,
  world: TownWorld,
  byId: Map<number, RosterChar>,
  night: boolean,
) {
  // 1. Release anchors no longer valid (wrong intent, gone, or moved building),
  //    and collect who wants what, per building.
  const workByBuilding = new Map<number, number[]>();
  const restByBuilding = new Map<number, number[]>();
  /** Everyone with no anchor, pooled per building so step 4 can hand out
   *  distinct waiting tiles across BOTH kinds of overflow at once. */
  const overflowByBuilding = new Map<number, number[]>();
  for (const [id, c] of sim.chars) {
    const indoors = (c.intent === "work" || c.intent === "rest") && byId.has(id);
    if (!indoors) {
      c.seat = null;
      c.restTile = null;
      releaseClaims(sim, c);
      continue;
    }
    const b = world.buildings[c.buildingIndex];
    if (c.intent === "work") {
      if (c.restSpot) {
        releaseClaims(sim, c);
        c.path = [];
      }
      if (c.seat && !(b?.seats ?? []).some((s) => s.x === c.seat!.x && s.y === c.seat!.y)) {
        c.seat = null;
        c.path = [];
      }
      const list = workByBuilding.get(c.buildingIndex) ?? [];
      list.push(id);
      workByBuilding.set(c.buildingIndex, list);
    } else {
      if (c.seat) c.path = [];
      c.seat = null;
      const want = night ? "bed" : "sofa";
      // Give up a sofa when night falls, and a bed when morning comes — the
      // claim is on a *kind* of rest, not on a tile.
      const stillRight =
        c.restSpot &&
        (b?.restSpots ?? []).some(
          (r) => r.tile.x === c.restSpot!.x && r.tile.y === c.restSpot!.y && r.kind === want,
        );
      if (c.restSpot && !stillRight) {
        releaseClaims(sim, c);
        // …and drop the route to it. Keeping the path meant a character that
        // gave up the sofa at nightfall finished walking to the sofa anyway —
        // by then unclaimed, so another quiet agent could be settling on it —
        // before turning round for the bed (Codex finding on 67114c2).
        //
        // Guarded on actually HAVING a spot: an overflow rester has none, and
        // reading that as "your rest kind changed" cleared its path and re-ran
        // A* on every frame of its walk. It still arrived, so nothing
        // behavioural caught it — the cost was a pathfind per character per
        // frame (Codex re-verify of edcd04d).
        c.path = [];
      }
      const list = restByBuilding.get(c.buildingIndex) ?? [];
      list.push(id);
      restByBuilding.set(c.buildingIndex, list);
    }
  }

  // 2. Desk seats for the workers, sticky; the rest become overflow.
  for (const [buildingIndex, ids] of workByBuilding) {
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
    for (const id of overflow) overflowByBuilding.set(buildingIndex, [
      ...(overflowByBuilding.get(buildingIndex) ?? []),
      id,
    ]);
    for (const id of ids) {
      const c = sim.chars.get(id)!;
      if (c.seat) c.restTile = null;
    }
  }

  // 3. Sofas and beds for the quiet, preferred kind first then anything free.
  const want: "sofa" | "bed" = night ? "bed" : "sofa";
  for (const [buildingIndex, ids] of restByBuilding) {
    const spots = world.buildings[buildingIndex]?.restSpots ?? [];
    const preferred = spots.filter((s) => s.kind === want);
    const overflow: number[] = [];
    for (const id of [...ids].sort((a, b) => a - b)) {
      const c = sim.chars.get(id)!;
      if (c.restSpot) continue; // sticky — already settled somewhere valid
      const spot = preferred.find((s) => claim(sim, c, s.tile));
      if (spot) {
        c.restSpot = spot.tile;
        c.restKind = spot.kind;
        c.restObject = spot.object;
        c.restTile = null;
      } else {
        overflow.push(id);
      }
    }
    if (overflow.length) {
      overflowByBuilding.set(buildingIndex, [
        ...(overflowByBuilding.get(buildingIndex) ?? []),
        ...overflow,
      ]);
    }
  }

  // 4. Park everyone left over. Both passes above feed one pool per building, so
  //    the waiting tiles are handed out ONCE. Assigning them per pass meant the
  //    work overflow and the rest overflow each asked for "the nearest free
  //    tiles to the door" without telling the other, got the same answer, and
  //    settled on top of each other (Codex finding on 67114c2).
  for (const [buildingIndex, ids] of overflowByBuilding) {
    assignOverflow(sim, world, buildingIndex, [...ids].sort((a, b) => a - b));
  }
}

/** Park characters with no anchor on distinct tiles near their building. */
function assignOverflow(
  sim: SimState,
  world: TownWorld,
  buildingIndex: number,
  overflow: number[],
) {
  if (!overflow.length) return;
  const tiles = nearbyRestTiles(world, buildingIndex, overflow.length);
  overflow.forEach((id, i) => {
    const c = sim.chars.get(id)!;
    // Past some population the world simply runs out of walkable tiles near a
    // door and characters must share one — that part is physical, not a defect.
    // Cycling rather than clamping to the last tile is what keeps an unavoidable
    // pair from becoming a heap on one tile (Codex re-verify of edcd04d).
    const tile = tiles[i % tiles.length];
    // The pool is handed out in task-id order across BOTH kinds of overflow, so
    // a character joining later can take the tile someone was already walking
    // to. Moving that someone without dropping its route left it heading for a
    // tile now promised to another character — the sofa's stale-route defect one
    // layer down.
    if (c.restTile && (c.restTile.x !== tile.x || c.restTile.y !== tile.y)) c.path = [];
    c.restTile = tile;
  });
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
  const night = opts.night ?? false;
  const byId = new Map(roster.map((r) => [r.taskId, r]));
  // Leisure-spot tiles are off-limits to wanderers — only a spot's claimant
  // stands on it, so two bodies never share a spot.
  const spotTiles = new Set(world.spots.map((s) => `${s.tile.x},${s.tile.y}`));
  // A path predicate that routes around every spot tile except the destination,
  // so a character walking to its own spot (or home/edge) never transits — and
  // momentarily stands on — a spot another character is occupying.
  const avoidSpots = (target: Tile) => (x: number, y: number) =>
    spotTiles.has(`${x},${y}`) && !(x === target.x && y === target.y);
  // A house's interior is a cul-de-sac off the green: the doorway is its only
  // opening. Wanderers must never step into one — only a character heading to
  // *its own* desk, sofa or kettle goes in, via an explicit path. So wander's
  // random steps avoid every interior tile (and the doorway itself, which is
  // what actually seals the house), and a character standing inside when its
  // intent flips outward is first walked back out to the door.
  const interiorTiles = new Set(
    world.buildings.flatMap((b) => {
      const keys = [`${b.door.x},${b.door.y - 1}`]; // the front-wall gap
      for (let y = b.interior.y; y < b.interior.y + b.interior.h; y++) {
        for (let x = b.interior.x; x < b.interior.x + b.interior.w; x++) keys.push(`${x},${y}`);
      }
      return keys;
    }),
  );
  const insideKey = (t: Tile) => interiorTiles.has(`${t.x},${t.y}`);
  // Each agent's own account of what it is doing, classified once per step
  // rather than per character per frame.
  const logActivity = new Map<number, Activity | null>(
    roster.map((r) => [r.taskId, classifyLog(r.lastLog)]),
  );

  // --- Spawn newcomers at their building door. ---
  for (const r of roster) {
    if (sim.chars.has(r.taskId)) {
      const c = sim.chars.get(r.taskId)!;
      c.agentName = r.agentName;
      const newIntent = intentOf(r.state, r.live, night);
      // A changed intent (or building) invalidates the current path — drop it so
      // the new state is honoured next resolve, not after a stale walk finishes.
      if (newIntent !== c.intent || r.buildingIndex !== c.buildingIndex) {
        c.path = [];
        c.wanderPauseMs = 0;
        releaseSpot(sim, c);
        releaseClaims(sim, c);
        // Work does not wait on small talk: an intent change ends the chat.
        if (c.chatMs > 0) endChat(c);
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
      intent: intentOf(r.state, r.live, night),
      moving: false,
      wanderPauseMs: 0,
      spotId: null,
      spotVerb: null,
      spotKind: null,
      dwellMs: 0,
      seat: null,
      restTile: null,
      restSpot: null,
      restKind: null,
      restObject: null,
      chore: null,
      choreMs: CHORE_MIN_MS + rng() * CHORE_SPREAD_MS,
      choreDwellMs: 0,
      seated: false,
      activity: "walking",
      posture: "stand",
      onTile: null,
      chatMs: 0,
      chatWith: null,
      chatCooldownMs: 0,
    });
  }

  // Give everyone indoors a desk seat or a rest spot of its own.
  assignAnchors(sim, world, byId, night);

  // Safety net: drop leisure-spot claims held by characters that no longer
  // exist, so a missed release can never leave a spot permanently blocked.
  for (const [spotId, taskId] of sim.occupied) {
    if (!sim.chars.has(taskId)) sim.occupied.delete(spotId);
  }
  reconcileClaims(sim);

  // --- Reduced motion: still tableau. Snap everyone home, no motion. ---
  if (opts.reducedMotion) {
    sim.occupied.clear(); // nobody is out using a spot in the still tableau
    for (const [id, c] of sim.chars) {
      if (!byId.has(id)) {
        sim.chars.delete(id); // gone characters simply vanish (no walk-off)
        continue;
      }
      snapToRest(c, world);
    }
    // snapToRest cancels every trip in flight, so the ledger reconciled at the
    // top of this step is already out of date. Reconciling once per step and
    // then returning early through a branch that drops holdings is how the
    // "a claim nobody holds is unrepresentable" invariant became false again at
    // the API boundary (Codex re-verify of edcd04d).
    reconcileClaims(sim);
    return sim;
  }

  // --- Leavers walk off to the edge, then despawn. ---
  for (const [id, c] of sim.chars) {
    if (byId.has(id)) continue;
    if (c.intent !== "off") {
      c.intent = "off";
      releaseSpot(sim, c); // give up any spot on the way out
      releaseClaims(sim, c);
      c.seat = null;
      c.path = findPath(world, round(c.pos), world.edge, avoidSpots(world.edge)).slice(1);
      if (c.path.length === 0) sim.chars.delete(id); // already at edge / stuck
    }
  }

  // --- Light social: idle passers-by stop for a moment. Before the resolve
  // loop, so a chatting character is already standing still when it runs. ---
  stepChats(sim, dt);

  // --- Resolve intent → path, then integrate movement. ---
  for (const [id, c] of sim.chars) {
    // Mid-chat: stand still and keep facing the other one. Leaving (`off`) is
    // the exception — a despawning character must not be held up by a chat.
    if (c.chatMs > 0 && c.intent !== "off") {
      c.moving = false;
      // Posed before the `continue`, or a character that stopped to talk keeps
      // whatever it was doing a frame ago: the bubble said "talking" while the
      // tooltip still said "fishing".
      setPose(c, logActivity.get(id) ?? null);
      continue;
    }

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

    if (c.intent === "work" || c.intent === "rest") {
      // Where it is meant to be right now: mid-trip, that is the kettle; else
      // its desk seat / sofa, or its overflow tile if the house is full.
      const target = indoorTarget(world, c)!;
      if (c.path.length === 0) {
        if (!sameTile(here, target)) {
          const path = findPath(world, here, target, avoidSpots(target)).slice(1);
          if (path.length > 0) c.path = path;
          else if (c.chore) endChore(sim, c, rng); // unreachable — go back to work
        } else if (c.pos.x !== target.x || c.pos.y !== target.y) {
          // On the target tile but stopped mid-tile (e.g. path cleared by an
          // intent flip) — snap the residual float to the exact rest tile.
          c.pos = { x: target.x, y: target.y };
        } else if (c.chore) {
          // At the kettle: use it for a moment, then head back to the desk.
          c.choreDwellMs -= dt;
          if (c.choreDwellMs <= 0) endChore(sim, c, rng);
        } else if (c.intent === "work" && c.seat && sameTile(here, c.seat)) {
          // Heads-down. Count towards the next trip out.
          c.choreMs -= dt;
          if (c.choreMs <= 0) startChore(sim, world, c, rng);
        } else if (c.intent === "rest" && !night && c.restSpot && sameTile(here, c.restSpot)) {
          // An evening in. Same loop as the workday, over the house's leisure
          // objects — the television, the guitar, the stove, a book — so a quiet
          // agent is at home rather than merely parked on a sofa. Not at night:
          // then `intentOf` has already put it to bed, and the point of bed is
          // that nobody gets up from it.
          c.choreMs -= dt;
          if (c.choreMs <= 0) startChore(sim, world, c, rng);
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
              c.spotVerb = spot.verb;
              c.spotKind = spot.kind;
              // Long enough to be doing the thing: an afternoon's fishing is not
              // the same length as a glance at the notice board.
              c.dwellMs = SPOT_DWELL_MS[spot.verb] ?? DWELL_MS;
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
      // One axis per move.
      //
      // A path is a chain of orthogonal steps, so normally only one of the two
      // deltas is nonzero — which is what the old "axis-aligned segments"
      // shortcut of spending `budget` on both at once relied on. That assumption
      // holds right up until a path is replanned *mid-tile*: replanning starts
      // from `round(pos)`, so a character caught between tiles is off the lane
      // of its own first waypoint, both deltas are nonzero, and it then moved
      // diagonally at twice its walking speed, jittering (Codex re-verify of
      // 49a28f1). Latent for as long as an intent flip has been able to clear a
      // path mid-tile; reassigning waiting tiles made it reachable in ordinary
      // play. Closing the off-axis residual first puts the character back on its
      // lane and costs it the distance, like any other travel.
      while (budget > 0 && c.path.length > 0) {
        const next = c.path[0];
        const dx = next.x - c.pos.x;
        const dy = next.y - c.pos.y;
        if (dx === 0 && dy === 0) {
          c.path.shift();
          continue;
        }
        // Facing follows the direction of travel (the larger delta), not the
        // residual — otherwise closing a sliver turns the sprite for one frame.
        c.facing = facingOf(dx, dy, c.facing);
        const alongY = dy !== 0 && (dx === 0 || Math.abs(dy) <= Math.abs(dx));
        const delta = alongY ? dy : dx;
        const dist = Math.abs(delta);
        if (dist <= budget) {
          // Snap to the waypoint's coordinate on this axis rather than adding,
          // so repeated float arithmetic can never leave a residual behind.
          c.pos = alongY ? { x: c.pos.x, y: next.y } : { x: next.x, y: c.pos.y };
          budget -= dist;
          if (c.pos.x === next.x && c.pos.y === next.y) c.path.shift();
        } else {
          const step = delta > 0 ? budget : -budget;
          c.pos = alongY
            ? { x: c.pos.x, y: c.pos.y + step }
            : { x: c.pos.x + step, y: c.pos.y };
          budget = 0;
        }
      }
      if (c.path.length === 0) {
        c.moving = false;
        if (c.intent === "off") sim.chars.delete(id);
      }
    } else {
      c.moving = false;
      // Settled indoors → face up into the monitor / the room, and mark it
      // seated once it is actually on its seat (drives the typing animation and
      // tells the renderer to light that monitor).
      if (c.intent === "work" || c.intent === "rest") {
        c.facing = "up";
        c.seated = c.intent === "work" && c.seat !== null && sameTile(here, c.seat);
      } else {
        c.seated = false;
      }
    }

    setPose(c, logActivity.get(id) ?? null);
  }

  return sim;
}

/**
 * Send a working character out on a short trip.
 *
 * Anything in its own house with a verb other than "working" — the counter, the
 * sink, the table, the bookshelf — as long as nobody else has claimed the tile.
 * The claim is what stops two workers standing in the same kettle; it is
 * released by `endChore`, and by the despawn sweep if the session dies mid-trip.
 * With nothing free the character simply stays at its desk and tries again after
 * the next interval, which is the right answer for a crowded house.
 */
function startChore(sim: SimState, world: TownWorld, c: CharAgent, rng: () => number) {
  const leisure = c.intent === "rest";
  const verbs = leisure ? LEISURE_VERBS : CHORE_VERBS;
  const all = world.buildings[c.buildingIndex]?.affordances ?? [];
  const options = all.filter(
    (a: Affordance) => verbs.includes(a.verb) && !sim.claims.has(`${a.tile.x},${a.tile.y}`),
  );
  if (!options.length) {
    c.choreMs = choreDelay(leisure, rng);
    return;
  }
  const pick = options[Math.floor(rng() * options.length)];
  if (!claim(sim, c, pick.tile)) {
    c.choreMs = choreDelay(leisure, rng);
    return;
  }
  c.chore = { tile: pick.tile, verb: pick.verb };
  c.choreDwellMs = leisure ? LEISURE_DWELL_MS : CHORE_DWELL_MS;
}

/** How long until this character's next trip. An evening at home is more
 *  restless than a workday: heads-down work is *meant* to be mostly heads-down. */
function choreDelay(leisure: boolean, rng: () => number): number {
  return leisure
    ? LEISURE_MIN_MS + rng() * LEISURE_SPREAD_MS
    : CHORE_MIN_MS + rng() * CHORE_SPREAD_MS;
}

/** Finish a trip: give the object back and start counting to the next one. */
function endChore(sim: SimState, c: CharAgent, rng: () => number) {
  if (c.chore) sim.claims.delete(`${c.chore.tile.x},${c.chore.tile.y}`);
  c.chore = null;
  c.choreDwellMs = 0;
  c.choreMs = choreDelay(c.intent === "rest", rng);
}
