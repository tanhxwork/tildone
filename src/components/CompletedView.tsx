import { format } from "date-fns";
import { useMemo, useState } from "react";
import { liveTasks, trashedTasks } from "../selectors";
import { useStore } from "../store";
import type { Task } from "../types";
import { dueLabel, todayStr } from "../utils/dates";
import { IconCheck, IconTrash } from "./Icons";

type Tab = "completed" | "trash";

function dayOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function timeOf(timestamp: string): string {
  // Works for both ISO ("2026-07-06T10:24:00.000Z" local-ignored) and SQLite datetimes.
  const d = new Date(timestamp.includes("T") ? timestamp : timestamp.replace(" ", "T"));
  return isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function groupByDay(tasks: Task[], stamp: (t: Task) => string): { day: string; tasks: Task[] }[] {
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    const day = dayOf(stamp(t));
    const list = map.get(day) ?? [];
    list.push(t);
    map.set(day, list);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] > b[0] ? -1 : 1))
    .map(([day, list]) => ({ day, tasks: list }));
}

export function CompletedView() {
  const { tasks, projects, patchTask, restoreTask, destroyTask, emptyTrash, archiveOlderDone } =
    useStore();
  const [tab, setTab] = useState<Tab>("completed");
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  const completed = useMemo(
    () =>
      liveTasks(tasks)
        .filter((t) => t.status === "done" && t.completed_at !== null)
        .sort((a, b) => (a.completed_at! > b.completed_at! ? -1 : 1)),
    [tasks],
  );

  // How many completed cards are still sitting in the board's Done window that the
  // "Move older off board" button would clear now: not finished today, not already
  // cleared. When zero, the button has nothing to do and stays hidden.
  const clearableOlder = useMemo(() => {
    const today = todayStr();
    return completed.filter(
      (t) =>
        t.archived_at === null &&
        format(new Date(t.completed_at!), "yyyy-MM-dd") !== today,
    ).length;
  }, [completed]);

  const trashed = useMemo(
    () =>
      trashedTasks(tasks).sort((a, b) => (a.deleted_at! > b.deleted_at! ? -1 : 1)),
    [tasks],
  );

  const groups =
    tab === "completed"
      ? groupByDay(completed, (t) => t.completed_at!)
      : groupByDay(trashed, (t) => t.deleted_at!);

  return (
    <div className="completed-view">
      <div className="completed-toolbar">
        <div className="segmented" role="group" aria-label="Completed or Trash">
          <button
            className={tab === "completed" ? "active" : ""}
            onClick={() => setTab("completed")}
          >
            Completed{completed.length > 0 ? ` ${completed.length}` : ""}
          </button>
          <button className={tab === "trash" ? "active" : ""} onClick={() => setTab("trash")}>
            Trash{trashed.length > 0 ? ` ${trashed.length}` : ""}
          </button>
        </div>
        {tab === "completed" && clearableOlder > 0 && (
          <button
            className="btn small"
            title="Clear every not-today card from the board's Done column. They stay here in Completed."
            onClick={() => void archiveOlderDone()}
          >
            Move older off board
          </button>
        )}
        {tab === "trash" && trashed.length > 0 && (
          <button
            className={`btn small ${confirmEmpty ? "danger" : "ghost-danger"}`}
            onClick={() => {
              if (confirmEmpty) {
                void emptyTrash();
                setConfirmEmpty(false);
              } else {
                setConfirmEmpty(true);
              }
            }}
            onBlur={() => setConfirmEmpty(false)}
          >
            {confirmEmpty ? "Really delete forever?" : "Empty trash"}
          </button>
        )}
      </div>

      <p className="completed-blurb">
        {tab === "completed"
          ? "Everything you've finished, newest first — your \"what did I actually do\" answer."
          : "Deleted tasks are kept for 30 days, then removed for good."}
      </p>

      {groups.length === 0 && (
        <div className="empty-state">
          <p className="empty-title">
            {tab === "completed" ? "Nothing completed yet" : "Trash is empty"}
          </p>
          <p className="empty-hint">
            {tab === "completed"
              ? "Finished tasks land here with a timestamp."
              : "Deleted tasks can be restored from here for 30 days."}
          </p>
        </div>
      )}

      {groups.map((group) => (
        <section key={group.day} className="task-group">
          <h2 className="group-label">
            {dueLabel(group.day)}
            <span className="group-count">{group.tasks.length}</span>
          </h2>
          {group.tasks.map((task) => {
            const project =
              task.project_id !== null ? projectById.get(task.project_id) : undefined;
            return (
              <div key={task.id} className="history-row">
                <span className={`task-check checked history-check ${tab === "trash" ? "trash" : ""}`}>
                  {tab === "completed" ? <IconCheck size={11} /> : <IconTrash size={10} />}
                </span>
                <span className="history-title">{task.title}</span>
                <span className="history-meta">
                  {project && (
                    <span className="project-label">
                      <span className="project-dot" style={{ background: project.color }} />
                      {project.name}
                    </span>
                  )}
                  <span className="history-time">
                    {timeOf(tab === "completed" ? task.completed_at! : task.deleted_at!)}
                  </span>
                </span>
                {tab === "completed" ? (
                  <button
                    className="btn small history-action"
                    onClick={() => void patchTask(task.id, { status: "todo" })}
                  >
                    Restore
                  </button>
                ) : (
                  <span className="history-actions">
                    <button
                      className="btn small history-action"
                      onClick={() => void restoreTask(task.id)}
                    >
                      Restore
                    </button>
                    <button
                      className="btn small ghost-danger history-action"
                      onClick={() => void destroyTask(task.id)}
                    >
                      Delete forever
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
