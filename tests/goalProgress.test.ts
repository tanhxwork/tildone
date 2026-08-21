import { describe, expect, it } from "bun:test";
import {
  goalProgress,
  goalsPageOrder,
  prunedGoalDismissals,
  tasksForSelection,
  ungoaledOpenCount,
} from "../src/selectors";
import type { Goal, Project, Task } from "../src/types";

// A goal's progress is derived on every read and never stored (migration 025),
// so the bar cannot drift from the tasks it describes. These are the rules that
// make that derivation trustworthy: trash is excluded outright, an archived
// completion still counts as done, and a task in no goal counts toward nothing.

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

describe("goalProgress", () => {
  it("counts done against total for one goal, ignoring other goals' tasks", () => {
    const tasks = [
      task({ goal_id: 5, status: "done" }),
      task({ goal_id: 5, status: "doing" }),
      task({ goal_id: 5, status: "todo" }),
      task({ goal_id: 9, status: "done" }),
      task({ goal_id: null, status: "done" }),
    ];
    expect(goalProgress(tasks, 5)).toEqual({ done: 1, total: 3, open: 2 });
  });

  it("excludes trashed tasks from both halves — a card in the trash is not owed", () => {
    const tasks = [
      task({ goal_id: 5, status: "done" }),
      task({ goal_id: 5, status: "todo", deleted_at: "2026-08-02T00:00:00.000Z" }),
      task({ goal_id: 5, status: "done", deleted_at: "2026-08-02T00:00:00.000Z" }),
    ];
    expect(goalProgress(tasks, 5)).toEqual({ done: 1, total: 1, open: 0 });
  });

  it("still counts an archived completion as done — moving it off the board does not un-finish it", () => {
    const tasks = [
      task({ goal_id: 5, status: "done", archived_at: "2026-08-02T00:00:00.000Z" }),
      task({ goal_id: 5, status: "todo" }),
    ];
    expect(goalProgress(tasks, 5)).toEqual({ done: 1, total: 2, open: 1 });
  });

  it("reports an empty goal as 0 of 0 rather than dividing by nothing", () => {
    expect(goalProgress([task({ goal_id: 9 })], 5)).toEqual({ done: 0, total: 0, open: 0 });
  });
});

describe("ungoaledOpenCount", () => {
  it("counts only this project's open, goal-less, live tasks", () => {
    const tasks = [
      task({ project_id: 1, goal_id: null, status: "todo" }),
      task({ project_id: 1, goal_id: null, status: "doing" }),
      task({ project_id: 1, goal_id: null, status: "done" }),
      task({ project_id: 1, goal_id: 5, status: "todo" }),
      task({ project_id: 2, goal_id: null, status: "todo" }),
      task({ project_id: 1, goal_id: null, status: "todo", deleted_at: "2026-08-02T00:00:00.000Z" }),
    ];
    expect(ungoaledOpenCount(tasks, 1)).toBe(2);
  });
});

describe("tasksForSelection with a goal", () => {
  it("returns that goal's live tasks, so every view mode filters for free", () => {
    const tasks = [
      task({ goal_id: 5 }),
      task({ goal_id: 5, deleted_at: "2026-08-02T00:00:00.000Z" }),
      task({ goal_id: 9 }),
      task({ goal_id: null }),
    ];
    const got = tasksForSelection(tasks, { type: "goal", goalId: 5 });
    expect(got).toHaveLength(1);
    expect(got[0].goal_id).toBe(5);
  });
});

describe("tasksForSelection with the No-goal row", () => {
  it("returns one project's un-goaled live tasks, and nothing from another", () => {
    const tasks = [
      task({ project_id: 1, goal_id: null }),
      task({ project_id: 1, goal_id: 5 }),
      task({ project_id: 1, goal_id: null, deleted_at: "2026-08-02T00:00:00.000Z" }),
      task({ project_id: 2, goal_id: null }),
      task({ project_id: null, goal_id: null }),
    ];
    const got = tasksForSelection(tasks, { type: "ungoaled", projectId: 1 });
    expect(got).toHaveLength(1);
    expect(got[0].project_id).toBe(1);
    expect(got[0].goal_id).toBeNull();
  });

  it("counts done tasks too — the row is a slice of the project, not a to-do list", () => {
    // ungoaledOpenCount drives the sidebar badge (open only); the selection
    // itself must still show the finished ones, or the board's Done column
    // empties the moment you click into it.
    const tasks = [
      task({ project_id: 1, goal_id: null, status: "done" }),
      task({ project_id: 1, goal_id: null, status: "todo" }),
    ];
    expect(tasksForSelection(tasks, { type: "ungoaled", projectId: 1 })).toHaveLength(2);
    expect(ungoaledOpenCount(tasks, 1)).toBe(1);
  });
});

