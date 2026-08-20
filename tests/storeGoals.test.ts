import { beforeEach, describe, expect, it } from "bun:test";
import { db, emptyBoard, resetDbMock, useStore } from "./support/dbMock";
import type { Goal, Task } from "../src/types";

// The store is where the goal invariants live for the UI side (agent.rs enforces
// the same ones for MCP). Three of them are load-bearing and easy to break later:
// a goal belongs to one project, a task's goal must be that task's project's goal,
// and deleting a goal must never take tasks with it.

let seq = 0;

function task(opts: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: seq,
    project_id: 1,
    goal_id: null,
    title: `task ${seq}`,
    notes: "",
    status: "todo",
    priority: 0,
    due_date: null,
    position: seq,
    created_at: "2026-08-01T00:00:00.000Z",
    completed_at: null,
    deleted_at: null,
    archived_at: null,
    number: seq,
    ref: `TIL-${seq}`,
    unseen_at: null,
    tag_ids: [],
    ...opts,
  };
}

function goal(opts: Partial<Goal> = {}): Goal {
  seq += 1;
  return {
    id: seq,
    project_id: 1,
    name: `goal ${seq}`,
    notes: "",
    color: "#5645d4",
    position: 0,
    target_date: null,
    created_at: "2026-08-01T00:00:00.000Z",
    completed_at: null,
    ...opts,
  };
}

beforeEach(() => {
  resetDbMock();
  useStore.setState({
    goals: [],
    tasks: [],
    projects: [],
    selection: { type: "today" },
  });
});

describe("addGoal", () => {
  it("creates the goal, selects it, and picks a colour this project isn't using", async () => {
    // id well clear of the mock's own insert counter, so the new goal is findable.
    useStore.setState({ goals: [goal({ id: 100, project_id: 1, color: "#5645d4" })] });
    const id = await useStore.getState().addGoal({ project_id: 1, name: "Ship it" });
    const created = useStore.getState().goals.find((g) => g.id === id);
    expect(created?.name).toBe("Ship it");
    expect(created?.color).not.toBe("#5645d4");
    expect(useStore.getState().selection).toEqual({ type: "goal", goalId: id });
  });
});

describe("goal names are unique per project", () => {
  it("throws on a duplicate name rather than quietly adopting the existing goal", async () => {
    useStore.setState({ goals: [goal({ id: 100, project_id: 1, name: "Ship it" })] });
    // Case and surrounding space must not be enough to make a second goal —
    // MCP resolves goals by name, so "ship it" and "Ship it" would be ambiguous.
    // It throws rather than adopting: silently selecting a different goal than
    // the one being created is invisible to the person who typed the name.
    expect(
      useStore.getState().addGoal({ project_id: 1, name: "  ship IT " }),
    ).rejects.toThrow(/already has a goal/);
    expect(useStore.getState().goals).toHaveLength(1);
    expect(db.insertGoal).not.toHaveBeenCalled();
  });

  it("allows the same name in a different project", async () => {
    useStore.setState({ goals: [goal({ id: 100, project_id: 1, name: "Ship it" })] });
    const id = await useStore.getState().addGoal({ project_id: 2, name: "Ship it" });
    expect(id).not.toBe(100);
    expect(useStore.getState().goals).toHaveLength(2);
  });

  it("throws on a rename that would collide inside the project", async () => {
    useStore.setState({
      goals: [
        goal({ id: 100, project_id: 1, name: "Ship it" }),
        goal({ id: 101, project_id: 1, name: "Town sim" }),
      ],
    });
    expect(useStore.getState().editGoal(101, { name: "ship it" })).rejects.toThrow(
      /already has a goal/,
    );
    expect(db.updateGoal).not.toHaveBeenCalled();
    expect(useStore.getState().goals.find((g) => g.id === 101)?.name).toBe("Town sim");
  });

  it("trims a rename that does not collide", async () => {
    useStore.setState({ goals: [goal({ id: 100, project_id: 1, name: "Ship it" })] });
    await useStore.getState().editGoal(100, { name: "  Ship it v2  " });
    expect(db.updateGoal).toHaveBeenCalledWith(100, { name: "Ship it v2" });
    expect(useStore.getState().goals[0].name).toBe("Ship it v2");
  });
});

