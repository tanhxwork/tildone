import { beforeEach, describe, expect, it } from "bun:test";
import { db, resetDbMock, useStore } from "./support/dbMock";

// Repo links live in the store as links[task_id] = TaskLink[]. The store derives
// the kind and a short label from the URL when the caller doesn't give them, and
// refuses anything that isn't http(s) — the same guard the Rust add_link enforces.

describe("repo links in the store", () => {
  beforeEach(() => {
    resetDbMock();
    useStore.setState({ links: {} });
  });

  it("attaches an http link, deriving kind and a short label, under its task", async () => {
    await useStore.getState().addLink(7, "https://github.com/x/y/pull/12");
    expect(db.addLink).toHaveBeenCalledTimes(1);
    const [taskId, url, label, kind] = db.addLink.mock.calls[0];
    expect(taskId).toBe(7);
    expect(kind).toBe("pr");
    expect(label).toBe("PR #12");
    expect(useStore.getState().links[7]).toHaveLength(1);
    expect(useStore.getState().links[7][0].url).toBe(url);
  });

  it("refuses a non-http url without touching the db", async () => {
    await useStore.getState().addLink(7, "javascript:alert(1)");
    expect(db.addLink).not.toHaveBeenCalled();
    expect(useStore.getState().links[7]).toBeUndefined();
  });

  it("removes a link from its task", async () => {
    useStore.setState({
      links: { 7: [{ id: 1, task_id: 7, url: "https://e.com/a", label: "a", kind: "other" }] },
    });
    await useStore.getState().removeLink(7, 1);
    expect(db.deleteLink).toHaveBeenCalledWith(1);
    expect(useStore.getState().links[7]).toHaveLength(0);
  });
});
