export type Status = "todo" | "doing" | "done";

export const STATUSES: Status[] = ["todo", "doing", "done"];

export const STATUS_LABELS: Record<Status, string> = {
  todo: "To Do",
  doing: "In Progress",
  done: "Done",
};

export interface Project {
  id: number;
  name: string;
  color: string;
  position: number;
}

export interface Tag {
  id: number;
  name: string;
  color: string;
}

export interface Task {
  id: number;
  project_id: number | null;
  title: string;
  notes: string;
  status: Status;
  priority: number; // 0 none, 1 low, 2 medium, 3 high
  due_date: string | null; // YYYY-MM-DD
  position: number;
  created_at: string;
  completed_at: string | null;
  deleted_at: string | null;
  tag_ids: number[];
}

export type Selection =
  | { type: "today" }
  | { type: "upcoming" }
  | { type: "inbox" }
  | { type: "all" }
  | { type: "week" }
  | { type: "review" }
  | { type: "completed" }
  | { type: "project"; projectId: number };

/** Pages render their own layout; view mode, filters and quick add only apply to task lists. */
export function isPageSelection(selection: Selection): boolean {
  return (
    selection.type === "week" || selection.type === "review" || selection.type === "completed"
  );
}

export type ViewMode = "list" | "board" | "table" | "calendar";

export const PRIORITY_LABELS: Record<number, string> = {
  0: "None",
  1: "Low",
  2: "Medium",
  3: "High",
};

export const PRIORITY_COLORS: Record<number, string> = {
  1: "#3b82f6",
  2: "#f59e0b",
  3: "#ef4444",
};

export const COLOR_CHOICES = [
  "#6366f1",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#8b5cf6",
  "#64748b",
];
