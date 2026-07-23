// The embedded attach pane's state — deliberately its own tiny store, apart
// from the board store: opening a terminal must never ride through (or
// trigger) the board's reload() wholesale-replacement cycle.
//
// One pane at a time by design (spec 2026-07-19-embedded-attach-pane): the
// jump is "go to the session", not a multiplexer. SessionPane owns the PTY
// lifecycle; this store only says which session the pane is showing.

import { create } from "zustand";

/** What the pane needs to attach and label itself. Two kinds of session can
 *  be behind it (spec 2026-07-19-hosted-agent-sessions): a foreign claude
 *  background session reached via `claude attach`, or a board-hosted session
 *  from host.rs's table. */
export type PaneTarget = {
  /** Stable identity for re-click matching: the claim's session UUID for
   *  attach targets, `hosted-<id>` for hosted ones. */
  sessionId: string;
  /** Card context for the header: "TIL-100"; null for an unbound (no card
   *  yet) session — the header shows the dashed "no card yet" chip then. */
  taskRef: string | null;
  taskId: number | null;
  /** Display name: the claim's session name, or the adapter's. */
  name: string | null;
} & (
  | {
      kind: "attach";
      /** The short id `claude attach` takes, from the Rust `attach_target` command. */
      shortId: string;
    }
  | {
      kind: "hosted";
      /** Row in host.rs's session table. */
      hostId: number;
    }
);

const WIDTH_KEY = "tildone.pane.widthFraction";
/** Default split: the terminal takes ~2/3, leaving the context rail a usable
 *  third (spec 2026-07-23-session-context-rail). It was 3/4 when the left of
 *  the pane was a throwaway squished board rather than the session's rail. */
const DEFAULT_FRACTION = 0.65;
const MIN_FRACTION = 0.3;
const MAX_FRACTION = 0.9;

export function storedFraction(): number {
  const raw = window.localStorage.getItem(WIDTH_KEY);
  // Number(null) and Number("") are both 0, which is finite — an absent or
  // empty key must fall through to the default, not clamp to the minimum.
  if (raw === null || raw.trim() === "") return DEFAULT_FRACTION;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_FRACTION;
  return Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, parsed));
}

const RAIL_KEY = "tildone.pane.railCollapsed";
/** Focus mode is a layout preference, persisted like the width. Default off. */
export function storedRailCollapsed(): boolean {
  return window.localStorage.getItem(RAIL_KEY) === "1";
}

interface PaneState {
  target: PaneTarget | null;
  /** Pane width as a fraction of the window; persisted across opens. */
  widthFraction: number;
  fullscreen: boolean;
  /** Terminal hidden to an edge peek tab, without detaching. Transient (the
   *  pane's `target` isn't persisted either); `widthFraction` is left
   *  untouched, so reopening restores the exact prior width for free. */
  collapsed: boolean;
  /** Focus mode: the context rail is hidden and the terminal fills the
   *  board-strip space; the sidebar stays (distinct from `fullscreen`, which
   *  covers everything). Persisted like `widthFraction` — a layout
   *  preference, not per-session state, so it survives a switch or reopen. */
  railCollapsed: boolean;
  /** Bumped by openPane on an already-open session — tells the pane to grab focus. */
  focusNonce: number;
  openPane: (target: PaneTarget) => void;
  closePane: () => void;
  setWidthFraction: (fraction: number) => void;
  toggleFullscreen: () => void;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
  setRailCollapsed: (collapsed: boolean) => void;
  toggleRailCollapsed: () => void;
}

export const usePaneStore = create<PaneState>((set, get) => ({
  target: null,
  widthFraction: storedFraction(),
  fullscreen: false,
  collapsed: false,
  railCollapsed: storedRailCollapsed(),
  focusNonce: 0,
  openPane: (target) => {
    const current = get().target;
    // Re-click on the same session: focus the existing pane, never re-attach —
    // and if it was collapsed, bring it back (clicking the session means "show
    // me it", not "focus a hidden pane").
    if (current && current.sessionId === target.sessionId) {
      set((s) => ({ collapsed: false, focusNonce: s.focusNonce + 1 }));
      return;
    }
    set((s) => ({ target, fullscreen: false, collapsed: false, focusNonce: s.focusNonce + 1 }));
  },
  closePane: () => set({ target: null, fullscreen: false, collapsed: false }),
  setWidthFraction: (fraction) => {
    const clamped = Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, fraction));
    window.localStorage.setItem(WIDTH_KEY, String(clamped));
    set({ widthFraction: clamped });
  },
  toggleFullscreen: () => set((s) => ({ fullscreen: !s.fullscreen })),
  setCollapsed: (collapsed) => set({ collapsed }),
  toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
  setRailCollapsed: (collapsed) => {
    window.localStorage.setItem(RAIL_KEY, collapsed ? "1" : "0");
    set({ railCollapsed: collapsed });
  },
  toggleRailCollapsed: () => {
    const next = !get().railCollapsed;
    window.localStorage.setItem(RAIL_KEY, next ? "1" : "0");
    set({ railCollapsed: next });
  },
}));

/** Is the keyboard currently inside the session pane? Global shortcut handlers
 *  (board hotkeys, view switches) must stand down while true — every key
 *  belongs to the TUI. */
export function paneHasFocus(): boolean {
  return document.activeElement?.closest(".session-pane") != null;
}
