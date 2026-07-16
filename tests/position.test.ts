import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Status, Task } from "../src/types";

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

mock.module("../src/db", () => ({ fetchAll, fetchActivity, updateTask, insertActivity }));

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

describe("applyPositions only writes rows that actually changed", () => {
  beforeEach(() => {
    updateTask.mockClear();
  });

  // A drag rewrites the index of every card in the column, but a within-column move
  // only actually shifts the cards between source and destination. The change-feed
  // trigger already suppresses no-op feed rows; this suppresses the wasted UPDATE
  // that would have fired it.
  it("skips the DB write for cards whose position is unchanged", async () => {
    useStore.setState({
      tasks: [
        task(1, { position: 0 }),
        task(2, { position: 1 }),
        task(3, { position: 2 }),
      ],
    });

    // Kanban always recomputes the whole column. Here cards 1 and 2 swap the top
    // two slots while card 3 keeps position 2 — so only 1 and 2 should hit the DB.
    await useStore.getState().applyPositions([
      { id: 2, status: "todo", position: 0 },
      { id: 1, status: "todo", position: 1 },
      { id: 3, status: "todo", position: 2 },
    ]);

    const written = updateTask.mock.calls.map((c) => c[0]);
    expect(written).toContain(1);
    expect(written).toContain(2);
    expect(written).not.toContain(3); // unchanged — no round-trip
  });

  it("still updates in-memory state for every card, changed or not", async () => {
    useStore.setState({
      tasks: [task(1, { position: 0 }), task(2, { position: 1 })],
    });

    await useStore.getState().applyPositions([
      { id: 1, status: "todo", position: 0 }, // unchanged
      { id: 2, status: "todo", position: 5 }, // moved
    ]);

    const tasks = useStore.getState().tasks;
    expect(tasks.find((t) => t.id === 2)?.position).toBe(5);
    expect(tasks.find((t) => t.id === 1)?.position).toBe(0);
  });

  it("writes a card that changes status even if its position index is the same", async () => {
    // Dragging todo/0 into an empty Done column: position stays 0 but status flips,
    // and completed_at must be set. A position-only diff would wrongly skip it.
    useStore.setState({ tasks: [task(1, { status: "todo", position: 0 })] });

    await useStore.getState().applyPositions([
      { id: 1, status: "done", position: 0 },
    ]);

    const patch = patchFor(1);
    expect(patch).toBeDefined();
    expect(patch?.status).toBe("done");
    expect(patch?.completed_at).not.toBeNull();
  });
});
