import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Status, Tag, Task } from "../src/types";

// Landing in Done ends the review conversation: `blocked` asks the user to answer,
// `needs-review` asks them to check the work, and a card the user just completed
// carries neither question any more. Before this contract the tags rode along —
// the user checked out reviewed work, dragged the card to Done, and then had to
// x the stale "Needs review" pill off by hand. `needs-landing` is the exception
// by design: a done task can still hold an unmerged PR (TIL-84), so it survives.
//
// The Rust MCP server is the other writer of this database; its half of the same
// contract lives in agent.rs (apply_task_update). Keep the two in lockstep.

const EMPTY_BOARD = { projects: [], tasks: [], tags: [], subtasks: [] };

const updateTask = mock(async (_id: number, _patch: Record<string, unknown>) => {});
const setTaskTags = mock(async (_id: number, _tagIds: number[]) => {});
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
  setTaskTags,
  insertActivity,
}));

const { useStore } = await import("../src/store");

const BLOCKED: Tag = { id: 1, name: "blocked", color: "#888" };
// Tags are auto-created from agent-supplied names, so casing is not canonical.
const NEEDS_REVIEW: Tag = { id: 2, name: "Needs-Review", color: "#888" };
const NEEDS_LANDING: Tag = { id: 3, name: "needs-landing", color: "#888" };
const PLAIN: Tag = { id: 4, name: "frontend", color: "#888" };
const ALL_TAGS = [BLOCKED, NEEDS_REVIEW, NEEDS_LANDING, PLAIN];

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
    created_at: "2026-07-19T00:00:00.000Z",
    completed_at: null,
    deleted_at: null,
    archived_at: null,
    number: null,
    ref: null,
    unseen_at: null,
    tag_ids: [],
    ...over,
  } as Task;
}

function stateTagIds(id: number): number[] | undefined {
  return useStore.getState().tasks.find((t) => t.id === id)?.tag_ids;
}

beforeEach(() => {
  updateTask.mockClear();
  setTaskTags.mockClear();
  insertActivity.mockClear();
  useStore.setState({ tags: ALL_TAGS, selection: { type: "project", projectId: null } });
});

describe("patchTask: completing a task clears its stale review-cycle tags", () => {
  it("strips blocked and needs-review (any casing), keeps needs-landing and plain tags", async () => {
    useStore.setState({
      tasks: [task(1, { status: "doing", tag_ids: [1, 2, 3, 4] })],
    });

    await useStore.getState().patchTask(1, { status: "done" });

    expect(setTaskTags).toHaveBeenCalledWith(1, [3, 4]);
    expect(stateTagIds(1)).toEqual([3, 4]);
  });

  it("does not touch tags when none are review-cycle tags", async () => {
    useStore.setState({
      tasks: [task(1, { status: "doing", tag_ids: [3, 4] })],
    });

    await useStore.getState().patchTask(1, { status: "done" });

    expect(setTaskTags).not.toHaveBeenCalled();
    expect(stateTagIds(1)).toEqual([3, 4]);
  });

  it("leaves tags alone on transitions that do not land in Done", async () => {
    useStore.setState({
      tasks: [task(1, { status: "todo", tag_ids: [1, 2] })],
    });

    await useStore.getState().patchTask(1, { status: "doing" });

    expect(setTaskTags).not.toHaveBeenCalled();
    expect(stateTagIds(1)).toEqual([1, 2]);
  });

  it("leaves tags alone when a done task is patched without changing status", async () => {
    // A rename of an already-done card must not re-run the strip (or write tags at all).
    useStore.setState({
      tasks: [task(1, { status: "done", tag_ids: [2] })],
    });

    await useStore.getState().patchTask(1, { title: "renamed" });

    expect(setTaskTags).not.toHaveBeenCalled();
    expect(stateTagIds(1)).toEqual([2]);
  });
});

describe("applyDrag: dragging a card into Done clears its stale review-cycle tags", () => {
  it("strips blocked and needs-review from the dragged card", async () => {
    useStore.setState({
      selection: { type: "project", projectId: 7 },
      tasks: [task(1, { project_id: 7, status: "doing", tag_ids: [1, 2, 3, 4] })],
    });

    const columns = { todo: [], doing: [], done: [1] } as Record<Status, number[]>;
    await useStore.getState().applyDrag(1, columns);

    expect(setTaskTags).toHaveBeenCalledWith(1, [3, 4]);
    expect(stateTagIds(1)).toEqual([3, 4]);
  });

  it("does not touch tags on a reorder within Done", async () => {
    useStore.setState({
      selection: { type: "project", projectId: 7 },
      tasks: [
        task(1, { project_id: 7, status: "done", position: 0, tag_ids: [2] }),
        task(2, { project_id: 7, status: "done", position: 1 }),
      ],
    });

    const columns = { todo: [], doing: [], done: [2, 1] } as Record<Status, number[]>;
    await useStore.getState().applyDrag(1, columns);

    expect(setTaskTags).not.toHaveBeenCalled();
    expect(stateTagIds(1)).toEqual([2]);
  });
});
