// The town as a tree of places, not a grid of booleans.
//
// `buildWorld` produces walkability: row-major `blocked` / `road` / `yard` /
// `path` masks that answer "can I stand here". That is everything the renderer
// and the pathfinder need and nothing a *character* needs — with only the masks,
// nothing in the town has a name, so the most an agent can be said to be doing
// is "wandering". Generative Agents (Park et al. 2023) models its world as
// world → areas → objects and converts that tree to natural language for the
// agent to reason over; this is the same shape, built from the declarations
// `buildWorld` already makes (building rooms, furniture, spots, props) rather
// than invented alongside them.
//
// Deliberately derived, never authored twice: every node here points at data
// that already exists on TownWorld. If the floor plan changes, the tree changes
// with it — there is no second copy to forget.

import type {
  BuildingPlacement,
  Furniture,
  LeisureSpot,
  Rect,
  Tile,
  TownProp,
  TownWorld,
} from "./world";
import { inRect } from "./world";

export type PlaceKind = "world" | "area" | "room" | "object";

export interface TownPlace {
  /** Stable path-like id: "town", "town/commons", "town/tildone/kitchen". */
  id: string;
  kind: PlaceKind;
  /** What to call it in prose — "the kitchen", "a bench", "Tildone's house". */
  name: string;
  /** The ground it covers. An object covers exactly its own tile. */
  rect: Rect;
  children: TownPlace[];
}

const at = (t: Tile): Rect => ({ x: t.x, y: t.y, w: 1, h: 1 });

/** Article-free, lower-case names for the things a house holds. */
const FURNITURE_NAME: Record<Furniture["kind"], string> = {
  desk: "a desk",
  counter: "the counter",
  sink: "the sink",
  table: "the table",
  chair: "a chair",
  sofa: "the sofa",
  bookshelf: "the bookshelf",
  bed: "the bed",
  nightstand: "the nightstand",
  rug: "the rug",
  plant: "a plant",
};

const SPOT_NAME: Record<LeisureSpot["kind"], string> = {
  bench: "a bench",
  pond: "the pond",
  campfire: "the campfire",
  garden: "the garden",
};

const PROP_NAME: Record<TownProp["kind"], string> = {
  planter: "a planter",
  noticeboard: "the notice board",
  market: "the market stall",
  coffeecart: "the coffee cart",
  cafetable: "a cafe table",
};

/** A slug that survives a project being renamed to something punctuation-heavy. */
function slug(name: string, fallback: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || fallback;
}

function house(b: BuildingPlacement, index: number): TownPlace {
  const id = `town/${slug(b.room.name, `building-${index}`)}`;
  const rooms: TownPlace[] = b.rooms.map((r) => ({
    id: `${id}/${r.kind}`,
    kind: "room" as const,
    name: r.name,
    rect: r.rect,
    children: [] as TownPlace[],
  }));
  const byKind = new Map(rooms.map((r, i) => [b.rooms[i].kind, r]));

  // Furniture hangs off the room it stands in — that link is what lets a plan
  // name a real affordance ("the counter, in the kitchen") instead of a tile.
  // Anything the rects do not cover still belongs to the house, never nowhere.
  const loose: TownPlace[] = [];
  for (const f of b.furniture) {
    const parent = f.room ? byKind.get(f.room) : undefined;
    const node: TownPlace = {
      id: `${parent?.id ?? id}/${f.kind}@${f.tile.x},${f.tile.y}`,
      kind: "object",
      name: FURNITURE_NAME[f.kind],
      rect: at(f.tile),
      children: [],
    };
    (parent?.children ?? loose).push(node);
  }

  const yard: TownPlace = {
    id: `${id}/yard`,
    kind: "area",
    name: "the yard",
    rect: b.lot,
    children: [
      { id: `${id}/yard/gate`, kind: "object", name: "the gate", rect: at(b.gate), children: [] },
      { id: `${id}/yard/door`, kind: "object", name: "the front door", rect: at(b.door), children: [] },
    ],
  };

  // The yard is listed first so the more specific rooms, which sit inside the
  // footprint inside the lot, win the deepest-match lookup.
  return {
    id,
    kind: "area",
    name: `${b.room.name}'s house`,
    rect: b.lot,
    children: [yard, ...rooms, ...loose],
  };
}

