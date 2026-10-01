import { describe, expect, it } from "bun:test";
import type { TownCharacter, TownModel, TownRoom } from "../src/selectors";
import { buildingPlan, floorCount, floorUses, townGrid, townLayout } from "../src/town/layout";
import type { Environment } from "../src/types";
import type { PresenceState } from "../src/utils/presence";

// The Town's structure before drawing: grid cells and the square, bridges, the
// island look per environment, building height and floor uses, and where each
// agent goes by state.

let seq = 0;

function agent(state: PresenceState): TownCharacter {
  seq += 1;
  return {
    taskId: seq,
    sessionId: `s${seq}`,
    agentName: `agent ${seq}`,
    ref: `T-${seq}`,
    title: `task ${seq}`,
    state,
    lastLog: null,
    at: "2026-10-01T10:00:00Z",
    live: true,
  };
}

function room(projectId: number | null, opts: Partial<TownRoom> = {}): TownRoom {
  return {
    projectId,
    name: projectId === null ? "Inbox" : `p${projectId}`,
    color: projectId === null ? null : "#5645d4",
    environment: projectId === null ? null : "meadow",
    characters: [],
    openTaskCount: 0,
    ...opts,
  };
}

function model(projectIds: number[], inbox: TownCharacter[] = []): TownModel {
  return { rooms: [...projectIds.map((id) => room(id)), room(null, { characters: inbox })] };
}

const cellsOf = (m: TownModel) => townLayout(m).islands.map((i) => [i.projectId, i.cell.col, i.cell.row]);

describe("cells", () => {
  it("sizes a roughly square grid with room for the square", () => {
    const sizes = [0, 1, 4, 5, 8].map((n) => {
      const g = townGrid(n);
      return [n, g.cols, g.rows, g.projects.length];
    });
    expect(sizes).toEqual([
      [0, 1, 1, 0],
      [1, 2, 1, 1],
      [4, 3, 2, 4],
      [5, 3, 2, 5],
      [8, 3, 3, 8],
    ]);
  });

  it("puts the square on the cell nearest the middle, first on a tie", () => {
    expect(townGrid(0).square).toEqual({ col: 0, row: 0 });
    expect(townGrid(4).square).toEqual({ col: 1, row: 0 });
    expect(townGrid(8).square).toEqual({ col: 1, row: 1 });
  });

  it("fills the other cells row-major in project order", () => {
    expect(cellsOf(model([7, 3, 9, 1]))).toEqual([
      [7, 0, 0],
      [3, 2, 0],
      [9, 0, 1],
      [1, 1, 1],
    ]);
  });

  it("reflows when a project is added or removed", () => {
    expect(cellsOf(model([7, 3, 9]))).toEqual([
      [7, 1, 0],
      [3, 0, 1],
      [9, 1, 1],
    ]);
    expect(cellsOf(model([3, 9, 1]))).toEqual([
      [3, 1, 0],
      [9, 0, 1],
      [1, 1, 1],
    ]);
  });

  it("bridges every pair of grid neighbours, the square included", () => {
    const bridges = townLayout(model([7, 3, 9])).bridges.map((b) => b.places);
    // 2x2, a four-way tie: square at (0,0), 7 at (1,0), 3 at (0,1), 9 at (1,1)
    expect(bridges).toEqual([
      [7, 9],
      [7, "square"],
      [3, 9],
      [3, "square"],
    ]);
  });

  it("draws the square alone for zero projects", () => {
    const layout = townLayout(model([]));
    expect(layout.islands).toEqual([]);
    expect(layout.bridges).toEqual([]);
    expect(layout.grid.square).toEqual({ col: 0, row: 0 });
  });
});

describe("inbox agents go to the square", () => {
  it("places project-less agents in the square and on no island", () => {
    const loose = [agent("working"), agent("blocked")];
    const layout = townLayout(model([1, 2], loose));
    expect(layout.squareAgents).toEqual(loose);
    const onIslands = layout.islands.flatMap((i) => [
      ...i.building.desks.map((d) => d.character),
      ...i.building.couch,
      ...i.building.bench,
      ...i.building.door,
    ]);
    expect(onIslands).toEqual([]);
  });
});

describe("style by environment", () => {
  it("picks the building, ground and weather from the project's environment", () => {
    const envs: Environment[] = ["meadow", "city", "desert", "snow", "autumn"];
    const m: TownModel = { rooms: envs.map((environment, i) => room(i + 1, { environment })) };
    const looks = townLayout(m).islands.map((i) => [i.style.environment, i.style.building, i.style.ground]);
    expect(looks).toEqual([
      ["meadow", "cottage", "grass"],
      ["city", "tower", "tiles"],
      ["desert", "adobe", "sand"],
      ["snow", "chalet", "snow"],
      ["autumn", "brick", "leaves"],
    ]);
  });
});

describe("floors and uses", () => {
  it("adds a storey per 12 open tasks, at most 4", () => {
    expect([0, 11, 12, 24, 36, 47, 100].map(floorCount)).toEqual([1, 1, 2, 3, 4, 4, 4]);
  });

  it("uses the ground floor for desks, then meeting, lounge, lab", () => {
    expect(floorUses(1)).toEqual(["desks"]);
    expect(floorUses(4)).toEqual(["desks", "meeting", "lounge", "lab"]);
  });
});

describe("slots", () => {
  it("spreads working agents one per floor from the ground up, each with a desk", () => {
    const working = [1, 2, 3, 4].map(() => agent("working"));
    const plan = buildingPlan(working, 30); // 3 floors
    expect(plan.desks.map((d) => [d.character.taskId, d.floor, d.side])).toEqual([
      [working[0].taskId, 0, 0],
      [working[1].taskId, 1, 0],
      [working[2].taskId, 2, 0],
      [working[3].taskId, 0, 1],
    ]);
  });

  it("seats quiet agents on the lounge couch when there is a lounge", () => {
    const quiet = [agent("quiet"), agent("quiet")];
    const plan = buildingPlan(quiet, 24); // desks, meeting, lounge
    expect(plan.loungeFloor).toBe(2);
    expect(plan.couch).toEqual(quiet);
    expect(plan.bench).toEqual([]);
  });

  it("seats quiet agents on the garden bench without a lounge", () => {
    const quiet = [agent("quiet")];
    const plan = buildingPlan(quiet, 12); // desks, meeting
    expect(plan.loungeFloor).toBe(-1);
    expect(plan.couch).toEqual([]);
    expect(plan.bench).toEqual(quiet);
  });

  it("stands blocked agents at the front door", () => {
    const blocked = agent("blocked");
    const plan = buildingPlan([agent("working"), blocked], 0);
    expect(plan.door).toEqual([blocked]);
    expect(plan.desks.map((d) => d.character.state)).toEqual(["working"]);
  });
});
