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
  /** Source folder Tildone discovers an icon from. See migration 010:
   *  null = auto-guess ~/projects/<name>; "" = icon disabled (colour dot);
   *  "<path>" = use this folder. */
  folder_path: string | null;
  /** Short unique code for the task reference, e.g. "TIL". Derived from the name
   * at creation; NULL only on legacy rows the backfill hasn't reached yet. */
  code: string | null;
}

/** Result of icon discovery for one project (Rust: discover_project_icon). */
export interface ProjectIcon {
  /** The folder actually scanned — the resolved guess or the override. */
  folder: string;
  iconPath: string | null;
  /** data: URI to render, or null to fall back to the colour dot. */
  dataUri: string | null;
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
  /** Set only by "Move older off board"; NULL keeps a done task eligible for the
   * board's Done window. Cleared when a task leaves Done. Not a delete — the task
   * still shows in Completed. */
  archived_at: string | null;
  /** Per-code counter (1..N), assigned once at creation and never changed — the
   * ref stays stable when a task moves to another project. NULL on legacy rows
   * the backfill hasn't reached yet. */
  number: number | null;
  /** Frozen "CODE-N" reference shown on the card and accepted by the MCP tools,
   * e.g. "TIL-3". Immutable after creation. NULL only pre-backfill. */
  ref: string | null;
  /** When an agent changed this task without you having looked since. NULL means
   * seen. Set only by the agent server — a change you made yourself is one you
   * saw, so the drag and the editor never stamp it. Rendered as the Tildone mark
   * held before its check settles; opening the card completes it and clears this. */
  unseen_at: string | null;
  tag_ids: number[];
}

export interface Subtask {
  id: number;
  task_id: number;
  title: string;
  done: boolean;
  position: number;
}

/** Subtasks titled "verify: …" are the task's review checklist: proposed by the
 * agent that flags needs-review, ticked only by the user (the MCP server refuses
 * agent ticks). The prefix IS the storage — no separate table, no new tools.
 * Keep this pattern in step with `is_verify_title` in src-tauri/src/agent.rs. */
export const VERIFY_PREFIX = /^verify:\s+/i;

export function isVerifyStep(s: Subtask): boolean {
  return VERIFY_PREFIX.test(s.title.trim());
}

export function verifyStepLabel(s: Subtask): string {
  return s.title.trim().replace(VERIFY_PREFIX, "");
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

export interface TaskLink {
  id: number;
  task_id: number;
  url: string;
  label: string;
  kind: string; // pr | branch | commit | worktree | other
}

export interface Comment {
  id: number;
  task_id: number;
  body: string;
  // 'user' | 'agent'. Unlike ActivityEntry this is never null — every comment is
  // authored at write time by a caller that knows which it is (migration 012).
  actor_kind: string;
  // The agent's own MCP client name (e.g. 'claude-code'); null for the user.
  actor_name: string | null;
  created_at: string;
}

export type LinkKind = "pr" | "branch" | "commit" | "worktree" | "other";

export const LINK_KINDS: LinkKind[] = ["pr", "branch", "commit", "worktree", "other"];

export const LINK_KIND_LABELS: Record<LinkKind, string> = {
  pr: "Pull request",
  branch: "Branch",
  commit: "Commit",
  worktree: "Worktree",
  other: "Link",
};

// Per-kind accent, hardcoded like PRIORITY_COLORS and picked to read on both themes.
export const LINK_KIND_COLORS: Record<LinkKind, string> = {
  pr: "#8250df",
  branch: "#1a7f5a",
  commit: "#dd5b00",
  worktree: "#2a9d99",
  other: "#787671",
};

/** A stored kind string is untrusted (an older or hand-written row); fold anything
 *  unrecognised to "other" so the UI always has a colour and icon. */
export function asLinkKind(kind: string): LinkKind {
  return (LINK_KINDS as string[]).includes(kind) ? (kind as LinkKind) : "other";
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
