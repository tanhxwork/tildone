import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Project, Task } from "../src/types";
import { db, resetDbMock, useStore } from "./support/dbMock";

// Client mode with the hub down: task-level writes queue as operations (a db.ts
// function name and its arguments), the rest is refused, and the queue replays on the
// hub in order when it is back. Rust's two file commands and the hub's SQL are the
// only things mocked besides db.ts itself.

const files = new Map<string, string>();
let hubNotes = "";

// The hub's /sql as the client sees it. A write sent with an op key that the hub has
// already run returns the stored result and does not run again, as the real hub does.
// `loseOnce`: the next write starting with this runs, then its response is lost.
const hub = {
  sent: [] as { sql: string; op?: string }[],
  ran: [] as string[],
  stored: new Map<string, unknown>(),
  lastId: 100,
  loseOnce: "",
};
const resetHub = () => Object.assign(hub, { sent: [], ran: [], stored: new Map(), lastId: 100, loseOnce: "" });

const realCore = await import("@tauri-apps/api/core");
mock.module("@tauri-apps/api/core", () => ({
  ...realCore,
  invoke: async (cmd: string, args: { name?: string; json?: string; kind?: string; sql?: string; op?: string } = {}) => {
    if (cmd === "hub_sql" && args.kind === "select") return [{ notes: hubNotes }];
    if (cmd === "hub_sql") {
      hub.sent.push({ sql: args.sql!, op: args.op });
      if (args.op && hub.stored.has(args.op)) return hub.stored.get(args.op);
      const result = { rowsAffected: 1, lastInsertId: ++hub.lastId };
      hub.ran.push(args.sql!);
      if (args.op) hub.stored.set(args.op, result);
      if (hub.loseOnce && args.sql!.startsWith(hub.loseOnce)) {
        hub.loseOnce = "";
        throw new Error("hub http://hub: unreachable: connection lost");
      }
      return result;
    }
    if (cmd === "offline_read") return files.get(args.name!) ?? null;
    if (cmd === "offline_write") return void files.set(args.name!, args.json!);
    throw new Error("hub http://hub: unreachable: connection refused");
  },
}));

