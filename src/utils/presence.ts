// What a card knows about the agent on it.
//
// Two sources, deliberately kept apart until the moment of render:
//
//   live     — reported by the agent's own hook, resolved in Rust (which alone can
//              ask the OS whether the session's process still exists). Truth.
//   fallback — derived from the newest agent row in `task_activity`, i.e. the age of
//              the last board write. A guess, and the guess this feature exists to
//              stop making: an agent grinding for 25 minutes without logging looks
//              exactly like one that touched the card once and left.
//
// The fallback is not dead code. It is the graceful-degradation path for every agent
// with no heartbeat hook installed — Codex, Cursor, a Claude Code that has not
// connected — and for a Tildone whose agent server is not running. Those cards keep
// working exactly as they do today: an agent mark and a timestamp, no live state.
//
// They are separate store fields rather than one merged map because `reload()`
// replaces everything `fetchAll()` returns, wholesale. Merging at write time would
// let a routine reload clobber live state with stale activity data until the next
// poll — a card blinking from "working" to "quiet" and back every time any agent
// wrote to the board.

import { isRecentPresence } from "./dates";

/** What the card renders. `idle` is a wire value from the hook and never reaches here. */
export type PresenceState = "working" | "blocked" | "quiet";

/** One entry from the Rust `agent_presence` command. Mirrors `PresenceEntry` in agent.rs. */
export interface LivePresence {
  task_id: number;
  /** The session behind this entry — what the editor's jump-to-session button
   *  hands back to the `focus_session` command. */
  session_id: string;
  agent_name: string | null;
  state: PresenceState;
  at: string;
  branch: string | null;
  cwd: string | null;
  last_log: string | null;
}

/** The activity-derived fallback: who last wrote to this task, and when. */
export interface FallbackPresence {
  name: string | null;
  at: string;
}

export interface CardPresence {
  name: string | null;
  state: PresenceState;
  /** ISO timestamp behind "quiet 25m". */
  at: string;
  branch: string | null;
  last_log: string | null;
  /** True when this came from a live heartbeat rather than the age of a write. */
  live: boolean;
}

/**
 * Resolve what to show for one task.
 *
 * A live entry always wins: it is reported and PID-checked, while the fallback is an
 * inference from a timestamp. When there is no live entry, an agent that wrote within
 * the presence window still shows — as `quiet`, which is the honest thing to say
 * about a write whose author may be long gone. Past that window, nothing: it is
 * history, and history lives in the Activity feed.
 */
export function cardPresence(
  taskId: number,
  live: Record<number, LivePresence>,
  fallback: Record<number, FallbackPresence>,
): CardPresence | null {
  const entry = live[taskId];
  if (entry) {
    return {
      name: entry.agent_name,
      state: entry.state,
      at: entry.at,
      branch: entry.branch,
      last_log: entry.last_log,
      live: true,
    };
  }
  const old = fallback[taskId];
  if (!old || !isRecentPresence(old.at)) return null;
  return {
    name: old.name,
    // Never "working": without a heartbeat we do not know, and guessing from a fresh
    // timestamp is the exact bug this replaced.
    state: "quiet",
    at: old.at,
    branch: null,
    last_log: null,
    live: false,
  };
}

/** Index the Rust command's flat list by task, for O(1) lookup per card. */
export function byTask(entries: LivePresence[]): Record<number, LivePresence> {
  const out: Record<number, LivePresence> = {};
  for (const e of entries) out[e.task_id] = e;
  return out;
}
