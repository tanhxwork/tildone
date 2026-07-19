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
  // PR-only merge status the chip renders (migration 016, written by set_pr_status).
  // Absent on non-PR links and on PR links the agent hasn't stamped yet — the chip
  // then falls back to its plain open-PR form.
  pr_state?: PrState | null; // merged | open | draft
  pr_behind?: number | null; // commits behind main, open PRs only
  // CI rollup observed by the board's own gh poll (F4, migration 018) —
  // rides the chip tooltip, never the chip color.
  pr_checks?: string | null; // pending | passing | failing
}

/** The merge status a PR chip can show (TIL-84). "open" splits at render into
 *  ready (behind 0) and behind (behind > 0). */
export type PrState = "merged" | "open" | "draft";

/** A screenshot pasted onto a task. The bytes live as a file under
 *  <app-data>/attachments/<task_id>/; `path` is relative to app-data so rows
 *  survive the app-data dir moving (dev vs release identifier). */
export interface TaskImage {
  id: number;
  task_id: number;
  path: string;
  filename: string;
  bytes: number;
  width: number | null;
  height: number | null;
  created_at: string;
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

// "file" is local evidence (a screenshot, a spec, a PDF) opened in its default
// app; the rest are http(s) links. See add_link in src-tauri/src/agent.rs.
export type LinkKind = "pr" | "branch" | "commit" | "worktree" | "other" | "file";

export const LINK_KINDS: LinkKind[] = ["pr", "branch", "commit", "worktree", "other", "file"];

export const LINK_KIND_LABELS: Record<LinkKind, string> = {
  pr: "Pull request",
  branch: "Branch",
  commit: "Commit",
  worktree: "Worktree",
  other: "Link",
  file: "File",
};

// Per-kind accent, hardcoded like PRIORITY_COLORS and picked to read on both themes.
export const LINK_KIND_COLORS: Record<LinkKind, string> = {
  pr: "#8250df",
  branch: "#1a7f5a",
  commit: "#dd5b00",
  worktree: "#2a9d99",
  other: "#787671",
  file: "#4b8fd6",
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
 * three columns stay; these three carry the card instead.
 *
 * `needs-landing` is the open-loop state: a task can be done yet still carry an
 * unmerged PR (draft, or behind main). The agent sets it at CLOSE when the PR is
 * not MERGED and clears it when the PR lands, so a done card never reads as
 * shipped while a branch is still in flight (TIL-84).
 *
 * Order is precedence: the first match wins, so blocked outranks needs-review,
 * which outranks needs-landing. Matched case-insensitively.
 */
export const RESERVED_TAGS = ["blocked", "needs-review", "needs-landing"] as const;
export type ReservedTag = (typeof RESERVED_TAGS)[number];

/** The reserved tags a landing in Done retires. Both are questions to the user —
 * answer me, check me — and a card the user (or an agent) just completed asks
 * neither any more; left alone they sit stale on the done card until someone
 * x-es them off by hand. `needs-landing` is exempt: done-with-an-unmerged-PR is
 * exactly the state it exists to mark (see above). Matched case-insensitively,
 * like reservedState. Both DB writers enforce this — the store on patchTask /
 * applyDrag, and agent.rs in apply_task_update. */
export const DONE_CLEARED_TAGS: readonly ReservedTag[] = ["blocked", "needs-review"];

export const RESERVED_TAG_LABELS: Record<ReservedTag, string> = {
  blocked: "Blocked",
  "needs-review": "Needs review",
  "needs-landing": "Needs landing",
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