const { setBoardHubUrl } = await import("../src/hubMode");
const { remoteDb } = await import("../src/remoteDb");
const offline = await import("../src/offline");
const { useOffline, loadOutbox, loadBoardCopy, comeBack, flushCopy, filesSettled } = offline;
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
  resetHub();
  setBoardHubUrl("http://hub");
  await loadOutbox();
  useOffline.setState({ offline: false, lastSynced: null, dropped: 0, notice: "" });
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

    // A move to another project clears the goal on screen, as the hub will on replay.
    useStore.setState({ tasks: [{ ...task(1), goal_id: 9 }] });
    expect(await gated.updateTask(1, { project_id: 2 })).toEqual({ project_id: 2, goal_id: null });

    const made = await gated.insertTask({ project_id: 1, title: "n" } as never);
    expect(made).toMatchObject({ id: -3, ref: "TIL-?", goal_id: null });
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
    expect(saved().ops).toHaveLength(12);
    expect(useOffline.getState().waiting).toBe(11); // the activity line is not a change
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
    expect(useOffline.getState().notice).toBe("Not available offline");

    // A restart finds the queue on disk; local mode is untouched by all of this.
    useOffline.setState({ waiting: 0 });
    await loadOutbox();
    expect(useOffline.getState().waiting).toBe(11);
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
    // The hub drops right after the comment went in: the queue on disk must already
    // hold the op without the notes, so the retry cannot comment twice.
    db.updateTask.mockRejectedValueOnce(DOWN);
    await comeBack();
    await filesSettled();
    expect(saved().ops).toEqual([{ fn: "updateTask", args: [5, {}], key: expect.any(String) }]);
    expect(db.insertComment).toHaveBeenCalledTimes(1);
    await comeBack();

    expect(db.updateTask.mock.calls[0]).toEqual([5, { notes: "mine", title: "T" }]);
    expect(db.updateTask.mock.calls[2]).toEqual([5, {}]);
    expect(db.insertComment).toHaveBeenCalledTimes(1);
    expect(db.insertComment.mock.calls[0][1]).toContain("mine again");
  });

  it("replays in order, drops rejected, stops on unreachable", async () => {
    useOffline.setState({ offline: true });
    const a = (await gated.insertTask({ project_id: 1, title: "a" } as never)) as { id: number };
    await gated.insertSubtask(a.id, "child", 0); // names a task whose creation will be rejected
    await gated.insertActivity(a.id, "Task created", "t"); // dropped with it, but not counted
    await gated.updateTask(1, { title: "one" });
    await gated.deleteTask(2);
    await gated.deleteTask(3);
    expect(useOffline.getState().waiting).toBe(5);

    db.insertTask.mockRejectedValueOnce(new Error("SQL: constraint failed"));
    db.deleteTask.mockRejectedValueOnce(DOWN);
    await comeBack();

    expect(calls("insertTask", "insertSubtask", "insertActivity", "updateTask", "deleteTask").map(([fn]) => fn)).toEqual([
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

  it("shows the changes waiting after a restart: the copy is re-saved from the board on screen", async () => {
    // Offline since the last sync at 10:00; the user adds a task, then the app restarts.
    useOffline.setState({ offline: true, lastSynced: "2026-01-01T10:00:00.000Z" });
    const id = await useStore.getState().addTask({ title: "Queued", project_id: 1, due_date: null });
    await useStore.getState().addTask({ title: "Second", project_id: 1, due_date: null });
    expect(files.has("board-copy")).toBe(false); // debounced: not once per write
    flushCopy();
    await filesSettled();

    const copy = await loadBoardCopy();
    expect(copy?.syncedAt).toBe("2026-01-01T10:00:00.000Z");
    expect(copy?.data.tasks.map((t) => [t.id, t.title, t.ref])).toEqual([
      [id, "Queued", "TIL-?"],
      [id - 1, "Second", "TIL-?"],
    ]);
  });

  it("writes a board the hub just gave us at once", async () => {
    await gated.fetchAll(); // no debounce: a quit right after must not leave an older copy
    await filesSettled();
    const copy = await loadBoardCopy();
    expect(copy?.syncedAt).toBe(useOffline.getState().lastSynced!);
    expect(copy?.data.tasks).toEqual([]);
  });

  it("never replays or opens what belongs to another hub", async () => {
    const theirs = JSON.stringify({
      hub: "http://other",
      nextTemp: -3,
      ops: [{ fn: "deleteTask", args: [17] }, { fn: "insertActivity", args: [17, "x", "t"] }],
      ids: {},
    });
    files.set("outbox", theirs);
    files.set("board-copy", JSON.stringify({ hub: "http://other", syncedAt: "t", data: {} }));
    await loadOutbox();
    expect(useOffline.getState()).toMatchObject({ waiting: 0, foreign: { hub: "http://other", count: 1 } });
    expect(await loadBoardCopy()).toBeNull();

    // This hub is down: nothing replays, and a write is refused rather than
    // overwriting the other hub's queue.
    useOffline.setState({ offline: true });
    await comeBack(); // the hub answers: nothing of the other hub's goes up
    expect(db.deleteTask).not.toHaveBeenCalled();
    useOffline.setState({ offline: true });
    await expect(gated.deleteTask(1)).rejects.toThrow("1 change queued for http://other waits");
    expect(db.deleteTask).not.toHaveBeenCalled();
    await filesSettled();
    expect(files.get("outbox")).toBe(theirs);

    // Back on that hub, its queue is ours again.
    setBoardHubUrl("http://other");
    await loadOutbox();
    expect(useOffline.getState()).toMatchObject({ waiting: 1, foreign: null });
    await comeBack();
    expect(db.deleteTask).toHaveBeenCalledWith(17);
  });

  it("keeps the temporary ids mapped until the reload has put the real ones on screen", async () => {
    useOffline.setState({ offline: true });
    const made = (await gated.insertTask({ project_id: 1, title: "a" } as never)) as { id: number };
    db.insertTask.mockResolvedValueOnce({ id: 50, number: 1, ref: "TIL-1", goal_id: null });
    db.fetchAll.mockRejectedValueOnce(new Error("SQL: database is locked"));
    await comeBack(); // the replay works, the reload after it fails

    // The screen still has the temporary id; an edit made now reaches the real task.
    await gated.updateTask(made.id, { title: "x" });
    expect(db.updateTask).toHaveBeenCalledWith(50, { title: "x" });

    await useStore.getState().reload(); // the next good reload settles the ids
    await expect(gated.updateTask(made.id, { title: "y" })).rejects.toThrow("dropped");
  });
  it("lands a queued write once when the hub ran it and the response was lost", async () => {
    useOffline.setState({ offline: true });
    const made = (await gated.insertTask({ project_id: 1, title: "a" } as never)) as { id: number };
    await gated.updateTask(made.id, { title: "b" });

    // The insert goes through remoteDb like the real db.ts does.
    const insert = async () => {
      const r = await remoteDb.execute("INSERT INTO tasks (title) VALUES ($1)", ["a"]);
      return { id: r.lastInsertId!, number: 1, ref: "TIL-1", goal_id: null };
    };
    db.insertTask.mockImplementationOnce(insert).mockImplementationOnce(insert);
    hub.loseOnce = "INSERT";
    await comeBack(); // the hub ran the insert; the replay is cut short by the lost response
    expect(useOffline.getState().offline).toBe(true);
    await comeBack();

    expect(hub.ran).toEqual(["INSERT INTO tasks (title) VALUES ($1)"]);
    expect(hub.sent).toHaveLength(2);
    expect(hub.sent[0].op).toBe(hub.sent[1].op);
    expect(db.updateTask).toHaveBeenCalledWith(101, { title: "b" });
    expect(useOffline.getState()).toMatchObject({ offline: false, waiting: 0 });
  });

  it("adds the conflict comment once when the update after it is cut short", async () => {
    useOffline.setState({ offline: true });
    useStore.setState({ tasks: [task(5, "base")] });
    await gated.updateTask(5, { notes: "mine" });
    hubNotes = "base + agent";

    db.insertComment.mockImplementation(async () => {
      await remoteDb.execute("INSERT INTO comments", []);
      await remoteDb.execute("INSERT INTO activity", []);
      return 1;
    });
    db.updateTask.mockImplementation(async () => {
      await remoteDb.execute("UPDATE tasks SET title = $1", ["x"]);
      return {};
    });
    hub.loseOnce = "UPDATE";
    await comeBack();
    await comeBack();

    // The update's write is numbered from 0 like the comment's first one, yet it is not
    // mistaken for it: it ran once, after the comment.
    expect(hub.ran).toEqual(["INSERT INTO comments", "INSERT INTO activity", "UPDATE tasks SET title = $1"]);
    expect(db.insertComment).toHaveBeenCalledTimes(1);
    expect(useOffline.getState().waiting).toBe(0);
  });

  it("sends no op key for a write made online", async () => {
    db.updateTask.mockImplementationOnce(async () => {
      await remoteDb.execute("UPDATE tasks SET title = $1", ["x"]);
      return {};
    });
    await gated.updateTask(1, { title: "x" });
    expect(hub.sent).toEqual([{ sql: "UPDATE tasks SET title = $1", op: undefined }]);
  });
  it("holds a write that is not queued until the replay is done, so it takes no key", async () => {
    useOffline.setState({ offline: true });
    const made = (await gated.insertTask({ project_id: 1, title: "a" } as never)) as { id: number };
    await gated.insertSubtask(made.id, "s", 0);
    // Launched with a leftover queue and the hub reachable: the replay runs with offline false.
    useOffline.setState({ offline: false });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    db.insertTask.mockImplementationOnce(async () => {
      await gate; // the replay is mid-op
      const r = await remoteDb.execute("INSERT INTO tasks", []);
      return { id: r.lastInsertId!, number: 1, ref: "TIL-1", goal_id: null };
    });
    db.insertProject.mockImplementationOnce(async () => {
      await remoteDb.execute("INSERT INTO projects", []);
      return { id: 1, code: "X" } as never;
    });
    const replay = comeBack();
    await new Promise((r) => setTimeout(r, 0));
    const project = gated.insertProject("New", "red", "meadow");
    await new Promise((r) => setTimeout(r, 0));
    expect(hub.sent).toEqual([]); // the project waits
    release();
    await Promise.all([replay, project]);

    expect(db.insertSubtask).toHaveBeenCalledWith(101, "s", 0);
    expect(hub.sent.map((w) => w.sql)).toEqual(["INSERT INTO tasks", "INSERT INTO projects"]);
    expect(hub.sent[0].op).toBeDefined();
    expect(hub.sent[1].op).toBeUndefined();
  });

  it("gives a queue saved before keys existed its keys, and saves them", async () => {
    files.set(
      "outbox",
      JSON.stringify({ hub: "http://hub", nextTemp: -1, ids: {}, ops: [{ fn: "deleteTask", args: [3] }] }),
    );
    await loadOutbox();
    await filesSettled();
    expect(saved().ops).toEqual([{ fn: "deleteTask", args: [3], key: expect.any(String) }]);
  });
});
