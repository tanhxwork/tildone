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
  task_id: number;
  task_ref: string | null;
  adapter_id: string;
  adapter_name: string;
  /** The CLI exited (on its own or killed) but hasn't been dismissed — a
   *  crash must be visible on the board, not a silent vanish. */
  exited: boolean;
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
  refresh: () => Promise<void>;
  refreshAdapters: () => Promise<void>;
}

export const useHostStore = create<HostState>((set) => ({
  sessions: [],
  adapters: [],
  refresh: async () => {
    try {
      set({ sessions: await invoke<HostSession[]>("host_list") });
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
