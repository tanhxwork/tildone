// Store-seam unit coverage the session-context-rail spec calls for
// (docs/specs/2026-07-23-session-context-rail.md "Testing decisions"):
// railCollapsed toggle + persistence, and that re-targeting the pane preserves
// widthFraction. paneStore reads window.localStorage at import, so the shim
// MUST be imported before the store (TIL-158 deviation, closed by TIL-161).
import { memoryStorage } from "./support/localStorageShim";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  usePaneStore,
  storedFraction,
  storedRailCollapsed,
  type PaneTarget,
} from "../src/paneStore";

function attach(sessionId: string, over: Partial<PaneTarget> = {}): PaneTarget {
  return {
    sessionId,
    taskRef: null,
    taskId: null,
    name: null,
    kind: "attach",
    shortId: sessionId.slice(0, 4),
    ...over,
  } as PaneTarget;
}

beforeEach(() => {
  memoryStorage.clear();
  // Baseline via setState (which does NOT write to storage), so each test
  // starts from the store's documented defaults and an empty localStorage.
  usePaneStore.setState({
    target: null,
    widthFraction: 0.65,
    fullscreen: false,
    collapsed: false,
    railCollapsed: false,
    focusNonce: 0,
  });
});

describe("paneStore railCollapsed", () => {
  test("setRailCollapsed persists so a fresh read returns it", () => {
    usePaneStore.getState().setRailCollapsed(true);
    expect(usePaneStore.getState().railCollapsed).toBe(true);
    // storedRailCollapsed() reads window.localStorage fresh — proves it
    // persisted, not merely that in-memory state flipped.
    expect(storedRailCollapsed()).toBe(true);

    usePaneStore.getState().setRailCollapsed(false);
    expect(usePaneStore.getState().railCollapsed).toBe(false);
    expect(storedRailCollapsed()).toBe(false);
  });

  test("toggleRailCollapsed flips state and persists both ways", () => {
    expect(usePaneStore.getState().railCollapsed).toBe(false);

    usePaneStore.getState().toggleRailCollapsed();
    expect(usePaneStore.getState().railCollapsed).toBe(true);
    expect(storedRailCollapsed()).toBe(true);

    usePaneStore.getState().toggleRailCollapsed();
    expect(usePaneStore.getState().railCollapsed).toBe(false);
    expect(storedRailCollapsed()).toBe(false);
  });

  test("only the '1' sentinel counts as collapsed", () => {
    memoryStorage.setItem("tildone.pane.railCollapsed", "0");
    expect(storedRailCollapsed()).toBe(false);
    memoryStorage.setItem("tildone.pane.railCollapsed", "1");
    expect(storedRailCollapsed()).toBe(true);
  });
});

describe("paneStore re-target preserves widthFraction", () => {
  test("opening a different session does not touch widthFraction", () => {
    usePaneStore.getState().setWidthFraction(0.5);
    expect(usePaneStore.getState().widthFraction).toBe(0.5);

    usePaneStore.getState().openPane(attach("sess-a"));
    expect(usePaneStore.getState().target?.sessionId).toBe("sess-a");
    expect(usePaneStore.getState().widthFraction).toBe(0.5);

    usePaneStore.getState().openPane(attach("sess-b"));
    expect(usePaneStore.getState().target?.sessionId).toBe("sess-b");
    expect(usePaneStore.getState().widthFraction).toBe(0.5);
  });

  test("re-clicking the same session keeps width and only bumps focus", () => {
    usePaneStore.getState().setWidthFraction(0.42);
    usePaneStore.getState().openPane(attach("sess-a"));
    const nonceAfterOpen = usePaneStore.getState().focusNonce;

    usePaneStore.getState().openPane(attach("sess-a"));
    expect(usePaneStore.getState().widthFraction).toBe(0.42);
    expect(usePaneStore.getState().target?.sessionId).toBe("sess-a");
    expect(usePaneStore.getState().focusNonce).toBe(nonceAfterOpen + 1);
  });
});

describe("paneStore widthFraction persistence and clamping", () => {
  test("defaults to 0.65 when unset or blank", () => {
    expect(storedFraction()).toBe(0.65);
    memoryStorage.setItem("tildone.pane.widthFraction", "   ");
    expect(storedFraction()).toBe(0.65);
  });

  test("setWidthFraction clamps to [0.3, 0.9] and persists the clamped value", () => {
    usePaneStore.getState().setWidthFraction(2);
    expect(usePaneStore.getState().widthFraction).toBe(0.9);
    expect(storedFraction()).toBe(0.9);

    usePaneStore.getState().setWidthFraction(0.01);
    expect(usePaneStore.getState().widthFraction).toBe(0.3);
    expect(storedFraction()).toBe(0.3);
  });

  test("a non-finite stored value falls back to the default", () => {
    memoryStorage.setItem("tildone.pane.widthFraction", "not-a-number");
    expect(storedFraction()).toBe(0.65);
  });
});
