import type { Task } from "../types";

// Short, stable, agent-friendly task references: `CODE-N`. CODE is a per-project
// short code; N counts tasks within that code from 1. See
// docs/specs/2026-07-16-per-project-task-ref.md.
//
// The derivation here is mirrored byte-for-byte in src-tauri/src/agent.rs
// (derive_project_code / mint_task_ref): the Rust MCP server and this frontend
// both create projects and tasks straight into SQLite, so an identical code must
// come out either way. Keep the two in lockstep.

/** Reserved code for tasks with no project (the Inbox). */
export const INBOX_CODE = "INBOX";

/** Split a project name into uppercase alphanumeric words. */
function words(name: string): string[] {
  return name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((w) => w.length > 0);
}

/**
 * The base (pre-uniqueness) code for a name: initials for a multi-word name,
 * the first three characters for a single word. Always ≥1 char; falls back to
 * "PRJ" for a name with no alphanumerics at all.
 */
export function baseProjectCode(name: string): string {
  const ws = words(name);
  if (ws.length === 0) return "PRJ";
  if (ws.length === 1) return ws[0].slice(0, 3);
  return ws.map((w) => w[0]).join("").slice(0, 4);
}

/**
 * A unique code for `name` given the set of codes already in use (uppercase).
 * On collision, append the smallest integer suffix that is free: TIL, TIL2, TIL3.
 * The suffix is a plain digit (no dash) so it never confuses the `CODE-N` split.
 */
export function deriveProjectCode(name: string, taken: Set<string>): string {
  const base = baseProjectCode(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The frozen reference string for a task. */
export function formatRef(code: string, number: number): string {
  return `${code}-${number}`;
}

/**
 * What the card and list row show. The frozen `ref` is authoritative; the raw
 * `#id` is only a fallback for a row the backfill somehow hasn't reached.
 */
export function taskRefLabel(task: Task): string {
  return task.ref ?? `#${task.id}`;
}