describe("setTaskGoal", () => {
  it("puts a task in a goal of its own project", async () => {
    useStore.setState({
      goals: [goal({ id: 1, project_id: 7 })],
      tasks: [task({ id: 10, project_id: 7 })],
    });
    await useStore.getState().setTaskGoal(10, 1);
    expect(useStore.getState().tasks[0].goal_id).toBe(1);
    expect(db.updateTask).toHaveBeenCalledWith(10, { goal_id: 1 });
  });

  it("refuses a goal from another project, and writes nothing", async () => {
    useStore.setState({
      goals: [goal({ id: 1, project_id: 7 })],
      tasks: [task({ id: 10, project_id: 8 })],
    });
    await useStore.getState().setTaskGoal(10, 1);
    expect(useStore.getState().tasks[0].goal_id).toBeNull();
    expect(db.updateTask).not.toHaveBeenCalled();
  });

  it("refuses any goal on an Inbox task — a goal requires a project", async () => {
    useStore.setState({
      goals: [goal({ id: 1, project_id: 7 })],
      tasks: [task({ id: 10, project_id: null })],
    });
    await useStore.getState().setTaskGoal(10, 1);
    expect(useStore.getState().tasks[0].goal_id).toBeNull();
    expect(db.updateTask).not.toHaveBeenCalled();
  });

  it("takes a task out of its goal with null", async () => {
    useStore.setState({
      goals: [goal({ id: 1, project_id: 7 })],
      tasks: [task({ id: 10, project_id: 7, goal_id: 1 })],
    });
    await useStore.getState().setTaskGoal(10, null);
    expect(useStore.getState().tasks[0].goal_id).toBeNull();
    expect(db.updateTask).toHaveBeenCalledWith(10, { goal_id: null });
  });
});

describe("addTask inside a goal view", () => {
  it("attaches the open goal to a new task in that goal's project", async () => {
    useStore.setState({
      goals: [goal({ id: 100, project_id: 7 })],
      selection: { type: "goal", goalId: 100 },
    });
    await useStore.getState().addTask({
      title: "new one",
      project_id: 7,
      due_date: null,
      priority: 0,
      tag_ids: [],
    });
    const created = useStore.getState().tasks.find((t) => t.title === "new one");
    expect(created?.goal_id).toBe(100);
    expect(db.insertTask.mock.calls[0][0].goal_id).toBe(100);
  });

  it("does not attach a goal when the new task lands in a different project", async () => {
    // Invariant 2 again: a task can only carry a goal of its own project, so a
    // "#otherproject" token in quick-add must drop the goal, not violate it.
    useStore.setState({
      goals: [goal({ id: 100, project_id: 7 })],
      selection: { type: "goal", goalId: 100 },
    });
    await useStore.getState().addTask({
      title: "elsewhere",
      project_id: 8,
      due_date: null,
      priority: 0,
      tag_ids: [],
    });
    const created = useStore.getState().tasks.find((t) => t.title === "elsewhere");
    expect(created?.goal_id).toBeNull();
  });

  it("attaches nothing when no goal is open", async () => {
    useStore.setState({
      goals: [goal({ id: 100, project_id: 7 })],
      selection: { type: "project", projectId: 7 },
    });
    await useStore.getState().addTask({
      title: "plain",
      project_id: 7,
      due_date: null,
      priority: 0,
      tag_ids: [],
    });
    expect(useStore.getState().tasks.find((t) => t.title === "plain")?.goal_id).toBeNull();
  });
});

