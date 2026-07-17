import { describe, expect, it } from "bun:test";
import { latestLinkPerKind } from "../src/utils/links";
import type { TaskLink } from "../src/types";

// A board card shows one chip per link kind — the newest of that kind — because a
// long-running task collects a link per attempt (TIL-29 had six PRs) and rendering
// all of them drowned the provenance row. The detail view still lists every link.

const link = (id: number, kind: string, label: string): TaskLink => ({
  id,
  task_id: 29,
  url: `https://github.com/o/r/pull/${label}`,
  label,
  kind,
});

describe("latestLinkPerKind", () => {
  it("keeps only the newest link of each kind, and counts the rest", () => {
    const result = latestLinkPerKind([
      link(1, "pr", "PR #13"),
      link(2, "pr", "PR #16"),
      link(3, "branch", "feat-a"),
      link(4, "pr", "PR #38"),
    ]);

    expect(result.map((e) => [e.link.label, e.total])).toEqual([
      ["PR #38", 4 - 1],
      ["feat-a", 1],
    ]);
  });

  it("takes the highest id, not the last in the array — id is the age", () => {
    const [entry] = latestLinkPerKind([link(9, "pr", "newest"), link(2, "pr", "older")]);

    expect(entry.link.label).toBe("newest");
  });

  it("orders chips by kind, so a card's row doesn't reshuffle as links are added", () => {
    const result = latestLinkPerKind([
      link(1, "commit", "abc1234"),
      link(2, "worktree", "wt"),
      link(3, "pr", "PR #1"),
      link(4, "branch", "feat-a"),
    ]);

    expect(result.map((e) => e.link.kind)).toEqual(["pr", "branch", "commit", "worktree"]);
  });

  it("folds an unrecognised kind into `other` — a stored kind string is untrusted", () => {
    const result = latestLinkPerKind([link(1, "bogus", "misc"), link(2, "other", "notes")]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ total: 2, link: { label: "notes" } });
  });

  it("renders nothing for a task with no links", () => {
    expect(latestLinkPerKind([])).toEqual([]);
  });
});
