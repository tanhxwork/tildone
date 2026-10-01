import { describe, expect, it } from "bun:test";
import { mineGroups, queueGroups } from "../src/ownerViews";
import type { Tag, Task } from "../src/types";

// Mine and the Agent queue are slices of the live task set by owner, status and
// the reserved tags. These cases pin which group a task lands in.

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
    owner: "human",
    from_task_id: null,
    tag_ids: [],
    ...opts,
  };
}

const tags: Tag[] = [
  { id: 1, name: "Blocked", color: "#e03131" },
  { id: 2, name: "needs-approval", color: "#dd5b00" },
  { id: 3, name: "human-verify", color: "#5645d4" },
  { id: 4, name: "docs", color: "#0075de" },
];
const ids = (list: Task[]) => list.map((t) => t.id);

describe("mineGroups", () => {
  it("puts human blocked and needs-approval tasks in needsAnswer, not myTodos", () => {
    const blocked = task({ tag_ids: [1], status: "doing" });
    const approval = task({ tag_ids: [2] });
    const plain = task({ tag_ids: [4] });
    const g = mineGroups([blocked, approval, plain], tags);
    expect(ids(g.needsAnswer)).toEqual([blocked.id, approval.id]);
    expect(ids(g.myTodos)).toEqual([plain.id]);
  });

  it("lists human-verify tasks of any owner under toVerify", () => {
    const agentDone = task({ owner: "agent", status: "done", tag_ids: [3] });
    const humanDone = task({ status: "done", tag_ids: [3] });
    const g = mineGroups([agentDone, humanDone], tags);
    expect(ids(g.toVerify).sort()).toEqual([agentDone.id, humanDone.id].sort());
    expect(g.toVerify.find((t) => t.id === agentDone.id)?.owner).toBe("agent");
    expect(g.myTodos).toEqual([]);
  });

  it("keeps myTodos to open human tasks, live only", () => {
    const todo = task();
    const doing = task({ status: "doing" });
    const done = task({ status: "done" });
    const trashed = task({ deleted_at: "2026-09-01T00:00:00.000Z" });
    const agent = task({ owner: "agent" });
    const g = mineGroups([todo, doing, done, trashed, agent], tags);
    expect(ids(g.myTodos).sort()).toEqual([todo.id, doing.id].sort());
    expect(g.needsAnswer).toEqual([]);
  });

  it("orders a group by priority before position", () => {
    const low = task();
    const high = task({ priority: 3 });
    expect(ids(mineGroups([low, high], tags).myTodos)).toEqual([high.id, low.id]);
  });
});

describe("queueGroups", () => {
  it("splits open agent tasks into doing, needsApproval and todo, and mine counts match", () => {
    const doing = task({ owner: "agent", status: "doing", tag_ids: [2] });
    const approval = task({ owner: "agent", tag_ids: [2] });
    const todo = task({ owner: "agent" });
    const done = task({ owner: "agent", status: "done" });
    const trashed = task({ owner: "agent", deleted_at: "2026-09-01T00:00:00.000Z" });
    const human = task();
    const all = [doing, approval, todo, done, trashed, human];
    const q = queueGroups(all, tags);
    expect(ids(q.doing)).toEqual([doing.id]);
    expect(ids(q.needsApproval)).toEqual([approval.id]);
    expect(ids(q.todo)).toEqual([todo.id]);
    expect(mineGroups(all, tags).queueCounts).toEqual({ todo: 1, doing: 1, needsApproval: 1 });
  });
});
