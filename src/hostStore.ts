// Board-hosted agent sessions (spec 2026-07-19-hosted-agent-sessions) — the
// frontend mirror of host.rs's session table. Its own tiny store for the same
// reason paneStore is: session state must never ride through the board
// store's wholesale reload() cycle.
//
// The mirror is event-driven, not polled: Rust emits `host-changed` on every
// start / exit / kill, and the store re-pulls the list. Aliveness here is a
// fact (the app owns the child process), not a heartbeat.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface HostSession {
  id: number;
  /** null = unbound: no card yet (spec 2026-07-20-shell-escape-hatch-
   *  session-first-intake). Bind-on-claim or "make it a task" fills it in. */
  task_id: number | null;
  task_ref: string | null;
  adapter_id: string;
  adapter_name: string;
  /** Where the CLI runs — the Sessions row's sublabel. Optional because
   *  locally-constructed HostSession literals predate it. */
  cwd?: string;
  /** The CLI exited (on its own or killed) but hasn't been dismissed — a
   *  crash must be visible on the board, not a silent vanish. */
  exited: boolean;
  /** Waiting-detect (F2): the session looks idle at a prompt. A heuristic
   *  read off the owned PTY's grid — the UI must present it as one. */
  waiting: boolean;
  /** The CLI's session id is captured and the adapter can resume (F3) — what
   *  lets the quit dialog promise "resumable next launch". */
  bound: boolean;
  /** Unbound lifecycle stage: quiet hint ("remind") or the expiry chip
   *  ("expire-soon"). Absent while quiet or bound. */
  unbound_stage?: "remind" | "expire-soon" | null;
  /** Seconds until expiry, in the expire-soon stage — the chip countdown. */
  expires_in_secs?: number | null;
  /** First line typed into an unbound session — "make it a task"'s title. */
  title_hint?: string | null;
  /** Is the single pane currently attached to (rendering) this session? Only
   *  the shown session is attached; switching the pane detaches the previous
   *  one. Optional because locally-constructed HostSession literals predate
   *  it. */
  attached?: boolean;
}

/** A dead-but-resumable session from a previous app run (F3). */
export interface Resumable {
  row_id: number;
  task_id: number;
  task_ref: string | null;
  adapter_id: string;
  adapter_name: string;
}

export interface HostAdapter {
  id: string;
  name: string;
  /** The CLI's binary resolves on this machine right now. */
  available: boolean;
}

interface HostState {
  sessions: HostSession[];
  adapters: HostAdapter[];
  resumables: Resumable[];
  refresh: () => Promise<void>;
  refreshAdapters: () => Promise<void>;
}

export const useHostStore = create<HostState>((set) => ({
  sessions: [],
  adapters: [],
  resumables: [],
  refresh: async () => {
    try {
      set({
        sessions: await invoke<HostSession[]>("host_list"),
        resumables: await invoke<Resumable[]>("host_resumables"),
      });
    } catch {
      /* commands unavailable (e.g. web preview) — the board works without */
    }
  },
  refreshAdapters: async () => {
    try {
      set({ adapters: await invoke<HostAdapter[]>("host_adapters") });
    } catch {
      /* same fallback */
    }
  },
}));

/** The task's hosted session, if any. Live one wins over an exited leftover. */
export function hostedForTask(sessions: HostSession[], taskId: number): HostSession | null {
  return (
    sessions.find((s) => s.task_id === taskId && !s.exited) ??
    sessions.find((s) => s.task_id === taskId) ??
    null
  );
}

/** The task's resumable session from a previous run, if any (F3). */
export function resumableForTask(resumables: Resumable[], taskId: number): Resumable | null {
  return resumables.find((r) => r.task_id === taskId) ?? null;
}

/** One-time wiring, called from App: initial pull + the change subscription. */
export function initHostStore(): () => void {
  const { refresh, refreshAdapters } = useHostStore.getState();
  void refresh();
  void refreshAdapters();
  const unlisten = listen("host-changed", () => void refresh());
  return () => {
    void unlisten.then((un) => un());
  };
}
