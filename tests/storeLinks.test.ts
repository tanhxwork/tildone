import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { TaskLink } from "../src/types";

// Repo links live in the store as links[task_id] = TaskLink[]. The store derives
// the kind and a short label from the URL when the caller doesn't give them, and
// refuses anything that isn't http(s) — the same guard the Rust add_link enforces.

const EMPTY_BOARD = { projects: [], tasks: [], tags: [], subtasks: [], links: {}, commentCounts: {} };

const addLink = mock(
  async (taskId: number, url: string, label: string, kind: string): Promise<TaskLink> => ({
    id: 1,
    task_id: taskId,
    url,
    label,
    kind,
  }),
);
const deleteLink = mock(async (_id: number) => {});
const fetchAll = mock(async () => EMPTY_BOARD);
// bun's mock.module is process-global, so whichever test file registers last wins
// for the shared store module. Mirror the other files' db surface (fetchActivity,
// updateTask, insertActivity) so this mock covers every store path they exercise,
// not just the link ones — otherwise combining the suites breaks those files.
const fetchActivity = mock(async () => []);
const fetchComments = mock(async () => []);
const insertComment = mock(async () => ({}));
const updateTask = mock(async () => {});
const insertActivity = mock(async () => {});

mock.module("../src/db", () => ({
  fetchAll,
  fetchActivity,
  fetchComments,
  insertComment,
  updateTask,
  insertActivity,
  addLink,
  deleteLink,
}));

const { useStore } = await import("../src/store");

describe("repo links in the store", () => {
  beforeEach(() => {
    addLink.mockClear();
    deleteLink.mockClear();
    useStore.setState({ links: {} });
  });

  it("attaches an http link, deriving kind and a short label, under its task", async () => {
    await useStore.getState().addLink(7, "https://github.com/x/y/pull/12");
    expect(addLink).toHaveBeenCalledTimes(1);
    const [taskId, url, label, kind] = addLink.mock.calls[0];
    expect(taskId).toBe(7);
    expect(kind).toBe("pr");
    expect(label).toBe("PR #12");
    expect(useStore.getState().links[7]).toHaveLength(1);
    expect(useStore.getState().links[7][0].url).toBe(url);
  });

  it("refuses a non-http url without touching the db", async () => {
    await useStore.getState().addLink(7, "javascript:alert(1)");
    expect(addLink).not.toHaveBeenCalled();
    expect(useStore.getState().links[7]).toBeUndefined();
  });

  it("removes a link from its task", async () => {
    useStore.setState({
      links: { 7: [{ id: 1, task_id: 7, url: "https://e.com/a", label: "a", kind: "other" }] },
    });
    await useStore.getState().removeLink(7, 1);
    expect(deleteLink).toHaveBeenCalledWith(1);
    expect(useStore.getState().links[7]).toHaveLength(0);
  });
});
