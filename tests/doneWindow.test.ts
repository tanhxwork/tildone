import { describe, expect, it } from "bun:test";
import { DONE_WINDOW_LIMIT, doneBoardWindow } from "../src/selectors";
import type { Task } from "../src/types";

// The board's Done column is a recent window, not the full history: everything
// finished *today* (local time) stays, and if that is under the auto-limit the
// most-recent older completions backfill up to it. Archived cards ("Move older
// off board") drop out of the window but stay live in Completed. This is the pure
// core of that rule — no store, no DB.

let seq = 0;

/** A done task completed at local noon on `day` (YYYY-MM-DD), so the local
 * calendar day round-trips regardless of the machine's timezone. */
function done(day: string | null, opts: Partial<Task> = {}): Task {
  seq += 1;
  let completed_at: string | null = null;
  if (day) {
    const [y, m, d] = day.split("-").map(Number);
    completed_at = new Date(y, m - 1, d, 12, 0, 0).toISOString();
  }
  return {
    id: seq,
    project_id: null,
    title: `task ${seq}`,
    notes: "",
    status: "done",
    priority: 0,
    due_date: null,
    position: -seq,
    created_at: completed_at ?? "2026-07-01T00:00:00.000Z",
    completed_at,
    deleted_at: null,
    archived_at: null,
    tag_ids: [],
    ...opts,
  };
}

const TODAY = "2026-07-16";

describe("doneBoardWindow", () => {
  it("keeps every task finished today and nothing else when today fills the limit", () => {
    const tasks = Array.from({ length: 5 }, () => done(TODAY));
    const w = doneBoardWindow(tasks, TODAY, 3);
    // 5 finished today, all stay even though that is over the limit of 3.
    expect(w.today).toHaveLength(5);
    expect(w.earlier).toHaveLength(0);
    expect(w.hiddenCount).toBe(0);
  });

  it("backfills older completions up to the limit when today is short", () => {
    const t1 = done(TODAY);
    const older = [done("2026-07-15"), done("2026-07-14"), done("2026-07-13")];
    const w = doneBoardWindow([t1, ...older], TODAY, 3);
    expect(w.today.map((t) => t.id)).toEqual([t1.id]);
    // Backfill fills 2 more (newest first) to reach the limit of 3.
    expect(w.earlier.map((t) => t.id)).toEqual([older[0].id, older[1].id]);
    // The 3rd older one is not on the board but lives in Completed.
    expect(w.hiddenCount).toBe(1);
  });

  it("fills entirely from older completions when nothing was finished today", () => {
    const older = [done("2026-07-15"), done("2026-07-14"), done("2026-07-10")];
    const w = doneBoardWindow(older, TODAY, 2);
    expect(w.today).toHaveLength(0);
    expect(w.earlier.map((t) => t.id)).toEqual([older[0].id, older[1].id]);
    expect(w.hiddenCount).toBe(1);
  });

  it("excludes archived tasks from the window and counts them as hidden", () => {
    const t1 = done(TODAY);
    const archivedOlder = done("2026-07-15", { archived_at: "2026-07-16T09:00:00.000Z" });
    const liveOlder = done("2026-07-14");
    const w = doneBoardWindow([t1, archivedOlder, liveOlder], TODAY, 3);
    expect(w.today.map((t) => t.id)).toEqual([t1.id]);
    // The archived older card is skipped; the live older one backfills instead.
    expect(w.earlier.map((t) => t.id)).toEqual([liveOlder.id]);
    // Archived card is not on the board → counted among the hidden.
    expect(w.hiddenCount).toBe(1);
  });

  it("orders both groups newest completion first", () => {
    const early = done(`2026-07-16`, { completed_at: new Date(2026, 6, 16, 8, 0).toISOString() });
    const late = done(`2026-07-16`, { completed_at: new Date(2026, 6, 16, 20, 0).toISOString() });
    const w = doneBoardWindow([early, late], TODAY, 5);
    expect(w.today.map((t) => t.id)).toEqual([late.id, early.id]);
  });

  it("treats a done task with no completion time as older, sorted last", () => {
    const t1 = done(TODAY);
    const noStamp = done(null);
    const w = doneBoardWindow([t1, noStamp], TODAY, 3);
    expect(w.today.map((t) => t.id)).toEqual([t1.id]);
    expect(w.earlier.map((t) => t.id)).toEqual([noStamp.id]);
  });

  it("defaults the limit to 14", () => {
    expect(DONE_WINDOW_LIMIT).toBe(14);
    const tasks = Array.from({ length: 20 }, (_, i) => done("2026-07-15", {
      completed_at: new Date(2026, 6, 15, 23 - i, 0).toISOString(),
    }));
    const w = doneBoardWindow(tasks, TODAY);
    expect(w.earlier).toHaveLength(14);
    expect(w.hiddenCount).toBe(6);
  });
});