function commons(world: TownWorld): TownPlace {
  const id = "town/commons";
  const children: TownPlace[] = [];
  if (world.plazaCenter) {
    children.push({
      id: `${id}/fountain`,
      kind: "object",
      name: "the fountain",
      rect: at(world.plazaCenter),
      children: [],
    });
  }
  for (const s of world.spots) {
    if (!inRect(world.plaza, s.tile)) continue;
    children.push({
      id: `${id}/${s.kind}-${s.id}`,
      kind: "object",
      name: SPOT_NAME[s.kind],
      rect: at(s.tile),
      children: [],
    });
  }
  for (const p of world.props) {
    if (!inRect(world.plaza, p.tile)) continue;
    children.push({
      id: `${id}/${p.kind}@${p.tile.x},${p.tile.y}`,
      kind: "object",
      name: PROP_NAME[p.kind],
      rect: at(p.tile),
      children: [],
    });
  }
  return { id, kind: "area", name: "the commons", rect: world.plaza, children };
}

/** Everything outside the lots and the square: the shared ground, and the
 *  pond / campfire / garden that sit on it. */
function green(world: TownWorld): TownPlace {
  const id = "town/green";
  const children: TownPlace[] = world.spots
    .filter((s) => !inRect(world.plaza, s.tile))
    .map((s) => ({
      id: `${id}/${s.kind}-${s.id}`,
      kind: "object" as const,
      name: SPOT_NAME[s.kind],
      rect: at(s.tile),
      children: [] as TownPlace[],
    }));
  return {
    id,
    kind: "area",
    name: "the green",
    rect: { x: 0, y: 0, w: world.cols, h: world.rows },
    children,
  };
}

/**
 * The whole town as one tree: world → areas → rooms → objects.
 *
 * Order matters for lookups. `placeAt` takes the deepest *last* match, and the
 * green covers the entire map, so it is listed first and every more specific
 * area after it.
 */
export function buildPlaces(world: TownWorld): TownPlace {
  return {
    id: "town",
    kind: "world",
    name: "the town",
    rect: { x: 0, y: 0, w: world.cols, h: world.rows },
    children: [green(world), commons(world), ...world.buildings.map(house)],
  };
}

/**
 * The chain of places containing `tile`, outermost first — e.g.
 * `[the town, Tildone's house, the kitchen, the counter]`. Empty when the tile
 * is off the map.
 */
export function placePath(root: TownPlace, tile: Tile): TownPlace[] {
  if (!inRect(root.rect, tile)) return [];
  const chain = [root];
  let node = root;
  for (;;) {
    // Last match wins: children are ordered general → specific, so a room
    // beats the lot it sits in and an object beats its room.
    let next: TownPlace | undefined;
    for (const c of node.children) if (inRect(c.rect, tile)) next = c;
    if (!next) return chain;
    chain.push(next);
    node = next;
  }
}

/** The most specific place containing `tile`, or null when it is off the map. */
export function placeAt(root: TownPlace, tile: Tile): TownPlace | null {
  const chain = placePath(root, tile);
  return chain.length ? chain[chain.length - 1] : null;
}

/**
 * Where something is, in words: "at the counter, in the kitchen, at Tildone's
 * house". Objects read as "at X", areas and rooms as "in X"; the town itself is
 * dropped — every answer would end with it.
 */
export function describePlace(root: TownPlace, tile: Tile): string {
  const chain = placePath(root, tile).filter((p) => p.kind !== "world");
  if (!chain.length) return "the town";
  return chain
    .reverse()
    .map((p) => `${p.kind === "object" ? "at" : "in"} ${p.name}`)
    .join(", ");
}
