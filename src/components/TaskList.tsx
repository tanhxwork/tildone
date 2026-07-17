import { useMemo } from "react";
import { visibleTasks } from "../selectors";
import { useStore } from "../store";
import type { Task } from "../types";
import { compareTasks, dueLabel, todayStr } from "../utils/dates";
import { TildoneMark } from "./Brand";
import { DailyPlan } from "./DailyPlan";
import { TaskRow } from "./TaskRow";

interface Group {
  key: string;
  label: string | null;
  accent?: "danger";
  tasks: Task[];
}

export function TaskList() {
  const {
    tasks,
    projects,
    selection,
    search,
    activeTagIds,
    priorityFilter,
    showCompleted,
  } = useStore();

  const groups = useMemo<Group[]>(() => {
    const visible = visibleTasks(tasks, selection, {
      search,
      activeTagIds,
      priorityFilter,
      showCompleted,
    }).sort(compareTasks);

    const today = todayStr();

    switch (selection.type) {
      case "today": {
        const overdue = visible.filter(
          (t) => t.due_date !== null && t.due_date < today && t.status !== "done",
        );
        const rest = visible.filter((t) => !overdue.includes(t));
        const result: Group[] = [];
        if (overdue.length > 0) {
          result.push({ key: "overdue", label: "Overdue", accent: "danger", tasks: overdue });
        }
        result.push({ key: "today", label: overdue.length > 0 ? "Today" : null, tasks: rest });
        return result;
      }
      case "upcoming": {
        const byDate = new Map<string, Task[]>();
        for (const t of visible) {
          const list = byDate.get(t.due_date!) ?? [];
          list.push(t);
          byDate.set(t.due_date!, list);
        }
        const dates = [...byDate.keys()].sort();
        const horizon = new Date();
        horizon.setDate(horizon.getDate() + 7);
        const horizonStr = horizon.toISOString().slice(0, 10);
        const result: Group[] = [];
        const later: Task[] = [];
        for (const date of dates) {
          if (date <= horizonStr) {
            result.push({ key: date, label: dueLabel(date), tasks: byDate.get(date)! });
          } else {
            later.push(...byDate.get(date)!);
          }
        }
        if (later.length > 0) {
          result.push({ key: "later", label: "Later", tasks: later });
        }
        return result;
      }
      case "all": {
        const result: Group[] = [];
        const inbox = visible.filter((t) => t.project_id === null);
        if (inbox.length > 0) {
          result.push({ key: "inbox", label: "Inbox", tasks: inbox });
        }
        for (const project of projects) {
          const list = visible.filter((t) => t.project_id === project.id);
          if (list.length > 0) {
            result.push({ key: `p${project.id}`, label: project.name, tasks: list });
          }
        }
        return result;
      }
      default:
        return [{ key: "main", label: null, tasks: visible }];
    }
  }, [tasks, projects, selection, search, activeTagIds, priorityFilter, showCompleted]);

  const isEmpty = groups.every((g) => g.tasks.length === 0);
  const showProject = selection.type !== "project" && selection.type !== "inbox";

  if (isEmpty) {
    return (
      <div className="empty-state">
        <TildoneMark width={36} className="empty-mark" />
        <p className="empty-title">
          {search || activeTagIds.length > 0 || priorityFilter
            ? "No tasks match your filters"
            : "All clear"}
        </p>
        <p className="empty-hint">
          {search || activeTagIds.length > 0 || priorityFilter
            ? "Try clearing the search or filters."
            : "Add a task above to get started."}
        </p>
      </div>
    );
  }

  return (
    <div className="task-list">
      {selection.type === "today" && <DailyPlan />}
      {groups.map((group) =>
        group.tasks.length === 0 ? null : (
          <section key={group.key} className="task-group">
            {group.label && (
              <h2 className={`group-label ${group.accent ?? ""}`}>
                {group.label}
                <span className="group-count">{group.tasks.length}</span>
              </h2>
            )}
            {group.tasks.map((task) => (
              <TaskRow key={task.id} task={task} showProject={showProject} />
            ))}
          </section>
        ),
      )}
    </div>
  );
}
