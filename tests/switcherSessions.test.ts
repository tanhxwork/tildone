import { describe, expect, test } from "bun:test";
import {
  nextSessionId,
  switcherSessions,
  type SwitchableSession,
  type SwitchTab,
} from "../src/utils/sessions";

function host(id: number, over: Partial<SwitchableSession> = {}): SwitchableSession {
  return {
    id,
    task_ref: `TIL-${id}`,
    adapter_id: "claude",
    adapter_name: "Claude Code",
    cwd: "/Users/x/projects/tildone",
    exited: false,
    waiting: false,
    unbound_stage: null,
    expires_in_secs: null,
    title_hint: null,
    ...over,
  };
}

describe("switcherSessions", () => {
  test("maps hosted sessions to hosted-<id> tabs, in order, marking the active one", () => {
    const tabs = switcherSessions([host(1), host(2), host(3)], "hosted-2");
    expect(tabs.map((t) => t.sessionId)).toEqual(["hosted-1", "hosted-2", "hosted-3"]);
    expect(tabs.map((t) => t.active)).toEqual([false, true, false]);
    expect(tabs[0].label).toBe("TIL-1");
    expect(tabs[0].ref).toBe("TIL-1");
  });

  test("label falls back to the typed hint, then the adapter, for unbound sessions", () => {
    const [a, b] = switcherSessions(
      [host(1, { task_ref: null, title_hint: "fix the bug" }), host(2, { task_ref: null })],
      null,
    );
    expect(a.label).toBe("fix the bug");
    expect(a.ref).toBeNull();
    expect(b.label).toBe("Claude Code");
  });

  test("exited sessions are excluded from the switcher (not live, not cycled)", () => {
    const tabs = switcherSessions(
      [host(1, { exited: true }), host(2, { waiting: true }), host(3)],
      null,
    );
    expect(tabs.map((t) => t.sessionId)).toEqual(["hosted-2", "hosted-3"]);
    expect(tabs.map((t) => t.state)).toEqual(["waiting", "quiet"]);
  });

  test("a foreign attach target rides in as a prepended tab when it isn't hosted", () => {
    const tabs = switcherSessions([host(1)], "attach-uuid", {
      sessionId: "attach-uuid",
      ref: "TIL-9",
    });
    expect(tabs.map((t) => t.sessionId)).toEqual(["attach-uuid", "hosted-1"]);
    expect(tabs[0].active).toBe(true);
    expect(tabs[0].ref).toBe("TIL-9");
    expect(tabs[0].label).toBe("TIL-9");
  });

  test("an attach target that IS already hosted is not duplicated", () => {
    const tabs = switcherSessions([host(1)], "hosted-1", {
      sessionId: "hosted-1",
      ref: "TIL-1",
    });
    expect(tabs.map((t) => t.sessionId)).toEqual(["hosted-1"]);
  });

  test("an attach target with no ref labels as 'session'", () => {
    const [a] = switcherSessions([], "x", { sessionId: "x", ref: null });
    expect(a.label).toBe("session");
  });
});

describe("nextSessionId", () => {
  const tabs: SwitchTab[] = [
    { sessionId: "a", label: "a", ref: null, state: "quiet", active: false },
    { sessionId: "b", label: "b", ref: null, state: "quiet", active: true },
    { sessionId: "c", label: "c", ref: null, state: "quiet", active: false },
  ];

  test("next and previous move to the neighbour", () => {
    expect(nextSessionId(tabs, "b", 1)).toBe("c");
    expect(nextSessionId(tabs, "b", -1)).toBe("a");
  });

  test("wraps around both ends", () => {
    expect(nextSessionId(tabs, "c", 1)).toBe("a");
    expect(nextSessionId(tabs, "a", -1)).toBe("c");
  });

  test("returns null when there is nothing else to switch to", () => {
    expect(nextSessionId([], null, 1)).toBeNull();
    expect(nextSessionId([tabs[0]], "a", 1)).toBeNull();
  });

  test("a missing active falls to the first tab", () => {
    expect(nextSessionId(tabs, "gone", 1)).toBe("a");
  });
});
