import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Project, Task } from "../src/types";
import { db, resetDbMock, useStore } from "./support/dbMock";

// Client mode with the hub down: task-level writes queue as operations (a db.ts
// function name and its arguments), the rest is refused, and the queue replays on the
// hub in order when it is back. Rust's two file commands and the hub's SQL are the
// only things mocked besides db.ts itself.

const files = new Map<string, string>();
let hubNotes = "";

const realCore = await import("@tauri-apps/api/core");
mock.module("@tauri-apps/api/core", () => ({
  ...realCore,
  invoke: async (cmd: string, args: { name?: string; json?: string } = {}) => {
    if (cmd === "offline_read") return files.get(args.name!) ?? null;
    if (cmd === "offline_write") return void files.set(args.name!, args.json!);
    throw new Error("hub http://hub: unreachable: connection refused");
  },
}));
mock.module("../src/remoteDb", () => ({
  remoteDb: { select: async () => [{ notes: hubNotes }], execute: async () => ({}) },
}));

const { setBoardHubUrl } = await import("../src/hubMode");
const offline = await import("../src/offline");
const { useOffline, loadOutbox, comeBack, filesSettled } = offline;
const gated = offline.db;

const DOWN = new Error("hub http://hub: unreachable: connection refused");
const saved = () => JSON.parse(files.get("outbox") ?? '{"ops":[]}') as { ops: { fn: string }[] };
const calls = (...fns: (keyof typeof db)[]) =>
  fns.flatMap((fn) => db[fn].mock.calls.map((args: unknown[]) => [fn, ...args]));

function task(id: number, notes = ""): Task {
  return { id, project_id: 1, goal_id: null, title: `t${id}`, notes, status: "todo", tag_ids: [] } as unknown as Task;
}

beforeEach(async () => {
  resetDbMock();
  files.clear();
  hubNotes = "";
  setBoardHubUrl("http://hub");
  await loadOutbox();
  useOffline.setState({ offline: false, lastSynced: null, dropped: 0 });
  useStore.setState({
    projects: [{ id: 1, name: "Tildone", code: "TIL" } as Project],
    tasks: [],
    subtasks: [],
    links: {},
  });
});

afterAll(() => {
  setBoardHubUrl("");
  useOffline.setState({ offline: false });
});

