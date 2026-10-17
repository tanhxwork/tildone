import { describe, expect, it } from "bun:test";
import {
  FOCUS_WINDOW_MS,
  MOVING_WINDOW_MS,
  STALLED_AFTER_MS,
  focusModel,
  lastMoved,
} from "../src/focusViews";
import { needsYouKind, nameIndex } from "../src/ownerViews";
import type { Goal, Project, Tag, Task } from "../src/types";

// The focus compass slices the live board into where the user is going (goals with
// a recent move), what is moving toward each, and what moves with no goal. A fixed
// `now` keeps every window deterministic; `ago` places a move relative to it.

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

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
    // Old by default, so only a test's own activity or created_at moves a card.
    created_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    deleted_at: null,
    archived_at: null,
    number: seq,
    ref: `TIL-${seq}`,
    unseen_at: null,
    owner: "human",
    from_task_id: null,
    kind: "task",
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
    created_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    ...opts,
  };
}

function project(id: number, position: number): Project {
  return {
    id,
    name: `project ${id}`,
    color: "#000",
    position,
    folder_path: null,
    code: `P${id}`,
    environment: "meadow",
  };
}

const tags: Tag[] = [
  { id: 1, name: "Blocked", color: "#e03131" },
  { id: 2, name: "needs-approval", color: "#dd5b00" },
  { id: 3, name: "human-verify", color: "#5645d4" },
];
const projects = [project(1, 0), project(2, 1), project(3, 2)];

function model(tasks: Task[], goals: Goal[], lastActivity: Record<number, string> = {}) {
  return focusModel({ tasks, goals, projects, tags, lastActivity, now: NOW });
}

describe("lastMoved", () => {
  it("takes the newest of activity, creation and completion, whatever the timestamp format", () => {
    const t = task({ created_at: ago(5 * DAY), completed_at: ago(4 * DAY) });
    // SQLite's marker-less UTC must not be read as local time.
    expect(lastMoved(t, { [t.id]: "2026-10-17 10:00:00" })).toBe(Date.parse("2026-10-17T10:00:00Z"));
    expect(lastMoved(t, {})).toBe(NOW - 4 * DAY);
  });
});

describe("focus goals", () => {
  it("lists goals with a move in the window newest first, then finished goals gone stale", () => {
    const fresh = goal({ notes: "Ship the thing\n\nmore detail" });
    const fresher = goal();
    const stale = goal();
    const staleDone = goal();
    const closed = goal({ completed_at: ago(DAY) });
    const orphan = goal({ project_id: 99 });
    const tasks = [
      task({ goal_id: fresh.id, status: "doing" }),
      task({ goal_id: fresh.id }),
      task({ goal_id: fresher.id, status: "doing" }),
      task({ goal_id: stale.id, status: "doing" }),
      task({ goal_id: staleDone.id, status: "done" }),
      task({ goal_id: closed.id, status: "doing" }),
      task({ goal_id: orphan.id, status: "doing" }),
    ];
    const lastActivity = {
      [tasks[0].id]: ago(3 * DAY),
      [tasks[2].id]: ago(DAY),
      [tasks[3].id]: ago(FOCUS_WINDOW_MS + 1),
      [tasks[4].id]: ago(30 * DAY),
      [tasks[5].id]: ago(DAY),
      [tasks[6].id]: ago(DAY),
    };
    const m = model(tasks, [fresh, fresher, stale, staleDone, closed, orphan], lastActivity);
    expect(m.goals.map((g) => g.goal.id)).toEqual([fresher.id, fresh.id, staleDone.id]);
    expect(m.goals[1]).toMatchObject({ done: 0, total: 2, open: 2, finished: false });
    expect(m.goals[1].outcome).toBe("Ship the thing");
  });

  it("keeps a move exactly at the window edge and drops one past it", () => {
    const edge = goal();
    const past = goal();
    const tasks = [task({ goal_id: edge.id }), task({ goal_id: past.id })];
    const m = model(tasks, [edge, past], {
      [tasks[0].id]: ago(FOCUS_WINDOW_MS),
      [tasks[1].id]: ago(FOCUS_WINDOW_MS + 1),
    });
    expect(m.goals.map((g) => g.goal.id)).toEqual([edge.id]);
  });

  it("writes the meta line: close it, 1 card left, else the outcome's first line", () => {
    const done = goal();
    const one = goal();
    const many = goal({ notes: "\n  First line\nsecond" });
    const none = goal();
    const tasks = [
      task({ goal_id: done.id, status: "done", completed_at: ago(DAY) }),
      task({ goal_id: one.id, status: "done", completed_at: ago(DAY) }),
      task({ goal_id: one.id, created_at: ago(DAY) }),
      task({ goal_id: many.id, created_at: ago(DAY) }),
      task({ goal_id: many.id, created_at: ago(DAY) }),
      task({ goal_id: none.id, created_at: ago(DAY) }),
      task({ goal_id: none.id, created_at: ago(DAY) }),
    ];
    const metas = Object.fromEntries(
      model(tasks, [done, one, many, none]).goals.map((g) => [g.goal.id, g.meta]),
    );
    expect(metas).toEqual({
      [done.id]: "close it?",
      [one.id]: "1 card left",
      [many.id]: "First line",
      [none.id]: "",
    });
  });

  it("splits a goal's cards into moving (newest first, unsliced) and needs-you", () => {
    const g = goal();
    const old = task({ goal_id: g.id, status: "doing" });
    const newer = task({ goal_id: g.id, status: "doing" });
    const newest = task({ goal_id: g.id, status: "todo", tag_ids: [1] });
    const outside = task({ goal_id: g.id, status: "doing" });
    const done = task({ goal_id: g.id, status: "done", tag_ids: [3], completed_at: ago(DAY) });
    const m = model([old, newer, newest, outside, done], [g], {
      [old.id]: ago(MOVING_WINDOW_MS),
      [newer.id]: ago(3_600_000),
      [newest.id]: ago(60_000),
      [outside.id]: ago(MOVING_WINDOW_MS + 1),
    });
    const [fg] = m.goals;
    expect(fg.moving.map((c) => c.task.id)).toEqual([newest.id, newer.id, done.id, old.id]);
    expect(fg.needsYou.map((c) => [c.task.id, c.needsYou])).toEqual([[newest.id, "decide"]]);
    expect(fg.lastMovedAt).toBe(NOW - 60_000);
  });
});

