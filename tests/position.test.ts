import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Selection, Status, Task } from "../src/types";
import { computeDragUpdates } from "../src/reorder";

const NOW = "2026-07-16T09:00:00.000Z";

// `position` is an ordinal WITHIN one (project, status) group — never comparable
// across projects (see the RANK_SQL comment in src-tauri/src/agent.rs).
//
// It used to be computed only when a task was created. Every status or project
// change wrote the new group and carried the OLD position along, so a task made at
// todo/0 and completed landed on done/0, on top of whatever was already there. The
// Kanban sorts by `position, id`, so a tie silently falls through to id order and
// the user's manual ordering is gone. On the author's real board this had reached
// eight tasks sharing done/position 0.
//
// The store is one of two independent writers of this database (the Rust MCP server
// is the other), so these tests are the TS half of the same contract. The Rust half
// lives in agent.rs — keep them honest together.

const EMPTY_BOARD = { projects: [], tasks: [], tags: [], subtasks: [] };

const updateTask = mock(async (_id: number, _patch: Record<string, unknown>) => {});
const insertActivity = mock(async () => {});
const fetchAll = mock(async () => EMPTY_BOARD);
const fetchActivity = mock(async () => []);
const fetchComments = mock(async () => []);
const insertComment = mock(async () => ({}));

mock.module("../src/db", () => ({
  fetchAll,
  fetchActivity,
  fetchComments,
  insertComment,
  updateTask,
  insertActivity,
}));

const { useStore, groupSlot } = await import("../src/store");

function task(id: number, over: Partial<Task> = {}): Task {
  return {
    id,
    project_id: null,
    title: `t${id}`,
    notes: "",
    status: "todo",
    priority: 0,
    due_date: null,
    position: 0,
    created_at: "2026-07-16T00:00:00.000Z",
    completed_at: null,
    deleted_at: null,
    tag_ids: [],
    ...over,
  };
}

/** The patch the store last wrote for `id`. */
function patchFor(id: number): Record<string, unknown> | undefined {
  const call = [...updateTask.mock.calls].reverse().find((c) => c[0] === id);
  return call?.[1] as Record<string, unknown> | undefined;
}

describe("groupSlot", () => {
  it("puts the first card of an empty group at 0", () => {
    for (const status of ["todo", "doing", "done"] as Status[]) {
      expect(groupSlot([], null, status)).toBe(0);
    }
  });

  it("appends todo and doing at the bottom", () => {
    const tasks = [task(1, { position: 0 }), task(2, { position: 1 })];
    expect(groupSlot(tasks, null, "todo")).toBe(2);
  });

  it("inserts done at the top so the newest completion reads first", () => {
    const tasks = [
      task(1, { status: "done", position: 0 }),
      task(2, { status: "done", position: 5 }),
    ];
    expect(groupSlot(tasks, null, "done")).toBe(-1);
  });

  it("scopes the group by project, not just status", () => {
    const tasks = [
      task(1, { project_id: 7, position: 0 }),
      task(2, { project_id: 7, position: 1 }),
      task(3, { project_id: null, position: 9 }),
    ];
    // Project 7's next slot ignores the inbox card sitting at 9.
    expect(groupSlot(tasks, 7, "todo")).toBe(2);
    // And the inbox's next slot ignores project 7 entirely.
    expect(groupSlot(tasks, null, "todo")).toBe(10);
  });

  it("ignores trashed tasks, whose slots are free to reuse", () => {
    const tasks = [task(1, { position: 0 }), task(2, { position: 1, deleted_at: "x" })];
    expect(groupSlot(tasks, null, "todo")).toBe(1);
  });
});

