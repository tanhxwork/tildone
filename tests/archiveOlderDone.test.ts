import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Task } from "../src/types";

// The board's Done window is derived, but two writes back it: the "Move older off
// board" button (archiveOlderDone) stamps archived_at on not-today completions, and
// un-completing a task must clear that stamp so it is board-eligible again. Both run
// through the store against the DB layer, mocked here.

const updateTask = mock(async (_id: number, _patch: Partial<Task>) => {});
const insertActivity = mock(async () => {});
const fetchActivity = mock(async () => []);
const fetchComments = mock(async () => []);
const insertComment = mock(async () => ({}));
const fetchAll = mock(async () => ({ projects: [], tasks: [], tags: [], subtasks: [] }));

mock.module("../src/db", () => ({
  updateTask,
  insertActivity,
  fetchActivity,
  fetchComments,
  insertComment,
  fetchAll,
}));

const { useStore } = await import("../src/store");

let seq = 0;
function task(over: Partial<Task>): Task {
  seq += 1;
  return {
    id: seq,
    project_id: null,
    title: `task ${seq}`,
    notes: "",
    status: "done",
    priority: 0,
    due_date: null,
    position: -seq,
    created_at: "2020-01-01T00:00:00.000Z",
    completed_at: "2020-01-01T12:00:00.000Z",
    deleted_at: null,
    archived_at: null,
    tag_ids: [],
    ...over,
  };
}

function taskById(id: number): Task {
  return useStore.getState().tasks.find((t) => t.id === id)!;
}

beforeEach(() => {
  updateTask.mockClear();
  insertActivity.mockClear();
  useStore.setState({ tasks: [], projects: [] });
});

describe("archiveOlderDone", () => {
  it("stamps not-today completions and leaves today, archived, and non-done alone", async () => {
    const todayIso = new Date().toISOString(); // local today by construction
    const older = task({ status: "done", completed_at: "2020-01-01T12:00:00.000Z" });
    const todayDone = task({ status: "done", completed_at: todayIso });
    const alreadyArchived = task({
      status: "done",
      completed_at: "2020-02-01T12:00:00.000Z",
      archived_at: "2020-06-01T00:00:00.000Z",
    });
    const stillTodo = task({ status: "todo", completed_at: null });
    useStore.setState({ tasks: [older, todayDone, alreadyArchived, stillTodo] });

    await useStore.getState().archiveOlderDone();

    expect(taskById(older.id).archived_at).not.toBeNull();
    expect(taskById(todayDone.id).archived_at).toBeNull();
    expect(taskById(alreadyArchived.id).archived_at).toBe("2020-06-01T00:00:00.000Z");
    expect(taskById(stillTodo.id).archived_at).toBeNull();

    // Only the one eligible card is persisted.
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask.mock.calls[0][0]).toBe(older.id);
    expect(updateTask.mock.calls[0][1]).toHaveProperty("archived_at");
  });

  it("does nothing (no writes) when there is nothing older to clear", async () => {
    const todayDone = task({ status: "done", completed_at: new Date().toISOString() });
    useStore.setState({ tasks: [todayDone] });

    await useStore.getState().archiveOlderDone();

    expect(updateTask).not.toHaveBeenCalled();
  });
});

describe("patchTask clears archived_at when a task leaves Done", () => {
  it("un-completing an archived done task makes it board-eligible again", async () => {
    const t = task({
      status: "done",
      completed_at: "2020-01-01T12:00:00.000Z",
      archived_at: "2020-06-01T00:00:00.000Z",
    });
    useStore.setState({ tasks: [t] });

    await useStore.getState().patchTask(t.id, { status: "todo" });

    const after = taskById(t.id);
    expect(after.status).toBe("todo");
    expect(after.completed_at).toBeNull();
    expect(after.archived_at).toBeNull();

    const persisted = updateTask.mock.calls[0][1];
    expect(persisted.archived_at).toBeNull();
  });
});