describe("needsYouKind", () => {
  const names = nameIndex(tags);

  it("names what the user must do, first match wins, and nothing once done", () => {
    expect(needsYouKind(task({ tag_ids: [1] }), names)).toBe("decide");
    expect(needsYouKind(task({ tag_ids: [2] }), names)).toBe("decide");
    expect(needsYouKind(task({ tag_ids: [3] }), names)).toBe("verify");
    expect(needsYouKind(task({ tag_ids: [3, 1] }), names)).toBe("decide");
    expect(needsYouKind(task({ owner: "agent", tag_ids: [3] }), names)).toBe("verify");
    expect(needsYouKind(task({ owner: "agent", tag_ids: [2] }), names)).toBe("approve");
    expect(needsYouKind(task({ owner: "agent", tag_ids: [1] }), names)).toBeNull();
    expect(needsYouKind(task(), names)).toBeNull();
    expect(needsYouKind(task({ tag_ids: [3], status: "done" }), names)).toBeNull();
  });

  it("counts every live card that waits on the user", () => {
    const tasks = [
      task({ tag_ids: [1] }),
      task({ owner: "agent", tag_ids: [2] }),
      task({ tag_ids: [3], deleted_at: ago(DAY) }),
      task({ tag_ids: [3], status: "done" }),
    ];
    expect(model(tasks, []).needsYou).toBe(2);
  });
});

describe("loose", () => {
  it("lists doing cards with no goal moved within two days, newest first, Inbox included", () => {
    const g = goal();
    const older = task({ status: "doing" });
    const newer = task({ status: "doing", project_id: null });
    const m = model(
      [
        older,
        newer,
        task({ status: "doing", goal_id: g.id, created_at: ago(60_000) }),
        task({ status: "todo", created_at: ago(60_000) }),
        task({ status: "doing" }),
      ],
      [g],
      { [older.id]: ago(DAY), [newer.id]: ago(60_000) },
    );
    expect(m.loose.map((c) => c.task.id)).toEqual([newer.id, older.id]);
  });
});

describe("stalled", () => {
  it("lists doing cards with no move for a week, oldest first", () => {
    const stalled = task({ status: "doing" });
    const stalledOlder = task({ status: "doing" });
    const fresh = task({ status: "doing" });
    const todo = task({ status: "todo" });
    const m = model([stalled, stalledOlder, fresh, todo], [], {
      [stalled.id]: ago(STALLED_AFTER_MS + 1),
      [stalledOlder.id]: ago(20 * DAY),
      [fresh.id]: ago(STALLED_AFTER_MS),
    });
    expect(m.stalled.map((t) => t.id)).toEqual([stalledOlder.id, stalled.id]);
  });
});

describe("active and quiet", () => {
  it("counts cards moved in the window per project, newest move first; the rest are quiet in position order", () => {
    const a = task({ project_id: 2, created_at: ago(3 * DAY) });
    const b = task({ project_id: 2, created_at: ago(2 * DAY) });
    const c = task({ project_id: 1, created_at: ago(DAY) });
    const old = task({ project_id: 1 });
    const m = model([a, b, c, old, task({ project_id: 3, deleted_at: ago(DAY) })], []);
    expect(m.active.map((p) => [p.project.id, p.moved])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(m.quiet.map((p) => p.id)).toEqual([3]);
    expect(m.movedThisWeek).toBe(3);
  });
});

describe("looseByProject", () => {
  it("groups goal-less cards moved this week by project, most first, Inbox as null", () => {
    const g = goal({ project_id: 2 });
    const m = model(
      [
        task({ project_id: 2, created_at: ago(DAY) }),
        task({ project_id: 2, created_at: ago(2 * DAY) }),
        task({ project_id: 2, goal_id: g.id, created_at: ago(DAY) }),
        task({ project_id: 1, created_at: ago(DAY) }),
        task({ project_id: null, created_at: ago(DAY) }),
        task({ project_id: 1, created_at: ago(FOCUS_WINDOW_MS + 1) }),
      ],
      [g],
    );
    expect(m.looseByProject.map((r) => [r.project?.id ?? null, r.count])).toEqual([
      [2, 2],
      [null, 1],
      [1, 1],
    ]);
    expect(m.movedNoGoal).toBe(4);
    expect(m.movedThisWeek).toBe(5);
  });
});

describe("empty", () => {
  it("returns empty lists and zeros", () => {
    expect(focusModel({ tasks: [], goals: [], projects: [], tags: [], lastActivity: {}, now: NOW })).toEqual({
      goals: [],
      loose: [],
      looseByProject: [],
      movedThisWeek: 0,
      movedNoGoal: 0,
      needsYou: 0,
      stalled: [],
      active: [],
      quiet: [],
    });
  });
});