describe("patchTask keeps positions distinct within a group", () => {
  beforeEach(() => {
    updateTask.mockClear();
    insertActivity.mockClear();
  });

  // The regression: before the fix this wrote no position at all, so the task kept
  // todo/0 and collided with the card already at done/0.
  it("gives a completed task a fresh slot at the top of Done", async () => {
    useStore.setState({
      tasks: [
        task(1, { position: 0 }), // todo/0 — about to be completed
        task(2, { status: "done", position: 0 }), // already holds done/0
      ],
    });

    await useStore.getState().patchTask(1, { status: "done" });

    const patch = patchFor(1);
    expect(patch?.position).toBe(-1);
    expect(patch?.position).not.toBe(0); // would have collided with task 2
    expect(useStore.getState().tasks.find((t) => t.id === 1)?.position).toBe(-1);
  });

  it("does not renumber the cards already in Done", async () => {
    useStore.setState({
      tasks: [
        task(1, { position: 0 }),
        task(2, { status: "done", position: 0 }),
        task(3, { status: "done", position: 1 }),
      ],
    });

    await useStore.getState().patchTask(1, { status: "done" });

    // A Done column grows without bound; completing must stay one write.
    expect(updateTask).toHaveBeenCalledTimes(1);
    const tasks = useStore.getState().tasks;
    expect(tasks.find((t) => t.id === 2)?.position).toBe(0);
    expect(tasks.find((t) => t.id === 3)?.position).toBe(1);
  });

  it("gives a reopened task a fresh slot instead of the one it left with", async () => {
    useStore.setState({
      tasks: [
        task(1, { status: "done", position: 0 }),
        task(2, { position: 0 }), // todo/0 is taken
      ],
    });

    await useStore.getState().patchTask(1, { status: "todo" });

    expect(patchFor(1)?.position).toBe(1);
  });

  it("gives a fresh slot when the project changes", async () => {
    useStore.setState({
      tasks: [
        task(1, { project_id: null, position: 0 }),
        task(2, { project_id: 7, position: 0 }), // project 7's todo/0 is taken
      ],
    });

    await useStore.getState().patchTask(1, { project_id: 7 });

    expect(patchFor(1)?.position).toBe(1);
  });

  it("leaves position alone when the group does not change", async () => {
    useStore.setState({ tasks: [task(1, { position: 3 })] });

    await useStore.getState().patchTask(1, { title: "renamed", priority: 2 });

    // Renaming a card must not move it.
    expect(patchFor(1)).not.toHaveProperty("position");
    expect(useStore.getState().tasks[0].position).toBe(3);
  });
});

// A drag only ever knows the *visible* (filtered) column, but `position` is a group
// ordinal. Writing the visible index straight through corrupts any group the column
// does not show in full: cross-project board views, and any single-project view with a
// filter active. computeDragUpdates reconstructs each full group from the store's task
// set instead. Pure function → tested directly; the store action applyDrag wraps it.
const cols = (over: Partial<Record<Status, number[]>>): Record<Status, number[]> => ({
  todo: [],
  doing: [],
  done: [],
  ...over,
});

describe("computeDragUpdates — single-group (project / inbox) views", () => {
  const project: Selection = { type: "project", projectId: 7 };

  it("reorders precisely: dragging card 3 to the top renumbers the group densely", () => {
    const tasks = [
      task(1, { project_id: 7, position: 0 }),
      task(2, { project_id: 7, position: 1 }),
      task(3, { project_id: 7, position: 2 }),
    ];
    // Visible column after the drag: 3 moved to the top.
    const updates = computeDragUpdates(tasks, project, 3, cols({ todo: [3, 1, 2] }), NOW);
    const pos = Object.fromEntries(updates.map((u) => [u.id, u.position]));
    expect(pos).toEqual({ 3: 0, 1: 1, 2: 2 });
  });

  // The core task-48 fix: a filter hides some of the group, but the drag must not
  // strand the hidden cards. Card 5 is hidden (filtered out); dragging 3 above 1 must
  // keep 5 between them in the full order, not renumber only the visible subset.
  it("preserves hidden filtered cards when reordering", () => {
    const tasks = [
      task(1, { project_id: 7, position: 0 }),
      task(5, { project_id: 7, position: 1 }), // hidden by a filter
      task(3, { project_id: 7, position: 2 }),
    ];
    // Only cards 1 and 3 are visible; the drag puts 3 above 1.
    const updates = computeDragUpdates(tasks, project, 3, cols({ todo: [3, 1] }), NOW);
    const pos = Object.fromEntries(updates.map((u) => [u.id, u.position]));
    // 3 first, then 1, and hidden 5 keeps its place after 1 — all distinct, dense.
    expect(pos[3]).toBeLessThan(pos[1]);
    expect(pos[1]).toBeLessThan(pos[5]);
    const values = Object.values(pos).sort((a, b) => a - b);
    expect(values).toEqual([0, 1, 2]); // dense, no duplicates
  });

  it("sets completed_at when a drag crosses into Done", () => {
    const tasks = [task(1, { project_id: 7, status: "todo", position: 0 })];
    const updates = computeDragUpdates(tasks, project, 1, cols({ done: [1] }), NOW);
    expect(updates[0].status).toBe("done");
    expect(updates[0].completed_at).toBe(NOW);
  });
});

