// The session switcher's live wiring (spec 2026-07-23-session-context-rail).
// The pure list model is in utils/sessions (switcherSessions/nextSessionId);
// this binds it to the stores and turns a chosen sessionId back into a pane
// re-target. One visible pane throughout — switching is openPane, the same
// re-attach + buffer-replay the jump has always used.

import { invoke } from "@tauri-apps/api/core";
import { useHostStore } from "../hostStore";
import { usePaneStore } from "../paneStore";
import { nextAfterClose, switcherSessions, type SwitchTab } from "../utils/sessions";

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

/** Close the active session (Ghostty's ⌘W; user decision 2026-07-23). A hosted
 *  CLI we own is *killed* — `host_kill` stops the child and removes its row —
 *  because closing a terminal ends its process. A foreign attach we don't own
 *  can't be killed, so it is merely detached (the pane's own teardown runs
 *  `pty_close`); the daemon keeps it running. Either way the view then falls to
 *  the next live session, or closes to the board when none remain.
 *
 *  This *terminates* where the old detach-and-fall-to-next never did: a
 *  detached session stayed live, so the fall-through always re-found the other
 *  session and the pane ping-ponged forever. A killed session is genuinely
 *  gone, so `nextAfterClose` converges. The confirm prompt for a live hosted
 *  session is the caller's (SessionPane's) — by here the decision is made.
 *
 *  `host_kill` emits `host-changed` and the store re-pulls asynchronously, so
 *  we `await refresh()` before choosing the next target: otherwise the killed
 *  row could still read live and we'd re-target a dead session. */
export async function closeCurrentSession(): Promise<void> {
  const st = usePaneStore.getState();
  const cur = st.target;
  if (!cur) return;
  if (cur.kind === "hosted") {
    await invoke("host_kill", { sessionId: cur.hostId }).catch(() => {});
    await useHostStore.getState().refresh();
  }
  const next = nextAfterClose(useHostStore.getState().sessions, cur.sessionId);
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
