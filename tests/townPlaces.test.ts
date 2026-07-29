import { describe, expect, it } from "bun:test";
import { buildPlaces, describePlace, placeAt, placePath } from "../src/town/places";
import { buildWorld } from "../src/town/world";
import type { TownModel, TownRoom } from "../src/selectors";

// The place tree is what gives the town nouns. buildWorld answers "can I stand
// here"; this answers "where am I". These pin that it is DERIVED — every node
// has to correspond to something buildWorld already declared — and that the
// deepest-match lookup resolves to the most specific place, which is the only
// property the prose depends on.

function room(name: string, openTaskCount = 1): TownRoom {
  return { projectId: 1, name, color: null, characters: [], openTaskCount };
}
function model(...names: string[]): TownModel {
  return { rooms: names.map(room) };
}

describe("buildPlaces", () => {
  it("is a world of areas: the green, the commons, and one house per building", () => {
    const world = buildWorld(model("Alpha", "Beta"));
    const root = buildPlaces(world);

    expect(root.kind).toBe("world");
    const names = root.children.map((c) => c.name);
    expect(names).toContain("the green");
    expect(names).toContain("the commons");
    expect(names).toContain("Alpha's house");
    expect(names).toContain("Beta's house");
    expect(root.children.every((c) => c.kind === "area")).toBe(true);
  });

  it("gives every house named rooms, and puts each item in the room it stands in", () => {
    const world = buildWorld(model("Alpha"));
    const root = buildPlaces(world);
    const house = root.children.find((c) => c.name === "Alpha's house")!;

    const rooms = house.children.filter((c) => c.kind === "room");
    expect(rooms.map((r) => r.name)).toContain("the kitchen");
    expect(rooms.map((r) => r.name)).toContain("the lounge");
    expect(rooms.map((r) => r.name)).toContain("the workroom");

    // The counter is in the kitchen and the sofa is in the lounge — not merely
    // "somewhere in the house".
    const kitchen = rooms.find((r) => r.name === "the kitchen")!;
    const lounge = rooms.find((r) => r.name === "the lounge")!;
    expect(kitchen.children.map((c) => c.name)).toContain("the counter");
    expect(lounge.children.map((c) => c.name)).toContain("the sofa");
    expect(kitchen.children.map((c) => c.name)).not.toContain("the sofa");
  });

  it("desks live in the workroom, one node per desk", () => {
    const world = buildWorld(model("Alpha"));
    const root = buildPlaces(world);
    const house = root.children.find((c) => c.name === "Alpha's house")!;
    const workroom = house.children.find((c) => c.name === "the workroom")!;
    const desks = workroom.children.filter((c) => c.name === "a desk");
    expect(desks).toHaveLength(world.buildings[0].desks.length);
  });

  it("loses nothing: every furniture tile appears exactly once in its house", () => {
    const world = buildWorld(model("Alpha", "Beta", "Gamma"));
    const root = buildPlaces(world);
    for (const [i, b] of world.buildings.entries()) {
      const house = root.children.find((c) => c.name === `${b.room.name}'s house`)!;
      const tiles = new Set<string>();
      const walk = (n: { children: { rect: { x: number; y: number } }[] }) => {
        for (const c of n.children) {
          tiles.add(`${c.rect.x},${c.rect.y}`);
          walk(c as never);
        }
      };
      walk(house as never);
      for (const f of b.furniture) {
        expect(tiles.has(`${f.tile.x},${f.tile.y}`), `building ${i} lost ${f.kind}`).toBe(true);
      }
    }
  });

  it("names the commons' seating and its fountain", () => {
    const world = buildWorld(model("Alpha", "Beta"));
    const root = buildPlaces(world);
    const commons = root.children.find((c) => c.name === "the commons")!;
    const names = commons.children.map((c) => c.name);
    expect(names).toContain("the fountain");
    expect(names.filter((n) => n === "a bench").length).toBeGreaterThan(0);
  });
});

describe("placeAt / describePlace", () => {
  it("resolves a tile to the most specific place containing it", () => {
    const world = buildWorld(model("Alpha"));
    const root = buildPlaces(world);
    const b = world.buildings[0];
    const counter = b.furniture.find((f) => f.kind === "counter")!;

    expect(placeAt(root, counter.tile)!.name).toBe("the counter");
    // The chain above it is house → kitchen, not just "the town".
    const chain = placePath(root, counter.tile).map((p) => p.name);
    expect(chain).toEqual(["the town", "Alpha's house", "the kitchen", "the counter"]);
  });

  it("reads a house tile as a room, and open ground as the green", () => {
    const world = buildWorld(model("Alpha"));
    const root = buildPlaces(world);
    const b = world.buildings[0];

    // A seat in front of a desk: inside the workroom, no object on it.
    expect(placeAt(root, b.seats[0])!.name).toBe("the workroom");
    expect(placeAt(root, world.edge)!.name).toBe("the green");
  });

  it("puts it in words, innermost first, without naming the town every time", () => {
    const world = buildWorld(model("Alpha"));
    const root = buildPlaces(world);
    const b = world.buildings[0];
    const sofa = b.furniture.find((f) => f.kind === "sofa")!;

    expect(describePlace(root, sofa.tile)).toBe("at the sofa, in the lounge, in Alpha's house");
    expect(describePlace(root, b.seats[0])).toBe("in the workroom, in Alpha's house");
  });

  it("is empty-safe off the map", () => {
    const world = buildWorld(model("Alpha"));
    const root = buildPlaces(world);
    expect(placeAt(root, { x: -1, y: -1 })).toBeNull();
    expect(placePath(root, { x: world.cols + 5, y: 0 })).toEqual([]);
  });
});
