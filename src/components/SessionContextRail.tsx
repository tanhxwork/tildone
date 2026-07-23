// The context rail (spec 2026-07-23-session-context-rail): while a terminal is
// docked, the middle column stops re-rendering the squished board and becomes
// the board-side truth of the ACTIVE session's task — title, progress, the
// checklist, the activity feed, and the PR/branch chips — with a roster
// dropdown to re-target the one pane. An unbound session (no card yet) shows a
// minimal rail instead. The terminal is the agent's voice; this is the board's.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fetchActivity } from "../db";
import { useHostStore } from "../hostStore";
import { usePaneStore } from "../paneStore";
import { useStore } from "../store";
import { isVerifyStep, verifyStepLabel, type ActivityEntry } from "../types";
import { latestLinkPerKind } from "../utils/links";
import { adapterGlyph, cwdBasename, suggestedTitle } from "../utils/sessions";
import { useSwitcherTabs, switchToSession } from "./useSwitcher";
import { prChip } from "./prChip";
import { IconChevronDown } from "./Icons";

const PRIORITY_LABEL = ["", "low", "medium", "high"] as const;

export function SessionContextRail() {
  const target = usePaneStore((s) => s.target);
  const tasks = useStore((s) => s.tasks);
  const subtasks = useStore((s) => s.subtasks);
  const links = useStore((s) => s.links);
  const openEditor = useStore((s) => s.openEditor);
  const hostSessions = useHostStore((s) => s.sessions);
  const tabs = useSwitcherTabs();
  const [rosterOpen, setRosterOpen] = useState(false);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);

  // The rail follows the LIVE session, like the pane's ref chip: an unbound
  // hosted session that binds-on-claim while the rail is up gains its card
  // without a re-open.
  const liveHost =
    target?.kind === "hosted" ? hostSessions.find((s) => s.id === target.hostId) : null;
  const taskId = liveHost?.task_id ?? target?.taskId ?? null;
  const task = taskId != null ? (tasks.find((t) => t.id === taskId) ?? null) : null;

  // The rail's activity is fetched here, decoupled from the editor's single
  // activity slot (store.loadActivity only fills it for the OPEN editor task).
  // Re-fetch on task change and whenever an agent writes to the DB, so the feed
  // is as live as the board.
  useEffect(() => {
    if (taskId == null) {
      setActivity([]);
      return;
    }
    let alive = true;
    const load = () => {
      fetchActivity(taskId)
        .then((a) => {
          if (alive) setActivity(a);
        })
        .catch(() => {});
    };
    load();
    const un = listen("agent-db-changed", load);
    return () => {
      alive = false;
      void un.then((fn) => fn());
    };
  }, [taskId]);

  const steps = useMemo(
    () =>
      taskId != null
        ? subtasks.filter((s) => s.task_id === taskId).sort((a, b) => a.position - b.position)
        : [],
    [subtasks, taskId],
  );
  const doneCount = steps.filter((s) => s.done).length;
  const taskLinks = taskId != null ? (links[taskId] ?? []) : [];

  function roster() {
    if (tabs.length < 2 && !rosterOpen) return null;
    return (
      <>
        <button
          type="button"
          className="rail-roster"
          aria-expanded={rosterOpen}
          onClick={() => setRosterOpen((o) => !o)}
          title="Switch session"
        >
          <span className="rail-roster-dot" />
          {tabs.length} live
          <IconChevronDown size={12} />
        </button>
        {rosterOpen && (
          <div className="rail-roster-menu" role="listbox">
            {tabs.map((t) => (
              <button
                type="button"
                key={t.sessionId}
                className={`rail-roster-item${t.active ? " is-active" : ""}`}
                role="option"
                aria-selected={t.active}
                onClick={() => {
                  switchToSession(t.sessionId);
                  setRosterOpen(false);
                }}
              >
                <span className={`sess-dot sess-dot--${t.state}`} />
                <span className="rail-roster-label">{t.label}</span>
              </button>
            ))}
          </div>
        )}
      </>
    );
  }

  // Unbound: no card yet. A minimal rail — what it is and where, plus the same
  // "make it a task" capture the sidebar offers — never the board, never an error.
  if (task == null) {
    const s = liveHost;
    return (
      <div className="context-rail context-rail--unbound">
        <header className="rail-head">
          <span className="rail-ref rail-ref--none">no card yet</span>
          {roster()}
        </header>
        <div className="rail-empty">
          <span className="rail-empty-glyph">{s ? adapterGlyph(s.adapter_id) : "○"}</span>
          <p className="rail-empty-title">{s ? suggestedTitle(s) : "Session"}</p>
          {s?.cwd && <p className="rail-empty-cwd">{cwdBasename(s.cwd)}</p>}
          {s && !s.exited && (
            <button
              type="button"
              className="rail-make-task"
              onClick={() => void makeTask(s.id, suggestedTitle(s))}
            >
              Make it a task
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="context-rail">
      <header className="rail-head">
        <span className="rail-ref">{task.ref ?? "task"}</span>
        {roster()}
      </header>
      <div className="rail-scroll">
        <div className="rail-block">
          <div className="rail-chips">
            <span className={`rail-status rail-status--${task.status}`}>{task.status}</span>
            {task.priority > 0 && (
              <span className="rail-chip">{PRIORITY_LABEL[task.priority]}</span>
            )}
          </div>
          <h2 className="rail-title">{task.title}</h2>
          {steps.length > 0 && (
            <div className="rail-progress">
              <div className="rail-bar">
                <i style={{ transform: `scaleX(${doneCount / steps.length})` }} />
              </div>
              <span className="rail-progress-count">
                {doneCount}/{steps.length}
              </span>
            </div>
          )}
        </div>

        {steps.length > 0 && (
          <div className="rail-block">
            <div className="rail-label">Checklist</div>
            <ul className="rail-checklist">
              {steps.map((s) => {
                const verify = isVerifyStep(s);
                return (
                  <li
                    key={s.id}
                    className={`rail-check${s.done ? " is-done" : ""}${verify ? " is-verify" : ""}`}
                  >
                    <span className="rail-check-box" />
                    <span className="rail-check-label">
                      {verify ? verifyStepLabel(s) : s.title}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {taskLinks.length > 0 && (
          <div className="rail-block">
            <div className="rail-links">
              {latestLinkPerKind(taskLinks).map(({ link }) => {
                const pr = prChip(link);
                return (
                  <a
                    key={link.id}
                    className={`rail-link${pr ? ` ${pr.cls}` : ""}`}
                    style={pr ? { color: pr.color, borderColor: pr.color } : undefined}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    title={pr ? pr.title : link.url}
                  >
                    {link.label || link.url}
                    {pr?.suffix}
                  </a>
                );
              })}
            </div>
          </div>
        )}

        <div className="rail-block rail-block--grow">
          <div className="rail-label">Activity</div>
          {activity.length === 0 ? (
            <p className="rail-empty-feed">No activity yet.</p>
          ) : (
            <ul className="rail-feed">
              {activity
                .slice()
                .reverse()
                .map((e) => (
                  <li key={e.id} className={`rail-ev rail-ev--${e.actor_kind ?? "none"}`}>
                    <span className="rail-ev-dot" />
                    <span className="rail-ev-label">{e.label}</span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </div>
      <button type="button" className="rail-open-card" onClick={() => openEditor(task.id)}>
        Open full card
      </button>
    </div>
  );

  async function makeTask(sessionId: number, title: string) {
    const id = await useStore.getState().addTask({ title, project_id: null, due_date: null });
    const ref = useStore.getState().tasks.find((t) => t.id === id)?.ref ?? null;
    await invoke("host_bind_task", { sessionId, taskId: id, taskRef: ref }).catch(() => {});
    void useHostStore.getState().refresh();
  }
}
