// The session switcher's live wiring (spec 2026-07-23-session-context-rail).
// The pure list model is in utils/sessions (switcherSessions/nextSessionId);
// this binds it to the stores and turns a chosen sessionId back into a pane
// re-target. One visible pane throughout — switching is openPane, the same
// re-attach + buffer-replay the jump has always used.

import { useHostStore } from "../hostStore";
import { usePaneStore } from "../paneStore";
import { switcherSessions, type SwitchTab } from "../utils/sessions";

/** The switcher list for the current pane: every hosted session, plus the
 *  active attach target when it isn't itself hosted, with the active one
 *  marked. Re-renders when hosted sessions or the pane target change. */
export function useSwitcherTabs(): SwitchTab[] {
  const sessions = useHostStore((s) => s.sessions);
  const target = usePaneStore((s) => s.target);
  const activeId = target?.sessionId ?? null;
  const activeAttach =
    target && target.kind === "attach"
      ? { sessionId: target.sessionId, ref: target.taskRef }
      : null;
  return switcherSessions(sessions, activeId, activeAttach);
}

/** Hand the one pane to a session by its switcher id. Re-selecting the active
 *  session just focuses it (and un-collapses a hidden terminal); a hosted id
 *  re-targets via openPane. A foreign attach session lives only as the current
 *  pane target, so it is switchable only while it is already active. */
export function switchToSession(sessionId: string): void {
  const st = usePaneStore.getState();
  if (st.target?.sessionId === sessionId) {
    st.openPane(st.target); // same-session path: un-collapse + refocus, no re-attach
    return;
  }
  const m = /^hosted-(\d+)$/.exec(sessionId);
  if (!m) return;
  const s = useHostStore.getState().sessions.find((x) => x.id === Number(m[1]));
  if (!s) return;
  st.openPane({
    kind: "hosted",
    hostId: s.id,
    sessionId: `hosted-${s.id}`,
    taskRef: s.task_ref,
    taskId: s.task_id,
    name: s.adapter_name,
  });
}

/** Closing the active pane falls to the next live session — the tab metaphor
 *  (⌘W → next tab), and the spec's "closing the terminal falls focus to the
 *  next live session … when none remain [it closes]". Detaching never kills
 *  the session; it keeps running, we just stop showing it. */
export function closeOrNextSession(): void {
  const st = usePaneStore.getState();
  const cur = st.target;
  if (!cur) return;
  const next = useHostStore
    .getState()
    .sessions.find((s) => !s.exited && `hosted-${s.id}` !== cur.sessionId);
  if (next) {
    st.openPane({
      kind: "hosted",
      hostId: next.id,
      sessionId: `hosted-${next.id}`,
      taskRef: next.task_ref,
      taskId: next.task_id,
      name: next.adapter_name,
    });
  } else {
    st.closePane();
  }
}
