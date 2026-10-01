import type { TownCharacter, TownModel } from "../selectors";
import type { Environment } from "../types";
import {
  cellOrigin,
  ISLAND_SIZE,
  townLayout,
  type BuildingPlan,
  type BuildingStyle,
  type Cell,
  type FloorUse,
  type IslandPlan,
  type Place,
  type Underside,
  type Weather,
} from "./layout";

// The Town as a flat list of draw items, built from the roster and a palette: the
// port of the approved mockup's props, biomes, buildings, square and bridges
// (docs/artifacts/2026-10-01-town-redesign.html, layout B). No DOM: renderer.ts
// paints the items, sorted here by layer then depth (painter's order).

// ---------- palette and colour ----------

export interface Palette {
  night: boolean;
  sky: [string, string, string];
  orb: string;
  cloud: string;
  sea: string;
  paper: string;
  wood: string;
  woodDark: string;
  floor: string;
  stone: string;
  water: string;
  ice: string;
  leaf: string;
  leaf2: string;
  pine: string;
  bloom: string;
  trunk: string;
  brick: string;
  glass: string;
  lit: string;
  smoke: string;
  rug: string;
  metal: string;
  snow: string;
  labelBg: string;
  ink: string;
  muted: string;
  line: string;
  doing: string;
  danger: string;
  faint: string;
  shadowAlpha: number;
  notes: [string, string, string, string];
}

/** Day palette for the light theme, night palette for the dark one. */
export function townPalette(dark: boolean): Palette {
  return dark
    ? {
        night: true,
        sky: ["#070b1c", "#1a1838", "#3a2c55"],
        orb: "#f3efdc",
        cloud: "rgba(150,150,210,.13)",
        sea: "rgba(70,64,120,.55)",
        paper: "#b8ab97",
        wood: "#86603f",
        woodDark: "#5a3f2c",
        floor: "#6c5845",
        stone: "#77736c",
        water: "#2f6f99",
        ice: "#7f9db5",
        leaf: "#3c7340",
        leaf2: "#4d8a4b",
        pine: "#2b6243",
        bloom: "#a8607d",
        trunk: "#56402f",
        brick: "#7a4535",
        glass: "#26324d",
        lit: "#ffcf73",
        smoke: "rgba(190,190,215,.3)",
        rug: "#3b3552",
        metal: "#55555e",
        snow: "#cfd8e6",
        labelBg: "#252525",
        ink: "#e8e8e6",
        muted: "#9b9a97",
        line: "#454545",
        doing: "#ffa344",
        danger: "#ff7369",
        faint: "#6f6e69",
        shadowAlpha: 0.34,
        notes: ["#d9b84f", "#d98aa0", "#7fa9d6", "#8fc27f"],
      }
    : {
        night: false,
        sky: ["#bfe0f4", "#e4eff3", "#f8efe2"],
        orb: "#fff3cf",
        cloud: "rgba(255,255,255,.92)",
        sea: "rgba(255,255,255,.95)",
        paper: "#efe5d3",
        wood: "#c48b58",
        woodDark: "#8f5f3d",
        floor: "#e9d2ad",
        stone: "#dcd6cc",
        water: "#73c2ea",
        ice: "#d3ecf8",
        leaf: "#5aab55",
        leaf2: "#7cc566",
        pine: "#3d8c58",
        bloom: "#f4a6c2",
        trunk: "#8a6347",
        brick: "#bd6a4f",
        glass: "#cfe7f3",
        lit: "#ffe3a3",
        smoke: "rgba(110,110,125,.32)",
        rug: "#e6ddf4",
        metal: "#6a6a74",
        snow: "#ffffff",
        labelBg: "#ffffff",
        ink: "#37352f",
        muted: "#787671",
        line: "#d9d5cf",
        doing: "#dd5b00",
        danger: "#e03131",
        faint: "#a4a097",
        shadowAlpha: 0.15,
        notes: ["#ffe27a", "#ffb3c7", "#a8d4ff", "#b9eea8"],
      };
}

function rgb(color: string): number[] {
  const hex = color.length === 4 ? "#" + [...color.slice(1)].map((c) => c + c).join("") : color;
  return (hex.slice(1, 7).match(/../g) ?? ["00", "00", "00"]).map((h) => parseInt(h, 16));
}

