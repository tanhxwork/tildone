import { beforeEach, describe, expect, it } from "bun:test";
import type { ActivityEntry } from "../src/types";
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
