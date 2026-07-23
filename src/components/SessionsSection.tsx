// The sidebar's Sessions section (spec 2026-07-20-shell-escape-hatch-
// session-first-intake, UI Option A): every hosted session as a row —
// bound or unbound — plus the "+ New session" entry point that spawns an
// UNBOUND session (adapter + cwd only; bind-on-claim or the expiry chip's
// "make it a task" cards it later). Clicking a row opens the existing
// single pane; the one-pane-at-a-time law is untouched.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useHostStore, type HostSession } from "../hostStore";
import { usePaneStore } from "../paneStore";
import { useStore } from "../store";
import { adapterGlyph, sessionRowModel, suggestedTitle } from "../utils/sessions";
import { IconPlus, IconX } from "./Icons";

export function SessionsSection() {
  const sessions = useHostStore((s) => s.sessions);
  const adapters = useHostStore((s) => s.adapters);
  const refresh = useHostStore((s) => s.refresh);
  const [picker, setPicker] = useState(false);
  const [cwd, setCwd] = useState("");
  const [cwds, setCwds] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  async function openPicker() {
    setPicker(true);
    setError("");
    try {
      // Recent claim cwds — where the board already knows work happens.
      const recent = await invoke<string[]>("recent_claim_cwds");
      setCwds(recent);
      if (!cwd && recent.length > 0) setCwd(recent[0]);
    } catch {
      /* suggestions are optional */
    }
  }

  function openSession(s: HostSession) {
    usePaneStore.getState().openPane({
      kind: "hosted",
      hostId: s.id,
      sessionId: `hosted-${s.id}`,
      taskRef: s.task_ref,
      taskId: s.task_id,
      name: s.adapter_name,
    });
  }

  async function start(adapterId: string) {
    if (starting) return;
    setStarting(true);
    setError("");
    try {
      const id = await invoke<number>("host_start", {
        taskId: null,
        taskRef: null,
        adapterId,
        claimCwd: cwd.trim() || null,
        projectName: null,
        prompt: null,
        cols: 80,
        rows: 24,
      });
      setPicker(false);
      usePaneStore.getState().openPane({
        kind: "hosted",
        hostId: id,
        sessionId: `hosted-${id}`,
        taskRef: null,
        taskId: null,
        name: adapters.find((a) => a.id === adapterId)?.name ?? adapterId,
      });
      void refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  }

  /** The expiry chip's "make it a task": capture first, structure later — a
   *  bare inbox card titled from the typed first line, bound on the spot.
   *  Also the manual bind path for shells (no MCP to self-claim through). */
  async function makeTask(s: HostSession) {
    const title = suggestedTitle(s);
    const id = await useStore.getState().addTask({ title, project_id: null, due_date: null });
    const ref = useStore.getState().tasks.find((t) => t.id === id)?.ref ?? null;
    await invoke("host_bind_task", { sessionId: s.id, taskId: id, taskRef: ref }).catch(() => {});
    void refresh();
  }

  async function keep(s: HostSession) {
    await invoke("host_keep", { sessionId: s.id }).catch(() => {});
    void refresh();
  }

  /** Close (kill) the session — a live CLI we own is terminated, an exited row
   *  is dismissed. One host_kill covers both: killing an already-dead session
   *  just removes its row. The sidebar X and the exited-row dismiss share it. */
  async function closeSession(s: HostSession) {
    await invoke("host_kill", { sessionId: s.id }).catch(() => {});
    void refresh();
  }

  return (
    <div className="sidebar-section">
      <div className="section-header">
        <span>Sessions</span>
        <button
          className="icon-btn"
          aria-label="New session"
          title="New session — no card needed"
          onClick={() => (picker ? setPicker(false) : void openPicker())}
        >
          <IconPlus size={14} />
        </button>
      </div>
      {sessions.map((s) => {
        const m = sessionRowModel(s);
        return (
          <div key={s.id}>
            <div
              className="nav-item sess-row"
              onClick={() => openSession(s)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && openSession(s)}
            >
              <span className="sess-glyph">{adapterGlyph(s.adapter_id)}</span>
              <span className="nav-label sess-label">
                {m.label}
                {m.sublabel && <small>{m.sublabel}</small>}
              </span>
              {/* Status dot at rest; on hover it slides inward and the close
                  (X) eases in from the right to take the far-right slot. */}
              <span className="sess-tail">
                <button
                  className="sess-close"
                  aria-label={s.exited ? "Dismiss exited session" : "Close session"}
                  title={s.exited ? "Dismiss" : "Close session"}
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeSession(s);
                  }}
                >
                  <IconX size={12} />
                </button>
                <span className="sess-status">
                  <span className={`sess-dot sess-dot--${m.state}`} />
                </span>
              </span>
            </div>
            {m.unbound?.kind === "remind" && <div className="sess-hint">no card yet</div>}
            {m.unbound?.kind === "expire-soon" && (
              <div className="sess-hint sess-hint--expire">
                <span>closes in {m.unbound.countdown}</span>
                <button className="sess-hint-act" onClick={() => void makeTask(s)}>
                  make it a task
                </button>
                <button className="sess-hint-act" onClick={() => void keep(s)}>
                  keep
                </button>
              </div>
            )}
          </div>
        );
      })}
      {picker && (
        <div className="sess-new">
          <input
            className="sess-new-cwd"
            list="sess-cwds"
            placeholder="Directory…"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
          />
          <datalist id="sess-cwds">
            {cwds.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <div className="sess-new-adapters">
            {adapters
              .filter((a) => a.available)
              .map((a) => (
                <button
                  key={a.id}
                  className="sess-new-adapter"
                  disabled={starting}
                  onClick={() => void start(a.id)}
                >
                  {adapterGlyph(a.id)} {a.name}
                </button>
              ))}
          </div>
          {error && <p className="sess-error">{error}</p>}
        </div>
      )}
    </div>
  );
}
