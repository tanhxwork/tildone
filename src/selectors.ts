import type { Selection, Task } from "./types";
import { todayStr } from "./utils/dates";

export interface Filters {
  search: string;
  activeTagIds: number[];
  priorityFilter: number;
  showCompleted: boolean;
}

export function taskMatchesFilters(task: Task, filters: Filters): boolean {
  if (!filters.showCompleted && task.status === "done") return false;
  if (filters.priorityFilter && task.priority !== filters.priorityFilter) return false;
  if (
    filters.activeTagIds.length > 0 &&
    !filters.activeTagIds.every((id) => task.tag_ids.includes(id))
  ) {
    return false;
  }
  if (filters.search) {
    const haystack = `${task.title} ${task.notes}`.toLowerCase();
    if (!haystack.includes(filters.search.toLowerCase())) return false;
  }
  return true;
}

export function tasksForSelection(tasks: Task[], selection: Selection): Task[] {
  const today = todayStr();
  switch (selection.type) {
    case "today":
      return tasks.filter((t) => t.due_date !== null && t.due_date <= today);
    case "upcoming":
      return tasks.filter((t) => t.due_date !== null && t.due_date > today);
    case "inbox":
      return tasks.filter((t) => t.project_id === null);
    case "all":
      return tasks;
    case "project":
      return tasks.filter((t) => t.project_id === selection.projectId);
  }
}

export function visibleTasks(
  tasks: Task[],
  selection: Selection,
  filters: Filters,
): Task[] {
  return tasksForSelection(tasks, selection).filter((t) =>
    taskMatchesFilters(t, filters),
  );
}
