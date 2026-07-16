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

export interface Subtask {
  id: number;
  task_id: number;
  title: string;
  done: boolean;
  position: number;
}

export interface ActivityEntry {
  id: number;
  task_id: number;
  label: string;
  created_at: string;
  // 'user' | 'agent' | null. null on rows written before migration 006 — genuinely
  // unknown, rendered as neither rather than guessed.
  actor_kind: string | null;
  // The agent's own MCP client name (e.g. 'claude-code'); null for user and legacy rows.
  actor_name: string | null;
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

/**
 * Tag names the board renders as states rather than labels.
 *
 * They are tags and not status values on purpose: status is a CHECK constraint,
 * and widening it needs a table rebuild that cannot run inside a plugin-sql
 * migration — see docs/decisions/2026-07-16-sqlite-migration-safety.md. The
 * three columns stay; these two carry the card instead.
 *
 * Order is precedence: the first match wins, so blocked outranks needs-review.
 * Matched case-insensitively.
 */
export const RESERVED_TAGS = ["blocked", "needs-review"] as const;
export type ReservedTag = (typeof RESERVED_TAGS)[number];

export const RESERVED_TAG_LABELS: Record<ReservedTag, string> = {
  blocked: "Blocked",
  "needs-review": "Needs review",
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