describe("computeDragUpdates — mixed (all / today / upcoming) views", () => {
  const all: Selection = { type: "all" };

  // The product decision: in a mixed column a drag moves ONLY the dragged card, to the
  // top or bottom of its OWN project group by which half it was dropped in. Other
  // projects are never touched — no flattening.
  it("never repositions another project's cards", () => {
    const tasks = [
      task(1, { project_id: 7, position: 0 }),
      task(2, { project_id: 8, position: 0 }), // different project, also at 0 — legal
      task(3, { project_id: 7, position: 1 }),
    ];
    // Drag card 3 (project 7) around a column that interleaves projects 7 and 8.
    const updates = computeDragUpdates(tasks, all, 3, cols({ todo: [3, 2, 1] }), NOW);
    // Only card 3 is written; project 8's card 2 and sibling card 1 are untouched.
    expect(updates.map((u) => u.id)).toEqual([3]);
  });

  it("drops to the TOP of its own group when released in the top half", () => {
    const tasks = [
      task(1, { project_id: 7, position: 0 }),
      task(2, { project_id: 7, position: 1 }),
      task(3, { project_id: 7, position: 2 }),
    ];
    // Column [3,1,2]: card 3 at index 0 → top half → top of group (min-1).
    const updates = computeDragUpdates(tasks, all, 3, cols({ todo: [3, 1, 2] }), NOW);
    expect(updates).toEqual([
      { id: 3, status: "todo", position: -1, completed_at: null },
    ]);
  });

  it("drops to the BOTTOM of its own group when released in the bottom half", () => {
    const tasks = [
      task(1, { project_id: 7, position: 0 }),
      task(2, { project_id: 7, position: 1 }),
      task(3, { project_id: 7, position: 2 }),
    ];
    // Column [1,2,3]: card 3 at index 2 of 3 → bottom half → bottom of group. Group
    // members excluding card 3 sit at 0 and 1, so bottom is max+1 = 2.
    const updates = computeDragUpdates(tasks, all, 3, cols({ todo: [1, 2, 3] }), NOW);
    expect(updates).toEqual([
      { id: 3, status: "todo", position: 2, completed_at: null },
    ]);
  });
});

describe("applyDrag writes only rows that changed", () => {
  beforeEach(() => {
    updateTask.mockClear();
    useStore.setState({ selection: { type: "project", projectId: 7 } });
  });

  it("skips the DB write for cards whose slot is unchanged", async () => {
    useStore.setState({
      tasks: [
        task(1, { project_id: 7, position: 0 }),
        task(2, { project_id: 7, position: 1 }),
        task(3, { project_id: 7, position: 2 }),
      ],
    });
    // Swap the top two; card 3 keeps position 2.
    await useStore.getState().applyDrag(2, cols({ todo: [2, 1, 3] }));

    const written = updateTask.mock.calls.map((c) => c[0]);
    expect(written).toContain(1);
    expect(written).toContain(2);
    expect(written).not.toContain(3);
  });

  it("writes a status change even when the position index is unchanged", async () => {
    // Drag the only todo card into an empty Done column: position stays 0, but status
    // flips and completed_at must land. A position-only diff would wrongly skip it.
    useStore.setState({
      tasks: [task(1, { project_id: 7, status: "todo", position: 0 })],
    });
    await useStore.getState().applyDrag(1, cols({ done: [1] }));

    const patch = patchFor(1);
    expect(patch?.status).toBe("done");
    expect(patch?.completed_at).not.toBeNull();
  });
});
