import { useMemo } from "react";
import { visibleTasks } from "../selectors";
import { useStore } from "../store";
import { isSingleProjectSelection } from "../types";
import type { Task } from "../types";
import { compareTasks } from "../utils/dates";
import { TildoneMark } from "./Brand";
import { TaskRow } from "./TaskRow";

interface Group {
  key: string;
  label: string | null;
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

    switch (selection.type) {
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
  const showProject = !isSingleProjectSelection(selection);

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
      {groups.map((group) =>
        group.tasks.length === 0 ? null : (
          <section key={group.key} className="task-group">
            {group.label && (
              <h2 className="group-label">
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