describe("offline queue", () => {
  it("queues the task-level operations and refuses the rest", async () => {
    // The hub drops without a status event: the first write finds out, and is queued.
    db.updateTask.mockRejectedValueOnce(DOWN);
    expect(await gated.updateTask(1, { title: "x" })).toEqual({ title: "x" });
    expect(useOffline.getState().offline).toBe(true);

    const made = await gated.insertTask({ project_id: 1, title: "n" } as never);
    expect(made).toMatchObject({ id: -2, ref: "TIL-?", goal_id: null });
    await gated.insertSubtask(1, "s", 0);
    await gated.insertComment(1, "c");
    await gated.addLink(1, "https://e.com", "e", "other");
    for (const call of [
      () => gated.deleteTask(1),
      () => gated.updateSubtask(1, { done: true }),
      () => gated.deleteSubtask(1),
      () => gated.deleteLink(1),
      () => gated.setTaskTags(1, [2]),
      () => gated.insertActivity(1, "l", "t"),
    ]) await call();
    await filesSettled();
    expect(saved().ops).toHaveLength(11);
    expect(useOffline.getState().waiting).toBe(10); // the activity line is not a change
    expect(db.insertTask).not.toHaveBeenCalled();

    for (const call of [
      () => gated.insertProject("p", "#fff", "meadow"),
      () => gated.deleteGoal(1),
      () => gated.mergeTags(1, 2),
      () => gated.deleteAllTrashed(),
      () => gated.insertImage(1, {} as never),
    ]) await expect(call()).rejects.toThrow("Not available offline");
    expect(db.insertProject).not.toHaveBeenCalled();
    expect(await gated.fetchComments(1)).toEqual([]);

    // A restart finds the queue on disk; local mode is untouched by all of this.
    useOffline.setState({ waiting: 0 });
    await loadOutbox();
    expect(useOffline.getState().waiting).toBe(10);
    setBoardHubUrl("");
    await gated.deleteTask(9);
    expect(db.deleteTask).toHaveBeenCalledWith(9);
  });

  it("remaps temporary ids on replay", async () => {
    useOffline.setState({ offline: true });
    const s = useStore.getState();
    const first = await s.addTask({ title: "a", project_id: 1, due_date: null, tag_ids: [4] });
    const second = await s.addTask({ title: "b", project_id: 1, due_date: null, from_task_id: first });
    await s.addSubtask(first, "step");
    await s.addLink(first, "https://github.com/x/y/pull/1");
    await s.addComment(first, "hello");
    await s.patchTask(first, { title: "renamed" });
    expect(useStore.getState().tasks.find((t) => t.id === first)?.ref).toBe("TIL-?");

    db.insertTask.mockResolvedValueOnce({ id: 50, number: 3, ref: "TIL-3", goal_id: null });
    db.insertTask.mockResolvedValueOnce({ id: 51, number: 4, ref: "TIL-4", goal_id: null });
    db.insertSubtask.mockResolvedValueOnce(77);
    await comeBack();

    expect(db.insertTask.mock.calls[1][0]).toMatchObject({ from_task_id: 50 });
    expect(db.setTaskTags).toHaveBeenCalledWith(50, [4]);
    expect(db.insertSubtask).toHaveBeenCalledWith(50, "step", 0);
    expect(db.addLink.mock.calls[0][0]).toBe(50);
    expect(db.insertComment).toHaveBeenCalledWith(50, "hello");
    expect(db.updateTask).toHaveBeenCalledWith(50, expect.objectContaining({ title: "renamed" }));
    expect(second).toBeLessThan(0);
    await filesSettled();
    // Done: the queue is empty on disk, the banner state is clear, the hub's board is shown.
    expect(saved().ops).toEqual([]);
    expect(useOffline.getState()).toMatchObject({ offline: false, waiting: 0 });
    expect(db.fetchAll).toHaveBeenCalled();
  });

  it("keeps the hub's notes and comments the offline version", async () => {
    useOffline.setState({ offline: true });
    useStore.setState({ tasks: [task(5, "base")] });
    await gated.updateTask(5, { notes: "mine", title: "T" });
    await gated.updateTask(5, { notes: "mine again" });

    // The hub's notes still equal the version the first edit started from: it goes in.
    hubNotes = "base";
    // ...then an agent appends before the second edit replays: that one is kept as a comment.
    db.updateTask.mockImplementationOnce(async (_id, patch) => {
      hubNotes = "base + agent";
      return patch;
    });
    await comeBack();

    expect(db.updateTask.mock.calls[0]).toEqual([5, { notes: "mine", title: "T" }]);
    expect(db.updateTask.mock.calls[1]).toEqual([5, {}]);
    expect(db.insertComment).toHaveBeenCalledTimes(1);
    expect(db.insertComment.mock.calls[0][1]).toContain("mine again");
  });

  it("replays in order, drops rejected, stops on unreachable", async () => {
    useOffline.setState({ offline: true });
    const a = (await gated.insertTask({ project_id: 1, title: "a" } as never)) as { id: number };
    await gated.insertSubtask(a.id, "child", 0); // names a task whose creation will be rejected
    await gated.updateTask(1, { title: "one" });
    await gated.deleteTask(2);
    await gated.deleteTask(3);

    db.insertTask.mockRejectedValueOnce(new Error("SQL: constraint failed"));
    db.deleteTask.mockRejectedValueOnce(DOWN);
    await comeBack();

    expect(calls("insertTask", "insertSubtask", "updateTask", "deleteTask").map(([fn]) => fn)).toEqual([
      "insertTask",
      "updateTask",
      "deleteTask",
    ]);
    // The rejected create and the subtask that hung on it are dropped and counted;
    // the op that hit the dead hub stays, with everything after it.
    expect(useOffline.getState()).toMatchObject({ offline: true, dropped: 2, waiting: 2 });
    await filesSettled();
    expect(saved().ops.map((o) => o.fn)).toEqual(["deleteTask", "deleteTask"]);

    await comeBack();
    expect(db.deleteTask.mock.calls.map((c) => c[0])).toEqual([2, 2, 3]);
    expect(useOffline.getState()).toMatchObject({ offline: false, waiting: 0 });
  });
});
