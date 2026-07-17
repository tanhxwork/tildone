import { describe, expect, it } from "bun:test";
import { isRecentPresence } from "../src/utils/dates";
import { byTask, cardPresence, type LivePresence } from "../src/utils/presence";

// This file used to pin down "a write seconds ago is actively working" — presence
// INFERRED from the age of the last board write, with a 2-minute window deciding
// whether the mark pulsed. That contract is gone, deliberately, because it was the
// bug rather than a casualty of fixing it: an agent grinding for 25 minutes in a
// worktree without calling log_progress wrote nothing, so it rendered exactly like an
// agent that touched the card once and left — same static mark, same stale timestamp.
// The card could not tell you the one thing you were looking at it to learn.
//
// "working" is now REPORTED by the agent's own hook (which fires on every tool call)
// and checked against the OS process, in Rust. The 12h window survives for exactly one
// job: gating the fallback shown for agents with no hook installed.
//
// The old invariant survives in a stronger form. It used to be that the pulse could
// only under-claim, needing a genuinely fresh write to switch on. Now nothing infers
// liveness at all: "working" requires a live session to have said so AND its process
// to still exist.

const live = (over: Partial<LivePresence> = {}): LivePresence => ({
  task_id: 7,
  agent_name: "claude",
  state: "working",
  at: "2026-07-17T10:05:00.000Z",
  branch: "wt-til-62",
  cwd: "/w/til-62",
  last_log: null,
  ...over,
});

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

describe("the presence fallback window", () => {
  it("a write hours ago is still presence", () => {
    expect(isRecentPresence(minutesAgo(3 * 60))).toBe(true);
  });

  it("a write past the 12h window is not presence", () => {
    expect(isRecentPresence(minutesAgo(24 * 60))).toBe(false);
  });

  it("a garbage timestamp is never presence", () => {
    expect(isRecentPresence("not-a-date")).toBe(false);
  });
});

describe("cardPresence", () => {
  it("prefers the live report over the age of a write", () => {
    const entry = cardPresence(7, { 7: live() }, { 7: { name: "claude", at: minutesAgo(600) } });
    expect(entry).toMatchObject({ state: "working", live: true, branch: "wt-til-62" });
  });

  it("shows a live agent as working however long it has been silent", () => {
    // The regression this feature exists for. A five-minute build inside one Bash
    // call writes nothing to the board; the old code called that quiet. Rust already
    // resolved this against the live process, so the UI must not second-guess it.
    const entry = cardPresence(7, { 7: live({ at: minutesAgo(45) }) }, {});
    expect(entry?.state).toBe("working");
  });

  it("falls back to quiet — never working — for an agent with no live report", () => {
    // Codex, Cursor, an unconnected Claude Code. A fresh write is NOT evidence of
    // working: that inference is precisely what was removed.
    const entry = cardPresence(7, {}, { 7: { name: "codex", at: minutesAgo(0) } });
    expect(entry).toMatchObject({ state: "quiet", live: false, name: "codex" });
  });

  it("carries the agent's last word through", () => {
    const entry = cardPresence(7, { 7: live({ last_log: "rebasing onto main" }) }, {});
    expect(entry?.last_log).toBe("rebasing onto main");
  });

  it("shows blocked when the agent is waiting on the human", () => {
    expect(cardPresence(7, { 7: live({ state: "blocked" }) }, {})?.state).toBe("blocked");
  });

  it("renders nothing for a task no agent has touched", () => {
    expect(cardPresence(7, {}, {})).toBeNull();
  });

  it("renders nothing once a stale write ages out of the window", () => {
    expect(cardPresence(7, {}, { 7: { name: "claude", at: minutesAgo(24 * 60) } })).toBeNull();
  });

  it("keeps one task's live state off another task's card", () => {
    // The shared-cwd bug, at the UI layer: presence is keyed by task, and a live
    // entry for task 7 must never bleed onto task 8.
    expect(cardPresence(8, { 7: live() }, {})).toBeNull();
  });
});

describe("byTask", () => {
  it("indexes the command's flat list by task id", () => {
    expect(byTask([live({ task_id: 3 }), live({ task_id: 9 })])).toMatchObject({
      3: { task_id: 3 },
      9: { task_id: 9 },
    });
  });

  it("indexes an empty list to an empty map", () => {
    expect(byTask([])).toEqual({});
  });
});
