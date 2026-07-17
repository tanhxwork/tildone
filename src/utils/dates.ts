import {
  addDays,
  differenceInCalendarDays,
  format,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import type { Task } from "../types";

export type WeekStartDay = "monday" | "sunday";

export function toDateStr(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

/** The 7 dates (YYYY-MM-DD) of the week containing `anchor`. */
export function weekDates(anchor: Date, weekStart: WeekStartDay): string[] {
  const start = startOfWeek(anchor, { weekStartsOn: weekStart === "monday" ? 1 : 0 });
  return Array.from({ length: 7 }, (_, i) => toDateStr(addDays(start, i)));
}

/** Full weeks (rows of 7 date strings) covering the month of `anchor`. */
export function monthGrid(anchor: Date, weekStart: WeekStartDay): string[][] {
  const first = startOfMonth(anchor);
  const gridStart = startOfWeek(first, { weekStartsOn: weekStart === "monday" ? 1 : 0 });
  const weeks: string[][] = [];
  let cursor = gridStart;
  const month = first.getMonth();
  do {
    weeks.push(Array.from({ length: 7 }, (_, i) => toDateStr(addDays(cursor, i))));
    cursor = addDays(cursor, 7);
  } while (cursor.getMonth() === month);
  return weeks;
}

export function todayStr(): string {
  return format(new Date(), "yyyy-MM-dd");
}

export function tomorrowStr(): string {
  return format(addDays(new Date(), 1), "yyyy-MM-dd");
}

export function isOverdue(task: Task): boolean {
  return !!task.due_date && task.status !== "done" && task.due_date < todayStr();
}

export function dueLabel(dueDate: string): string {
  const date = parseISO(dueDate);
  const diff = differenceInCalendarDays(date, startOfDay(new Date()));
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return format(date, sameYear ? "EEE, MMM d" : "MMM d, yyyy");
}

/** Sort: unfinished first, then by due date (nulls last), priority desc, manual position. */
export function compareTasks(a: Task, b: Task): number {
  const doneA = a.status === "done" ? 1 : 0;
  const doneB = b.status === "done" ? 1 : 0;
  if (doneA !== doneB) return doneA - doneB;
  const dueA = a.due_date ?? "9999-12-31";
  const dueB = b.due_date ?? "9999-12-31";
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.position !== b.position) return a.position - b.position;
  return a.id - b.id;
}

/** "in 5 days" / "today" / "3 days overdue" — the secondary label next to a due date. */
export function relativeDueLabel(dueDate: string): string {
  const diff = differenceInCalendarDays(parseISO(dueDate), startOfDay(new Date()));
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff > 1) return `in ${diff} days`;
  if (diff === -1) return "1 day ago";
  return `${-diff} days ago`;
}

/**
 * Coerce a timestamp to ISO-8601 UTC. Rows written before migration 004 (and
 * data imported from an export taken back then) carry SQLite's
 * "YYYY-MM-DD HH:MM:SS", which is UTC but has no marker — `new Date()` would
 * read it as local time and land hours off.
 */
export function toIsoUtc(timestamp: string): string {
  return timestamp.includes("T") ? timestamp : timestamp.replace(" ", "T") + "Z";
}

/** Short relative timestamp for activity rows: "just now", "2h ago", "Yesterday", "Jul 5". */
export function timeAgo(timestamp: string): string {
  const date = new Date(toIsoUtc(timestamp));
  if (isNaN(date.getTime())) return "";
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24 && date.getDate() === new Date().getDate()) return `${hours}h ago`;
  const days = differenceInCalendarDays(startOfDay(new Date()), startOfDay(date));
  if (days <= 1) return "Yesterday";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return format(date, sameYear ? "MMM d" : "MMM d, yyyy");
}

/**
 * How long an agent's last activity keeps surfacing as FALLBACK presence on the card.
 *
 * Only reached for agents with no heartbeat hook installed (Codex, Cursor, an
 * unconnected Claude Code) — a live agent reports its own state and never consults
 * this. See src/utils/presence.ts.
 */
export const PRESENCE_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Whether an agent touch is recent enough to surface on the card at all.
 *
 * This is NOT a live/dead verdict, and must never become one. It is only the point
 * past which a timestamp stops being *presence* and becomes *history* (still in the
 * Activity feed). Beyond the window, a card an agent touched last week carries no
 * stale badge.
 *
 * There was a companion to this — `isActivelyWorking`, a 2-minute window whose
 * freshness decided whether the mark pulsed "working". It is gone. Its own doc
 * comment named the flaw it shipped with: "a long silent build ages out of the window
 * and the mark settles to static". That was accepted because an MCP agent had no
 * heartbeat and there was no better signal available. There is now — agents report
 * their state on every tool call and Rust checks the process — so liveness is no
 * longer guessed from the age of a write. Do not reintroduce that inference: it made
 * a busy agent and a departed one render identically, which is the whole reason the
 * live path exists.
 */
export function isRecentPresence(timestamp: string): boolean {
  const t = new Date(toIsoUtc(timestamp)).getTime();
  if (isNaN(t)) return false;
  return Date.now() - t < PRESENCE_WINDOW_MS;
}
