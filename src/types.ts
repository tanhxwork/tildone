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

// Priority and project/tag colors come from the Notion design system's brand
// palette (docs/design/notion-DESIGN.md).
export const PRIORITY_COLORS: Record<number, string> = {
  1: "#0075de",
  2: "#dd5b00",
  3: "#e03131",
};

export const COLOR_CHOICES = [
  "#5645d4",
  "#0075de",
  "#2a9d99",
  "#1aae39",
  "#dd5b00",
  "#e03131",
  "#ff64c8",
  "#787671",
];
