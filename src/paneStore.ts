// The embedded attach pane's state — deliberately its own tiny store, apart
// from the board store: opening a terminal must never ride through (or
// trigger) the board's reload() wholesale-replacement cycle.
//
// One pane at a time by design (spec 2026-07-19-embedded-attach-pane): the
// jump is "go to the session", not a multiplexer. SessionPane owns the PTY
// lifecycle; this store only says which session the pane is showing.

import { create } from "zustand";

/** What the pane needs to attach and label itself. */
export interface PaneTarget {
  /** Full session UUID — the claim's identity, for re-click matching. */
  sessionId: string;
  /** The short id `claude attach` takes, from the Rust `attach_target` command. */
  shortId: string;
  /** Card context for the header: "TIL-100" (null on legacy rows). */
  taskRef: string | null;
  taskId: number;
  /** Session display name, if the claim knows one. */
  name: string | null;
}

const WIDTH_KEY = "tildone.pane.widthFraction";
/** Spec default: the pane takes 3/4 of the window. */
const DEFAULT_FRACTION = 0.75;
const MIN_FRACTION = 0.3;
const MAX_FRACTION = 0.9;

function storedFraction(): number {
  const raw = window.localStorage.getItem(WIDTH_KEY);
  // Number(null) is 0, which is finite — an absent key must fall through to
  // the default, not clamp to the minimum width.
  if (raw === null) return DEFAULT_FRACTION;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_FRACTION;
  return Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, parsed));
}

interface PaneState {
  target: PaneTarget | null;
  /** Pane width as a fraction of the window; persisted across opens. */
  widthFraction: number;
  fullscreen: boolean;
  /** Bumped by openPane on an already-open session — tells the pane to grab focus. */
  focusNonce: number;
  openPane: (target: PaneTarget) => void;
  closePane: () => void;
  setWidthFraction: (fraction: number) => void;
  toggleFullscreen: () => void;
}

export const usePaneStore = create<PaneState>((set, get) => ({
  target: null,
  widthFraction: storedFraction(),
  fullscreen: false,
  focusNonce: 0,
  openPane: (target) => {
    const current = get().target;
    // Re-click on the same session: focus the existing pane, never re-attach.
    if (current && current.sessionId === target.sessionId) {
      set((s) => ({ focusNonce: s.focusNonce + 1 }));
      return;
    }
    set((s) => ({ target, fullscreen: false, focusNonce: s.focusNonce + 1 }));
  },
  closePane: () => set({ target: null, fullscreen: false }),
  setWidthFraction: (fraction) => {
    const clamped = Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, fraction));
    window.localStorage.setItem(WIDTH_KEY, String(clamped));
    set({ widthFraction: clamped });
  },
  toggleFullscreen: () => set((s) => ({ fullscreen: !s.fullscreen })),
}));

/** Is the keyboard currently inside the session pane? Global shortcut handlers
 *  (board hotkeys, view switches) must stand down while true — every key
 *  belongs to the TUI. */
export function paneHasFocus(): boolean {
  return document.activeElement?.closest(".session-pane") != null;
}