function project(id: number, position: number): Project {
  return {
    id,
    name: `p${id}`,
    color: "#5645d4",
    position,
    folder_path: null,
    code: `P${id}`,
  };
}

describe("goalsPageOrder", () => {
  const TODAY = "2026-08-20";
  const PROJECTS = [project(1, 0), project(2, 1)];

  it("leads with overdue goals, soonest first", () => {
    const late = goal({ target_date: "2026-08-15" });
    const later = goal({ target_date: "2026-08-01" });
    const soon = goal({ target_date: "2026-09-01" });
    const order = goalsPageOrder([soon, late, later], PROJECTS, TODAY);
    expect(order.map((g) => g.target_date)).toEqual([
      "2026-08-01",
      "2026-08-15",
      "2026-09-01",
    ]);
  });

  it("puts untargeted goals after targeted ones, and completed goals last", () => {
    const undated = goal({ target_date: null });
    const dated = goal({ target_date: "2026-09-01" });
    const closed = goal({ target_date: "2026-08-01", completed_at: "2026-08-19T00:00:00.000Z" });
    const order = goalsPageOrder([undated, closed, dated], PROJECTS, TODAY);
    expect(order[0]).toBe(dated);
    expect(order[1]).toBe(undated);
    expect(order[2]).toBe(closed);
  });

  it("is a stable sort on position then id, and does not mutate its input", () => {
    const a = goal({ position: 1 });
    const b = goal({ position: 0 });
    const input = [a, b];
    const order = goalsPageOrder(input, PROJECTS, TODAY);
    expect(order.map((g) => g.position)).toEqual([0, 1]);
    expect(input).toEqual([a, b]);
  });

  it("treats a goal due today as on time, not overdue", () => {
    const today = goal({ target_date: TODAY });
    const yesterday = goal({ target_date: "2026-08-19" });
    expect(goalsPageOrder([today, yesterday], PROJECTS, TODAY)[0]).toBe(yesterday);
  });

  it("breaks ties on project position before the goal's own position", () => {
    // Regression, Codex verify TIL-204 finding 3: ordering fell straight through
    // to goal.position, so a goal sitting late inside the FIRST project lost to a
    // goal sitting first inside the SECOND one, interleaving the two projects.
    const inFirstProject = goal({ project_id: 1, position: 5, target_date: null });
    const inSecondProject = goal({ project_id: 2, position: 0, target_date: null });
    const order = goalsPageOrder([inSecondProject, inFirstProject], PROJECTS, TODAY);
    expect(order[0]).toBe(inFirstProject);
    expect(order[1]).toBe(inSecondProject);
  });

  it("sorts a goal whose project is missing last, not first", () => {
    const orphan = goal({ project_id: 999, position: 0, target_date: null });
    const real = goal({ project_id: 2, position: 9, target_date: null });
    expect(goalsPageOrder([orphan, real], PROJECTS, TODAY)[0]).toBe(real);
  });
});

describe("prunedGoalDismissals", () => {
  it("drops dismissals for goals that no longer exist, and keeps the live ones", () => {
    expect(prunedGoalDismissals({ 1: 3, 2: 5 }, [2])).toEqual({ 2: 5 });
  });

  it("returns null when nothing is stale, so settings are never rewritten needlessly", () => {
    expect(prunedGoalDismissals({ 7: 2 }, [7, 9])).toBeNull();
    expect(prunedGoalDismissals({}, [])).toBeNull();
  });

  it("clears everything when every goal is gone", () => {
    expect(prunedGoalDismissals({ 1: 1, 2: 2 }, [])).toEqual({});
  });
});