/** Blend two #rgb / #rrggbb colours; t = 0 is `a`, 1 is `b`. */
export function mix(a: string, b: string, t: number): string {
  const from = rgb(a);
  const to = rgb(b);
  return "#" + from.map((v, i) => Math.round(v + (to[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

/** Darken (negative) or lighten (positive) a colour. */
export function shade(color: string, amount: number): string {
  return amount < 0 ? mix(color, "#000000", -amount) : mix(color, "#ffffff", amount);
}

/** A daylight colour as it reads at night (pulled toward the night sky). */
export function tint(palette: Palette, color: string): string {
  return palette.night ? mix(color, "#151433", 0.42) : color;
}

export function hash(text: string): number {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

/** A seeded xorshift generator in [0, 1): the same seed draws the same scenery. */
export function rng(seed: number): () => number {
  let s = Math.imul(seed + 1, 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

// ---------- items ----------

export type Face = "L" | "R";
export type Texture = "grass" | "tiles" | "sand" | "snow" | "leaves" | "planks" | "water" | "ice";
export type Side = "strata" | "siding" | "logs" | "brick" | "plaster";
export type TreeKind =
  | "round"
  | "pine"
  | "bloom"
  | "planter"
  | "palm"
  | "cactus"
  | "snowpine"
  | "orange"
  | "red"
  | "gold";
/** [x, y, z, w, d, h] in world units. */
export type Bounds = [number, number, number, number, number, number];

/** Something painted flat on a box's front-left (L) or front-right (R) face, in
 *  face units: u along the face, z up from the box's base. */
interface FacePatch {
  face: Face;
  u: number;
  z: number;
  w: number;
  h: number;
}

export type Deco =
  | { kind: "band"; face: Face; z: number; h: number; color: string }
  | { kind: "curtain"; face: Face }
  | (FacePatch & {
      kind: "window";
      lit: boolean;
      style: BuildingStyle;
      /** A working agent seen at its desk through the window. */
      worker?: TownCharacter | null;
      /** A quiet agent seen dozing on the lounge couch. */
      sleeper?: TownCharacter | null;
    })
  | (FacePatch & { kind: "pane" })
  | (FacePatch & { kind: "picture"; warn?: boolean; color: string })
  | (FacePatch & { kind: "clock" })
  | (FacePatch & { kind: "screen"; color: string })
  | (FacePatch & { kind: "door"; style: BuildingStyle })
  | (FacePatch & { kind: "sign"; text: string; style: BuildingStyle })
  | (FacePatch & { kind: "board"; notes: string[]; title: string })
  | (FacePatch & { kind: "books" })
  | { kind: "logo"; color: string }
  | { kind: "leds" }
  | { kind: "net" };

/** A box the renderer can paint, either a scene item or one it composes on the fly. */
export interface BoxShape {
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
  color: string;
  texture?: Texture;
  side?: Side;
  /** Lies flat: no top edge highlight, casts no shadow. */
  flat?: boolean;
  decos?: Deco[] | null;
  /** Texture specks [u, v, k] in box units, seeded by prepare(). */
  specks?: number[][];
  /** Rock strata marks, seeded by prepare(). */
  strata?: number[][];
  /** The project colour a door or band takes. */
  projectColor?: string;
  /** Lit from inside: doors glow at night. */
  lit?: boolean;
  seed: number;
}

export interface Shadow {
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  z: number;
}

interface ItemBase {
  layer: number;
  /** The island the item belongs to; it fades when another island is focused. */
  group?: Place;
  /** Items between islands (bridges, drones) stay visible when either end is focused. */
  groups?: Place[];
  /** On an island with no agents: drawn at reduced alpha. */
  dim?: boolean;
  /** Overrides the computed depth inside a layer. */
  depthOverride?: number;
  /** Set by prepare(). */
  seed: number;
  depth: number;
  bounds: Bounds;
  shadow?: Shadow;
}

export type BoxItem = ItemBase & Omit<BoxShape, "seed"> & { kind: "box"; ground?: boolean };

export interface BuildingItem extends ItemBase {
  kind: "building";
  projectId: number;
  name: string;
  color: string;
  x: number;
  y: number;
  w: number;
  d: number;
  floors: number;
  floorHeight: number;
  style: BuildingStyle;
  material?: Side;
  wallColor: string;
  uses: FloorUse[];
  lit: boolean;
  /** Has a working agent: the chimney smokes. */
  active: boolean;
  /** What stands on each storey, shown when the building is cut open. */
  contents: Item[][];
  /** The two inner walls of each storey (back = L, left = R). */
  innerWalls: { L: Deco[]; R: Deco[] }[];
  /** Windows, door and sign on each storey's outside walls. */
  shell: Deco[][];
}

export interface AgentItem extends ItemBase {
  kind: "agent";
  x: number;
  y: number;
  z: number;
  character: TownCharacter;
  pose: "sit" | "stand";
  /** Sits at a desk: legs hidden behind it, screen glow on the face. */
  desk?: boolean;
  /** Sways side to side by this much (blocked agents waiting at the door). */
  pace?: number;
  color: string;
}

export interface LabelItem extends ItemBase {
  kind: "label";
  x: number;
  y: number;
  /** The project's island, or null for the town square's chip. */
  projectId: number | null;
  name: string;
  color: string;
  counts: { working: number; blocked: number; quiet: number };
  open: number;
  /** Height the chip floats over when there is no building (the square). */
  baseZ: number;
  floors: number;
}

interface Spot {
  x: number;
  y: number;
}

export type Item =
  | BoxItem
  | BuildingItem
  | AgentItem
  | LabelItem
  | (ItemBase & Spot & { kind: "tree"; variety: TreeKind; scale: number; phase: number })
  | (ItemBase & Spot & { kind: "lamp"; height: number; modern?: boolean; indoor?: boolean })
  | (ItemBase & Spot & { kind: "plant" })
  | (ItemBase & Spot & { kind: "fountain" })
  | (ItemBase & Spot & { kind: "car"; color: string })
  | (ItemBase & Spot & { kind: "snowman"; color: string })
  | (ItemBase & Spot & { kind: "pumpkin" })
  | (ItemBase & Spot & { kind: "flag"; color: string; height: number; phase: number })
  | (ItemBase & Spot & { kind: "steam"; z: number })
  | (ItemBase & Spot & { kind: "fall"; z: number; width: number; length: number })
  | (ItemBase & Spot & { kind: "hang"; variety: Underside; size: number; pattern: number })
  | (ItemBase & Spot & { kind: "weather"; variety: Weather; size: number; pattern: number })
  /** Helper bot on a floor: decoration, never an agent. */
  | (ItemBase & { kind: "bot"; use: FloorUse; x0: number; x1: number; y: number; color: string; phase: number })
  /** Delivery drone between an island and the square: decoration. */
  | (ItemBase & Spot & { kind: "drone"; x2: number; y2: number; color: string; phase: number });

/** Bots and drones: hidden by "Agents only", never hit-tested, never a bubble. */
export function isHelper(item: Item): boolean {
  return item.kind === "bot" || item.kind === "drone";
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type FreshItem = DistributiveOmit<Item, "seed" | "depth" | "bounds">;

/** Group tags spread onto every item of one island. */
interface Tag {
  group?: Place;
  groups?: Place[];
  dim?: boolean;
}

const NO_BOUNDS: Bounds = [0, 0, 0, 0, 0, 0];

function add(list: Item[], fields: FreshItem): void {
  list.push({ ...fields, seed: 0, depth: 0, bounds: NO_BOUNDS } as Item);
}

type BoxFields = Omit<BoxItem, "kind" | "seed" | "depth" | "bounds" | "z" | "layer"> & { z?: number; layer?: number };

function box(list: Item[], fields: BoxFields): void {
  add(list, { kind: "box", z: 0, layer: 1, ...fields });
}

// ---------- environments ----------

interface GroundColors {
  top: string;
  lip: string;
  rock: [string, string, string, string];
}

const CITY_ROCK: GroundColors["rock"] = ["#a19c94", "#8a857d", "#76726b", "#625e58"];

const BIOME_COLORS: Record<Environment, GroundColors> = {
  meadow: { top: "#9bd07a", lip: "#5f9d4f", rock: ["#c79b6c", "#a8835f", "#8d6b4f", "#715541"] },
  city: { top: "#d8d4cc", lip: "#a29d94", rock: CITY_ROCK },
  desert: { top: "#efd39a", lip: "#d3a964", rock: ["#dc9d5f", "#c7844b", "#af6c3b", "#95582f"] },
  snow: { top: "#f3f7fb", lip: "#d3e1ee", rock: ["#9aa3ad", "#858e99", "#717a85", "#5f6670"] },
  autumn: { top: "#c7b46c", lip: "#8d7a3f", rock: ["#8b6a4c", "#76583f", "#624834", "#4f3a2b"] },
};

const SQUARE_GROUND: GroundColors = { top: "#e7dfcf", lip: "#b9ab93", rock: CITY_ROCK };

const BUILDING_SHAPES: Record<BuildingStyle, { w: number; d: number; wall: string; material?: Side }> = {
  cottage: { w: 4, d: 3.6, wall: "#f4ecdd", material: "siding" },
  tower: { w: 3.6, d: 3.6, wall: "#a9c9de" },
  adobe: { w: 4, d: 3.4, wall: "#e2b585", material: "plaster" },
  chalet: { w: 3.8, d: 3.2, wall: "#8d5d3c", material: "logs" },
  brick: { w: 3.6, d: 3.4, wall: "#b65a40", material: "brick" },
};

const FLOOR_HEIGHT = 1.5;
const INBOX_COLOR = "#787671";

// ---------- props ----------

function tree(list: Item[], x: number, y: number, tag: Tag, seed: number, variety: TreeKind): void {
  const r = rng(seed);
  add(list, { kind: "tree", x, y, variety, scale: 0.85 + r() * 0.35, phase: r() * 6, layer: 1, ...tag });
}

function lamp(list: Item[], x: number, y: number, height: number, tag: Tag, modern: boolean): void {
  add(list, { kind: "lamp", x, y, height, modern, layer: 1, ...tag });
}

function plant(list: Item[], x: number, y: number, tag: Tag): void {
  add(list, { kind: "plant", x, y, layer: 1, ...tag });
}

function seated(list: Item[], x: number, y: number, z: number, character: TownCharacter, color: string, tag: Tag): void {
  add(list, { kind: "agent", x, y, z, character, pose: "sit", color, layer: 1, ...tag });
}

/** A garden bench; two agents sit, any more stand beside it. */
function bench(list: Item[], x: number, y: number, agents: TownCharacter[], color: string, p: Palette, tag: Tag): void {
  const depth = x + y + 0.75;
  box(list, { x: x + 0.1, y: y + 0.15, w: 0.08, d: 0.3, h: 0.25, color: p.woodDark, depthOverride: depth - 0.5, ...tag });
  box(list, { x: x + 1.32, y: y + 0.15, w: 0.08, d: 0.3, h: 0.25, color: p.woodDark, depthOverride: depth - 0.5, ...tag });
  box(list, { x, y: y + 0.1, z: 0.25, w: 1.5, d: 0.4, h: 0.06, color: p.wood, depthOverride: depth - 0.4, ...tag });
  box(list, { x, y, z: 0.31, w: 1.5, d: 0.08, h: 0.36, color: p.wood, depthOverride: depth - 0.6, ...tag });
  agents.forEach((character, i) => {
    if (i < 2) seated(list, x + 0.4 + i * 0.7, y + 0.38, 0.31, character, color, tag);
    else add(list, { kind: "agent", x: x + 1.9 + (i - 2) * 0.6, y: y + 0.5, z: 0, character, pose: "stand", color, layer: 1, ...tag });
  });
}

/** A notice board with one sticky note per open task (up to 15). */
function board(list: Item[], x: number, y: number, seedName: string, open: number, p: Palette, tag: Tag = {}): void {
  const r = rng(hash(seedName) + 7);
  const notes = Array.from({ length: Math.min(open, 15) }, () => p.notes[Math.floor(r() * 4)]);
  box(list, { x: x + 0.1, y, w: 0.05, d: 0.05, h: 0.4, color: p.metal, ...tag });
  box(list, { x: x + 1.25, y, w: 0.05, d: 0.05, h: 0.4, color: p.metal, ...tag });
  box(list, {
    x,
    y,
    z: 0.35,
    w: 1.4,
    d: 0.06,
    h: 0.9,
    color: p.metal,
    decos: [{ kind: "board", face: "L", u: 0.06, z: 0.06, w: 1.28, h: 0.78, notes, title: `${open} open` }],
    ...tag,
  });
}

function workDesk(list: Item[], sx: number, sy: number, character: TownCharacter | null, color: string, p: Palette): void {
  const depth = sx + 0.65 + sy - 0.25;
  box(list, { x: sx + 0.05, y: sy + 0.05, w: 0.06, d: 0.5, h: 0.5, color: p.woodDark });
  box(list, { x: sx + 1.19, y: sy + 0.05, w: 0.06, d: 0.5, h: 0.5, color: p.woodDark });
  box(list, { x: sx, y: sy, z: 0.5, w: 1.3, d: 0.6, h: 0.06, color: p.wood });
  box(list, { x: sx + 0.4, y: sy + 0.15, z: 0.56, w: 0.5, d: 0.32, h: 0.03, color: "#cfd0d6", flat: true });
  box(list, { x: sx + 0.4, y: sy + 0.1, z: 0.59, w: 0.5, d: 0.04, h: 0.32, color: "#c4c6cd", decos: [{ kind: "logo", color }] });
  box(list, { x: sx + 1.05, y: sy + 0.36, z: 0.56, w: 0.08, d: 0.08, h: 0.1, color: "#efe9de" });
  box(list, { x: sx + 0.45, y: sy - 0.45, z: 0.3, w: 0.4, d: 0.38, h: 0.06, color: "#4a4a54", depthOverride: depth - 0.02 });
  box(list, { x: sx + 0.62, y: sy - 0.3, w: 0.06, d: 0.06, h: 0.3, color: "#4a4a54", depthOverride: depth - 0.03 });
  box(list, { x: sx + 0.45, y: sy - 0.55, z: 0.36, w: 0.4, d: 0.06, h: 0.48, color: "#4a4a54" });
  if (character) add(list, { kind: "agent", x: sx + 0.65, y: sy - 0.25, z: 0.36, character, pose: "sit", desk: true, color, layer: 1 });
}

function couch(list: Item[], x: number, y: number, color: string, p: Palette, agents: TownCharacter[]): void {
  const c = mix(p.rug, color, 0.45);
  agents.forEach((character, i) => seated(list, x + 0.45 + i * 0.65, y + 0.5, 0.3, character, color, {}));
  box(list, { x, y, w: 2.2, d: 0.75, h: 0.3, color: c, depthOverride: x + y + 0.5 });
  box(list, { x, y, z: 0.3, w: 2.2, d: 0.22, h: 0.45, color: shade(c, -0.06), depthOverride: x + y + 0.3 });
  box(list, { x, y: y + 0.22, z: 0.3, w: 0.22, d: 0.53, h: 0.22, color: shade(c, -0.04), depthOverride: x + y + 0.6 });
  box(list, { x: x + 1.98, y: y + 0.22, z: 0.3, w: 0.22, d: 0.53, h: 0.22, color: shade(c, -0.04) });
  box(list, { x: x + 0.6, y: y + 1.15, w: 1, d: 0.5, h: 0.26, color: p.woodDark });
  box(list, { x: x + 1.2, y: y + 1.3, z: 0.26, w: 0.1, d: 0.1, h: 0.12, color: "#efe9de" });
  add(list, { kind: "steam", x: x + 1.25, y: y + 1.35, z: 0.4, layer: 2 });
}

// ---------- buildings ----------

interface Footprint {
  x: number;
  y: number;
  w: number;
  d: number;
  floors: number;
}

/** What stands on one storey of a building, by the storey's use. */
function floorContents(b: Footprint, floor: number, use: FloorUse, plan: BuildingPlan, color: string, seedName: string, p: Palette): Item[] {
  const list: Item[] = [];
  const { x, y, w, d } = b;
  const x1 = x + w;
  const y1 = y + d;
  const desks = plan.desks.filter((s) => s.floor === floor);
  add(list, {
    kind: "bot",
    use,
    x0: x + 0.5,
    x1: x1 - 0.7,
    y: use === "lounge" ? y + d * 0.74 : y1 - 0.35,
    color,
    phase: (floor * 0.37 + x * 0.13) % 1,
    layer: 1,
  });
  if (use !== "desks") for (const s of desks) workDesk(list, s.side ? x1 - 1.75 : x + 0.45, y1 - 1.25, s.character, color, p);
  if (use === "desks") {
    box(list, { x: x + 0.3, y: y1 - 1.75, w: w - 0.6, d: 1.45, h: 0.02, color: mix(p.rug, color, 0.22), flat: true, layer: 0.4 });
    for (const side of [0, 1]) {
      const slot = desks.find((s) => s.side === side);
      workDesk(list, side ? x1 - 1.75 : x + 0.45, y1 - 1.25, slot?.character ?? null, color, p);
    }
    box(list, {
      x: x + 0.18,
      y: y + 0.16,
      w: 1.3,
      d: 0.35,
      h: 1.15,
      color: p.woodDark,
      decos: [{ kind: "books", face: "L", u: 0.06, z: 0.08, w: 1.18, h: 1.0 }],
    });
    plant(list, x1 - 0.6, y + 0.3, {});
    if (b.floors === 1) board(list, x + 1.7, y + 0.45, seedName, 0, p);
  } else if (use === "meeting") {
    box(list, { x: x + 0.5, y: y + 1.2, w: w - 1.6, d: 1.0, h: 0.5, color: p.wood });
    for (let k = 0; k < 3; k++) {
      box(list, { x: x + 0.75 + k * 0.8, y: y + 0.85, w: 0.35, d: 0.3, h: 0.32, color: "#4a4a54" });
      if (!desks.length) box(list, { x: x + 0.75 + k * 0.8, y: y + 2.3, w: 0.35, d: 0.3, h: 0.32, color: "#4a4a54" });
    }
    for (let k = 0; k < 3; k++) {
      box(list, { x: x + 0.8 + k * 0.8, y: y + 1.35, z: 0.5, w: 0.32, d: 0.24, h: 0.02, color: "#c4c6cd", flat: true });
      box(list, { x: x + 0.8 + k * 0.8, y: y + 1.33, z: 0.52, w: 0.32, d: 0.03, h: 0.2, color: "#aeb1b9" });
    }
    board(list, x1 - 1.55, y1 - 0.5, seedName, 0, p);
    plant(list, x + 0.25, y1 - 0.6, {});
  } else if (use === "lounge") {
    box(list, { x: x + 0.4, y: y + 0.6, w: w - 0.9, d: d - 1.1, h: 0.02, color: mix(p.rug, color, 0.25), flat: true, layer: 0.4 });
    couch(list, x + 0.8, y + 0.55, color, p, plan.couch);
    box(list, { x: x1 - 0.65, y: y + 1.75, w: 0.5, d: 0.95, h: 0.62, color: p.woodDark, side: "siding" });
    box(list, { x: x1 - 0.6, y: y + 1.85, z: 0.62, w: 0.36, d: 0.3, h: 0.36, color: "#2b2d35" });
    box(list, { x: x1 - 0.56, y: y + 2.35, z: 0.62, w: 0.13, d: 0.13, h: 0.1, color: "#efe9de" });
    add(list, { kind: "steam", x: x1 - 0.42, y: y + 2.0, z: 0.98, layer: 2 });
    add(list, { kind: "lamp", x: x + 0.35, y: y + 0.4, height: 1.0, indoor: true, layer: 1 });
    plant(list, x1 - 0.6, y1 - 0.6, {});
    plant(list, x + 0.3, y1 - 0.6, {});
  } else {
    for (let k = 0; k < 3; k++) {
      box(list, { x: x + 0.3 + k * 0.75, y: y + 0.22, w: 0.6, d: 0.55, h: 1.25, color: "#2b2d35", decos: [{ kind: "leds" }] });
    }
    box(list, { x: x1 - 2.0, y: y + 1.4, w: 1.7, d: 0.9, h: 0.45, color: "#2f7d5b", decos: [{ kind: "net" }] });
  }
  return list;
}

type WallPatch =
  | (Omit<FacePatch, "face"> & { kind: "pane" | "clock" })
  | (Omit<FacePatch, "face"> & { kind: "picture"; warn?: boolean })
  | (Omit<FacePatch, "face"> & { kind: "screen" });

/** What hangs on a storey's two visible inner walls, by use: back wall (L) and left wall (R). */
const INNER_WALLS: Record<FloorUse, { L: WallPatch[]; R: WallPatch[] }> = {
  desks: {
    L: [
      { kind: "pane", u: 1.75, z: 0.5, w: 0.8, h: 0.62 },
      { kind: "clock", u: 2.9, z: 1.0, w: 0.3, h: 0.3 },
    ],
    R: [
      { kind: "pane", u: 0.8, z: 0.5, w: 0.8, h: 0.62 },
      { kind: "picture", u: 2.0, z: 0.6, w: 0.55, h: 0.45 },
    ],
  },
  meeting: {
    L: [
      { kind: "pane", u: 0.7, z: 0.5, w: 0.8, h: 0.62 },
      { kind: "pane", u: 1.9, z: 0.5, w: 0.8, h: 0.62 },
    ],
    R: [{ kind: "screen", u: 0.6, z: 0.3, w: 1.7, h: 0.75 }],
  },
  lounge: {
    L: [
      { kind: "picture", u: 1.15, z: 0.8, w: 0.6, h: 0.42 },
      { kind: "picture", u: 1.95, z: 0.72, w: 0.42, h: 0.55 },
    ],
    R: [{ kind: "pane", u: 1.1, z: 0.5, w: 1.1, h: 0.65 }],
  },
  lab: {
    L: [{ kind: "picture", u: 2.6, z: 0.75, w: 0.4, h: 0.4, warn: true }],
    R: [
      { kind: "pane", u: 0.9, z: 0.55, w: 0.7, h: 0.5 },
      { kind: "clock", u: 2.2, z: 1.0, w: 0.3, h: 0.3 },
    ],
  },
};

function fitWall(patches: WallPatch[], length: number, face: Face, color: string): Deco[] {
  return patches
    .filter((patch) => patch.u + patch.w <= length - 0.1)
    .map((patch): Deco => {
      if (patch.kind === "picture" || patch.kind === "screen") return { ...patch, face, color };
      return { ...patch, face };
    });
}

/** Windows, door and sign on one storey's outside walls; a window shows the
 *  silhouette of the agent at the desk (or on the couch) behind it. */
function shellDecos(b: Footprint & { style: BuildingStyle; color: string; name: string; lit: boolean }, floor: number, plan: BuildingPlan, seedKey: number): Deco[] {
  const decos: Deco[] = [];
  const { w, d, style } = b;
  const r = rng(seedKey + floor * 17);
  const desks = plan.desks.filter((s) => s.floor === floor);
  const worker = (side: 0 | 1) => desks.find((s) => s.side === side)?.character ?? null;
  const lit = () => b.lit && r() < 0.75;
  if (style === "tower") {
    decos.push(
      { kind: "curtain", face: "L" },
      { kind: "curtain", face: "R" },
      { kind: "band", face: "L", z: 0, h: 0.1, color: b.color },
      { kind: "band", face: "R", z: 0, h: 0.1, color: b.color },
    );
  }
  const wz = 0.45;
  const ww = 0.62;
  const wh = 0.62;
  if (floor === 0) {
    decos.push({ kind: "door", face: "L", u: w / 2 - 0.32, z: 0, w: 0.64, h: 1.0, style });
    decos.push({ kind: "sign", face: "L", u: w / 2 - 0.8, z: 1.1, w: 1.6, h: 0.28, text: b.name, style });
    decos.push({ kind: "window", face: "L", u: 0.4, z: wz, w: ww, h: wh, lit: lit(), style, worker: worker(0) });
    decos.push({ kind: "window", face: "L", u: w - 0.4 - ww, z: wz, w: ww, h: wh, lit: lit(), style, worker: worker(1) });
  } else {
    const n = Math.floor((w - 0.3) / 1.05);
    const gap = (w - 0.8 - ww) / (n - 1);
    for (let i = 0; i < n; i++) {
      const seen = i === 0 ? worker(0) : i === n - 1 ? worker(1) : null;
      decos.push({ kind: "window", face: "L", u: 0.4 + i * gap, z: wz, w: ww, h: wh, lit: lit(), style, worker: seen });
    }
  }
  const m = Math.floor((d - 0.3) / 1.05);
  const gap = (d - 0.8 - ww) / (m - 1);
  for (let i = 0; i < m; i++) {
    const sleeper = floor === plan.loungeFloor ? (plan.couch[i] ?? null) : null;
    decos.push({ kind: "window", face: "R", u: 0.4 + i * gap, z: wz, w: ww, h: wh, lit: lit(), style, sleeper });
  }
  return decos;
}

function building(list: Item[], ox: number, oy: number, island: IslandPlan, color: string, p: Palette, tag: Tag): BuildingItem {
  const style = island.style.building;
  const shape = BUILDING_SHAPES[style];
  const plan = island.building;
  const seedName = `project-${island.projectId}`;
  const footprint: Footprint = { x: ox + 0.9, y: oy + 0.9, w: shape.w, d: shape.d, floors: plan.floors };
  const characters = island.room.characters;
  const lit = characters.length > 0;
  const shellInput = { ...footprint, style, color, name: island.room.name, lit };
  const item: BuildingItem = {
    kind: "building",
    projectId: island.projectId,
    name: island.room.name,
    color,
    ...footprint,
    floorHeight: FLOOR_HEIGHT,
    style,
    material: shape.material,
    wallColor: tint(p, shape.wall),
    uses: plan.uses,
    lit,
    active: plan.desks.length > 0,
    contents: plan.uses.map((use, f) => floorContents(footprint, f, use, plan, color, seedName, p)),
    innerWalls: plan.uses.map((use) => ({
      L: fitWall(INNER_WALLS[use].L, footprint.w, "L", color),
      R: fitWall(INNER_WALLS[use].R, footprint.d - 0.1, "R", color),
    })),
    shell: plan.uses.map((_, f) => shellDecos(shellInput, f, plan, hash(seedName))),
    layer: 1,
    seed: 0,
    depth: 0,
    bounds: NO_BOUNDS,
    ...tag,
  };
  list.push(item);
  return item;
}

// ---------- islands ----------

/** A floating island: grass (or sand, snow...) top, a lip, rock strata tapering
 *  underneath, and roots, cables or icicles hanging off its front edges. */
function island(
  list: Item[],
  ox: number,
  oy: number,
  size: number,
  tintColor: string,
  colors: GroundColors,
  ground: Texture,
  underside: Underside,
  tag: Tag,
  pattern: number,
  p: Palette,
): void {
  box(list, { x: ox - 0.07, y: oy - 0.07, z: -0.46, w: size + 0.14, d: size + 0.14, h: 0.18, color: tint(p, colors.lip), layer: 0, ...tag });
  box(list, {
    x: ox,
    y: oy,
    z: -0.3,
    w: size,
    d: size,
    h: 0.3,
    color: tint(p, mix(colors.top, tintColor, 0.05)),
    texture: ground,
    layer: 0,
    ground: true,
    ...tag,
  });
  const layers: [number, number][] = [
    [0.25, 1.3],
    [0.9, 1.7],
    [1.7, 1.7],
    [2.5, 1.6],
  ];
  let z = -0.46;
  layers.forEach(([inset, h], k) => {
    z -= h;
    box(list, {
      x: ox + inset,
      y: oy + inset,
      z,
      w: size - 2 * inset,
      d: size - 2 * inset,
      h,
      color: tint(p, colors.rock[k]),
      side: "strata",
      layer: 0,
      ...tag,
    });
  });
  box(list, {
    x: ox + size / 2 - 0.55,
    y: oy + size / 2 - 0.55,
    z: z - 1.3,
    w: 1.1,
    d: 1.1,
    h: 1.3,
    color: tint(p, shade(colors.rock[3], -0.1)),
    side: "strata",
    layer: 0,
    ...tag,
  });
  add(list, { kind: "hang", variety: underside, x: ox, y: oy, size, pattern, layer: 0, depthOverride: ox + oy + size + 0.4, ...tag });
}

function pond(list: Item[], x: number, y: number, w: number, d: number, p: Palette, tag: Tag, ice = false): void {
  box(list, { x: x - 0.1, y: y - 0.1, w: w + 0.2, d: d + 0.2, h: 0.04, color: p.stone, flat: true, layer: 0.4, ...tag });
  box(list, { x, y, z: 0.04, w, d, h: 0.01, color: ice ? p.ice : p.water, texture: ice ? "ice" : "water", flat: true, layer: 0.41, ...tag });
}

/** One environment's props in the free space right of and in front of the
 *  building, plus a signature prop in the corner left of the path. */
function scenery(list: Item[], ox: number, oy: number, island: IslandPlan, color: string, p: Palette, tag: Tag, seed: number): void {
  const n = ISLAND_SIZE;
  const t = (c: string) => tint(p, c);
  const env = island.style.environment;
  const at = (x: number, y: number): [number, number] => [ox + x, oy + y];
  if (env === "meadow") {
    tree(list, ...at(6.1, 0.3), tag, seed + 1, "round");
    tree(list, ...at(7.7, 1.5), tag, seed + 2, "pine");
    tree(list, ...at(6.3, 2.9), tag, seed + 3, "bloom");
    pond(list, ...at(7.1, 3.7), 1.2, 1.1, p, tag);
    box(list, { x: ox + 8.3, y: oy + 4.0, z: 0.04, w: 0.7, d: 0.45, h: 0.01, color: p.water, texture: "water", flat: true, layer: 0.41, ...tag });
    add(list, { kind: "fall", x: ox + n, y: oy + 4.0, width: 0.45, z: 0, length: 6.5, layer: 0, depthOverride: ox + oy + n * 1.5 + 1, ...tag });
    for (let k = 0; k < 5; k++) box(list, { x: ox + 5.6 + k * 0.65, y: oy + n - 0.3, w: 0.08, d: 0.08, h: 0.42, color: p.woodDark, ...tag });
    box(list, { x: ox + 5.6, y: oy + n - 0.29, z: 0.26, w: 2.7, d: 0.05, h: 0.06, color: p.wood, ...tag });
    tree(list, ...at(7.6, 6.0), tag, seed + 4, "round");
  } else if (env === "city") {
    for (const [x, y] of [
      [6.1, 0.4],
      [7.8, 0.4],
      [7.8, 2.4],
    ]) {
      tree(list, ...at(x, y), tag, seed + x * 3, "planter");
    }
    add(list, { kind: "fountain", x: ox + 6.0, y: oy + 5.4, layer: 1, ...tag });
    add(list, { kind: "car", x: ox + 6.1, y: oy + 3.0, color: "#e8554e", layer: 1, ...tag });
    lamp(list, ...at(5.5, 7.9), 1.8, tag, true);
    lamp(list, ...at(8.3, 4.9), 1.8, tag, true);
  } else if (env === "desert") {
    tree(list, ...at(6.1, 0.3), tag, seed + 1, "palm");
    tree(list, ...at(7.9, 2.1), tag, seed + 2, "palm");
    tree(list, ...at(6.0, 3.2), tag, seed + 3, "cactus");
    pond(list, ...at(6.3, 5.4), 1.6, 1.2, p, tag);
    tree(list, ...at(8.0, 5.0), tag, seed + 4, "palm");
    tree(list, ...at(7.9, 7.4), tag, seed + 5, "cactus");
    box(list, { x: ox + 5.6, y: oy + 7.6, w: 0.45, d: 0.35, h: 0.25, color: t("#c98a55"), ...tag });
    box(list, { x: ox + 0.3, y: oy + 5.3, w: 0.35, d: 0.3, h: 0.2, color: t("#c98a55"), ...tag });
  } else if (env === "snow") {
    for (const [x, y, s] of [
      [6.1, 0.3, 1],
      [7.7, 1.6, 2],
      [6.4, 3.0, 3],
      [8.0, 7.5, 4],
      [0.2, 5.2, 5],
    ]) {
      tree(list, ...at(x, y), tag, seed + s, "snowpine");
    }
    add(list, { kind: "snowman", x: ox + 6.3, y: oy + 6.2, color, layer: 1, ...tag });
    pond(list, ...at(7.2, 4.0), 1.3, 1.3, p, tag, true);
    box(list, { x: ox + 5.4, y: oy + 7.7, w: 0.9, d: 0.4, h: 0.12, color: t("#b0473a"), ...tag });
  } else {
    tree(list, ...at(6.1, 0.3), tag, seed + 1, "orange");
    tree(list, ...at(7.7, 1.6), tag, seed + 2, "red");
    tree(list, ...at(6.4, 3.0), tag, seed + 3, "gold");
    tree(list, ...at(8.0, 7.3), tag, seed + 4, "red");
    for (const [x, y] of [
      [6.2, 6.3],
      [6.75, 6.75],
      [5.8, 6.95],
    ]) {
      add(list, { kind: "pumpkin", x: ox + x, y: oy + y, layer: 1, ...tag });
    }
    box(list, { x: ox + 7.4, y: oy + 5.2, w: 0.9, d: 0.6, h: 0.5, color: t("#d9b85c"), side: "siding", ...tag });
  }

  const X = ox + 0.35;
  const Y = oy + 5.05;
  const B = (fields: BoxFields) => box(list, { ...fields, ...tag });
  if (env === "meadow") {
    // vegetable patch
    B({ x: X, y: Y, w: 1.5, d: 1.2, h: 0.08, color: t("#7a5a3c") });
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        B({
          x: X + 0.12 + c * 0.36,
          y: Y + 0.12 + r * 0.36,
          z: 0.08,
          w: 0.18,
          d: 0.18,
          h: 0.14 + ((r + c) % 2) * 0.06,
          color: t((r * 4 + c) % 5 === 2 ? "#e8554e" : "#5f9d4f"),
        });
      }
    }
  } else if (env === "city") {
    // bus stop
    B({ x: X + 0.05, y: Y, w: 0.06, d: 1.3, h: 1.1, color: t("#bcd9ea") });
    B({ x: X, y: Y - 0.1, z: 1.1, w: 0.75, d: 1.5, h: 0.07, color: "#3e3e46" });
    B({ x: X + 0.15, y: Y + 0.25, z: 0.3, w: 0.32, d: 0.8, h: 0.06, color: p.wood });
    B({ x: X + 0.7, y: Y - 0.05, w: 0.06, d: 0.06, h: 1.5, color: "#3e3e46" });
    B({ x: X + 0.62, y: Y - 0.1, z: 1.5, w: 0.22, d: 0.16, h: 0.3, color: t(color) });
  } else if (env === "desert") {
    // well and pots
    B({ x: X, y: Y, w: 0.9, d: 0.9, h: 0.5, color: t("#b9a58a"), side: "plaster" });
    B({ x: X + 0.15, y: Y + 0.15, z: 0.5, w: 0.6, d: 0.6, h: 0.02, color: p.water, flat: true });
    B({ x: X + 0.02, y: Y + 0.4, z: 0.5, w: 0.06, d: 0.06, h: 0.7, color: p.woodDark });
    B({ x: X + 0.82, y: Y + 0.4, z: 0.5, w: 0.06, d: 0.06, h: 0.7, color: p.woodDark });
    B({ x: X - 0.08, y: Y + 0.25, z: 1.2, w: 1.06, d: 0.4, h: 0.08, color: t("#b0473a") });
    B({ x: X + 1.1, y: Y + 0.6, w: 0.5, d: 0.45, h: 0.35, color: t("#c46a3a") });
    B({ x: X + 1.2, y: Y + 0.7, z: 0.35, w: 0.28, d: 0.25, h: 0.2, color: t("#d07a48") });
  } else if (env === "snow") {
    // igloo
    const ice = t("#eef4fa");
    B({ x: X, y: Y, w: 1.3, d: 1.3, h: 0.35, color: ice, side: "siding" });
    B({ x: X + 0.15, y: Y + 0.15, z: 0.35, w: 1.0, d: 1.0, h: 0.3, color: ice, side: "siding" });
    B({ x: X + 0.35, y: Y + 0.35, z: 0.65, w: 0.6, d: 0.6, h: 0.22, color: ice });
    B({ x: X + 0.45, y: Y + 1.28, w: 0.4, d: 0.12, h: 0.32, color: t("#4a5a6a") });
  } else {
    // scarecrow and a hay cart
    B({ x: X + 0.55, y: Y + 0.4, w: 0.06, d: 0.06, h: 1.15, color: p.woodDark });
    B({ x: X + 0.25, y: Y + 0.4, z: 0.8, w: 0.66, d: 0.06, h: 0.06, color: p.woodDark });
    B({ x: X + 0.45, y: Y + 0.33, z: 0.5, w: 0.26, d: 0.18, h: 0.4, color: t("#b0473a") });
    B({ x: X + 0.48, y: Y + 0.33, z: 0.92, w: 0.2, d: 0.18, h: 0.2, color: t("#e2c37a") });
    B({ x: X + 0.4, y: Y + 0.28, z: 1.12, w: 0.36, d: 0.28, h: 0.04, color: t("#5a3f2c") });
    B({ x: X + 0.47, y: Y + 0.33, z: 1.16, w: 0.22, d: 0.18, h: 0.12, color: t("#5a3f2c") });
    B({ x: X, y: Y + 0.9, w: 0.9, d: 0.5, h: 0.12, color: t("#d9822b") });
    B({ x: X + 0.2, y: Y + 1.0, z: 0.12, w: 0.5, d: 0.3, h: 0.08, color: t("#c8562f") });
  }
  if (island.style.weather) {
    add(list, { kind: "weather", variety: island.style.weather, x: ox, y: oy, size: n, pattern: seed, layer: 2.5, ...tag });
  }
}

function stateCounts(characters: TownCharacter[]): LabelItem["counts"] {
  return {
    working: characters.filter((c) => c.state === "working").length,
    blocked: characters.filter((c) => c.state === "blocked").length,
    quiet: characters.filter((c) => c.state === "quiet").length,
  };
}

/** One project's island: ground, building, people by state, scenery and name chip. */
function lot(list: Item[], island: IslandPlan, p: Palette): void {
  const { x: ox, y: oy } = cellOrigin(island.cell);
  const room = island.room;
  const color = room.color ?? INBOX_COLOR;
  const tag: Tag = { group: island.projectId, dim: room.characters.length === 0 };
  const seed = hash(`project-${island.projectId}`) + 3;
  const env = island.style.environment;
  const snowy = env === "snow";
  const t = (c: string) => tint(p, c);
  projectIsland(list, ox, oy, color, island, tag, seed, p);
  const b = building(list, ox, oy, island, color, p, tag);
  const doorX = b.x + b.w / 2;
  const y1 = b.y + b.d;
  const paving = snowy ? t("#c9d3df") : p.stone;
  for (let k = 0; k < 6; k++) {
    box(list, { x: doorX - 0.22, y: y1 + 0.2 + k * 0.66, w: 0.45, d: 0.42, h: 0.03, color: paving, flat: true, layer: 0.4, ...tag });
  }
  island.building.door.forEach((character, k) => {
    add(list, { kind: "agent", x: doorX + 0.75 + k * 0.6, y: y1 + 0.8, z: 0, character, pose: "stand", pace: 0.12, color, layer: 1, ...tag });
  });
  box(list, { x: doorX - 0.55, y: y1, w: 1.1, d: 0.32, h: 0.07, color: paving, layer: 0.42, ...tag });
  box(list, { x: doorX - 0.3, y: y1 + 0.06, z: 0.07, w: 0.6, d: 0.2, h: 0.01, color: t(mix("#8a6a4a", color, 0.35)), flat: true, layer: 0.43, ...tag });
  plant(list, doorX - 0.95, y1 + 0.05, tag);
  plant(list, doorX + 0.62, y1 + 0.05, tag);
  box(list, { x: doorX + 0.6, y: y1 + 3.4, w: 0.06, d: 0.06, h: 0.55, color: p.woodDark, ...tag });
  box(list, { x: doorX + 0.5, y: y1 + 3.31, z: 0.55, w: 0.26, d: 0.24, h: 0.2, color: t(color), ...tag });
  bench(list, ox + 0.6, oy + ISLAND_SIZE - 1.6, island.building.bench, color, p, tag);
  lamp(list, doorX - 0.9, y1 + 1.6, 1.6, tag, env === "city");
  scenery(list, ox, oy, island, color, p, tag, seed);
  add(list, {
    kind: "label",
    x: b.x + b.w / 2,
    y: b.y + b.d / 2,
    projectId: island.projectId,
    name: room.name,
    color,
    counts: stateCounts(room.characters),
    open: room.openTaskCount,
    baseZ: 4,
    floors: b.floors,
    layer: 3,
    ...tag,
  });
}

function projectIsland(list: Item[], ox: number, oy: number, color: string, plan: IslandPlan, tag: Tag, seed: number, p: Palette): void {
  const env = plan.style.environment;
  island(list, ox, oy, ISLAND_SIZE, color, BIOME_COLORS[env], plan.style.ground, plan.style.underside, tag, seed, p);
}

/** Where the n-th Inbox agent stands in the square: rows in front of and behind
 *  the fountain, five to a row. */
function squareSpot(index: number): { x: number; y: number } {
  const row = Math.floor(index / 5);
  const rows = [6.0, 7.3, 2.4];
  return { x: 2.3 + (index % 5) * 0.75, y: rows[row % rows.length] + Math.floor(row / rows.length) * 0.3 };
}

/** The town square: fountain, benches, lamps, a flag per project in its colour,
 *  a kiosk, a board, the Inbox agents, and a chip with the totals. */
function square(list: Item[], x: number, y: number, model: TownModel, inbox: TownCharacter[], p: Palette): void {
  const tag: Tag = { group: "square" };
  const t = (c: string) => tint(p, c);
  const projects = model.rooms.filter((room) => room.projectId !== null);
  const allCharacters = model.rooms.flatMap((room) => room.characters);
  const open = projects.reduce((sum, room) => sum + room.openTaskCount, 0);
  island(list, x, y, ISLAND_SIZE, "#9a8f7c", SQUARE_GROUND, "tiles", "roots", tag, hash("town"), p);
  add(list, { kind: "fountain", x: x + 3.8, y: y + 3.8, layer: 1, ...tag });
  bench(list, x + 1.2, y + 1.6, [], INBOX_COLOR, p, tag);
  bench(list, x + 6.2, y + 6.6, [], INBOX_COLOR, p, tag);
  lamp(list, x + 1.4, y + 6.4, 1.8, tag, true);
  lamp(list, x + 7.2, y + 1.6, 1.8, tag, true);
  for (const [a, c] of [
    [0.4, 0.4],
    [8.1, 0.4],
    [0.4, 8.1],
    [8.1, 8.1],
  ]) {
    tree(list, x + a, y + c, tag, hash("sq") + a * 7 + c, "planter");
  }
  projects.forEach((room, k) => {
    const angle = Math.PI * (0.15 + (1.2 * k) / Math.max(1, projects.length - 1)) - Math.PI * 0.35;
    add(list, {
      kind: "flag",
      x: x + 4.5 + Math.cos(angle) * 2.6,
      y: y + 4.5 - Math.sin(angle) * 2.6,
      color: room.color ?? INBOX_COLOR,
      height: 2.1,
      phase: k,
      layer: 1,
      ...tag,
    });
  });
  board(list, x + 5.6, y + 0.5, "Town square", Math.min(15, open), p, tag);
  // kiosk with an awning
  box(list, { x: x + 0.6, y: y + 3.4, w: 0.8, d: 1.3, h: 0.75, color: t("#c9573a"), side: "siding", ...tag });
  box(list, { x: x + 0.62, y: y + 3.5, z: 0.75, w: 0.5, d: 0.3, h: 0.25, color: "#2b2d35", ...tag });
  for (const [a, c] of [
    [0.55, 3.3],
    [0.55, 4.65],
    [1.35, 3.3],
    [1.35, 4.65],
  ]) {
    box(list, { x: x + a, y: y + c, z: 0.75, w: 0.06, d: 0.06, h: 0.7, color: p.woodDark, ...tag });
  }
  box(list, {
    x: x + 0.45,
    y: y + 3.2,
    z: 1.45,
    w: 1.1,
    d: 1.6,
    h: 0.08,
    color: t("#f4ecdd"),
    decos: [
      { kind: "band", face: "L", z: 0, h: 0.08, color: t("#c9573a") },
      { kind: "band", face: "R", z: 0, h: 0.08, color: t("#c9573a") },
    ],
    ...tag,
  });
  inbox.forEach((character, i) => {
    const spot = squareSpot(i);
    add(list, {
      kind: "agent",
      x: x + spot.x,
      y: y + spot.y,
      z: 0,
      character,
      pose: "stand",
      pace: character.state === "blocked" ? 0.12 : undefined,
      color: INBOX_COLOR,
      layer: 1,
      ...tag,
    });
  });
  add(list, {
    kind: "label",
    x: x + 4.5,
    y: y + 4.5,
    projectId: null,
    name: "Town square",
    color: INBOX_COLOR,
    counts: stateCounts(allCharacters),
    open,
    baseZ: 1.4,
    floors: 0,
    layer: 3,
    ...tag,
  });
}

/** A wooden bridge across the gap between two neighbouring cells. */
function bridge(list: Item[], from: Cell, to: Cell, places: Place[], p: Palette): void {
  const a = cellOrigin(from);
  const c = cellOrigin(to);
  const n = ISLAND_SIZE;
  const along = from.row === to.row;
  const x = along ? Math.min(a.x, c.x) + n : a.x + n / 2 - 0.6;
  const y = along ? a.y + n / 2 - 0.6 : Math.min(a.y, c.y) + n;
  const length = Math.abs(along ? c.x - a.x : c.y - a.y) - n;
  const w = along ? length : 1.2;
  const d = along ? 1.2 : length;
  const tag: Tag = { groups: places };
  box(list, { x, y, z: -0.16, w, d, h: 0.12, color: p.wood, texture: "planks", layer: 0.3, ...tag });
  for (const side of [0, 1]) {
    const rx = along ? x : x + side * 1.1;
    const ry = along ? y + side * 1.1 : y;
    box(list, { x: rx, y: ry, z: 0.25, w: along ? w : 0.08, d: along ? 0.08 : d, h: 0.06, color: p.woodDark, layer: 0.5, ...tag });
    for (let k = 0; k <= 2; k++) {
      box(list, {
        x: along ? x + (k * (w - 0.08)) / 2 : rx,
        y: along ? ry : y + (k * (d - 0.08)) / 2,
        z: -0.04,
        w: 0.08,
        d: 0.08,
        h: 0.29,
        color: p.woodDark,
        layer: 0.5,
        ...tag,
      });
    }
  }
}

// ---------- prepare ----------

/** World bounds, shadow, painter's depth and texture specks for one item. */
function prepare(item: Item, seed: number): void {
  item.seed = seed;
  switch (item.kind) {
    case "box": {
      item.bounds = [item.x, item.y, item.z, item.w, item.d, item.h];
      if (item.texture && item.texture !== "water") {
        const r = rng(seed * 7 + 3);
        const count = Math.max(4, Math.round(item.w * item.d * (item.texture === "planks" ? 1 : 6)));
        item.specks = Array.from({ length: count }, () => [r() * item.w, r() * item.d, r()]);
      }
      if (item.side === "strata") {
        const r = rng(seed * 13 + 1);
        item.strata = Array.from({ length: 8 }, () => [r(), r(), r()]);
      }
      if (item.layer >= 1 && !item.flat && item.z < 0.05 && item.h > 0.12) {
        item.shadow = { x: item.x, y: item.y, w: item.w, d: item.d, h: item.h, z: item.z };
      }
      break;
    }
    case "building":
      item.bounds = [item.x - 0.3, item.y - 0.3, 0, item.w + 0.6, item.d + 0.6, item.floors * (item.floorHeight + 1.9) + 2];
      item.shadow = { x: item.x, y: item.y, w: item.w, d: item.d, h: item.floors * item.floorHeight + 0.8, z: 0 };
      item.contents.forEach((floor, f) => {
        floor.forEach((inner, i) => prepare(inner, seed * 100 + f * 1000 + i));
        floor.sort(byPaintOrder);
      });
      break;
    case "tree":
      item.bounds = [item.x, item.y, 0, 1, 1, 2.2 * item.scale];
      item.shadow = { x: item.x + 0.15, y: item.y + 0.15, w: 0.7, d: 0.7, h: 1.6 * item.scale, z: 0 };
      break;
    case "lamp":
      item.bounds = [item.x, item.y, 0, 0.2, 0.2, item.height + 0.3];
      item.shadow = { x: item.x, y: item.y, w: 0.08, d: 0.08, h: item.height, z: 0 };
      break;
    case "plant":
      item.bounds = [item.x, item.y, 0, 0.35, 0.35, 0.8];
      item.shadow = { x: item.x, y: item.y, w: 0.32, d: 0.32, h: 0.6, z: 0 };
      break;
    case "fountain":
      item.bounds = [item.x, item.y, 0, 1.4, 1.4, 1];
      item.shadow = { x: item.x, y: item.y, w: 1.4, d: 1.4, h: 0.4, z: 0 };
      break;
    case "car":
      item.bounds = [item.x, item.y, 0, 1.2, 0.6, 0.7];
      item.shadow = { x: item.x, y: item.y, w: 1.2, d: 0.6, h: 0.5, z: 0 };
      break;
    case "snowman":
      item.bounds = [item.x, item.y, 0, 0.6, 0.6, 1.3];
      item.shadow = { x: item.x, y: item.y, w: 0.5, d: 0.5, h: 1.1, z: 0 };
      break;
    case "pumpkin":
      item.bounds = [item.x, item.y, 0, 0.35, 0.35, 0.35];
      break;
    case "agent":
      item.bounds = [item.x - 0.3, item.y - 0.3, item.z, 0.6, 0.6, 1.8];
      break;
    case "drone":
      item.bounds = [item.x, item.y, 0, 0, 0, 0];
      break;
    case "flag":
      item.bounds = [item.x, item.y, 0, 0, 0, item.height];
      break;
    case "bot":
      item.bounds = [item.x0, item.y, 0, item.x1 - item.x0, 0, 0.6];
      break;
    case "label":
      item.bounds = [item.x, item.y, 0, 0, 0, item.floors * FLOOR_HEIGHT + 3.6];
      break;
    case "fall":
      item.bounds = [item.x, item.y, item.z - item.length, 0, item.width, item.length];
      break;
    case "hang":
    case "weather":
      item.bounds = [item.x, item.y, -1, item.size, item.size, 0];
      break;
    case "steam":
      item.bounds = [item.x, item.y, item.z, 0, 0, 0];
      break;
  }
  const [bx, by, bz, bw, bd] = item.bounds;
  item.depth = item.depthOverride ?? bx + bw / 2 + by + bd / 2 + bz * 0.01;
}

function byPaintOrder(a: Item, b: Item): number {
  return a.layer - b.layer || a.depth - b.depth;
}

export interface TownScene {
  /** Every item in paint order. */
  items: Item[];
  buildings: BuildingItem[];
  /** Island tops: shadows are clipped to these. */
  grounds: BoxItem[];
}

/**
 * The whole town for a roster and palette: islands in project order on their grid
 * cells, the square (with the Inbox agents), bridges between neighbours, and one
 * drone per project shuttling to the square. Zero projects draws the square alone.
 */
export function buildScene(model: TownModel, palette: Palette): TownScene {
  const layout = townLayout(model);
  const items: Item[] = [];
  for (const island of layout.islands) lot(items, island, palette);
  const sq = cellOrigin(layout.grid.square);
  square(items, sq.x, sq.y, model, layout.squareAgents, palette);
  layout.islands.forEach((island, i) => {
    const from = cellOrigin(island.cell);
    add(items, {
      kind: "drone",
      x: from.x + 6.5,
      y: from.y + 6,
      x2: sq.x + 4.5,
      y2: sq.y + 4.5,
      color: island.room.color ?? INBOX_COLOR,
      phase: i,
      groups: [island.projectId, "square"],
      layer: 2.6,
    });
  });
  for (const b of layout.bridges) bridge(items, b.from, b.to, b.places, palette);
  items.forEach((item, i) => prepare(item, i));
  items.sort(byPaintOrder);
  return {
    items,
    buildings: items.filter((item): item is BuildingItem => item.kind === "building"),
    grounds: items.filter((item): item is BoxItem => item.kind === "box" && !!item.ground),
  };
}