describe("regressions from the Codex verify pass on TIL-204", () => {
  it("clears the goal in state, not just in the database, when a task changes project", async () => {
    // Finding 1. db.updateTask enforces invariant 2 internally, so SQLite dropped
    // the goal while editTask merged its own patch — which has no goal_id — and
    // Zustand kept the stale goal until the next reload.
    db.updateTask.mockImplementation(async (_id: number, patch: Record<string, unknown>) =>
      "project_id" in patch ? { ...patch, goal_id: null } : patch,
    );
    useStore.setState({
      goals: [goal({ id: 100, project_id: 7 })],
      tasks: [task({ id: 10, project_id: 7, goal_id: 100 })],
    });
    await useStore.getState().patchTask(10, { project_id: 8 });
    const moved = useStore.getState().tasks.find((t) => t.id === 10);
    expect(moved?.project_id).toBe(8);
    expect(moved?.goal_id).toBeNull();
  });

  it("drops a dead goal selection when a reload no longer has it", async () => {
    // Finding 4. An agent calling delete_goal arrives as a reload; init validated
    // the restored selection but reload did not, leaving the view pointed at a
    // goal that no longer exists — empty board, no band, no way back.
    db.fetchAll.mockImplementation(async () => ({
      ...emptyBoard(),
      projects: [{ id: 7, name: "p", color: "#000", position: 0, folder_path: null, code: "P" }],
    }));
    useStore.setState({ selection: { type: "goal", goalId: 100 } });
    await useStore.getState().reload();
    expect(useStore.getState().selection).toEqual({ type: "today" });
  });

  it("keeps a goal selection a reload still has", async () => {
    const survivor = goal({ id: 100, project_id: 7 });
    db.fetchAll.mockImplementation(async () => ({ ...emptyBoard(), goals: [survivor] }));
    useStore.setState({ selection: { type: "goal", goalId: 100 } });
    await useStore.getState().reload();
    expect(useStore.getState().selection).toEqual({ type: "goal", goalId: 100 });
  });
});

describe("removeGoal", () => {
  it("deletes the goal but keeps its tasks, returned to No goal", async () => {
    useStore.setState({
      goals: [goal({ id: 1, project_id: 7 })],
      tasks: [task({ id: 10, project_id: 7, goal_id: 1 }), task({ id: 11, goal_id: null })],
      selection: { type: "goal", goalId: 1 },
    });
    await useStore.getState().removeGoal(1);
    const { goals, tasks, selection } = useStore.getState();
    expect(goals).toHaveLength(0);
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.goal_id === null)).toBe(true);
    expect(selection).toEqual({ type: "project", projectId: 7 });
  });
});

describe("setGoalCompleted", () => {
  it("closes the goal without touching any task's status", async () => {
    useStore.setState({
      goals: [goal({ id: 1, project_id: 7 })],
      tasks: [task({ id: 10, project_id: 7, goal_id: 1, status: "doing" })],
      selection: { type: "goal", goalId: 1 },
    });
    await useStore.getState().setGoalCompleted(1, true);
    const { goals, tasks, selection } = useStore.getState();
    expect(goals[0].completed_at).not.toBeNull();
    expect(tasks[0].status).toBe("doing");
    // A closed goal leaves the sidebar, so the view steps back to its project.
    expect(selection).toEqual({ type: "project", projectId: 7 });
  });

  it("reopens a closed goal by clearing completed_at", async () => {
    useStore.setState({
      goals: [goal({ id: 1, project_id: 7, completed_at: "2026-08-19T00:00:00.000Z" })],
    });
    await useStore.getState().setGoalCompleted(1, false);
    expect(useStore.getState().goals[0].completed_at).toBeNull();
  });
});

describe("removeProject", () => {
  it("takes the project's goals with it and leaves no selection pointing at one", async () => {
    useStore.setState({
      projects: [
        { id: 7, name: "a", color: "#000", position: 0, folder_path: null, code: "A" },
        { id: 8, name: "b", color: "#000", position: 1, folder_path: null, code: "B" },
      ],
      goals: [goal({ id: 1, project_id: 7 }), goal({ id: 2, project_id: 8 })],
      tasks: [task({ id: 10, project_id: 7, goal_id: 1 })],
      selection: { type: "goal", goalId: 1 },
    });
    await useStore.getState().removeProject(7);
    const { goals, selection } = useStore.getState();
    expect(goals.map((g) => g.id)).toEqual([2]);
    expect(selection).toEqual({ type: "today" });
  });
});
