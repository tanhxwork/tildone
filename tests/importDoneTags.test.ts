import { beforeEach, describe, expect, it } from "bun:test";
import type { Tag } from "../src/types";
import { db, resetDbMock, useStore } from "./support/dbMock";

// Import is the third writer of a task's tags, alongside patchTask and applyDrag
// (tests/doneClearsReviewTags.test.ts). Those two strip `blocked` / `needs-review`
// on the *transition* into Done, so a row that arrives already at status "done"
// slipped through: importData inserts via db.insertTask + db.setTaskTags and never
// crosses that transition. Restoring a backup therefore resurrected stale
// "Needs review" pills on cards the user had long since finished (TIL-98).
//
// `needs-landing` is the deliberate exception in all three paths: a done task can
// still hold an unmerged PR (TIL-84).

const BLOCKED: Tag = { id: 1, name: "blocked", color: "#888" };
// Tags are auto-created from agent-supplied names, so casing is not canonical.
const NEEDS_REVIEW: Tag = { id: 2, name: "Needs-Review", color: "#888" };
const NEEDS_LANDING: Tag = { id: 3, name: "needs-landing", color: "#888" };
const PLAIN: Tag = { id: 4, name: "frontend", color: "#888" };
const ALL_TAGS = [BLOCKED, NEEDS_REVIEW, NEEDS_LANDING, PLAIN];

beforeEach(() => {
  resetDbMock();
  db.insertTask.mockImplementation(async (_row: unknown) => ({ id: 100, number: 100, ref: "T-100" }));
  useStore.setState({
    tags: ALL_TAGS,
    projects: [],
    tasks: [],
    selection: { type: "project", projectId: null },
  });
});

describe("importData: a row that arrives already done drops its stale review tags", () => {
  it("strips blocked and needs-review (any casing), keeps needs-landing and plain tags", async () => {
    await useStore.getState().importData({
      tasks: [
        {
          title: "finished long ago",
          status: "done",
          tags: ["blocked", "Needs-Review", "needs-landing", "frontend"],
        },
      ],
    });

    expect(db.setTaskTags).toHaveBeenCalledWith(100, [3, 4]);
  });

  it("keeps them on a row that is imported as todo or doing", async () => {
    await useStore.getState().importData({
      tasks: [{ title: "still open", status: "todo", tags: ["blocked", "frontend"] }],
    });

    expect(db.setTaskTags).toHaveBeenCalledWith(100, [1, 4]);
  });

  it("does not create a tag row for a stripped name it has never seen", async () => {
    // The strip has to happen before the name is resolved, or importing one done
    // card conjures a "blocked" tag into a board that had none.
    useStore.setState({ tags: [PLAIN] });

    await useStore.getState().importData({
      tasks: [{ title: "done", status: "done", tags: ["blocked", "frontend"] }],
    });

    expect(db.insertTag).not.toHaveBeenCalled();
    expect(db.setTaskTags).toHaveBeenCalledWith(100, [4]);
  });

  it("writes no tags at all when every tag on a done row is stripped", async () => {
    await useStore.getState().importData({
      tasks: [{ title: "done", status: "done", tags: ["blocked", "needs-review"] }],
    });

    expect(db.setTaskTags).not.toHaveBeenCalled();
  });
});
