import { describe, expect, it } from "bun:test";
import {
  decisionTone,
  defaultObserveId,
  observeCounts,
  observeGroups,
  observeState,
  watchMoreTrigger,
  yesSummary,
} from "../src/observeViews";
import type { ObserveCard, ObserveLogLine, Task } from "../src/types";

// An observe card is Waiting until its trigger fires, Due after, Observed once
// decided. These cases pin the trigger rules, the grouping and the summaries.

let seq = 0;

function task(opts: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: seq,
    project_id: 1,
    goal_id: null,
    title: `question ${seq}`,
    notes: "",
    status: "todo",
    priority: 0,
    due_date: null,
    position: seq,
    created_at: "2026-09-01T00:00:00.000Z",
    completed_at: null,
    deleted_at: null,
    archived_at: null,
    number: seq,
    ref: `TIL-${seq}`,
    unseen_at: null,
    owner: "human",
    from_task_id: null,
    kind: "observe",
    tag_ids: [],
    ...opts,
  };
}

function lines(verdicts: (boolean | null)[]): ObserveLogLine[] {
  return verdicts.map((verdict, i) => ({
    id: i + 1,
    task_id: 0,
    at: "2026-09-30T10:00:00.000Z",
    session_id: null,
    text: `line ${i + 1}`,
    verdict,
  }));
}

function card(opts: Partial<ObserveCard> = {}, taskOpts: Partial<Task> = {}): ObserveCard {
  return {
    task: task(taskOpts),
    check_text: "grep it",
    trigger_date: null,
    trigger_count: 5,
    trigger_unit: "deliveries",
    options: [
      { label: "Keep", detail: "" },
      { label: "Change", detail: "" },
      { label: "Revert", detail: "" },
    ],
    decision: null,
    log: [],
    ...opts,
  };
}

const TODAY = "2026-10-01";

describe("observeState", () => {
  it("is due once the log reaches the count, waiting one line short", () => {
    expect(observeState(card({ log: lines([true, true, null, false]) }), TODAY)).toBe("waiting");
    expect(observeState(card({ log: lines([true, true, null, false, true]) }), TODAY)).toBe("due");
  });

  it("is due on and after the trigger date, waiting the day before", () => {
    const dated = (trigger_date: string) =>
      card({ trigger_count: null, trigger_unit: null, trigger_date });
    expect(observeState(dated("2026-10-02"), TODAY)).toBe("waiting");
    expect(observeState(dated("2026-10-01"), TODAY)).toBe("due");
    expect(observeState(dated("2026-09-20"), TODAY)).toBe("due");
  });

  it("is observed once decided, whatever the trigger says", () => {
    expect(observeState(card({ decision: 0, log: lines([true]) }), TODAY)).toBe("observed");
  });
});

describe("observeGroups and the default selection", () => {
  it("groups by state and opens on the first due card", () => {
    const waiting = card();
    const due = card({ log: lines([null, null, null, null, null]) });
    const older = card({ decision: 2 }, { completed_at: "2026-09-20T00:00:00.000Z" });
    const newer = card({ decision: 0 }, { completed_at: "2026-09-30T00:00:00.000Z" });
    const groups = observeGroups([waiting, older, due, newer], TODAY);
    expect(groups.due).toEqual([due]);
    expect(groups.waiting).toEqual([waiting]);
    expect(groups.observed).toEqual([newer, older]);
    expect(defaultObserveId(groups)).toBe(due.task.id);
  });

  it("falls back to the first card when nothing is due, and to null when empty", () => {
    const waiting = card();
    expect(defaultObserveId(observeGroups([waiting], TODAY))).toBe(waiting.task.id);
    expect(defaultObserveId(observeGroups([], TODAY))).toBeNull();
  });
});

describe("observeCounts", () => {
  it("counts due, waiting and only this month's decisions", () => {
    const counts = observeCounts(
      [
        card({ log: lines([null, null, null, null, null]) }),
        card(),
        card(),
        card({ decision: 0 }, { completed_at: "2026-10-01T03:00:00.000Z" }),
        card({ decision: 1 }, { completed_at: "2026-08-15T12:00:00.000Z" }),
      ],
      TODAY,
    );
    expect(counts).toEqual({ due: 1, waiting: 2, observedThisMonth: 1 });
  });
});

describe("yesSummary", () => {
  it("counts yes over the lines that carry a verdict", () => {
    expect(yesSummary(lines([true, false, true, null, false, true]))).toBe("Yes in 3 of 5");
  });

  it("is null when no line has a verdict", () => {
    expect(yesSummary(lines([null, null]))).toBeNull();
  });
});

describe("decisionTone", () => {
  it("reads first as success, last as danger, middle as neutral", () => {
    expect([0, 1, 2].map((i) => decisionTone(i, 3))).toEqual(["success", "neutral", "danger"]);
    expect([0, 1].map((i) => decisionTone(i, 2))).toEqual(["success", "danger"]);
  });
});

describe("watchMoreTrigger", () => {
  it("adds three lines to a due count card so it returns to waiting", () => {
    const due = card({ log: lines([null, null, null, null, null]) });
    const patch = watchMoreTrigger(due, TODAY);
    expect(patch).toEqual({ trigger_count: 8 });
    expect(observeState({ ...due, ...patch }, TODAY)).toBe("waiting");
  });

  it("moves a date card to a week from today", () => {
    const dated = card({ trigger_count: null, trigger_unit: null, trigger_date: "2026-09-28" });
    expect(watchMoreTrigger(dated, TODAY)).toEqual({ trigger_date: "2026-10-08" });
  });
});
