import type { Selection, Task } from "./types";
import { todayStr } from "./utils/dates";

export interface Filters {
  search: string;
  activeTagIds: number[];
  priorityFilter: number;
  showCompleted: boolean;
}

/** Tasks that are not in the trash — every view except Trash works on these. */
export function liveTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.deleted_at === null);
}

export function trashedTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.deleted_at !== null);
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
  const live = liveTasks(tasks);
  const today = todayStr();
  switch (selection.type) {
    case "today":
      return live.filter((t) => t.due_date !== null && t.due_date <= today);
    case "upcoming":
      return live.filter((t) => t.due_date !== null && t.due_date > today);
    case "inbox":
      return live.filter((t) => t.project_id === null);
    case "all":
    // Pages (week, review, completed) do their own slicing from the full live set.
    case "week":
    case "review":
    case "completed":
      return live;
    case "project":
      return live.filter((t) => t.project_id === selection.projectId);
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
