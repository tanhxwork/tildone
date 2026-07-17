import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Comment } from "../src/types";

// Comments are the return channel to an agent: the user answers on the card and the
// agent, parked in list_changes, wakes. On the app side that means two things must
// hold — an open task's thread stays live when an agent writes to it (reload refreshes
// it, since fetchAll carries only counts, not bodies), and posting a reply appears
// immediately and bumps the card badge. This is the TS half; the Rust half is in
// agent.rs (the add_comment tests).

const EMPTY_BOARD = {
  projects: [],
  tasks: [],
  tags: [],
  subtasks: [],
  presence: {},
  links: {},
  commentCounts: {},
};

let thread: Comment[] = [];
const fetchComments = mock(async (taskId: number) => thread.filter((c) => c.task_id === taskId));
const fetchActivity = mock(async () => []);
const fetchAll = mock(async () => EMPTY_BOARD);
const insertComment = mock(
  async (taskId: number, body: string): Promise<Comment> => ({
    id: 99,
    task_id: taskId,
    body,
    actor_kind: "user",
    actor_name: null,
    created_at: "2026-07-17T00:00:00.000Z",
  }),
);

mock.module("../src/db", () => ({ fetchAll, fetchActivity, fetchComments, insertComment }));

const { useStore } = await import("../src/store");

function comment(id: number, body: string, kind: "user" | "agent" = "agent"): Comment {
  return {
    id,
    task_id: 19,
    body,
    actor_kind: kind,
    actor_name: kind === "agent" ? "claude-code" : null,
    created_at: `2026-07-17T03:0${id}:00.000Z`,
  };
}

describe("comments in the store", () => {
  beforeEach(() => {
    thread = [];
    fetchComments.mockClear();
    insertComment.mockClear();
    useStore.setState({ editingTaskId: null, comments: [], commentCounts: {} });
  });

  it("keeps an open task's thread live when an agent adds a comment", async () => {
    useStore.setState({ editingTaskId: 19 });
    thread = [comment(1, "Which port for the dev build?")];
    await useStore.getState().loadComments(19);
    expect(useStore.getState().comments.map((c) => c.body)).toEqual([
      "Which port for the dev build?",
    ]);

    // The agent posts again while the user is looking. App.tsx's agent-db-changed
    // listener calls reload(); fetchAll has no bodies, so only reload's explicit
    // loadComments keeps the thread current.
    thread = [comment(1, "Which port for the dev build?"), comment(2, "Thanks, using 5599.")];
    await useStore.getState().reload();

    expect(useStore.getState().comments.map((c) => c.body)).toEqual([
      "Which port for the dev build?",
      "Thanks, using 5599.",
    ]);
  });

  it("does not fetch comments when no task is open", async () => {
    await useStore.getState().reload();
    expect(fetchComments).not.toHaveBeenCalled();
    expect(useStore.getState().comments).toEqual([]);
  });

  it("posts a reply optimistically and bumps the card count", async () => {
    useStore.setState({ editingTaskId: 19 });
    await useStore.getState().addComment(19, "  On it.  ");

    // Trimmed, appended to the open thread, and the card badge count goes up — all
    // without a reload.
    expect(insertComment).toHaveBeenCalledWith(19, "On it.");
    expect(useStore.getState().comments.map((c) => c.body)).toEqual(["On it."]);
    expect(useStore.getState().commentCounts[19]).toBe(1);
  });

  it("ignores an empty reply", async () => {
    useStore.setState({ editingTaskId: 19 });
    await useStore.getState().addComment(19, "   ");
    expect(insertComment).not.toHaveBeenCalled();
    expect(useStore.getState().comments).toEqual([]);
  });
});
