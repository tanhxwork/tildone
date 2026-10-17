import { beforeEach, describe, expect, it } from "bun:test";
import type { ActivityEntry, Status, Task } from "../src/types";
import { db, resetDbMock, useStore } from "./support/dbMock";

// The Activity feed is the surface an agent's log_progress writes to, and the one
// the user watches while work happens. It is fed by fetchActivity — which fetchAll
// knows nothing about — so refreshing the board does not refresh the log unless
// reload() asks for it.

let feed: ActivityEntry[] = [];

function entry(id: number, label: string): ActivityEntry {
  return {
    id,
    task_id: 19,
    label,
    created_at: `2026-07-16T03:0${id}:00Z`,
    actor_kind: null,
    actor_name: null,
  };
}

const CREATED = entry(1, "Task created");
const AGENT_WROTE = entry(2, "tests written (RED, 5 failing)");

describe("reload keeps an open task's Activity feed live", () => {
  beforeEach(() => {
    resetDbMock();
    feed = [CREATED];
    db.fetchActivity.mockImplementation(async (taskId: number) =>
      feed.filter((e) => e.task_id === taskId),
    );
    useStore.setState({ editingTaskId: null, activity: [] });
  });

  it("picks up an entry written while the user has the task open", async () => {
    // The user opens task 19 and is looking at its Activity feed.
    useStore.setState({ editingTaskId: 19 });
    await useStore.getState().loadActivity(19);
    expect(useStore.getState().activity.map((e) => e.label)).toEqual(["Task created"]);

    // An agent calls log_progress on that task. The Rust side notifies, and
    // App.tsx's agent-db-changed listener calls exactly this — nothing else.
    feed = [CREATED, AGENT_WROTE];
    await useStore.getState().reload();

    expect(useStore.getState().activity.map((e) => e.label)).toEqual([
      "Task created",
      "tests written (RED, 5 failing)",
    ]);
  });

  it("does not fetch activity when no task is open", async () => {
    await useStore.getState().reload();

    expect(db.fetchAll).toHaveBeenCalled();
    expect(db.fetchActivity).not.toHaveBeenCalled();
    expect(useStore.getState().activity).toEqual([]);
  });
});

describe("lastActivity", () => {
  beforeEach(() => {
    resetDbMock();
    useStore.setState({ lastActivity: {}, tasks: [] });
  });

  it("moves at once when the app records an activity row", async () => {
    // Any user edit that records activity goes through recordActivity.
    const id = await useStore.getState().addTask({ title: "x" });
    await new Promise((r) => setTimeout(r, 0)); // addTask does not await its log row
    const [taskId, , createdAt] = db.insertActivity.mock.calls[0];
    expect(taskId).toBe(id);
    expect(useStore.getState().lastActivity[id]).toBe(createdAt);
  });
});

describe("a board drag counts as a move", () => {
  const card = (id: number, status: Status, position: number) =>
    ({
      id, project_id: 7, goal_id: null, title: `t${id}`, notes: "", status, priority: 0,
      due_date: null, position, created_at: "2026-07-19T00:00:00.000Z", completed_at: null,
      deleted_at: null, archived_at: null, number: null, ref: null, unseen_at: null,
      owner: "human", from_task_id: null, kind: "task", tag_ids: [],
    }) as Task;

  beforeEach(() => {
    resetDbMock();
    useStore.setState({ lastActivity: {}, selection: { type: "project", projectId: 7 } });
  });

  it("logs a status change when a card lands in another column", async () => {
    useStore.setState({ tasks: [card(1, "todo", 0)] });
    await useStore.getState().applyDrag(1, { todo: [], doing: [1], done: [] } as Record<Status, number[]>);
    await new Promise((r) => setTimeout(r, 0));
    expect(db.insertActivity.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [1, "Status changed to In Progress"],
    ]);
    expect(useStore.getState().lastActivity[1]).toBeDefined();
  });

  it("logs nothing for a reorder inside one column", async () => {
    useStore.setState({ tasks: [card(1, "todo", 0), card(2, "todo", 1)] });
    await useStore.getState().applyDrag(1, { todo: [2, 1], doing: [], done: [] } as Record<Status, number[]>);
    await new Promise((r) => setTimeout(r, 0));
    expect(db.insertActivity).not.toHaveBeenCalled();
  });
});
