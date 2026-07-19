// Artifact facts (spec 2026-07-19-anycli-workspace-v2, F1) — the frontend
// mirror of artifacts.rs's facts map. Its own tiny store for the same reason
// hostStore is: this state must never ride through the board store's
// wholesale reload() cycle.
//
// Event-driven, not polled: Rust recomputes on filesystem events (FSEvents on
// transcripts and git refs) and emits `artifacts-changed`; the store re-pulls.
// These are durable-trace facts — they outlive the session that made them.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface ArtifactFacts {
  task_id: number;
  /** ISO timestamp of the newest transcript write, if any transcript exists. */
  last_active: string | null;
  /** Assistant turns in the newest transcript. */
  turns: number;
  /** Commits on the task's branch not on the default branch. */
  commits_ahead: number;
  /** Subjects of the newest of those commits (at most 3). */
  commit_subjects: string[];
  /** The last assistant message's text, truncated — "what did it just say". */
  last_message: string | null;
}

interface ArtifactState {
  facts: Record<number, ArtifactFacts>;
  refresh: () => Promise<void>;
}

export const useArtifactStore = create<ArtifactState>((set) => ({
  facts: {},
  refresh: async () => {
    try {
      const rows = await invoke<ArtifactFacts[]>("artifact_facts");
      set({ facts: Object.fromEntries(rows.map((f) => [f.task_id, f])) });
    } catch {
      /* commands unavailable (e.g. web preview) — the board works without */
    }
  },
}));

/** One-time wiring, called from App: initial pull + the change subscription. */
export function initArtifactStore(): () => void {
  void useArtifactStore.getState().refresh();
  const unlisten = listen("artifacts-changed", () =>
    void useArtifactStore.getState().refresh(),
  );
  return () => {
    void unlisten.then((un) => un());
  };
}
